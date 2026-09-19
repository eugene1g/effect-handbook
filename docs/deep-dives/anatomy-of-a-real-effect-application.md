# Anatomy of a Real Effect Application

This guide turns Effect's core primitives into one application shape. It targets `effect@4.0.0-rc.116`: domain values are Schemas, expected failures are tagged errors, behavior lives behind services, Layers own construction and cleanup, and the runtime is called only at an application edge.

Use the concise references when you need the complete API surface: [Core Runtime & Execution](../foundations/core-runtime-execution), [Services, Context & Layers](../foundations/services-context-layers), [Configuration & Secrets](../foundations/configuration-secrets), [Errors, Option & Result](../foundations/errors-option-result), [Schema](../data/schema), [Observability](../operations/observability), and [Testing & Dev Tooling](../tooling/testing-dev-tooling).

## The application shape

An Effect application is easiest to reason about as four concentric boundaries:

1. **Domain** — schemas, domain values, and expected errors. It knows nothing about databases, HTTP, or process startup.
2. **Capabilities** — service interfaces such as `EmployeeRepository` or `AuditLog`. Business logic depends on these interfaces through the Effect requirement channel.
3. **Implementations** — Layers that construct capabilities from configuration and lower-level services, and own any acquired resources.
4. **Edges** — an HTTP server, CLI, worker, test, or framework adapter that provides the completed Layer graph and runs the Effect.

Dependencies point inward. Domain logic never calls `Effect.runPromise`, reads `process.env`, creates an SDK client, or chooses a database driver. Those decisions belong at the outer edge.

### A practical source tree

> **Example status — Illustrative:** the names are a project layout, not library API.

```text
src/
  domain/
    Employee.ts          # Schema values and tagged domain errors
  services/
    EmployeeRepository.ts # capability only
    Compensation.ts       # use-case service
  layers/
    EmployeeRepositoryMemory.ts
    EmployeeRepositorySql.ts
    AppConfig.ts
  api/
    Api.ts                # transport contract, safe for clients to import
    Handlers.ts           # server implementation
  AppLive.ts              # production Layer graph
  Main.ts                 # the only process-runtime edge
test/
  Compensation.test.ts
```

Separate files are useful because they enforce ownership. They are not a reason to create a service for every helper: keep pure calculations as ordinary functions and introduce a service when behavior needs substitution, lifecycle, configuration, or another Effect capability.

## Model the boundary once

The domain schema should describe both the runtime value and the representation that crosses a boundary. A branded identifier prevents accidental mixing, a class gives the domain a named value, and tagged schema errors stay typed and serializable.

> **Example status — Runnable:** this block runs with the published `effect` package.

```ts
import { Effect, Schema } from "effect"

const EmployeeId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("EmployeeId")
)
type EmployeeId = typeof EmployeeId.Type

class Employee extends Schema.Class<Employee>("handbook/Employee")({
  id: EmployeeId,
  name: Schema.String.check(Schema.isMinLength(1)),
  baseSalary: Schema.Finite.check(Schema.isGreaterThan(0))
}) {}

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()(
  "EmployeeNotFound",
  { id: EmployeeId }
) {}

class RaiseRejected extends Schema.TaggedError<RaiseRejected>()(
  "RaiseRejected",
  {
    id: EmployeeId,
    requestedPercent: Schema.Finite,
    maximumPercent: Schema.Finite
  }
) {}

const decodeEmployee = Schema.decodeUnknownEffect(Employee)

const program = Effect.gen(function*() {
  const employee = yield* decodeEmployee({
    id: 42,
    name: "Ada Lovelace",
    baseSalary: 120_000
  })
  return employee.id
})

console.log(await Effect.runPromise(program)) // 42, typed as EmployeeId
```

Decode unknown data at ingress and pass decoded values inward. Do not make every service re-parse the same object, and do not replace validation with `as Employee`. See [Schema — From External Input to Domain and Back](schema-from-external-input-to-domain-and-back) for the full boundary journey.

## Define capabilities before implementations

`Context.Service` describes what domain logic may do. Its methods return Effects so success, expected failure, and required dependencies remain visible in their types.

The implementation is a Layer. Naming a dependency-free implementation `layerNoDeps` makes the eventual wiring graph readable; a convenient `layer` may provide a normal production dependency when there is one unambiguous default.

> **Example status — Contextual:** place this after the domain definitions above. Every library import used by the block is included.

```ts
import { Context, Effect, Layer } from "effect"

class EmployeeRepository extends Context.Service<EmployeeRepository, {
  readonly findById: (
    id: EmployeeId
  ) => Effect.Effect<Employee, EmployeeNotFound>
  readonly save: (employee: Employee) => Effect.Effect<void>
}>()("handbook/EmployeeRepository") {
  static layerMemory = (seed: ReadonlyArray<Employee>) =>
    Layer.sync(EmployeeRepository, () => {
      const rows = new Map<number, Employee>(seed.map((employee) => [employee.id, employee]))
      return EmployeeRepository.of({
        findById: Effect.fn("EmployeeRepository.findById")(function*(id) {
          const employee = rows.get(id)
          if (employee === undefined) {
            return yield* new EmployeeNotFound({ id })
          }
          return employee
        }),
        save: Effect.fn("EmployeeRepository.save")(function*(employee) {
          rows.set(employee.id, employee)
        })
      })
    })
}

class Compensation extends Context.Service<Compensation, {
  readonly approveRaise: (
    id: EmployeeId,
    percent: number
  ) => Effect.Effect<Employee, EmployeeNotFound | RaiseRejected>
}>()("handbook/Compensation") {
  static layerNoDeps = Layer.effect(
    Compensation,
    Effect.gen(function*() {
      const employees = yield* EmployeeRepository
      const maximumPercent = 0.2

      return Compensation.of({
        approveRaise: Effect.fn("Compensation.approveRaise")(function*(id, percent) {
          if (percent < 0 || percent > maximumPercent) {
            return yield* new RaiseRejected({
              id,
              requestedPercent: percent,
              maximumPercent
            })
          }
          const current = yield* employees.findById(id)
          const updated = new Employee({
            id: current.id,
            name: current.name,
            baseSalary: current.baseSalary * (1 + percent)
          })
          yield* employees.save(updated)
          return updated
        })
      })
    })
  )
}
```

The use-case implementation reads `EmployeeRepository` once while its Layer is built. Callers see only the `Compensation` requirement; they do not know whether the repository is memory, SQL, or an HTTP client.

## Let Layers own resources and configuration

A Layer's build runs in a Scope. `Effect.acquireRelease` acquired inside `Layer.effect` is therefore released when the Layer is torn down, including after failure or interruption. Read configuration during construction rather than throughout business logic, and keep secrets redacted until the concrete client requires their raw value.

> **Example status — Contextual:** this is the production implementation of an application capability. `AuditClient` represents a third-party SDK supplied by the application.

```ts
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"

interface AuditClient {
  readonly write: (event: string) => Promise<void>
  readonly close: () => Promise<void>
}

declare const connectAuditClient: (options: {
  readonly endpoint: string
  readonly token: string
}) => Promise<AuditClient>

class AuditError extends Schema.TaggedError<AuditError>()("AuditError", {
  cause: Schema.Defect()
}) {}

class AuditLog extends Context.Service<AuditLog, {
  readonly write: (event: string) => Effect.Effect<void, AuditError>
}>()("handbook/AuditLog") {
  static layer = Layer.effect(
    AuditLog,
    Effect.gen(function*() {
      const endpoint = yield* Config.String("AUDIT_ENDPOINT")
      const token = yield* Config.Redacted("AUDIT_TOKEN")
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => connectAuditClient({ endpoint, token: Redacted.value(token) }),
          catch: (cause) => new AuditError({ cause })
        }),
        (client) => Effect.promise(() => client.close())
      )

      return AuditLog.of({
        write: Effect.fn("AuditLog.write")((event: string) =>
          Effect.tryPromise({
            try: () => client.write(event),
            catch: (cause) => new AuditError({ cause })
          })
        )
      })
    })
  )
}
```

Do not acquire a resource outside Effect and then merely place it in a Layer: the Layer cannot finalize what it does not own. Conversely, do not wrap an already-managed Layer in a new manual Scope. Compose it and let one outer runtime close the graph.

### One bracket per resource

**`Effect.acquireRelease` registers its release only after the acquire effect succeeds**, so an acquire that opens two handles and fails on the second leaves the first one open with no finalizer. Give every handle its own bracket. When a later acquisition fails, the Layer's Scope unwinds and the earlier releases run, newest first. The same rule covers a Layer build that fails halfway: whatever was already bracketed is released; whatever was opened outside a bracket leaks.

> **Example status — Contextual:** `openLedger` and `openArchive` stand for two SDK connections supplied by the application.

```ts
import { Context, Effect, Layer } from "effect"

interface Connection {
  readonly append: (line: string) => Promise<void>
  readonly close: () => Promise<void>
}

declare const openLedger: () => Promise<Connection>
declare const openArchive: () => Promise<Connection>

class PayrollExport extends Context.Service<PayrollExport, {
  readonly record: (line: string) => Effect.Effect<void>
}>()("handbook/PayrollExport") {
  static layer = Layer.effect(
    PayrollExport,
    Effect.gen(function*() {
      // Two brackets, not one acquire that opens both:
      // if `openArchive` rejects, the ledger's release still runs.
      const ledger = yield* Effect.acquireRelease(
        Effect.promise(() => openLedger()),
        (connection) => Effect.promise(() => connection.close())
      )
      const archive = yield* Effect.acquireRelease(
        Effect.promise(() => openArchive()),
        (connection) => Effect.promise(() => connection.close())
      )

      return PayrollExport.of({
        record: Effect.fn("PayrollExport.record")(function*(line: string) {
          yield* Effect.promise(() => ledger.append(line))
          yield* Effect.promise(() => archive.append(line))
        })
      })
    })
  )
}
```

A release effect has error type `never`, so a fallible `close()` forces a decision at the point of registration. `Effect.promise` turns a rejected `close()` into a defect; wrap it with `Effect.tryPromise(...).pipe(Effect.ignore)` when a failed close is only worth a log line, and bound it with `Effect.timeoutOption` when shutdown must not wait on a dead peer. Finalizers run uninterruptibly, so an unbounded finalizer is an unbounded shutdown.

## Assemble one graph at the edge

Build named Layer values and reuse them. Layer memoization is based on Layer object identity inside a build, so recreating an equivalent expression is not the same as sharing the same value.

> **Example status — Contextual:** it uses the services defined above and supplies an application seed.

```ts
import { Effect, Layer, Schema } from "effect"

const employeeId = Schema.decodeUnknownSync(EmployeeId)(42)
const EmployeeRepositoryLive = EmployeeRepository.layerMemory([
  new Employee({ id: employeeId, name: "Ada Lovelace", baseSalary: 120_000 })
])

const CompensationLive = Compensation.layerNoDeps.pipe(
  Layer.provide(EmployeeRepositoryLive)
)

const AppLive = Layer.merge(CompensationLive, AuditLog.layer)

const approve = Effect.gen(function*() {
  const compensation = yield* Compensation
  const audit = yield* AuditLog
  const employee = yield* compensation.approveRaise(employeeId, 0.08)
  yield* audit.write(`raise-approved:${employee.id}`)
  return employee
})

export const program = approve.pipe(Effect.provide(AppLive))
```

Use `Layer.provide(dependency)` when the dependency is an implementation detail and should disappear from the output. Use `Layer.provideMerge(dependency)` only when callers genuinely need both services. `Layer.merge` combines independent outputs. Avoid exposing every low-level service “just in case”; the remaining requirement type should describe the application's public capabilities.

### What the composition root owns

There is **one composition root per executable or host instance** — the HTTP server, the payroll worker, the CLI, and each test harness have their own — not one per repository. A root has six duties, and nothing else in the codebase should perform them:

1. Define the top-level program, or the bridge a foreign host calls into.
2. Assemble the Layer graph from named feature Layers.
3. Install configuration and observability **before** the Layers that depend on them acquire anything.
4. Bind the graph to its owner's lifetime: a process, a `ManagedRuntime`, or a test scope.
5. Hand the closed program to the platform runner or host bridge.
6. Dispose the graph and report how the program ended.

A higher-level use case composes an existing use case through its service; it does not reach through to that use case's repository. Keep feature graphs open — a feature Layer may still require `SqlClient` — and close them only here. A universal `layers.ts` that exports every Layer, or a global service locator, erases exactly the ownership this section is about.

**“Built once” is a claim about a specific build, so name it.** Sharing happens inside one build: every `Effect.provide` that is not nested in another build starts its own, so two sibling `program.pipe(Effect.provide(AppLive))` calls acquire `AppLive` twice, while a `provide` nested inside a live build of the same Layer value — including an effect run through a `ManagedRuntime` made from it — reuses the live instance. Provide the application Layer once at the root, and prove the claim with an acquisition counter rather than by reading the code. `Layer.fresh` and `Effect.provide(layer, { local: true })` exist for deliberate isolation; neither is a fix for a type error, because both duplicate pools, caches, and subscriptions.

Official guides: [Managing Layers](https://effect.website/docs/v4/requirements-management/layers), [Layer Memoization](https://effect.website/docs/v4/requirements-management/layer-memoization) (it says local provides are simply not memoized and does not cover the nested-reuse case or the `local` option). These track Effect's `main` branch rather than the pinned `rc.116` release, so where they differ, this page and the tagged source win.

## Choose the correct runtime edge

There are three common edges, and choosing the wrong one usually creates lifecycle problems.

### An Effect-native process

For a one-shot program, provide the Layer and pass the resulting Effect to the host runtime. For a server or permanent background process represented as Layers, `Layer.launch` keeps the graph alive until interruption. `NodeRuntime.runMain` and its Bun/Deno equivalents install process signal handling and map the final `Exit` to process termination.

> **Example status — Contextual:** this is an application entrypoint and requires `@effect/platform-node` at the same release line as `effect`.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { AppLive, program } from "./AppLive.ts"

// One-shot command or batch:
program.pipe(NodeRuntime.runMain)

// A long-running app would instead launch its server/background Layer:
// Layer.launch(ServerLive.pipe(Layer.provide(AppLive))).pipe(NodeRuntime.runMain)
```

### A non-Effect host

When Hono, Express, a UI framework, or another callback-driven host owns execution, construct one `ManagedRuntime` for the application Layer, reuse it for every callback, and dispose it during host shutdown. Creating one runtime per request defeats Layer sharing and leaks resources if it is not disposed.

> **Example status — Contextual:** `handleRequest` is the callback exposed to the external host.

```ts
import { Effect, ManagedRuntime } from "effect"
import { AppLive } from "./AppLive.ts"
import { Compensation, employeeId } from "./domain.ts"

const runtime = ManagedRuntime.make(AppLive)

export const handleRequest = () =>
  runtime.runPromise(
    Compensation.use((service) => service.approveRaise(employeeId, 0.05))
  )

export const shutdown = () => runtime.dispose()
```

That is the minimal shape. A real host callback also **forwards the host's cancellation, in both hops**. Every `ManagedRuntime` runner accepts `Effect.RunOptions`; passing the host's `AbortSignal` as `{ signal }` turns a client disconnect into fiber interruption, so finalizers run and pool slots come back. That is hop one. Hop two lives in the adapters: an `Effect.tryPromise` thunk receives Effect's own `AbortSignal` and must hand it to `fetch` or the driver. Drop either hop and the caller is gone while the work keeps its socket, connection, and rate-limit budget. When a framework offers a disconnect hook instead of a signal, abort an `AbortController` from that hook and pass its signal.

> **Example status — Contextual:** `AppLive` stands for the application Layer assembled above.

```ts
import { Context, Exit, ManagedRuntime } from "effect"
import type { Effect, Layer } from "effect"

class Compensation extends Context.Service<Compensation, {
  readonly approveRaise: (employeeId: number, percent: number) => Effect.Effect<number>
}>()("handbook/Compensation") {}

declare const AppLive: Layer.Layer<Compensation>

const runtime = ManagedRuntime.make(AppLive)

export const handleRequest = async (request: Request): Promise<Response> => {
  // Hop one: the host's signal interrupts the fiber that serves this request.
  const exit = await runtime.runPromiseExit(
    Compensation.use((service) => service.approveRaise(42, 0.05)),
    { signal: request.signal }
  )
  if (Exit.isSuccess(exit)) return Response.json({ baseSalary: exit.value })
  // The client went away: nobody reads this response, but it must not be logged as a fault.
  if (Exit.hasInterrupts(exit)) return new Response(null, { status: 499 })
  return new Response(null, { status: 500 })
}

export const shutdown = () => runtime.dispose()
```

On abort, the Promise returned by `runPromise` rejects, which is why this handler uses `runPromiseExit`: `Exit.hasInterrupts(exit)` is the branch that separates "client closed request" from a failure. The complete pattern, including the adapter hop and the lifecycle assertions, is in [Recipe: Request Cancellation Through a Host](../recipes/request-cancellation-through-a-host); [Recipe: ManagedRuntime at an Imperative Boundary](../recipes/managed-runtime-integration) covers the runtime itself, and [Owning Lifetimes — Startup, Readiness, and Shutdown](owning-lifetimes-startup-readiness-and-shutdown) covers the host lifecycle around it.

### A Web-standard handler

For serverless and edge hosts, prefer the HTTP adapter's layer-backed Web handler. Retain and call its `dispose` function; it owns the constructed Layer graph. The detailed choices live in [HTTP Server](../interfaces/http-server#httpeffect).

## A runnable vertical slice

This compact capstone keeps the same boundaries in one file: Schema values, tagged errors, a repository capability, a use-case service, a replaceable Layer, and one runtime call at the edge.

> **Example status — Runnable:** no ambient declarations or external services are required.

```ts
import { Context, Effect, Layer, Schema } from "effect"

const Id = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("Id"))
type Id = typeof Id.Type

class Account extends Schema.Class<Account>("handbook/Account")({
  id: Id,
  balance: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

class AccountNotFound extends Schema.TaggedError<AccountNotFound>()(
  "AccountNotFound",
  { id: Id }
) {}

class Accounts extends Context.Service<Accounts, {
  readonly get: (id: Id) => Effect.Effect<Account, AccountNotFound>
  readonly put: (account: Account) => Effect.Effect<void>
}>()("handbook/Accounts") {}

const AccountsMemory = (initial: ReadonlyArray<Account>) =>
  Layer.sync(Accounts, () => {
    const rows = new Map<number, Account>(initial.map((account) => [account.id, account]))
    return Accounts.of({
      get: Effect.fn("Accounts.get")(function*(id) {
        const account = rows.get(id)
        if (account === undefined) return yield* new AccountNotFound({ id })
        return account
      }),
      put: (account) => Effect.sync(() => void rows.set(account.id, account))
    })
  })

class Deposits extends Context.Service<Deposits, {
  readonly deposit: (id: Id, amount: number) => Effect.Effect<Account, AccountNotFound>
}>()("handbook/Deposits") {
  static layer = Layer.effect(
    Deposits,
    Effect.gen(function*() {
      const accounts = yield* Accounts
      return Deposits.of({
        deposit: Effect.fn("Deposits.deposit")(function*(id, amount) {
          const current = yield* accounts.get(id)
          const updated = new Account({ id, balance: current.balance + amount })
          yield* accounts.put(updated)
          yield* Effect.logInfo("deposit completed", { accountId: id, amount })
          return updated
        })
      })
    })
  )
}

const id = Schema.decodeUnknownSync(Id)(1)
const TestLive = Deposits.layer.pipe(
  Layer.provide(AccountsMemory([new Account({ id, balance: 100 })]))
)

const program = Deposits.use((service) => service.deposit(id, 25)).pipe(
  Effect.provide(TestLive)
)

console.log((await Effect.runPromise(program)).balance) // 125
```

The in-memory Layer is not “test code inside production logic.” It is one implementation of a stable capability. A SQL implementation can replace it without changing `Deposits` or its callers.

## Test at the capability boundary

Test the use case with a small Layer graph. Use a fresh in-memory Layer per test when isolation matters; `layer(...)` deliberately shares one built graph across its whole block. Pick the cheapest seam that proves the behavior: `Effect.provideService(Service, fake)` for a focused unit test with a ready-made fake, a test Layer when the fake needs state, configuration, or a lifetime, and the live graph only at the application edge.

> **Example status — Contextual:** place this beside the runnable capstone and execute it with Vitest 5 and `@effect/vitest`.

```ts
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

describe("Deposits", () => {
  it.effect("updates the balance", () => {
    const IsolatedLive = Deposits.layer.pipe(
      Layer.provide(AccountsMemory([new Account({ id, balance: 100 })]))
    )

    return Effect.gen(function*() {
      const deposits = yield* Deposits
      const updated = yield* deposits.deposit(id, 25)
      assert.strictEqual(updated.balance, 125)
    }).pipe(Effect.provide(IsolatedLive))
  })
})
```

An application test should prove observable behavior and important lifetime semantics, not merely that a Layer builds. Add focused tests for typed failures, cleanup after interruption, retry decisions, and boundary round-trips where those are part of the contract.

## One owner per policy

Most production surprises in an Effect application are a policy with two owners: a timeout inside an adapter *and* around the use case, a second connection pool built by a stray `provide`, a retry loop in the client *and* in the workflow. Give each cross-cutting concern exactly one owning value, provide it in one place, and test it through that owner.

| Concern | Owning value | Where it is provided | How it is tested |
| --- | --- | --- | --- |
| Time | the `Clock` reference | default at the root; nowhere else | `TestClock.layer()` plus `TestClock.adjust` |
| Recurrence | one named `Schedule` per operation | passed to `Effect.retry` / `Effect.repeat` by the service that owns the operation | virtual time; assert the attempt count |
| Deployment inputs | one `Config` program, read during a Layer build | `ConfigProvider.layer(...)` at the root | `ConfigProvider.fromUnknown({ ... })` |
| Capacity | one shared `Semaphore` or `Pool`, created in a Layer | the Layer that owns the bottleneck | peak in-flight counter, decremented in `Effect.ensuring` |
| Execution | one platform `runMain`, or one `ManagedRuntime` per host | the entrypoint or host adapter | acquisition and release counters; abort a request |
| Telemetry export | one scoped exporter Layer | the root, before dependents acquire | an in-memory logger or tracer Layer |
| Atomicity | one transaction around the state change | the repository method that owns the write | force a failure inside it and assert the rollback |

## Operational checklist

- Decode unknown input once at each ingress; keep decoded domain values inside.
- Define expected errors as specific tagged values. Do not turn every failure into a defect.
- Keep pure calculations as functions; use services for replaceable or effectful capabilities.
- Give resource acquisition to the Layer that owns its lifetime and verify finalization.
- Name and reuse shared Layer values; use `Layer.fresh` only when a second instance is intentional.
- Hide implementation dependencies with `Layer.provide`; expose only capabilities callers need.
- Read config and unwrap secrets at the concrete integration boundary, not in domain logic.
- Add spans with `Effect.fn("qualified.name")`, and log/measure once at the boundary that owns an operation.
- Run the runtime only at an entrypoint, framework adapter, or test edge.
- Use one long-lived `ManagedRuntime` per external host integration and always dispose it.
- Forward the host's `AbortSignal` into every runner call, and Effect's signal into every Promise adapter.
- Prefer host `runMain` for Effect-native processes so signals interrupt the root and close scopes.
- Give every acquired handle its own `acquireRelease`, and decide up front what a failing release means.
- Keep one composition root per executable; provide the application Layer once and count acquisitions to prove sharing.
- Quarantine platform packages and leaf `effect/unstable/*` imports behind small application-owned services, so an upstream rename touches one file and tests provide a fake instead of patching globals. Framework-level unstable modules such as `HttpApi` or `SqlClient` are used directly and managed by pinning and re-auditing.
- Build a fresh test Layer for isolated tests; use shared Layer test blocks only deliberately.
- Coming from a Promise codebase? [Adopting Effect in an Existing TypeScript Codebase](adopting-effect-in-an-existing-codebase) is the path to this shape; the [Review Checklists](../reference/review-checklists) restate it as verifiable statements.

The essential architecture is small: **Schema defines what crosses boundaries; services define what the application can do; Layers decide how and for how long; one outer runtime makes it happen.**
