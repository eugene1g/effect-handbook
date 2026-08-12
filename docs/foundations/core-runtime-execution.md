# Core Runtime & Execution

`Effect` is not a running program — it's a description. The runtime spins up **fibers** to execute descriptions, **scopes** bound resource lifetimes, and a finished computation returns an **Exit** carrying a full **Cause**. Build a value of type `Effect<A, E, R>` by composing combinators; nothing runs until you execute it. Running forks a root fiber that may fork children, await deferreds, race siblings, or open scopes. When it finishes it produces an `Exit<A, E>` — either `Success<A>` or `Failure` holding a `Cause<E>` recording everything that went wrong (typed errors, defects, interruptions).

> **Official examples:** The release-matched `ai-docs` corpus has runnable examples for [Effect basics](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/01_effect/01_basics), [resource safety](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/01_effect/05_resources), [running programs](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/01_effect/06_running), and [ManagedRuntime integration](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/04_integration).

## Effect

`effect/Effect` — stable

`Effect<A, E, R>` is a lazy, immutable description of a computation that yields an `A`, may fail with typed `E`, and requires services `R`. Think of it as program-as-data: you assemble a recipe and the runtime executes it. That indirection enables typed errors, dependency injection, retries, interruption, and tracing as ordinary composition.

### 1. Creating effects

Pull values, sync code, promises, nullables, and callback APIs into the Effect world. Note `Effect.callback` (v4's name — not `async`) and `Effect.tryPromise` for fallible promises.

`Effect.fromOption(option, onNone?)` lifts an `Option`; without the callback it fails with `NoSuchElementError`, while `onNone` lets the boundary produce a custom typed error lazily.

```ts
import { Effect, Schema } from "effect"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {
  endpoint: Schema.String,
  cause: Schema.Defect()
}) {}

const fromValue = Effect.succeed({ cycle: "2026-MERIT" })          // already have it
const fromSync = Effect.sync(() => crypto.randomUUID())            // pure side effect
const fromEnv = Effect.fromNullishOr(process.env.HRIS_BASE_URL)   // -> fails NoSuchElementError if unset

const fetchEmployee = Effect.fn("fetchEmployee")((id: string) =>
  Effect.tryPromise({
    try: () => fetch(`/hris/employees/${id}`).then((r) => r.json()),
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

### 4. Concurrency

Most combinators take a `{ concurrency }` option. `"unbounded"` runs everything at once; a number caps in-flight work; the default is sequential.

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

### 7. Sequential folds and context control

`Effect.reduce(iterable, () => zero, step)` is the effectful, strictly sequential fold: the lazy seed is rebuilt on every run, the step receives its zero-based index, and the first failure stops later steps. For context, `provideContext` satisfies part of an environment while retaining unrelated outer services; `setContext` replaces the wrapped effect's **entire** environment with an already-complete `Context`. `updateServiceScoped(Service, f, { reset? })` temporarily updates a service until scope close and can merge the original, updated, and then-current values while restoring it.

**Reach for it when** you want typed errors, dependency injection, structured concurrency, and interruption-safe resource handling as the default.

## ExecutionPlan

`effect/ExecutionPlan` — stable

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

const selectedEndpoint = Effect.runSync(program) // "https://backup.example"
```

`attempts` is per step; `ExecutionPlan.CurrentMetadata` exposes the cumulative 1-based attempt and 0-based step index inside the computation. The optional `onEvent` observer receives strictly ordered `AttemptStart` / `AttemptSuccess` / `AttemptFailure` events: `attempt` is cumulative, `stepAttempt` resets for each step, and failures carry the full `Cause`. Every start is paired with one terminal event, including interruption; observer failure cannot change the computation's outcome. `ExecutionPlan.merge` concatenates independently defined plans, while `plan.captureRequirements` captures services needed to build its layers and schedules.

**Reach for it when** one operation should retry or fail over across interchangeable service implementations — regional endpoints, model providers, replicas, or storage tiers — without putting fallback branching inside the operation itself.

## Effectable

`effect/Effectable` — stable

The low-level toolkit for making custom values behave like effects — so they can be `yield*`-ed inside `Effect.gen` and evaluated by the runtime. Exposes `Effectable.Class` (abstract base class) and `Effectable.Prototype` (class-free builder). Extend `Effectable.Class<A, E, R>` and define the abstract `override` member — the `Effect` your value stands for. The runtime evaluates it when the value is yielded. This explains why non-Effect types (e.g. a `Context.Service` key) are still yieldable.

```ts
import { Clock, Effect, Effectable } from "effect"

// A domain value that *is* an Effect when evaluated: "the current
// review-cycle timestamp", read through the testable Clock.
class ReviewClockStamp extends Effectable.Class<number> {
  // v4 defines the standing-in effect via the abstract `override` member,
  // the abstract member is the effect this value stands for.
  override = Clock.currentTimeMillis
}

const program = Effect.gen(function*() {
  // Yielding the value evaluates its `override` effect.
  const stampedAt = yield* new ReviewClockStamp()
  return { event: "cycle-opened", at: stampedAt }
})
```

**Reach for it when** building a library primitive or DSL whose values should be first-class citizens of `Effect.gen`.

## Exit

`effect/Exit` — stable

`Exit<A, E>` is the result of a finished computation: either `Success<A>` (holding the value) or `Failure<A, E>` (holding a `Cause<E>`). Returned by `runSyncExit`, `runPromiseExit`, `Fiber.await`, and finalizers. An `Exit` is itself an `Effect`, so you can `yield*` it to re-raise its result. Pattern-match with `Exit.match`, or guard with `isSuccess` / `isFailure`.

```ts
import { Cause, Effect, Exit, Fiber } from "effect"

const program = Effect.gen(function*() {
  // Run a per-employee review task and capture its outcome as data
  // instead of letting a single failure propagate.
  const fiber = yield* Effect.forkChild(Effect.fail("hris timeout"))
  const exit = yield* Fiber.await(fiber) // Exit<never, string>, never fails
  return exit
})

// Branch on a finished review result.
const describe = (exit: Exit.Exit<number, string>) =>
  Exit.match(exit, {
    onSuccess: (raise) => `approved raise: ${raise}`,
    // onFailure receives the *Cause*, not a bare error.
    onFailure: (cause) => `review failed: ${Cause.pretty(cause)}`
  })
```

> **Note:** Use `Effect.catch` for error handling within effects. Use `Exit` at boundaries where a computation has *already finished* and you need to inspect the result as a value: awaiting a fiber, reading a finalizer's exit, or running at the app edge with `runSyncExit`.

**Reach for it when** you've crossed out of the Effect world and need to inspect success-or-cause synchronously.

## Cause

`effect/Cause` — stable

The complete, structured record of why an effect failed. A single failure can be several things simultaneously — a typed error, a finalizer that threw, and an interruption. `Cause` retains all of them. A `Cause` is a flat array of reasons. There are exactly three reason kinds: `Fail` (typed error), `Die` (unexpected defect), and `Interrupt` (fiber cancelled). An empty cause is an empty array.

```ts
import type { Cause } from "effect"

type CauseShape<E> = {
  readonly reasons: ReadonlyArray<Cause.Reason<E>>
}
// Cause.Reason<E> = Cause.Fail<E> | Cause.Die | Cause.Interrupt
```

Because it's flat, inspection is a loop, not a recursion. Narrow each reason with `is*Reason` guards; query whole-cause with `hasFails` / `hasDies` / `hasInterrupts`.

```ts
import { Cause } from "effect"

const summarize = (cause: Cause.Cause<string>): string => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) return `comp error: ${reason.error}`
    if (Cause.isDieReason(reason)) return `defect: ${String(reason.defect)}`
    if (Cause.isInterruptReason(reason)) return `cycle interrupted by ${reason.fiberId}`
  }
  return "empty cause"
}

// Whole-cause predicates avoid hand-rolling the loop.
declare const cause: Cause.Cause<string>
const wasCancelledCleanly = Cause.hasInterruptsOnly(cause)
const allFails = cause.reasons.filter(Cause.isFailReason)
```

**Reach for it when** you need to distinguish a typed error from a defect from an interruption, collect every failure from a concurrent batch, or render a full diagnostic with `Cause.pretty`.

## Fiber

`effect/Fiber` — stable

`Fiber<A, E>` is a lightweight green thread — a running or finished execution of an effect. You don't construct one directly; you get a handle from `Effect.forkChild` (and friends). A child fiber is bound to its parent's lifetime: when the parent ends, the child is interrupted — no leaks. `Fiber.await` gives you the `Exit` (never fails); `Fiber.join` propagates the result into the current effect (fails if the fiber failed); `Fiber.interrupt` cancels it and waits for cleanup.

```ts
import { Effect, Fiber } from "effect"

const program = Effect.gen(function*() {
  // forkChild: a supervised child that recomputes one employee's vested equity.
  const valuation = yield* Effect.forkChild(
    Effect.gen(function*() {
      yield* Effect.sleep("1 second")
      return 4_250 // vested shares as of today
    })
  )

  // join propagates success/failure into this fiber...
  const vested = yield* Fiber.join(valuation)
  // ...whereas await would hand back the Exit without failing.
  return vested
})
```

**Reach for it when** you need manual control over a background task — fork work, keep the handle, and await or interrupt on your own schedule. For fixed bundles of work, prefer `Effect.all`/`forEach` with `{ concurrency }`.

## FiberHandle

`effect/FiberHandle` — stable

A scoped holder for *at most one* fiber. Setting a new fiber interrupts the previous one (unless `onlyIfMissing` is passed); closing the owning scope interrupts the current fiber automatically. "Latest wins." The structured-concurrency answer to the `let current; current?.cancel(); current = start()` pattern.

```ts
import { Effect, FiberHandle } from "effect"

// Recompute the merit-budget pool whenever a recommendation changes.
declare const recomputeBudget: Effect.Effect<void>

const makeBudgetRecomputer = Effect.gen(function*() {
  const handle = yield* FiberHandle.make<void>()

  // Each edit replaces the in-flight recompute — the older one is interrupted.
  const trigger = FiberHandle.run(handle, recomputeBudget)

  yield* trigger
  yield* trigger // first recompute cancelled, second takes over
}).pipe(Effect.scoped) // closing the scope interrupts whatever is running
```

**Reach for it when** exactly one instance of a task should be alive at a time and re-triggering should cancel the old one.

## FiberMap

`effect/FiberMap` — stable

A scoped map of fibers keyed by some value. Running work under a key replaces any existing fiber for that key (or skips with `onlyIfMissing`). Completed fibers remove themselves; closing the scope interrupts all remaining fibers. `FiberHandle` generalized from one slot to many, with the same leak-proof guarantee.

```ts
import { Effect, FiberMap } from "effect"

// Run one supervised review task per employee, keyed by employee id.
declare const runReview: (employeeId: string) => Effect.Effect<void>

const meritCycle = Effect.gen(function*() {
  const reviews = yield* FiberMap.make<string>()

  // One supervised fiber per employee.
  yield* FiberMap.run(reviews, "emp_142", runReview("emp_142"))
  yield* FiberMap.run(reviews, "emp_207", runReview("emp_207"))

  // Idempotent start: don't restart a review that's already running.
  yield* FiberMap.run(reviews, "emp_142", runReview("emp_142"), {
    onlyIfMissing: true
  })

  const inFlight = yield* FiberMap.size(reviews)
  return inFlight
}).pipe(Effect.scoped) // every review fiber is interrupted on shutdown
```

**Reach for it when** you have a dynamic population of keyed background fibers and want them all interrupted cleanly when the parent scope closes.

## FiberSet

`effect/FiberSet` — stable

A scoped, unkeyed bag of fibers. Added fibers remove themselves on completion; closing the scope interrupts whatever remains. `FiberSet.awaitEmpty` blocks until the set drains. The keyless sibling of `FiberMap` — use when spawning an unbounded stream of fire-and-forget tasks that need group supervision.

```ts
import { Effect, FiberSet } from "effect"

// Fan out one fiber per raise-approved notification, then wait for the batch.
declare const notifyManager: (raise: unknown) => Effect.Effect<void>
declare const approvedRaises: ReadonlyArray<unknown>

const sendApprovals = Effect.gen(function*() {
  const fibers = yield* FiberSet.make<void>()

  for (const raise of approvedRaises) {
    yield* FiberSet.run(fibers, notifyManager(raise)) // fire-and-supervise
  }

  yield* FiberSet.awaitEmpty(fibers) // wait for every notification to finish
}).pipe(Effect.scoped)
```

**Reach for it when** you spawn many independent throwaway fibers and want them tracked as a group — interrupted together on scope close, or awaited together with `awaitEmpty`.

## Runtime

`effect/Runtime` — stable

Process-lifecycle helpers: `makeRunMain` (used by platform packages to build `runMain`), `Teardown` / `defaultTeardown` (turn an `Exit` into a process exit code), and error markers for custom exit codes. Application code almost never imports this directly — use `NodeRuntime.runMain` / `BunRuntime.runMain`, which are built on `makeRunMain`. Touch it only to customize how completion maps to an exit code.

```ts
import { Effect, Exit, Runtime } from "effect"

// A custom teardown for the nightly payroll job: log the outcome, then
// choose an exit code so the cron wrapper knows whether the run succeeded.
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit)) {
    onExit(0)
  } else {
    console.error("payroll run failed:", exit.cause)
    onExit(1)
  }
}

declare const nightlyPayroll: Effect.Effect<void>
// Platform runMain accepts a `teardown` override:
// NodeRuntime.runMain(nightlyPayroll, { teardown })
```

**Reach for it when** writing a platform adapter or needing bespoke exit-code logic for a process entry point. For ordinary apps, use `NodeRuntime.runMain`.

## Scope

`effect/Scope` — stable

A lifetime boundary. A `Scope` collects finalizers; closing it runs them (sequentially or in parallel) with the `Exit` that ended the work. The machinery underneath `acquireRelease`, `Effect.scoped`, and every `Layer`. Most of the time you never name a scope — `Effect.scoped` opens one, runs your effect, and closes it, discharging the `Scope` requirement. Manipulate scopes directly only when a resource must outlive the expression that created it.

```ts
import { Effect, Scope } from "effect"

declare const acquireHrisConn: Effect.Effect<{ close: () => void }, never, Scope.Scope>

// Open a scope by hand when the connection must outlive a single expression —
// e.g. it's reused across loading employees, bands, and writing raises.
const manual = Effect.gen(function*() {
  const scope = yield* Scope.make()

  // `Scope.use` supplies this scope, runs all work that may use the connection,
  // and closes the scope with the work's actual Exit. Do not return the scoped
  // connection: it is finalized before `Scope.use` completes.
  return yield* Scope.use(
    Effect.gen(function*() {
      const conn = yield* acquireHrisConn
      // ...use `conn` across loading employees, bands, and writing raises...
      return "review batch complete"
    }),
    scope
  )
})
```

> **Tip:** Prefer the high-level path: `Effect.acquireRelease` to register cleanup, `Effect.scoped` to bound it, and `Layer` when a resource should live for the whole app. Hand-managed `Scope.make` / `close` is for the rare case where a resource's lifetime doesn't align with any single effect.

**Reach for it when** a resource must live longer than the expression that creates it, or when implementing a primitive that controls finalization order directly.

## Scheduler

`effect/Scheduler` — stable

Decides *when* queued fiber work runs on the JavaScript thread, and when a long-running fiber should yield. The default is a `MixedScheduler` that batches tasks by priority and dispatches synchronous batches through Promise microtasks, installed as a `Context.Reference` so it can be swapped. Effect's fibers are cooperative — they run in bursts and periodically yield to keep the event loop responsive. Two useful knobs: `Scheduler.MaxOpsBeforeYield` (operations before yielding, default 2048) and `PreventSchedulerYield` (disable yielding for controlled workloads).

```ts
import { Effect, Scheduler } from "effect"

// A hot, latency-insensitive pass: value every equity grant in the ledger.
declare const valueAllGrants: Effect.Effect<void>

// Let it run longer between yields so the batch finishes faster.
const tuned = valueAllGrants.pipe(
  Effect.provideService(Scheduler.MaxOpsBeforeYield, 8192)
)
```

> **Note:** A custom `Scheduler` can provide deterministic task ordering in tests, but synchrony and flushing behavior belong to that scheduler implementation; merely replacing the service does not make every scheduler synchronous.

**Reach for it when** tuning throughput-vs-fairness for a heavy workload, or needing deterministic task ordering in a test. Otherwise the default scheduler is correct.

## Clock

`effect/Clock` — stable

The service that owns "what time is it" and "sleep." `Clock.currentTimeMillis` and `currentTimeNanos` read the time as effects; `Effect.sleep` goes through the clock too. Installed as a `Context.Reference` — always available and always replaceable. Time is a dependency, not a global: read it through the clock so tests can install a virtual one and fast-forward to any point without real waiting.

```ts
import { Clock, Effect } from "effect"

// Time as an effect — substitutable in tests, never a hidden global.
const stampReviewOpened = Effect.gen(function*() {
  const now = yield* Clock.currentTimeMillis
  return { event: "merit-cycle-opened", at: now }
})

// `clockWith` hands you the live clock when you need it directly —
// e.g. how long is left before the review-cycle deadline.
const timeUntilDeadline = (deadline: number) =>
  Clock.clockWith((clock) =>
    Effect.sync(() => deadline - clock.currentTimeMillisUnsafe())
  )
```

> **Warning:** No `Date.now()` or `new Date()` inside effects. Read wall-clock time via `Clock` (or `DateTime` for calendar math). Anything else makes time-sensitive logic untestable and non-deterministic.

Wall-clock readings (`currentTimeMillis` / `currentTimeNanos`) may jump when the operating system corrects its clock; elapsed-time measurement uses the separate monotonic clock. A custom `Clock.Clock` implementation must therefore provide both `monotonicTimeNanosUnsafe()` and `monotonicTimeNanos`, with an arbitrary but consistently increasing origin.

**Reach for it when** any logic depends on current time, durations, or delays — so you can drive it with a virtual clock under test.

## Deferred

`effect/Deferred` — stable

A one-shot, write-once coordination cell. A `Deferred<A, E>` starts empty, can be completed *exactly once* (with a success, failure, defect, or interruption), and lets any number of fibers `await` the result. Awaiting suspends the fiber without blocking a thread; every waiter sees the same outcome. A `Promise` completed by hand, but Effect-native: typed error channel, interruptible await, runtime-integrated.

```ts
import { Deferred, Effect } from "effect"

const program = Effect.gen(function*() {
  // The approved merit budget, published once HRBP signs off.
  const approvedBudget = yield* Deferred.make<number>()

  // Producer completes the cell exactly once.
  yield* Effect.forkChild(
    Effect.gen(function*() {
      yield* Effect.sleep("100 millis")
      yield* Deferred.succeed(approvedBudget, 2_400_000)
    })
  )

  // Every per-manager planner awaits the same approved figure.
  const budget = yield* Deferred.await(approvedBudget)
  return budget
})
```

> **Tip:** `Deferred.into` runs an effect and completes a deferred with its *full exit* (success or cause), uninterruptibly. Useful for "load once, let every waiter get the result" caching and single-flight patterns.

**Reach for it when** one fiber must signal a single value or completion to others — bridging callbacks, gating on an approved result, or building single-flight/memoization.

## Latch

`effect/Latch` — stable

A *reusable* open/closed gate. While a `Latch` is closed, `await` (and `whenOpen`) suspend; `open` releases current and future waiters; `release` frees only current waiters; `close` makes future waiters suspend again. Where `Deferred` is one-shot, a `Latch` resets — open it, close it, open it again.

`Latch.isOpen(latch)` (or the instance's `.isOpen()`) is a synchronous, non-mutating status check; use it for observation, never as a substitute for `await` when correctness depends on the gate remaining open.

```ts
import { Effect, Latch } from "effect"

const program = Effect.gen(function*() {
  // Start closed: every manager's planner waits at the gate until kickoff.
  const cycleGate = yield* Latch.make(false)

  yield* Effect.forkChild(
    Effect.gen(function*() {
      yield* cycleGate.await // suspends until the cycle opens
      yield* Effect.log("planner unlocked — entering recommendations")
    })
  )

  yield* Effect.sleep("50 millis")
  yield* Latch.open(cycleGate) // open the merit cycle to everyone

  // `whenOpen` gates an arbitrary effect behind the latch.
  yield* Latch.whenOpen(cycleGate, Effect.log("accepting recommendations"))
})
```

**Reach for it when** you need a gate that opens and closes repeatedly. For a one-time signal, use `Deferred` instead.

## ManagedRuntime

`effect/ManagedRuntime` — stable

A reusable runtime built once from a `Layer`. Constructs services lazily on first use, caches them, and exposes plain `runPromise` / `runSync` / `runFork` methods so non-Effect code can execute effects with full dependency injection. Call `dispose()` to release everything the layer acquired. The bridge for embedding Effect inside a world that isn't Effect — Express handlers, React event callbacks, test harnesses, CLI commands. Pay the layer-construction cost once, then call `runtime.runPromise(effect)` repeatedly.

```ts
import { Context, Effect, Layer, ManagedRuntime } from "effect"

// The compensation engine, exposed as a service.
class CompService extends Context.Service<CompService, {
  readonly recommendRaise: (employeeId: string) => Effect.Effect<number>
}>()("app/CompService") {
  static readonly layer = Layer.succeed(this)({
    recommendRaise: (employeeId) => Effect.succeed(employeeId === "emp_142" ? 8_500 : 0)
  })
}

// Build services once; reuse the runtime across many web requests.
const runtime = ManagedRuntime.make(CompService.layer)

// Non-Effect code (e.g. an HTTP handler) can now run effects directly:
async function handler(employeeId: string) {
  return await runtime.runPromise(
    Effect.flatMap(CompService, (comp) => comp.recommendRaise(employeeId))
  )
}

// On shutdown, release the layer's resources (HRIS pool, ledger client, ...).
async function shutdown() {
  await runtime.dispose()
}
```

`ManagedRuntime` also implements `Symbol.asyncDispose`, so TypeScript's `await using runtime = ManagedRuntime.make(layer)` releases the runtime automatically at block exit. Use either that protocol or `dispose()`—never leave a long-lived runtime's layer scope open.

> **Note:** Don't use `ManagedRuntime` when the whole app *is* Effect — use `Layer.launch` + `NodeRuntime.runMain` there. `ManagedRuntime` is for seams where Effect meets imperative or framework-driven code that calls in repeatedly.

**Reach for it when** embedding Effect into a non-Effect host — framework callbacks, library glue, incremental adoption — and a long-lived, dependency-injected runtime is needed to run effects on demand.

## Pull

`effect/Pull` — stable

The low-level primitive powering streams and channels. A `Pull<A, E, Done, R>` is an `Effect` that, when evaluated, either: produces a value `A`, fails with an ordinary error `E`, or signals end-of-input via `Cause.Done<Done>` in the error channel. Repeatedly evaluating a `Pull` is how a `Stream` is consumed under the hood. Normal completion is encoded as a special failure (`Cause.Done`) so a single effect expresses "here's a chunk," "I errored," and "I'm finished" — carrying a leftover value at the end if needed. The module provides `catchDone`, `filterDone`, `matchEffect` to distinguish these cases.

```ts
import { Cause, Effect, Pull } from "effect"

// Pulling the next page of an employee export out of the HRIS.
declare const nextEmployeePage: Pull.Pull<ReadonlyArray<{ id: string }>, Error>

// Distinguish "more rows", "real error", and "done" in one match.
// Note: onFailure receives the full Cause, onDone receives the leftover.
const step = Pull.matchEffect(nextEmployeePage, {
  onSuccess: (page) => Effect.succeed(`loaded ${page.length} employees`),
  onFailure: (cause) => Effect.succeed(`hris error: ${Cause.pretty(cause)}`),
  onDone: () => Effect.succeed("employee export complete")
})
```

> **Note:** This is plumbing. Work with `Stream`, `Channel`, and `Sink` day to day; drop to `Pull` only when writing a custom stream source or low-level operator and need direct control over the produce/fail/done protocol.

**Reach for it when** implementing a custom `Stream` or `Channel` primitive and needing direct control over the element-by-element pull protocol, including the end-of-input signal. For everyday data flow, stay in `Stream`.

> **Tip:** Effects are descriptions; **fibers** run them; **scopes** decide how long resources live; **exits** and **causes** capture how things ended. Coordinate fibers with **Deferred** (one-time signal) and **Latch** (repeatable gate); supervise dynamic fibers with **FiberHandle/Map/Set**; read time through the **Clock**; bridge to the outside world with **ManagedRuntime**. Everything else in this handbook builds on these pieces.
