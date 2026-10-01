# Recipe: A Resource-Safe Bounded Worker

Use a bounded Queue for producer backpressure, a fixed number of supervised consumers for concurrency, and `acquireUseRelease` around each resource-owning job.

## Contract

- **Classification:** Runnable example; complete `bounded-worker.ts`.
- **Install:** `pnpm add effect@4.0.0`
- **Run:** Node 26+: `node bounded-worker.ts`
- **Expected output:** `{"results":[2,4,6,8,10],"released":5,"maxActive":2}`.
- **Program type:** `Effect<Summary, never, never>`.
- **Required Layers:** none; Clock is a default runtime reference used by `Effect.sleep`.
- **Lifetime and interruption:** each job release action runs on success, failure, or interruption. Worker fibers are children of the producer program, and the Queue’s done signal terminates their streams. Interrupting the parent interrupts the workers and releases any active job resources.

## Complete file

**Runnable example.**

<!-- effect-example id=resource-safe-bounded-worker check=run runtime=resource-safe-bounded-worker -->
```ts
import { Cause, Effect, Fiber, Queue, Ref, Stream } from "effect"

interface Job {
  readonly id: number
  readonly value: number
}

interface Summary {
  readonly results: Array<number>
  readonly released: number
  readonly maxActive: number
}

const program: Effect.Effect<Summary> = Effect.gen(function*() {
  // At most two jobs may wait in memory. A faster producer suspends when full.
  const queue = yield* Queue.bounded<Job, Cause.Done>(2)
  const results = yield* Ref.make<Array<number>>([])

  let active = 0
  let released = 0
  let maxActive = 0

  const processJob = (job: Job) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        active += 1
        maxActive = Math.max(maxActive, active)
        return { jobId: job.id }
      }),
      () => Effect.sleep("10 millis").pipe(Effect.as(job.value * 2)),
      () => Effect.sync(() => {
        active -= 1
        released += 1
      })
    ).pipe(
      Effect.tap((result) => Ref.update(results, (values) => [...values, result])),
      Effect.asVoid
    )

  const worker = Stream.fromQueue(queue).pipe(
    Stream.runForEach(processJob)
  )

  // Two consumers compete for Queue elements: one job goes to one worker.
  const workers = yield* Effect.all([worker, worker], {
    concurrency: "unbounded",
    discard: true
  }).pipe(Effect.forkChild)

  yield* Queue.offerAll(queue, [
    { id: 1, value: 1 },
    { id: 2, value: 2 },
    { id: 3, value: 3 },
    { id: 4, value: 4 },
    { id: 5, value: 5 }
  ])
  yield* Queue.end(queue)
  yield* Fiber.join(workers)

  const completed = yield* Ref.get(results)
  return {
    results: [...completed].sort((a, b) => a - b),
    released,
    maxActive
  }
})

console.log(JSON.stringify(await Effect.runPromise(program)))
```

## Why these primitives?

The Queue owns buffering and backpressure; the two consumers define actual concurrency. `Effect.acquireUseRelease` owns the per-job resource even though processing can be interrupted. `Queue.end` is an explicit protocol event, so consumers do not remain blocked forever after the producer finishes.

Three details carry more weight than they appear to:

- **Overflow is the queue's contract.** `Queue.bounded(2)` suspends `offerAll` when two jobs are waiting, so the producer is paced by the workers and nothing is lost. `Queue.dropping` or `Queue.sliding` in the same position would turn this worker into a lossy one; choose them only as a stated policy and count what they shed, as described in [Make loss observable](../concurrency/concurrency-coordination#make-loss-observable).
- **`concurrency: "unbounded"` is safe here only because the collection is the bound.** `Effect.all([worker, worker], …)` starts exactly two fibers; the number of workers is the limit. The same option over one effect per job would start a fiber per job and defeat the queue.
- **Release runs on every exit of `use`.** `Effect.acquireUseRelease` runs the release action on success, typed failure, defect, and interruption — including a `use` function that throws synchronously before returning an Effect — and a failure inside the release action is combined with the original failure rather than replacing it. That is why `released` reaches `5` without any `try`/`finally`.

In a larger program, give the producer a `Queue.Enqueue<Job, Cause.Done>` and each worker a `Queue.Dequeue<Job, Cause.Done>` so that only the wiring code can both offer and take; see [Put queue roles in function signatures](../concurrency/concurrency-coordination#put-queue-roles-in-function-signatures). If the producer is an independent fiber that can fail, pipe it through `Queue.into(queue)` so its failure reaches the workers instead of leaving them blocked in `take`.

For a single finite input where buffering is unnecessary, `Effect.forEach(jobs, processJob, { concurrency: 2 })` is simpler. Use the Queue shape when producers and consumers have independent lifetimes, input arrives over time, or capacity itself is operationally important. [Structured Concurrency Through a Bounded Worker](../deep-dives/structured-concurrency-through-a-bounded-worker) builds the same design step by step, including failure policy and shutdown.

## Common wrong alternative

Avoid `Effect.all(jobs.map(processJob), { concurrency: "unbounded" })` over uncontrolled input, a growing module-level array as a mailbox, or manual `acquire`/`release` calls with release only on the success path. Also do not confuse a Queue with PubSub: Queue distributes work among consumers; PubSub copies each event to every subscriber.
