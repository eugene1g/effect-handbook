# Testing & Dev Tooling

Effect's test services make time, console output, randomness, and dependencies deterministic; `@effect/vitest` integrates those services with a test runner. The repository's documentation tools then compile and validate examples so docs can be treated like code rather than inert prose.

> **Official companions:** Browse the release-matched authored [AI documentation source](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src) for executable examples across Effect. [`LLMS.md`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/LLMS.md) is its generated single-file aggregate and begins with Effect's coding conventions.

## TestClock

`effect/testing/TestClock` — stable

A virtual clock that replaces the real clock inside Effect. `TestClock.adjust("1 hour")` fast-forwards time: every fiber sleeping until that point wakes immediately in scheduled order. Tests that would take minutes in wall time complete in milliseconds.

**Mental model.** Every fiber calling `Effect.sleep` (or anything built on it: schedules, retries with backoff, timeouts) suspends and queues itself against a virtual timestamp. `TestClock.adjust` / `TestClock.setTime` advances the timeline; all fibers scheduled before the new mark run in order. The live clock is entirely absent.

> **Tip:** Because a sleeping fiber semantically blocks, you must fork the work first, then advance the clock, then join. Advancing after joining a sleeping fiber will deadlock.

Key APIs: TestClock.adjust(duration), TestClock.setTime(timestamp), TestClock.withLive(effect), TestClock.layer(options?), TestClock.make(options?)

`@effect/vitest` automatically provides `TestClock.layer()` (plus `TestConsole.layer`) inside every `it.effect` block. Use `it.live` for the real clock.

```ts
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Ref, Schedule } from "effect"
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
      assert.isTrue(true) // deadline-crossing assertions would follow
    }))
})
```

Use when code under test touches `Effect.sleep`, `Effect.timeout`, schedules, retry delays, or rate limiters.

## TestConsole

`effect/testing/TestConsole` — stable

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

Use when Effect code emits structured diagnostics via `Console.*` and you want to assert on output without parsing stdout or suppressing CI noise.

## FastCheck

`effect/testing/FastCheck` — stable

A direct re-export of the `fast-check` property-based testing library. Provides the entire fast-check API — arbitraries, shrinking, replay — without a separate dependency. Used internally by Effect to test schemas and algorithms.

**Mental model.** Describe input shape with arbitraries; write a property that should hold for all of them. fast-check generates hundreds of random samples and shrinks any violation to the smallest failing case.

```ts
import { FastCheck } from "effect/testing"

// Describe a raise recommendation shape.
const raiseArb = FastCheck.record({
  employeeId: FastCheck.string({ minLength: 1, maxLength: 10 }),
  currentSalary: FastCheck.float({ min: 50_000, max: 300_000, noNaN: true }),
  raisePercent: FastCheck.float({ min: 0, max: 0.15, noNaN: true })
})

// Property: the post-raise salary always equals the expected arithmetic.
FastCheck.assert(
  FastCheck.property(raiseArb, ({ currentSalary, raisePercent }) => {
    const newSalary = currentSalary * (1 + raisePercent)
    return newSalary >= currentSalary && newSalary <= currentSalary * 1.15 + 1
  })
)
```

Inside `it.effect` tests via `@effect/vitest`, use `it.effect.prop` to run property-based tests as Effects. Supply raw `FastCheck.Arbitrary` values or `Schema` objects directly — the framework converts schemas to arbitraries automatically:

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

// Schema-driven property test: any computed raise stays within the comp band.
// CompBand: min 80 000, max 200 000. Raise capped at 15%.
const SalarySchema = Schema.Finite.pipe(
  Schema.check(Schema.makeFilter((n: number) => n >= 80_000 && n <= 200_000 ? undefined : "outside comp band"))
)
const RaisePctSchema = Schema.Finite.pipe(
  Schema.check(Schema.makeFilter((n: number) => n >= 0 && n <= 0.15 ? undefined : "raise out of range"))
)

it.effect.prop(
  "computed raise always lands within the CompBand",
  [SalarySchema, RaisePctSchema],
  ([currentSalary, raisePct]) =>
    Effect.gen(function*() {
      const newSalary = currentSalary * (1 + raisePct)
      assert.isTrue(newSalary >= 80_000, "below band minimum")
      assert.isTrue(newSalary <= 200_000 * 1.15, "above band maximum with raise")
    })
)

// Named-key variant — destructure from an object record.
it.effect.prop(
  "merit increase preserves ordering: higher rating yields higher raise",
  { base: Schema.Finite.pipe(Schema.check(Schema.makeFilter((n: number) => n >= 50_000 && n <= 150_000 ? undefined : "outside comp band"))) },
  ({ base }) =>
    Effect.gen(function*() {
      const meetsRaise = base * 1.03
      const exceedsRaise = base * 1.07
      assert.isTrue(exceedsRaise > meetsRaise)
    })
)
```

`prop` accepts either an array of arbitraries/schemas (positional) or an object record (named destructuring). Pass `{ fastCheck: { numRuns: 500 } }` as the timeout parameter to control run count.

Use when testing pure transformations, codecs, data-structure invariants, or any function where the claim is "this holds for all valid inputs."

## TestSchema

`effect/testing/TestSchema` — stable

A class-based helper wrapping a `Schema` with ergonomic methods for asserting decoding, encoding, construction (`make`), and property-based round-trip verification.

**Mental model.** Create `new TestSchema.Asserts(MySchema)` as your test handle. It exposes `.decoding()`, `.encoding()`, `.make()`, and `.arbitrary()` — each returning an object with `succeed(input, expected?)` and `fail(input, message)` methods that are `async` and use `assert.deepStrictEqual` internally. `verifyLosslessTransformation()` runs a full property-based round-trip.

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
await ta.verifyLosslessTransformation()

// --- arbitrary generation sanity check ---
new TestSchema.Asserts(PerformanceRating).arbitrary().verifyGeneration()
// asserts Schema.is(PerformanceRating) for every fast-check-generated value
```

When the schema's decoder requires a service, pass a `Context.Key` and its implementation to `.decoding().provide(key, impl)` to inject the service into the decoding context before running assertions.

Use when authoring a new schema to pin down exactly what inputs decode or encode to — especially useful for custom transformations and branded types.

## @effect/vitest

`@effect/vitest` — package

The official Effect test runner adapter for Vitest. It requires Vitest 4.1 or newer, wraps Vitest's `it` with Effect-aware variants that handle fibers, provides the test environment (TestClock + TestConsole), cleans up scopes, and surfaces failures with pretty-printed `Cause` traces. It re-exports everything from `vitest`.

**Mental model.** A thin Layer between Vitest and Effect tests. Key additions:

- `it.effect` — runs an Effect, provides TestClock + TestConsole, opens a fresh Scope per test.
- `it.live` — same but uses real runtime services (no TestClock substitution).
- `it.effect.prop` — property-based test whose body is an Effect; accepts Schemas as arbitraries.
- `layer(L)` — builds a layer once for a block of tests, sharing state across them, tears down in `afterAll`.
- `assert` — re-exported Node.js assert; repo convention prefers this over Vitest's `expect`.

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

### Property-based tests with `it.effect.prop`

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

// Schemas are converted to Arbitraries automatically.
// Property: applying a non-negative raise never decreases the salary.
it.effect.prop(
  "applying a merit raise never decreases the salary",
  [
    Schema.Finite.pipe(Schema.check(Schema.makeFilter((n: number) => n >= 50_000 && n <= 250_000 ? undefined : "salary out of range"))),
    Schema.Finite.pipe(Schema.check(Schema.makeFilter((n: number) => n >= 0 && n <= 0.20 ? undefined : "raise out of range")))
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
    base:   Schema.Finite.pipe(Schema.check(Schema.makeFilter((n: number) => n > 0 && n <= 200_000 ? undefined : "base out of range"))),
    factor: Schema.Finite.pipe(Schema.check(Schema.makeFilter((n: number) => n >= 0 && n <= 1 ? undefined : "factor out of range")))
  },
  ({ base, factor }) =>
    Effect.gen(function*() {
      assert.strictEqual(base * factor, factor * base)
    })
)
```

Use for all Effect tests. Start with `it.effect`, graduate to `layer(...)` when integration state needs sharing, and use `it.effect.prop` whenever the claim is "this holds for all inputs."

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

The assertion transform handles a complete expression statement or a single initialized `const`; it does not implicitly await promises, run Effects, or consume iterators. Do those operations explicitly. `@effect/doctest` requires Vitest 4.1+ at this release.

**Other repository tools.**

- **@effect/openapi-generator** — Public tool. Given an OpenAPI spec file, generates Effect Schema type definitions, typed HTTP clients, or full `HttpApi` module skeletons. CLI: `openapigen --spec api.yaml`. Accepts JSON Patch files to pre-process the spec before generation; reports warnings to stderr. Output goes to stdout.

- **@effect/ai-codegen** — Code-generation framework used internally to produce AI provider bindings (OpenAI, Anthropic, etc.) inside `packages/ai`. Wraps `@effect/openapi-generator` with provider-specific discovery, patching, and post-processing. Not intended for external use. CLI: `effect-ai-codegen`.

- **@effect/ai-docgen** — Repository-internal compiler that combines the authored, ordered `ai-docs/src` directory tree into the aggregate `LLMS.md` document. It reads each directory's `index.md`, extracts title/description metadata from numbered TypeScript examples, skips fixtures, recurses into topic folders, and supports watch mode. CLI: `effect-ai-docgen ai-docs/src -o LLMS.md`.

- **@effect/jsdocs** — JSDoc extraction and analysis toolkit. Parses Effect source files with the TypeScript compiler, validates JSDoc blocks against Effect house style (required tags, example shape, `@since`, etc.), emits structured `JSDocResult` objects. Used by CI to enforce documentation quality. CLI: `effect-jsdocs`.

- **@effect/bundle** — Bundle-size testing infrastructure. Provides CLI commands for building fixture packages with Rollup, measuring tree-shaken output sizes, and comparing against a reporter. Prevents accidental bundle size regressions when publishing new Effect versions. CLI: `effect-bundle`.

> **Takeaway:** Application tests usually start with `@effect/vitest` and the test services. Library authors add `@effect/docgen` and `@effect/doctest` when examples are part of the contract; the OpenAPI, AI, JSDoc, and bundle tools are specialized repository and code-generation infrastructure.
