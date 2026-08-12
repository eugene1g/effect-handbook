# Errors, Option & Result

Effect treats failure as a typed value, not an exception. `Option` models absence, `Result` models success-or-failure, `Filter` models keep-or-reject, and `Data` builds structured comparable errors. Together they turn the error channel into ordinary control flow.

`Option<A>`, `Result<A, E>`, and `Effect<A, E, R>`'s `E` channel are the same idea at increasing power levels. Learn to move between them fluently.

> **Official examples:** Effect's release-matched [`ai-docs` error-handling examples](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/01_effect/04_errors) cover tagged errors, `catchTag`/`catchTags`, and reason-based errors.

## Effect error handling

The `catch*` family handles failures while keeping recovery visible in the effect's type.

| Combinator | What it does |
| --- | --- |
| `Effect.catch` | Recover from any expected error `E`. |
| `Effect.catchTag` / `catchTags` | Recover from one (or several) tagged error variants by `_tag` — the workhorse. |
| `Effect.catchFilter` | Recover only when a `Filter` matches. |
| `Effect.catchCause` / `catchDefect` | Reach below typed errors to the full `Cause`, or specifically to unexpected defects. |
| `Effect.result` / `Effect.option` | Reify the outcome into a `Result` / `Option` value instead of failing. |
| `Effect.tapError` / `tapCause` | Peek at failures (log them) without handling them. |
| `Effect.orElseSucceed` / `Effect.ignore` | Fall back to a plain success value, or swallow the error entirely. |

Define caught errors as **schema-backed tagged classes** — typed constructor, `_tag` for matching, and free serialization:

```ts
import { Effect, Schema } from "effect"

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {
  employeeId: Schema.String
}) {}

class BandViolation extends Schema.TaggedError<BandViolation>()("BandViolation", {
  employeeId: Schema.String,
  proposedSalary: Schema.Finite,
  bandMax: Schema.Finite
}) {}

const lookupEmployee = Effect.fn("lookupEmployee")(function*(id: string) {
  if (id === "") return yield* new EmployeeNotFound({ employeeId: id })
  if (id === "over-band") {
    return yield* new BandViolation({ employeeId: id, proposedSalary: 160_000, bandMax: 150_000 })
  }
  return { id, name: "Priya Sharma", level: "L4", baseSalary: 120_000 }
})

const safeComp = lookupEmployee("").pipe(
  // Handle each tagged error by name; TypeScript narrows `e` per tag.
  Effect.catchTags({
    EmployeeNotFound: (e) => Effect.succeed({ id: e.employeeId, name: "unknown", level: "L1", baseSalary: 0 }),
    BandViolation: (e) => Effect.logWarning(`salary ${e.proposedSalary} exceeds band max ${e.bandMax}`).pipe(
      Effect.as({ id: e.employeeId, name: "?", level: "L1", baseSalary: e.bandMax })
    )
  })
)
```

## Option

`effect/Option` — stable

`Option.some(a)` or `Option.none()`. The typed replacement for `null`/`undefined` — absence is in the type, not an implicit convention.

**Mental model.** A list with zero or one element. `map`, `flatMap`, `filter` are no-ops on `none`, enabling chainable transforms without null checks.

```ts
import { Option } from "effect"

// An employee record may or may not have a manager (top-level employees don't).
interface Employee {
  id: string
  name: string
  managerId: string | null | undefined
}

const employee: Employee = { id: "e-42", name: "Priya Sharma", managerId: null }

// Turn a nullable field into an Option, then transform safely.
const managerDisplay = Option.fromNullishOr(employee.managerId).pipe(
  Option.map((mid) => `reports to ${mid}`),
  Option.getOrElse(() => "no direct manager (top-level)")
)
// managerDisplay: "no direct manager (top-level)"

// Pattern-match both branches exhaustively.
const describeManager = (opt: Option.Option<string>) =>
  Option.match(opt, {
    onNone: () => "IC or department head — no manager on record",
    onSome: (mid) => `manager employee id: ${mid}`
  })
```

Use when a value is legitimately optional and the compiler must enforce handling of absence — optional config lookups, "find first" results, optional fields.

## Result

`effect/Result` — stable

`Result.succeed(a)` or `Result.fail(e)`. Synchronous, pure success-or-failure — `Effect`'s error channel without async or requirements.

**Mental model.** `Effect` minus the runtime. Use `Result` for pure computations that can fail (validation, parsing); bridge into `Effect` with `Effect.result` to materialize an outcome.

```ts
import { Effect, Result } from "effect"

interface CompBand { min: number; mid: number; max: number }

// A pure validation — is a raise recommendation within the comp band?
const validateRaise = (
  currentSalary: number,
  proposedSalary: number,
  band: CompBand
): Result.Result<number, string> => {
  if (proposedSalary < band.min)
    return Result.fail(`proposed salary ${proposedSalary} is below band minimum ${band.min}`)
  if (proposedSalary > band.max)
    return Result.fail(`proposed salary ${proposedSalary} exceeds band maximum ${band.max}`)
  if (proposedSalary <= currentSalary)
    return Result.fail(`raise must exceed current salary ${currentSalary}`)
  return Result.succeed(proposedSalary)
}

const band: CompBand = { min: 100_000, mid: 125_000, max: 150_000 }
const approved = Result.getOrElse(validateRaise(120_000, 130_000, band), () => 120_000) // 130_000
const rejected = Result.getOrElse(validateRaise(120_000, 160_000, band), () => 120_000) // 120_000 (capped)

// Bridge the Effect error channel INTO a Result to inspect it without failing.
const program = Effect.gen(function*() {
  const outcome = yield* Effect.result(Effect.fail("HrisUnavailable"))
  if (Result.isFailure(outcome)) {
    yield* Effect.log(`comp lookup failed: ${outcome.failure}`)
  }
})
```

Use when you need a pure, eager "did it work?" value — validation logic, eligibility checks, or inspecting an effect's outcome before branching.

## Filter

`effect/Filter` — stable

New in v4. A function `(input) => Result<Pass, Fail>` that decides whether a value passes (optionally refining or transforming it) or is filtered out. A predicate that can narrow the type and explain the rejection.

**Mental model.** A refinement built on `Result`. The pass branch can have a different type than the input, so filters act as type guards and mini-parsers that compose. They power `Effect.catchFilter` and stream filtering.

```ts
import { Filter, Result } from "effect"

interface Employee { id: string; level: string; performanceRating: string; baseSalary: number }

// A filter that keeps only employees eligible for a merit increase:
// must be rated "exceeds" or "meets" and not already at band maximum.
const BAND_MAX = 150_000

const eligibleForMerit = Filter.make((emp: Employee) => {
  if (emp.performanceRating === "below")
    return Result.fail(emp) // filtered out — not eligible
  if (emp.baseSalary >= BAND_MAX)
    return Result.fail(emp) // filtered out — already at ceiling
  return Result.succeed(emp) // passes through for raise calculation
})

const priya: Employee = { id: "e-42", name: "Priya Sharma", level: "L4", performanceRating: "exceeds", baseSalary: 120_000 } as any
eligibleForMerit(priya)  // Result.succeed(priya)

const atCeiling: Employee = { id: "e-99", name: "Dev Anand", level: "L5", performanceRating: "meets", baseSalary: 150_000 } as any
eligibleForMerit(atCeiling)  // Result.fail(atCeiling) — at band max

// Built-in filters compose; turn one into a plain predicate when needed.
const isNumber = Filter.toPredicate(Filter.number)
isNumber(42) // true
```

Use when you need a reusable, composable keep-or-drop rule that also refines types — selective error recovery with `catchFilter`, or validating-and-narrowing untrusted input.

## Data

`effect/Data` — stable

Helpers for values with **structural equality** baked in — classes, tagged classes, tagged enums (discriminated unions), and error classes. Two `Data` values with the same contents are `Equal`, usable as keys in `HashMap`/`HashSet` and comparable via `Equal.equals`.

**Mental model.** Plain classes give reference equality; `Data` gives value equality plus a discriminant. Foundation for tagged errors and domain value objects.

```ts
import { Data, Equal } from "effect"

// A tagged union for the state of a raise recommendation in a merit workflow.
type RaiseState = Data.TaggedEnum<{
  Pending: { readonly employeeId: string }
  Approved: { readonly employeeId: string; readonly newSalary: number }
  Rejected: { readonly employeeId: string; readonly reason: string }
}>
const { Pending, Approved, Rejected, $match } = Data.taggedEnum<RaiseState>()

const a = Approved({ employeeId: "e-42", newSalary: 130_000 })
const b = Approved({ employeeId: "e-42", newSalary: 130_000 })
Equal.equals(a, b) // true — structural, not reference

const describe = $match({
  Pending: (s) => `awaiting approval for ${s.employeeId}`,
  Approved: (s) => `${s.employeeId} approved at $${s.newSalary}`,
  Rejected: (s) => `${s.employeeId} rejected: ${s.reason}`
})
describe(a) // "e-42 approved at $130000"
```

`Data.TaggedError` builds an `Error` subclass that is also a tagged, value-equal effect failure — suitable for quick internal errors. For serializable errors, prefer `Schema.TaggedError` (shown above).

```ts
import { Data } from "effect"

// Quick internal errors — no schema needed, but still tagged and value-equal.
class BudgetExceeded extends Data.TaggedError("BudgetExceeded")<{
  readonly requested: number
  readonly remaining: number
}> {}

class EmployeeNotFound extends Data.TaggedError("EmployeeNotFound")<{
  readonly employeeId: string
}> {}
```

Use when you need value objects, discriminated unions with tidy constructors and a built-in matcher, or lightweight tagged errors.

## ErrorReporter

`effect/ErrorReporter` — stable

A pluggable sink for reporting `Cause`s — controls how unhandled failures are surfaced. Register reporters via a `Context.Reference`; annotate error types with severity and attributes for structured rendering.

**Mental model.** Logging is for messages; `ErrorReporter` is for errors as first-class artifacts — it understands `Cause` structure, severity, and per-error metadata.

```ts
import { Cause, Effect, ErrorReporter } from "effect"

// Report a cause through the currently-installed reporters.
// Here: a comp service failed during a merit cycle run.
const program = ErrorReporter.report(
  Cause.fail("HrisUnavailable: timed out fetching employee roster")
)

// Mark a domain error's severity and structured attributes so reporters render it richly.
class BandViolationError extends Error {
  override readonly [ErrorReporter.severity] = "Error"
  override readonly [ErrorReporter.attributes] = { employeeId: "e-42", proposedSalary: 160_000, bandMax: 150_000 }
}
```

Use when you need centralized, structured error reporting (to a dashboard, Sentry-like sink, or custom channel) that understands causes and severity.

## PlatformError

`effect/PlatformError` — stable

The typed error family for platform operations (filesystem, paths, child processes). Two shapes: `BadArgument` (invalid input) and `SystemError` (OS-level failure: `ENOENT`, `EACCES`, etc.), unified under `PlatformError`.

**Mental model.** `FileSystem.readFileString` fails with a `PlatformError` you can `catchTag` on, including the syscall, path, and reason — not a stringly-typed `Error`.

```ts
import { Effect, FileSystem } from "effect"

// Load a comp-band configuration file. Recover gracefully if the file is missing.
const loadCompBands = Effect.fn("loadCompBands")(
  function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString("./comp-bands.json")
  },
  // PlatformError is tagged ("PlatformError"); its .reason holds BadArgument | SystemError.
  Effect.catchTag("PlatformError", (error) =>
    error.reason._tag === "NotFound"
      ? Effect.logWarning("comp-bands file not found").pipe(
          Effect.as("{}") // fall back only for the expected missing-file case
        )
      : Effect.fail(error) // preserve permission, timeout, invalid-input, and other failures
  )
)
```

Use when handling I/O from platform modules (FileSystem, Path, process) and reacting to specific failure reasons — e.g., distinguishing a missing file from a permission error.

> **Tip:** **Expected** problems (not found, out of band, budget exceeded) belong in the typed `E` channel as tagged errors you `catchTag`. **Unexpected** problems (bugs, "impossible" states) should be defects — surface them via `Cause`/`ErrorReporter` rather than modeling as recoverable errors.
