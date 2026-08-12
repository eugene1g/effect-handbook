# Recipe: Typed Retry with TestClock

Keep transient failures typed, classify them in the Schedule, fork the retrying operation, and advance virtual time instead of waiting in real time.

## Contract

- **Classification:** Runnable example; complete `retry-test-clock.ts`.
- **Install:** `pnpm add effect@4.0.0-rc.108`
- **Run:** Node 26+: `node retry-test-clock.ts`
- **Expected output:** `{"value":"ready","attempts":3}` immediately; no three-second wall-clock wait.
- **Before provision:** the test program is `Effect<Result, TransientError, never>`. Clock is a defaulted context reference, so using time does not add a compile-time requirement.
- **After provision:** `Effect<Result, TransientError, never>`. Retry does not erase the final typed error because all attempts can still fail.
- **Required Layers:** none at the type level. Provide `TestClock.layer()` to replace the live Clock reference with controllable virtual time; calling TestClock-only controls without installing it is unsupported and can defect.
- **Lifetime and interruption:** the retrying Effect runs in a child fiber. Interrupting the parent interrupts the current attempt and cancels future retries. TestClock state lives for the provided Layer scope.

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

## Common wrong alternative

Do not call `Effect.orDie` before retry, retry every error indefinitely, use `setTimeout` in tests, or join the sleeping fiber before adjusting time. External writes also need idempotency even with a correct Schedule: retry provides at-least-once attempts, not exactly-once effects.
