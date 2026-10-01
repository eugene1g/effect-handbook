# Structured Concurrency Through a Bounded Worker

A worker pool is not merely “start N promises.” It has ownership, capacity, failure, completion, cancellation, and cleanup semantics. This guide builds those semantics from Effect's structured fibers, bounded `Queue`, `Stream`, `Semaphore`, and test services against `effect@4.0.0`.

Use [Core Runtime & Execution](../foundations/core-runtime-execution) for fibers and scopes, [Concurrency & Coordination](../concurrency/concurrency-coordination) for queues and semaphores, [State & Mutable References](../concurrency/state-mutable-references) for counters, [Software Transactional Memory](../concurrency/software-transactional-memory) for multi-value atomic coordination, [Streaming & Channels](../concurrency/streaming-channels) for pipeline operators, and [Testing & Dev Tooling](../tooling/testing-dev-tooling) for deterministic tests.

> **Official guides:** the Fibers, Queue, and Error Accumulation guides are linked from the sections they illustrate. These track Effect's `main` branch rather than a specific tagged release, so where they differ, this page and the tagged `effect@4.0.0` source win.

## Write the execution policy first

Before choosing a combinator, answer these questions in a comment, a design note, or the pull request description. Every later section of this guide is one of these answers turned into code.

| Question | What a complete answer looks like |
| --- | --- |
| Who owns each fiber, and for how long? | "The batch Effect owns the producer and the workers; all end when it returns or is interrupted." |
| How much runs at once? | Sequential, a number, or deliberately unbounded — and the number is tied to a scarce dependency ("8 workers; 3 HRIS permits because the vendor allows 3 concurrent calls per tenant") |
| What is the capacity of every buffer, and what happens when it is full? | "128 jobs; the producer suspends" — or a named loss policy with a metric |
| Which order is contractual? | Usually only one of input, start, completion, output, or committed order (see below) |
| Does one failure fail the batch? | Fail fast, or collect per-job outcomes |
| What do producers, consumers, siblings, and buffers observe on failure, interruption, early completion, and shutdown? | "A producer failure fails the queue; shutdown drains for 30 s, then interrupts" |
| Is the input finite? Is there one consumer or many? | Decides between `forEach`, `Stream`, `Queue`, and `PubSub` |

If a question has no answer yet, the code will answer it by accident — typically with an unbounded buffer, a detached fiber, or a worker that waits forever.

## Choose the smallest concurrency shape

Start with the shape of the work, not a favorite primitive.

| Problem | Default primitive |
| --- | --- |
| A finite collection is already in memory | `Effect.forEach(items, work, { concurrency })` |
| A source emits over time and one pipeline owns consumption | `Stream.mapEffect(work, { concurrency })` |
| Producers and consumers have independent lifetimes | bounded `Queue` |
| Every subscriber must see every message | `PubSub` |
| One shared external limit surrounds several code paths | `Semaphore` |
| One shared limit, but tenants/keys must take fair turns at it | `PartitionedSemaphore` |
| Each tenant/key needs its own independent limit | one `Semaphore` per key |
| Dynamic tasks must be tracked as a group | `FiberSet` or `FiberMap` |
| Several state changes must commit atomically or wait for change | STM (`TxRef`, `TxQueue`, and friends) |

Do not build a queue when `Effect.forEach` already owns the finite list. A queue earns its complexity when enqueueing and processing must be decoupled, when capacity must push back on producers, or when multiple producers share workers.

### Five kinds of order

"Ordered" is five different promises, and most designs need only one of them:

| Order | Meaning | Who provides it |
| --- | --- | --- |
| Input | The sequence in which work was submitted | The source; a `Queue` is FIFO |
| Start | The sequence in which jobs begin executing | A single worker, or `concurrency: 1` |
| Completion | The sequence in which jobs finish | Nothing, once concurrency exceeds one |
| Output | The sequence of results handed to the caller | `Effect.forEach` and `Stream.mapEffect` preserve input order in their results even while running concurrently; `Stream.mapEffect(…, { unordered: true })` trades that for throughput |
| Committed | The sequence in which an external system observes writes | Only a serialized writer, a per-key partition, or the external system's own ordering |

**Ordered output does not require serialized work, so serialize only the boundary whose order is contractual.** If raises for one employee must be applied in submission order, partition by `employeeId` and keep each partition sequential; do not reduce the whole pool to one worker. Test the promise by forcing the opposite: make the first job finish last and assert only the order you actually guarantee.

## Structured concurrency is ownership

`Effect.forkChild(effect)` creates a supervised child fiber. If its parent ends, the child is interrupted; keep and join the `Fiber` when its result matters. `forkScoped` ties a fiber to an explicit surrounding Scope. `forkDetach` moves a fiber to the global scope and is therefore an exceptional choice for work that intentionally outlives its requester.

**Name the owner before you pick the fork.** Work that must not outlive the current fiber uses `forkChild`. Work owned by the surrounding `Scope` — a Layer, a request, a test — uses `forkScoped`. Work owned by a `Scope` you were handed uses `Effect.forkIn(effect, scope)`. Work owned by the process uses `forkDetach`, and only with a documented stop path: if nobody can say who interrupts a detached fiber, it is a leak. A long-lived loop in library code should be *returned as an Effect* and forked by the caller that owns its lifetime, not started on a root fiber behind the caller's back. The full table is under [Fiber](../foundations/core-runtime-execution#fiber).

A fork returns a handle, not a result. `Fiber.join` re-enters the child's success or failure into the joiner, `Fiber.await` yields its `Exit` for supervision and tests, and `Fiber.interrupt` waits until the child's finalizers have run.

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

Official guide: [Fibers](https://effect.website/docs/v4/concurrency/fibers) — its "Lifetime of Child Fibers" examples show these ownership rules with timed logs.

## Capacity is part of the contract

A bounded Queue suspends an offer when capacity is full. That suspension is backpressure: the producer cannot outrun the memory budget chosen by the application.

- `Queue.bounded(capacity)` suspends producers when full.
- A dropping queue rejects new offers with `false` when full.
- A sliding queue accepts new offers and evicts the oldest buffered value.
- An unbounded queue never pushes back and can grow with the producer/consumer gap.

For work that must be processed, use bounded. Dropping and sliding are loss policies suitable for telemetry samples or latest-state updates, not hidden performance switches. Suspension also needs a producer that can wait: a synchronous callback calling `Queue.offerUnsafe` on a full bounded queue gets `false`, not backpressure. [Concurrency & Coordination](../concurrency/concurrency-coordination#make-loss-observable) has the full overflow table and shows how to count what a lossy queue sheds.

**Structured does not mean bounded.** A perfectly supervised `Effect.forEach(employees, recalc, { concurrency: "unbounded" })` still starts one fiber, one HRIS request, and one result buffer per employee. State the active-work bound as a number and derive it from the scarce dependency it protects — pool size, vendor quota, CPU cores — never from what made a benchmark faster. Then estimate what the design can hold in memory at its worst moment:

```text
peak retained memory ≈ Σ (capacity × largest item)
  over: queue storage
      + operator buffers (Stream.buffer, grouped batches)
      + per-subscriber PubSub lag
      + in-flight handlers (concurrency × working set)
      + sink and transport write buffers
```

One unbounded seam — an unbounded queue, a `Stream.callback` without `bufferSize`, `concurrency: "unbounded"` over external input — makes the whole sum unbounded. [Streaming Ingestion Without Accidental Buffering](streaming-ingestion-without-accidental-buffering) applies the same equation to a file-ingestion pipeline.

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

### Give each side only its half of the queue

As the pipeline grows beyond one function, **put the queue's roles in the signatures: producers accept `Queue.Enqueue`, consumers accept `Queue.Dequeue`, and only the wiring code holds the full `Queue`.** `Queue.offer` requires an `Enqueue` and `Queue.take` a `Dequeue`, so the compiler rejects a worker that re-enqueues follow-up jobs behind the scheduler's back or a producer that takes work away from the workers. A `Queue` is assignable to both roles, so the wiring passes the same value twice.

The reverse direction of failure needs a decision too. A consumer blocked in `take` learns nothing from a producer fiber that failed. `Queue.into(queue)` closes that gap: it ends the queue when the producer succeeds and fails the queue with the producer's cause otherwise, so the workers' stream ends with the same typed error.

> **Example status — Runnable:** the job source fails after two jobs; both are processed, then the failure reaches the consumer side.

```ts
import { Cause, Effect, Queue, Schema, Stream } from "effect"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()(
  "HrisUnavailable",
  { status: Schema.Int }
) {}

interface RecalculationJob {
  readonly employeeId: string
}

// Write-only role. Success ends the queue; HrisUnavailable fails it.
const produce = (
  outbox: Queue.Enqueue<RecalculationJob, HrisUnavailable | Cause.Done>
) =>
  Effect.gen(function*() {
    yield* Queue.offerAll(outbox, [{ employeeId: "e-1" }, { employeeId: "e-2" }])
    return yield* new HrisUnavailable({ status: 503 }) // the next page of jobs failed to load
  }).pipe(Queue.into(outbox))

// Read-only role. The stream carries the queue's terminal outcome.
const work = (
  inbox: Queue.Dequeue<RecalculationJob, HrisUnavailable | Cause.Done>,
  processed: Array<string>
) =>
  Stream.fromQueue(inbox).pipe(
    Stream.mapEffect(
      (job) => Effect.sync(() => { processed.push(job.employeeId) }),
      { concurrency: 2 }
    ),
    Stream.runDrain
  )

// Only the wiring sees both halves.
const program = Effect.gen(function*() {
  const queue = yield* Queue.bounded<RecalculationJob, HrisUnavailable | Cause.Done>(16)
  const processed: Array<string> = []

  yield* Effect.forkChild(produce(queue))
  const outcome = yield* Effect.result(work(queue, processed))

  return { processed, outcome: outcome._tag }
})

console.log(await Effect.runPromise(program))
// { processed: [ 'e-1', 'e-2' ], outcome: 'Failure' }
```

When a worker needs a hand-written loop instead of a Stream, take in a `while (true)` and end it with `Effect.catchIf(Cause.isDone, () => Effect.void)`; [Concurrency & Coordination](../concurrency/concurrency-coordination#put-queue-roles-in-function-signatures) shows the complete pattern.

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

Official guide: [Error Accumulation](https://effect.website/docs/v4/error-management/error-accumulation) — `Effect.validate` and `Effect.partition` are the collection-level counterparts of the per-element `Effect.result` policy shown here.

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

Use one semaphore value shared by all callers that participate in the limit. Constructing a semaphore inside every job gives each job its own permits and enforces nothing. Hold the permit around the scarce call only — `callHris`, not the parsing and mapping around it — so that work which does not consume the quota never waits for it.

Use `PartitionedSemaphore` when tenants or keys share one permit pool but must take fair turns at it: released permits go round-robin to the waiting partitions, so one busy department cannot starve the rest. It does not give each key its own ceiling; for independent per-tenant limits keep one `Semaphore` per key.

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

Treat termination as a protocol with named roles, decided when the queue is created:

- **One owner creates the queue and the worker fibers, and the same owner's scope ends them.** A queue created in one Layer and drained by fibers forked somewhere else has no one responsible for its last message.
- **One party signals the end** — normally the producer, through `Queue.end`, `Queue.fail`, or `Queue.into`. A producer that can fail without telling the queue leaves consumers blocked in `take` until something interrupts them.
- **Shutdown is observed as interruption, not as a value.** `Queue.shutdown` interrupts every fiber parked on `offer`, `take`, or `Queue.await`. Code chained after those calls with `Effect.andThen` never runs, and `Fiber.join` on such a fiber re-raises the interruption into the joiner. Attach reactions with `Effect.onExit`, and observe the fibers with `Fiber.await`.

> **Example status — Runnable:** the watcher's follow-up step is skipped, its `onExit` hook runs, and `Fiber.await` reports the interruption as data.

```ts
import { Effect, Exit, Fiber, Queue } from "effect"

const program = Effect.gen(function*() {
  const queue = yield* Queue.bounded<number>(8)
  const notes: Array<string> = []

  const watcher = yield* Queue.await(queue).pipe(
    Effect.andThen(Effect.sync(() => notes.push("drained normally"))), // skipped
    Effect.onExit(() => Effect.sync(() => notes.push("queue finished"))), // always runs
    Effect.forkChild({ startImmediately: true })
  )

  yield* Queue.shutdown(queue)
  const exit = yield* Fiber.await(watcher) // join would propagate the interruption

  return { notes, interrupted: Exit.hasInterrupts(exit) }
})

console.log(await Effect.runPromise(program))
// { notes: [ 'queue finished' ], interrupted: true }
```

Official guide: [Queue](https://effect.website/docs/v4/concurrency/queue) — its shutdown and `await` sections show the same interruption from the waiting fiber's side (the guide predates `Queue.end` / `Queue.fail` and the `Cause.Done` protocol in the table above).

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

When dynamic tasks are keyed — at most one recalculation per employee — use `FiberMap`. By default `FiberMap.run(map, key, effect)` interrupts the fiber already registered under that key and replaces it ("latest request wins"). Pass `{ onlyIfMissing: true }` to keep the running fiber and ignore the new request instead ("first request wins"). See [FiberMap](../foundations/core-runtime-execution#fibermap).

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

Also test fail-fast versus collect-outcomes policy, the exact maximum concurrent count, normal `end` draining every accepted job, and Scope closure running each job's cleanup. For retrying workers, use `TestClock` and assert the attempt timeline and stable idempotency key, as in [Recipe: Typed Retry with TestClock](../recipes/retry-with-test-clock).

Three techniques make these tests deterministic rather than lucky:

- **`startImmediately` instead of a `yieldNow` guess.** `Effect.forkChild(effect, { startImmediately: true })` runs the child synchronously up to its first suspension before the fork returns, so "is the producer already blocked on `offer`?" has a definite answer. With the default options the child has not run at all when `forkChild` returns.
- **A rendezvous for racy interleavings.** To prove a lost-update bug (or its fix), make every fiber announce its arrival, open a `Deferred` when the last one arrives, and have all of them wait on a gate the test opens. The contested step then happens on every run, not one run in a thousand. [Deferred](../foundations/core-runtime-execution#deferred) and [Latch](../foundations/core-runtime-execution#latch) are the building blocks.
- **Capacity `1` on purpose.** Large buffers hide deadlocks and ordering assumptions; a one-slot queue exposes them on the first run.

> **Example status — Runnable in Vitest:** interrupting a blocked consumer must not leave a stale waiter that swallows the next job.

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Option, Queue } from "effect"

it.effect("an interrupted taker does not steal a later job", () =>
  Effect.gen(function*() {
    const queue = yield* Queue.bounded<string>(1)

    // Parked in take before forkChild returns — no yieldNow needed.
    const abandoned = yield* Queue.take(queue).pipe(
      Effect.forkChild({ startImmediately: true })
    )
    assert.isUndefined(abandoned.pollUnsafe())

    yield* Fiber.interrupt(abandoned)
    yield* Queue.offer(queue, "cycle-2026:e-42")

    // The job is still there for a live consumer, exactly once.
    assert.strictEqual(yield* Queue.take(queue), "cycle-2026:e-42")
    assert.isTrue(Option.isNone(yield* Queue.poll(queue)))
  }))
```

For peak-in-flight assertions, decrement the counter in `Effect.ensuring`, as the capstone does; a counter decremented only on the success path reports a false maximum as soon as one job fails. Grow a concurrent component in stages — interruption plus finalizer, then bounded fan-out with counters, then the queue drain — so that a red test points at one idea.

## Operational checklist

- Write the execution policy — owners, bounds, overflow, order, failure, shutdown — before choosing combinators.
- Use `forEach` for an owned finite batch; introduce Queue only for independent lifetimes or admission control.
- Bound both buffered capacity and in-flight execution; they solve different problems.
- Derive every bound from the scarce dependency it protects, and use `"unbounded"` only where the collection itself is the bound.
- Choose dropping/sliding only when losing work is an explicit domain policy, and export a metric for what is shed.
- Promise only the order the contract needs; serialize that boundary, not the whole pool.
- Put `Queue.Enqueue` and `Queue.Dequeue` in signatures; keep the full `Queue` in the wiring.
- Make producer failure a terminal queue signal (`Queue.fail`, `Queue.into`) so consumers never wait forever.
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
