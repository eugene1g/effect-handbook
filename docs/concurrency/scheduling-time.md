# Scheduling & Time

_Effect provides a composable time stack: typed duration values, a testable clock-aware date/time system, a cron parser, an effect-native PRNG, and `Schedule`, the algebraic policy engine powering retry and repeat._

> **Official companions:** Effect's release-matched `ai-docs` corpus has executable [Schedule](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.116/ai-docs/src/06_schedule) and [DateTime](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.116/ai-docs/src/07_datetime) examples.

> **Official guides:** [Built-In Schedules](https://effect.website/docs/v4/scheduling/built-in-schedules) prints the delay sequence of every constructor (its "once" heading is a stale name; the code uses `Schedule.duration`); section-specific guides are linked where they apply. These track Effect's `main` branch rather than the pinned `rc.116` release, so where they differ, this page and the tagged source win.

## Schedule

`effect/Schedule` — stable

**What it is.** A `Schedule<Output, Input, Error, Env>` is a composable recurrence policy. At each step it decides: keep going or stop? If continuing, how long to wait? The policy can inspect the input (error when retrying, success value when repeating) and emit any output. `Effect.retry` and `Effect.repeat` are built on this primitive.

**Mental model.** A Schedule is a composable state machine from *(now, input)* to *(output, delay)* — or done. Most built-in policies are pure, but the type's `Error` and `Env` parameters are real: effectful predicates/transforms may fail or require services. Like parser combinators for timing policies, you build primitives and pipe them together rather than hand-writing the state machine.

### Primitive constructors

```ts
import { Schedule, Duration } from "effect"

// Retry/repeat up to N additional times (after the initial attempt)
const fiveTimes = Schedule.recurs(5)

// Wait a fixed gap after each completion — delays are relative to when the
// previous run finished. Good for polling.
const everySecond = Schedule.spaced("1 second")

// Fixed cadence measured from this schedule's first step. If work overruns,
// the next recurrence is immediate; missed ticks are not replayed.
const every30s = Schedule.fixed("30 seconds")

// Divide elapsed time into 30-second windows and sleep to the nearest next
// boundary after each step.
const every30sWindow = Schedule.windowed("30 seconds")

// Exactly one recurrence after one minute; unlike `during`, this is a delay.
const oneFollowUp = Schedule.duration("1 minute")

// Pure exponential backoff. Second argument is the multiplier (default 2).
const expBackoff = Schedule.exponential("200 millis")

// Fibonacci growth — slower than exponential, gentler on stressed backends.
const fibBackoff = Schedule.fibonacci("100 millis")

// An elapsed-time budget. It adds no delay by itself, so combine it with a
// cadence or backoff rather than using it as a timer.
const thirtySecBudget = Schedule.during("30 seconds")

// Recurs without end and without delay, outputting 0, 1, 2, ... It is the
// base that the `{ times, while, until }` options object builds on.
const noDelayForever = Schedule.forever

// Recurs without end and outputs its input unchanged — the starting point for
// a policy whose delay is derived from the input via `modifyDelay`.
const echoStatus = Schedule.identity<"Pending" | "Approved" | "Rejected">()
```

> **Warning:** A schedule with no stopping condition retries or repeats forever, and `Schedule.forever` does so in a hot loop. Every policy that reaches production needs a bound (`recurs`, `upTo`, `during`) and, for remote calls, a delay.

### Composing schedules

`Schedule.max([...])` continues only while *all* schedules recur and waits for the slowest delay. `Schedule.min([...])` continues while *any* schedule recurs and waits for the fastest delay. `Schedule.concat` sequences one policy after another, and `Schedule.upTo` bounds an existing policy by elapsed duration, recurrence count, or both.

```ts
import { Schedule, Schema } from "effect"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()(
  "HrisUnavailable",
  { retryable: Schema.Boolean }
) {}

// === HRIS retry policy ===
// Exponential backoff starting at 250 ms, each delay capped at 10 s via
// min picks the shorter delay, jitter spreads callers after an outage,
// and upTo hard-stops after 6 schedule recurrences.
const hrisRetryPolicy = Schedule.min([
  Schedule.exponential("250 millis"),
  Schedule.spaced("10 seconds")
]).pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 6 })
)

// === Merit-cycle sync policy ===
// Retry aggressively at first (3 quick attempts), then back off to a slow
// steady heartbeat — useful for a quarterly merit-cycle data sync.
const warmThenSteady = Schedule.exponential("100 millis").pipe(
  Schedule.upTo({ times: 3 }),
  Schedule.concat(Schedule.spaced("5 seconds"))
)
```

`max` and `min` output the selected `Duration`, so add `Schedule.passthrough` later if the retry input must become the output.

`concatResult(first, second)` preserves which phase emitted an output: first-phase values are `Result.Failure`, second-phase values are `Result.Success`. Use it instead of `concat` when downstream logic must distinguish warm-up from steady state.

`upTo({ times: n })` counts **schedule recurrences**, not the initial evaluation: a retry/repeat effect can therefore run up to `n + 1` times. Schedules may also fail—for example an effectful predicate or an invalid `Schedule.cron`—and `Effect.schedule` / `scheduleFrom` expose that schedule error alongside the wrapped effect's own error.

Official guide: [Schedule Combinators](https://effect.website/docs/v4/scheduling/schedule-combinators) (its `jittered(0.0, 1.0)` sentence and `whileOutput` comment are stale: in `rc.116` `Schedule.jittered` takes no range and always scales by 0.8–1.2, and the only filter is `Schedule.while`).

### Filtering on the input

Schedules receive the error (for retry) or success value (for repeat) as input. Use `Schedule.while` to short-circuit on non-retryable failures, avoiding burning retry budget on permanent errors.

```ts
import { Duration, Effect, Schedule, Schema } from "effect"

class HrisError extends Schema.TaggedError<HrisError>()("HrisError", {
  message: Schema.String,
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  retryable: Schema.Boolean
}) {}

// Only retry when the HRIS says the failure is transient (e.g. 503, not 404).
const hrisRetry = Schedule.exponential("250 millis").pipe(
  (backoff) => Schedule.min([backoff, Schedule.spaced("10 seconds")]),
  Schedule.jittered,
  Schedule.setInputType<HrisError>(),
  Schedule.while(({ input }) => input.retryable)
)

// `tap` observes the complete metadata object without changing behavior.
const instrumented = hrisRetry.pipe(
  Schedule.tap(({ duration, input }) =>
    Effect.logDebug(
      `Retrying HRIS after ${input.status}: ${input.message}; next attempt in ${Duration.format(duration)}`
    )
  )
)

declare const fetchEmployee: (id: string) => Effect.Effect<{ name: string }, HrisError>

const loadEmployee = fetchEmployee("emp-42").pipe(
  Effect.retry(instrumented),
  Effect.orDie
)
```

The complete schedule metadata is `{ input, output, duration, attempt, start, now, elapsed, elapsedSincePrevious }`. `tap`, `addDelay`, and `modifyDelay` callbacks all receive that same object, so instrumentation and adaptive delays can use attempt and elapsed-time context without reconstructing it.

`addDelay` adds an effectfully computed duration to the policy's selected delay; `modifyDelay` replaces that delay. A provider's `Retry-After` value is therefore usually a `modifyDelay` lower bound:

```ts
import { Duration, Effect, Schedule } from "effect"

interface ProviderError {
  readonly status: 429 | 500 | 503
  readonly retryAfter: Duration.Duration | undefined
}

const providerRetry = Schedule.exponential("1 second").pipe(
  Schedule.setInputType<ProviderError>(),
  Schedule.modifyDelay(({ input, duration }) =>
    Effect.succeed(
      Duration.min(
        input.retryAfter === undefined
          ? duration
          : Duration.max(duration, input.retryAfter),
        Duration.minutes(1)
      )
    )
  ),
  Schedule.upTo({ times: 6 }),
  Schedule.while(({ input }) => input.status === 429 || input.status >= 500)
)
```

`Schedule.while` also accepts a type guard over the metadata object — `(meta): meta is Schedule.Metadata<Output, NarrowedInput> => …` — and then narrows the resulting schedule's input and output types. When the predicate belongs to one call site rather than to a shared policy, the [options object](#shorthand-options-for-retry-and-repeat) is shorter than `setInputType` plus `while`.

Official guide: [Retrying](https://effect.website/docs/v4/error-management/retrying).

### Polling with repeat and passthrough

`Effect.repeat` repeats on success and stops on failure. Combined with `Schedule.passthrough`, poll for a terminal state and get the final value back.

```ts
import { Effect, Schedule } from "effect"

type ApprovalStatus = "Pending" | "Approved" | "Rejected"

declare const getMeritApprovalStatus: (
  cycleId: string
) => Effect.Effect<ApprovalStatus>

const pollUntilSettled = Schedule.spaced("10 seconds").pipe(
  Schedule.setInputType<ApprovalStatus>(),
  Schedule.passthrough,           // output = the latest ApprovalStatus
  Schedule.while(({ input }) => input === "Pending")
)

// The final output of Effect.repeat is the last ApprovalStatus that caused
// the schedule to stop — "Approved" or "Rejected".
const waitForMeritApproval = (cycleId: string) =>
  getMeritApprovalStatus(cycleId).pipe(Effect.repeat(pollUntilSettled))
```

**`Effect.repeat` fails as soon as one run fails, and the caller loses the schedule context.** `Effect.repeatOrElse(effect, schedule, orElse)` hands the failure (the effect's or the schedule's) to a handler that must produce the schedule's output type, together with `Option<Schedule.Metadata>` for the previous step — `None` when the very first run failed. `Effect.retryOrElse(effect, policy, orElse)` is the failure-side twin: when the policy is exhausted, `orElse(lastError, scheduleOutput)` supplies a fallback instead of the last error.

```ts
import { Effect, Option, Schedule } from "effect"

declare const sendPayrollHeartbeat: Effect.Effect<void, "Disconnected">

// Ends with the number of completed beats instead of an error.
const heartbeat = Effect.repeatOrElse(
  sendPayrollHeartbeat,
  Schedule.spaced("30 seconds"),
  (error, previous) =>
    Effect.logWarning(`payroll heartbeat stopped: ${error}`).pipe(
      Effect.as(Option.match(previous, {
        onNone: () => 0,
        onSome: (meta) => meta.attempt
      }))
    )
)
```

Official guide: [Repetition](https://effect.website/docs/v4/scheduling/repetition) (its "repeatN" heading is a stale name; the code uses `Effect.repeat(effect, { times })`).

### Shorthand options for retry and repeat

`Effect.retry` and `Effect.repeat` also accept a plain options object instead of a `Schedule`:

| Key | Meaning on `retry` | Meaning on `repeat` |
| --- | --- | --- |
| `schedule` | Pacing and bounds between attempts | Pacing and bounds between runs |
| `while` | Keep retrying while the **error** matches | Keep repeating while the **success value** matches |
| `until` | Stop retrying once the error matches | Stop repeating once the value matches |
| `times` | At most `n` retries after the first attempt | At most `n` repetitions after the first run |

The object is sugar for `Schedule.passthrough(schedule ?? Schedule.forever)` filtered with `Schedule.while`, which explains the two surprises:

- **The result is the last value, not a schedule counter.** `Effect.repeat(poll, { until })` returns the value that satisfied `until`.
- **Omitting `schedule` means zero delay.** `{ while: isTransient }` alone is an unbounded hot loop against a struggling dependency. Always pair a predicate with `schedule`, `times`, or both.

Predicates may return `boolean` or an `Effect` of `boolean`. A type guard narrows the result: `until` narrows the success type on `repeat`, and on `retry` a guard in `{ while }` alone removes that error from `E` — it is retried without limit, so it can never be the final failure.

```ts
import { Effect, Schedule, Schema } from "effect"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()(
  "HrisUnavailable",
  { status: Schema.Int }
) {}

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()(
  "EmployeeNotFound",
  { employeeId: Schema.String }
) {}

declare const fetchEmployee: (
  id: string
) => Effect.Effect<{ readonly name: string }, HrisUnavailable | EmployeeNotFound>

declare const getApprovalStatus: Effect.Effect<"Pending" | "Approved" | "Rejected">

// Timing is a reusable, named value with no opinion about error types.
const hrisBackoff = Schedule.exponential("250 millis").pipe(Schedule.jittered)

// Classification sits at the call site that knows what this operation can fail with.
const loadEmployee = (id: string) =>
  fetchEmployee(id).pipe(
    Effect.retry({
      schedule: hrisBackoff,
      times: 4,
      while: (error) => error._tag === "HrisUnavailable"
    })
  )

// repeat is success-driven; the guard narrows the result to the settled states.
const settled: Effect.Effect<"Approved" | "Rejected"> = Effect.repeat(getApprovalStatus, {
  schedule: Schedule.spaced("10 seconds"),
  until: (status): status is "Approved" | "Rejected" => status !== "Pending"
})
```

| Put the predicate… | When |
| --- | --- |
| On the call site (`{ schedule, while }`) | The classification is specific to one operation; the timing policy is shared and stays input-agnostic |
| In the schedule (`Schedule.while`) | The whole policy — timing *and* classification — is shared and its error type is fixed, or the predicate needs `attempt`, `elapsed`, or the computed `duration` |

A third form avoids `Schedule.setInputType`: pass a builder, `Effect.retry(($) => $(hrisBackoff).pipe(Schedule.while(({ input }) => input._tag === "HrisUnavailable")))`. The `$` function pins the schedule's input to the effect's error type (or success type, for `repeat`).

### Retry policy checklist

A retry policy is a specification, so write it down before composing combinators, then [test its shape](#testing-a-policy).

- **Classify first.** Which typed errors are transient? Defects and interruption are never retried; everything not named retryable must fail on the first attempt.
- **Bound it.** Maximum recurrences *and* a total time budget (`upTo({ times, duration })`), inside the caller's timeout rather than multiplying it.
- **Pace it.** Backoff with a per-delay cap, plus `Schedule.jittered` in production so recovering callers do not synchronize.
- **Retry the transient operation, not the whole use case.** Wrap the HRIS call, not the workflow that also wrote an audit row.
- **Build the side effect inside the retried Effect.** `Effect.retry` re-runs an Effect description. `const pending = client.fetch(id)` followed by retrying `Effect.promise(() => pending)` replays one settled Promise; call the client inside `Effect.tryPromise` so every attempt starts fresh work.
- **Confirm idempotency** for anything that writes; retry gives at-least-once attempts.
- **Decide what is observed:** a `Schedule.tap` log or metric per retry, and the final failure left in `E`.

Interruption stops both the running attempt and the pending delay, so a retried effect needs no extra cancellation plumbing.

### Scheduled repeat via Schedule.cron

`Schedule.cron` parses a standard 5-field (or 6-field with seconds) cron expression and builds a schedule sleeping until the next matching wall-clock time. Accepts an optional IANA timezone string.

```ts
import { Effect, Schedule } from "effect"

declare const kickOffMeritCycle: Effect.Effect<void>

// "0 8 1 1,4,7,10 *" = 08:00 on the first day of Jan, Apr, Jul, Oct
// — a quarterly merit-cycle kickoff in New York time.
const quarterlyCycle = Schedule.cron(
  "0 8 1 1,4,7,10 *",
  "America/New_York"
)

// Effect.repeat runs the effect once immediately then at each cron tick.
const meritCycleJob = kickOffMeritCycle.pipe(Effect.repeat(quarterlyCycle))

// Effect.schedule consults the schedule first: nothing runs until the next tick.
const meritCycleJobOnTick = kickOffMeritCycle.pipe(Effect.schedule(quarterlyCycle))
```

**`Effect.repeat` always evaluates the effect once before it asks the schedule anything; `Effect.schedule` steps the schedule first.** A deploy or crash-restart therefore re-runs a `repeat`-driven job immediately, which is rarely what a quarterly kickoff or nightly payroll run wants. The same difference shows up in counts: `Effect.repeat(task, Schedule.recurs(2))` runs three times, `Effect.schedule(task, Schedule.recurs(2))` runs twice. `Effect.schedule` feeds the schedule `undefined` on that first step, so it accepts only schedules whose input type is `unknown`; `Effect.scheduleFrom(effect, initial, schedule)` seeds a typed initial input instead.

### Running a side task for as long as the main task runs

To log progress or send a heartbeat while real work runs, race an endlessly repeating effect against the main effect: the repeater never completes, so when the main effect finishes first the repeater is interrupted with no fork bookkeeping.

```ts
import { Effect, Schedule } from "effect"

declare const runMeritCycle: Effect.Effect<number, "BudgetExceeded">

const progress = Effect.log("merit cycle still running").pipe(
  Effect.repeat(Schedule.fixed("5 seconds"))
)

// raceFirst settles with whichever side completes first, success or failure.
const program = Effect.raceFirst(runMeritCycle, progress)
```

> **Warning:** Use `Effect.raceFirst` here, not `Effect.race`. `race` waits for the first *success*: if `runMeritCycle` fails while the repeater is still healthy, `race` keeps waiting on a side task that never finishes and the failure is never reported. Because `raceFirst` also settles on the side task's failure, make a fallible side task infallible first (`Effect.ignore`), or a lost heartbeat cancels the merit cycle.

### Inspecting a schedule

A schedule is a step function from *(now, input)* to *(output, delay)*, and `Schedule.toStep` hands you that function. Feeding it timestamps and inputs by hand prints the exact delay sequence of a composed policy without running an effect or sleeping — the cheapest way to answer "does my capped backoff really plateau at two seconds and stop after five recurrences?". The step is a `Pull`: success is `[output, delay]`, and exhaustion arrives on the done channel, so close the loop with `Pull.catchDone` rather than an error handler.

```ts
import { Duration, Effect, Pull, Schedule } from "effect"

const policy = Schedule.min([
  Schedule.exponential("250 millis"),
  Schedule.spaced("2 seconds")
]).pipe(Schedule.upTo({ times: 5 }))

const delays = Effect.gen(function*() {
  const step = yield* Schedule.toStep(policy)
  const millis: Array<number> = []

  const loop: Effect.Effect<void> = step(0, undefined).pipe( // caller supplies `now` and the input
    Effect.flatMap(([, delay]) => {
      millis.push(Duration.toMillis(delay))
      return loop
    }),
    Pull.catchDone(() => Effect.void)
  )

  yield* loop
  return millis // [250, 500, 1000, 2000, 2000]
})
```

Keep `Schedule.jittered` out of such a trace, or pin it with `Random.withSeed`; jitter draws from the `Random` service.

### Testing a policy

**Asserting only the final value and an attempt count proves little**: that test also passes for a policy with no backoff at all, for one that retries permanent errors, and for one with the wrong multiplier or cap. Assert the policy's shape on both paths instead:

- **Retryable path:** record `attempt@virtualMillis` from `Clock.currentTimeMillis` inside the operation and assert the exact timeline — for `Schedule.exponential("100 millis")` bounded to two recurrences, `["attempt-1@0", "attempt-2@100", "attempt-3@300"]`.
- **Non-retryable path:** run the same harness with a permanent error and assert exactly one attempt, at time zero, with the error still in `E`.
- **Exhaustion:** with an error that never clears, assert the attempt count equals the bound plus one and that the last typed error is what the caller sees.
- **Keep jitter out of the asserted policy.** Compose `Schedule.jittered` only in the production policy, or pin it with `Random.withSeed`.

The complete harness is in [Recipe: Typed Retry with TestClock](../recipes/retry-with-test-clock); [TestClock](../tooling/testing-dev-tooling#testclock) covers the fork–adjust–join mechanics.

### Quick reference

| Combinator | Semantics |
| --- | --- |
| `recurs(n)` | Stop after n additional recurrences |
| `spaced(d)` | Fixed gap after each completion |
| `fixed(d)` | Cadence aligned to this schedule's first step; skip missed ticks |
| `windowed(d)` | Sleep to the next elapsed-time window boundary |
| `duration(d)` | Recur exactly once after `d` |
| `exponential(base)` | Exponential delay, 2× factor by default |
| `fibonacci(one)` | Fibonacci delay growth |
| `during(d)` | Stop after this much elapsed time; adds no delay |
| `forever` | Recur without end and without delay; outputs the recurrence count |
| `identity<A>()` | Recur without end; output equals input |
| `max([s1, s2])` | Continue while all recur; use the slowest delay |
| `min([s1, s2])` | Continue while any recur; use the fastest delay |
| `concat(s)` | Run self then other sequentially |
| `jittered` | Multiply delay by 0.8–1.2 randomly |
| `while(pred)` | Stop when predicate returns false |
| `passthrough` | Output the input instead of policy output |
| `upTo({ duration, times })` | Bound elapsed time and/or recurrences |
| `addDelay(f)` | Add an effectful metadata-derived delay |
| `modifyDelay(f)` | Replace the selected delay effectfully |
| `tap(({ input, output, duration, ... }))` | Observe full step metadata |
| `cron(expr, tz?)` | Sleep to next cron wall-clock match |
| `toStep(schedule)` | Extract the step function to inspect or unit-test the delay sequence |

| Runner | First execution | Input fed to the schedule | Result |
| --- | --- | --- | --- |
| `Effect.retry(effect, policy)` | Immediately | Each typed error | The first success; the last error if the policy stops |
| `Effect.repeat(effect, schedule)` | Immediately | Each success value | The schedule's final output (the last value, for the options form) |
| `Effect.schedule(effect, schedule)` | After the schedule's first delay | `undefined`, then each success value | The schedule's final output |
| `Effect.retryOrElse` / `Effect.repeatOrElse` | As `retry` / `repeat` | As above | `retryOrElse`: the fallback once the policy is exhausted; `repeatOrElse`: the fallback once a run fails |

**Reach for it when** you need to retry failed API calls with backoff, poll a workflow for a terminal state, run background jobs on a cron cadence, or express any policy combining timing, attempt count, and error classification.

## Duration

`effect/Duration` — stable

**What it is.** `Duration` is Effect's typed time-span value. Every scheduling API, timeout, and sleep accepts a `Duration.Input` — a raw number (millis), a string like `"5 seconds"`, or a `Duration` object. For arithmetic or comparison, construct a real `Duration` first.

**Mental model.** A tagged value preserving finite integral milliseconds as `number`, sub-millisecond/exact values as nanosecond `bigint`, and explicit positive/negative infinity. It implements `Equal`, `Pipeable`, and `Inspectable`; module-level `Order` and `Equivalence` support sorting, clamping, and min/max. Hashes are canonical across equal millis/nanos representations, so semantically equal durations are safe as `HashMap`/`HashSet` keys.

```ts
import { Duration } from "effect"

// Construction — pick the unit that matches your domain
const heartbeat = Duration.millis(50)
const ttl       = Duration.seconds(30)
const lease     = Duration.minutes(15)
const day       = Duration.days(1)

// A fixed 365-day interval. Calendar-based 12-month cliffs belong in DateTime.
const fixedYear = Duration.days(365)

// String shorthand works wherever Duration.Input is accepted:
// "200 millis", "5 seconds", "2 minutes", "1 hour", "3 days", "1 week"

// Arithmetic
const totalReview = Duration.sum(Duration.weeks(1), Duration.days(2))   // 9 days
const doubled     = Duration.times(Duration.hours(2), 2)                // 4 h
const overtime    = Duration.subtract(Duration.hours(9), Duration.hours(8)) // 1 h

// Comparisons — e.g. is a fixed interval already past?
Duration.isLessThan(Duration.days(200), fixedYear)      // true (200d < 365d)
Duration.isGreaterThan(Duration.weeks(52), fixedYear)   // false
Duration.between(Duration.days(300), {
  minimum: Duration.days(180),
  maximum: Duration.days(365)
})  // true — 300d is within the range

// Conversion
Duration.toMillis(Duration.days(1))       // 86_400_000
Duration.toSeconds(Duration.minutes(15)) // 900

// Human-readable formatting — useful in review-deadline notifications
Duration.format(Duration.sum(Duration.days(30), Duration.hours(4)))  // "30d 4h"
```

> **Tip:** `Duration.Input` accepts strings like `"500 millis"`, `"5 seconds"`, `"2 minutes"`, `"1 hour"`, `"3 days"`, and `"1 week"`. You never need to multiply by 1000 to pass a duration to `Effect.sleep`, `Schedule.spaced`, or `Effect.timeout` — just write the human name.

### Parsing untrusted durations and interop edges

**Parse a duration once, at startup, into a `Duration`, and pass that value everywhere after.** A bare `5` in a config file or function signature does not say seconds, milliseconds, or attempts; a `Duration` cannot be misread.

| Source of the value | Use | On bad input |
| --- | --- | --- |
| Environment / config provider | `Config.Duration("HRIS_TIMEOUT")` | Typed `ConfigError` at startup |
| JSON, HTTP payloads, database text | `Schema.DurationFromString` inside the boundary schema | `SchemaError` from decoding |
| A value already typed as `Duration.Input` | `Duration.fromInput(input)` | `Option.none()` |
| A literal you control | `Duration.fromInputUnsafe("5 seconds")`, or a constructor | Throws — never feed it external text |

All four accept the same forms: a `number` is **milliseconds**, a `bigint` is **nanoseconds**, a string is `"<n> <unit>"` (`nanos` through `weeks`, singular or plural) or `"Infinity"` / `"-Infinity"`, a `[seconds, nanos]` tuple is high-resolution time, and an object such as `{ minutes: 1, seconds: 30 }` adds its fields.

```ts
import { Config, Duration, Effect, Option, Schema } from "effect"

// Deployment input: a malformed value is a named startup failure.
const hrisTimeout = Config.Duration("HRIS_TIMEOUT").pipe(
  Config.withDefault(Duration.seconds(5))
)

// Boundary schema: "90 seconds" on the wire, Duration in the domain.
const SyncSettings = Schema.Struct({
  pollEvery: Schema.DurationFromString
})

// "No TTL" is a value, not a magic number.
const cacheTtl = Option.getOrElse(
  Duration.fromInput("15 minutes"),
  () => Duration.infinity
)

const program = Effect.gen(function*() {
  const timeout = yield* hrisTimeout
  // Combine spans with Duration arithmetic, not + and *.
  const budget = Duration.sum(Duration.times(timeout, 3), Duration.seconds(1))

  // Convert to a number only where a foreign API demands one.
  const timer = setTimeout(() => {}, Duration.toMillis(budget))
  clearTimeout(timer)

  return { budget, cacheTtl, SyncSettings }
})
```

- **`Duration.infinity` has no nanosecond value**: `Duration.toNanos` returns `Option.none()` for it, while `Duration.toNanosUnsafe` throws. Use the `Option` form whenever a configurable TTL or timeout may be infinite.
- **Pick the codec by the precision and range you promise.** `Schema.DurationFromMillis` encodes through a JavaScript `number`, so nanosecond-precision durations beyond 2^53 ns do not survive a round trip. `Schema.DurationFromNanos` (a `bigint` carrier) is exact but rejects an infinite duration when encoding. `Schema.DurationFromString` is exact and carries `"Infinity"`.

See [Configuration & Secrets](../foundations/configuration-secrets) for loading the rest of the startup configuration.

Official guide: [Duration](https://effect.website/docs/v4/data-types/duration).

**Reach for it when** you need to express, compare, add, or format typed time spans rather than raw millisecond numbers. It is the currency of every scheduling and timeout API in the library.

## DateTime

`effect/DateTime` — stable

**What it is.** `DateTime` is Effect's Clock-aware, timezone-capable replacement for the native `Date` type. Two flavors: `DateTime.Utc` (a pure millisecond instant) and `DateTime.Zoned` (an instant pinned to an IANA timezone with rendered local time). Covers parsing, current time, arithmetic, and formatting.

**Mental model.** An instant is always stored as UTC epoch milliseconds. A `Zoned` value wraps that instant with a timezone tag so calendar-math (add 1 month, start of week) respects DST transitions. Attaching a zone does not change the underlying timestamp — it changes the lens through which it is read.

> **Warning:** `DateTime.now` and `DateTime.nowInCurrentZone` read Effect's `Clock`, so `TestClock` controls them. `DateTime.nowUnsafe()` and `new Date()` read global wall time and bypass that service; reserve them for synchronous boot code outside an Effect. Constructing/parsing a known timestamp is pure and does not have this problem.

### Computing dates and deadlines

```ts
import { DateTime, Effect } from "effect"

// EquityGrant domain type
interface EquityGrant {
  readonly employeeId: string
  readonly shares: number
  readonly grantDate: DateTime.Utc
}

// One-year cliff + monthly vesting over 48 months (standard 4-yr schedule).
// Returns the number of whole shares vested as of `asOf`.
function vestedShares(grant: EquityGrant, asOf: DateTime.Utc): number {
  const cliffEnd = grant.grantDate.pipe(DateTime.add({ months: 12 }))

  // Before the cliff: no shares vested
  if (DateTime.isLessThan(asOf, cliffEnd)) return 0

  // Count completed calendar months. A duration/30.44 approximation can
  // under-vest at the exact cliff because calendar months have varying lengths.
  const grantParts = DateTime.toParts(grant.grantDate)
  const asOfParts = DateTime.toParts(asOf)
  let monthsVested = (asOfParts.year - grantParts.year) * 12 + asOfParts.month - grantParts.month
  if (asOfParts.day < grantParts.day) monthsVested -= 1
  const fraction = Math.min(monthsVested / 48, 1)
  return Math.floor(grant.shares * fraction)
}

const checkVesting = Effect.gen(function*() {
  // Clock-driven "now" — safe in tests via TestClock
  const today: DateTime.Utc = yield* DateTime.now

  const grant: EquityGrant = {
    employeeId: "emp-101",
    shares: 4800,
    grantDate: DateTime.makeUnsafe("2023-01-15T00:00:00Z")
  }

  const vested = vestedShares(grant, today)
  yield* Effect.log(`Vested shares as of ${DateTime.formatIsoDate(today)}: ${vested}`)

  // Review-cycle deadline: 90 days from today
  const reviewDeadline = today.pipe(DateTime.add({ days: 90 }))
  yield* Effect.log(`Q3 merit review deadline: ${DateTime.formatIso(reviewDeadline)}`)
})
```

### Parsing safely

```ts
import { DateTime, Option } from "effect"

// make() returns Option.Option<DateTime.Utc> — never throws
const parsed: Option.Option<DateTime.Utc> =
  DateTime.make("2024-06-15T14:30:00.000Z")

// From epoch millis (e.g. a grantDate stored as a number in the HRIS)
const fromEpoch: Option.Option<DateTime.Utc> = DateTime.make(1_718_460_600_000)

// Epoch-second boundaries avoid hand-written ×1000 / ÷1000 conversions.
const fromSeconds: DateTime.Utc = DateTime.fromEpochSeconds(1_718_460_600)
DateTime.toEpochSeconds(fromSeconds) // 1_718_460_600

// When you're certain the string is valid (e.g. a hardcoded grant date):
const grantDate = DateTime.makeUnsafe("2023-01-15T00:00:00Z")
```

`DateTime.Input` is an existing `DateTime`, a JavaScript `Date`, epoch milliseconds, a partial parts object such as `{ year: 2026, month: 4 }` (missing parts default to the start of the period, in UTC), or a string.

> **Warning:** **A zone-less string and a zone-less `Date` do not mean the same thing.** `DateTime.make("2026-01-01 04:00:00")` treats the text as UTC and yields `04:00Z`. `DateTime.make(new Date("2026-01-01 04:00:00"))` inherits JavaScript's rule that a zone-less date-time string is *host local time*, so the same text becomes `03:00Z` on a machine running at UTC+1 — and a different instant on every other machine. Pass strings, not pre-built `Date` objects, and when the text is a wall-clock reading in a known zone, use [`makeZoned` with `adjustForTimeZone`](#constructing-zoned-values-from-wall-clock-input). `DateTime.fromDateUnsafe` throws on an invalid `Date`.

### Time zones (IANA)

```ts
import { DateTime, Effect, Option } from "effect"
import { NodeRuntime } from "@effect/platform-node"

const program = Effect.gen(function*() {
  const now = yield* DateTime.now

  // Attach a known IANA zone — unsafe (throws if zone is invalid)
  const nyTime = now.pipe(DateTime.setZoneNamedUnsafe("America/New_York"))

  // Safe variant returns Option — use when zone comes from user input
  const sfTime: Option.Option<DateTime.Zoned> = now.pipe(
    DateTime.setZoneNamed("America/Los_Angeles")
  )

  // Render with offset and zone id: "2026-06-20T10:00:00.000-04:00[America/New_York]"
  const isoZoned = DateTime.formatIsoZoned(nyTime)
  yield* Effect.log(`Merit cycle closes at: ${isoZoned}`)

  // Read the current zone from the CurrentTimeZone service
  const localNow: DateTime.Zoned = yield* DateTime.nowInCurrentZone
  yield* Effect.log(DateTime.formatIsoZoned(localNow))
}).pipe(
  // Provide New York as the application-wide current zone
  Effect.provide(DateTime.layerCurrentZoneNamed("America/New_York")),
  NodeRuntime.runMain
)
```

A zone is a value of its own, `DateTime.TimeZone`, with two variants: `TimeZone.Named` (an IANA id, DST-aware) and `TimeZone.Offset` (fixed milliseconds from UTC). **An offset zone never follows daylight saving**, so store the IANA id whenever the zone describes a place. Validate a user-supplied zone once and reuse the value:

| Constructor | Accepts | Result |
| --- | --- | --- |
| `DateTime.zoneFromString(text)` | `"+05:30"` or `"Asia/Kolkata"` | `Option<TimeZone>` |
| `DateTime.zoneMakeNamed(id)` | IANA id | `Option<TimeZone.Named>` |
| `DateTime.zoneMakeNamedEffect(id)` | IANA id | Effect failing with `IllegalArgumentError` |
| `DateTime.zoneMakeNamedUnsafe(id)` | IANA id you control | Throws on an unknown id |
| `DateTime.zoneMakeOffset(millis)` / `DateTime.zoneMakeLocal()` | Offset in ms / the host zone | `TimeZone` |

```ts
import { DateTime, Option } from "effect"

// An employee profile stores either an IANA id or a fixed offset.
const parseProfileZone = (raw: string): DateTime.TimeZone =>
  DateTime.zoneFromString(raw).pipe(
    Option.getOrElse(() => DateTime.zoneMakeOffset(0)) // fall back to UTC
  )

const reviewOpens = DateTime.makeUnsafe("2026-03-01T00:00:00Z")

// setZone re-reads the same instant through a validated zone value.
const forEmployee = DateTime.setZone(reviewOpens, parseProfileZone("Asia/Kolkata"))
// setZoneOffset is the fixed-offset shortcut (+05:30 in milliseconds).
const fixedOffset = DateTime.setZoneOffset(reviewOpens, 5.5 * 60 * 60 * 1000)
```

`DateTime.zoneToString(zone)` renders the id or offset back to text.

### Constructing zoned values from wall-clock input

`setZone*` attaches a zone to an instant that is already correct. The other common case is the reverse: the input is a **local wall-clock reading** — "the merit cycle closes at 09:00 in New York" — and the instant is what you need to compute.

**By default `DateTime.makeZoned` reads its input as UTC and merely attaches the zone; `adjustForTimeZone: true` interprets the input as local time in that zone**, which produces a different instant:

```ts
import { DateTime, Option } from "effect"

const local = "2026-03-02T09:00:00"

// Input read as UTC, zone attached: 04:00 in New York.
const attached = DateTime.makeZonedUnsafe(local, { timeZone: "America/New_York" })
DateTime.formatIsoZoned(attached) // "2026-03-02T04:00:00.000-05:00[America/New_York]"

// Input read as New York wall-clock time: 09:00 there, 14:00 UTC.
const wallClock = DateTime.makeZonedUnsafe(local, {
  timeZone: "America/New_York",
  adjustForTimeZone: true
})
DateTime.formatIsoZoned(wallClock) // "2026-03-02T09:00:00.000-05:00[America/New_York]"
DateTime.formatIso(wallClock)      // "2026-03-02T14:00:00.000Z"

// A payroll cutoff at 02:30 on the day clocks spring forward does not exist.
const cutoff = DateTime.makeZoned("2026-03-08T02:30:00", {
  timeZone: "America/New_York",
  adjustForTimeZone: true,
  disambiguation: "reject"
}) // Option.none()

// formatIsoZoned and makeZonedFromString round-trip without losing the zone.
const restored: Option.Option<DateTime.Zoned> = DateTime.makeZonedFromString(
  DateTime.formatIsoZoned(wallClock)
)
```

Daylight-saving transitions make some wall-clock readings nonexistent (the spring-forward gap) and others ambiguous (the repeated hour in autumn). `disambiguation` applies only together with `adjustForTimeZone: true`:

| `disambiguation` | Gap (02:30 on 2026-03-08, New York) | Repeated hour (01:30 on 2026-11-01, New York) |
| --- | --- | --- |
| `"compatible"` (default) | Later reading: 03:30 EDT | Earlier occurrence: 01:30 EDT |
| `"earlier"` | 01:30 EST | 01:30 EDT |
| `"later"` | 03:30 EDT | 01:30 EST |
| `"reject"` | `makeZoned` → `Option.none()`; `makeZonedUnsafe` throws | same |

**Use `"reject"` for deadlines, payroll cutoffs, and anything with legal weight, and surface the rejection to whoever entered the time**; silently moving a cutoff by an hour is a decision a person should make. `DateTime.setZone` accepts the same two options.

### Calendar math and truncation

```ts
import { DateTime } from "effect"

const grantDate = DateTime.makeUnsafe("2023-01-15T09:00:00Z").pipe(
  // Pin to a timezone before doing calendar-aware math
  DateTime.setZoneNamedUnsafe("America/New_York")
)

// Vesting cliff: exactly 12 months after grant date
const cliffDate = grantDate.pipe(DateTime.add({ months: 12 }))

// Start of the merit-review quarter (start of the month, 3 months out)
const reviewStart = grantDate.pipe(DateTime.add({ months: 3 }), DateTime.startOf("month"))

// End of the fiscal year for bonus accrual
const fiscalYearEnd = grantDate.pipe(DateTime.endOf("year"))

// How long until the vesting cliff from today?
const today = DateTime.makeUnsafe("2026-06-20T00:00:00Z")
const timeToCliff = DateTime.distance(today, cliffDate) // Duration (negative = past cliff)

// Subtract a Duration — e.g. 30-day window before the cliff to send reminders
const reminderStart = cliffDate.pipe(DateTime.subtractDuration("30 days"))
```

Month and year arithmetic clamps to the last valid day instead of spilling into the next month: `2026-01-31` plus `{ months: 1 }` is `2026-02-28`, and `2024-02-29` plus `{ years: 1 }` is `2025-02-28`. Consequently adding a month and then subtracting one is not always the identity — compute recurring dates from the original anchor (`grantDate + n months`), not by chaining increments. `DateTime.setParts` / `setPartsUtc` do not clamp: the parts you pass are applied together, so `{ month: 2, day: 15 }` on 31 January is 15 February, but `{ month: 2 }` alone keeps day 31 and rolls over to 3 March.

### Providing the current zone via a Layer

```ts
import { DateTime, Layer } from "effect"

// Named IANA zone — HQ time for the compensation team
const hqZone    = DateTime.layerCurrentZoneNamed("America/New_York")

// Fixed UTC offset — offset is in milliseconds (+05:30 = 5.5 * 60 * 60 * 1000)
const kolkata   = DateTime.layerCurrentZoneOffset(5.5 * 60 * 60 * 1000)

// System local zone of the Node process
const local     = DateTime.layerCurrentZoneLocal

// An already-validated TimeZone value
const fromValue = DateTime.layerCurrentZone(DateTime.zoneMakeNamedUnsafe("Europe/Rome"))
```

A Layer fixes the zone for the whole application. For a per-request or per-employee zone, scope `CurrentTimeZone` to one effect with `DateTime.withCurrentZone(zone)`, `withCurrentZoneNamed(id)`, `withCurrentZoneOffset(millis)`, or `withCurrentZoneLocal`. `withCurrentZoneNamed` adds `IllegalArgumentError` to the effect's error channel for an unknown id, whereas `layerCurrentZoneNamed` fails when the Layer is built. `DateTime.setZoneCurrent(dateTime)` re-zones an existing value using the service.

```ts
import { DateTime, Effect } from "effect"

// Render the review deadline in each employee's own zone.
const deadlineFor = (deadline: DateTime.Utc, employeeZone: DateTime.TimeZone) =>
  DateTime.setZoneCurrent(deadline).pipe(
    Effect.map(DateTime.formatIsoZoned),
    DateTime.withCurrentZone(employeeZone)
  )
```

### Formatting

Picking the wrong formatter silently changes what a database column or API consumer receives. Output below is for 09:00 New York time on 2 March 2026.

| Formatter | Zone applied | Output |
| --- | --- | --- |
| `DateTime.formatIso` | UTC, always | `2026-03-02T14:00:00.000Z` |
| `DateTime.formatIsoOffset` | The value's zone | `2026-03-02T09:00:00.000-05:00` |
| `DateTime.formatIsoZoned` | The value's zone | `2026-03-02T09:00:00.000-05:00[America/New_York]` — the form `makeZonedFromString` parses |
| `DateTime.formatIsoDate` / `formatIsoDateUtc` | The value's zone / UTC | `2026-03-02` — the two differ near midnight |
| `DateTime.format(dt, options)` | The value's zone | `Intl.DateTimeFormat` output, e.g. `Mar 2, 2026, 9:00 AM` |
| `DateTime.formatUtc` / `formatLocal` | UTC / the host's zone | As `format`, with the zone forced |
| `DateTime.formatIntl(dt, formatter)` | The formatter's | Bring your own `Intl.DateTimeFormat` |

**Persist `formatIso` (an instant) or `formatIsoZoned` (an instant plus the place it was meant for); keep `format*` with `Intl` options for display only.**

**Key APIs.** Guards: `isDateTime`, `isUtc`, `isZoned`, `isTimeZone`. Comparison: `min`, `max`, `between`, `isLessThan`, `isGreaterThan`, `distance`. `DateTime.isFuture` and `DateTime.isPast` are Effects that read the `Clock`, so `TestClock` controls them; `isFutureUnsafe` / `isPastUnsafe` read wall time like `nowUnsafe`. Leaving `DateTime`: `toEpochMillis`, `toDateUtc`, `toDate` (zone-adjusted), `zonedOffset` / `zonedOffsetIso`. Parts: `toParts` / `toPartsUtc`, `getPart`, `setParts` / `setPartsUtc`, `removeTime`, and `nearest` alongside `startOf` / `endOf`.

Official guide: [DateTime](https://effect.website/docs/v4/data-types/datetime) (several headings keep stale names such as `unsafeMake`; its "Zoned Constructors" section predates `disambiguation`; and it describes zone-less strings as local time, which is true only for the `Date` inputs its examples use).

**Reach for it when** you need the current time in an Effect, when parsing ISO timestamps safely, when computing dates that must respect DST and timezones, or when formatting a timestamp for display or a database column.

## Cron

`effect/Cron` — stable

**What it is.** A pure cron expression parser and evaluator. Parses a standard 5-field (or 6-field with seconds) cron string into a typed `Cron` value queryable for next/previous run times, instant matching, or an infinite sequence of future fire times. Also backs `Schedule.cron`.

**Mental model.** A `Cron` is six `Set<number>` values — one per field (seconds, minutes, hours, days, months, weekdays) — plus an optional timezone. Matching is O(1) set lookups; computing the next occurrence walks forward in time field by field.

```ts
import { Cron, Result, DateTime } from "effect"

// parse() returns Result<Cron, CronParseError> — never throws
const everyHour = Result.getOrThrow(Cron.parse("0 * * * *"))

// parseUnsafe for hardcoded, known-valid expressions
// Nightly payroll run at 01:00 UTC (6-field form with seconds)
const nightly = Cron.parseUnsafe("0 0 1 * * *")

// Quarterly merit-cycle kickoff: 08:00 on 1 Jan, 1 Apr, 1 Jul, 1 Oct (NY time)
const quarterlyMerit = Cron.parseUnsafe("0 8 1 1,4,7,10 *", "America/New_York")

// Does today's 08:00 ET match the quarterly expression?
const checkpoint = DateTime.makeUnsafe("2026-07-01T12:00:00Z") // 08:00 ET
const fires = Cron.match(quarterlyMerit, checkpoint)  // true

// Next payroll run after a given instant
const nextPayroll: Date = Cron.next(nightly, new Date("2026-06-20T00:00:00Z"))
// → Sat Jun 20 2026 01:00:00 UTC

// Enumerate the next 3 nightly payroll runs
const seq = Cron.sequence(nightly)
const next3 = [seq.next().value, seq.next().value, seq.next().value]

// Serialize for a config editor. A sole zero-seconds field is omitted by default.
Cron.format(nightly)                                  // "0 1 * * *"
Cron.format(nightly, { includeSeconds: true })        // "0 0 1 * * *"
```

`Cron.format` serializes the calendar fields, not the whole semantic value: it drops timezone information and the special day/weekday `and` restriction. Consequently `Cron.parse(Cron.format(cron))` is not always equivalent to `cron`; persist the missing metadata separately when it matters.

### Building a Cron from structured fields

When the schedule comes from a settings screen or typed configuration rather than a cron string, build it with `Cron.make`. An empty collection means "unconstrained" for that field, `seconds` defaults to `[0]`, `tz` takes a `DateTime.TimeZone`, and `and: true` requires day-of-month **and** weekday to match instead of either.

```ts
import { Cron, DateTime } from "effect"

// Payroll preview: 04:00 Rome time on days 8–14 of every month.
const secondWeek = Cron.make({
  minutes: [0],
  hours: [4],
  days: [8, 9, 10, 11, 12, 13, 14],
  months: [],   // every month
  weekdays: [], // any weekday
  tz: DateTime.zoneMakeNamedUnsafe("Europe/Rome")
})

Cron.next(secondWeek, new Date("2026-06-01T00:00:00Z")) // 2026-06-08T02:00:00.000Z
Cron.prev(secondWeek, new Date("2026-06-01T00:00:00Z")) // 2026-05-14T02:00:00.000Z
```

> **Warning:** `Cron.make` throws a `RangeError` synchronously for out-of-range values (`minutes: [99]`), and `Cron.next` / `Cron.prev` throw when no matching date can be found (`"0 0 31 2 *"`). Validate user-supplied fields with a Schema first, and prefer `Cron.parse`, which returns a `Result`, for cron text.

### Driving a scheduled job with Schedule.cron

```ts
import { Effect, Schedule } from "effect"

// Schedule.cron wraps Cron.parse internally and emits CronParseError if invalid.
// Prefer parseUnsafe for literals you control.
const payrollCron = Schedule.cron("0 1 * * *", "UTC")  // 01:00 UTC every night

declare const runPayrollBatch: Effect.Effect<void>

// Effect.repeat runs the effect once immediately, then again at each cron tick.
const payrollJob = runPayrollBatch.pipe(Effect.repeat(payrollCron))

// Effect.schedule waits for the first tick — a restart at 14:00 does not run payroll.
const payrollJobOnTick = runPayrollBatch.pipe(Effect.schedule(payrollCron))
```

**Choose the runner by what a restart should do.** A nightly job driven by `Effect.repeat` runs on every deploy and crash-restart, then again at 01:00; `Effect.schedule` runs only at cron ticks. Neither catches up on ticks missed while the process was down — a job that must not be skipped needs durable scheduling such as [ClusterCron](../systems/cluster-sharding#clustercron) or a [Workflow](../systems/workflows-durable-execution). The schedule's output is a `Duration` (the computed wait), and an invalid expression fails the schedule with `Cron.CronParseError`.

Official guide: [Cron](https://effect.website/docs/v4/scheduling/cron) (its prose says `Schedule.cron` outputs a `[start, end]` tuple and mentions `TestContext`; in `rc.116` the output is a `Duration` and `TestClock.layer()` is all a test needs).

**Reach for it when** you need to parse cron expressions from configuration, check whether a scheduled job should have fired, enumerate upcoming run times for a scheduling preview UI, or drive a background job with `Schedule.cron`.

## Random

`effect/Random` — stable

**What it is.** Effect-native pseudo-random number generation. Every `Random.*` function returns an `Effect` reading from a `Context.Reference` holding the PRNG service. Because that service can be locally replaced rather than relying on a process-global generator, it is **seedable** and **reproducible** — test suites can pin the seed and get deterministic runs.

**Mental model.** `Math.random()` is a black box mutating hidden global state. `Random.next` is an effect reading from an injectable, swappable PRNG. Swap the reference with `Random.withSeed("my-seed")` and you get the same sequence every run.

```ts
import { Effect, Random } from "effect"

const program = Effect.gen(function*() {
  // Float in [0, 1)
  const roll    = yield* Random.next

  // Random boolean
  const flip    = yield* Random.nextBoolean

  // Integer anywhere in the safe-integer range
  const big     = yield* Random.nextInt

  // Float in [min, max)
  const pct     = yield* Random.nextBetween(0, 100)

  // Integer in [min, max] inclusive (default; pass { halfOpen: true } for exclusive max)
  const bucket  = yield* Random.nextIntBetween(1, 10)

  // Pick one element from a collection — e.g. assign a random reviewer
  const reviewer = yield* Random.choice(["alice", "bob", "carol"] as const)

  // Shuffle an array — e.g. randomize the order of raise recommendations for review
  const shuffled = yield* Random.shuffle([1, 2, 3, 4, 5])

  return { roll, flip, big, pct, bucket, reviewer, shuffled }
})
```

### Deterministic testing

```ts
import { Effect, Random } from "effect"

// Simulate a random performance rating draw for load testing.
// With a fixed seed, every CI run produces the same sequence.
const drawRating = Effect.gen(function*() {
  const a = yield* Random.nextIntBetween(1, 5) // rating 1–5
  const b = yield* Random.nextIntBetween(1, 5)
  const c = yield* Random.nextIntBetween(1, 5)
  return [a, b, c] as const
})

// Same seed → identical output every run, in any environment.
const deterministicDraw = drawRating.pipe(Random.withSeed("merit-sim-v1"))

// In a real test (e.g. vitest):
// const result = await Effect.runPromise(deterministicDraw)
// expect(result).toEqual([1, 4, 3])  // pinned by this audited PRNG implementation
```

The generator object supplied by one `Random.withSeed` region is mutable and inherited by child fibers. Concurrent children in the same region therefore draw from one shared sequence, so scheduling can affect which child receives which value. For independently reproducible branches, wrap each branch separately with its own `Random.withSeed`.

### Jitter without coupling to Math.random

`Schedule.jittered` internally uses the `Random` reference, so it is also seedable in tests. Retry delays with jitter are fully deterministic under a fixed seed.

```ts
import { Effect, Random, Schedule, Schema } from "effect"

class HrisError extends Schema.TaggedError<HrisError>()("HrisError", {
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  retryable: Schema.Boolean
}) {}

// Load-test: simulate concurrent compensation-plan API calls with random
// employee IDs and staggered delays, reproducibly.
const compPlanLoadTest = Effect.gen(function*() {
  // Random employee ID in a realistic range
  const empId  = yield* Random.nextIntBetween(10000, 99999)
  // Random startup delay so not all fibers hammer the API at t=0
  const jitter = yield* Random.nextBetween(0, 50)
  yield* Effect.sleep(`${jitter} millis`)
  yield* Effect.log(`Querying comp plan for employee ${empId}`)
}).pipe(
  // Run 100 times total with a 10 ms gap between completions.
  Effect.repeat(Schedule.spaced("10 millis").pipe(Schedule.upTo({ times: 99 }))),
  // Seed the PRNG so the load test is fully reproducible in CI
  Random.withSeed("comp-load-test-v1")
)
```

**Reach for it when** you need randomness inside an Effect — picking a random item, shuffling data, generating test data, adding jitter to a custom retry delay, or running a reproducible simulation. Never call `Math.random()` directly; you lose testability and fiber-locality.
