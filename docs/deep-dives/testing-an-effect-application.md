# Testing an Effect Application

> Audited **2026-09-19** against `effect@4.0.0`. This guide uses `@effect/vitest@4.0.0`, Vitest 5, TypeScript 7 strict mode, and the test services shipped by the same Effect release.

An Effect test should exercise the same program description as production while replacing only its boundary Layers. That means testing values, typed failures, required services, time, interruption, and resource lifetime without putting `runPromise`, global mocks, or real sleeps inside application code.

Examples are labelled **Runnable** when they form a complete test or Node program, **Contextual** when a local module is intentionally imported, and **Illustrative** when the code shows architecture rather than a copy-ready file.

For individual APIs, use [Testing & Dev Tooling](../tooling/testing-dev-tooling.md), [Services, Context & Layers](../foundations/services-context-layers.md), and [Errors, Option & Result](../foundations/errors-option-result.md). This guide connects those primitives into one application-shaped test strategy.

## Model the proof before writing the test

A test is an argument, and an argument has a conclusion and a scope. Before writing one, state what it will establish and what it deliberately leaves open. Seven lines are enough:

| Question | Example answer for "a conflict stops the notification" |
| --- | --- |
| **Claim** — which observable invariant? | when `save` fails with `ApprovalConflict`, `send` is never called |
| **Boundary** — a pure function, a service, a real adapter, or the packaged build? | service: `ApprovalService.layer` over two replaced boundaries |
| **Channels** — which of success, typed failure, defect, interruption, cleanup matter? | typed failure only; a defect must *fail* this test, not satisfy it |
| **Replaced vs live** — which requirements are fakes? | `ApprovalRepo` and `ApprovalNotifier` are fakes; nothing is live |
| **Owners** — who owns scopes, fibers, ports? | the per-test `Scope` from `it.effect`; no fibers, no ports |
| **Coordination** — which event proves each phase was reached? | none needed: the program is sequential |
| **Oracle** — what is inspected, including after close? | the `Exit` and the notifier's call counter |

The eighth line is the one most often skipped: **what this test does not prove**. Here: that the real repository raises `ApprovalConflict` on a duplicate key, or that the real notifier is reachable. Writing that line is what stops a green service test from being quoted as evidence about a database.

Each step on the fidelity ladder yields a different kind of evidence, and **a lower step never verifies a higher boundary**:

| Step | Evidence it gives | It does not prove |
| --- | --- | --- |
| Type check plus Effect diagnostics | the contract is coherent: `E`, `R`, and laziness mistakes are absent | that anything behaves correctly when run |
| Pure test | a transformation or constructor is right for the inputs tried | how it composes with effects, time, or failure |
| Service test with replacement Layers | orchestration, typed failures, interruption, and cleanup of *your* code | that an adapter speaks its dependency's real protocol |
| Real-adapter test against a real fixture | the adapter's queries, codecs, error mapping, and cancellation | that the whole graph wires together |
| Application-graph test with the production Layers | the graph builds, acquires once, and releases | that the packaged entry point starts, reports readiness, and exits cleanly |
| Built-artifact test | the thing you ship starts, serves, and shuts down | production load, data, and network conditions |

Classify a test by the boundary it crosses, not by the technology it names: an in-memory filesystem service makes a *service* test, and calling a router in memory does not show that a server binds or releases a port. "It type-checks", "the tests pass", and "the behavior was verified" are three different claims; report the one you actually have.

## Characterize existing behavior first

When the unit under test already exists — a Promise-based service you are about to migrate — the first test pins what it does **today**, including behavior you intend to change. Characterization tests record operational facts that a signature cannot: whether the caller is acknowledged before a follow-up settles, whether assembling the module already starts I/O, whether cleanup runs, how many downstream calls one request fans out to.

**Illustrative — a characterization test for a legacy Promise function:**

```ts
import { assert, it } from "@effect/vitest"

// The legacy unit, exactly as it is today. Characterization never edits it.
declare const submitRaise: (
  raise: { readonly employeeId: string; readonly amount: number },
  deps: { readonly writeAudit: (employeeId: string) => Promise<void> }
) => Promise<"accepted">

it("characterization: the caller is acknowledged before the audit write settles", async () => {
  let releaseAudit = (): void => {}
  const auditGate = new Promise<void>((resolve) => {
    releaseAudit = resolve
  })
  let auditStarted = 0
  let auditSettled = false

  const result = await submitRaise({ employeeId: "emp-42", amount: 4_200 }, {
    writeAudit: () => {
      auditStarted++
      return auditGate.then(() => {
        auditSettled = true
      })
    }
  })

  assert.strictEqual(result, "accepted")
  assert.strictEqual(auditStarted, 1) // fan-out: exactly one audit write is started
  assert.isFalse(auditSettled) // ordering: acknowledged while the write is still in flight
  releaseAudit()
})
```

- **Use latches and counters, never elapsed milliseconds.** The manually resolved `auditGate` makes "before" and "after" exact; a `setTimeout`-based inference turns the characterization itself into a flake.
- **Do not repair production code while characterizing.** A surprising result — here, a fire-and-forget audit write — is a finding to record, not a bug to fix in the same change.
- **After the migration, edit these same assertions to the repaired contract.** If the Effect version must finish the audit write before acknowledging, `assert.isFalse(auditSettled)` becomes the opposite claim, and that one-line diff is the documented behavior change.

This is only the testing half of the brownfield strategy. [Adopting Effect in an Existing TypeScript Codebase](./adopting-effect-in-an-existing-codebase) covers the order of migration, keeping one place where Promise meets Effect, and what to leave alone.

## The application seam

Suppose an approval service must save a decision, notify the employee, and retry a transient notification. Its business program depends on two services; it does not know whether either service is live, in-memory, or deliberately failing.

**Contextual — `src/approval.ts`:**

```ts
import { Context, Effect, Layer, Schema } from "effect"

export interface Approval {
  readonly employeeId: string
  readonly cycleId: string
  readonly amount: number
}

export class ApprovalConflict extends Schema.TaggedError<ApprovalConflict>()(
  "ApprovalConflict",
  { employeeId: Schema.String, cycleId: Schema.String }
) {}

export class NotificationUnavailable extends Schema.TaggedError<NotificationUnavailable>()(
  "NotificationUnavailable",
  {}
) {}

export class ApprovalRepo extends Context.Service<ApprovalRepo, {
  readonly save: (approval: Approval) => Effect.Effect<void, ApprovalConflict>
}>()("app/ApprovalRepo") {}

export class ApprovalNotifier extends Context.Service<ApprovalNotifier, {
  readonly send: (approval: Approval) => Effect.Effect<void, NotificationUnavailable>
}>()("app/ApprovalNotifier") {}

export class ApprovalService extends Context.Service<ApprovalService, {
  readonly approve: (
    approval: Approval
  ) => Effect.Effect<void, ApprovalConflict | NotificationUnavailable>
}>()("app/ApprovalService") {
  static readonly layer = Layer.effect(
    ApprovalService,
    Effect.gen(function*() {
      const repo = yield* ApprovalRepo
      const notifier = yield* ApprovalNotifier

      return ApprovalService.of({
        approve: Effect.fn("ApprovalService.approve")(function*(approval) {
          yield* repo.save(approval)
          yield* notifier.send(approval)
        })
      })
    })
  )
}
```

The important testing boundary is the environment of `ApprovalService.layer`: provide `ApprovalRepo` and `ApprovalNotifier`, then test the public `approve` operation. Avoid mocking internal combinators such as `Effect.retry` or `Layer.provide`; doing so tests a different program.

**Never mock the `effect` module itself.** A module mock that makes production code compile or pass hides a wrong API call behind a stub that agrees with it. Replace *capabilities* instead, each through the seam Effect already provides:

| To control | Replace | How |
| --- | --- | --- |
| an application dependency | its `Context.Service` | a test Layer, or `Effect.provideService` for one call |
| time | `Clock` | `TestClock`, installed by `it.effect` |
| randomness | `Random` | `Random.withSeed("…")` for a repeatable sequence — see [Random](../concurrency/scheduling-time#random) |
| configuration | `ConfigProvider` | `ConfigProvider.layer(ConfigProvider.fromUnknown({ … }))` — see [ConfigProvider](../foundations/configuration-secrets#configprovider) |
| console output | `Console` | `TestConsole`, installed by `it.effect` |
| log records and spans | `Logger`, `Tracer` | an in-memory logger or tracer, shown later in this guide |

## A deterministic test Layer

A useful fake is typed, observable, and small. A `Ref` records calls without escaping Effect's synchronization model.

**Contextual — `test/approval-layers.ts`:**

```ts
import { Effect, Layer, Ref } from "effect"
import {
  ApprovalNotifier,
  ApprovalRepo,
  type Approval
} from "../src/approval.ts"

export const ApprovalRepoTest = Layer.effect(
  ApprovalRepo,
  Effect.gen(function*() {
    const saved = yield* Ref.make<ReadonlyArray<Approval>>([])
    return ApprovalRepo.of({
      save: (approval) => Ref.update(saved, (all) => [...all, approval])
    })
  })
)

export const ApprovalNotifierTest = Layer.effect(
  ApprovalNotifier,
  Effect.succeed(ApprovalNotifier.of({ send: () => Effect.void }))
)

export const ApprovalBoundariesTest = Layer.merge(
  ApprovalRepoTest,
  ApprovalNotifierTest
)
```

In a real test suite, expose a dedicated state service when assertions must inspect the fake. Do not reach into private implementation state or use an untyped object cast merely to satisfy a service tag.

### Spy, lazy, and clock-driven fakes

A fake that returns canned data proves the workflow *can* succeed. Three more properties make it prove the seam is real and keep it honest under retry and virtual time:

| Property | Rule | The mistake it catches |
| --- | --- | --- |
| **Spy** | record what was received; assert exact forwarding and call count, and — when a live implementation is reachable in the test — that its counter stayed at zero | a workflow that ignores its injected dependency, or calls it twice |
| **Lazy** | choose and consume the next scripted answer when the returned Effect *runs*, not when the method is *called* | `Effect.retry` re-runs the same Effect value; an eager fake captured attempt one's answer and never serves the scripted recovery |
| **Clock-driven** | simulate latency with `Effect.sleep`, never `setTimeout` | `TestClock.adjust` cannot move a native timer, so timeouts become untestable and the fake ignores interruption |

**Runnable test:**

```ts
import { assert, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Queue, Ref, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {}) {}

class HrisClient extends Context.Service<HrisClient, {
  readonly salaryOf: (employeeId: string) => Effect.Effect<number, HrisUnavailable>
}>()("app/HrisClient") {}

// A scripted spy. `received` records every call and doubles as a phase signal.
const makeScriptedHris = (script: ReadonlyArray<"down" | number>) =>
  Effect.gen(function*() {
    const received = yield* Queue.unbounded<string>()
    const remaining = yield* Ref.make(script)
    const layer = Layer.succeed(HrisClient, HrisClient.of({
      salaryOf: (employeeId) =>
        // Lazy: everything below happens when the returned Effect runs,
        // so every retry attempt consumes its own script entry.
        Effect.gen(function*() {
          yield* Queue.offer(received, employeeId)
          yield* Effect.sleep("200 millis") // latency lives on Effect's clock
          const next = yield* Ref.modify(remaining, (all) => [all[0], all.slice(1)] as const)
          if (next === undefined || next === "down") return yield* new HrisUnavailable()
          return next
        })
    }))
    return { layer, received } as const
  })

const salaryWithRetry = Effect.gen(function*() {
  const hris = yield* HrisClient
  return yield* hris.salaryOf("emp-42").pipe(
    Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 2 })))
  )
})

it.effect("the retry observes the scripted recovery", () =>
  Effect.gen(function*() {
    const hris = yield* makeScriptedHris(["down", 120_000])
    const fiber = yield* salaryWithRetry.pipe(Effect.provide(hris.layer), Effect.forkChild)

    assert.strictEqual(yield* Queue.take(hris.received), "emp-42") // attempt 1 is in flight
    yield* TestClock.adjust("200 millis") // latency elapses: HrisUnavailable
    yield* TestClock.adjust("1 second") // retry spacing
    assert.strictEqual(yield* Queue.take(hris.received), "emp-42") // attempt 2 is in flight
    yield* TestClock.adjust("200 millis")

    assert.strictEqual(yield* Fiber.join(fiber), 120_000)
    assert.strictEqual(yield* Queue.size(hris.received), 0) // exactly two calls, no third
  }))
```

Rewrite `salaryOf` so that it picks `script[i++]` in the method body and returns `Effect.fail(...)` or `Effect.succeed(...)` directly, and the same test fails: the method is called once, the retried Effect fails every time, and the counter never passes `1`. That eager version still passes every test that does not retry, which is why the property has to be designed in rather than discovered.

## Test the successful contract

`it.effect` runs the returned Effect, supplies `TestClock` and `TestConsole`, opens a `Scope`, and closes it after the test. Return the Effect directly; do not call a runner inside the test.

**Runnable test — `test/approval.test.ts`:**

```ts
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import {
  ApprovalNotifier,
  ApprovalRepo,
  ApprovalService,
  type Approval
} from "../src/approval.ts"

describe("ApprovalService", () => {
  it.effect("saves before notifying", () =>
    Effect.gen(function*() {
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      const approval: Approval = {
        employeeId: "emp-42",
        cycleId: "fy27",
        amount: 4_200
      }

      const boundaries = Layer.merge(
        Layer.succeed(ApprovalRepo, ApprovalRepo.of({
          save: () => Ref.update(events, (all) => [...all, "saved"])
        })),
        Layer.succeed(ApprovalNotifier, ApprovalNotifier.of({
          send: () => Ref.update(events, (all) => [...all, "notified"])
        }))
      )
      const application = ApprovalService.layer.pipe(
        Layer.provide(boundaries)
      )

      yield* ApprovalService.pipe(
        Effect.flatMap((service) => service.approve(approval)),
        Effect.provide(application)
      )

      assert.deepStrictEqual(yield* Ref.get(events), ["saved", "notified"])
    }))
})
```

The test proves ordering because that ordering is part of the behavior. A test that only asserts success would not detect a notification sent before persistence.

## Assert typed failures as data

Expected failures belong in the `E` channel. Convert the result to data and inspect its tag; do not catch an arbitrary JavaScript exception around a runner.

**Contextual — add to `test/approval.test.ts`:**

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import {
  ApprovalConflict,
  ApprovalNotifier,
  ApprovalRepo,
  ApprovalService
} from "../src/approval.ts"

it.effect("does not notify when persistence rejects the approval", () =>
  Effect.gen(function*() {
    let notified = false
    const boundaries = Layer.merge(
      Layer.succeed(ApprovalRepo, ApprovalRepo.of({
        save: (approval) => Effect.fail(new ApprovalConflict({
          employeeId: approval.employeeId,
          cycleId: approval.cycleId
        }))
      })),
      Layer.succeed(ApprovalNotifier, ApprovalNotifier.of({
        send: () => Effect.sync(() => { notified = true })
      }))
    )
    const application = ApprovalService.layer.pipe(
      Layer.provide(boundaries)
    )

    const result = yield* ApprovalService.pipe(
      Effect.flatMap((service) => service.approve({
        employeeId: "emp-42",
        cycleId: "fy27",
        amount: 4_200
      })),
      Effect.provide(application),
      Effect.result
    )

    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) {
      assert.strictEqual(result.failure._tag, "ApprovalConflict")
    }
    assert.isFalse(notified)
  }))
```

Use `Effect.exit` instead when the assertion needs the full `Cause`, including defects and interruption. A typed failure assertion should not accidentally accept a defect.

Three operators bring a failure into an assertion, and they differ in what a *wrong* outcome does to the test:

| Operator | Yields | If the Effect unexpectedly succeeds | Sees defects and interruption |
| --- | --- | --- | --- |
| `Effect.flip` | the error `E` as the success value | the flipped Effect fails, and so does the test | no — they still fail the test |
| `Effect.result` | `Result<A, E>` | you must assert `Result.isFailure` yourself | no — they still fail the test |
| `Effect.exit` | `Exit<A, E>` with the full `Cause` | you must assert the failure yourself | yes — use `Exit.hasFails`, `Exit.hasDies`, `Exit.hasInterrupts` |

**Runnable test:**

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Exit, Option, Schema } from "effect"

class ApprovalConflict extends Schema.TaggedError<ApprovalConflict>()("ApprovalConflict", {
  employeeId: Schema.String,
  cycleId: Schema.String
}) {}

const approveDuplicate = Effect.fail(
  new ApprovalConflict({ employeeId: "emp-42", cycleId: "fy27" })
)

it.effect("flip: the failure is the value under test", () =>
  Effect.gen(function*() {
    const error = yield* Effect.flip(approveDuplicate)
    assert.strictEqual(error._tag, "ApprovalConflict")
    assert.strictEqual(error.cycleId, "fy27")
  }))

it.effect("exit: a typed failure, and nothing but a typed failure", () =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(approveDuplicate)
    assert.isTrue(Exit.hasFails(exit))
    assert.isFalse(Exit.hasDies(exit))
    assert.isFalse(Exit.hasInterrupts(exit))
    const error = Exit.findErrorOption(exit)
    assert.isTrue(Option.isSome(error) && error.value.employeeId === "emp-42")
  }))
```

- **Assert structure, never rendered text.** Match on `_tag` and fields through `Result`, `Exit`, or `Cause`. `Cause.pretty` output, the message a runner prints for a failed fiber, and `SchemaError.message` are diagnostics whose wording changes between releases; a snapshot of a whole `Cause` or stack is the same mistake in bulk.
- **Prove the post-recovery type as well as the behavior.** A handler that compiles is not proof that only the intended variant left `E` — a broad `Effect.catch` compiles too. Pin it with `expectTypeOf` on `Effect.Error<typeof recovered>`, as shown in [Prove laziness and the static contract](../tooling/testing-dev-tooling#prove-laziness-and-the-static-contract).

Official guide: [Error Channel Operations](https://effect.website/docs/v4/error-management/error-channel-operations).

## Drive time instead of waiting

Anything built on `Clock`—sleep, timeout, retry delay, schedules—uses the virtual clock inside `it.effect`. Fork sleeping work, advance time, then join it.

**Runnable test:**

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

it.effect("retries twice without wall-clock delay", () =>
  Effect.gen(function*() {
    const attempts = yield* Ref.make(0)
    const notify = Effect.gen(function*() {
      const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
      if (attempt < 3) return yield* Effect.fail("transient" as const)
      return "sent" as const
    }).pipe(
      Effect.retry(Schedule.exponential("1 second"))
    )

    const fiber = yield* Effect.forkChild(notify)
    yield* TestClock.adjust("1 second")
    yield* TestClock.adjust("2 seconds")

    assert.strictEqual(yield* Fiber.join(fiber), "sent")
    assert.strictEqual(yield* Ref.get(attempts), 3)
  }))
```

Use `it.live` only when real runtime services are the subject of a small integration smoke test. Wall-clock sleeps make ordinary tests slow and flaky.

### Synchronize on phases, not on turns

The test above works because `notify` reaches its first retry delay within one scheduling turn. `TestClock.adjust` gives already-forked fibers exactly one turn before it moves time, so a fiber that needs more — an extra `yieldNow`, a queue hand-off, a second service call — registers its `sleep` *after* the adjustment and the join never completes. Sprinkling `Effect.yieldNow` between the fork and the adjust is turn-counting: it passes until someone adds a step to the code under test.

The robust pattern is a **handshake per sleep boundary**. The operation announces each attempt; the test waits for the announcement *before* each adjustment; and every attempt records the virtual time at which it ran.

**Runnable test:**

```ts
import { assert, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Queue, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

it.effect("notification attempts run at 0 s, 1 s, and 2 s — never early", () =>
  Effect.gen(function*() {
    const count = yield* Ref.make(0)
    const attempts = yield* Queue.unbounded<{ readonly attempt: number; readonly at: number }>()

    const notify = Effect.gen(function*() {
      const attempt = yield* Ref.updateAndGet(count, (n) => n + 1)
      yield* Queue.offer(attempts, { attempt, at: yield* Clock.currentTimeMillis })
      if (attempt < 3) return yield* Effect.fail("transient" as const)
      return "sent" as const
    })

    const fiber = yield* notify.pipe(
      Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 5 }))),
      Effect.forkChild
    )

    assert.deepStrictEqual(yield* Queue.take(attempts), { attempt: 1, at: 0 })
    yield* TestClock.adjust("1 second")
    assert.deepStrictEqual(yield* Queue.take(attempts), { attempt: 2, at: 1_000 })
    yield* TestClock.adjust("1 second")
    assert.deepStrictEqual(yield* Queue.take(attempts), { attempt: 3, at: 2_000 })

    assert.strictEqual(yield* Fiber.join(fiber), "sent")
    assert.strictEqual(yield* Queue.size(attempts), 0) // and no fourth attempt
  }))
```

- **Each `Queue.take` is both a synchronization point and an assertion.** It cannot return before the attempt happened, and the recorded `at` proves the attempt did not run early.
- **Advance by the full delay**, including any jitter you injected; with a jittered schedule, control `Random` or assert a range.
- **A test timeout is a safety net, never synchronization.** If a test only passes with a longer timeout or a `retry: 3` in the runner config, the missing piece is a handshake.

Retry *policy* — which failures are retried, how the schedule is bounded, what the caller sees after exhaustion — is tested in [Recipe: Typed Retry with TestClock](../recipes/retry-with-test-clock) and explained in [Schedule](../concurrency/scheduling-time#schedule).

## Choose isolation deliberately

Providing a Layer inside one `it.effect` builds and releases it for that test. The top-level `layer(L)` helper instead builds one Layer for the whole block and releases it in `afterAll`.

**Runnable test — shared state is intentional:**

```ts
import { assert, layer } from "@effect/vitest"
import { Context, Effect, Layer, Ref } from "effect"

class Counter extends Context.Service<Counter, Ref.Ref<number>>()("test/Counter") {}

const CounterTest = Layer.effect(Counter, Ref.make(0))

layer(CounterTest)("shared integration fixture", (it) => {
  it.effect("increments", () =>
    Effect.gen(function*() {
      const counter = yield* Counter
      assert.strictEqual(yield* Ref.updateAndGet(counter, (n) => n + 1), 1)
    }))

  it.effect("sees the same layer instance", () =>
    Effect.gen(function*() {
      const counter = yield* Counter
      assert.strictEqual(yield* Ref.get(counter), 1)
    }))
})
```

Shared mutable fixtures introduce order coupling. Use them for integration resources whose sharing is the point; otherwise provide a fresh Layer per test. Nested `it.layer(...)` can add a dependent Layer while retaining the outer context.

Isolation has a second axis: **which clock the fixture lives on**. `layer(L)` builds `L` with `TestClock` and `TestConsole` already provided, so the Layer itself is constructed in virtual time. That is what you want for an in-memory fake and a trap for a real fixture: a database driver's connect timeout, an HTTP server's readiness poll, or a container wait written with `Effect.sleep` parks on a clock nobody advances, and the block hangs until the hook timeout. Make the choice explicit:

| The shared Layer contains | Build the block with | Why |
| --- | --- | --- |
| in-memory fakes and `Ref` state | `layer(L)` | application delays stay drivable with `TestClock.adjust` |
| a real driver, server, or container | `layer(L, { excludeTestServices: true, timeout })` | construction, tests, and teardown all run on the live clock |
| mostly fakes, plus one wall-clock wait | `layer(L)` and `TestClock.withLive(wait)` | only that wait leaves virtual time |

The `it` handed to a `layer` block has no `live` tester, so the block-level option is the switch. The option table is in [Sharing a layer across tests](../tooling/testing-dev-tooling#sharing-a-layer-across-tests).

## Test interruption and cleanup

Resource safety is observable behavior. Test the finalizer, not just the success value.

**Runnable test:**

```ts
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref } from "effect"

it.effect("interrupting a child runs its finalizer", () =>
  Effect.gen(function*() {
    const events = yield* Ref.make<ReadonlyArray<string>>([])
    const started = yield* Deferred.make<void>()
    const worker = Effect.acquireUseRelease(
      Ref.update(events, (all) => [...all, "open"]).pipe(
        Effect.andThen(Deferred.succeed(started, undefined))
      ),
      () => Effect.never,
      () => Ref.update(events, (all) => [...all, "close"])
    )

    const fiber = yield* Effect.forkChild(worker)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)

    assert.deepStrictEqual(yield* Ref.get(events), ["open", "close"])
  }))
```

For scoped services, test through the Layer that owns the resource. `it.effect` already supplies a test Scope; adding `Effect.scoped` around the whole test changes the lifecycle being tested and is normally unnecessary.

Two guarantees are worth a test of their own when a resource matters. A `use` callback that *throws synchronously* — before it returns an Effect — still triggers the release, and the exception stays a defect. And when the body fails *and* the finalizer fails, the resulting `Cause` keeps both reasons — for example a `Fail` and a `Die` — instead of letting the cleanup failure replace the original one, so assert on the reason you care about with `Cause.hasFails` or `Exit.findErrorOption`, not on "the" error.

### Test lifetimes, not just values

Checking the returned value says nothing about cleanup: a suite can be green while every call leaks a handle. "The test returned" is not a leak oracle either, because the per-test `Scope` closes *after* your last assertion. To observe a lifetime, own the `Scope` yourself and assert twice — the **live state** while it is open and the **terminal state** after it closes.

**Runnable test:**

```ts
import { assert, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Ref, Scope } from "effect"

class HrisConnection extends Context.Service<HrisConnection, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("test/HrisConnection") {}

// A counting Layer: the instrumentation wraps the real acquire/release shape.
const countedConnection = (acquired: Ref.Ref<number>, released: Ref.Ref<number>) =>
  Layer.effect(
    HrisConnection,
    Effect.gen(function*() {
      const id = yield* Effect.acquireRelease(
        Ref.updateAndGet(acquired, (n) => n + 1),
        () => Ref.update(released, (n) => n + 1)
      )
      return HrisConnection.of({ query: (sql) => Effect.succeed(`${id}:${sql}`) })
    })
  )

it.effect("acquires once, stays open while in use, releases exactly once", () =>
  Effect.gen(function*() {
    const acquired = yield* Ref.make(0)
    const released = yield* Ref.make(0)
    const counts = Effect.all([Ref.get(acquired), Ref.get(released)])
    const connectionLayer = countedConnection(acquired, released)
    assert.deepStrictEqual(yield* counts, [0, 0]) // describing the Layer acquires nothing

    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(connectionLayer, scope)
    const connection = Context.get(context, HrisConnection)
    yield* connection.query("select 1")
    yield* connection.query("select 2")
    assert.deepStrictEqual(yield* counts, [1, 0]) // live: two uses, one acquisition, not released early

    yield* Scope.close(scope, Exit.void)
    assert.deepStrictEqual(yield* counts, [1, 1]) // terminal: released

    yield* Scope.close(scope, Exit.void)
    assert.deepStrictEqual(yield* counts, [1, 1]) // closing again does not release twice
  }))
```

The four assertions reject four different wrong implementations: eager acquisition (`[1, 0]` before the build), per-call acquisition (`[2, 0]` while live), early release (`[1, 1]` while live), and missing or duplicate release after close. Extend the same shape to the exits that matter for the resource:

| Exit | What to assert |
| --- | --- |
| success, typed failure, defect, interruption | release ran exactly once, and *after* the last use |
| partial acquisition — the second of three resources fails to open | the first is released; the failed one is not "released" as if it had been acquired |
| nested resources | inner releases before outer — assert order only where the order is contractual |
| repeated close | no second release |

Prefer an **external probe** over a counter wherever one exists: rebind the port that was just closed (and show that binding it *before* close fails), delete the temporary directory once handles are closed, read the pool's checked-out count, inspect the listener registry. Open-handle detectors are supporting evidence, not proof. When a test claims that a Layer instance is shared rather than rebuilt, check that the test could tell the difference: count acquisitions as above and compare against a `Layer.fresh` copy, which must acquire again ([Layer](../foundations/services-context-layers#layer) covers the sharing rules). The full ownership model is in [Owning Lifetimes — Startup, Readiness, and Shutdown](./owning-lifetimes-startup-readiness-and-shutdown).

### Force the interleaving you fear

A concurrency bug that appears once in a thousand runs is not under test. Two techniques make the racy schedule happen on *every* run.

**A rendezvous gate.** Every fiber reports its arrival at the dangerous point; the last arrival opens `allArrived`; all of them then wait on a `gate` that the test opens. Placed between a read and a write, it guarantees that every fiber has read before any fiber writes.

**Runnable test:**

```ts
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref } from "effect"

// Runs two spenders against one budget, holding both at `betweenReadAndWrite`.
const spendConcurrently = (
  spend: (budget: Ref.Ref<number>, betweenReadAndWrite: Effect.Effect<void>) => Effect.Effect<void>
) =>
  Effect.gen(function*() {
    const budget = yield* Ref.make(100)
    const arrived = yield* Ref.make(0)
    const allArrived = yield* Deferred.make<void>()
    const gate = yield* Deferred.make<void>()

    const rendezvous = Ref.updateAndGet(arrived, (n) => n + 1).pipe(
      Effect.flatMap((n) => n === 2 ? Deferred.succeed(allArrived, undefined) : Effect.void),
      Effect.andThen(Deferred.await(gate))
    )

    const fibers = yield* Effect.forEach([1, 2], () => Effect.forkChild(spend(budget, rendezvous)))
    yield* Deferred.await(allArrived) // both fibers are parked between read and write
    yield* Deferred.succeed(gate, undefined)
    yield* Fiber.joinAll(fibers)
    return yield* Ref.get(budget)
  })

it.effect("a read-then-write spend loses an update; an atomic update does not", () =>
  Effect.gen(function*() {
    const racy = yield* spendConcurrently((budget, pause) =>
      Effect.gen(function*() {
        const current = yield* Ref.get(budget)
        yield* pause
        yield* Ref.set(budget, current - 10)
      })
    )
    const atomic = yield* spendConcurrently((budget, pause) =>
      pause.pipe(Effect.andThen(Ref.update(budget, (n) => n - 10)))
    )

    assert.strictEqual(racy, 90) // deterministic lost update: both read 100
    assert.strictEqual(atomic, 80)
  }))
```

In application code the rendezvous usually lives inside a fake: the service call that sits between the read and the write is the natural place to park every fiber.

**`startImmediately`.** `Effect.forkChild(effect)` returns before the child has run a single step, so "has it started?" is a race unless you wait for a signal. `Effect.forkChild(effect, { startImmediately: true })` runs the child up to its first suspension before returning — after it, a `Ref` the child sets on entry already reads `true`, with no `yieldNow` guess. The same option exists on `forkIn`, `forkScoped`, and `forkDetach`.

For peak-in-flight assertions, increment on entry and decrement in `Effect.ensuring`, never after the work on the success path, or one failure corrupts every later reading. [Structured Concurrency Through a Bounded Worker](./structured-concurrency-through-a-bounded-worker) applies these techniques to a queue-backed worker.

**Integrate progressively.** Grow a concurrent component in stages — interruption plus finalizer, then bounded fan-out with counters, then a queue worker that drains — and let each test introduce at most two primitives. A red test should point at one idea.

## Test schemas and broad invariants

Use example-based tests for named cases and `it.effect.prop` when the claim applies to all valid values. Schemas can act directly as property arbitraries.

**Runnable test:**

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

const Salary = Schema.Int.check(Schema.isBetween({
  minimum: 50_000,
  maximum: 250_000
}))
const RaiseBasisPoints = Schema.Int.check(Schema.isBetween({
  minimum: 0,
  maximum: 2_000
}))

it.effect.prop(
  "a non-negative raise never lowers salary",
  [Salary, RaiseBasisPoints],
  ([salary, basisPoints]) => Effect.sync(() => {
    const raised = salary + salary * basisPoints / 10_000
    assert.isTrue(raised >= salary)
  }),
  { arbitrary: { runs: 200 } }
)
```

For detailed codec expectations, `effect/testing/TestSchema` adds decode, encode, construction, arbitrary-generation, and lossless-transformation assertions. Keep a few human-readable boundary cases even when property tests cover the larger domain.

A Schema-derived generator produces **valid decoded values**, so a green property says nothing about rejection. Keep named *encoded* fixtures for malformed input, omitted keys that take a decoding default, and representation bugs you have already fixed; put cross-field rules into the schema as a `check` so the generator can see them; and turn every shrunk counterexample into a permanent example test. [What a derived generator cannot test](../tooling/testing-dev-tooling#what-a-derived-generator-cannot-test) has the table.

## Test logs without scraping stdout

Calls through Effect's `Console` service are captured by `TestConsole` in `it.effect`. This does not capture arbitrary `console.log` calls—which is another reason application code should use Effect services.

**Runnable test:**

```ts
import { assert, it } from "@effect/vitest"
import { Console, Effect } from "effect"
import { TestConsole } from "effect/testing"

it.effect("emits an auditable approval message", () =>
  Effect.gen(function*() {
    yield* Console.log("approval saved", { employeeId: "emp-42" })
    assert.deepStrictEqual(yield* TestConsole.logLines, [
      "approval saved",
      { employeeId: "emp-42" }
    ])
  }))
```

`logLines` is flat: every positional argument from every call becomes one array element.

### Capture `Effect.log*` records with a test Logger

`TestConsole` is the seam for `Console.*`. It is the wrong seam for `Effect.logInfo` and its siblings: the default logger prints through `Console`, so a log call does show up in `logLines`, but as rendered output — a prefix string carrying a time stamp in the machine's local zone and a fiber id, then the message parts, then the annotations object. Assert on log **records** instead, by installing an in-memory `Logger` around the Effect under test.

**Runnable test:**

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Logger, Redacted, References } from "effect"
import type { LogLevel } from "effect"

interface LogRecord {
  readonly level: LogLevel.LogLevel
  readonly message: unknown
  readonly annotations: Readonly<Record<string, unknown>>
}

// Replaces the current loggers for `effect` and returns what they were given.
const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const records: Array<LogRecord> = []
    const logger = Logger.make<unknown, void>((options) => {
      records.push({
        level: options.logLevel,
        message: options.message,
        annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) }
      })
    })
    const value = yield* effect.pipe(Effect.provide(Logger.layer([logger])))
    return { value, records } as const
  })

const hrisToken = Redacted.make("hris-token-123")

const approveRaise = Effect.gen(function*() {
  yield* Effect.logDebug("band lookup", { band: "L5" })
  yield* Effect.logInfo("raise approved", { token: hrisToken })
}).pipe(Effect.annotateLogs({ employeeId: "emp-42" }))

it.effect("emits one auditable record, gated by level, without the secret", () =>
  Effect.gen(function*() {
    const { records } = yield* captureLogs(approveRaise)

    assert.strictEqual(records.length, 1) // Debug is below the default minimum level
    assert.strictEqual(records[0]?.level, "Info")
    assert.deepStrictEqual(records[0]?.annotations, { employeeId: "emp-42" })
    assert.notInclude(JSON.stringify(records), "hris-token-123")
  }))
```

`options.message` is the array of arguments passed to the log call. `Logger.layer([logger])` replaces the current loggers, so nothing is printed; pass `{ mergeWithExisting: true }` to keep them. To assert on a lower level, provide `References.MinimumLogLevel` (for example `"Debug"`) around the Effect. [Logger](../operations/observability#logger) documents the production side.

## Test spans structurally

Spans are part of the operational contract — they are how an incident is traced to one approval. Test them with an in-memory `Tracer` that records every span it creates, and assert **structure only**: names, parent links, that each span ended, and whether it ended in failure. Never assert ids, timestamps, or durations.

**Runnable test:**

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Exit, Option, Schema, Tracer } from "effect"

class BandViolation extends Schema.TaggedError<BandViolation>()("BandViolation", {
  employeeId: Schema.String
}) {}

// A named Effect.fn opens a span with that name around every call.
const loadBudget = Effect.fn("MeritCycle.loadBudget")(function*(cycleId: string) {
  yield* Effect.annotateCurrentSpan("cycleId", cycleId)
  return 500_000
})

const applyRaise = Effect.fn("MeritCycle.applyRaise")(function*(employeeId: string) {
  yield* Effect.annotateCurrentSpan("employeeId", employeeId)
  return yield* new BandViolation({ employeeId })
})

const runMeritCycle = Effect.fn("MeritCycle.run")(function*(cycleId: string) {
  yield* loadBudget(cycleId)
  return yield* applyRaise("emp-42")
})

it.effect("a failing child span marks its parent failed, and every span ends", () =>
  Effect.gen(function*() {
    const spans: Array<Tracer.Span> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })

    yield* Effect.exit(runMeritCycle("fy27")).pipe(Effect.provideService(Tracer.Tracer, tracer))

    const summary = spans.map((span) => ({
      name: span.name,
      parent: Option.isSome(span.parent) && span.parent.value._tag === "Span"
        ? span.parent.value.name
        : undefined,
      failed: span.status._tag === "Ended" ? Exit.isFailure(span.status.exit) : undefined
    }))

    assert.deepStrictEqual(summary, [
      { name: "MeritCycle.run", parent: undefined, failed: true },
      { name: "MeritCycle.loadBudget", parent: "MeritCycle.run", failed: false },
      { name: "MeritCycle.applyRaise", parent: "MeritCycle.run", failed: true }
    ])
    assert.strictEqual(spans[2]?.attributes.get("employeeId"), "emp-42")
  }))
```

A `failed: undefined` entry would mean a span that never ended — a leaked span, which is a lifetime bug like any other. Attribute assertions double as a disclosure test: check that the identifying field is present and that nothing secret is. [Tracer](../operations/observability#tracer) covers span creation and export.

## Assert against the likely mistake

A passing test is only interesting if a believable wrong implementation would fail it. For each behavior, name the mistakes your team actually makes, then check that at least one assertion turns red for each. This converts "the test passes" into "the test would have caught it".

| Plausible wrong implementation | The assertion that rejects it |
| --- | --- |
| hard-coded success (`Effect.succeed(expected)`) | a second case with a different expected value; a spy call count of `1` |
| the injected fake is ignored and a live default is used | exact forwarded arguments on the spy, and a live-side counter that stays `0` |
| a step is skipped — input is parsed but never sent | the ordered event log (`["saved", "notified"]`), not just the result |
| catch-all recovery swallows a failure that should propagate | an `Exit` assertion on the variant that must still fail, plus `expectTypeOf` on `E` |
| a believable default is returned after a failed decode | a malformed-input case that must fail with a schema issue |
| cleanup runs on the success path only (`tap` plus `tapError` instead of `ensuring`) | the lifetime test under **interruption**, not just success and failure |
| early or duplicate release | live-state `[1, 0]` and terminal-state `[1, 1]` counters, plus a second close |
| sequential execution where a bound was intended — or unbounded where a bound was required | peak-in-flight counter asserted to equal the bound exactly |
| an update that is atomic per step but wrong as a whole (read, then write) | the rendezvous test that forces both reads before either write |
| retry of every failure, including permanent ones | a permanent failure with an attempt counter that must stay at `1` |
| a runner inside the program, or one runtime built per request | the inertness counter (`0` before run); one acquisition across many requests |
| collect everything, then slice | a pull counter on the source: a prefix of `n` must perform no later reads |
| rows paired to requests by position | shuffled rows with one id missing and one duplicated |
| the write happens outside the transaction, or recovery happens inside it | a forced failure after the first write, then a row count of `0` |

Counters (`Ref`), latches (`Deferred`), and recorded virtual time give deterministic evidence for every row; "it returned the right value" distinguishes almost none of them.

## The testing pyramid for an Effect service

Use the smallest boundary that proves the claim:

1. Pure tests for data transformations and constructors.
2. `it.effect` with small fake Layers for orchestration, errors, time, and cancellation.
3. Tests with real codecs and in-memory Effect runtimes such as `WorkflowEngine.layerMemory` or `TestRunner.layer`.
4. A narrow adapter integration test for SQL, HTTP, filesystem, or a provider sandbox.
5. A small end-to-end smoke test with the production Layer graph.
6. A built-artifact test that launches what you actually ship.

The same service program should flow through levels two through five. Only its provided Layer graph changes. Level three keeps the real protocol machinery and removes one piece of infrastructure; [In-memory test runtimes shipped with Effect](../tooling/testing-dev-tooling#in-memory-test-runtimes-shipped-with-effect) lists what each harness keeps and what it cannot show.

### The built-artifact lane

Levels one through five import source modules. None of them shows that the package builds, that the entry point wires the graph, that the process reports readiness, or that it exits cleanly — and those are the failures that reach production on a green suite. One lane, kept small, runs the artifact itself:

1. **Build and package** exactly as the release pipeline does; test the output, not the source tree.
2. **Launch the real entry point** as a child process with temporary configuration: an OS-assigned port, a scratch directory, a throwaway database.
3. **Wait for an explicit readiness event** — a health endpoint that answers, or a line the process prints on purpose. Never a fixed delay.
4. **Exercise one success and one failure** through the public interface, asserting the external contract: status, body, exit code.
5. **Request graceful shutdown** the way the platform will (`SIGTERM` on POSIX hosts) and enforce an outer deadline. Forced termination is the failure path, never the happy path.
6. **Assert the terminal state**: the exit status, and that the port can be rebound, the lock file is gone, and no child process survives.

Add two startup-failure cases: invalid configuration must exit non-zero with an actionable message *before* anything is acquired, and an occupied port must roll back whatever had already started. Mark signal-based tests as platform-specific and give other hosts an equivalent trigger rather than skipping the lane.

| This lane proves | It does not prove |
| --- | --- |
| the shipped artifact starts, becomes ready, serves, and releases its resources on shutdown | behavior under production load, real data volume, or real network partitions |

[Recipe: A Graceful Node Entrypoint](../recipes/graceful-entrypoint-and-shutdown) shows the entry point this lane launches.

## A contract for real fixtures

An adapter test is only evidence if its fixture is real, isolated, and honest about availability. Hold every real fixture — database, broker, HTTP server, temporary directory — to the same contract:

| Rule | Reason |
| --- | --- |
| **Acquire it through a scoped Layer.** | Acquisition, readiness, and teardown get one owner, and the same interruption guarantees as production code. |
| **Name it uniquely per worker**: schema, database, directory, and an OS-assigned port. | Parallel workers and a developer's leftover state cannot collide. |
| **Migrate during acquisition and report ready only after a real probe** — a query, a request, a bind. | A delay is not readiness; it is a slower race. |
| **Close the `Scope` before removing the external fixture.** | Dropping a database under open connections turns teardown errors into noise that hides real ones. |
| **Never swallow a cleanup failure.** | A fixture that cannot be removed is tomorrow's flake; fail loudly now. |
| **Keep logs and diagnostics when a test fails.** | The container log is usually the only explanation for a readiness timeout. |
| **Give every test its own disposable database and credentials.** | A suite that can reach someone's working database or a production account is not safe to run on any machine, repeatedly. |
| **Required infrastructure that is unavailable fails the lane** or marks it visibly incomplete. | A silent skip reports green with zero evidence. |
| **Build the block on the live clock.** | Real drivers and readiness probes do not advance with `TestClock` — see [Choose isolation deliberately](#choose-isolation-deliberately). |

**Illustrative — a scoped fixture Layer:**

```ts
import { Context, Effect, Layer, Schema } from "effect"

class FixtureError extends Schema.TaggedError<FixtureError>()("FixtureError", {
  step: Schema.String
}) {}

class PayrollDb extends Context.Service<PayrollDb, {
  readonly url: string
}>()("test/PayrollDb") {}

declare const workerId: string // for example Vitest's pool id
declare const createDatabase: (name: string) => Effect.Effect<{ readonly url: string }, FixtureError>
declare const dropDatabase: (name: string) => Effect.Effect<void, FixtureError>
declare const migrate: (url: string) => Effect.Effect<void, FixtureError>
declare const probe: (url: string) => Effect.Effect<void, FixtureError>

export const PayrollDbFixture = Layer.effect(
  PayrollDb,
  Effect.gen(function*() {
    const name = `payroll_test_${workerId}`
    const database = yield* Effect.acquireRelease(
      createDatabase(name),
      // A failed drop becomes a defect: loud, never swallowed.
      () => dropDatabase(name).pipe(Effect.orDie)
    )
    yield* migrate(database.url)
    yield* probe(database.url) // ready means "answered a real query", not "waited a while"
    return PayrollDb.of({ url: database.url })
  })
)
```

Finalizers run in reverse order of acquisition, so a repository Layer built on top of `PayrollDb` closes its pool before this Layer drops the database; that ordering is what satisfies "close before removing the fixture". Use the block form `layer(PayrollDbFixture, { excludeTestServices: true, timeout: "60 seconds" })` so that the acquisition above runs on the live clock.

## When green means nothing

A suite can be entirely green and entirely uninformative. Audit for these before trusting a result:

| False green | How to detect it |
| --- | --- |
| an Effect returned from plain `it(...)` — Vitest never runs it | the `floatingEffectInVitest` diagnostic; grep for `it(` callbacks that return `Effect.` |
| assertion-free tests, or "does not throw" as the only claim | every test names the invariant it checks; count assertions in review |
| success-only coverage | for each operation, at least one typed-failure case and, for resourceful code, one interruption case |
| a fake is declared but never provided, so a live default still answers | a live-side counter that must stay `0`, and a spy call count that must not |
| a broad mock presented as adapter evidence | the adapter has at least one test against a real fixture |
| a typed client that cannot express malformed wire input | raw-request tests below the typed client for decode failures |
| an integration suite that skips itself when a dependency is missing | required lanes fail when the dependency is absent; skipped counts are reported and reviewed |
| every test imports source files, and nothing ever starts the packaged build | the built-artifact lane above |
| shared mutable Layer state under concurrent tests | per-test Layers, or state designed for interleaving |
| real sleeps, polling loops, oversized timeouts, blanket retries | `TestClock`, handshakes, and the flake protocol below |
| snapshots of whole `Cause`s, stacks, or rendered messages | structural assertions on `_tag` and fields |

**A green command that collected zero relevant tests is a failure.** Check the script, workspace filters, `include` and `exclude` globs, the CI working directory, and environment-gated skips. Run the exact file, then the package command, then the CI-equivalent command, and compare the collected counts — they should differ only in ways you can explain.

### When a test flakes

On the **first** failure, keep the evidence: seed, worker id, ports, versions, a fiber dump if you have one, fixture logs, and the phase timeline from your handshakes. Then classify the cause before touching the test:

| Cause | Fix |
| --- | --- |
| shared state between tests | isolate the Layer, or make the state order-independent |
| missing readiness signal | add a probe or a handshake |
| arbitrary timing — real sleeps, turn-counting | `TestClock` plus a phase handshake |
| leaked ownership — a fiber or handle from an earlier test | fix the lifetime; add the lifetime test that would have caught it |
| resource collision — ports, names, directories | unique per-worker names and OS-assigned ports |
| true external eventual consistency | the only case that may justify a bounded retry, with artifacts kept from every attempt |

Quarantine only with a named owner and an expiry date. Build one deterministic reproducer before adding stress repetitions: a thousand reruns of a test that cannot fail deterministically only measure luck.

## Capstone test plan

For the approval service, a meaningful suite covers:

- success ordering: persist, then notify;
- typed conflict: notification is not attempted;
- transient notification: bounded retry follows virtual time;
- interruption: an in-flight adapter closes its resource;
- schema boundaries: valid payloads round-trip and malformed input fails;
- idempotency: repeating the same employee/cycle does not duplicate the durable write;
- integration: the real repository Layer honors its transaction and uniqueness contract;
- observability: the expected log/span fields identify the operation without exposing secrets.

That plan validates behavior rather than implementation structure. It remains stable when internal combinators are refactored.

**Boundary placement is itself testable.** Where a check, a bound, or a commit happens is a behavior, and a counter on the far side of the boundary observes it:

| Placement claim | Evidence |
| --- | --- |
| invalid input is rejected at ingress | the repository fake's call counter stays `0` for a malformed payload |
| a prefix of a large source reads no more than it needs | a pull counter on the source after `take(n)` |
| many requests share one expensive resource | one acquisition across the whole run, from the counting Layer |
| the durable write commits before the external delivery | the ordered event log reads `["committed", "delivered"]` |
| a cache entry expires when its TTL says so | a lookup counter, with `TestClock.adjust` to just before and just after the TTL |
| concurrent callers share one in-flight lookup | the lookup signals "started", the test asserts a count of `1` while callers are parked, then releases it |
| a batched resolver settles every request | rows returned shuffled, with one id missing and one duplicated: one backend call, caller-order results, no request left hanging |

[Caching & Batching](../operations/caching-batching) describes the cache and resolver semantics those last three rows exercise. Finish each item in the plan by writing its "does not prove" line; the gaps that remain are the integration and artifact lanes' job list.

## Operational checklist

- Pin `effect`, every `@effect/*` package, TypeScript, and `@effect/tsgo` coherently.
- State each test's claim, boundary, and "does not prove" line; never quote a lower step as evidence for a higher boundary.
- Characterize legacy behavior with latches and counters before migrating it; change those assertions, not new ones, when the contract changes.
- Use `it.effect`; reserve `it.live` for a deliberate live-service check.
- Return Effects from tests instead of invoking runners inside them, and never return an Effect from plain `it(...)`.
- Provide typed fake Layers at application boundaries; never mock the `effect` module.
- Make fakes spies, lazy, and clock-driven: record calls, choose scripted answers at run time, simulate latency with `Effect.sleep`.
- Assert that construction is inert for every adapter around legacy code.
- Pin `E` and `R` with type-level tests, and type-check the test project in CI.
- Advance `TestClock`; never wait through production delays. Synchronize on a handshake per sleep boundary, not on `Effect.yieldNow`.
- Make time assertions two-sided: not yet before the instant, exactly once after it.
- Assert typed failures separately from defects and interruption, on structure rather than rendered text.
- Test finalizers and interrupted children for resource-owning code; assert the live state before close and the terminal state after it.
- Force dangerous interleavings with a rendezvous gate instead of hoping a race appears.
- Decide whether every Layer is per-test or shared, and which clock it is built on; document shared state.
- Use Schema-driven properties for broad invariants, named encoded fixtures for rejection, and a regression example for every shrunk counterexample.
- Capture `Effect.log*` with a test `Logger` and spans with an in-memory `Tracer`; assert structure and the absence of secrets.
- For each behavior, name the plausible wrong implementation and confirm an assertion rejects it.
- Hold real fixtures to the fixture contract; an unavailable required dependency fails the lane.
- Keep one built-artifact lane: launch, wait for readiness, exercise, shut down gracefully, assert the terminal state.
- Treat zero collected tests, silent skips, and blanket retries as failures.
- Run strict TypeScript and Effect diagnostics on test code as well as application code.
- Keep integration failures actionable by naming the exact external service and setup they require.

[Review Checklists](../reference/review-checklists) collects the review-time version of these rules for every area of the handbook.

Continue with [Core Runtime & Execution](../foundations/core-runtime-execution.md) for interruption and scope semantics, or [The Durability and Distribution Ladder](./durability-and-distribution-ladder.md) for choosing the in-memory and durable test runtime that matches production.
