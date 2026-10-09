// Runtime evidence for behavioral claims the handbook makes in prose, where a
// compiling example proves nothing. Each check names the page section it backs.
import assert from "node:assert/strict"
import { Cache, Config, ConfigProvider, Context, Deferred, Effect, Exit, Fiber, Layer, PubSub, Queue, Ref, Schedule, Scope, Stream } from "effect"

const checks: Array<string> = []
const checked = (claim: string) => checks.push(claim)

// operations/caching-batching — "Interrupted computations are never cached".
{
  let runs = 0
  const started = await Effect.runPromise(Deferred.make<void>())
  const lookup = Effect.gen(function*() {
    runs++
    yield* Deferred.succeed(started, undefined)
    yield* Effect.sleep("50 millis")
    return runs
  })
  const result = await Effect.runPromise(Effect.gen(function*() {
    const cached = yield* Effect.cached(lookup)
    const first = yield* Effect.forkChild(cached)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(first)
    return yield* cached
  }))
  assert.equal(result, 2)
  checked("caching-batching: Effect.cached does not keep an interrupted computation; the next caller recomputes")
}

// operations/caching-batching — cachedInvalidateWithTTL accepts a TTL chosen from the Exit.
{
  let calls = 0
  const flaky = Effect.suspend(() => ++calls === 1 ? Effect.fail("HrisUnavailable" as const) : Effect.succeed(calls))
  const values = await Effect.runPromise(Effect.gen(function*() {
    const [cached] = yield* Effect.cachedInvalidateWithTTL(flaky, (exit) => Exit.isSuccess(exit) ? "1 hour" : 0)
    const first = yield* Effect.exit(cached)
    const second = yield* cached
    const third = yield* cached
    return [Exit.isFailure(first), second, third]
  }))
  assert.deepEqual(values, [true, 2, 2])
  checked("caching-batching: an Exit-based TTL of 0 for failures retries the next call while successes stay cached")
}

// operations/caching-batching — Cache.get shares one lookup among concurrent misses.
{
  let lookups = 0
  const result = await Effect.runPromise(Effect.gen(function*() {
    const cache = yield* Cache.make({
      capacity: 16,
      lookup: (level: string) => Effect.sleep("20 millis").pipe(Effect.as(`${level}:${++lookups}`))
    })
    return yield* Effect.all([Cache.get(cache, "L5"), Cache.get(cache, "L5"), Cache.get(cache, "L5")], { concurrency: "unbounded" })
  }))
  assert.deepEqual(result, ["L5:1", "L5:1", "L5:1"])
  assert.equal(lookups, 1)
  checked("caching-batching: concurrent Cache.get misses for one key share a single lookup")
}

// concurrency/concurrency-coordination — a bounded Queue suspends offer when full; dropping and sliding do not.
{
  const result = await Effect.runPromise(Effect.gen(function*() {
    const bounded = yield* Queue.bounded<number>(1)
    yield* Queue.offer(bounded, 1)
    const blocked = yield* Effect.forkChild(Queue.offer(bounded, 2))
    yield* Effect.sleep("10 millis")
    const stillWaiting = blocked.pollUnsafe() === undefined
    yield* Queue.take(bounded)
    yield* Fiber.join(blocked)
    const dropping = yield* Queue.dropping<number>(1)
    const droppingAccepted = [yield* Queue.offer(dropping, 1), yield* Queue.offer(dropping, 2)]
    const sliding = yield* Queue.sliding<number>(1)
    yield* Queue.offer(sliding, 1)
    yield* Queue.offer(sliding, 2)
    return { stillWaiting, droppingAccepted, slidingKept: yield* Queue.take(sliding) }
  }))
  assert.deepEqual(result, { stillWaiting: true, droppingAccepted: [true, false], slidingKept: 2 })
  checked("concurrency-coordination: bounded offer waits for space; dropping rejects the newest; sliding keeps the newest")
}

// concurrency/concurrency-coordination — PubSub rejects NaN and fractional capacities.
{
  for (const capacity of [Number.NaN, 1.5]) {
    const exit = await Effect.runPromiseExit(Effect.suspend(() => PubSub.bounded<number>(capacity)))
    assert(Exit.isFailure(exit), `PubSub.bounded(${capacity}) should not succeed`)
  }
  checked("concurrency-coordination: PubSub.bounded rejects NaN and fractional capacities")
}

// foundations/fibers-scopes-runtimes — a Scope runs finalizers in reverse acquisition order, on any exit.
{
  const order: Array<string> = []
  const acquire = (name: string) => Effect.acquireRelease(Effect.sync(() => order.push(`open ${name}`)), () => Effect.sync(() => order.push(`close ${name}`)))
  await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
    yield* acquire("pool")
    yield* acquire("client")
    return yield* Effect.fail("boom")
  })))
  assert.deepEqual(order, ["open pool", "open client", "close client", "close pool"])
  checked("fibers-scopes-runtimes: finalizers run in reverse acquisition order, also when the scope fails")
}

// foundations/services-context-layers — a Layer is built once per memo map; Layer.fresh builds again.
{
  class Pool extends Context.Service<Pool, { readonly id: number }>()("probe/Pool") {}
  class Reader extends Context.Service<Reader, { readonly poolId: number }>()("probe/Reader") {}
  class Writer extends Context.Service<Writer, { readonly poolId: number }>()("probe/Writer") {}
  let builds = 0
  const PoolLive = Layer.effect(Pool, Effect.sync(() => ({ id: ++builds })))
  const ReaderLive = Layer.effect(Reader, Effect.gen(function*() { return { poolId: (yield* Pool).id } }))
  const WriterLive = Layer.effect(Writer, Effect.gen(function*() { return { poolId: (yield* Pool).id } }))
  const shared = await Effect.runPromise(Effect.gen(function*() {
    return [(yield* Reader).poolId, (yield* Writer).poolId]
  }).pipe(Effect.provide(Layer.mergeAll(ReaderLive, WriterLive).pipe(Layer.provide(PoolLive)))))
  assert.deepEqual(shared, [1, 1])
  assert.equal(builds, 1)
  const fresh = await Effect.runPromise(Effect.gen(function*() {
    return [(yield* Reader).poolId, (yield* Writer).poolId]
  }).pipe(Effect.provide(Layer.mergeAll(ReaderLive.pipe(Layer.provide(Layer.fresh(PoolLive))), WriterLive.pipe(Layer.provide(Layer.fresh(PoolLive)))))))
  assert.notEqual(fresh[0], fresh[1])
  checked("services-context-layers: one Layer is built once per graph; Layer.fresh builds a separate instance")
}

// foundations/fibers-scopes-runtimes — a forkChild fiber is interrupted when its parent ends.
{
  const interrupted = await Effect.runPromise(Effect.gen(function*() {
    const flag = yield* Ref.make(false)
    const parent = yield* Effect.forkChild(Effect.gen(function*() {
      yield* Effect.forkChild(Effect.never.pipe(Effect.onInterrupt(() => Ref.set(flag, true))))
      yield* Effect.sleep("10 millis")
    }))
    yield* Fiber.await(parent)
    yield* Effect.sleep("10 millis")
    return yield* Ref.get(flag)
  }))
  assert.equal(interrupted, true)
  checked("fibers-scopes-runtimes: a child forked with forkChild is interrupted when its parent ends")
}

// foundations/core-runtime-execution — Effect.race interrupts the loser.
{
  const loserInterrupted = await Effect.runPromise(Effect.gen(function*() {
    const flag = yield* Ref.make(false)
    const winner = yield* Effect.race(
      Effect.sleep("5 millis").pipe(Effect.as("fast")),
      Effect.sleep("1 second").pipe(Effect.as("slow"), Effect.onInterrupt(() => Ref.set(flag, true)))
    )
    return [winner, yield* Ref.get(flag)]
  }))
  assert.deepEqual(loserInterrupted, ["fast", true])
  checked("core-runtime-execution: Effect.race returns the first success and interrupts the loser")
}

// concurrency/scheduling-time — Schedule.recurs(n) allows n retries after the first attempt.
{
  let attempts = 0
  await Effect.runPromiseExit(Effect.suspend(() => {
    attempts++
    return Effect.fail("transient")
  }).pipe(Effect.retry(Schedule.recurs(2))))
  assert.equal(attempts, 3)
  checked("scheduling-time: Effect.retry(Schedule.recurs(2)) makes three attempts in total")
}

// concurrency/streaming-channels — grouped flushes at n elements or at the end of the stream.
{
  const groups = await Effect.runPromise(Stream.runCollect(Stream.make(1, 2, 3, 4, 5).pipe(Stream.grouped(2))))
  assert.deepEqual(groups.map((group) => [...group]), [[1, 2], [3, 4], [5]])
  checked("streaming-channels: Stream.grouped(n) emits full groups and a final partial group at the end")
}

// foundations/configuration-secrets — Config.orElse falls back when the primary key is missing.
{
  const hrisUrl = Config.String("HRIS_URL").pipe(Config.orElse(() => Config.String("HRIS_FALLBACK_URL")))
  const value = await Effect.runPromise(Effect.gen(function*() { return yield* hrisUrl }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HRIS_FALLBACK_URL: "https://hris.example" })))
  ))
  assert.equal(value, "https://hris.example")
  checked("configuration-secrets: Config.orElse uses the fallback when the primary key is missing")
}

// foundations/fibers-scopes-runtimes — Scope.close runs finalizers added to that scope.
{
  const closed = await Effect.runPromise(Effect.gen(function*() {
    const scope = yield* Scope.make()
    const flag = yield* Ref.make(false)
    yield* Scope.addFinalizer(scope, Ref.set(flag, true))
    yield* Scope.close(scope, Exit.void)
    return yield* Ref.get(flag)
  }))
  assert.equal(closed, true)
  checked("fibers-scopes-runtimes: closing a Scope runs the finalizers registered in it")
}

console.log(JSON.stringify({ target: "effect@4.0.2", probes: checks.length, checks }))
