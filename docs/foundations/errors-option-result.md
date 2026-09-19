# Errors, Option & Result

Effect treats failure as a typed value, not an exception. `Option` models absence, `Result` models success-or-failure, `Filter` models keep-or-reject, and `Data` builds structured comparable errors. Together they turn the error channel into ordinary control flow.

`Option<A>`, `Result<A, E>`, and `Effect<A, E, R>`'s `E` channel are the same idea at increasing power levels. Learn to move between them fluently.

> **Official examples:** Effect's release-matched [`ai-docs` error-handling examples](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.115/ai-docs/src/01_effect/04_errors) cover tagged errors, `catchTag`/`catchTags`, and reason-based errors.

> **Official guides:** [Expected Errors](https://effect.website/docs/v4/error-management/expected-errors), [Two Types of Errors](https://effect.website/docs/v4/error-management/two-error-types). These track Effect's `main` branch rather than the pinned `rc.115` release, so where they differ, this page and the tagged source win.

## Designing the error model

Decide what each unpleasant outcome *is* before writing a class for it. The channel it lands in determines who can see it, who may recover from it, and what retry and alerting code will do with it.

| Outcome | Belongs in | Ask | Example |
| --- | --- | --- | --- |
| A correct negative answer that every caller treats as ordinary output | the success value `A` (a tagged `Data`/`Schema` value, an `Option`, or a `Result`) | "Would every caller branch on this identically as part of normal operation?" | an eligibility check answers `Ineligible { reason }`; a band lookup answers `Option.none()` |
| A condition a valid caller can act on: recover, retry, translate, or compensate | a typed failure in `E` | "Does some caller need its own policy for this?" | `EmployeeNotFound`, `BandViolation`, `HrisUnavailable` |
| A broken invariant or a bug | a defect (`Effect.die`, `Effect.orDie`, a throw inside `Effect.sync`) | "Could any caller do something sensible with it?" — no | a stored salary is negative although the schema forbids it |
| The caller went away | interruption | never modeled by hand | timeout, race loser, shutdown |

**Not everything unpleasant is a failure.** If a service's job is to decide eligibility, "not eligible" is the product's answer, so the workflow succeeds with that classification and `E` stays reserved for outcomes callers must handle differently (invalid input, storage failure). Putting a correct negative answer in `E` makes retry schedules and alerts treat a right answer as a fault. Classifying at the layer that owns the question is also what legitimately produces `E = never` further up.

Fill in one row per failure *before* writing error classes. The columns are the decisions the classes must support:

| Failure | Detected by | What the caller can do | Channel | Retryable | Translated by | Logged by |
| --- | --- | --- | --- | --- | --- | --- |
| no row for the employee id | repository (the query succeeded with zero rows) | answer 404, or skip the employee | `E`: `EmployeeNotFound` | no | repository, into a domain error | HTTP edge, at info level |
| proposed salary above the band | domain validation | request an exception, or reject | `E`: `BandViolation` | no | nobody; it is already domain language | nobody; it is expected |
| HRIS answers 503 or times out | HRIS adapter | retry with backoff, then degrade | `E`: `HrisUnavailable { retryable }` | yes, bounded | adapter wraps the driver error once | retry boundary (attempts), owner (terminal outcome) |
| a decoded row violates a guaranteed constraint | repository decode | nothing | defect | no | nobody | process edge through `ErrorReporter` |
| the request was aborted | runtime | nothing | interruption | never | never | not logged as a fault |

Rules that fall out of the worksheet:

- **Model caller decisions, not the library's exception classes.** One variant per distinct policy; fields carry the facts the policy needs (`retryable`, `employeeId`, `bandMax`), never a message to parse.
- **Keep missing, conflict, unavailable, timeout, corrupt, forbidden, and unknown-infrastructure distinct** whenever their policies differ, because collapsing them forces every caller to guess.
- **Only a query that succeeded and returned nothing is "not found".** Timeouts, permission errors, pool exhaustion, malformed rows, and unknown driver errors must never become `EmployeeNotFound` or a 404, and a constraint violation is a specific conflict only after checking *which* constraint fired.
- **Translate where knowledge is added:** foreign throwable → one stable adapter error (wrap the unknown once, at the adapter) → domain meaning → sanitized public representation. A layer that adds no knowledge passes the error through unrenamed. [Cancellable adapters](core-runtime-execution#8-cancellable-adapters-for-promises-and-callbacks) shows the adapter end of that chain, including dying on rejections the contract does not allow.
- **Interruption is cancellation.** It is never a domain error, never a retry trigger, and not a fault to log by default.
- **Public error values are an output surface.** A `Schema.TaggedError` declared on an HTTP endpoint or RPC encodes every field, so `cause: Schema.Defect()` publishes the wrapped error's `name` and `message` (stacks are omitted unless `includeStack: true`). Keep diagnostic causes on internal errors; give public errors stable tags plus safe identifiers, and never serialize a `Cause`, SQL text, a credential, or a `Redacted`.

The [failure deep dive](../deep-dives/failure-retry-fallback-and-interruption) follows one operation through these decisions, including retry, timeout, and fallback.

## Effect error handling

The `catch*` family handles failures while keeping recovery visible in the effect's type.

| Combinator | What it does |
| --- | --- |
| `Effect.catch` | Recover from any expected error `E`. |
| `Effect.catchTag` / `catchTags` | Recover from one (or several) tagged error variants by `_tag` — the workhorse. `catchTag` also accepts a non-empty array of tags. |
| `Effect.catchIf` / `Effect.catchFilter` | Recover when a predicate or refinement over `E` holds, or when a `Filter` matches (and narrows). |
| `Effect.catchReason` / `catchReasons` / `unwrapReason` | Recover at the level of a nested tagged `reason` field; see [Core Runtime: error handling](core-runtime-execution#3-error-handling). An unmatched reason with no fallback re-fails with the original `Cause`. |
| `Effect.catchCause` / `catchDefect` | Reach below typed errors to the full `Cause`, or specifically to unexpected defects. |
| `Effect.mapError` / `mapBoth` / `flip` | Rewrite `E` without recovering, rewrite both channels, or swap `A` and `E`. |
| `Effect.filterOrFail` / `filterOrElse` | Turn an unacceptable success into a typed failure, or into another Effect. |
| `Effect.match` / `matchEffect` | Fold typed failure and success into one value; `E` becomes `never` (pure handlers) or the handlers' errors. |
| `Effect.matchCause` / `matchCauseEffect` | The same fold, but `onFailure` receives the whole `Cause`, including defects and interruption. |
| `Effect.result` / `Effect.option` / `Effect.exit` | Reify the outcome into a `Result`, an `Option` (the error value is discarded), or an `Exit` (the full `Cause`). |
| `Effect.validate` / `Effect.partition` | Run every element and accumulate all failures instead of stopping at the first. |
| `Effect.tapError` / `tapErrorTag` / `tapCause` / `tapDefect` | Observe failures (log them) without handling them; the original failure is re-raised when the observer succeeds. |
| `Effect.orElseSucceed` / `Effect.firstSuccessOf` | Replace **every** typed failure with a plain value, or try alternatives in order. |
| `Effect.ignore` / `Effect.ignoreCause` | Discard the success value and typed failures (`ignore`), or additionally defects and interruption (`ignoreCause`). |
| `Effect.sandbox` | Move the whole `Cause<E>` into the error channel so ordinary `catch` sees every reason. |
| `Effect.orDie` | Convert the typed failure into a defect and remove it from `E`. |
| `Effect.fail` / `Effect.failSync` / `Effect.die` | Create a typed failure (eagerly, or lazily so the error is built only on the failing path) or a defect. |

**Name each handler's intent.** Every `catch*` should be exactly one of four things: *recover* (supply a truthful value for the handled condition, not merely a way to empty `E`), *translate* (add meaning at an abstraction boundary with `mapError`), *compensate* (undo prior work, then re-fail), or *observe* (`tap*`, failure unchanged). A handler that does none of these is hiding a failure.

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

### Selective recovery beyond one tag

```ts
import { Effect, Filter, Schema } from "effect"

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {
  employeeId: Schema.String
}) {}

class BandViolation extends Schema.TaggedError<BandViolation>()("BandViolation", {
  employeeId: Schema.String
}) {}

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {
  status: Schema.Int
}) {}

declare const proposeRaise: Effect.Effect<string, EmployeeNotFound | BandViolation | HrisUnavailable>

// One handler for several tags: E shrinks to HrisUnavailable.
const skipped = proposeRaise.pipe(
  Effect.catchTag(["EmployeeNotFound", "BandViolation"], (error) =>
    Effect.succeed(`skipped ${error.employeeId}: ${error._tag}`)
  )
)

// A Filter selects, and narrows, the failure to recover.
const cached = proposeRaise.pipe(
  Effect.catchFilter(Filter.tagged("HrisUnavailable"), (error) =>
    Effect.succeed(`served from cache after HTTP ${error.status}`)
  )
)

// A predicate over E: for a field test, or for errors that are not tagged classes.
const restarting = proposeRaise.pipe(
  Effect.catchIf(
    (error) => error._tag === "HrisUnavailable" && error.status === 503,
    () => Effect.succeed("HRIS is restarting; try again shortly")
  )
)
```

`catchTag`, `catchIf`, `catchFilter`, and `catchReason` take an optional trailing `orElse` handler for the failures that did **not** match, which empties `E` in one call. **Prefer the narrowest selector that expresses the policy**, because the remaining union in `E` is the record of what has not been decided yet. A handler that compiles is not proof that only the intended tag left the channel — a broad `Effect.catch` compiles too — so pin the post-recovery type with an annotation (`const skipped: Effect.Effect<string, HrisUnavailable> = ...`) next to the behavior test.

### Transforming the error channel

```ts
import { Effect, FileSystem, Schema } from "effect"

// An internal error: the diagnostic cause never leaves the process.
class CompBandsUnavailable extends Schema.TaggedError<CompBandsUnavailable>()("CompBandsUnavailable", {
  path: Schema.String,
  cause: Schema.Defect()
}) {}

class NoManagerOnRecord extends Schema.TaggedError<NoManagerOnRecord>()("NoManagerOnRecord", {
  employeeId: Schema.String
}) {}

// mapError: translate a platform failure into the error this module owns. Nothing is recovered.
const loadBands = Effect.fn("loadBands")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path).pipe(
    Effect.mapError((cause) => new CompBandsUnavailable({ path, cause }))
  )
})

declare const findManagerId: (employeeId: string) => Effect.Effect<string | null>

// filterOrFail: an unacceptable success becomes a typed failure; a refinement narrows A.
const requireManager = (employeeId: string) =>
  findManagerId(employeeId).pipe(
    Effect.filterOrFail(
      (managerId): managerId is string => managerId !== null,
      () => new NoManagerOnRecord({ employeeId })
    )
  ) // Effect<string, NoManagerOnRecord>
```

- **`Effect.mapError(f)` rewrites only `E`**; use it at the layer that owns a dependency so driver and SDK errors do not leak upward. `Effect.mapBoth({ onFailure, onSuccess })` rewrites both channels in one pass.
- **`Effect.filterOrFail(predicate, orFailWith?)`** replaces `flatMap` + `if` + `Effect.fail`. Without `orFailWith` it fails with `Cause.NoSuchElementError`. `Effect.filterOrElse` runs a fallback Effect instead of producing an error.
- **`Effect.flip` swaps `A` and `E`.** Its main use is a test that wants the typed error as a value (`const error = yield* Effect.flip(effect)`); in production code `mapError` or a catch states the intent better.
- **Map before you `orDie`.** When a boundary deliberately promotes a failure to a defect, `Effect.mapError` first so the defect carries a meaningful error rather than a raw driver object.

### Folding both channels at a boundary

Selective recovery keeps a workflow alive and leaves the rest of `E` for the next owner. *Folding* is the terminal move for an edge that must produce exactly one ordinary shape: an HTTP response, a CLI exit summary, a worker acknowledgement, a test observation.

```ts
import { Effect, Schema } from "effect"

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {
  employeeId: Schema.String
}) {}

class BandViolation extends Schema.TaggedError<BandViolation>()("BandViolation", {
  bandMax: Schema.Finite
}) {}

declare const proposeRaise: (employeeId: string) => Effect.Effect<number, EmployeeNotFound | BandViolation>

// Pure handlers. E is `never`: this boundary has accounted for every expected failure.
const response = proposeRaise("e-42").pipe(
  Effect.match({
    onFailure: (error) =>
      error._tag === "EmployeeNotFound"
        ? { status: 404 as const, body: { employeeId: error.employeeId } }
        : { status: 422 as const, body: { bandMax: error.bandMax } },
    onSuccess: (newSalary) => ({ status: 200 as const, body: { newSalary } })
  })
)

// Effectful handlers may log, record a metric, or fail with a new error.
const audited = proposeRaise("e-42").pipe(
  Effect.matchEffect({
    onFailure: (error) => Effect.logWarning("raise rejected", { tag: error._tag }).pipe(Effect.as(false)),
    onSuccess: (newSalary) => Effect.logInfo("raise approved", { newSalary }).pipe(Effect.as(true))
  })
)
```

- **Fold only at a terminal boundary.** A lower layer that folds steals policy from its callers.
- **`match` and `matchEffect` see typed failures only**; a defect or interruption still fails the fiber. `matchCause` and `matchCauseEffect` hand `onFailure` the whole `Cause`, so they are process- or request-edge tools with the same caution as `catchCause`.
- To make the fold exhaustive over a large union, delegate to a matcher from [Classifying an error union](#classifying-an-error-union).

### Accumulating errors instead of failing fast

`Effect.all` and `Effect.forEach` stop at the first typed failure, which is wrong for form or batch validation where the caller needs every problem at once.

```ts
import { Effect, Schema } from "effect"

class BandViolation extends Schema.TaggedError<BandViolation>()("BandViolation", {
  employeeId: Schema.String
}) {}

declare const checkRaise: (employeeId: string) => Effect.Effect<number, BandViolation>
const employeeIds = ["e-1", "e-2", "e-3"]

// Runs every check. Succeeds with Array<number>, or fails with NonEmptyArray<BandViolation>.
const allOrEveryViolation = Effect.validate(employeeIds, checkRaise, { concurrency: 4 })

// Runs every check and never fails: [violations, approvedAmounts].
const split = Effect.partition(employeeIds, checkRaise, { concurrency: 4 })

// One Result per member, in the shape of the input.
const perMember = Effect.all(employeeIds.map(checkRaise), { mode: "result" })
```

| Need | Use | Outcome |
| --- | --- | --- |
| Stop the batch at the first problem | `Effect.all` / `Effect.forEach` (default) | fails with the first `E`; when sequential, later elements never start |
| Every problem at once, or else every value | `Effect.validate(items, f, { concurrency?, discard? })` | `Array<B>`, or fails with `NonEmptyArray<E>` (successes are dropped) |
| Act on both sides | `Effect.partition(items, f, { concurrency? })` | never fails: `[excluded: Array<E>, satisfying: Array<B>]` |
| Per-member outcome in the input's shape | `Effect.all(effects, { mode: "result" })` | a `Result` per member |

A defect in any element still fails the whole call. **Accumulate as data rather than as several `Fail` reasons in one `Cause`**, because typed handlers inspect only the first `Fail` reason (see below).

### Fallback values and ignoring failures

```ts
import { Effect } from "effect"

declare const fromHris: Effect.Effect<number, "HrisUnavailable">
declare const fromReplica: Effect.Effect<number, "ReplicaStale">
declare const fromSnapshot: Effect.Effect<number, "NoSnapshot">

// Sequential; the first success wins. If all fail, the error is the last one: "NoSnapshot".
const bandMidpoint = Effect.firstSuccessOf([fromHris, fromReplica, fromSnapshot])
```

- **`Effect.orElseSucceed(() => value)` replaces every typed failure.** If only "not found" should default, narrow with `catchTag` first and keep the rest typed.
- **`Effect.firstSuccessOf(effects)`** tries different effects in order; an empty iterable is a defect. When the *same* effect should run under different provided services, use [`ExecutionPlan`](core-runtime-execution#executionplan) instead.
- **`Effect.option` discards the error value**, so use it only when every typed failure of that effect genuinely means "absent"; otherwise use `Effect.result`. Both leave defects and interruption as fiber failures.
- **`Effect.ignore` discards typed failures only** — a defect or interruption still fails the fiber. `Effect.ignoreCause` also discards defects and interruption and can therefore hide bugs; reserve it for best-effort cleanup. Both accept `{ log: true | severity, message }` to log the `Cause` while ignoring it.

### Recovery replaces the whole Cause

A [`Cause`](core-runtime-execution#cause) is a flat list of reasons and may hold a typed failure *and* a defect or interruption at once: a failing operation whose finalizer dies, a concurrent sibling whose cleanup dies while being interrupted, or a `race` in which every contender fails.

**Every typed-channel operator looks for the first `Fail` reason; when it finds one, the handler's result becomes the entire outcome and the other reasons are dropped.** That covers `catch`, `catchTag(s)`, `catchIf`, `catchFilter`, `catchReason(s)`, `mapError`, `orDie`, `orElseSucceed`, `firstSuccessOf`, `match`, `matchEffect`, `result`, `option`, `ignore`, and `retry`. With no `Fail` reason, or when the selector does not match, the original `Cause` passes through untouched. `tapError` and `tapCause` re-raise the original `Cause`, so they lose nothing.

```ts
import { Cause, Effect, Schema } from "effect"

class ExportFailed extends Schema.TaggedError<ExportFailed>()("ExportFailed", {
  batchId: Schema.String
}) {}

// A typed failure whose finalizer then dies: one Cause, reasons [Fail, Die].
const exportBatch = Effect.fail(new ExportFailed({ batchId: "b-7" })).pipe(
  Effect.ensuring(Effect.die(new Error("ledger handle already closed")))
)

// Succeeds with "skipped": the Die reason is gone.
const lossy = exportBatch.pipe(
  Effect.catchTag("ExportFailed", () => Effect.succeed("skipped"))
)

// Recovers only when typed failures are the whole story; otherwise re-fails with every reason.
const careful = exportBatch.pipe(
  Effect.catchCause((cause) =>
    Cause.hasDies(cause) || Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.succeed("skipped")
  )
)
```

Only the *first* `Fail` is inspected, so `catchTag("B")` does not fire for reasons `[Fail(A), Fail(B)]`. The failure deep dive shows the guarded `catchCause`, reason inspection, and `Effect.sandbox` variants in full: [Typed recovery replaces the whole Cause](../deep-dives/failure-retry-fallback-and-interruption#typed-recovery-replaces-the-whole-cause).

Official guides: [Error Channel Operations](https://effect.website/docs/v4/error-management/error-channel-operations), [Matching](https://effect.website/docs/v4/error-management/matching), [Error Accumulation](https://effect.website/docs/v4/error-management/error-accumulation), [Fallback](https://effect.website/docs/v4/error-management/fallback).

## Classifying an error union

Before choosing a catch operator, write down which boundary owns each variant: validation failures belong to the API edge, transient transport failures to the retry boundary, impossible invariants to defects rather than `E`. When one boundary must classify the *whole* union — a status code, a retry decision, a user message — **finish the matcher with `Match.exhaustive` or `Match.tagsExhaustive`, never a `switch` with `default`**, so that adding a variant fails compilation exactly where policy must be updated. A default branch silently assigns tomorrow's error to today's fallback.

```ts
import { Effect, Match, Schema } from "effect"

class InvalidRaise extends Schema.TaggedError<InvalidRaise>()("InvalidRaise", {
  requestedPercent: Schema.Finite
}) {}

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {
  employeeId: Schema.String
}) {}

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {
  status: Schema.Int
}) {}

type RaiseFailure = InvalidRaise | EmployeeNotFound | HrisUnavailable
type Policy = "reject-input" | "report-missing" | "retry-later" | "page-oncall"

// Field-sensitive policy. Adding a variant to RaiseFailure breaks compilation here.
const policyFor = Match.type<RaiseFailure>().pipe(
  Match.tag("InvalidRaise", (): Policy => "reject-input"),
  Match.tag("EmployeeNotFound", (): Policy => "report-missing"),
  Match.tag("HrisUnavailable", ({ status }): Policy => (status >= 500 ? "retry-later" : "page-oncall")),
  Match.exhaustive
)

// Table form: one handler per tag, checked for completeness.
const statusFor = Match.type<RaiseFailure>().pipe(
  Match.tagsExhaustive({
    InvalidRaise: () => 422,
    EmployeeNotFound: () => 404,
    HrisUnavailable: () => 503
  })
)

// Plain data works too: `satisfies` rejects a missing or misspelled tag.
const retryable = {
  InvalidRaise: false,
  EmployeeNotFound: false,
  HrisUnavailable: true
} as const satisfies Record<RaiseFailure["_tag"], boolean>

declare const approveRaise: Effect.Effect<number, RaiseFailure>

// The terminal fold delegates to the exhaustive classifiers.
const response = approveRaise.pipe(
  Effect.match({
    onFailure: (error) => ({ status: statusFor(error), policy: policyFor(error) }),
    onSuccess: (newSalary) => ({ status: 200, newSalary })
  })
)
```

- **Reserve `Match.orElse` for a deliberate fallback**, and say in a comment why new variants may land there.
- **`Match.fn((...args) => selected)` builds a classifier that takes extra arguments** (a locale, a request id): `Match.tag` handlers receive the narrowed value followed by the original arguments. Finish it with `Match.exhaustive`; `Match.tagsExhaustive` is typed for matchers without extra arguments.
- A `Schema.TaggedUnion` carries its own exhaustive `.match(value, cases)`; `.matchOrElse(value, cases, orElse)` is the partial form with a typed fallback (see [Schema unions](../data/schema#4-unions-literals-records-tuples)). `Data.taggedEnum` provides `$match` (below).
- **Completeness is mechanical.** The compiler proves every tag has a row; it cannot prove a row is *right*. That needs domain review and a test per policy.

The full `Match` API lives in [The Functional Toolkit](../data/functional-toolkit#match).

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

### Combining optional values

```ts
import { Option } from "effect"

interface CompBand {
  readonly level: string
  readonly max: number
}

declare const findLevel: (employeeId: string) => Option.Option<string>
declare const findBand: (level: string) => Option.Option<CompBand>
declare const currentSalary: Option.Option<number>

// flatMap: a dependent lookup that is itself optional, without nesting Options.
const band = findLevel("e-42").pipe(Option.flatMap(findBand))

// filter: keep the value only when the predicate holds.
const roomyBand = band.pipe(Option.filter((b) => b.max > 120_000))

// all: independent Options in a struct or tuple; any None collapses the whole result.
const inputs = Option.all({ band, salary: currentSalary })

// zipWith: exactly two values.
const headroom = Option.zipWith(band, currentSalary, (b, salary) => b.max - salary)

// gen: imperative style that stops at the first None.
const headroomPercent = Option.gen(function*() {
  const b = yield* band
  const salary = yield* currentSalary
  return ((b.max - salary) / salary) * 100
})
```

`Option.gen` evaluates eagerly, so keep its body pure; reach for `Effect.gen` plus `Effect.fromOption` when a step has side effects.

### Fallbacks and boundary exits

```ts
import { Option } from "effect"

declare const employeeOverride: Option.Option<string>
declare const teamDefault: Option.Option<string>

// The first present value wins: override, then team default, then the global default.
const bandId = Option.firstSomeOf([employeeOverride, teamDefault, Option.some("L1")])

// orElse takes a lazy alternative Option.
const overrideOrTeam = employeeOverride.pipe(Option.orElse(() => teamDefault))

// liftPredicate: a boolean test becomes an Option-returning function.
const positiveRaise = Option.liftPredicate((percent: number) => percent > 0)
positiveRaise(-5) // Option.none()
positiveRaise(4) // Option.some(4)
```

| Exit | Use it at |
| --- | --- |
| `Option.getOrElse(() => fallback)` | rendering and defaults that the *boundary* owns |
| `Option.getOrNull` / `Option.getOrUndefined` | JSON, SQL parameters, UI props — the mirror of `fromNullOr` / `fromUndefinedOr` / `fromNullishOr` |
| `Option.match({ onNone, onSome })` | both branches produce a value |
| `Option.getOrThrow` / `Option.getOrThrowWith(() => error)` | invariants only; it reintroduces the hidden crash the type removed |

**Keep absence visible until a real boundary.** Carry an optional domain field as `Option` through the domain and collapse it only where rendering, JSON, SQL, or interop needs a concrete value. Use `None` when callers need no reason and `Result` when they must act on one. The quiet wrong turn is defaulting every branch to a plausible success (`getOrElse(() => 0)` for an unknown salary): it type-checks and is silently wrong.

`Option.makeEquivalence` and `Option.makeOrder` lift an `Equivalence` or `Order` for `A` to `Option<A>`, so optional fields can take part in sorting and de-duplication. `None` orders before every `Some`; `Order.flip` reverses the whole order, which puts missing values last and present values in descending order.

Official guides: [Option](https://effect.website/docs/v4/data-types/option) (its statement that an `Option` can be yielded directly inside `Effect.gen` does not hold on `rc.115`; see [Moving between Option, Result, and Effect](#moving-between-option-result-and-effect)), [Effect Data Types](https://effect.website/docs/v4/schema/effect-data-types) (Schema) for nullable and optional wire shapes that decode to `Option`.

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

### Transforming and combining Results

```ts
import { Result } from "effect"

declare const salary: Result.Result<number, string>
declare const levelMidpoint: Result.Result<number, string>

// all: struct (or tuple) in, same shape out. The FIRST failure wins; nothing is accumulated.
const compaRatio = Result.all({ salary, levelMidpoint }).pipe(
  Result.map(({ salary, levelMidpoint }) => salary / levelMidpoint),
  Result.flatMap((ratio) => ratio > 1.2 ? Result.fail("above the band ceiling") : Result.succeed(ratio)),
  Result.mapError((reason) => ({ _tag: "InvalidComp" as const, reason }))
)

// match folds both branches into one value.
const label = Result.match(compaRatio, {
  onFailure: (error) => `rejected: ${error.reason}`,
  onSuccess: (ratio) => `compa-ratio ${ratio.toFixed(2)}`
})
```

`Result.map` / `mapError` / `mapBoth` transform one or both sides, `flatMap` chains a dependent check, and `Result.gen` is the imperative form. **`Result.all` and `Result.gen` stop at the first failure**; to collect every problem, validate each field to a `Result` and gather the failures yourself, or use `Effect.validate`. Like `Option.gen`, `Result.gen` runs eagerly and should stay free of side effects.

### Moving between Option, Result, and Effect

Climb only when the semantics change: absence → absence with a reason → a reason inside a workflow.

| From → to | Function | Notes |
| --- | --- | --- |
| nullable → `Option` | `Option.fromNullishOr` (`fromNullOr`, `fromUndefinedOr`) | |
| `Option` → `Result` | `Result.fromOption(option, () => reason)` | upgrades absence into a named failure |
| `Result` → `Option` | `Result.getSuccess` / `Result.getFailure` | deliberately discards the other side |
| `Option` → `Effect` | `Effect.fromOption(option, () => error)` | without the second argument, `None` fails with `Cause.NoSuchElementError` |
| `Result` → `Effect` | `Effect.fromResult(result)` | a `Failure<E>` becomes the typed failure `E` |
| nullable → `Effect` | `Effect.fromNullishOr(value)` | fails with `Cause.NoSuchElementError` |
| `Effect` → `Result` / `Option` / `Exit` | `Effect.result` / `Effect.option` / `Effect.exit` | `result` and `option` capture typed failures only; `exit` captures the full `Cause` |

```ts
import { Data, Effect, Option, Result } from "effect"

interface Employee {
  readonly id: string
  readonly managerId: string | null
}
declare const employees: ReadonlyArray<Employee>

class NoSuchEmployee extends Data.TaggedError("NoSuchEmployee")<{ readonly employeeId: string }> {}
class NoManager extends Data.TaggedError("NoManager")<{ readonly employeeId: string }> {}

// Absence: callers need no reason.
const findEmployee = (employeeId: string) =>
  Option.fromNullishOr(employees.find((employee) => employee.id === employeeId))

// Absence plus a reason: still pure, now a named failure.
const requireEmployee = (employeeId: string) =>
  Result.fromOption(findEmployee(employeeId), () => new NoSuchEmployee({ employeeId }))

// A reason inside a workflow: convert explicitly, then yield the Effect.
const loadManagerId = Effect.fn("loadManagerId")(function*(employeeId: string) {
  const employee = yield* Effect.fromResult(requireEmployee(employeeId))
  return yield* Effect.fromOption(
    Option.fromNullishOr(employee.managerId),
    () => new NoManager({ employeeId })
  )
}) // Effect<string, NoSuchEmployee | NoManager>
```

> **Warning:** On `rc.115`, `Option` and `Result` are **not** yieldable inside `Effect.gen`, and neither is a subtype of `Effect`. `yield* someOption` is rejected by TypeScript at the `Effect.gen` call, and if the types are bypassed the fiber dies with `Fiber.runLoop: Not a valid effect: some(1)`. Convert with `Effect.fromOption` / `Effect.fromResult` (also before passing one to `Effect.all`), or match on it. `Option.gen` and `Result.gen` do yield their own type. The official Option and Result guides, and upstream `migration/yieldable.md`, say otherwise; the tagged release wins.

Pulling a value out early with `Option.getOrThrow`, or re-throwing `result.failure`, reintroduces exactly the hidden branch these types removed. For the three-way choice itself, see [Option vs Result vs Effect](../reference/choosing-effect-primitives#option-vs-result-vs-effect).

Official guide: [Result](https://effect.website/docs/v4/data-types/result) (the same `rc.115` caveat applies to its claim that a `Result` can be yielded inside `Effect.gen`).

## Filter

`effect/Filter` — stable

New in v4. A function `(input) => Result<Pass, Fail>` that decides whether a value passes (optionally refining or transforming it) or is filtered out. A predicate that can narrow the type and explain the rejection.

**Mental model.** A refinement built on `Result`. The pass branch can have a different type than the input, so filters act as type guards and mini-parsers that compose. They power `Effect.catchFilter` and stream filtering.

```ts
import { Filter, Result } from "effect"

interface Employee { id: string; name: string; level: string; performanceRating: string; baseSalary: number }

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

const priya: Employee = { id: "e-42", name: "Priya Sharma", level: "L4", performanceRating: "exceeds", baseSalary: 120_000 }
eligibleForMerit(priya)  // Result.succeed(priya)

const atCeiling: Employee = { id: "e-99", name: "Dev Anand", level: "L5", performanceRating: "meets", baseSalary: 150_000 }
eligibleForMerit(atCeiling)  // Result.fail(atCeiling) — at band max

// Built-in filters compose; turn one into a plain predicate when needed.
const isNumber = Filter.toPredicate(Filter.number)
isNumber(42) // true
```

`Filter.tagged("Tag")` is the ready-made filter for one member of a `_tag` union; pass it to `Effect.catchFilter` as shown in [Selective recovery beyond one tag](#selective-recovery-beyond-one-tag).

Use when you need a reusable, composable keep-or-drop rule that also refines types — selective error recovery with `catchFilter`, or validating-and-narrowing untrusted input.

## Data

`effect/Data` — stable

Helpers for defining value types — classes, tagged classes, tagged enums (discriminated unions), and error classes. Two `Data` values with the same contents are `Equal`, usable as keys in `HashMap`/`HashSet` and comparable via `Equal.equals`.

**Mental model.** In v4, [`Equal.equals`](../data/functional-toolkit#equal) is already structural for plain objects, arrays, and instances of ordinary classes, so `Data` is not what *gives* you value equality. `Data` supplies the ergonomics around it: class syntax with a typed constructor argument, an automatic `_tag`, tagged-enum constructors with `$is`/`$match`, and yieldable `Error` subclasses. A plain factory function is a complete value-object constructor when you need none of that; `Equal.byReference(value)` opts one object back into reference equality.

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

`$is(tag)` is the reusable type guard that pairs with `$match`, and `Data.Class` / `Data.TaggedClass` are the class forms — the ones that can carry getters and methods:

```ts
import { Data, Equal } from "effect"

type RaiseState = Data.TaggedEnum<{
  Pending: { readonly employeeId: string }
  Approved: { readonly employeeId: string; readonly newSalary: number }
}>
const { $is, Approved, Pending } = Data.taggedEnum<RaiseState>()

const states = [Pending({ employeeId: "e-1" }), Approved({ employeeId: "e-42", newSalary: 130_000 })]
const approved = states.filter($is("Approved")) // narrowed: newSalary is typed

class CompBand extends Data.Class<{ readonly level: string; readonly min: number; readonly max: number }> {
  get midpoint() {
    return (this.min + this.max) / 2
  }
}

const l4 = new CompBand({ level: "L4", min: 100_000, max: 150_000 })
const same = new CompBand({ level: "L4", min: 100_000, max: 150_000 })
const sameReference = l4 === same // false: `===` is still reference equality
const sameValue = Equal.equals(l4, same) // true

// Update by replacement.
const widened = new CompBand({ level: l4.level, min: l4.min, max: 160_000 })
```

Three caveats:

- **`readonly` is a TypeScript promise, not a runtime freeze.** `Data` values are not frozen, so a cast can still mutate one.
- **`===` remains reference equality.** Use `Equal.equals` wherever value equality is meant: assertions, de-duplication, cache keys.
- **Never mutate a value after it has been compared, hashed, or used as a key.** `Equal.equals` caches its result per object pair and `Hash` caches hashes, so a mutated value keeps its stale equality. Build a new value instead.

v3's `Data.struct`, `Data.tuple`, `Data.array`, and `Data.case` do not exist in `rc.115`; the module exports `Class`, `TaggedClass`, `TaggedEnum` / `taggedEnum`, `Error`, and `TaggedError`. Generic unions use `Data.TaggedEnum.WithGenerics<N>`.

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

**Yieldable errors.** Classes built with `Data.Error`, `Data.TaggedError`, `Schema.Error`, or `Schema.TaggedError` extend `Cause.YieldableError`, so `yield* new BudgetExceeded({ ... })` inside `Effect.gen` is the same as `yield* Effect.fail(new BudgetExceeded({ ... }))`; `return yield*` tells TypeScript the branch ends there. `Data.Error` is the untagged base: still an `Error` subclass with typed fields, but not selectable by `catchTag`.

```ts
import { Data, Effect } from "effect"

class LedgerCorrupted extends Data.Error<{ readonly ledgerId: string }> {}

// A field literally named `cause` becomes the native `Error.cause`, so `Cause.pretty`
// and the Node inspector print the wrapped exception under `[cause]`.
class PayrollExportFailed extends Data.TaggedError("PayrollExportFailed")<{
  readonly batchId: string
  readonly cause: unknown
}> {}

declare const pushBatch: (batchId: string, signal: AbortSignal) => Promise<void>

const exportBatch = (batchId: string) =>
  Effect.tryPromise({
    try: (signal) => pushBatch(batchId, signal),
    catch: (cause) => new PayrollExportFailed({ batchId, cause })
  })

const verifyLedger = Effect.fn("verifyLedger")(function*(ledgerId: string, checksumOk: boolean) {
  if (!checksumOk) return yield* new LedgerCorrupted({ ledgerId })
  return ledgerId
})
```

> **Warning:** `_tag` strings must be unique across every error that can meet in one union. `catchTag` and TypeScript narrowing both trust the tag, and nothing stops two classes from reusing one: they become indistinguishable, with no compiler or runtime warning. Namespace tags that cross package boundaries (`"Payroll/ExportFailed"`).

Use when you need value objects, discriminated unions with tidy constructors and a built-in matcher, or lightweight tagged errors.

Official guides: [Data](https://effect.website/docs/v4/data-types/data), [Yieldable Errors](https://effect.website/docs/v4/error-management/yieldable-errors).

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

## The three failure buckets

> **Tip:** **Expected** problems (not found, out of band, budget exceeded) belong in the typed `E` channel as tagged errors you `catchTag`. **Unexpected** problems (bugs, "impossible" states) should be defects — surface them via `Cause`/`ErrorReporter` rather than modeling as recoverable errors.

| Bucket | How it arises | Where it shows up | Who may recover | What a test asserts |
| --- | --- | --- | --- | --- |
| Typed failure | `Effect.fail`, yielding an error instance, `Effect.try` / `tryPromise` (the `{ try, catch }` form fails with what `catch` returns; the direct function form fails with `Cause.UnknownError`), a failed decode | `E`, and a `Fail` reason in the `Cause` | the narrowest owner with a meaningful policy (`catchTag`, `Effect.match`) | the tag **and** the fields, through `Exit.findErrorOption(exit)` |
| Defect | `Effect.die`, `Effect.orDie`, a throw inside `Effect.sync`, a rejection inside `Effect.promise` | not in `E`; a `Die` reason | a process or request boundary that reports it (`ErrorReporter`, `tapDefect`, `catchDefect`) | `Exit.hasDies(exit)`, and that `Exit.findErrorOption(exit)` is `None` |
| Interruption | timeout, race loser, `Fiber.interrupt`, a closing scope, a host signal | not in `E`; an `Interrupt` reason | nobody: finalizers run and it propagates | `Exit.hasInterrupts(exit)` plus the cleanup effect, never a domain tag |

`Exit.findErrorOption` returns `None` for defects and interruptions, so a typed-failure assertion cannot accept a defect by accident. Two gotchas: **retrying or defaulting a defect hides a bug**, and **translating interruption into a user-facing error** creates noise and can block shutdown. Where a boundary must survive a defect (a plugin host, a per-job worker), `Effect.catchDefect` should recover only the defect it recognizes and re-raise the rest with `Effect.die(defect)`. The testing deep dive shows these assertions in context: [Assert typed failures as data](../deep-dives/testing-an-effect-application#assert-typed-failures-as-data). For symptoms and fixes, see [Typed failure versus defect and interruption](../troubleshooting/troubleshooting-and-anti-patterns#typed-failure-versus-defect-and-interruption).
