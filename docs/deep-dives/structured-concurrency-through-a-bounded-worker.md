# Structured Concurrency Through a Bounded Worker

A worker pool is not merely “start N promises.” It has ownership, capacity, failure, completion, cancellation, and cleanup semantics. This guide builds those semantics from Effect's structured fibers, bounded `Queue`, `Stream`, `Semaphore`, and test services against `effect@4.0.0-rc.108`.

Use [Core Runtime & Execution](../foundations/core-runtime-execution) for fibers and scopes, [Concurrency & Coordination](../concurrency/concurrency-coordination) for queues and semaphores, [State & Mutable References](../concurrency/state-mutable-references) for counters, [Software Transactional Memory](../concurrency/software-transactional-memory) for multi-value atomic coordination, [Streaming & Channels](../concurrency/streaming-channels) for pipeline operators, and [Testing & Dev Tooling](../tooling/testing-dev-tooling) for deterministic tests.

## Choose the smallest concurrency shape

Start with the shape of the work, not a favorite primitive.

| Problem | Default primitive |
| --- | --- |
| A finite collection is already in memory | `Effect.forEach(items, work, { concurrency })` |
| A source emits over time and one pipeline owns consumption | `Stream.mapEffect(work, { concurrency })` |
| Producers and consumers have independent lifetimes | bounded `Queue` |
| Every subscriber must see every message | `PubSub` |
| One shared external limit surrounds several code paths | `Semaphore` |
| Limits are independent per tenant/key | `PartitionedSemaphore` |
| Dynamic tasks must be tracked as a group | `FiberSet` or `FiberMap` |
| Several state changes must commit atomically or wait for change | STM (`TxRef`, `TxQueue`, and friends) |

Do not build a queue when `Effect.forEach` already owns the finite list. A queue earns its complexity when enqueueing and processing must be decoupled, when capacity must push back on producers, or when multiple producers share workers.

## Structured concurrency is ownership

`Effect.forkChild(effect)` creates a supervised child fiber. If its parent ends, the child is interrupted; keep and join the `Fiber` when its result matters. `forkScoped` ties a fiber to an explicit surrounding Scope. `forkDetach` moves a fiber to the global scope and is therefore an exceptional choice for work that intentionally outlives its requester.

Higher-level concurrency operators already own their children:

- `Effect.all` and `forEach` start bounded or unbounded children and collect results.
- `Stream.mapEffect` owns per-element Effects and interrupts them when the pipeline stops.
- `race` interrupts the losing branch after the first success; `raceFirst` uses first completion.
- Closing a Scope interrupts fibers forked into it and runs registered finalizers.

Structured ownership means failure and cancellation travel in both directions. If a worker fails the pipeline, sibling work is interrupted unless you deliberately turn each job's failure into a value.

> **Example status — Runnable:** for a known finite batch, this is the whole worker pool.

```ts
import { Effect } from "effect"

const jobs = [1, 2, 3, 4, 5]

const processJob = Effect.fn("processJob")((job: number) =>
  Effect.succeed(job * 2)
)

const results = await Effect.runPromise(
  Effect.forEach(jobs, processJob, { concurrency: 3 })
)

console.log(results) // [2, 4, 6, 8, 10]
```

At most three calls are in flight, and results retain input order. There is no queue because there is no independent producer.

## Capacity is part of the contract

A bounded Queue suspends an offer when capacity is full. That suspension is backpressure: the producer cannot outrun the memory budget chosen by the application.

- `Queue.bounded(capacity)` suspends producers when full.
- A dropping queue rejects new offers with `false` when full.
- A sliding queue accepts new offers and evicts the oldest buffered value.
- An unbounded queue never pushes back and can grow with the producer/consumer gap.

For work that must be processed, use bounded. Dropping and sliding are loss policies suitable for telemetry samples or latest-state updates, not hidden performance switches.

> **Example status — Runnable:** the producer cannot finish its second offer until the consumer frees capacity.

```ts
import { Effect, Fiber, Queue } from "effect"

const program = Effect.gen(function*() {
  const queue = yield* Queue.bounded<number>(1)
  const producer = yield* Queue.offerAll(queue, [1, 2]).pipe(Effect.forkChild)

  yield* Effect.yieldNow
  console.log(producer.pollUnsafe()) // undefined: offer of 2 is backpressured

  const first = yield* Queue.take(queue)
  yield* Effect.yieldNow
  const offered = yield* Fiber.join(producer)
  const second = yield* Queue.take(queue)

  return { first, second, unoffered: offered }
})

console.log(await Effect.runPromise(program))
// { first: 1, second: 2, unoffered: [] }
```

`offerAll` returns values that were not accepted. For a bounded queue it waits until values can be accepted; dropping queues return rejected values instead.

## Define a job protocol

A job should contain enough stable identity to make processing observable and, if it crosses a durability boundary, idempotent. Keep the queue's in-memory message distinct from a remote or persisted delivery guarantee: an ordinary Queue is lost when the process stops.

> **Example status — Runnable:** Schema makes the job and its expected failure explicit.

```ts
import { Schema } from "effect"

class RecalculateEmployee extends Schema.Class<RecalculateEmployee>(
  "handbook/RecalculateEmployee"
)({
  jobId: Schema.String.check(Schema.isMinLength(1)),
  employeeId: Schema.String.check(Schema.isMinLength(1)),
  attempt: Schema.Natural
}) {}

class JobFailed extends Schema.TaggedError<JobFailed>()("JobFailed", {
  jobId: Schema.String,
  retryable: Schema.Boolean,
  reason: Schema.String
}) {}

const job = new RecalculateEmployee({
  jobId: "cycle-2026:e-42",
  employeeId: "e-42",
  attempt: 0
})

console.log(job.jobId)
```

If jobs must survive a crash, replace the ingress with [PersistedQueue](../tooling/persistence#persistedqueue), an SQL outbox, or a durable [Workflow](../systems/workflows-durable-execution). The in-process concurrency pattern can remain similar, but delivery, acknowledgment, and idempotency become durable protocol concerns.

## Turn a Queue into a bounded worker pipeline

`Stream.fromQueue(queue)` consumes values with backpressure. `Stream.mapEffect(work, { concurrency: n })` owns at most `n` in-flight jobs. This composition is usually simpler than writing N manual infinite loops, and Stream correctly carries queue completion, failure, and cancellation.

> **Example status — Contextual:** `sourceJobs` may come from pagination, a file, or another service. The queue bridges its lifetime to processing.

```ts
import { Cause, Effect, Fiber, Queue, Stream } from "effect"

declare const sourceJobs: ReadonlyArray<RecalculateEmployee>
declare const processJob: (
  job: RecalculateEmployee
) => Effect.Effect<void, JobFailed>

const runWorkers = Effect.gen(function*() {
  const queue = yield* Queue.bounded<RecalculateEmployee, Cause.Done>(128)

  const producer = yield* Effect.gen(function*() {
    yield* Queue.offerAll(queue, sourceJobs)
    yield* Queue.end(queue)
  }).pipe(Effect.forkChild)

  yield* Stream.fromQueue(queue).pipe(
    Stream.mapEffect(processJob, { concurrency: 8 }),
    Stream.runDrain
  )

  yield* Fiber.join(producer)
})
```

`Queue.end` stops further offers but preserves buffered values. `Stream.fromQueue` drains them and ends normally when it observes `Cause.Done`. Joining the producer surfaces its completion before `runWorkers` returns.

If `processJob` fails, `Stream.runDrain` fails and interrupts remaining in-flight work. Because the producer is a child, it is also interrupted as the parent unwinds; it cannot remain blocked forever trying to offer into an abandoned queue.

## Decide whether one job may fail the batch

There are two valid policies:

- **Fail fast:** let `JobFailed` stay in the Stream error channel. The first failure ends the pipeline and interrupts sibling work.
- **Collect outcomes:** apply `Effect.result` per element. Each failure becomes `Result.Failure`, so the Stream itself can continue.

Do not catch all causes per job. Expected job failures may become values; defects and interruption should still terminate ownership unless the protocol explicitly says otherwise.

> **Example status — Contextual:** this changes only typed job failures into values.

```ts
import { Effect, Result, Stream } from "effect"

declare const jobs: Stream.Stream<RecalculateEmployee>
declare const processJob: (
  job: RecalculateEmployee
) => Effect.Effect<string, JobFailed>

const outcomes: Stream.Stream<Result.Result<string, JobFailed>> = jobs.pipe(
  Stream.mapEffect(
    (job) => processJob(job).pipe(Effect.result),
    { concurrency: 8 }
  )
)
```

Apply retry inside `processJob` only when the complete job operation is repeatable. A stable `jobId` does not create idempotency by itself; the external writer must enforce it. See [Failure, Retry, Fallback, and Interruption](failure-retry-fallback-and-interruption).

## Put shared limits around the actual bottleneck

Worker count and external-resource capacity are different limits. Eight workers may perform CPU work but share only three outbound HRIS permits. A `Semaphore` around the HTTP call lets unrelated call sites obey the same limit.

> **Example status — Contextual:** the permit is released on success, typed failure, defect, or interruption.

```ts
import { Effect, Semaphore } from "effect"

declare const callHris: (
  job: RecalculateEmployee
) => Effect.Effect<string, JobFailed>

const makeProcessor = Effect.gen(function*() {
  const hrisPermits = yield* Semaphore.make(3)

  return Effect.fn("Recalculate.process")((job: RecalculateEmployee) =>
    hrisPermits.withPermit(callHris(job))
  )
})
```

Use one semaphore value shared by all callers that participate in the limit. Constructing a semaphore inside every job gives each job its own permits and enforces nothing. Use `PartitionedSemaphore` when each tenant/key needs an independent limit with fair coordination.

## Coordinate state at the right level

Use a `Ref` for one atomic counter or snapshot. Use `SynchronizedRef` when computing the new value itself is effectful and must be serialized. Use STM when a decision reads and updates multiple pieces of transactional state, or must wait until a state predicate changes.

For example, “take one job, reserve its department budget, and decrement capacity atomically” is not safely expressed as three independent `Ref` updates. A `TxQueue` and `TxRef` can participate in one `Effect.tx`. Keep network and logging effects outside the transaction because STM may rerun its body before commit.

## Complete, interrupt, or shut down deliberately

Queue termination APIs encode different operational policies:

| Operation | New offers | Buffered values | Terminal outcome |
| --- | --- | --- | --- |
| `Queue.end` | rejected | drained | normal `Cause.Done` completion |
| `Queue.fail(error)` | rejected | drained | typed failure after drain |
| `Queue.interrupt` | rejected | drained | interruption after drain |
| `Queue.shutdown` | rejected | discarded immediately | interruption immediately |

`Queue.end` signals that no more work will arrive; it does not wait for buffered work to finish. Consumers drain it, and `Queue.await` waits until the queue reaches its final Done state. Use `shutdown` for emergency cancellation where abandoning buffered work is intentional.

For process shutdown, stop ingress first, end or interrupt the queue according to policy, wait for the pipeline within a deadline, then let outer Scope closure interrupt anything still running. If abandoning an in-memory job would violate the product contract, the job needed durable storage before shutdown began.

## Track dynamic work only when it is truly dynamic

`FiberSet` owns an open-ended group of fibers and removes them as they complete. It is useful when tasks arrive from callbacks or subscriptions and cannot be represented as one `forEach` call. Closing its Scope interrupts remaining members. `awaitEmpty` waits until no tasks remain but does not report their failures; `join` reports the first non-interruption failure but does not mean “all succeeded.” Race the two when either successful completion or failure must finish the group.

> **Example status — Contextual:** every submitted notification is supervised by the surrounding Scope.

```ts
import { Effect, FiberSet } from "effect"

declare const notify: (employeeId: string) => Effect.Effect<void, JobFailed>

const notificationRuntime = Effect.scoped(
  Effect.gen(function*() {
    const fibers = yield* FiberSet.make()
    yield* FiberSet.run(fibers, notify("e-1"))
    yield* FiberSet.run(fibers, notify("e-2"))
    yield* Effect.raceFirst(
      FiberSet.join(fibers),
      FiberSet.awaitEmpty(fibers)
    )
  })
)
```

Prefer a Queue when tasks need admission capacity or ordering. A FiberSet supervises work already admitted; it is not itself a backpressure mechanism.

## Runnable capstone: bounded admission and bounded execution

The capstone has an independently forked producer, a two-item queue, two concurrent workers, per-job typed outcomes, and counters proving that execution never exceeds the worker limit.

> **Example status — Runnable:** copy it into a TypeScript file and run with Node 26+.

```ts
import { Cause, Effect, Fiber, Queue, Ref, Result, Schema, Stream } from "effect"

class Job extends Schema.Class<Job>("handbook/BoundedJob")({
  id: Schema.Int,
  shouldFail: Schema.Boolean
}) {}

class JobError extends Schema.TaggedError<JobError>()("JobError", {
  id: Schema.Int,
  reason: Schema.String
}) {}

const runPool = (jobs: ReadonlyArray<Job>, concurrency: number) =>
  Effect.gen(function*() {
    const queue = yield* Queue.bounded<Job, Cause.Done>(2)
    const inFlight = yield* Ref.make(0)
    const maximumInFlight = yield* Ref.make(0)

    const process = Effect.fn("Job.process")(function*(job: Job) {
      const active = yield* Ref.updateAndGet(inFlight, (n) => n + 1)
      yield* Ref.update(maximumInFlight, (current) => Math.max(current, active))

      return yield* Effect.gen(function*() {
        yield* Effect.yieldNow
        if (job.shouldFail) {
          return yield* new JobError({ id: job.id, reason: "declared failure" })
        }
        return job.id * 10
      }).pipe(
        Effect.ensuring(Ref.update(inFlight, (n) => n - 1))
      )
    })

    const producer = yield* Effect.gen(function*() {
      yield* Queue.offerAll(queue, jobs)
      yield* Queue.end(queue)
    }).pipe(Effect.forkChild)

    const outcomes = yield* Stream.fromQueue(queue).pipe(
      Stream.mapEffect(
        (job) => process(job).pipe(Effect.result),
        { concurrency }
      ),
      Stream.runCollect
    )

    yield* Fiber.join(producer)
    return {
      outcomes,
      maximumInFlight: yield* Ref.get(maximumInFlight)
    }
  })

const result = await Effect.runPromise(
  runPool([
    new Job({ id: 1, shouldFail: false }),
    new Job({ id: 2, shouldFail: true }),
    new Job({ id: 3, shouldFail: false }),
    new Job({ id: 4, shouldFail: false })
  ], 2)
)

console.log(result.maximumInFlight) // 2
console.log(result.outcomes.map((outcome) =>
  Result.match(outcome, {
    onFailure: (error) => `failed:${error.id}`,
    onSuccess: (value) => `ok:${value}`
  })
))
// ["ok:10", "failed:2", "ok:30", "ok:40"]
```

`Effect.result` catches only the typed `JobError` channel. A defect or interruption still terminates the pipeline. The finalizer decrements `inFlight` on every exit, so the operational counter does not leak when processing fails or is canceled.

## Test backpressure, concurrency, and cleanup

Do not test concurrency with wall-clock sleeps. Use a bounded queue, `Deferred`/`Latch`, and `TestClock` to put fibers in known states, then assert admission, in-flight limits, interruption, and finalization.

> **Example status — Runnable in Vitest:** the first assertion proves admission backpressure; the second proves queue shutdown unblocks the producer.

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Queue } from "effect"

it.effect("backpressures a producer and cancels it on shutdown", () =>
  Effect.gen(function*() {
    const queue = yield* Queue.bounded<number>(1)
    const producer = yield* Queue.offerAll(queue, [1, 2, 3]).pipe(
      Effect.forkChild
    )

    yield* Effect.yieldNow
    assert.isUndefined(producer.pollUnsafe())
    assert.strictEqual(yield* Queue.size(queue), 1)

    assert.strictEqual(yield* Queue.take(queue), 1)
    yield* Effect.yieldNow
    assert.isUndefined(producer.pollUnsafe()) // 2 buffered; 3 still blocked

    yield* Queue.shutdown(queue)
    const exit = yield* Fiber.await(producer)
    assert.isTrue(Exit.isSuccess(exit))
    if (Exit.isSuccess(exit)) {
      assert.deepStrictEqual(exit.value, [3]) // the unaccepted remainder
    }
  }))
```

Also test fail-fast versus collect-outcomes policy, the exact maximum concurrent count, normal `end` draining every accepted job, and Scope closure running each job's cleanup. For retrying workers, use `TestClock` and assert the attempt count and stable idempotency key.

## Operational checklist

- Use `forEach` for an owned finite batch; introduce Queue only for independent lifetimes or admission control.
- Bound both buffered capacity and in-flight execution; they solve different problems.
- Choose dropping/sliding only when losing work is an explicit domain policy.
- Keep producer fibers supervised and join them when their outcome matters.
- Let Stream own concurrent worker Effects and propagate cancellation.
- Decide explicitly whether one typed job failure fails the batch or becomes a `Result` value.
- Let defects and interruption escape per-job recovery unless the protocol explicitly owns them.
- Share one Semaphore around the actual constrained resource.
- Use Ref for one atomic value and STM for multi-value atomic decisions.
- End to drain normally; interrupt to drain then cancel; shut down only to discard immediately.
- Stop ingress before draining during process shutdown.
- Persist jobs before admission when losing accepted work across restart is unacceptable.
- Track open-ended work with FiberSet only after admission has been controlled.
- Test fiber states with coordination primitives and virtual time, never timing guesses.

The governing rule is: **every fiber has an owner, every buffer has a capacity, every failure has a policy, and every shutdown says whether accepted work drains or is abandoned.**
