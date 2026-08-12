# Recipe: A Resource-Safe Bounded Worker

Use a bounded Queue for producer backpressure, a fixed number of supervised consumers for concurrency, and `acquireUseRelease` around each resource-owning job.

## Contract

- **Classification:** Runnable example; complete `bounded-worker.ts`.
- **Install:** `pnpm add effect@4.0.0-rc.108`
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

For a single finite input where buffering is unnecessary, `Effect.forEach(jobs, processJob, { concurrency: 2 })` is simpler. Use the Queue shape when producers and consumers have independent lifetimes, input arrives over time, or capacity itself is operationally important.

## Common wrong alternative

Avoid `Effect.all(jobs.map(processJob), { concurrency: "unbounded" })` over uncontrolled input, a growing module-level array as a mailbox, or manual `acquire`/`release` calls with release only on the success path. Also do not confuse a Queue with PubSub: Queue distributes work among consumers; PubSub copies each event to every subscriber.
