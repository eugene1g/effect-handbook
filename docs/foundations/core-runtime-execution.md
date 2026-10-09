# Core Runtime & Execution

`Effect` is not a running program — it's a description. The runtime spins up **fibers** to execute descriptions, **scopes** bound resource lifetimes, and a finished computation returns an **Exit** carrying a full **Cause**. Build a value of type `Effect<A, E, R>` by composing combinators; nothing runs until you execute it. Running forks a root fiber that may fork children, await deferreds, race siblings, or open scopes. When it finishes it produces an `Exit<A, E>` — either `Success<A>` or `Failure` holding a `Cause<E>` recording everything that went wrong (typed errors, defects, interruptions).

**This page covers building and combining Effects.** How they run — `Exit` and `Cause`, fibers and their handles, `Scope`, the scheduler and clock, `Deferred`, `Latch`, and `ManagedRuntime` — is on [Fibers, Scopes & Runtimes](fibers-scopes-runtimes).

> **Official examples:** The release-matched `ai-docs` corpus has runnable examples for [Effect basics](https://github.com/Effect-TS/effect/tree/effect%404.0.2/ai-docs/src/01_effect/01_basics), [resource safety](https://github.com/Effect-TS/effect/tree/effect%404.0.2/ai-docs/src/01_effect/05_resources), [running programs](https://github.com/Effect-TS/effect/tree/effect%404.0.2/ai-docs/src/01_effect/06_running), and [ManagedRuntime integration](https://github.com/Effect-TS/effect/tree/effect%404.0.2/ai-docs/src/04_integration).

> **Official guides:** [Creating Effects](https://effect.website/docs/v4/getting-started/creating-effects), [Running Effects](https://effect.website/docs/v4/getting-started/running-effects) (its `runFork` text still names a `RuntimeFiber` return type; `Effect.runFork` returns `Fiber`). These guides track Effect's `main` branch rather than the tagged `4.0.2` release, so where they differ, this page and the tagged source win.

## Effect

`effect/Effect` — stable

`Effect<A, E, R>` is a lazy, immutable description of a computation that yields an `A`, may fail with typed `E`, and requires services `R`. Think of it as program-as-data: you assemble a recipe and the runtime executes it. That indirection enables typed errors, dependency injection, retries, interruption, and tracing as ordinary composition.

**Read the three slots honestly.** `A` is what success returns, `E` lists the failures the program *chose to model*, and `R` lists what must still be provided. **`E = never` means "no modeled failure is left", not "cannot go wrong"**: defects (a throw inside `Effect.sync`, a bug in a finalizer) and interruption exist for every effect and travel in the [Cause](fibers-scopes-runtimes#cause), never in `E`. The types make the operational questions visible — what fails, what it needs, who can cancel it — but they do not prove that a timeout value or a retry rule is the right policy. When a channel has to be named, extract it from the inferred type: `Effect.Success<typeof program>`, `Effect.Error<typeof program>`, `Effect.Services<typeof program>`.

**The ownership habit.** For anything that runs or holds a resource, ask three questions: *who closes it, what bounds it, and what runs when it loses?* The answers are a `Scope` owner ([section 6](#6-interruption-resource-safety)), a fork owner ([Fiber](fibers-scopes-runtimes#fiber)), a `{ concurrency }` bound ([section 4](#4-concurrency)), and a finalizer.

### 1. Creating effects

Pull values, sync code, promises, nullables, and callback APIs into the Effect world. Note `Effect.callback` (v4's name — not `async`) and `Effect.tryPromise` for fallible promises.

**Choose the constructor by the JavaScript convention being wrapped** — how the foreign code reports failure and when it does its work — not by which one makes `E` smallest. A constructor is an assertion about the wrapped code: `sync` and `promise` assert "this cannot throw or reject", so when it does anyway the failure is a defect, invisible in `E`.

| You are wrapping | Constructor | A throw or rejection becomes |
| --- | --- | --- |
| A value you already hold | `Effect.succeed(value)` | not applicable — the argument is evaluated eagerly (see the warning below) |
| A known failure | `Effect.fail(error)`, or `yield* new MyError(...)` | not applicable; `Effect.failSync(() => error)` when building the error is itself work |
| Synchronous code that cannot throw | `Effect.sync(() => ...)` | a **defect** |
| Synchronous code that can throw (`JSON.parse`, `new URL`) | `Effect.try({ try, catch })` | the typed error `catch` returns; the bare-thunk form `Effect.try(() => ...)` yields `Cause.UnknownError` |
| A Promise that is not expected to reject | `Effect.promise((signal) => ...)` | a **defect** |
| A Promise that can reject (`fetch`, SDK calls) | `Effect.tryPromise({ try: (signal) => ..., catch })` | the typed error `catch` returns (`Cause.UnknownError` for the bare-thunk form); a synchronous throw while creating the Promise goes through the same `catch` |
| A one-shot callback API | `Effect.callback<A, E>((resume, signal) => ...)` | whatever you pass to `resume`; only the first `resume` call counts |
| "Building the next effect is itself work" — recursion, a mutable read, branches of different effect types | `Effect.suspend(() => effect)` | a **defect** if the thunk throws |
| An `Option`, `Result`, or nullable value | `Effect.fromOption`, `Effect.fromResult`, `Effect.fromNullishOr` | not applicable |

`Effect.promise(() => fetch(url))` is the classic misuse: it claims the network cannot fail and silently moves every outage out of the typed channel. For `Effect.try` and `Effect.tryPromise`, the bare-thunk form always has `E = Cause.UnknownError` and the `{ try, catch }` form has exactly the type `catch` returns; there is no overload for an explicit two-type-argument call on the bare form, nor for an argument that is a union of both forms — write `{ try, catch }` with a real mapper instead.

> **Warning:** **Arguments are evaluated before the call.** `Effect.succeed(Date.now())`, `Effect.succeed(counter.next())`, and `Effect.fail(buildError())` do their work while the program is being *built*, and every run — and every retry — replays that one captured value. Symptoms: stale timestamps, work that "already happened" before anything ran, retries that reuse the first result. Use `Effect.sync` / `Effect.try` when the work must happen at run time, and `Effect.suspend` when even *choosing* the next effect must wait. The same trap applies to any helper that takes a value instead of a thunk. A cheap regression test: build the effect, assert the spy count is 0, run it, assert 1.

`Effect.fromOption(option, onNone?)` lifts an `Option`; without the callback it fails with `NoSuchElementError`, while `onNone` lets the boundary produce a custom typed error lazily.

```ts
import { Effect, Schema } from "effect"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {
  endpoint: Schema.String,
  cause: Schema.Defect()
}) {}

class InvalidBandFile extends Schema.TaggedError<InvalidBandFile>()("InvalidBandFile", {
  cause: Schema.Defect()
}) {}

const fromValue = Effect.succeed({ cycle: "2026-MERIT" })          // already have it
const fromSync = Effect.sync(() => crypto.randomUUID())            // side effect that cannot throw
const fromEnv = Effect.fromNullishOr(process.env.HRIS_BASE_URL)   // -> fails NoSuchElementError if unset

// Synchronous code that can throw: the throw becomes a typed failure.
const parseBandFile = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new InvalidBandFile({ cause })
  })

// Promise that can reject. The Promise is created inside the thunk (so nothing starts
// until the effect runs) and the supplied signal is forwarded, so a timeout, a lost
// race, or a shutdown aborts the HTTP request instead of abandoning it.
const fetchEmployee = Effect.fn("fetchEmployee")((id: string) =>
  Effect.tryPromise({
    try: (signal) => fetch(`/hris/employees/${id}`, { signal }).then((r) => r.json()),
    catch: (cause) => new HrisUnavailable({ endpoint: `/hris/employees/${id}`, cause })
  })
)

// Callback-style async: resume once, return a finalizer for interruption.
// e.g. a payroll webhook that fires once the nightly run settles.
const awaitPayrollAck = Effect.callback<string>((resume) => {
  const id = setTimeout(() => resume(Effect.succeed("ack:run-2026-06")), 10)
  return Effect.sync(() => clearTimeout(id))
})
```

`Effect.callback` details: only the first `resume(...)` counts (later calls are ignored, so a multi-event source needs a `Queue` or [`Stream.callback`](../concurrency/streaming-channels) instead); the register function also receives an `AbortSignal` as its second argument; and the type parameters usually have to be written out because nothing in the body lets TypeScript infer them. Adapters that must be cancellable are covered in [section 8](#8-cancellable-adapters-for-promises-and-callbacks).

**Deferring construction with `Effect.suspend`.** Three situations need it: an expression that would otherwise be captured once while building (a counter, a mutable lookup); a recursive function that would build its whole tree of effects before anything runs; and a function whose branches return differently typed effects, which `suspend` unifies into one `Effect<A, E, R>`.

```ts
import { Effect } from "effect"

let attempts = 0
const captured = Effect.succeed(++attempts)                      // incremented once, while building
const perRun = Effect.suspend(() => Effect.succeed(++attempts))  // incremented on every run

// Recursion: each level is built only when the previous one runs.
const vestedAfter = (quarters: number): Effect.Effect<number> =>
  quarters === 0
    ? Effect.succeed(0)
    : Effect.suspend(() => vestedAfter(quarters - 1)).pipe(Effect.map((shares) => shares + 250))
```

### 2. Sequencing with gen & fn

Generators are the imperative-looking glue. Use `Effect.gen` inline; use `Effect.fn("name")` for functions that return an effect — it adds a tracing span and clean stack traces. Always `return yield*` a terminal effect so TypeScript knows the function stops there.

```ts
import { Effect, Schema } from "effect"

class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()(
  "BudgetExceeded",
  { remaining: Schema.Finite, requested: Schema.Finite }
) {}

// A traced, reusable effect-returning function. Note: do NOT .pipe an Effect.fn —
// pass extra combinators as further arguments instead.
// Draw a raise down against the remaining merit-budget pool.
export const drawDownBudget = Effect.fn("drawDownBudget")(
  function*(remaining: number, raiseAmount: number) {
    if (raiseAmount > remaining) {
      return yield* new BudgetExceeded({ remaining, requested: raiseAmount })
    }
    yield* Effect.log(`Approving raise of ${raiseAmount} from pool`)
    return remaining - raiseAmount
  }
)
```

> **Tip:** **gen vs. fn vs. fnUntraced.** Use `Effect.gen` for one-off inline composition. Use `Effect.fn("name")` for any function called from elsewhere — the span name is valuable in traces. Drop to `Effect.fnUntraced` only on genuinely hot paths where per-call span overhead shows up in a profile.

**Pipeline combinators have different jobs.** Each is dual, so `Effect.map(self, f)`, `pipe(self, Effect.map(f))`, and `self.pipe(Effect.map(f))` are the same thing. Use a pipeline when every step can be named inline, and switch to `Effect.gen` once several intermediate values are needed — the execution model is identical.

| Combinator | Give it | Success value afterwards | Typical mistake |
| --- | --- | --- | --- |
| `Effect.map(f)` | a plain function `A => B` | `B` | passing an effect-returning function: the result is a nested `Effect` that never runs |
| `Effect.flatMap(f)` | `A => Effect<B>` | `B` | — |
| `Effect.andThen(next)` | an effect, or `A => Effect<B>` | `B` | passing a plain value, Promise, `Option`, or `Result` — only the two forms on the left have overloads |
| `Effect.tap(f)` | an effect, or `A => Effect<X>` | the original `A` (a failing tap still fails the pipeline) | using `tap` to "change" the value: it is silently unchanged |
| `Effect.as(value)` / `Effect.asVoid` | a constant / nothing | `value` / `void` | — |

An effect that is created inside a callback but neither returned nor chained is silently dropped — the pipeline form of [“My Effect never ran”](../troubleshooting/troubleshooting-and-anti-patterns).

> **Note:** **Yield descriptions, not handles.** Inside `Effect.gen` you can `yield*` an `Effect`, an `Exit`, a `Context.Service` key or `Context.Reference`, a `Config`, and a yieldable error (`Schema.TaggedError`, `Data.TaggedError`, the built-in `Cause.*Error` classes). Runtime handles and plain data types are **not** effects: for a `Fiber`, `Ref`, `Deferred`, `Option`, or `Result` use `Fiber.join`, `Ref.get`, `Deferred.await`, `Effect.fromOption`, or `Effect.fromResult`. `yield* someOption` is a type error, and forcing it past the compiler dies with `Not a valid effect`. (`Option` and `Result` keep their iterators for `Option.gen` / `Result.gen`.)

Generator functions do not inherit `this`. In a class method, bind it with the options overload instead of aliasing `const self = this`: `Effect.gen({ self: this }, function*() { return this.cycleId })`.

**Do notation is the pipe-only equivalent.** You will meet `Effect.Do` with `Effect.bind` / `Effect.bindTo` / `Effect.let` in migrated code and in other modules. Each step adds a named field to a growing record (a repeated name replaces the field); later steps receive the whole record. The handbook standardizes on `Effect.gen` because it is flat, uses native control flow, and needs no record threading.

```ts
import { Effect } from "effect"

declare const loadBaseSalary: Effect.Effect<number>
declare const loadMeritRate: Effect.Effect<number>

const viaDo = Effect.Do.pipe(
  Effect.bind("base", () => loadBaseSalary),
  Effect.bind("rate", () => loadMeritRate),
  Effect.let("raise", ({ base, rate }) => base * rate),
  Effect.map(({ base, raise }) => base + raise)
)

const viaGen = Effect.gen(function*() {
  const base = yield* loadBaseSalary
  const rate = yield* loadMeritRate
  return base + base * rate
})
```

Official guides: [Using Generators](https://effect.website/docs/v4/getting-started/using-generators), [Building Pipelines](https://effect.website/docs/v4/getting-started/building-pipelines) (it says `Option` and `Result` can be yielded inside `Effect.gen`; they cannot), [Simplifying Excessive Nesting](https://effect.website/docs/v4/code-style/do).

### 3. Error handling

Errors live in the typed `E` channel. Recover with `Effect.catch`, narrow by tag with `catchTag`/`catchTags`, or reach for the cause with `catchCause`/`catchDefect`. Convert a failure into a value with `Effect.result`.

```ts
import { Effect } from "effect"
import type { EmployeeNotFound, BandViolation } from "./errors.ts"

declare const proposeRaise: (
  employeeId: string
) => Effect.Effect<number, EmployeeNotFound | BandViolation>

const recommendation = proposeRaise("emp_142").pipe(
  // Catch several tags at once, each handler narrowed to its error type.
  Effect.catchTags({
    EmployeeNotFound: () => Effect.succeed(0),       // no employee, no raise
    BandViolation: (e) => Effect.fail(e)             // re-raise: a comp analyst must review
  }),
  // Final safety net for anything still in the error channel.
  Effect.catch(() => Effect.succeed(0))
)

// `Effect.result` moves the failure into a value so you can branch on it.
// Result.Success carries the value in `.success` (not `.value`).
const inspected = Effect.gen(function*() {
  const result = yield* Effect.result(proposeRaise("emp_999"))
  return result._tag === "Success" ? result.success : -1
})
```

**Tagged reasons.** When one error wraps several distinct causes, model the cause as a `reason` field typed as a `Schema.Union` of tagged errors. Recover at the reason level without unpacking the parent: `Effect.catchReason` handles one reason tag (with an optional catch-all), `Effect.catchReasons` handles several at once, and `Effect.unwrapReason` lifts the reasons into the error channel so `catchTag`/`catchTags` apply.

```ts
import { Effect, Schema } from "effect"

// A tagged error whose `reason` is itself a tagged union — the v4 idiom for an
// error that wraps several distinct failure causes.
class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", { retryAfter: Schema.Natural }) {}
class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()("QuotaExceeded", { limit: Schema.Natural }) {}
class HrisError extends Schema.TaggedError<HrisError>()("HrisError", {
  reason: Schema.Union([RateLimited, QuotaExceeded])
}) {}

declare const fetchRoster: Effect.Effect<ReadonlyArray<string>, HrisError>

// catchReason: handle ONE reason tag, with an optional catch-all for the rest.
const oneReason = fetchRoster.pipe(
  Effect.catchReason(
    "HrisError",                                                 // parent error _tag
    "RateLimited",                                               // reason _tag
    (reason) => Effect.succeed([`retry after ${reason.retryAfter}s`]),
    (reason) => Effect.succeed([`HRIS failed: ${reason._tag}`])  // optional catch-all
  )
)

// catchReasons: handle SEVERAL reason tags at once.
const manyReasons = fetchRoster.pipe(
  Effect.catchReasons("HrisError", {
    RateLimited: (reason) => Effect.succeed([`retry after ${reason.retryAfter}s`]),
    QuotaExceeded: (reason) => Effect.succeed([`quota ${reason.limit} hit`])
  })
)

// unwrapReason: lift the reasons into the error channel, then use catchTags.
const unwrapped = fetchRoster.pipe(
  Effect.unwrapReason("HrisError"),
  Effect.catchTags({
    RateLimited: (reason) => Effect.succeed([`back off ${reason.retryAfter}s`]),
    QuotaExceeded: (reason) => Effect.succeed([`raise quota past ${reason.limit}`])
  })
)
```

This section is a summary. The full recovery toolkit — accumulation, folding with `Effect.match`, `mapError`, fallbacks, `ignore` versus `ignoreCause`, and when an outcome is a result rather than a failure — lives in [Errors, Option & Result](../foundations/errors-option-result#effect-error-handling). One fact belongs here because it is about the runtime's `Cause`: typed handlers such as `Effect.catch`, `catchTag`, and `orDie` act on the *first* typed failure they find and replace the **whole** cause with the handler's result, so a defect or interruption recorded next to that failure is dropped — see [recovering from a mixed Cause](fibers-scopes-runtimes#recovering-from-a-mixed-cause).

Official guide: [Expected Errors](https://effect.website/docs/v4/error-management/expected-errors) (it defines errors with `Data.TaggedError`; the handbook's house style is `Schema.TaggedError`, and both are valid constructors).

### 4. Concurrency

Most combinators take a `{ concurrency }` option. `"unbounded"` runs everything at once; a number caps in-flight work; the default is sequential. `Types.Concurrency` is exactly `number | "unbounded"`; there is no `"inherit"` mode.

```ts
import { Effect } from "effect"

declare const employeeIds: ReadonlyArray<string>
declare const loadCompBand: (id: string) => Effect.Effect<{ mid: number }>

// Sequential (default): one at a time.
const serial = Effect.forEach(employeeIds, loadCompBand)

// Bounded: at most 10 in flight — kind to the HRIS rate limit.
const bounded = Effect.forEach(employeeIds, loadCompBand, { concurrency: 10 })

// Unbounded: all at once.
const all = Effect.forEach(employeeIds, loadCompBand, { concurrency: "unbounded" })

// Fire-and-collect a heterogeneous bundle; first failure interrupts the rest.
const bundle = Effect.all([loadCompBand("emp_1"), loadCompBand("emp_2")], { concurrency: 2 })
```

**The `Effect.all` contract.** Do not read it as `Promise.all` (eager and unbounded) or as `Promise.allSettled` (accumulating): it is lazy, sequential unless told otherwise, and fail-fast unless told otherwise.

| Facet | Contract |
| --- | --- |
| Shape | A tuple returns a tuple, an iterable returns an array, and a record of effects returns a record with the same keys. Positions and keys follow the *input*, even when a later member finishes first. Prefer the record form for unrelated inputs — there is no positional destructuring to get wrong. |
| Default mode | **Fail-fast, no partial results.** Sequentially, members after the first failure never start; concurrently, the first failure interrupts the siblings still running. The resulting `Cause` holds that first failure only. |
| `{ mode: "result" }` | Runs every member and returns a `Result` per slot, so the combined effect has `E = never`. The only modes are `"default"` and `"result"`. |
| `{ discard: true }` | Side effects only: the result is `void` and no collection is built. |
| Accumulating over a collection | `Effect.partition(items, f)` never fails and returns `[successes, failures]`; `Effect.validate(items, f)` fails with a non-empty array of *every* error. Both are covered in [Errors, Option & Result](../foundations/errors-option-result#effect-error-handling). |

```ts
import { Effect } from "effect"

declare const loadBand: Effect.Effect<{ readonly mid: number }, "BandMissing">
declare const loadBudget: Effect.Effect<number, "BudgetMissing">

// Record in, record out.
const inputs = Effect.all({ band: loadBand, budget: loadBudget }, { concurrency: 2 })
// Effect<{ band: { readonly mid: number }; budget: number }, "BandMissing" | "BudgetMissing">

// Run every slot and keep each outcome; this effect cannot fail.
const outcomes = Effect.all([loadBand, loadBudget], { mode: "result" })
// Effect<[Result<{ readonly mid: number }, "BandMissing">, Result<number, "BudgetMissing">]>

// Side effects only.
const announce = Effect.all([Effect.log("cycle open"), Effect.log("budget loaded")], { discard: true })
```

For exactly two effects, `Effect.zip(a, b)` returns the pair and `Effect.zipWith(a, b, f)` combines them; both are sequential unless you pass `{ concurrent: true }` (a boolean — not the `concurrency` option used elsewhere). `Effect.zipLeft` / `zipRight` no longer exist; see [section 9](#9-branching-and-looping).

Official guide: [Basic Concurrency](https://effect.website/docs/v4/concurrency/basic-concurrency) (its printed `Cause` output shows nested `Parallel` / `Sequential` nodes; a `Cause` here is flat — see [Cause](fibers-scopes-runtimes#cause)). The guide for `zip`, `forEach`, and `all` shapes is linked from [section 9](#9-branching-and-looping).

### 5. Racing & timeouts

`Effect.race` returns the first *success* and interrupts the loser; `raceFirst` lets the first *completion* (success or failure) win. `Effect.timeout` fails with `Cause.TimeoutError`; `timeoutOption` gives `Option.none` instead; `timeoutOrElse` runs a fallback.

```ts
import { Effect } from "effect"

declare const livePayBand: Effect.Effect<number>
declare const cachedPayBand: Effect.Effect<number>

// Whichever source answers first wins; the other is interrupted —
// the live HRIS and a warm replica race for the band midpoint.
const fastest = Effect.race(livePayBand, cachedPayBand)

// Bound a flaky HRIS call; on timeout, fall back to last night's snapshot.
const guarded = livePayBand.pipe(
  Effect.timeoutOrElse({
    duration: "2 seconds",
    orElse: () => Effect.succeed(150_000) // cached midpoint
  })
)
```

**Race semantics, precisely.**

| Operator | Who wins | When every contender fails | Losers |
| --- | --- | --- | --- |
| `Effect.race(a, b)` / `Effect.raceAll([...])` | the first **success** — an early failure does not end the race | fails with one flat `Cause` holding every contender's failure reasons | interrupted, and the race result is delivered only after their finalizers finish |
| `Effect.raceFirst(a, b)` / `Effect.raceAllFirst([...])` | the first **completion**, success or failure | not applicable — the first failure already won | same as above |

`race` is `raceAll` with two members, and `raceFirst` is `raceAllFirst` with two. Because losers are *interrupted*, a branch that owns a resource must be interruptible and finalizer-backed, and a slow loser finalizer delays the winner's result. Interruption reaches every loser even if the race settles (or is itself interrupted) while some contenders are still starting — none are left running unsupervised. Every race function accepts `{ onWinner }`, a purely observational callback receiving `{ fiber, index, parentFiber }` — useful for a "which replica answered" metric. Wrap each side in `Effect.result` when you want the first *settled* outcome as a value.

**Timeout semantics.** All three operators interrupt the source when the deadline passes and wait for that interruption — including the source's finalizers — before continuing. `Effect.timeoutOrElse` evaluates its fallback only after the source has finished interrupting, in the caller's fiber, so the fallback never overlaps the source's cleanup. A source failure that happens before the deadline is preserved as-is by all three, and `Effect.timeoutOption` maps *only* the timeout to `Option.none()` — typed failures stay in `E`, so it is not a failure suppressor. There is no `timeoutFail` / `timeoutFailCause` / `timeoutTo`: to surface a domain error, fail from `orElse` (reserve `Effect.die` there for invariant violations).

```ts
import { Effect, Schema } from "effect"

class HrisTimeout extends Schema.TaggedError<HrisTimeout>()("HrisTimeout", {
  afterMillis: Schema.Int
}) {}

declare const primaryBand: Effect.Effect<number, "PrimaryDown">
declare const replicaBand: Effect.Effect<number, "ReplicaDown">

// First success wins; a replica that fails fast does not end the race.
const fastestBand = Effect.raceAll([primaryBand, replicaBand], {
  onWinner: ({ index }) => console.log(`band source #${index} answered first`)
})

// A domain error instead of Cause.TimeoutError.
const bounded = fastestBand.pipe(
  Effect.timeoutOrElse({
    duration: "2 seconds",
    orElse: () => Effect.fail(new HrisTimeout({ afterMillis: 2000 }))
  })
) // Effect<number, "PrimaryDown" | "ReplicaDown" | HrisTimeout>
```

> **Warning:** A deadline can only fire where the fiber can be interrupted. A long synchronous section (a tight loop, a large `JSON.parse`) runs to completion — and can even beat the deadline it overran — before `Effect.timeout` can act, and an interrupted adapter that ignores its `AbortSignal` leaves the foreign work running — see [section 8](#8-cancellable-adapters-for-promises-and-callbacks).

Official guides: [Timing Out](https://effect.website/docs/v4/error-management/timing-out), [Basic Concurrency](https://effect.website/docs/v4/concurrency/basic-concurrency) (it says an all-failing `raceAll` fails with the last error; it instead fails with one `Cause` collecting every contender's failure reasons).

### 6. Interruption & resource safety

Interruption is cooperative and first-class. `Effect.uninterruptible` protects a critical section; `uninterruptibleMask` provides a `restore` to re-open windows inside it. `Effect.acquireRelease` guarantees cleanup runs on *any* exit — success, failure, or interruption. `ensuring` attaches an unconditional finalizer.

```ts
import { Effect } from "effect"

declare const openHrisConnection: Effect.Effect<{
  close: () => void
  query: (sql: string) => string
}>

// Acquire/release ties cleanup to the surrounding scope. Requires Scope,
// so run it under Effect.scoped (or a Layer).
const readHeadcount = Effect.gen(function*() {
  const conn = yield* Effect.acquireRelease(
    openHrisConnection,
    (c) => Effect.sync(() => c.close()) // always runs, even if a review is interrupted
  )
  return conn.query("SELECT count(*) FROM employees")
}).pipe(Effect.scoped)
```

**What `try` / `finally` cannot do.** `finally` protects only code that runs after `try` was entered, so setup between "acquire" and `try` leaks; a throwing cleanup replaces the original error; and nothing runs at all when the caller simply abandons the Promise. Effect's brackets close all three gaps, and they also run on interruption.

**Choose the bracket by the lifetime's shape, then name the owner.**

| Lifetime shape | Tool | Who closes it | May cleanup fail in `E`? |
| --- | --- | --- | --- |
| Exactly one operation; the handle must not escape | `Effect.acquireUseRelease(acquire, use, release)` | the bracket, as soon as `use` ends | yes — `release` receives `use`'s `Exit` and may fail |
| Acquire now, use across several later steps | `Effect.acquireRelease(acquire, release)`, which adds `Scope` to `R` | whoever discharges `Scope`: `Effect.scoped`, a Layer build, or a manually closed scope | no — the release effect's error type is `never` |
| The whole application (pool, client, exporter) | `Layer.effect(Service, ...)` whose build uses `acquireRelease` | the layer's scope: `Layer.launch` under `runMain`, `ManagedRuntime.dispose()`, or the test layer's teardown | no |
| Cleanup around existing work, no resource value | `Effect.ensuring(finalizer)` | runs when the wrapped effect ends | no |
| Cleanup that depends on the outcome | `Effect.onExit`, `Effect.onError`, `Effect.onInterrupt` | runs when the wrapped effect ends | `onExit` and `onInterrupt` yes; `onError` no |
| Register cleanup in the current scope without a resource value | `Effect.addFinalizer((exit) => ...)` | the scope's owner | no |

**`Scope` still in `R` means nobody owns the resource yet.** `acquireRelease` registers cleanup but does not decide who closes it; the requirement stays in the type until an owner discharges it. Read a signature such as `Effect<Conn, never, Scope>` as "a connection whose lifetime the caller must choose".

| Finalizer | Runs on | Receives |
| --- | --- | --- |
| `Effect.ensuring(fin)` | every outcome | nothing — it cannot tell how the work ended |
| `Effect.onExit((exit) => ...)` | every outcome | the full `Exit<A, E>` |
| `Effect.onError((cause) => ...)` | typed failure, defect, or interruption | the `Cause<E>` |
| `Effect.onInterrupt((ids) => ...)` | interruption only | the `ReadonlySet<number>` of interrupting fiber ids |
| `Effect.addFinalizer((exit) => ...)`, or the `release` of `acquireRelease` | the owning scope closing | the `Exit` that closed the scope |

```ts
import { Effect, Exit } from "effect"

declare const openLedgerTx: Effect.Effect<{
  readonly post: (entry: string) => Effect.Effect<void, "LedgerDown">
  readonly commit: Effect.Effect<void>
  readonly rollback: Effect.Effect<void>
}>

// One operation; the handle cannot escape; release sees how `use` ended.
const postRaise = Effect.acquireUseRelease(
  openLedgerTx,
  (tx) => tx.post("raise:emp_142:8500"),
  (tx, exit) => (Exit.isSuccess(exit) ? tx.commit : tx.rollback)
)

declare const settlePayroll: Effect.Effect<number, "LedgerDown">

const audited = settlePayroll.pipe(
  Effect.onInterrupt(() => Effect.logWarning("payroll run cancelled")),               // interruption only
  Effect.onError((cause) => Effect.logError("payroll run did not complete", cause)),  // anything but success
  Effect.onExit((exit) => Effect.logInfo(`payroll run finished: ${exit._tag}`)),      // always, with the Exit
  Effect.ensuring(Effect.logDebug("run lock released"))                               // always, outcome unknown
)
```

Facts that decide correctness:

- **Finalizers of a scope run in reverse registration order**, so a dependent resource closes while the thing it depends on is still alive (`Scope.make("parallel")` opts into concurrent finalization).
- **The acquire step is uninterruptible by default** (`{ interruptible: true }` opts out), so a resource is never half-acquired without its finalizer registered. Finalizers also run uninterruptibly: an unbounded finalizer is an unbounded shutdown.
- **Release is registered only after `acquire` succeeds.** If one acquire effect allocates two things and fails on the second, nothing releases the first. Give each allocation its own `acquireRelease` (the earlier one then unwinds when the later one fails) or make the acquire effect roll back its own partial work. The same applies inside a `Layer.effect` build.
- **`Effect.acquireUseRelease` releases even when `use` throws synchronously** before returning an effect; the throw becomes a defect.
- **Cleanup attached with `Effect.tap` or `Effect.andThen` is success-only.** It passes every happy-path test and leaks on failure and interruption.
- **Compare interrupted exits with `Exit.hasInterrupts(exit)`**, not structural equality — the cause carries a fiber id. `Effect.interrupt` is how a fiber cancels itself.

```ts
import { Effect } from "effect"

interface Cursor {
  readonly readAll: Effect.Effect<ReadonlyArray<string>>
  readonly close: Effect.Effect<void>
}
declare const openPool: Effect.Effect<{
  readonly openCursor: Effect.Effect<Cursor, "CursorLimit">
  readonly close: Effect.Effect<void>
}>

// One acquireRelease per allocation: if `openCursor` fails, the pool is still released.
const exportRoster = Effect.gen(function*() {
  const pool = yield* Effect.acquireRelease(openPool, (p) => p.close)             // registered first, closed last
  const cursor = yield* Effect.acquireRelease(pool.openCursor, (c) => c.close)    // closed first, pool still alive
  return yield* cursor.readAll
}).pipe(Effect.scoped)
```

**Limits of cooperative interruption.** User code never polls a cancellation flag: an interruptible fiber that is suspended — sleeping, awaiting a callback, waiting on a queue — is resumed with the interruption at once, and code opts out only by marking a region `uninterruptible`. Two things interruption cannot do: pre-empt a long *synchronous* section (a tight loop or a large `JSON.parse` finishes first), and force an uncooperative external system to stop — that needs a real cancel mechanism such as the `AbortSignal` in [section 8](#8-cancellable-adapters-for-promises-and-callbacks), a driver-level cancel, or a process kill. What to do when the cleanup itself can fail is [section 10](#10-when-cleanup-can-fail); manual scopes and finalizer order are under [Scope](fibers-scopes-runtimes#scope). For the full startup, readiness, and shutdown story see [Owning Lifetimes — Startup, Readiness, and Shutdown](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown).

Official guide: [Resource Management: Introduction](https://effect.website/docs/v4/resource-management/introduction).

### 7. Sequential folds and context control

`Effect.reduce(iterable, () => zero, step)` is the effectful, strictly sequential fold: the lazy seed is rebuilt on every run, the step receives its zero-based index, and the first failure stops later steps. For context, `provideContext` satisfies part of an environment while retaining unrelated outer services; `setContext` replaces the wrapped effect's **entire** environment with an already-complete `Context`. `updateServiceScoped(Service, f, { reset? })` temporarily updates a service until scope close and can merge the original, updated, and then-current values while restoring it.

Two small accessors round this out: `Effect.withFiberSucceed((fiber) => value)` computes a value from the current fiber without building an effect (the effectful sibling is `Effect.withFiber`), and `Effect.head(effect)` takes the first element of an effect's iterable result, failing with `Cause.NoSuchElementError` when it is empty.

### 8. Cancellable adapters for promises and callbacks

Interruption stops the *fiber*. The socket, query, timer, or child process behind an adapter keeps running — and keeps holding its connection or quota — unless the adapter tells the foreign API to stop. Deadlines, races, and structured shutdown are only as good as the leaf adapters, so the chain must be unbroken: host signal → root fiber interruption → the adapter's `AbortSignal` → foreign cancel → finalizers.

- **Create the Promise inside the thunk and forward the `signal`.** `Effect.tryPromise` and `Effect.promise` hand the thunk an `AbortSignal` that is aborted when the fiber is interrupted (timeout, lost race, scope close, shutdown). The `AbortController` is allocated only when the thunk declares the parameter, so an adapter written as `() => fetch(url)` costs nothing and cancels nothing.
- **For callback APIs, pass the `signal` or return a cleanup effect.** `Effect.callback`'s register function receives `(resume, signal)`; for APIs without abort support, return an `Effect<void>` that detaches the listener or clears the timer.
- **Keep cancellation as cancellation.** Interrupting a `tryPromise` produces an interrupt-only `Cause`. The `catch` mapper may still be invoked for the resulting `AbortError`, but its value is discarded — so keep `catch` a pure mapping with no logging or metrics. Hand-written adapters must preserve this: an abort is never a `RequestFailed`, never a retry trigger, and never logged as a fault by default.
- **Let `Effect.timeout` own the deadline.** A second wall-clock timer inside the adapter (`setTimeout`, `AbortSignal.timeout`) cannot be driven by `TestClock` and races the outer deadline.
- **If the adapter accepts an external signal, check `signal.aborted` first** and refuse before starting transport work.
- **A foreign Promise is a trust boundary.** Whatever it rejects with is `unknown`. Mapping all of it to one domain error makes a `TypeError` inside the adapter indistinguishable from an expected outage, and a retry policy will then happily retry a bug. Recognize the failures the contract allows and `Effect.die` the rest.
- **Interrupting `tryPromise` does not wait for the Promise to settle.** It aborts the signal and continues immediately. When the next step must not overlap the previous attempt's teardown (a retry after a timeout, releasing a lock), build the adapter with `Effect.callback` and return a cleanup effect that awaits settlement; `Fiber.interrupt`, `Effect.timeout`, and `Effect.race` then wait for it.

```ts
import { Effect, Schema } from "effect"

class PayrollApiDown extends Schema.TaggedError<PayrollApiDown>()("PayrollApiDown", {
  status: Schema.Int
}) {}

class UnrecognizedSdkFailure extends Schema.TaggedError<UnrecognizedSdkFailure>()("UnrecognizedSdkFailure", {
  cause: Schema.Defect()
}) {}

interface Receipt {
  readonly receiptId: string
}
declare const payrollSdk: {
  submitRun(runId: string, options: { readonly signal: AbortSignal }): Promise<Receipt>
}
declare const isOutage: (cause: unknown) => cause is { readonly status: number }

// Promise adapter: lazy, abortable, and honest about what it recognizes.
const submitRun = Effect.fn("submitRun")((runId: string) =>
  Effect.tryPromise({
    try: (signal) => payrollSdk.submitRun(runId, { signal }),
    catch: (cause) =>
      isOutage(cause)
        ? new PayrollApiDown({ status: cause.status }) // allowed by the contract: stays typed
        : new UnrecognizedSdkFailure({ cause })
  }).pipe(
    // Anything the contract does not allow is a bug: a defect, invisible to retry policies.
    Effect.catchTag("UnrecognizedSdkFailure", (failure) => Effect.die(failure.cause))
  )
)

// Callback API that understands AbortSignal: the listener is removed on interruption.
const nextApproval = (bus: EventTarget) =>
  Effect.callback<Event>((resume, signal) => {
    bus.addEventListener("raise-approved", (event) => resume(Effect.succeed(event)), { once: true, signal })
  })

// Interruption completes only after the foreign Promise has settled.
const submitRunAndSettle = (runId: string) =>
  Effect.callback<Receipt, unknown>((resume, signal) => {
    const running = payrollSdk.submitRun(runId, { signal })
    running.then((receipt) => resume(Effect.succeed(receipt)), (cause) => resume(Effect.fail(cause)))
    return Effect.promise(() => running.then(() => undefined, () => undefined))
  })
```

`Effect.abortSignal` is the scope-bound variant — an `Effect<AbortSignal, never, Scope>` whose signal is aborted when the surrounding scope closes — for APIs that take a signal outside a Promise adapter, such as a long-lived subscription.

The host side of the same chain — turning a request's `AbortSignal` into fiber interruption with `{ signal }` — is in [section 11](#11-running-effects-at-an-owned-edge), with a complete walk-through in [Recipe: Request Cancellation Through a Host](../recipes/request-cancellation-through-a-host).

### 9. Branching and looping

Effect 4 keeps the control-flow surface small: **branch with ordinary `if` / ternaries and loop with ordinary `for` / `while` inside `Effect.gen` or `Effect.fn`**, and reach for an operator only when the *condition* is itself an effect. Coding agents routinely emit the operators below, which do not exist in Effect 4.

| Not in Effect 4 | Write instead |
| --- | --- |
| `Effect.if`, `Effect.unless` | a JavaScript conditional inside `Effect.gen`, or `Effect.suspend(() => cond ? a : b)` |
| `Effect.whenEffect`, `Effect.unlessEffect` | `Effect.when(self, conditionEffect)`; negate the condition for "unless" |
| `Effect.loop`, `Effect.iterate` | a `for` / `while` loop in `Effect.gen`; `Effect.forEach` or `Effect.reduce` for collections |
| `Effect.zipRight` | `Effect.andThen(next)` |
| `Effect.zipLeft` | `Effect.tap(next)`, or `Effect.zip` followed by `Effect.map` |

`Effect.when` takes an `Effect<boolean>` — not a boolean and not a thunk, so `Effect.when(() => cond)` does not type-check — and reports the skipped case as `Option.none()`, so its result type is `Option<A>`. `Effect.whileLoop({ while, body, step })` still exists, but it is a low-level primitive that returns `void`; prefer a generator loop.

```ts
import { Effect } from "effect"
import type { Option } from "effect"

declare const cycleIsFrozen: Effect.Effect<boolean>
declare const notifyManager: Effect.Effect<void>

// Plain condition and plain loop: ordinary JavaScript inside a generator.
const drawDown = Effect.fn("drawDown")(function*(pool: number, raises: ReadonlyArray<number>) {
  let remaining = pool
  for (const raise of raises) {
    if (raise > remaining) return yield* Effect.fail("OverBudget" as const)
    remaining -= raise
  }
  return remaining
})

// Effectful condition: a skip is Option.none(). This is the old `unlessEffect` shape.
const maybeNotified: Effect.Effect<Option.Option<void>> = notifyManager.pipe(
  Effect.when(Effect.map(cycleIsFrozen, (frozen) => !frozen))
)
```

Official guide: [Control Flow Operators](https://effect.website/docs/v4/code-style/control-flow) (its `whileLoop` signature block shows an `Effect.loop`-style shape; the real `whileLoop` takes `{ while, body, step }`, has no state, no result array, and no `discard`).

### 10. When cleanup can fail

The finalizer of `Effect.acquireRelease`, `Effect.ensuring`, `Effect.onError`, and `Effect.addFinalizer` must have error type `never`. **Finalizers are infallible by type, so a fallible `close()` forces you to decide what a failed teardown means** — before it compiles.

| Policy | Shape | Choose when |
| --- | --- | --- |
| Log and ignore | `close.pipe(Effect.ignore({ log: "Warn", message: "..." }))` | nobody can act on the failure |
| Bound, then ignore | `close.pipe(Effect.timeout("5 seconds"), Effect.ignore({ log: "Warn" }))` | shutdown must not hang on a dead peer — a telemetry exporter, a remote flush |
| Escalate to a defect | `close.pipe(Effect.orDie)` | a failed close is a bug, or leaves state you cannot reason about |
| Report to the caller | `Effect.acquireUseRelease` or `Effect.onExit`, whose cleanup may fail in `E` | the caller must see it — a commit or flush whose failure means lost data |

Whatever you choose, **the original outcome is not overwritten.** When `use` fails and the release fails too, both reasons are present in the resulting `Cause`; a finalizer that dies next to a typed failure yields a `Fail` and a `Die` reason. This is not "last error wins", so tests should assert through `Effect.exit` and inspect `cause.reasons` rather than expect one error to replace the other. Remember that `Effect.ignore` absorbs typed failures only; use `Effect.ignoreCause` to absorb defects as well.

```ts
import { Effect } from "effect"

declare const openExporter: Effect.Effect<{
  readonly flush: Effect.Effect<void, "ExporterUnreachable">
}>

// Bounded, best-effort exporter shutdown: never fails, never hangs.
const exporter = Effect.acquireRelease(openExporter, (handle) =>
  handle.flush.pipe(
    Effect.timeout("5 seconds"),
    Effect.ignore({ log: "Warn", message: "exporter flush failed during shutdown" })
  )
)
```

Keep finalizers small, reliable, and time-bounded: they run uninterruptibly, so an unbounded finalizer is an unbounded shutdown.

### 11. Running effects at an owned edge

Nothing runs until a runner is called. **Choose the runner by the outcome contract the host needs**, and treat every `runFork` as an ownership obligation — somebody must join, observe, or interrupt the fiber it returns.

| Runner | Returns | Failure surfaces as | Choose when |
| --- | --- | --- | --- |
| `Effect.runSync` | `A` | a `throw` of the squashed cause (the typed error value itself, or the defect); throws `Cause.AsyncFiberError` at the first async boundary | the effect is known to finish synchronously. The types cannot tell you that, so this is a deliberate edge case, not a default. |
| `Effect.runSyncExit` | `Exit<A, E>` | never throws; async work shows up as a defect holding `AsyncFiberError` | a synchronous edge that wants the outcome as data |
| `Effect.runPromise` | `Promise<A>` | a rejection with the squashed cause — the `Fail` / `Die` / `Interrupt` distinction is lost | a JavaScript edge that wants value-or-rejection |
| `Effect.runPromiseExit` | `Promise<Exit<A, E>>` | always resolves | an adapter, reporter, or test that must keep typed failure, defect, and interruption apart. Prefer it whenever the host can represent the outcome. |
| `Effect.runFork` | `Fiber<A, E>`, immediately | `Fiber.await` or `fiber.addObserver` | the caller keeps the handle and owns its lifetime. The other runners are built on it. |
| `Effect.runCallback` | an interruptor function | the `onExit` callback receives the `Exit` | callback-style hosts |
| Platform `runMain` | `void` | a logged error and a process exit code — see [Runtime](fibers-scopes-runtimes#runtime) | the process entry point |
| `ManagedRuntime` | the same family as methods | same as above | a host that calls in repeatedly — see [ManagedRuntime](fibers-scopes-runtimes#managedruntime) |

Every runner except `runSync` / `runSyncExit` accepts `RunOptions`: `signal` (aborting it interrupts the fiber), `scheduler`, `uninterruptible`, and `onFiberStart`. Each also has a curried `*With(context)` twin — `Effect.runPromiseWith(context)(effect)`, `runForkWith`, `runSyncWith`, and so on — for a host that already holds a `Context<R>` (captured with `Effect.context<R>()` inside a Layer, or assembled with `Context.make`) and wants to run effects requiring exactly `R` without paying for a `ManagedRuntime`.

**Run at *owned* edges, not "once".** A server, a test runner, and a plugin host each legitimately run many effects. The rule is that reusable code — services, domain functions, libraries — never calls a runner.

**An interior runner severs supervision.** `Effect.promise(() => Effect.runPromise(inner))` type-checks and returns the right value, but:

- `inner` is now a separate **root fiber**: interrupting the outer fiber (timeout, race, shutdown) does not reach it, so it runs to completion unobserved;
- bare runners start from an empty context, so `inner` loses the surrounding services and references — the provided `Clock` (and therefore `TestClock`), loggers, the current span — and its `R` must already be fully provided;
- its typed failure is flattened into a rejection, which `Effect.promise` then reports as a defect.

The fix is almost always to return the effect and let the caller compose it. If a nested runner is genuinely unavoidable (a third-party callback insists on a Promise), forward the adapter's signal so interruption still crosses the gap, and carry the `Exit` across so the failure keeps its type. A second variant of the same mistake is calling a runner while *building* a description (`Effect.runSync(parse(x)); return workflow`), which makes construction non-inert.

```ts
import { Effect, Exit } from "effect"

declare const recomputeBudget: Effect.Effect<number, "LedgerDown">

// A host edge that keeps the three outcomes apart. The runner looks at `signal` only
// after the fiber's first synchronous run, so check an already-aborted signal yourself.
const onRecomputeRequest = async (signal: AbortSignal): Promise<string> => {
  if (signal.aborted) return "client went away"
  const exit = await Effect.runPromiseExit(recomputeBudget, { signal })
  if (Exit.isSuccess(exit)) return `budget ${exit.value}`
  return Exit.hasInterrupts(exit) ? "cancelled" : "failed"
}

// Unavoidable nested runner: `{ signal }` restores interruption, and re-raising the
// Exit restores the typed failure.
const throughLegacyHook = <A, E>(inner: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.promise((signal) => Effect.runPromiseExit(inner, { signal })).pipe(Effect.flatten)
```

**Reach for it when** you want typed errors, dependency injection, structured concurrency, and interruption-safe resource handling as the default.

## ExecutionPlan

`effect/ExecutionPlan` — unstable

An ordered failover policy for an `Effect` or `Stream`. Each step provides the services needed by the same computation and may add an attempt count, a retry `Schedule`, or a `while` predicate. `Effect.withExecutionPlan` reruns the computation under each step until it succeeds or the plan is exhausted; `Stream.withExecutionPlan` does the same for an entire stream execution.

```ts
import { Context, Effect, ExecutionPlan, Layer, Schedule } from "effect"

const Endpoint = Context.Service<{ readonly url: string }>("handbook/HrisEndpoint")

const fetchEmployees = Effect.gen(function*() {
  const endpoint = yield* Endpoint
  if (endpoint.url === "https://primary.invalid") {
    return yield* Effect.fail("HRIS unavailable" as const)
  }
  return endpoint.url
})

const hrisPlan = ExecutionPlan.make(
  {
    provide: Layer.succeed(Endpoint, { url: "https://primary.invalid" }),
    attempts: 2,
    schedule: Schedule.exponential("100 millis")
  },
  {
    provide: Layer.succeed(Endpoint, { url: "https://backup.example" })
  }
)

const events: Array<string> = []
const program = Effect.withExecutionPlan(fetchEmployees, hrisPlan, {
  onEvent: (event) =>
    Effect.sync(() => events.push(`${event._tag}:${event.stepIndex}`))
})

const selectedEndpoint = await Effect.runPromise(program)
console.log(selectedEndpoint) // "https://backup.example"
console.log(events) // ["AttemptStart:0", "AttemptFailure:0", "AttemptStart:0", "AttemptFailure:0", "AttemptStart:1", "AttemptSuccess:1"]
```

The retry schedule sleeps between attempts, so the program is asynchronous: run it with `Effect.runPromise` (or inside a larger program). `Effect.runSync` would throw an `AsyncFiberError` instead of returning.

`attempts` is per step; `ExecutionPlan.CurrentMetadata` exposes the cumulative 1-based attempt and 0-based step index inside the computation. The optional `onEvent` observer receives strictly ordered `AttemptStart` / `AttemptSuccess` / `AttemptFailure` events: `attempt` is cumulative, `stepAttempt` resets for each step, and failures carry the full `Cause`. Every start is paired with one terminal event, including interruption; observer failure cannot change the computation's outcome. `ExecutionPlan.merge` concatenates independently defined plans, while `plan.captureRequirements` captures services needed to build its layers and schedules.

**Reach for it when** one operation should retry or fail over across interchangeable service implementations — regional endpoints, model providers, replicas, or storage tiers — without putting fallback branching inside the operation itself.

## Effectable

`effect/Effectable` — stable

The low-level toolkit for making custom values behave like effects — so they can be `yield*`-ed inside `Effect.gen` and evaluated by the runtime. It exposes three entry points: `Effectable.Class<A, E, R>` (abstract base class), `Effectable.Mixin(Base)` (insert the Effect prototype into an *existing* class hierarchy), and `Effectable.Prototype` (class-free builder). With `Class` and `Mixin` you implement one abstract method, `asEffect()`, returning the `Effect` your value stands for. The runtime calls it **on the instance for each execution**, so it sees current receiver state and the services provided at that point. This explains why non-Effect types (e.g. a `Context.Service` key) are still yieldable.

```ts
import { Clock, Effect, Effectable } from "effect"

// A domain value that *is* an Effect when evaluated: "the current
// review-cycle timestamp", read through the testable Clock.
class ReviewClockStamp extends Effectable.Class<number> {
  // The abstract member is the effect this value stands for.
  asEffect() {
    return Clock.currentTimeMillis
  }
}

// Mixin keeps an existing base class (and its constructor) and infers A/E/R
// from the concrete asEffect() return type.
class ReviewCycle {
  readonly cycleId: string
  constructor(cycleId: string) {
    this.cycleId = cycleId
  }
}

class OpenedReviewCycle extends Effectable.Mixin(ReviewCycle) {
  asEffect() {
    return Effect.map(Clock.currentTimeMillis, (at) => ({ cycleId: this.cycleId, at }))
  }
}

const program = Effect.gen(function*() {
  // Yielding the value evaluates its asEffect().
  const stampedAt = yield* new ReviewClockStamp()
  const opened = yield* new OpenedReviewCycle("2025-Q4")
  return { event: "cycle-opened", at: stampedAt, opened }
})
```

With `Mixin`, Effect's prototype members shadow same-named base members: `pipe`, `toString`, `toJSON`, `[Symbol.iterator]`, and the Node inspect hook.

**Reach for it when** building a library primitive or DSL whose values should be first-class citizens of `Effect.gen`.
