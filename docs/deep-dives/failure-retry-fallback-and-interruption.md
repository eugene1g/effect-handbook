# Failure, Retry, Fallback, and Interruption

Reliable Effect code does not ask only “did it throw?” It distinguishes an expected domain failure from a defect, an interruption, a timeout, an exhausted retry policy, and a failed alternative implementation. This guide follows one operation through those choices against `effect@4.0.0-rc.108`.

Use [Core Runtime & Execution](../foundations/core-runtime-execution) for `Effect`, `Exit`, `Cause`, and `ExecutionPlan`; [Errors, Option & Result](../foundations/errors-option-result) for the full recovery surface; [Scheduling & Time](../concurrency/scheduling-time) for Schedule semantics; [Observability](../operations/observability) for telemetry; and [Testing & Dev Tooling](../tooling/testing-dev-tooling) for virtual time.

## Begin with the four outcomes

An `Effect<A, E, R>` exposes two channels in its type and two additional runtime outcomes:

- **Success `A`** — the operation produced its value.
- **Expected failure `E`** — a domain or integration condition callers are expected to handle.
- **Defect** — an unexpected bug or violated invariant, preserved in `Cause` rather than `E`.
- **Interruption** — cooperative cancellation, also preserved in `Cause`.

`Effect.catch` and `catchTag(s)` handle the typed error channel. They do not silently consume defects or interruption. `catchCause` can see the full failure tree, but reaching for it too early often erases the distinction the runtime is maintaining for you.

### Model errors for decisions

Errors should carry the facts needed to decide recovery. Avoid a single `ApplicationError { message }` that forces retry, HTTP, and telemetry code to parse text.

> **Example status — Runnable:** this block defines and selectively handles domain errors.

```ts
import { Effect, Schema } from "effect"

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()(
  "EmployeeNotFound",
  { employeeId: Schema.String }
) {}

class InvalidRaise extends Schema.TaggedError<InvalidRaise>()("InvalidRaise", {
  requestedPercent: Schema.Finite,
  maximumPercent: Schema.Finite
}) {}

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()(
  "HrisUnavailable",
  {
    operation: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.Defect()
  }
) {}

const approveRaise = Effect.fn("approveRaise")(
  function*(employeeId: string, percent: number) {
    if (percent > 0.2) {
      return yield* new InvalidRaise({ requestedPercent: percent, maximumPercent: 0.2 })
    }
    if (employeeId === "missing") {
      return yield* new EmployeeNotFound({ employeeId })
    }
    return { employeeId, percent }
  }
)

const recovered = approveRaise("missing", 0.1).pipe(
  Effect.catchTag("EmployeeNotFound", (error) =>
    Effect.succeed({ employeeId: error.employeeId, percent: 0 })
  )
)

console.log(await Effect.runPromise(recovered))
```

The error union is a protocol. Keep variants stable at service and transport boundaries, and map low-level errors into domain/integration errors at the layer that owns the dependency. Do not leak every driver or SDK error through every use case.

## Recover at the narrowest owner

Recovery belongs where the fallback has business meaning:

- A repository maps “row absent” into `EmployeeNotFound` because it owns storage semantics.
- A use case may turn `EmployeeNotFound` into a domain alternative if absence is acceptable there.
- An HTTP handler maps unhandled domain errors to statuses because it owns transport semantics.
- The process edge reports any remaining `Cause` and chooses an exit code.

Use `tapError` or `tapCause` to observe without recovering. Use `Effect.result` when the outcome itself is data. Use `orDie` only when a typed failure is genuinely unrecoverable at and above that boundary; it converts the error into a defect and removes it from `E`.

> **Example status — Contextual:** the application handles only the failure it owns and leaves infrastructure failure typed.

```ts
import { Effect } from "effect"

declare const loadEmployee: (
  id: string
) => Effect.Effect<{ readonly id: string }, EmployeeNotFound | HrisUnavailable>

const optionalEmployee = (id: string) =>
  loadEmployee(id).pipe(
    Effect.catchTag("EmployeeNotFound", () => Effect.void),
    Effect.tapError((error) =>
      Effect.logWarning("employee lookup failed", { tag: error._tag, employeeId: id })
    )
  )
```

After `catchTag`, only `HrisUnavailable` remains in the error channel. That shrinking union is useful evidence: the type shows exactly which policy has and has not been applied.

## Retry only a repeatable operation

`Effect.retry(schedule)` re-runs the entire wrapped Effect. It does not roll back external state. Before adding retry, answer three questions:

1. Is this failure transient?
2. Is the operation safe to repeat, or protected by an idempotency key/transaction?
3. What bounds attempts and elapsed time?

A Schedule receives the error as input. Use `Schedule.while` to reject permanent failures, a backoff for spacing, and `upTo` or another schedule for a hard bound. `upTo({ times: n })` counts recurrences after the initial attempt, so the wrapped Effect may run `n + 1` times.

> **Example status — Contextual:** this is a production-shaped retry policy for the `HrisUnavailable` error above.

```ts
import { Duration, Effect, Schedule } from "effect"

const hrisRetry = Schedule.exponential("200 millis").pipe(
  (backoff) => Schedule.min([backoff, Schedule.spaced("5 seconds")]),
  Schedule.jittered,
  Schedule.setInputType<HrisUnavailable>(),
  Schedule.while(({ input }) => input.retryable),
  Schedule.upTo({ times: 5 }),
  Schedule.tap(({ attempt, duration, input }) =>
    Effect.logWarning("retrying HRIS operation", {
      operation: input.operation,
      attempt,
      delayMillis: Duration.toMillis(duration)
    })
  )
)

declare const idempotentLookup: Effect.Effect<string, HrisUnavailable>

const guardedLookup = idempotentLookup.pipe(Effect.retry(hrisRetry))
```

`Schedule.min([backoff, spaced(cap)])` selects the faster delay while either schedule continues, which caps an otherwise growing backoff. `Schedule.max` has the opposite continuation rule: it continues only while every schedule continues and selects the slowest delay. Review the [Schedule decision table](../concurrency/scheduling-time#quick-reference) rather than guessing from the names.

Do not put a logging side effect inside the retried operation merely to count retries: it also runs on the first attempt and may duplicate higher-level logging. `Schedule.tap` observes retry decisions directly.

### Idempotency is outside the retry combinator

A GET-like read is usually naturally repeatable. A payment, email, queue publish, or remote database write is not. If a write can fail after the external system commits but before the caller observes success, a retry can duplicate it.

> **Example status — Contextual:** the stable operation id lets the external service deduplicate repeated delivery.

```ts
import { Effect } from "effect"

interface PayrollGateway {
  readonly recordRaise: (input: {
    readonly operationId: string
    readonly employeeId: string
    readonly amount: number
  }) => Effect.Effect<void, HrisUnavailable>
}

declare const payroll: PayrollGateway

const recordRaise = (cycleId: string, employeeId: string, amount: number) =>
  payroll.recordRaise({
    operationId: `raise:${cycleId}:${employeeId}`,
    employeeId,
    amount
  }).pipe(Effect.retry(hrisRetry))
```

The downstream system must enforce idempotency for `operationId`; merely sending the field is not enough. A local SQL transaction can make local writes atomic, but it cannot atomically commit an unrelated remote API. Use an outbox, durable Workflow Activity, or an idempotent remote operation when the crash boundary crosses systems.

## Bound waiting and preserve cancellation

Timeout is a cancellation policy. `Effect.timeout(effect, duration)` interrupts the operation if the deadline wins and fails with `TimeoutError`. `timeoutOption` represents expiry as `Option.none`; `timeoutOrElse` supplies another Effect.

Choose the fallback carefully: a timeout does not prove the remote side did nothing. The same idempotency rule applies if the fallback or caller retries a write.

> **Example status — Runnable:** timeout interrupts the loser and the scoped finalizer still runs.

```ts
import { Effect, Ref } from "effect"

const program = Effect.gen(function*() {
  const closed = yield* Ref.make(false)

  const useConnection = Effect.gen(function*() {
    yield* Effect.acquireRelease(
      Effect.succeed({ name: "hris-connection" }),
      () => Ref.set(closed, true)
    )
    return yield* Effect.never
  }).pipe(Effect.scoped)

  yield* useConnection.pipe(
    Effect.timeout("1 millis"),
    Effect.catchTag("TimeoutError", () => Effect.void)
  )

  return yield* Ref.get(closed)
})

console.log(await Effect.runPromise(program)) // true
```

Interruption is cooperative at Effect boundaries. Finalizers are uninterruptible by default so cleanup can finish. Use `uninterruptible` sparingly around the smallest commit region; a large uninterruptible operation makes shutdown and timeouts unresponsive. `uninterruptibleMask` lets setup/commit stay protected while `restore(effect)` re-opens cancellation around slow work.

## Inspect the full Cause without flattening it

Concurrent Effects can fail in parallel, and finalizers can fail while another operation is already failing. `Cause` retains sequential/parallel structure, defects, and interruptions instead of forcing them into one exception.

Use `Effect.exit` when code needs to inspect how an Effect ended without failing. Use `Cause.pretty` for diagnostics and `findError`/`findErrorOption` plus the Cause guards for analysis. `Cause.squash` is a last-mile bridge to an exception-shaped API; it loses structure, so do not use it as the application's internal error model.

> **Example status — Runnable:** the value distinguishes typed failure from successful completion without catching defects broadly.

```ts
import { Cause, Effect, Exit, Option, Schema } from "effect"

class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()(
  "QuotaExceeded",
  { limit: Schema.Int }
) {}

const exit = await Effect.runPromise(
  Effect.exit(Effect.fail(new QuotaExceeded({ limit: 10 })))
)

if (Exit.isFailure(exit)) {
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isSome(failure)) console.log(failure.value._tag)
}
```

Do not `catchCause(() => Effect.void)` around a long-running service. That swallows defects and can turn interruption into an accidental restart loop. Recover specific typed failures inside the loop and let unexpected causes terminate the owner.

## Use fallback when the implementation changes

Retry repeats the same Effect under the same service graph. Fallback often means trying the same logical operation with a different region, model, replica, or credential set. `ExecutionPlan` expresses that distinction: each ordered step supplies a Context or Layer and may define attempts, a Schedule, and a predicate.

> **Example status — Runnable:** the primary endpoint is attempted twice, then the same operation succeeds under the backup service.

```ts
import { Context, Effect, ExecutionPlan, Layer, Schema } from "effect"

class EndpointFailure extends Schema.TaggedError<EndpointFailure>()(
  "EndpointFailure",
  { endpoint: Schema.String, retryable: Schema.Boolean }
) {}

class Endpoint extends Context.Service<Endpoint, {
  readonly name: string
}>()("handbook/Endpoint") {}

const Primary = Layer.succeed(Endpoint, { name: "primary" })
const Backup = Layer.succeed(Endpoint, { name: "backup" })

let primaryCalls = 0
const request = Effect.gen(function*() {
  const endpoint = yield* Endpoint
  if (endpoint.name === "primary") {
    primaryCalls++
    return yield* new EndpointFailure({ endpoint: endpoint.name, retryable: true })
  }
  return `response-from-${endpoint.name}`
})

const plan = ExecutionPlan.make(
  {
    provide: Primary,
    attempts: 2,
    while: (error: EndpointFailure) => error.retryable
  },
  { provide: Backup }
)

const events: Array<string> = []
const program = Effect.withExecutionPlan(request, plan, {
  onEvent: (event) =>
    Effect.sync(() => events.push(`${event._tag}:${event.stepIndex}`))
})

console.log(await Effect.runPromise(program)) // response-from-backup
console.log(primaryCalls) // 2
console.log(events)
```

`attempts` is per step. `onEvent` receives ordered start/success/failure events and cannot change the operation's result if the observer itself fails. A Stream execution plan may restart the stream after it already emitted elements; set `preventFallbackOnPartialStream: true` when mixing elements from two providers would violate the protocol.

Use ordinary `catchTag` when the fallback is a different value or business path. Use `ExecutionPlan` when the computation stays the same and the provided implementation changes.

## Observe once, where ownership is clear

Retries and fallbacks multiply attempts, so telemetry needs two levels:

- One span for the logical operation (`Effect.fn("Payroll.recordRaise")`).
- Attempt events from `Schedule.tap` or the `onEvent` option of `Effect.withExecutionPlan`, tagged with attempt/step metadata.
- One terminal log or metric at the boundary that owns the operation.

Avoid logging the same failure in repository, service, handler, and process code. Lower levels should enrich typed errors or spans; the owner decides whether an outcome is noteworthy. Never put secrets or rejected personal data into annotations merely because structured logging makes it convenient.

## Runnable capstone: classify, retry, and recover

The capstone makes the policy order explicit: validate first, run an idempotent remote operation, retry only transient failures, and recover only the expected domain case. A permanent remote failure stays typed for the caller.

> **Example status — Runnable:** the simulated gateway fails twice and succeeds on the third attempt without wall-clock delay.

```ts
import { Effect, Ref, Schedule, Schema } from "effect"

class InvalidAmount extends Schema.TaggedError<InvalidAmount>()(
  "InvalidAmount",
  { amount: Schema.Finite }
) {}

class RemoteFailure extends Schema.TaggedError<RemoteFailure>()(
  "RemoteFailure",
  { retryable: Schema.Boolean, attempt: Schema.Int }
) {}

const policy = Schedule.recurs(2).pipe(
  Schedule.setInputType<RemoteFailure>(),
  Schedule.while(({ input }) => input.retryable)
)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)

  const write = Effect.gen(function*() {
    const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
    if (attempt < 3) {
      return yield* new RemoteFailure({ retryable: true, attempt })
    }
    return { operationId: "raise:2026:e-42", attempt }
  })

  const submit = (amount: number) =>
    amount <= 0
      ? Effect.fail(new InvalidAmount({ amount }))
      : write.pipe(Effect.retry(policy))

  const result = yield* submit(5_000)
  return { result, attempts: yield* Ref.get(attempts) }
})

console.log(await Effect.runPromise(program))
// { result: { operationId: "raise:2026:e-42", attempt: 3 }, attempts: 3 }
```

Validation sits outside `write`, so invalid input does not consume retry attempts. The stable operation id is part of the simulated remote contract; a real receiver must enforce its uniqueness.

## Test time and interruption deterministically

Tests should assert the semantic promise: attempt count, delay progression, cancellation, cleanup, and final error—not merely that “eventually it worked.” `@effect/vitest` supplies `TestClock`; fork sleeping work before advancing virtual time.

> **Example status — Runnable in Vitest:** it validates two scheduled retries without waiting two seconds.

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Ref, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"

class TemporaryFailure extends Schema.TaggedError<TemporaryFailure>()(
  "TemporaryFailure",
  { attempt: Schema.Int }
) {}

it.effect("retries twice on the declared cadence", () =>
  Effect.gen(function*() {
    const attempts = yield* Ref.make(0)
    const action = Ref.updateAndGet(attempts, (n) => n + 1).pipe(
      Effect.flatMap((attempt) =>
        attempt < 3
          ? Effect.fail(new TemporaryFailure({ attempt }))
          : Effect.succeed("ok")
      ),
      Effect.retry(
        Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 2 }))
      )
    )

    const fiber = yield* Effect.forkChild(action)
    yield* Effect.yieldNow
    assert.strictEqual(yield* Ref.get(attempts), 1)

    yield* TestClock.adjust("1 second")
    assert.strictEqual(yield* Ref.get(attempts), 2)

    yield* TestClock.adjust("1 second")
    assert.strictEqual(yield* Fiber.join(fiber), "ok")
    assert.strictEqual(yield* Ref.get(attempts), 3)
  }))
```

Also test a permanent error stops immediately, an exhausted policy returns the last typed failure, interrupting a blocked attempt releases its resources, and an idempotency key stays identical across attempts.

## Operational checklist

- Keep expected failures in `E`; reserve defects for bugs and impossible invariants.
- Give error variants decision-relevant fields rather than parseable message strings.
- Handle an error at the narrowest layer that owns a meaningful recovery.
- Use `tapError`/`tapCause` for observation and `catchTag(s)` for recovery.
- Retry only classified transient failures, with both attempt and time/delay bounds.
- Prove the whole retried Effect is repeatable or supply enforced idempotency.
- Remember that timeout/interruption does not prove a remote write was rolled back.
- Keep uninterruptible regions small; place slow waits inside restored interruptibility.
- Let scoped acquisition own cleanup and test that interruption runs finalizers.
- Use `ExecutionPlan` when fallback changes provided implementations.
- Preserve `Cause` structure internally; squash only at exception-shaped edges.
- Emit one logical-operation span, explicit attempt telemetry, and one terminal outcome.
- Drive Schedule and timeout tests with `TestClock`, never real sleeps.

The reliable sequence is: **classify the failure, decide whether the operation is repeatable, bound retries, preserve cancellation and cleanup, then choose recovery or a different implementation explicitly.**
