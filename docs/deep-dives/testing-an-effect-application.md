# Testing an Effect Application

> Audited **2026-08-12** against `effect@4.0.0-rc.108`. This guide uses `@effect/vitest@4.0.0-rc.108`, Vitest 4.1+, TypeScript 7 strict mode, and the test services shipped by the same Effect release.

An Effect test should exercise the same program description as production while replacing only its boundary Layers. That means testing values, typed failures, required services, time, interruption, and resource lifetime without putting `runPromise`, global mocks, or real sleeps inside application code.

Examples are labelled **Runnable** when they form a complete test or Node program, **Contextual** when a local module is intentionally imported, and **Illustrative** when the code shows architecture rather than a copy-ready file.

For individual APIs, use [Testing & Dev Tooling](../tooling/testing-dev-tooling.md), [Services, Context & Layers](../foundations/services-context-layers.md), and [Errors, Option & Result](../foundations/errors-option-result.md). This guide connects those primitives into one application-shaped test strategy.

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
  { fastCheck: { numRuns: 200 } }
)
```

For detailed codec expectations, `effect/testing/TestSchema` adds decode, encode, construction, arbitrary-generation, and lossless-transformation assertions. Keep a few human-readable boundary cases even when property tests cover the larger domain.

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

## The testing pyramid for an Effect service

Use the smallest boundary that proves the claim:

1. Pure tests for data transformations and constructors.
2. `it.effect` with small fake Layers for orchestration, errors, time, and cancellation.
3. Tests with real codecs and in-memory Effect runtimes such as `WorkflowEngine.layerMemory` or `TestRunner.layer`.
4. A narrow adapter integration test for SQL, HTTP, filesystem, or a provider sandbox.
5. A small end-to-end smoke test with the production Layer graph.

The same service program should flow through levels two through five. Only its provided Layer graph changes.

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

## Operational checklist

- Pin `effect`, every `@effect/*` package, TypeScript, and `@effect/tsgo` coherently.
- Use `it.effect`; reserve `it.live` for a deliberate live-service check.
- Return Effects from tests instead of invoking runners inside them.
- Provide typed fake Layers at application boundaries.
- Advance `TestClock`; never wait through production delays.
- Assert typed failures separately from defects and interruption.
- Test finalizers and interrupted children for resource-owning code.
- Decide whether every Layer is per-test or shared; document shared state.
- Use Schema-driven properties for broad invariants and examples for important cases.
- Run strict TypeScript and Effect diagnostics on test code as well as application code.
- Keep integration failures actionable by naming the exact external service and setup they require.

Continue with [Core Runtime & Execution](../foundations/core-runtime-execution.md) for interruption and scope semantics, or [The Durability and Distribution Ladder](./durability-and-distribution-ladder.md) for choosing the in-memory and durable test runtime that matches production.
