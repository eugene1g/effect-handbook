# Fibers, Scopes & Runtimes

What happens after you build an `Effect`: how it finishes (`Exit` and its full `Cause`), the fibers that run it and the handles that supervise them, the `Scope` that bounds every resource, the scheduler and clock underneath, the one-shot and gate primitives fibers coordinate with, and the runtimes that run Effects from non-Effect code. [Core Runtime & Execution](core-runtime-execution) covers building and combining Effects; this page covers owning them while they run.

![Diagram: an Effect is run on a root fiber; forkChild, forkScoped, and forkDetach give forked fibers different owners; acquireRelease and Layers register finalizers in a Scope; the run ends in an Exit](/diagrams/effect-fiber-scope-ownership.svg)

_An Effect is only a description until an owned edge runs it on a root fiber. Every fiber it forks has an owner that ends it, every resource is released by the Scope that acquired it, and the run ends in an `Exit` carrying the full `Cause`._

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

Inside an effect, `Effect.exit(self)` captures the complete outcome — typed failure, defect, and interruption — as a value with `E = never`; `Effect.result` captures only the typed failure. Construct exits with `Exit.succeed`, `Exit.fail`, `Exit.die`, `Exit.interrupt`, and `Exit.failCause(cause)`; classify them with `Exit.hasFails` / `Exit.hasDies` / `Exit.hasInterrupts`, and pull the first typed error out with `Exit.findErrorOption`. Test assertions should match on this structure, never on rendered failure text.

Official guides: [Exit](https://effect.website/docs/v4/data-types/exit), [Unexpected Errors](https://effect.website/docs/v4/error-management/unexpected-errors).

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

**When a `Cause` holds more than one reason.** Reasons accumulate where outcomes combine: a failing `use` plus a failing finalizer ([section 10 of Core Runtime & Execution](core-runtime-execution#10-when-cleanup-can-fail)), every contender of a race that nobody won, or an explicit `Cause.combine(a, b)`. A fail-fast `Effect.all` or `Effect.forEach` is *not* such a place — it records the first failure only, so later members' failures never appear in `reasons`; accumulate with `{ mode: "result" }`, `Effect.partition`, or `Effect.validate` instead.

**Constructing and re-raising.** Build causes with `Cause.fail(error)`, `Cause.die(defect)`, `Cause.interrupt(fiberId?)`, and `Cause.combine`; fail with one through `Effect.failCause(cause)` (a die-only or interrupt-only cause leaves `E = never`). After `Effect.catchCause`, propagate what you cannot handle with `Effect.failCause(cause)` *unchanged* — `Effect.fail(Cause.squash(cause))` collapses the record to a single value. `Interrupt.fiberId` is `number | undefined`.

**Rendering.** `Cause.pretty(cause)` is for humans: an empty cause renders as the empty string, a non-`Error` failure is wrapped as `Error: <value>`, and a combined cause renders one block per reason. `Cause.prettyErrors(cause)` returns the per-reason `Error` objects for a reporter. Both are diagnostics that change between releases — never assert on them.

Official guides: [Cause](https://effect.website/docs/v4/data-types/cause), [Parallel and Sequential Errors](https://effect.website/docs/v4/error-management/parallel-and-sequential-errors), [Sandboxing](https://effect.website/docs/v4/error-management/sandboxing).

**Reach for it when** you need to distinguish a typed error from a defect from an interruption, inspect every reason when outcomes combine, or render a full diagnostic with `Cause.pretty`.

### Recovering from a mixed Cause

The typed recovery operators — `Effect.catch`, `catchTag` / `catchTags`, `catchIf`, `Effect.match`, `Effect.result`, `Effect.mapError`, and `Effect.orDie` — all look up the **first `Fail` reason** in the flat cause. If there is none, the cause passes through untouched, which is why they never swallow a pure defect or a pure interruption. If there is one, the handler's result becomes the *entire* outcome, and any `Die` or `Interrupt` reason recorded alongside it disappears:

| Input cause | `Effect.catch(() => fallback)` | `Effect.orDie` | Guarded `catchCause` (below) |
| --- | --- | --- | --- |
| `Die` only | unchanged — still a defect | unchanged | unchanged |
| `Fail` only | success with the fallback | `Die(error)` | success with the fallback |
| `Fail` + `Die` | **success** — the defect is lost | a single `Die(error)` — the original defect is lost | unchanged — both reasons kept |
| two `Fail` reasons | the handler sees only the first | `Die(first)` | success with the fallback |

So: **where mixed causes are possible and the other reasons matter, recover through `Effect.catchCause` with an explicit guard**, and never use `Effect.orDie` as a way to tidy an error union. `Effect.tapError` and the finalizer family observe without replacing, so they are safe.

```ts
import { Cause, Effect } from "effect"

// Recover the expected failure only when nothing else went wrong alongside it.
const recoverCleanFailure = <A, E, R>(self: Effect.Effect<A, E, R>, fallback: A) =>
  self.pipe(
    Effect.catchCause((cause) =>
      Cause.hasDies(cause) || Cause.hasInterrupts(cause)
        ? Effect.failCause(cause) // not ours to handle: propagate every reason
        : Effect.succeed(fallback)
    )
  )
```

`Effect.sandbox(self)` is the other route: it moves the whole `Cause<E>` into the error channel so ordinary typed combinators (`catch`, `mapError`, `result`) see it. There is no `unsandbox`; restore the normal model with `Effect.catch(Effect.failCause)`. For a single recovery step `catchCause` is simpler. The operator-by-operator treatment is in [Errors, Option & Result](errors-option-result#effect-error-handling).

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

A fork returns a **handle, not a result**, and a `Fiber` is not yieldable — `yield* fiber` does not compile. Turn handles back into effects and then use ordinary combinators: `Fiber.join` for one, `Fiber.joinAll(fibers)` for an array of results, `Fiber.awaitAll(fibers)` for an array of exits, `Fiber.interruptAll(fibers)` to cancel a group. Low-level integrations that read a fiber's derived state use `fiber.cache` (`scheduler`, `span`, `logLevel`, `minimumLogLevel`, `maxOpsBeforeYield`, ...); there is no separate family of `current*` fields.

Official guide: [Fibers](https://effect.website/docs/v4/concurrency/fibers) (its prose calls `Effect.yieldNow()`; `Effect.yieldNow` is a value, not a function, and the guide does not mention `startImmediately`).

**Reach for it when** you need manual control over a background task — fork work, keep the handle, and await or interrupt on your own schedule. For fixed bundles of work, prefer `Effect.all`/`forEach` with `{ concurrency }`.

### Choosing a fork by its owner

**Name the owner first; the fork function follows.** The four fork functions differ only in who is responsible for interrupting the fiber.

| Function | Owner | Interrupted when | Choose when | Avoid when |
| --- | --- | --- | --- | --- |
| `Effect.forkChild(effect)` | the current fiber | the parent ends — success, failure, or interruption — and the child's finalizers run | the work must not outlive the code that started it: a helper for this request or this batch | the work has to survive the function that forked it |
| `Effect.forkScoped(effect)` (adds `Scope` to `R`) | the surrounding `Scope` | that scope closes | background work owned by a Layer, a request scope, or a test | the nearest scope closes too early — wrapping the fork itself in `Effect.scoped` interrupts it at once |
| `Effect.forkIn(effect, scope)` | a `Scope` you were handed, or captured with `Effect.scope` | that scope closes | "start it here, own it there" — forked inside an inner scope but owned by an outer one | the current scope is already the right owner |
| `Effect.forkDetach(effect)` | nobody — the global scope | never, unless someone keeps the handle and interrupts it | process-lifetime work with a documented stop path | library and domain code. If nobody can say who interrupts a detached fiber, it is a leak. |

Two corollaries: a long-lived loop should be *exposed as an effect* and run in the caller's fiber or scope rather than forked internally, and reusable code should not create root fibers. All four functions accept `{ startImmediately, uninterruptible }`. For dynamic populations of fibers use [FiberHandle](#fiberhandle), [FiberMap](#fibermap), or [FiberSet](#fiberset) instead of hand-kept handles; the worked example is [Structured Concurrency Through a Bounded Worker](../deep-dives/structured-concurrency-through-a-bounded-worker).

```ts
import { Effect } from "effect"

declare const heartbeat: Effect.Effect<never>
declare const pollApprovals: Effect.Effect<never>

const meritCycleServer = Effect.scoped(Effect.gen(function*() {
  const cycleScope = yield* Effect.scope
  yield* Effect.scoped(Effect.gen(function*() {
    yield* Effect.forkIn(heartbeat, cycleScope) // owned by the outer scope
    yield* Effect.forkScoped(pollApprovals)      // owned by this inner scope
  }))
  // pollApprovals is already interrupted here; heartbeat runs until the outer scope closes.
}))
```

### When a forked fiber starts

**Forking returns the handle immediately; the child is only *scheduled* and does not run until the current fiber yields or suspends.** Code that forks a listener — a `PubSub` or `SubscriptionRef.changes` consumer, a queue taker, a latch waiter — and then publishes straight away can therefore lose the first events. Letting the parent yield (`yield* Effect.yieldNow`, a value, not a function) usually helps but is not a hard ordering guarantee. When the child must register before the parent continues, pass `{ startImmediately: true }`: the child runs synchronously up to its first suspension before the fork returns. The same option removes "has it started yet?" guesses from tests.

```ts
import { Effect, Fiber, Ref } from "effect"

const program = Effect.gen(function*() {
  const events = yield* Ref.make<ReadonlyArray<string>>([])
  const record = (event: string) => Ref.update(events, (all) => [...all, event])

  const lazyListener = yield* Effect.forkChild(record("listener registered"))
  yield* record("first approval published") // runs first: the child is only scheduled so far
  yield* Fiber.join(lazyListener)

  const eagerListener = yield* Effect.forkChild(record("eager listener registered"), {
    startImmediately: true
  })
  yield* record("second approval published") // runs after the eager child registered
  yield* Fiber.join(eagerListener)

  return yield* Ref.get(events)
})
// ["first approval published", "listener registered",
//  "eager listener registered", "second approval published"]
```

### Requesting cancellation versus awaiting cleanup

`Fiber.interrupt(fiber)` completes only after the target has finished — finalizers included — so it back-pressures the caller, and a slow finalizer makes a slow cancel. A fiber inside an uninterruptible region or a finalizer keeps running until that region ends. If the region then fails, the pending interruption still wins: recovery handlers such as `Effect.catch` are skipped, the typed failure is dropped from the `Cause`, and the fiber exits interrupted (defects are kept). When the caller must not wait (inside a request handler, under its own deadline), signal and move on: `Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true })` sends the interruption before continuing while cleanup proceeds in the background, and `fiber.interruptUnsafe()` is the synchronous hook that platform `runMain` uses for `SIGINT`. A public "cancel" API should say which of the two it offers: *request cancellation* or *await cleanup*.

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

Official guide: [Tracking Fibers](https://effect.website/docs/v4/observability/tracking-fibers) (uses `FiberSet.size` as a live "fibers in flight" gauge).

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

**What `runMain` does by default.** It forks the program as the root fiber, interrupts it on `SIGINT` or `SIGTERM` (Node and Bun), waits for finalizers, and then sets the exit code through `Runtime.defaultTeardown`:

| Outcome | Exit code | Logged? |
| --- | --- | --- |
| Success | `0` | no |
| Interrupt-only `Cause` (a signal arrived, nothing else failed) | `130` | no |
| Any other failure | the squashed error's `[Runtime.errorExitCode]` when it is a number, otherwise `1` | yes, with `Effect.logError` — unless `{ disableErrorReporting: true }` is passed or the error carries `[Runtime.errorReported] = false` |

The two markers let a domain error choose its own exit code and avoid double logging without a custom `teardown`:

```ts
import { Data, Effect, Runtime } from "effect"

class CompConfigInvalid extends Data.TaggedError("CompConfigInvalid")<{ readonly key: string }> {
  // `override`: Effect augments the global `Error` interface with both optional markers.
  override readonly [Runtime.errorExitCode] = 78    // the process exits with 78 instead of 1
  override readonly [Runtime.errorReported] = false // already reported by the loader; skip runMain's log
}

const main = Effect.fail(new CompConfigInvalid({ key: "MERIT_BUDGET" }))
// NodeRuntime.runMain(main)
```

The entry-point recipe is [Recipe: A Graceful Node Entrypoint](../recipes/graceful-entrypoint-and-shutdown). Official guide: [Platform Runtime](https://effect.website/docs/v4/platform/runtime) (it describes exit codes as only `0` and `1` and names only `SIGINT`; the runtime also uses `130` for interruption-only failures and listens for `SIGTERM` as well as `SIGINT`).

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

**Finalizer order and what finalizers see.**

- **A scope runs its finalizers in reverse registration order** (the default `"sequential"` strategy), which is what makes "open the pool, then open a cursor on it" tear down safely: the cursor closes while the pool is still alive. Every finalizer runs even if an earlier one fails. `Scope.make("parallel")` runs them concurrently instead.
- **Finalizers are exit-aware.** `Effect.addFinalizer((exit) => ...)`, `Scope.addFinalizerExit(scope, (exit) => ...)`, and the release function of `Effect.acquireRelease((resource, exit) => ...)` all receive the `Exit` the scope was closed with, so cleanup can commit on success and roll back otherwise.
- **`Scope` in `R` is an unpaid debt.** Until `Effect.scoped`, a Layer build, `Scope.use`, or `Scope.provide` discharges it, the resource has no owner — see the chooser in [section 6 of Core Runtime & Execution](core-runtime-execution#6-interruption-resource-safety).

**Interleaved lifetimes.** Everything sequenced under one `Effect.scoped` shares that scope, so all of its finalizers wait until the end. When two resources need different lifetimes, create scopes with `Scope.make()`, attach work with `Scope.provide(scope)` — it extends the work's resources into that scope *without* closing it — and end each with `Scope.close(scope, exit)` at the moment you choose (`Scope.use` is provide-then-close with the work's real `Exit`). Three facts to keep in mind: closing a scope runs finalizers and interrupts fibers forked *into* it, but does nothing to other fibers that still hold its resources; registering a finalizer on an already-closed scope runs it immediately; and closing a closed scope is a no-op.

```ts
import { Effect, Exit, Scope } from "effect"

declare const openStagingTable: Effect.Effect<void, never, Scope.Scope>
declare const openLedgerConnection: Effect.Effect<void, never, Scope.Scope>
declare const loadIntoStaging: Effect.Effect<void, "StagingRejected">
declare const postToLedger: Effect.Effect<void, "LedgerDown">

// A manual scope still needs an owner: its close is registered in the enclosing scope,
// so a failure or interruption half-way through cannot strand it.
const ownedScope = Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit))

const payrollImport = Effect.gen(function*() {
  const staging = yield* ownedScope
  const ledger = yield* ownedScope
  yield* openStagingTable.pipe(Scope.provide(staging))    // attaches to `staging` without closing it
  yield* openLedgerConnection.pipe(Scope.provide(ledger))
  yield* loadIntoStaging
  yield* Scope.close(staging, Exit.void)                  // staging is released now...
  yield* postToLedger                                      // ...while the ledger connection stays open
}).pipe(Effect.scoped)
```

Official guide: [Scope](https://effect.website/docs/v4/resource-management/scope).

**Reach for it when** a resource must live longer than the expression that creates it, or when implementing a primitive that controls finalization order directly.

## Scheduler

`effect/Scheduler` — stable

Decides *when* queued fiber work runs on the JavaScript thread, and when a long-running fiber should yield. The default is a `MixedScheduler` in `"async"` mode, installed as a `Context.Reference` so it can be swapped: it batches queued tasks by priority (FIFO within a priority) and dispatches each batch with `setImmediate`, or `setTimeout(0)` where `setImmediate` does not exist. It falls back to a Promise microtask when setting that timer throws — Cloudflare Workers forbid timers in global scope — so an effect run at module load can still yield. `new MixedScheduler("sync")` dispatches through microtasks. Effect's fibers are cooperative — they run in bursts and periodically yield to keep the event loop responsive. Two useful knobs: `Scheduler.MaxOpsBeforeYield` (operations before yielding, default 2048) and `PreventSchedulerYield` (disable yielding for controlled workloads).

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

**Every completion function returns `Effect<boolean>`: `true` only for the call that actually completed the cell.** That boolean is how competing producers learn who won; ignoring it hides lost writes. A `Deferred` is a handle, not an effect — read it with `Deferred.await`, or check it without suspending via `Deferred.isDone(d)` and `Deferred.poll(d)` (an effect yielding `Option<Effect<A, E>>`).

| Complete with | Function |
| --- | --- |
| a value | `Deferred.succeed(d, value)`, `Deferred.sync(d, () => value)` |
| a typed failure | `Deferred.fail(d, error)`, `Deferred.failSync(d, () => error)` |
| a defect, a full cause, or interruption | `Deferred.die(d, defect)`, `Deferred.failCause(d, cause)`, `Deferred.interrupt(d)` |
| an already computed `Exit` | `Deferred.done(d, exit)` |
| the outcome of running an effect **once** — memoized, every waiter sees the same result | `Deferred.complete(d, effect)`; `Deferred.into(effect, d)` does the same uninterruptibly |
| the effect **itself** — not memoized, each waiter runs it again | `Deferred.completeWith(d, effect)`; a sharp edge for side-effecting effects |

**Gates are per lifecycle generation, and must complete on every outcome.** A `Deferred` cannot be reopened, so anything restartable — a scheduler generation, a reconnecting client, a readiness signal — mints a fresh one per generation; reusing a completed gate lets the next generation sail through on stale readiness. When a generation ends, *fail* its gate so anyone still waiting on it is woken rather than left hanging, and use `Deferred.fail` for "startup failed" so waiters fail fast rather than time out. A late completion from a retired producer is then detectably ignored (`false`) rather than overwriting state. When the same gate really must reopen, use a [Latch](#latch).

```ts
import { Deferred, Effect, Ref, Schema } from "effect"

class HrisSyncRetired extends Schema.TaggedError<HrisSyncRetired>()("HrisSyncRetired", {
  generation: Schema.Int
}) {}

interface SyncGeneration {
  readonly generation: number
  readonly ready: Deferred.Deferred<void, HrisSyncRetired>
}

// Start the next sync generation: fresh gate, and the retired gate fails its waiters.
const rollOver = Effect.fn("rollOver")(function*(current: Ref.Ref<SyncGeneration>) {
  const ready = yield* Deferred.make<void, HrisSyncRetired>()
  const previous = yield* Ref.getAndUpdate(current, (g) => ({ generation: g.generation + 1, ready }))
  const released = yield* Deferred.fail(previous.ready, new HrisSyncRetired({ generation: previous.generation }))
  // `released` is false when the previous generation had already become ready or failed.
  return { released, ready }
})
```

Official guide: [Deferred](https://effect.website/docs/v4/concurrency/deferred) (its intro calls a `Deferred` a subtype of `Effect`; it is not yieldable, and `Deferred.poll` returns an `Effect<Option<Effect<A, E>>>` — `None` while unresolved, `Some` wrapping the completed effect once it is).

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

Official guide: [Latch](https://effect.website/docs/v4/concurrency/latch) (a gate releases everyone at once; a `Semaphore` admits a bounded number at a time).

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

**A `ManagedRuntime` is a lifetime-bearing bridge, so every callback follows the same protocol.**

- **Forward the host's cancellation.** Every run method except `runSync` / `runSyncExit` takes `RunOptions`; pass the request's `AbortSignal` as `{ signal }` and an aborted request interrupts the fiber, which in turn aborts the signal handed to your Promise adapters ([section 8 of Core Runtime & Execution](core-runtime-execution#8-cancellable-adapters-for-promises-and-callbacks)). Check `signal.aborted` yourself first: the runner consults the signal only after the fiber's first synchronous run.
- **Decide how outcomes cross the boundary.** `runPromise` rejects with the squashed cause; use `runPromiseExit` when the host must tell a typed failure from a defect from a cancellation (an interrupted run is an interrupt-only `Cause`, not an error to log).
- **Stop admitting work before you dispose.** Flip a draining flag, let in-flight callbacks finish or interrupt them, and only then call `dispose()`. After disposal every run dies with `ManagedRuntime disposed`. Disposal itself is idempotent — a second `dispose()` releases nothing twice — which keeps hot-reload and double shutdown hooks safe. `runtime.disposeEffect` is the same operation as an `Effect`, for shutdown that is itself composed in Effect.
- **The first run pays for the Layer.** Services are built lazily on first use, so a startup failure surfaces on the first callback. Hosts that want to fail at boot warm the runtime with `await runtime.context()` (or one `runPromise(Effect.void)`).

```ts
import { Effect, Exit, Layer, ManagedRuntime } from "effect"

declare const AppLayer: Layer.Layer<never>
declare const handleRaiseRequest: (body: unknown) => Effect.Effect<{ readonly raise: number }, "BandViolation">

const runtime = ManagedRuntime.make(AppLayer)
let draining = false

export const onRequest = async (body: unknown, signal: AbortSignal) => {
  if (draining || signal.aborted) return { status: 503 as const }
  const exit = await runtime.runPromiseExit(handleRaiseRequest(body), { signal })
  if (Exit.isSuccess(exit)) return { status: 200 as const, body: exit.value }
  if (Exit.hasInterrupts(exit)) return { status: 499 as const } // client went away: not a fault
  return { status: Exit.hasFails(exit) ? (422 as const) : (500 as const) }
}

export const onShutdown = async () => {
  draining = true
  await runtime.dispose()
}
```

The complete host-side walk-through — request signal to adapter abort, with its tests — is [Recipe: Request Cancellation Through a Host](../recipes/request-cancellation-through-a-host); the embedding recipe is [Recipe: ManagedRuntime at an Imperative Boundary](../recipes/managed-runtime-integration); readiness, draining, and shutdown ordering are in [Owning Lifetimes — Startup, Readiness, and Shutdown](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown). When the host already holds a `Context<R>`, the lighter `Effect.run*With(context)` runners in [section 11 of Core Runtime & Execution](core-runtime-execution#11-running-effects-at-an-owned-edge) avoid a managed runtime altogether.

Official guide: [Runtime](https://effect.website/docs/v4/runtime).

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

The user-facing entry point is `Stream.toPull(stream)`: a scoped effect (run it under `Effect.scoped`) that returns a pull. Each evaluation yields the next non-empty array of elements, and completion arrives as a `Cause.Done` failure — which is how you hand a stream to an imperative `while` loop without collecting it. Official guide: [Stream Operations](https://effect.website/docs/v4/stream/operations).

> **Note:** This is plumbing. Work with `Stream`, `Channel`, and `Sink` day to day; drop to `Pull` only when writing a custom stream source or low-level operator and need direct control over the produce/fail/done protocol.

**Reach for it when** implementing a custom `Stream` or `Channel` primitive and needing direct control over the element-by-element pull protocol, including the end-of-input signal. For everyday data flow, stay in `Stream`.

## Version

`effect/Version` — unstable

The `effect` package version string reported in OTLP resources, telemetry headers, and span scopes. Added in 4.0.2.

```ts twoslash
import * as Version from "effect/Version"

// Read the version Effect reports in telemetry.
const v: string = Version.getCurrentVersion() // e.g. "4.0.2"

// Override it — useful in a monorepo where the installed version
// should differ from the one surfaced in traces and OTLP resources.
Version.setCurrentVersion("4.0.2-internal.1")
console.log(Version.getCurrentVersion()) // "4.0.2-internal.1"
```

> **Note:** `setCurrentVersion` mutates only this copy of the module. Telemetry layers built before the call retain the version they read at construction time.

**Reach for it when** you need to read or pin the version that Effect reports in OTLP resources and span attributes.

> **Tip:** Effects are descriptions; **fibers** run them; **scopes** decide how long resources live; **exits** and **causes** capture how things ended. Coordinate fibers with **Deferred** (one-time signal) and **Latch** (repeatable gate); supervise dynamic fibers with **FiberHandle/Map/Set**; read time through the **Clock**; bridge to the outside world with **ManagedRuntime**. Wrap foreign code with the constructor that matches its failure convention and forward the **AbortSignal**; give every fiber and resource a named **owner**; call runners only at **owned edges**. Everything else in this handbook builds on these pieces.
