# Testing & Dev Tooling

Effect's test services make time, console output, randomness, and dependencies deterministic; `@effect/vitest` integrates those services with a test runner. The repository's documentation tools then compile and validate examples so docs can be treated like code rather than inert prose.

> **Official companions:** Browse the release-matched authored [AI documentation source](https://github.com/Effect-TS/effect/tree/effect%404.0.2/ai-docs/src) for executable examples across Effect. [`LLMS.md`](https://github.com/Effect-TS/effect/blob/effect%404.0.2/LLMS.md) is its generated single-file aggregate and begins with Effect's coding conventions.

> **Official guides:** [Devtools](https://effect.website/docs/v4/getting-started/devtools). These track Effect's `main` branch rather than this handbook's pinned `4.0.2` release, so where they differ, this page and the tagged source win.

**Pick the tool by the claim you need to prove.** Each row is evidence for one kind of statement and for nothing beyond it; [Testing an Effect Application](../deep-dives/testing-an-effect-application) turns the table into a full strategy.

| Claim under test | Tool | It does not prove |
| --- | --- | --- |
| A delay, timeout, retry spacing, or TTL behaves as specified | [`TestClock`](#testclock) inside `it.effect` | that a real driver, socket, or OS timer honors the same timing |
| A program writes the expected `Console.*` output | [`TestConsole`](#testconsole) | anything about `Effect.log*` records — capture those with a test `Logger` |
| A rule holds for every valid input | [`Arbitrary`](#arbitrary) via `it.effect.prop` | rejection of malformed wire input — generators produce valid decoded values |
| A codec decodes, encodes, and round-trips | [`TestSchema`](#testschema) | cross-field business rules the schema does not state |
| Orchestration, typed failures, interruption, cleanup | `it.effect` plus replacement Layers | the real adapter's behavior — a fake is not an adapter |
| An adapter works against a real dependency | `layer(L, { excludeTestServices: true })` or `it.live` | that the packaged entry point starts, serves, and shuts down |
| `E` and `R` are exactly what the contract says | `expectTypeOf` under the type checker | any runtime behavior |
| Editor, `tsc`, and CI agree on Effect-specific mistakes | [`@effect/tsgo`](#effect-language-service-effect-tsgo) | anything a test would have to run to observe |

## TestClock

`effect/testing/TestClock` — stable

A virtual clock that replaces the real clock inside Effect. `TestClock.adjust("1 hour")` fast-forwards time: every fiber sleeping until that point wakes immediately in scheduled order. Tests that would take minutes in wall time complete in milliseconds.

**Mental model.** Every fiber calling `Effect.sleep` (or anything built on it: schedules, retries with backoff, timeouts) suspends and queues itself against a virtual timestamp. `TestClock.adjust` / `TestClock.setTime` advances the timeline; all fibers scheduled before the new mark run in order. The live clock is entirely absent.

> **Tip:** Because a sleeping fiber semantically blocks, you must fork the work first, then advance the clock, then join. Advancing after joining a sleeping fiber will deadlock.

Key APIs: TestClock.adjust(duration), TestClock.setTime(timestamp), TestClock.withLive(effect), TestClock.layer(options?), TestClock.make(options?)

`@effect/vitest` automatically provides `TestClock.layer()` (plus `TestConsole.layer`) inside every `it.effect` block. Use `it.live` for the real clock.

Semantics worth knowing before a test hangs:

| Fact | Consequence |
| --- | --- |
| **Virtual time starts at `0`**, the Unix epoch. | `Clock.currentTimeMillis` and `DateTime.now` read 1970 until you call `setTime`; pin the date whenever a calendar rule is under test. |
| **`adjust` and `setTime` give already-forked fibers one scheduling turn, then move time**, waking sleepers in timestamp order and yielding once after each. | A fiber that needs several turns to reach its `sleep` registers it *after* the adjustment and then waits forever. Synchronize on a signal from the fiber instead of counting turns — see [Drive time instead of waiting](../deep-dives/testing-an-effect-application#drive-time-instead-of-waiting). |
| **A zero or negative sleep returns immediately.** | It never becomes a scheduled wake-up, so there is nothing to adjust past. |
| **A sleep that nobody advances logs a warning** after `warningDelay` of *live* time (default `"1 second"`). | The message "A test is using time, but is not advancing the test clock" means a missing `adjust`, not a slow test. Tune it with `TestClock.layer({ warningDelay })`. |
| **Adjustments keep nanosecond precision**, including after very large jumps. | `Clock.currentTimeNanos` is exact: a `"365 days"` adjust followed by `1.5` ms reads `31536000001500000n`. |
| **`TestClock.withLive(effect)`** runs one effect on the real clock. | Use it for a wall-clock guard around a join (`Effect.timeoutOption`) or for a real fixture's readiness wait inside an otherwise virtual test. |

```ts
import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Option, Queue, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

describe("TestClock — vesting & merit-cycle scenarios", () => {
  // Fast-forward an equity vesting cliff without real waiting.
  // After a 1-year cliff, all 25% of the first-year tranche should be vested.
  it.effect("vesting cliff: fiber wakes after 1 year of virtual time", () =>
    Effect.gen(function*() {
      const vestedRef = yield* Ref.make(0)

      // Simulates the vesting service checking a cliff after 1 year.
      const vestingFiber = yield* Effect.forkChild(
        Effect.sleep("365 days").pipe(
          Effect.flatMap(() => Ref.set(vestedRef, 1000)), // 1 000 shares vest at cliff
          Effect.as("cliff-vested")
        )
      )

      // No real time passes — jump the virtual clock to just past the cliff.
      yield* TestClock.adjust("365 days")

      const result = yield* Fiber.join(vestingFiber)
      const vested = yield* Ref.get(vestedRef)

      assert.strictEqual(result, "cliff-vested")
      assert.strictEqual(vested, 1000)
    }))

  // Fast-forward through a merit-cycle retry schedule.
  // The merit service retries transient HRIS failures with exponential backoff.
  it.effect("merit-cycle retry: resolves in virtual time without sleeping", () =>
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)

      // Retry up to 8 seconds of cumulative backoff (exponential from 1 s).
      const policy = Schedule.exponential("1 second").pipe(
        Schedule.upTo({ duration: "8 seconds" })
      )

      const fetchMeritBudget = Effect.gen(function*() {
        const n = yield* Ref.updateAndGet(attempts, (x) => x + 1)
        if (n < 3) return yield* Effect.fail("HrisUnavailable" as const)
        return { totalBudget: 500_000, cycleYear: 2025 }
      })

      // Fork so we can drive the virtual clock independently.
      const fiber = yield* fetchMeritBudget.pipe(
        Effect.retry(policy),
        Effect.forkChild
      )

      // Each advance triggers the next scheduled retry attempt.
      yield* TestClock.adjust("1 second")  // attempt 2
      yield* TestClock.adjust("2 seconds") // attempt 3 — succeeds

      const budget = yield* Fiber.join(fiber)
      assert.strictEqual(budget.totalBudget, 500_000)
      assert.strictEqual(yield* Ref.get(attempts), 3)
    }))

  // Pin the virtual clock to a known review-cycle start date.
  it.effect("sets absolute timestamp for merit-cycle deadline assertions", () =>
    Effect.gen(function*() {
      // Pin virtual clock to 1 Jan 2025 00:00:00 UTC for deterministic assertions.
      const cycleOpen = new Date("2025-01-01T00:00:00Z").getTime()
      yield* TestClock.setTime(cycleOpen)
      // Advance 90 days to the Q1 submission deadline.
      yield* TestClock.adjust("90 days")
      const deadline = new Date("2025-04-01T00:00:00Z").getTime()
      assert.strictEqual(yield* Clock.currentTimeMillis, deadline)
    }))

  // A timeout is a claim about two instants: not yet at 29 s, fired at 30 s.
  it.effect("an unanswered HRIS lookup times out at exactly 30 seconds", () =>
    Effect.gen(function*() {
      const lookup = Effect.never.pipe(Effect.timeoutOption("30 seconds"))
      const fiber = yield* Effect.forkChild(lookup)

      yield* TestClock.adjust("29 seconds")
      assert.isUndefined(fiber.pollUnsafe()) // still running

      yield* TestClock.adjust("1 second")
      assert.isTrue(Option.isNone(yield* Fiber.join(fiber)))
    }))

  // A recurring job: assert "nothing yet" as well as "exactly one per interval".
  it.effect("the payroll sync runs at once, then once per hour", () =>
    Effect.gen(function*() {
      const runs = yield* Queue.unbounded<number>()
      const fiber = yield* Clock.currentTimeMillis.pipe(
        Effect.flatMap((startedAt) => Queue.offer(runs, startedAt)),
        Effect.repeat(Schedule.spaced("1 hour")),
        Effect.forkChild
      )

      assert.strictEqual(yield* Queue.take(runs), 0) // the take is the handshake
      yield* TestClock.adjust("59 minutes")
      assert.isTrue(Option.isNone(yield* Queue.poll(runs))) // not early

      yield* TestClock.adjust("1 minute")
      assert.deepStrictEqual(yield* Queue.poll(runs), Option.some(3_600_000))
      assert.isTrue(Option.isNone(yield* Queue.poll(runs))) // and only once

      yield* Fiber.interrupt(fiber)
    }))
})
```

**Make every time test two-sided.** Asserting only the state after the adjustment accepts an implementation that fires early; assert the "not yet" instant as well, as the timeout and recurring-job tests do.

Retry policies have their own home: [Recipe: Typed Retry with TestClock](../recipes/retry-with-test-clock) is a complete file, and [Schedule](../concurrency/scheduling-time#schedule) covers the policy combinators those tests exercise.

Use when code under test touches `Effect.sleep`, `Effect.timeout`, schedules, retry delays, or rate limiters.

Official guide: [TestClock](https://effect.website/docs/v4/testing/testclock).

## TestConsole

`effect/testing/TestConsole` — unstable

A test implementation of the Effect `Console` service that captures output instead of printing it. All calls through `Console.log`, `Console.error`, etc. are recorded in memory for deterministic assertion via `TestConsole.logLines` and `TestConsole.errorLines`.

**Mental model.** `logLines` / `errorLines` return a flat array of every argument passed across all calls of that method. Three `Console.log` calls each passing one value yield a three-element array. `it.effect` provides `TestConsole.layer` automatically.

```ts
import { assert, it } from "@effect/vitest"
import { Console, Effect } from "effect"
import { TestConsole } from "effect/testing"

it.effect("captures comp-service audit logs for assertions", () =>
  Effect.gen(function*() {
    // Simulate a compensation service emitting structured diagnostics.
    yield* Console.log("raise applied", { employeeId: "E42", delta: 4200 })
    yield* Console.log("budget remaining", { pool: "eng", remaining: 95800 })
    yield* Console.error("BandViolation", { employeeId: "E99", requested: 210000 })

    // logLines is a flat array of all arguments from every Console.log call.
    const logs = yield* TestConsole.logLines
    const errors = yield* TestConsole.errorLines

    // Two Console.log calls — three arguments total (flat).
    assert.deepStrictEqual(logs, [
      "raise applied", { employeeId: "E42", delta: 4200 },
      "budget remaining", { pool: "eng", remaining: 95800 }
    ])
    // One Console.error call — two arguments total (flat).
    assert.deepStrictEqual(errors, ["BandViolation", { employeeId: "E99", requested: 210000 }])
  }))
```

> **Note:** `logLines` returns a **flat** array of all individual arguments from every `Console.log` call so far. Each positional argument becomes its own element. If you log `Console.log("a", "b")` and then `Console.log("c")`, you get `["a", "b", "c"]` — not an array-of-arrays.

> **Warning:** `TestConsole` is the wrong seam for `Effect.log*`. The default logger prints *through* the `Console` service, so under `it.effect` a call such as `Effect.logInfo("raise approved")` does land in `logLines` — as a rendered prefix string such as `"[00:00:00.000] INFO (#1):"` followed by the message parts and the annotations object. That prefix renders the virtual time in the machine's local time zone and includes a fiber id, so asserting on it is brittle. Capture log records with a test `Logger` instead; [Test logs without scraping stdout](../deep-dives/testing-an-effect-application#test-logs-without-scraping-stdout) shows the helper.

Use when Effect code emits structured diagnostics via `Console.*` and you want to assert on output without parsing stdout or suppressing CI noise.

## Arbitrary

`effect/Arbitrary` — unstable

Effect's native, **Schema-first** property-testing engine. It is not a fast-check bridge: `effect/testing/FastCheck`, `Schema.toArbitrary`, and the `fastCheck` options in `@effect/vitest` do not exist, and the `effect` package does not depend on fast-check.

**Mental model.** You do not assemble generators from primitives. You describe the domain once as a `Schema` and derive the generator from it with `Arbitrary.schema(schema)`; checks such as `isBetween` and `isPattern` become *constructive* constraints rather than rejection filters. Generated values are the schema's decoded `Type`. The small combinator set — `map`, `filter`, `filterMap`, `flatMap` (dependent generation), `all` (tuples, iterables, records), and `Constant` — composes derived arbitraries without introducing a second catalog of primitive constructors.

```ts
import { Arbitrary, Effect, Schema } from "effect"

// Describe a raise recommendation as a Schema; the generator is derived from it.
const RaiseRecommendation = Schema.Struct({
  employeeId: Schema.NonEmptyString,
  currentSalary: Schema.Finite.check(Schema.isBetween({ minimum: 50_000, maximum: 300_000 })),
  raisePercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.15 }))
})

const raiseArb = Arbitrary.schema(RaiseRecommendation)

// Sampling is an Effect: interruptible, seedable, and bounded.
const samples = Arbitrary.sampleEffect(raiseArb, { count: 5, seed: 42 })

// Property: the post-raise salary never drops and never exceeds the 15% cap.
const check = Arbitrary.checkEffect(
  raiseArb,
  ({ currentSalary, raisePercent }) => {
    const newSalary = currentSalary * (1 + raisePercent)
    return newSalary >= currentSalary && newSalary <= currentSalary * 1.15 + 1
  },
  { runs: 200, seed: 42 }
)

// checkEffect does NOT throw on falsification — it returns data to inspect.
const report = Effect.gen(function*() {
  const result = yield* check
  switch (result._tag) {
    case "Passed":
      return `ok after ${result.runs} runs`
    case "Falsified":
      // shrunkInput is the smallest failing value found; replay reproduces it exactly.
      return `failed for ${JSON.stringify(result.shrunkInput)} — replay: ${result.replay}`
    case "Exhausted":
      return `too many discards (seed ${result.seed}); loosen the filter or make it constructive`
    case "ReplayMismatch":
      return `replay token no longer reproduces: ${result.reason}`
  }
})

const _ = [samples, report]
```

`checkEffect` accepts a pure predicate or an Effectful property. Returning `false` and failing the Effect are both shrinkable falsifications (a typed failure is preserved in `Falsified.failure`); **defects and interruption are not converted** and continue through the returned Effect. `Arbitrary.formatCheckFailure(result)` renders a non-passing result for a custom reporter. Everything is bounded: `maxDiscards` caps rejected candidates (reported as `Exhausted`, or `SampleError` when sampling), and `maxShrinks` caps the shrink search, returning the best input found so far.

Generation is **size-scaled**. `size` is a local complexity budget that a check grows toward as runs complete, and at the default an *unconstrained* `Schema.Int` stays within roughly ±100 and an unconstrained `Schema.String` within about ten characters. Explicit Schema bounds are always honored regardless of size. So if a bug only appears for large values, say so in the schema (`isBetween`, `isMinLength`) or raise `size` — more `runs` alone will not reach it.

Three rules keep properties trustworthy. Treat generated values as **immutable** — the runner does not clone them, so mutation corrupts shrinking and replay. Make the property **deterministic for a given input**, because it may be evaluated repeatedly; a stateful property should acquire and release its own fixture inside each evaluation. And record a failure as an **explicit regression test**: a `replay` token reproduces the current failure, but it is an unstable-module artifact that is not guaranteed across upgrades, and it is unrelated to fast-check seeds and paths. Array shrinking drops prefixes and interior blocks while keeping the order of what remains, and composed values keep shrink candidates where possible. `BigInt` and `BigDecimal` generation covers a wide range of magnitude, precision, and exponent, with shrinking toward numeric boundaries.

`Arbitrary.configureGlobal({ check, sample })` replaces the defaults `checkEffect` and `sampleEffect` fall back to, for executions that start after the call — set it once, outside any concurrent test, rather than per test. Pass `{}` to reset it. A `replay` token always keeps control of its own run regardless of configured defaults.

When a custom `Schema.declare`/`instanceOf` type is opaque to derivation, annotate it with `toCodecArbitrary` (a `Schema.link` to a generatable representation) — but first check whether it already has a `toCodecJson`/`toCodec`, which derivation falls back to automatically. A selective custom filter can contribute an `arbitraryConstraint` (for example `{ order: Order.Number, minimum: 0, exclusiveMinimum: true }`) so generation constructs valid values instead of discarding invalid ones; the predicate stays authoritative.

### Shrinking, composition, and wire-side samples

```ts
import { Arbitrary, Effect, Schema } from "effect"

const GrantShares = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))

// Custom shrinking REPLACES the Schema-derived shrink tree for this arbitrary.
const grantShares = Arbitrary.schema(GrantShares, {
  shrink: (shares) => (shares === 0 ? [] : [Math.floor(shares / 2)])
})

// Dependent generation: draw a comp band first, then a salary inside that band.
const Band = Schema.Struct({
  minimum: Schema.Int.check(Schema.isBetween({ minimum: 50_000, maximum: 100_000 })),
  spread: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 50_000 }))
})
const bandAndSalary = Arbitrary.schema(Band).pipe(
  Arbitrary.flatMap((band) =>
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ minimum: band.minimum, maximum: band.minimum + band.spread }))
    ).pipe(Arbitrary.map((salary) => ({ band, salary })))
  )
)

// Wire side. toEncoded keeps only the encoded SHAPE — for FiniteFromString, any string —
// so this is a decoder-fuzzing source, not a supply of valid payloads.
const SalaryWire = Schema.FiniteFromString
const fuzzInputs = Arbitrary.sampleEffect(
  Arbitrary.schema(Schema.toEncoded(SalaryWire)),
  { count: 20, seed: 1 }
)

// Valid payloads come from encoding generated decoded values.
const validPayloads = Arbitrary.sampleEffect(Arbitrary.schema(SalaryWire), { count: 20, seed: 1 }).pipe(
  Effect.flatMap((salaries) =>
    Effect.forEach(salaries, (salary) => Schema.encodeEffect(SalaryWire)(salary))
  )
)

const _ = [grantShares, bandAndSalary, fuzzInputs, validPayloads]
```

- **Reach for a custom `shrink` only when the derived counterexample is not meaningful in the domain.** The callback returns the immediate simplifications of a failing value; every candidate is re-validated against the schema, invalid ones are skipped and still count against `maxShrinks`, and the function must be synchronous, deterministic, terminating, and free of mutation. It replaces derived shrinking rather than refining it: for the property `shares < 1_000` over this schema, the derived shrinker reports the exact boundary `1000`, while the halving shrinker above stops at `1953`.
- **Derivation is eager; discards are lazy.** `Arbitrary.schema` throws at the call site when it cannot build a generator — a bare `Schema.Never`, contradictory bounds such as `isBetween({ minimum: 10, maximum: 5 })`, a declaration without a generatable representation, or a recursive schema with no finite path. A `Never` nested where another finite path exists is treated as an uninhabited branch instead of an error: `Schema.optionalKey(Schema.Never)` leaves the key out, `Schema.Union([Schema.Never, S])` generates `S`, and `Schema.Array(Schema.Never)` generates `[]`. A generator that *can* be built but rejects too many candidates fails later, as `Exhausted` from `checkEffect` or `SampleError` from `sampleEffect`. The first is a schema problem; the second is a filter problem.
- **`size` is local, not global.** Every unconstrained string, collection, and object property observes the same size independently, so a wide struct still produces a large value at a small size; recursive branches share one recursion allowance.

**Sequences of custom values use `Arbitrary.array(item, { minLength?, maxLength? })`.** It shrinks by removing blocks, including prefixes and interior runs, while keeping the order and values of what remains, then shrinks individual elements, which suits command sequences for state-machine properties. Invalid length bounds throw a `RangeError` at the call. This approval-workflow property is falsified with the minimal history `["Reject", "Approve"]`:

```ts
import { Arbitrary, Effect, Schema } from "effect"

const reviewAction = Arbitrary.schema(Schema.Literals(["Approve", "Reject", "Reopen"]))
const reviewHistory = Arbitrary.array(reviewAction, { minLength: 1, maxLength: 20 })

// Property: once a raise is rejected, no later action approves it.
const rejectionSticks = Arbitrary.checkEffect(reviewHistory, (actions) => {
  const rejected = actions.indexOf("Reject")
  return rejected === -1 || !actions.slice(rejected + 1).includes("Approve")
}, { runs: 100, seed: 0 })

const _ = Effect.map(rejectionSticks, (result) => result._tag)
```

### What a derived generator cannot test

A derived arbitrary produces **valid decoded `Type` values**. That makes it the right input for invariants and useless for three other claims, each of which needs hand-written cases:

| Claim | Why generation cannot show it | What to write instead |
| --- | --- | --- |
| Malformed input is rejected with the right issue | every generated value already satisfies the schema | named encoded fixtures: bad brand pattern, impossible timestamp, wrong tag, missing required key |
| An omitted key takes its decoding default | generated values are decoded, so the key is always present | one encoded fixture per default, asserted with [`TestSchema`](#testschema) `.decoding()` |
| A rule spanning several fields holds | the generator only knows what the schema states | put the rule in a schema `check`, or derive dependent values with `Arbitrary.flatMap` as above |

Record the seed and the shrunk counterexample from any failure, then keep that input as a permanent example-based test: a regression example survives an engine upgrade, a replay token might not. The round-trip law worth asserting for a codec, and why `decode(encode(x)) === x` is the wrong one, lives in [Schema — From External Input to Domain and Back](../deep-dives/schema-from-external-input-to-domain-and-back).

Inside `@effect/vitest`, use `it.prop`, `it.effect.prop`, or `it.live.prop`. Inputs may be Schemas, native Arbitraries, or a mix — they are combined with `Arbitrary.all` — and non-passing results become test failures that print the shrunk input and replay token:

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

// Schema-driven property test: any computed raise stays within the comp band.
// CompBand: min 80 000, max 200 000. Raise capped at 15%.
const SalarySchema = Schema.Finite.check(Schema.isBetween({ minimum: 80_000, maximum: 200_000 }))
const RaisePctSchema = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.15 }))

it.effect.prop(
  "computed raise always lands within the CompBand",
  [SalarySchema, RaisePctSchema],
  ([currentSalary, raisePct]) =>
    Effect.gen(function*() {
      const newSalary = currentSalary * (1 + raisePct)
      assert.isTrue(newSalary >= 80_000, "below band minimum")
      assert.isTrue(newSalary <= 200_000 * 1.15, "above band maximum with raise")
    }),
  // Native check options live under `arbitrary` (formerly `fastCheck: { numRuns }`).
  { arbitrary: { runs: 500, seed: 42 } }
)

// Named-key variant — destructure from an object record.
it.effect.prop(
  "merit increase preserves ordering: higher rating yields higher raise",
  { base: Schema.Finite.check(Schema.isBetween({ minimum: 50_000, maximum: 150_000 })) },
  ({ base }) =>
    Effect.gen(function*() {
      const meetsRaise = base * 1.03
      const exceedsRaise = base * 1.07
      assert.isTrue(exceedsRaise > meetsRaise)
    })
)
```

`prop` accepts either an array of schemas/arbitraries (positional) or an object record (named destructuring). Prefer a constructive check such as `Schema.isBetween` over an opaque `Schema.makeFilter` predicate for generated domains: an opaque filter works, but only as a bounded residual filter that can exhaust its discard budget.

> **Migrating from the fast-check bridge:** replace `Schema.toArbitrary(schema)(FastCheck)` with `Arbitrary.schema(schema)`; `FastCheck.sample` with `Arbitrary.sampleEffect` (`numRuns` → `count`); `FastCheck.assert(FastCheck.property(...))` with `Arbitrary.checkEffect` and handle the result (`numRuns` → `runs`, `path` → `replay`, `maxSkipsPerRun` → `maxDiscards`, `endOnFailure` → `maxShrinks: 0`); and `{ fastCheck: { numRuns } }` with `{ arbitrary: { runs } }`. Raw fast-check arbitraries are no longer accepted by `@effect/vitest`. Seeds, distributions, and shrink results are not compatible, so re-record any saved failure. If a test truly needs fast-check, install it yourself and use it directly with Vitest. Effect's release-matched [Arbitrary guide](https://github.com/Effect-TS/effect/blob/effect%404.0.2/packages/effect/ARBITRARY.md) goes deeper.

Use when testing pure transformations, codecs, data-structure invariants, or any function where the claim is "this holds for all valid inputs."

Official guide: [Schema to Arbitrary](https://effect.website/docs/v4/schema/arbitrary) (its `checkEffect` option list is shorter than this module's, which also accepts `size`, `maxDiscards`, and `maxShrinks`).

## TestSchema

`effect/testing/TestSchema` — unstable

A class-based helper wrapping a `Schema` with ergonomic methods for asserting decoding, encoding, construction (`make`), and property-based round-trip verification.

**Mental model.** Create `new TestSchema.Asserts(MySchema)` as your test handle. It exposes `.decoding()`, `.encoding()`, and `.make()` — each returning an object with `succeed(input, expected?)` / `fail(input, message)` Promise methods, plus `succeedEffect` / `failEffect` Effect-returning variants that preserve required decoding or encoding services — all comparing with `assert.deepStrictEqual` internally. `.arbitrary()` returns generation-check helpers. `verifyRoundTrip()` (and its Effect variant `verifyRoundTripEffect()`) runs a full property-based round-trip.

```ts
import { Schema } from "effect"
import { TestSchema } from "effect/testing"

// A comp-band salary value: positive number branded as Salary.
const Salary = Schema.Finite.pipe(
  Schema.check(Schema.makeFilter((n: number) => n > 0 ? undefined : "salary must be positive")),
  Schema.brand("Salary")
)

// --- decoding a PerformanceRating from a raw string ---
const PerformanceRating = Schema.Literals(["exceeds", "meets", "below"])

const dec = new TestSchema.Asserts(PerformanceRating).decoding()
await dec.succeed("exceeds", "exceeds")
await dec.succeed("meets")            // identity when expected equals input
await dec.fail(42, 'Expected "exceeds" | "meets" | "below", got 42')

// --- encoding a NumberFromString salary representation ---
const SalaryFromString = Schema.FiniteFromString
const enc = new TestSchema.Asserts(SalaryFromString).encoding()
await enc.succeed(95000, "95000")

// --- round-trip property test: encode → decode is lossless ---
const ta = new TestSchema.Asserts(SalaryFromString)
await ta.verifyRoundTrip()

// --- arbitrary generation sanity check ---
new TestSchema.Asserts(PerformanceRating).arbitrary().verifyGeneration()
// asserts Schema.is(PerformanceRating) for every natively generated value;
// both verifiers accept Arbitrary.CheckOptions, e.g. { seed: 1, runs: 20 }
```

When the schema's decoder requires a service, pass a `Context.Key` and its implementation to `.decoding().provide(key, impl)` to inject the service into the decoding context before running assertions.

The static `TestSchema.Asserts.ast.fields.equals(a, b)` and `TestSchema.Asserts.ast.elements.equals(a, b)` compare the *ASTs* of two struct-field records or two tuple-element lists with `deepStrictEqual`. Use them to prove that a schema-building helper — a field mapper, a `pick`/`omit` wrapper, a generated model — yields the same definition as the hand-written schema. The field comparison walks every own key, including symbol and non-enumerable keys, and compares by AST rather than by schema instance: two separately constructed but equivalent field schemas are equal, while differing ASTs or distinct symbol keys are not.

**Keep named encoded fixtures beside the generated checks.** `verifyRoundTrip()` and `arbitrary()` start from valid decoded values; a `.decoding().fail(...)` case per rejection rule is what proves the decoder says no.

Use when authoring a new schema to pin down exactly what inputs decode or encode to — especially useful for custom transformations and branded types.

## @effect/vitest

`@effect/vitest` — package

The official Effect test runner adapter for Vitest. It requires Vitest 5 (`>=5.0.0 <6.0.0`), wraps Vitest's `it` with Effect-aware variants that handle fibers, provides the test environment (TestClock + TestConsole), cleans up scopes, and surfaces failures with pretty-printed `Cause` traces. It re-exports everything from `vitest`.

**Mental model.** A thin Layer between Vitest and Effect tests. Key additions:

- `it.effect` — runs an Effect, provides TestClock + TestConsole, opens a fresh Scope per test.
- `it.live` — same but uses real runtime services (no TestClock substitution).
- `it.prop` / `it.effect.prop` / `it.live.prop` — property-based tests driven by the native [`Arbitrary`](#arbitrary) runner; inputs are Schemas, native Arbitraries, or a mix, with check options under `{ arbitrary: { runs, seed, … } }`.
- `layer(L)` — builds a layer once for a block of tests, sharing state across them, tears down in `afterAll`.
- `assert` — Vitest's Chai-style `assert`, re-exported with the rest of `vitest` (`assert.strictEqual`, `assert.deepStrictEqual`, `assert.isTrue`, …); repo convention prefers this over Vitest's `expect`.
- `@effect/vitest/utils` — structural helpers built on Node's `assert` and Effect's `Equal`: `assertEquals` (`Equal.equals` with a diff), `assertSome` / `assertNone`, `assertSuccess` / `assertFailure` for `Result`, and `assertExitSuccess` / `assertExitFailure(exit, cause)` for `Exit`.
- `makeMethods(it)` — rebuilds `it.effect` / `it.live` / `it.prop` / `layer` on top of a Vitest test API extended with fixtures, so fixture values flow into Effect tests too.
- Everything else Vitest exports, including `expectTypeOf` for [type-level contract tests](#prove-laziness-and-the-static-contract).

**Vitest fixtures work with Effect tests via `makeMethods`.** A test receives the fixtures it destructures from its context; Vitest sets them up before the test and tears them down after the test's scope closes:

```ts
import { assert, makeMethods, test } from "@effect/vitest"
import { Effect } from "effect"

const it = makeMethods(
  test.extend("config", { scope: "file" }, () => ({ port: 3000 }))
)

it.effect("reads the config fixture", ({ config }) =>
  Effect.sync(() => {
    assert.strictEqual(config.port, 3000)
  }))
```

Vitest parses the destructured parameter names to decide which fixtures to set up, so a test that takes the whole context as one plain parameter (`(ctx) => ...`) once any fixture is defined fails with a `FixtureParseError` — destructure the fixture names instead. Property tests (`it.prop`, `it.effect.prop`) receive only the base test context and cannot request fixtures, though auto fixtures still run. `it.effect.each` passes the fixture-bearing context after the test case; named and anonymous `it.layer` blocks keep the fixtures too.

Runner behavior that affects what a result means:

| Behavior | Detail |
| --- | --- |
| **A failing test logs before it throws.** | Each entry of `Cause.prettyErrors` is written with `Effect.logError`, then the `Exit` is rethrown to Vitest. Treat that text as a diagnostic, never as an assertion target. |
| **A Vitest timeout interrupts the fiber.** | The test's abort signal is passed to the runner, so the Effect is interrupted, its finalizers run, and the runner waits for them before the test finishes. A synchronous callback that never returns cannot be preempted. |
| **`it.effect` and `it.live` both open a `Scope` per test.** | Scoped acquisitions made in the body are released when the test ends; wrapping the body in another `Effect.scoped` changes the lifetime under test. |
| **Returning an Effect from plain `it(...)` runs nothing.** | Vitest receives an object that is not a promise and reports the test green — even for `Effect.fail`. Always use `it.effect`; the [`floatingEffectInVitest`](#effect-language-service-effect-tsgo) diagnostic catches the slip. |

Tester modifiers (`it.effect.*` and `it.live.*`):

| Modifier | Use | Watch for |
| --- | --- | --- |
| `.each(cases)` | one body per case; the case is the first argument, the test context (and any fixtures) is the second | — |
| `.only`, `.skip` | focus or park a test locally | never commit `.only` |
| `.skipIf(condition)`, `.runIf(condition)` | gate on an environment fact | a silently skipped lane is reported green with zero evidence; make required infrastructure fail loudly instead |
| `.fails` | passes only when the Effect fails | asserts *that* it fails, not *how*; prefer an `Exit` assertion |
| `it.flakyTest(effect, timeout?)` | reruns a scoped Effect up to 10 more times within `timeout` (default 30 seconds), retrying on any failure including a defect, then dies | it hides nondeterminism instead of removing it; acceptable only for genuine external eventual consistency |

### Basic test shapes

```ts
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

describe("comp-service: it.effect basics", () => {
  // Runs as an Effect. TestClock and TestConsole are provided automatically.
  it.effect("normalises employee names to title case", () =>
    Effect.gen(function*() {
      const names = ["ada lovelace", "grace hopper"].map((s) =>
        s.replace(/\b\w/g, (c) => c.toUpperCase())
      )
      assert.deepStrictEqual(names, ["Ada Lovelace", "Grace Hopper"])
    }))

  // Parameterized: it.effect.each accepts an array of cases.
  it.effect.each([
    { rating: "exceeds", multiplier: 1.07 },
    { rating: "meets",   multiplier: 1.03 },
    { rating: "below",   multiplier: 1.00 }
  ])("merit multiplier for rating %#", ({ rating, multiplier }) =>
    Effect.gen(function*() {
      const raise = (base: number) => base * multiplier
      assert.strictEqual(raise(100_000), 100_000 * multiplier)
    }))

  // it.live — uses real clock; useful for smoke-testing actual I/O timing.
  it.live("passes a minimal real-time smoke test", () =>
    Effect.gen(function*() {
      yield* Effect.sleep(1) // 1 ms of real sleep
      assert.isTrue(true)
    }))

  // Time-based test — TestClock is already active inside it.effect.
  it.effect("fast-forwards a vesting cliff without real waiting", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        Effect.sleep("365 days").pipe(Effect.as("cliff-reached"))
      )
      yield* TestClock.adjust("365 days")
      assert.strictEqual(yield* Fiber.join(fiber), "cliff-reached")
    }))
})
```

### Prove laziness and the static contract

Two properties are specific to Effect code and cheap to pin: building a program starts nothing, and its `E` and `R` are exactly what the contract says. Value-based tests pass whether or not either holds.

```ts
import { assert, expectTypeOf, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"

class BandViolation extends Schema.TaggedError<BandViolation>()("BandViolation", {
  employeeId: Schema.String
}) {}

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {}) {}

class Hris extends Context.Service<Hris, {
  readonly salaryOf: (employeeId: string) => Effect.Effect<number, HrisUnavailable>
}>()("app/Hris") {}

const proposeRaise = Effect.fn("proposeRaise")(function*(employeeId: string, amount: number) {
  const hris = yield* Hris
  const salary = yield* hris.salaryOf(employeeId)
  if (amount > salary * 0.15) return yield* new BandViolation({ employeeId })
  return salary + amount
})

// 1. Construction is inert: describing the program must not touch the dependency.
it.effect("building a raise proposal performs no lookup", () =>
  Effect.gen(function*() {
    let lookups = 0
    const spy = Hris.of({
      salaryOf: () =>
        Effect.sync(() => {
          lookups++
          return 100_000
        })
    })

    const program = proposeRaise("emp-42", 5_000).pipe(Effect.provideService(Hris, spy))
    assert.strictEqual(lookups, 0) // described, not started

    assert.strictEqual(yield* program, 105_000)
    assert.strictEqual(lookups, 1) // one run, one lookup
  }))

// 2. Static contract: recovery removes ONLY the variant it names, and R is still open.
const withFallback = proposeRaise("emp-42", 5_000).pipe(
  Effect.catchTag("HrisUnavailable", () => Effect.succeed(0))
)

it("proposeRaise keeps its static contract", () => {
  expectTypeOf<Effect.Success<typeof withFallback>>().toEqualTypeOf<number>()
  expectTypeOf<Effect.Error<typeof withFallback>>().toEqualTypeOf<BandViolation>()
  expectTypeOf<Effect.Services<typeof withFallback>>().toEqualTypeOf<Hris>()
})

// 3. A negative proof documents a guard rail. Keep it inside a function nobody calls.
export const notRunnableYet = () =>
  // @ts-expect-error Hris has not been provided, so the runner must reject the program
  // @effect-diagnostics-next-line missingEffectContext:off
  Effect.runPromise(withFallback)
```

- **Add the inertness test to every adapter around legacy code.** An adapter that calls the Promise-returning function while *building* the Effect, or a constructor that hides a runner, returns correct values and still starts work too early; only the `0`-then-`1` counter sees it.
- **Type assertions are checked by the compiler, not by the runner.** Vitest strips types, so `expectTypeOf` and `@ts-expect-error` prove something only when the test files belong to a project that CI type-checks (`tsc --noEmit`, or Vitest's typecheck mode). `Effect.Success`, `Effect.Error`, and `Effect.Services` extract the three channels.
- **A negative proof needs both suppressions when the language service is on.** TypeScript and the [`missingEffectContext`](#effect-language-service-effect-tsgo) rule each report the unprovided service. `@ts-expect-error` must come first and the `@effect-diagnostics-next-line` directive must sit directly above the offending line; in the other order the directive is reported as having no effect.
- **Assert the inferred type, not an annotated one.** An explicit annotation such as `const p: Effect.Effect<number, BandViolation, Hris> = …` rejects a *wider* inferred type but silently accepts a narrower one, and a type test written against an annotated value only tests the annotation. Use `toEqualTypeOf` on the un-annotated expression when exactness matters — for example to show that `catchTag` was used where a broad `Effect.catch` would also compile.

### Sharing a layer across tests

Use the top-level `layer(L)` export (or `it.layer(L)` for nesting) to build a service once and share it across an entire block. Appropriate for integration tests against stateful services where re-initialization per test would be expensive.

```ts
import { assert, it, layer } from "@effect/vitest"
import { Array, Context, Effect, Layer, Ref } from "effect"

interface RaiseRecord { readonly employeeId: string; readonly amount: number }

class MeritCycle extends Context.Service<MeritCycle, { cycleYear: number }>()("MeritCycle") {}

// A minimal in-memory raise-log service for integration tests.
class RaiseLog extends Context.Service<RaiseLog, {
  record(employeeId: string, amount: number): Effect.Effect<RaiseRecord>
  readonly entries: Effect.Effect<ReadonlyArray<RaiseRecord>>
}>()("comp/RaiseLog") {
  static readonly layerTest = Layer.effect(
    RaiseLog,
    Effect.gen(function*() {
      const store = yield* Ref.make(Array.empty<RaiseRecord>())
      return RaiseLog.of({
        record: Effect.fn("RaiseLog.record")(function*(employeeId, amount) {
          const entry: RaiseRecord = { employeeId, amount }
          yield* Ref.update(store, (xs) => [...xs, entry])
          return entry
        }),
        entries: Ref.get(store)
      })
    })
  )
}

// One layer instance shared across all tests — torn down in afterAll.
layer(RaiseLog.layerTest)("RaiseLog", (it) => {
  it.effect("starts with an empty audit log", () =>
    Effect.gen(function*() {
      const log = yield* RaiseLog
      assert.deepStrictEqual(yield* log.entries, [])
    }))

  it.effect("records a raise and accumulates across tests (shared state)", () =>
    Effect.gen(function*() {
      const log = yield* RaiseLog
      yield* log.record("E42", 4_200)
      const entries = yield* log.entries
      assert.strictEqual(entries.length, 1)
      const first = entries[0]
      assert.isDefined(first)
      assert.strictEqual(first.employeeId, "E42")
    }))

  // Nest a second layer that depends on the outer one.
  it.layer(
    Layer.effect(MeritCycle, Effect.succeed({ cycleYear: 2025 }))
  )("nested merit-cycle layer", (it) => {
    it.effect("has access to both the raise log and the cycle context", () =>
      Effect.gen(function*() {
        const log = yield* RaiseLog
        assert.isDefined(log.record)
      }))
  })
})
```

> **Warning:** Tests inside a `layer(...)` block see the same service instance and its accumulated state. This is intentional for integration tests but dangerous if isolation is expected. For isolated state per test, provide the layer inside each `it.effect` body with `Effect.provide`, or use a `Ref` reset in `beforeEach`.

`layer(L, options?)` accepts four options:

| Option | Meaning |
| --- | --- |
| `excludeTestServices` | When `true`, `TestClock` and `TestConsole` are **not** merged into the block: the layer is built, and its tests run, on the live clock and the real console. Default `false`. Nested `it.layer(...)` blocks inherit the choice. |
| `timeout` | A `Duration` input applied to the hooks that build and close the layer. Give a real fixture room to start and to shut down. |
| `concurrent` | Named blocks only: overrides the enclosing suite's concurrency. An anonymous `layer(L)((it) => …)` always inherits it. Concurrent tests over one shared Layer need state that tolerates interleaving. |
| `memoMap` | A `Layer.MemoMap` to share already-built layers between separate `layer(...)` blocks. A nested `it.layer(...)` forks the parent's memo map on its own, so outer services are reused, not rebuilt. |

Three consequences follow from how the helper is built:

- **The shared Layer is constructed on the virtual clock.** By default `layer(L)` builds `L` with the test services provided, so a fixture that sleeps, polls for readiness, or applies an `Effect.timeout` while it *acquires* waits on a clock nobody advances, and the block hangs until the hook timeout. A Layer that only allocates in-memory state is unaffected.
- **The `it` handed to the block has no `live` tester.** It offers `effect`, `prop`, `flakyTest`, and `layer`. Choose the clock for the whole block with `excludeTestServices`, or for one effect with `TestClock.withLive`.
- **A Layer that fails to build fails the suite, not the tests.** The construction error is converted with `Effect.orDie` inside the block's setup hook; Vitest then reports one failed suite and marks the block's tests as *skipped*. Read the suite failure — a per-test count alone shows nothing red.

```ts
import { assert, layer } from "@effect/vitest"
import { Context, Effect } from "effect"
import type { Layer } from "effect"

class PayrollDb extends Context.Service<PayrollDb, {
  readonly ping: Effect.Effect<"ok">
}>()("test/PayrollDb") {}

// A real fixture: starts a database, migrates it, and probes readiness with real timeouts.
declare const PayrollDbFixture: Layer.Layer<PayrollDb>

layer(PayrollDbFixture, { excludeTestServices: true, timeout: "60 seconds" })(
  "PayrollDb adapter against a real database",
  (it) => {
    it.effect("answers a probe within five real seconds", () =>
      Effect.gen(function*() {
        const db = yield* PayrollDb
        // No TestClock in this block: the timeout below is wall-clock time.
        assert.strictEqual(yield* db.ping.pipe(Effect.timeout("5 seconds")), "ok")
      }))
  }
)
```

| Situation | Clock choice |
| --- | --- |
| Application delays, retries, TTLs, schedules | default `it.effect` / `layer(L)` and `TestClock.adjust` |
| A real driver, server, or container inside the shared Layer | `layer(L, { excludeTestServices: true })` |
| One wall-clock wait inside an otherwise virtual test | `TestClock.withLive(effect)` |
| A single smoke test of real runtime services | `it.live` |

### Property-based tests with `it.effect.prop`

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

// Schemas are converted to native Arbitraries automatically. Constructive checks
// such as isBetween generate in-range values directly instead of discarding.
// Property: applying a non-negative raise never decreases the salary.
it.effect.prop(
  "applying a merit raise never decreases the salary",
  [
    Schema.Finite.check(Schema.isBetween({ minimum: 50_000, maximum: 250_000 })),
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.20 }))
  ],
  ([baseSalary, raisePct]) =>
    Effect.gen(function*() {
      const newSalary = baseSalary * (1 + raisePct)
      assert.isTrue(newSalary >= baseSalary)
    })
)

// Named-key variant — destructure from an object record.
it.effect.prop(
  "bonus calculation is commutative across rating and base",
  {
    base:   Schema.Finite.check(Schema.isBetween({ minimum: 0, exclusiveMinimum: true, maximum: 200_000 })),
    factor: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
  },
  ({ base, factor }) =>
    Effect.gen(function*() {
      assert.strictEqual(base * factor, factor * base)
    })
)
```

Use for all Effect tests. Start with `it.effect`, graduate to `layer(...)` when integration state needs sharing, and use `it.effect.prop` whenever the claim is "this holds for all inputs."

### In-memory test runtimes shipped with Effect

Several modules ship their own test harness. Each removes one piece of infrastructure and keeps the rest of the pipeline real, which defines exactly what a green result covers.

| Harness | Keeps real | Replaces | Does not prove |
| --- | --- | --- | --- |
| [`HttpApiTest.groups`](../interfaces/http-api#httpapitest) (unstable) | request encoding, routing, middleware, response encoding, client decoding | the HTTP server and socket | that a server binds a port, negotiates TLS, or releases the port on shutdown |
| [`RpcTest.makeClient`](../interfaces/rpc#rpctest) (unstable) | client and server protocol machinery: streams, acknowledgements, interrupts, headers, middleware | transport **and serialization** | that payloads survive a real codec and wire |
| `NodeHttpServer.layerTest` | a real HTTP server on an ephemeral port plus a client pointed at it | the fixed address | deployment concerns: proxies, TLS, production configuration |
| [`TestRunner.layer`](../systems/cluster-sharding#testrunner) (unstable) | sharding, entity registration, mailbox persistence logic | storage (in-memory), runner transport (no-op), health checks | multi-runner rebalancing, durable storage behavior |
| [`Entity.makeTestClient`](../systems/cluster-sharding#entity) (unstable) | one entity's handlers behind an in-memory RPC client | the cluster transport | routing across runners. It honors the entity layer's `disableFatalDefects` option: with that option set, a handler defect fails only its own call instead of every pending call on the client |
| `WorkflowEngine.layerMemory`, `Persistence.layerMemory`, `KeyValueStore.layerMemory`, `EventJournal.layerMemory` (unstable) | the orchestration or storage *contract* | the durable backend | durability across a restart, backend-specific limits |
| `ConfigProvider.fromUnknown(...)` via `ConfigProvider.layer` | `Config` parsing, defaults, redaction | environment variables | that the deployed environment sets those names |

**Classify a test by the boundary it crosses, not by the technology it mentions.** Calling an `HttpApi` handler through `HttpApiTest` is a service test even though it says "HTTP"; an in-memory `KeyValueStore` test says nothing about Redis.

## Effect language service (@effect/tsgo)

`@effect/tsgo` — external package ([Effect-TS/tsgo](https://github.com/Effect-TS/tsgo)), versioned separately from `effect`; this handbook validates with `0.47.2`

A build of TypeScript-Go with the Effect language service embedded. It reports Effect-specific mistakes — a floating Effect, an unprovided requirement, error handling on an Effect that cannot fail, two copies of `effect` in one program — as diagnostics, and offers quick fixes and refactors for them. The same rules run in the editor, in `tsc`, and in a dedicated CLI, which is what makes them usable in CI and by coding agents: the feedback arrives before any test runs.

**Mental model.** The rules live in the compiler, not in a lint plugin bolted on afterwards. You register one `tsconfig.json` plugin entry (its name is `@effect/language-service`, for every front end), and then choose where the diagnostics surface.

```sh
# Guided setup: adds the dependency, the tsconfig plugin entry, and editor hints
npx @effect/tsgo setup
# Non-interactive flags, for scripts and coding agents
npx @effect/tsgo setup --help
```

`@effect/tsgo` needs a native TypeScript 7 install beside it (`typescript` 7, or an alias such as `@typescript/native`). The plugin entry looks like this — the three `tsc` options are the ones this handbook's validation project sets, and `diagnosticSeverity` is the per-rule knob:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@effect/language-service",
        "includeSuggestionsInTsc": true,
        "ignoreEffectWarningsInTscExitCode": false,
        "ignoreEffectErrorsInTscExitCode": false,
        "diagnosticSeverity": { "floatingEffect": "error" }
      }
    ]
  }
}
```

| Surface | How | Notes |
| --- | --- | --- |
| Editor | make the editor use `effect-tsgo` as its TypeScript language server | **Use it instead of plain `tsgo`, not beside it** — two servers duplicate diagnostics and slow the editor. Adds quick fixes, hovers, and refactors such as `asyncAwaitToGen` and `layerMagic`. |
| `tsc` | `effect-tsgo patch`, usually from a `prepare` script | Patches the installed native TypeScript so ordinary `tsc` runs emit Effect diagnostics as TypeScript diagnostics. An **unpatched** `tsc` stays silent about them. Exit-code impact is set by `ignoreEffectSuggestionsInTscExitCode` (default `true`), `ignoreEffectWarningsInTscExitCode` (`false`), and `ignoreEffectErrorsInTscExitCode` (`false`). |
| Dedicated CLI | `effect-tsgo diagnostics --project tsconfig.json --strict --format text` | Needs no patch. `--strict` treats warnings as errors; `--format` is `json`, `pretty`, `text`, or `github-actions`; `--file` checks one file. This is the command that validates every example in this handbook. |
| Oxlint | `effect-tsgo patch --oxlint` | Experimental type-aware lint integration; presets ship under `@effect/tsgo/oxlint-presets` (`recommended`, `correctness`, `antipattern`, `effect-native`, `style`). The official Devtools guide covers this and the VS Code / Cursor extension. |

The rules fall into four groups (`0.47.2` ships 118: 23 correctness, 20 anti-pattern, 22 Effect-native, 53 style), and **many are not errors until you raise them** — most style and Effect-native rules default to `suggestion` or `off`, and `effect-tsgo config` shows every rule's current level. The ones below map directly onto failures described elsewhere in this handbook:

| Group | Examples (default severity) | What it catches |
| --- | --- | --- |
| Correctness | `floatingEffect`, `floatingEffectInVitest`, `missingEffectContext`, `missingEffectError`, `missingLayerContext`, `missingStarInYieldEffectGen` (all `error`); `duplicatePackage`, `outdatedApi` (`warning`); `unsafeEffectTypeAssertion` (`off`) | an Effect that is built and dropped; a plain Vitest callback returning an Effect that never runs; leftover `R` or `E` at a boundary; `yield` without `*`; two Effect versions in one program; an API that no longer exists; a cast that narrows `E` or `R` |
| Anti-pattern | `multipleEffectProvide`, `layerMergeAllWithDependencies`, `globalErrorInEffectFailure` (`warning`); `catchUnfailableEffect`, `runEffectInsideEffect`, `tryCatchInEffectGen`, `leakingRequirements` (`suggestion`) | chained `Effect.provide`; interdependent layers passed to `Layer.mergeAll`; the global `Error` in `E`; recovery that can never run; an interior runner; `try`/`catch` around `yield*`; an implementation service leaking through a service method |
| Effect-native | `globalDateInEffect`, `globalTimersInEffect`, `globalRandomInEffect`, `globalFetchInEffect`, `processEnvInEffect`, `globalConsoleInEffect` (all `off`) | ambient `Date.now()`, `setTimeout`, `Math.random()`, `fetch`, `process.env`, and `console` inside Effect code — exactly the dependencies `TestClock`, `Random`, `HttpClient`, `Config`, and `TestConsole` exist to control. Turn these on for application code that must be deterministic under test. |
| Style | `unnecessaryEffectGen`, `catchAllToMapError`, `effectFnOpportunity`, `schemaStructWithTag` (`suggestion`) | simplifications with a mechanical fix |

Severity is per rule: `diagnosticSeverity` maps a rule name to `"off"`, `"suggestion"`, `"message"`, `"warning"`, or `"error"`; `overrides` applies different levels to file globs; and an `@effect-diagnostics` or `@effect-diagnostics-next-line` comment adjusts one file or one line. `effect-tsgo config` opens an interactive rule picker for an existing `tsconfig.json`. One rule deserves a project-level decision up front: `unstableApiUsage` warns on every API tagged `@stability unstable`, which in `4.0.2` is every call into `effect/http`, `effect/sql`, `effect/rpc`, `effect/ai`, and the other area families. A project that builds on those modules sets `"diagnosticSeverity": { "unstableApiUsage": "off" }` (this handbook's validation does exactly that); a library that wants to stay inside the semver-covered surface leaves it on.

- **Run the diagnostics on test code too.** `floatingEffectInVitest` is the static counterpart of the false green described under [`@effect/vitest`](#effect-vitest): `it("…", () => Effect.fail("boom"))` passes at runtime and fails this check.
- **Pin it like any other toolchain dependency.** Each release is built against specific TypeScript (and Oxlint) versions listed in its README; upgrade it together with TypeScript rather than independently.
- **Link out for option tables.** The tool evolves faster than `effect` itself; the complete rule list and option reference live in its repository README, and [Getting Started](../foundations/getting-started) covers the project setup around it.

Use when you want the mistakes in [Troubleshooting & Anti-Patterns](../troubleshooting/troubleshooting-and-anti-patterns) reported by the compiler instead of discovered in review.

**Development tooling.** The `packages/tools/` directory mixes public documentation/code-generation packages with private utilities used to maintain the Effect monorepo. The public tools in the audited release are `@effect/openapi-generator`, `@effect/docgen`, and `@effect/doctest`; the rest of the list below is repository-internal.

## @effect/docgen

`@effect/docgen` — package

An opinionated Node 18+ documentation generator for Effect-style TypeScript libraries. The `docgen` CLI reads source modules and JSDoc, enforces configurable description/example/`@since` policies, typechecks and runs `@example` blocks, and emits Markdown/site material. It is zero-config by default (`src` → `docs`) or configured with `docgen.json` and its bundled `schema.json`.

```json
{
  "$schema": "node_modules/@effect/docgen/schema.json",
  "srcDir": "src",
  "outDir": "docs",
  "exclude": ["src/internal/**/*.ts"],
  "enforceDescriptions": true,
  "enforceExamples": true,
  "enforceVersion": true
}
```

Install with `pnpm add -D @effect/docgen` and run `docgen`. Supported documentation controls include `@category`, `@example`, `@since`, `@deprecated`, `@internal`, and `@ignore`; parser/example compiler options can point at strict project configs.

## @effect/doctest

`@effect/doctest` — package

A Vitest/Vite integration that extracts marked TypeScript examples from JSDoc, Markdown, and MDX and runs every fence as an isolated test module. Mark a fence `ts import.meta.vitest`; an optional `name="..."` labels it. Trailing `// => expectedExpression` assertions use Effect's `Equal.equals` semantics.

<!-- effect-example id=tooling.doctest.run check=run runtime=doctest -->
```ts import.meta.vitest name="runs Effect values explicitly"
import { Effect } from "effect"

Effect.runSync(Effect.succeed(42)) // => 42
```

```ts
import * as Doctest from "@effect/doctest/Plugin"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [Doctest.plugin()],
  test: {
    include: ["test/**/*.test.ts"],
    includeSource: ["src/**/*.ts", "docs/**/*.{md,mdx}"]
  }
})
```

The assertion transform handles a complete expression statement or a single initialized `const`; it does not implicitly await promises, run Effects, or consume iterators. Do those operations explicitly. `@effect/doctest` requires Vitest 5 and Vite 8.1.5+.

**Other repository tools.**

- **@effect/openapi-generator** — Public tool. Given an OpenAPI spec file, generates Effect Schema type definitions, typed HTTP clients, or full `HttpApi` module skeletons. CLI: `openapigen --spec api.yaml`. Accepts JSON Patch files to pre-process the spec before generation; reports warnings to stderr. Output goes to stdout.

- **@effect/ai-codegen** — Code-generation framework used internally to produce AI provider bindings (OpenAI, Anthropic, etc.) inside `packages/ai`. Wraps `@effect/openapi-generator` with provider-specific discovery, patching, and post-processing. Not intended for external use. CLI: `effect-ai-codegen`.

- **@effect/ai-docgen** — Repository-internal compiler that combines the authored, ordered `ai-docs/src` directory tree into the aggregate `LLMS.md` document. It reads each directory's `index.md`, extracts title/description metadata from numbered TypeScript examples, skips fixtures, recurses into topic folders, and supports watch mode. CLI: `effect-ai-docgen ai-docs/src -o LLMS.md`.

- **@effect/jsdocs** — JSDoc extraction and analysis toolkit. Parses Effect source files with the TypeScript compiler, validates JSDoc blocks against Effect house style (required tags, example shape, `@since`, etc.), emits structured `JSDocResult` objects. Used by CI to enforce documentation quality. CLI: `effect-jsdocs`.

- **@effect/bundle** — Bundle-size testing infrastructure. Provides CLI commands for building fixture packages with Rollup, measuring tree-shaken output sizes, and comparing against a reporter. Prevents accidental bundle size regressions when publishing new Effect versions. CLI: `effect-bundle`.

> **Takeaway:** Application tests usually start with `@effect/vitest` and the test services. Library authors add `@effect/docgen` and `@effect/doctest` when examples are part of the contract; the OpenAPI, AI, JSDoc, and bundle tools are specialized repository and code-generation infrastructure.
