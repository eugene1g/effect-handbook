import assert from "node:assert/strict"
import { Deferred, Effect, Fiber, MutableRef, Ref, Semaphore } from "effect"
import { TestClock } from "effect/testing"

const checks: Array<string> = []

const mutableCounter = MutableRef.make(0)
await Effect.runPromise(Effect.forEach(Array.from({ length: 100 }), () =>
  Effect.sync(() => MutableRef.update(mutableCounter, (value) => value + 1)),
{ concurrency: "unbounded" }))
assert.equal(MutableRef.get(mutableCounter), 100)

// Splitting the transition across a suspension loses an update for either cell.
await Effect.runPromise(Effect.gen(function*() {
  const effectCounter = yield* Ref.make(0)
  MutableRef.set(mutableCounter, 0)
  const bothRead = yield* Deferred.make<void>()
  let reads = 0
  const splitUpdate = Effect.gen(function*() {
    const mutableSnapshot = MutableRef.get(mutableCounter)
    const effectSnapshot = yield* Ref.get(effectCounter)
    if (++reads === 2) yield* Deferred.succeed(bothRead, undefined)
    yield* Deferred.await(bothRead)
    MutableRef.set(mutableCounter, mutableSnapshot + 1)
    yield* Ref.set(effectCounter, effectSnapshot + 1)
  })
  yield* Effect.all([splitUpdate, splitUpdate], { concurrency: 2 })
  assert.equal(MutableRef.get(mutableCounter), 1)
  assert.equal(yield* Ref.get(effectCounter), 1)
}).pipe(Effect.timeout("5 seconds")))
checks.push("synchronous MutableRef updates do not interleave; split read-wait-write races with MutableRef and Ref")

const interruptionEvents: Array<string> = []
await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const child = yield* Effect.never.pipe(
    Effect.ensuring(Effect.sync(() => interruptionEvents.push("finalized"))),
    Effect.forkScoped
  )
  yield* Effect.yieldNow
  yield* Fiber.interrupt(child)
})))
assert.deepEqual(interruptionEvents, ["finalized"])
checks.push("fiber interruption runs scoped finalizers")

const clockResult = await Effect.runPromise(Effect.gen(function*() {
  const fiber = yield* Effect.sleep("10 seconds").pipe(Effect.as("ready"), Effect.forkChild)
  yield* TestClock.adjust("10 seconds")
  return yield* Fiber.join(fiber)
}).pipe(Effect.provide(TestClock.layer())))
assert.equal(clockResult, "ready")
checks.push("TestClock deterministically advances sleeping fibers")

const maximum = await Effect.runPromise(Effect.gen(function*() {
  const permits = yield* Semaphore.make(2)
  const active = yield* Ref.make(0)
  const peak = yield* Ref.make(0)
  const work = permits.withPermit(Effect.acquireUseRelease(
    Ref.updateAndGet(active, (value) => value + 1),
    (current) => Ref.update(peak, (value) => Math.max(value, current)).pipe(
      Effect.andThen(Effect.sleep("10 millis"))
    ),
    () => Ref.update(active, (value) => value - 1)
  ))
  yield* Effect.all(Array.from({ length: 8 }, () => work), { concurrency: "unbounded" })
  return yield* Ref.get(peak)
}))
assert.equal(maximum, 2)
checks.push("Semaphore bounds unbounded child concurrency")

console.log(JSON.stringify({ target: "effect@4.0.0", probes: checks.length, checks }))
