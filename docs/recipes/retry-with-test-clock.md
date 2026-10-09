# Recipe: Typed Retry with TestClock

Keep transient failures typed, classify them in the Schedule, fork the retrying operation, and advance virtual time instead of waiting in real time.

> **Official guides:** [Retrying](https://effect.website/docs/v4/error-management/retrying), [TestClock](https://effect.website/docs/v4/testing/testclock). Where that guide and the tagged `effect@4.0.2` source disagree, this page and the source win.

## Contract

- **Classification:** Runnable example; complete `retry-test-clock.ts`.
- **Install:** `pnpm add effect@4.0.2`
- **Run:** Node 26+: `node retry-test-clock.ts`
- **Expected output:** `{"value":"ready","attempts":3}` immediately; no three-second wall-clock wait.
- **Before provision:** the test program is `Effect<Result, TransientError, never>`. Clock is a defaulted context reference, so using time does not add a compile-time requirement.
- **After provision:** `Effect<Result, TransientError, never>`. Retry does not erase the final typed error because all attempts can still fail.
- **Required Layers:** none at the type level. Provide `TestClock.layer()` to replace the live Clock reference with controllable virtual time; calling TestClock-only controls without installing it is unsupported and can defect.
- **Lifetime and interruption:** the retrying Effect runs in a child fiber. Interrupting the parent interrupts the current attempt and cancels future retries. TestClock state lives for the provided Layer scope.
- **What the complete file proves:** the fork–adjust–join mechanics and that a retryable error eventually succeeds. **What it does not prove:** the delays between attempts or the non-retryable path. [Assert the shape of the policy](#assert-the-shape-of-the-policy) adds both.

## Complete file

**Runnable example.**

<!-- effect-example id=typed-retry-testclock check=run runtime=typed-retry-testclock -->
```ts
import { Effect, Fiber, Ref, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"

class TransientError extends Schema.TaggedError<TransientError>()(
  "TransientError",
  {
    attempt: Schema.Int,
    retryable: Schema.Boolean
  }
) {}

const retryPolicy = Schedule.exponential("1 second").pipe(
  Schedule.setInputType<TransientError>(),
  Schedule.while(({ input }) => input.retryable),
  Schedule.upTo({ times: 2 })
)

const testProgram = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)

  const operation: Effect.Effect<string, TransientError> = Effect.gen(function*() {
    const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
    if (attempt < 3) {
      return yield* new TransientError({ attempt, retryable: true })
    }
    return "ready"
  })

  // The sleeping retry fiber must run independently while the test drives time.
  const fiber = yield* operation.pipe(
    Effect.retry(retryPolicy),
    Effect.forkChild
  )

  yield* TestClock.adjust("1 second")
  yield* TestClock.adjust("2 seconds")

  return {
    value: yield* Fiber.join(fiber),
    attempts: yield* Ref.get(attempts)
  }
})

const runnable = testProgram.pipe(
  Effect.provide(TestClock.layer())
)

console.log(JSON.stringify(await Effect.runPromise(runnable)))
```

## Why these primitives?

`Effect.retry` reacts to typed `TransientError`; the Schedule owns classification, delay, and the hard recurrence bound. TestClock replaces time at the service boundary, so the same retry implementation is tested without sleeps or timing races. Forking is essential because `TestClock.adjust` must execute while the retrying fiber is suspended.

In `@effect/vitest`, `it.effect` already provides TestClock and TestConsole. The fork-adjust-join ordering is the same.

## Assert the shape of the policy

**A retry policy is a specification, and `{"value":"ready","attempts":3}` checks very little of it.** That expectation also passes for a policy with no backoff at all, for one that retries permanent errors, and for one with the wrong multiplier. Test the two paths the policy distinguishes, and record *when* each attempt ran:

- **Retryable path:** every attempt reports its number and `Clock.currentTimeMillis`; assert the exact virtual timeline — `0`, `1000`, `3000` for `Schedule.exponential("1 second")` bounded to two recurrences.
- **Non-retryable path:** the same harness with `retryable: false` must record exactly one attempt at time zero and leave the `TransientError` in `E`.
- **Handshake before every adjustment.** The operation offers each attempt to a `Queue`; the test takes that attempt *before* it moves the clock. The test then never depends on how many scheduler turns the retrying fiber needs to reach its next sleep.

```ts
import { assert, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Queue, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"

class TransientError extends Schema.TaggedError<TransientError>()(
  "TransientError",
  {
    attempt: Schema.Int,
    retryable: Schema.Boolean
  }
) {}

// The asserted policy has no jitter; compose Schedule.jittered only where production uses it.
const retryPolicy = Schedule.exponential("1 second").pipe(
  Schedule.setInputType<TransientError>(),
  Schedule.while(({ input }) => input.retryable),
  Schedule.upTo({ times: 2 })
)

interface Attempt {
  readonly attempt: number
  readonly at: number
}

// Every attempt reports its number and the virtual time at which it ran.
const makeOperation = (options: { readonly retryable: boolean; readonly succeedOn: number }) =>
  Effect.gen(function*() {
    const attempts = yield* Queue.unbounded<Attempt>()
    let count = 0
    const operation = Effect.gen(function*() {
      const attempt = ++count
      yield* Queue.offer(attempts, { attempt, at: yield* Clock.currentTimeMillis })
      if (attempt < options.succeedOn) {
        return yield* new TransientError({ attempt, retryable: options.retryable })
      }
      return "ready"
    })
    return { attempts, operation }
  })

it.effect("retryable failures follow the exponential timeline", () =>
  Effect.gen(function*() {
    const { attempts, operation } = yield* makeOperation({ retryable: true, succeedOn: 3 })
    const fiber = yield* operation.pipe(Effect.retry(retryPolicy), Effect.forkChild)

    // Wait for each attempt before moving time: a handshake, not a scheduler guess.
    const first = yield* Queue.take(attempts)
    yield* TestClock.adjust("1 second")
    const second = yield* Queue.take(attempts)
    yield* TestClock.adjust("2 seconds")
    const third = yield* Queue.take(attempts)

    assert.deepStrictEqual([first, second, third], [
      { attempt: 1, at: 0 },
      { attempt: 2, at: 1_000 },
      { attempt: 3, at: 3_000 }
    ])
    assert.strictEqual(yield* Fiber.join(fiber), "ready")
  }))

it.effect("a non-retryable failure is attempted once and stays typed", () =>
  Effect.gen(function*() {
    const { attempts, operation } = yield* makeOperation({ retryable: false, succeedOn: 3 })
    const fiber = yield* operation.pipe(Effect.retry(retryPolicy), Effect.flip, Effect.forkChild)

    // A policy that wrongly retried would use this time and record more attempts.
    yield* TestClock.adjust("10 seconds")
    const error = yield* Fiber.join(fiber)

    assert.strictEqual(error._tag, "TransientError")
    assert.strictEqual(error.retryable, false)
    assert.deepStrictEqual(yield* Queue.clear(attempts), [{ attempt: 1, at: 0 }])
  }))
```

Both tests fail fast against the policies they are meant to reject: replacing the backoff with `Schedule.forever` records attempts two and three at time `0`, and deleting the `Schedule.while` line lets the second test's operation succeed on its third attempt, so `Effect.flip` reports the unexpected success. Add a third case for exhaustion — an error that never clears must surface the last `TransientError` after exactly three attempts. The unbounded queue is safe here because the attempt bound is the policy itself. [Scheduling & Time](../concurrency/scheduling-time#testing-a-policy) lists the same checks as a policy checklist.

## Common wrong alternative

Do not call `Effect.orDie` before retry, retry every error indefinitely, use `setTimeout` in tests, or join the sleeping fiber before adjusting time. External writes also need idempotency even with a correct Schedule: retry provides at-least-once attempts, not exactly-once effects.

Two more mistakes are specific to virtual time:

- **Adjusting the clock before forking.** A sleep is registered relative to the clock's current reading, so `TestClock.adjust("10 seconds")` followed by the fork leaves the first retry delay entirely in the future and `Fiber.join` never returns. Fork first, then adjust.
- **Asserting a jittered policy.** `Schedule.jittered` scales every delay by a random factor between 0.8 and 1.2, so an exact timeline is no longer deterministic. Keep jitter out of the policy under test and add it in the production composition, or pin the generator with `Random.withSeed` and advance by the full jittered delay.
