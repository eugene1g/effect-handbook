# Scheduling & Time

_Effect provides a composable time stack: typed duration values, a testable clock-aware date/time system, a cron parser, an effect-native PRNG, and `Schedule`, the algebraic policy engine powering retry and repeat._

> **Official companions:** Effect's release-matched [Schedule cookbook](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/cookbooks/schedule.md) develops retry, repeat, composition, and schedule state as a worked recipe. The `ai-docs` corpus adds executable [Schedule](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/06_schedule) and [DateTime](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/07_datetime) examples.

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
```

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
```

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

  // Render with offset suffix: "2026-06-20T10:00:00.000-04:00"
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

### Providing the current zone via a Layer

```ts
import { DateTime, Layer } from "effect"

// Named IANA zone — HQ time for the compensation team
const hqZone    = DateTime.layerCurrentZoneNamed("America/New_York")

// Fixed UTC offset — offset is in milliseconds (+05:30 = 5.5 * 60 * 60 * 1000)
const kolkata   = DateTime.layerCurrentZoneOffset(5.5 * 60 * 60 * 1000)

// System local zone of the Node process
const local     = DateTime.layerCurrentZoneLocal
```

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

### Driving a scheduled job with Schedule.cron

```ts
import { Effect, Schedule } from "effect"

// Schedule.cron wraps Cron.parse internally and emits CronParseError if invalid.
// Prefer parseUnsafe for literals you control.
const payrollCron = Schedule.cron("0 1 * * *", "UTC")  // 01:00 UTC every night

declare const runPayrollBatch: Effect.Effect<void>

// Effect.repeat runs the effect once immediately, then again at each cron tick.
const payrollJob = runPayrollBatch.pipe(Effect.repeat(payrollCron))
```

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
