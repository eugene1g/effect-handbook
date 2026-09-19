# Adopting Effect in an Existing TypeScript Codebase

Audited against `effect@4.0.0-rc.115` and the matching Effect repository source on 2026-09-18.

Most teams do not get to start over. They have a Promise-based service that works, callers that depend on its exact shape, and a list of production incidents that all sound alike: a request nobody could cancel, a failure nobody could tell apart from another failure, a batch job that opened four hundred connections. This guide takes one such service from a compensation platform and moves it to Effect without a rewrite, one verifiable step at a time.

[Anatomy of a Real Effect Application](anatomy-of-a-real-effect-application) describes the destination. This page is the path. For the mechanics it relies on, see [Core Runtime & Execution](../foundations/core-runtime-execution), [Recipe: ManagedRuntime at an Imperative Boundary](../recipes/managed-runtime-integration), [Recipe: Request Cancellation Through a Host](../recipes/request-cancellation-through-a-host), and [Testing an Effect Application](testing-an-effect-application).

> **Official guides:** [Creating Effects](https://effect.website/docs/v4/getting-started/creating-effects), [Running Effects](https://effect.website/docs/v4/getting-started/running-effects) (it names the `runFork` result `RuntimeFiber`; in `rc.115` the type is `Fiber`), [Managing Services](https://effect.website/docs/v4/requirements-management/services), [Runtime](https://effect.website/docs/v4/runtime). These track Effect's `main` branch rather than the pinned `rc.115` release, so where they differ, this page and the tagged source win.

The route: audit what the signatures do not say, pin today's behavior, freeze the external contract, migrate leaf-first behind it, keep exactly one seam where Promise meets Effect, make adapters cancellable before adding policy, take the first testing win with `Effect.provideService`, graduate to Layers, then bound the fan-out and decide when you are done.

## The service we are starting with

> **Example status — Contextual:** plain TypeScript, no Effect yet. This is the code being adopted.

```ts
export interface Employee {
  readonly id: string
  readonly level: string
  readonly salary: number
}

export async function getEmployee(baseUrl: string, id: string): Promise<Employee> {
  const response = await fetch(`${baseUrl}/employees/${id}`)
  if (!response.ok) throw new Error(`HRIS responded ${response.status}`)
  return (await response.json()) as Employee
}

export interface RaiseDependencies {
  readonly hris: { readonly getEmployee: (id: string) => Promise<Employee> }
  readonly payroll: { readonly updateSalary: (id: string, salary: number) => Promise<void> }
  readonly notify: (message: string) => Promise<void>
}

export class RaiseService {
  private readonly deps: RaiseDependencies
  constructor(deps: RaiseDependencies) {
    this.deps = deps
  }

  async approveRaise(id: string, percent: number): Promise<Employee> {
    const employee = await this.deps.hris.getEmployee(id)
    if (percent > 0.15) throw new Error("raise exceeds the band for this level")
    const updated = { ...employee, salary: Math.round(employee.salary * (1 + percent)) }
    await this.deps.payroll.updateSalary(id, updated.salary)
    void this.deps.notify(`Raise approved for ${id}`) // fire and forget
    return updated
  }

  approveCycle(ids: ReadonlyArray<string>, percent: number): Promise<Array<Employee>> {
    return Promise.all(ids.map((id) => this.approveRaise(id, percent)))
  }
}
```

It compiles under `strict`. It has tests. It is also the source of every incident in the first paragraph.

## Run the operational audit

"It compiles" answers one question: do the values fit together? An operational audit asks what happens when the code *runs*, and it needs no Effect knowledge — it is a code-review checklist for any TypeScript function. Ask each question of the signature first, then of the body, and write down the gap between the two.

| Question | What `RaiseService` answers | Where Effect makes the answer explicit |
| --- | --- | --- |
| **What can fail, and is it typed?** | HRIS down, employee missing, malformed JSON (hidden by `as Employee`), band violation, payroll rejection. `Promise<Employee>` names none of them; a caller's `catch` receives `unknown`. | the `E` channel, tagged errors, Schema decoding |
| **What does it depend on, and is that visible?** | The constructor shows three collaborators; call sites show nothing. `getEmployee` also depends on the global `fetch`. | the `R` channel |
| **Has work started by the time I hold the return value?** | Yes. Calling `approveRaise` has already sent the HRIS request, so it cannot be retried, delayed, or composed as a value. | an Effect is a lazy description; a runner at the edge starts it |
| **What does it hold open, and who releases it?** | One HTTP exchange per call, `ids.length` of them in `approveCycle`. Nothing releases them if the caller stops waiting. | `Scope`, `acquireRelease`, finalizers |
| **Can it be cancelled?** | No. There is no `AbortSignal` anywhere, so a client disconnect or a caller-side timeout leaves the request and the payroll write running. | interruption, plus `signal` in every adapter |
| **What happens under concurrency?** | `Promise.all` starts every call at once. On the first rejection the batch rejects while the others keep running, payroll writes included. | `Effect.forEach(..., { concurrency })`; a failure interrupts the siblings |
| **Where do logs, spans, and identifiers come from?** | Nowhere. | `Effect.fn("name")`, log annotations |
| **Is a retry safe?** | Unknown: nothing says whether `updateSalary` is idempotent. | a `Schedule` owned by the operation that knows |

Keep one honesty rule while filling in the table. Instrumentation can *prove* that work starts eagerly or that two failure paths are indistinguishable. It cannot prove that a timeout, retry, or telemetry policy is absent on purpose; a missing policy is a gap in the contract, so record it as a question for the owner, not as a bug.

Each row maps to a slot in `Effect<A, E, R>` or to a runtime guarantee. That mapping is the argument for adopting Effect here, and it tells you which rows to fix first: the ones behind last quarter's incidents.

## Pin current behavior before changing it

Before touching `RaiseService`, write tests that describe what it does *today*, including the parts you intend to change. These are characterization tests: they assert ordering, fan-out, and start time, not just return values.

- **Use latches and counters, never elapsed time.** A Promise you resolve by hand forces an interleaving; `setTimeout(50)` merely hopes for one.
- **Do not fix production code while characterizing it.** A surprising assertion that passes is the point.
- **One observed symptom, one test.** Each later step changes at most one of these assertions.

> **Example status — Contextual:** a Vitest file; `makeService` builds the `RaiseService` above from controllable collaborators.

```ts
import { expect, it } from "vitest"

interface Employee {
  readonly id: string
  readonly level: string
  readonly salary: number
}
declare const makeService: (deps: {
  readonly getEmployee: (id: string) => Promise<Employee>
  readonly updateSalary: (id: string, salary: number) => Promise<void>
  readonly notify: (message: string) => Promise<void>
}) => {
  readonly approveRaise: (id: string, percent: number) => Promise<Employee>
  readonly approveCycle: (ids: ReadonlyArray<string>, percent: number) => Promise<ReadonlyArray<Employee>>
}

// A Promise the test resolves by hand: a latch, not a timer.
const latch = <A>() => {
  let open!: (value: A) => void
  const promise = new Promise<A>((resolve) => {
    open = resolve
  })
  return { promise, open }
}
const ada: Employee = { id: "e-1", level: "L4", salary: 120_000 }

it("acknowledges the raise before the notification settles", async () => {
  const notified = latch<void>()
  const service = makeService({
    getEmployee: () => Promise.resolve(ada),
    updateSalary: () => Promise.resolve(),
    notify: () => notified.promise // never opened during the call
  })
  await expect(service.approveRaise("e-1", 0.04)).resolves.toMatchObject({ salary: 124_800 })
})

it("starts every HRIS call before any of them finishes", async () => {
  let inFlight = 0
  let peak = 0
  const gate = latch<Employee>()
  const service = makeService({
    getEmployee: () => {
      peak = Math.max(peak, ++inFlight)
      return gate.promise.finally(() => inFlight--)
    },
    updateSalary: () => Promise.resolve(),
    notify: () => Promise.resolve()
  })
  const cycle = service.approveCycle(["e-1", "e-2", "e-3", "e-4", "e-5"], 0.04)
  expect(peak).toBe(5) // synchronously: all five started before the first `await`
  gate.open(ada)
  await cycle
})
```

Both tests pass against the legacy code, and both describe behavior you will deliberately change. When a later step bounds the fan-out to four, the second test's `5` becomes `4` in the same commit. **The diff of a characterization test is the documented behavior change.**

## Preserve the external contract

Freeze everything a caller can observe: the class and method names, `Promise`-returning signatures, HTTP and CLI shapes, identifiers, storage formats, and the order of side effects. A step may change an *internal* contract — that is what the steps are for — but it changes one, says so, and updates the matching characterization test.

Two consequences shape everything below:

- **The Promise method stays callable.** Add an Effect-returning function beside it and make the Promise method delegate. Callers migrate when they are ready; nothing breaks while they wait.
- **One keystone edit per step, verified cumulatively.** After each step the whole suite runs, not just the new test.

## Migrate leaf-first

Dependencies decide the order. Start where nothing else in your code is called, and move up only when the layer below returns Effects.

| Stage | What moves | Why it is safe here |
| --- | --- | --- |
| 1 | Pure values: `Option` for absence, `Result` for validation, `Data` classes, `Duration` | No runtime involved; usable from plain TypeScript today |
| 2 | Leaf adapters become lazy descriptions with one runner at the edge | Callers still see Promises |
| 3 | Typed failures replace `throw new Error(...)` | The facade converts them back into the rejections callers expect |
| 4 | Schemas at the boundaries replace `as` casts | Malformed data becomes a named failure instead of a latent crash |
| 5 | Services and Layers replace constructor wiring | Tests stop patching modules |
| 6 | Scoped resources, owned fibers, bounded fan-out | Lifetimes get owners |
| 7 | Shared state and queues | Only now, because they depend on all of the above |

The first leaf is `getEmployee`. Pick the constructor by how the wrapped code reports failure: a Promise that can reject is `Effect.tryPromise`, and its thunk receives an `AbortSignal` that you pass straight through.

> **Example status — Contextual:** the Effect version of the HRIS leaf.

```ts
import { Effect, Schema } from "effect"

export class Employee extends Schema.Class<Employee>("comp/Employee")({
  id: Schema.String,
  level: Schema.String,
  salary: Schema.Finite
}) {}

export class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {
  employeeId: Schema.String,
  cause: Schema.Defect()
}) {}

export class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {
  employeeId: Schema.String
}) {}

export class HrisContractViolation extends Schema.TaggedError<HrisContractViolation>()(
  "HrisContractViolation",
  { employeeId: Schema.String, detail: Schema.String }
) {}

const decodeEmployee = Schema.decodeUnknownEffect(Employee)

export const getEmployee = Effect.fn("Hris.getEmployee")(function*(baseUrl: string, employeeId: string) {
  // The request is created inside the thunk, so it is supervised from its first instant,
  // and `signal` aborts it when the calling fiber is interrupted.
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(`${baseUrl}/employees/${employeeId}`, { signal }),
    catch: (cause) => new HrisUnavailable({ employeeId, cause })
  })
  if (response.status === 404) return yield* new EmployeeNotFound({ employeeId })
  if (!response.ok) {
    return yield* new HrisUnavailable({ employeeId, cause: `status ${response.status}` })
  }
  const body = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: (cause) => new HrisUnavailable({ employeeId, cause })
  })
  return yield* decodeEmployee(body).pipe(
    Effect.mapError((error) => new HrisContractViolation({ employeeId, detail: error.message }))
  )
})
```

Three audit rows now have answers, and nothing has run: the failures are named in the type — `Effect<Employee, HrisUnavailable | EmployeeNotFound | HrisContractViolation>` — the JSON is decoded instead of cast, and the request can be cancelled. One trap to carry along: JavaScript evaluates arguments eagerly, so `Effect.succeed(Date.now())` reads the clock while the program is being built. Wrap side effects in `Effect.sync`, `Effect.try`, or `Effect.tryPromise`, and add one test that builds the Effect, asserts the spy was not called, runs it, and asserts exactly one call.

## Keep exactly one seam

The legacy method keeps its name and its Promise. Its body becomes a single runner call, and that file is the only place in the codebase that is allowed to contain one.

> **Example status — Contextual:** `getEmployeeEffect` is the Effect from the previous section, imported under another name.

```ts
import { Effect } from "effect"

interface Employee {
  readonly id: string
  readonly level: string
  readonly salary: number
}
declare const getEmployeeEffect: (
  baseUrl: string,
  employeeId: string
) => Effect.Effect<Employee, { readonly _tag: "HrisUnavailable" | "EmployeeNotFound" | "HrisContractViolation" }>

// Same name, same Promise, plus an optional signal that legacy callers may ignore.
export const getEmployee = (baseUrl: string, id: string, signal?: AbortSignal): Promise<Employee> =>
  Effect.runPromise(getEmployeeEffect(baseUrl, id), { signal })
```

`Effect.runPromise` rejects with the failure value itself, and the tagged errors above are `Error` subclasses, so a legacy `catch (error)` keeps working while new callers can branch on `error._tag`. If a caller inspects the old message text, restore it here with `Effect.mapError`; the facade is where the old contract is honored.

**A runner in the middle of the code severs supervision.** The first form below type-checks and returns the right value:

> **Example status — Contextual:** `loadBand` stands for any Effect your code already has.

```ts
import { Effect } from "effect"

declare const loadBand: (level: string) => Effect.Effect<number>

// Wrong: `loadBand` now runs as an unrelated root fiber.
export const bandViaInteriorRunner = (level: string) => Effect.promise(() => Effect.runPromise(loadBand(level)))

// Unavoidable third-party callback? Forward the signal so interruption still arrives.
export const bandViaBridge = (level: string) =>
  Effect.promise((signal) => Effect.runPromise(loadBand(level), { signal }))

// Right, whenever you control the code: stay in Effect and compose.
export const band = (level: string) => loadBand(level)
```

In the first form, interrupting the outer fiber never reaches the inner one: its `onInterrupt` finalizer does not run, its requirements must already be closed, and its typed failure is flattened into a rejection. Timeouts, races, and graceful shutdown all stop at that line. The second form restores cancellation and nothing else; treat it as a bridge for callbacks you do not own.

Keep the seam in one place so it can shrink. Today it is `Effect.runPromise` inside the facade. Once services exist it becomes one `ManagedRuntime`, and when the last Promise caller is gone the facade is deleted and the entrypoint's `runMain` is the only runner left. A quick check that survives code review: `Effect.run` should appear only in entrypoints, host adapters, the facade, and tests.

## Make adapters cancellable before adding policy

Deadlines, races, and structured shutdown are only as good as the leaves. `Effect.timeout` interrupts the fiber; if the adapter ignored its `signal`, "interrupted" means "abandoned but still running", and a retry then stacks a second request on top of the first. So the order is fixed: cancellation first, policy second.

Rules for every adapter, whatever it wraps:

- **Create the Promise inside the thunk and pass the supplied `signal`** to `fetch`, the driver, or the SDK.
- **For callback APIs, return a cleanup Effect** from the `Effect.callback` registration, or register listeners with `{ signal }`.
- **Keep cancellation as cancellation.** An interrupted `tryPromise` exits as an interruption, not through `catch`; do not convert it into `HrisUnavailable`, or a retry policy will retry a caller who left.
- **Do not start a wall-clock timer inside the adapter.** Let `Effect.timeout` own the deadline so `TestClock` can drive it.

> **Example status — Contextual:** the policy that becomes safe once both adapters can be cancelled.

```ts
import { Effect, Schedule } from "effect"

declare const getEmployee: (
  employeeId: string
) => Effect.Effect<{ readonly salary: number }, { readonly _tag: "HrisUnavailable" | "EmployeeNotFound" }>
declare const updateSalary: (
  employeeId: string,
  salary: number
) => Effect.Effect<void, { readonly _tag: "PayrollRejected" }>

// Reads are repeatable, so the read owns a retry: each attempt gets two seconds,
// and only an unavailable HRIS is worth another attempt.
export const getEmployeeWithPolicy = (employeeId: string) =>
  getEmployee(employeeId).pipe(
    Effect.timeout("2 seconds"),
    Effect.retry({
      schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
      times: 3,
      while: (error) => error._tag === "HrisUnavailable"
    })
  )

// The payroll write gets a deadline and no retry: nothing has established that it is idempotent.
export const updateSalaryWithDeadline = (employeeId: string, salary: number) =>
  updateSalary(employeeId, salary).pipe(Effect.timeout("5 seconds"))
```

[Failure, Retry, Fallback, and Interruption](failure-retry-fallback-and-interruption) covers how to choose the policy. The adoption rule is only about order.

## Take the first testing win with `Effect.provideService`

The use case needs its collaborators. In Promise code they arrive through a constructor, and tests reach past it to patch modules or globals. In Effect they are requirements: declare each one as a `Context.Service`, `yield*` it, and the type lists what is still unwired.

You do not need a Layer graph to benefit. **A service value that already exists — above all a test fake — is provided with `Effect.provideService`**, and each call removes exactly one identifier from `R`.

> **Example status — Contextual:** the use case and its first test, run with Vitest 5 and `@effect/vitest`.

```ts
import { assert, it } from "@effect/vitest"
import { Context, Effect, Ref, Schema } from "effect"

interface Employee {
  readonly id: string
  readonly level: string
  readonly salary: number
}

class RaiseOutOfBand extends Schema.TaggedError<RaiseOutOfBand>()("RaiseOutOfBand", {
  employeeId: Schema.String,
  percent: Schema.Finite
}) {}

class Hris extends Context.Service<Hris, {
  readonly getEmployee: (employeeId: string) => Effect.Effect<Employee>
}>()("comp/Hris") {}

class Payroll extends Context.Service<Payroll, {
  readonly updateSalary: (employeeId: string, salary: number) => Effect.Effect<void>
}>()("comp/Payroll") {}

export const approveRaise = Effect.fn("Raises.approveRaise")(function*(employeeId: string, percent: number) {
  const hris = yield* Hris
  const payroll = yield* Payroll
  const employee = yield* hris.getEmployee(employeeId)
  if (percent > 0.15) return yield* new RaiseOutOfBand({ employeeId, percent })
  const salary = Math.round(employee.salary * (1 + percent))
  yield* payroll.updateSalary(employeeId, salary)
  return { ...employee, salary }
})

it.effect("writes the new salary to payroll exactly once", () =>
  Effect.gen(function*() {
    const writes = yield* Ref.make<ReadonlyArray<number>>([])
    const updated = yield* approveRaise("e-1", 0.04).pipe(
      Effect.provideService(Hris, {
        getEmployee: (id) => Effect.succeed({ id, level: "L4", salary: 120_000 })
      }),
      Effect.provideService(Payroll, {
        updateSalary: (_id, salary) => Ref.update(writes, (all) => [...all, salary])
      })
    )
    assert.strictEqual(updated.salary, 124_800)
    assert.deepStrictEqual(yield* Ref.get(writes), [124_800])
  }))
```

The real workflow ran with no network, no module patching, and no shared mock state, and the fake *recorded* what it received, which proves the seam is real rather than merely declared. Fakes obey the same contract as live implementations: they fail with `Effect.fail(new EmployeeNotFound(...))`, never with `throw`, or the test exercises a different failure channel than production.

Do the inverse nowhere: an `Effect.provideService(Hris, liveHris)` inside `approveRaise` would make `R` look clean while hard-wiring production I/O into a reusable function. Live implementations are provided at the application edge and fakes at the test edge.

## Graduate to Layers when construction becomes a graph

`provideService` stops being enough when an implementation needs configuration, state, an effectful constructor, another service, or a lifetime. That is what a Layer is for: `Layer.succeed` for a ready value, `Layer.effect` for everything else. The Layer's build owns the `Scope`, so a connection acquired with `Effect.acquireRelease` inside it is released when the application shuts down.

> **Example status — Contextual:** the production wiring and the final shape of the seam.

```ts
import { Config, Context, Effect, Layer, ManagedRuntime } from "effect"

interface Employee {
  readonly id: string
  readonly level: string
  readonly salary: number
}
declare const getEmployee: (baseUrl: string, employeeId: string) => Effect.Effect<Employee>
declare const updateSalary: (employeeId: string, salary: number) => Effect.Effect<void>
declare const approveRaise: (
  employeeId: string,
  percent: number
) => Effect.Effect<Employee, never, Hris | Payroll>

class Hris extends Context.Service<Hris, {
  readonly getEmployee: (employeeId: string) => Effect.Effect<Employee>
}>()("comp/Hris") {
  // Construction needs (configuration) live here, not in the `R` of `getEmployee`.
  static layer = Layer.effect(
    Hris,
    Effect.gen(function*() {
      const baseUrl = yield* Config.String("HRIS_URL")
      return Hris.of({ getEmployee: (employeeId) => getEmployee(baseUrl, employeeId) })
    })
  )
}

class Payroll extends Context.Service<Payroll, {
  readonly updateSalary: (employeeId: string, salary: number) => Effect.Effect<void>
}>()("comp/Payroll") {}

const AppLive = Layer.mergeAll(Hris.layer, Layer.succeed(Payroll, Payroll.of({ updateSalary })))

// The one seam: built once, reused for every call, disposed on shutdown.
const runtime = ManagedRuntime.make(AppLive)

export class RaiseService {
  approveRaise(id: string, percent: number, signal?: AbortSignal): Promise<Employee> {
    return runtime.runPromise(approveRaise(id, percent), { signal })
  }
  shutdown(): Promise<void> {
    return runtime.dispose()
  }
}
```

`RaiseService` kept its name, its method, and its Promise. Its constructor lost its dependency bag because the runtime now supplies them, and it gained an optional `signal` that a host forwards from the request. Creating a `ManagedRuntime` per call would rebuild `AppLive` every time; create it once per host.

## Bound the fan-out and update the pinned tests

`approveCycle` is the last audit row. `Promise.all` has no Effect equivalent that behaves the same way, and that is deliberate: `Effect.all` and `Effect.forEach` are sequential unless you ask for concurrency, and they stop on the first failure by interrupting the work still in flight.

> **Example status — Contextual:** `approveRaise` is the use case with its services already provided.

```ts
import { Effect } from "effect"

declare const approveRaise: (
  employeeId: string,
  percent: number
) => Effect.Effect<number, { readonly _tag: "PayrollRejected" }>

export const approveCycle = (employeeIds: ReadonlyArray<string>, percent: number) =>
  Effect.forEach(employeeIds, (employeeId) => approveRaise(employeeId, percent), { concurrency: 4 })
```

Results come back in input order. At most four HRIS and payroll calls are in flight, and because the adapters are cancellable, a failure in one stops the others instead of orphaning them. If the batch should report every outcome instead, that is a different contract: `Effect.forEach` over `Effect.result(approveRaise(...))`, or `Effect.partition`.

This step changes observable behavior, so the second characterization test changes with it — `expect(peak).toBe(5)` becomes an assertion that the peak never exceeds `4` — and the fire-and-forget notification gets the same treatment. Decide who owns it (`Effect.forkScoped` inside a Layer, or a queue with a worker), then rewrite the first test to say what the new owner guarantees.

## Collapse only at a boundary

Every step above is the same move with a different noun: keep something explicit on the inside, and collapse it exactly once, at a boundary that owns the decision.

| Kept explicit inside | Collapsed at | Collapsing anywhere else causes |
| --- | --- | --- |
| Absence (`Option`) | the display or serialization edge that picks the fallback | `undefined` checks scattered through the domain |
| Expected failure (`E`) | the handler that maps it to a response, with `Effect.match` or `Effect.catchTags` | a generic 500, or a swallowed error |
| Unknown data | one Schema decode at ingress | `as` casts and re-validation in every function |
| Requirements (`R`) | one `provide` at the edge, or fakes at the test edge | hidden live dependencies |
| Execution | one runner per owned edge | severed supervision |
| Units (`Duration`, branded ids) | the interop call that needs a bare number or string | milliseconds passed where seconds were expected |

## Decide what to leave out

Adoption is also a list of things you do not do.

- **Pure, synchronous, dependency-free functions stay plain TypeScript.** Salary arithmetic gains nothing from an Effect wrapper.
- **No service per helper.** Introduce a service when behavior needs substitution, configuration, a lifetime, or another capability.
- **No big-bang rewrite of callers.** The facade exists so that they can move on their own schedule.
- **No queue, `PubSub`, or shared state until the leaves, failures, and services are in place.**
- **No compatibility layer that re-exports Effect under Promise-shaped names.** The facade *is* the compatibility layer, and it shrinks.

## How to know you are done

- Every audit row for the module has an answer in a type, a Layer, or a test.
- `Effect.run` appears only in entrypoints, host adapters, the shrinking facade, and tests.
- Every Promise and callback adapter receives a `signal` or returns a cleanup Effect, and one test interrupts it and observes the abort.
- The top-level program has `R = never` after one `Effect.provide` or one `ManagedRuntime`; no reusable function provides a live implementation.
- Public service methods expose business inputs, results, and failures only. Construction needs live in the Layer.
- Each characterization test either still passes unchanged or was changed in the commit that changed the behavior, with the reason in that commit.
- Unit tests use `Effect.provideService` or test Layers; nothing patches a module or a global.
- Fan-out has a number next to it.
- The Promise facade is either deleted or is the deliberate public API, and it contains nothing but runner calls.
- Strict `tsc` and strict Effect diagnostics pass, with no casts that narrow `E` or `R`.

From here the codebase has the shape described in [Anatomy of a Real Effect Application](anatomy-of-a-real-effect-application); the [Review Checklists](../reference/review-checklists) turn the same criteria into a recurring review.
