# Failure, Retry, Fallback, and Interruption

Reliable Effect code does not ask only “did it throw?” It distinguishes an expected domain failure from a defect, an interruption, a timeout, an exhausted retry policy, and a failed alternative implementation. This guide follows one operation through those choices against `effect@4.0.0-rc.116`.

Use [Core Runtime & Execution](../foundations/core-runtime-execution) for `Effect`, `Exit`, `Cause`, and `ExecutionPlan`; [Errors, Option & Result](../foundations/errors-option-result) for the full recovery surface; [Scheduling & Time](../concurrency/scheduling-time) for Schedule semantics; [Observability](../operations/observability) for telemetry; and [Testing & Dev Tooling](../tooling/testing-dev-tooling) for virtual time.

## Begin with the four outcomes

An `Effect<A, E, R>` exposes two channels in its type and two additional runtime outcomes:

- **Success `A`** — the operation produced its value.
- **Expected failure `E`** — a domain or integration condition callers are expected to handle.
- **Defect** — an unexpected bug or violated invariant, preserved in `Cause` rather than `E`.
- **Interruption** — cooperative cancellation, also preserved in `Cause`.

`Effect.catch` and `catchTag(s)` handle the typed error channel. A `Cause` with *no* typed failure — a pure defect or a pure interruption — passes straight through them. That is narrower than "they never consume defects": a `Cause` is a flat list of reasons, and when it holds a typed failure *and* a defect, recovering the typed failure replaces the whole `Cause` and the defect is dropped (see [Typed recovery replaces the whole Cause](#typed-recovery-replaces-the-whole-cause)). `catchCause` can see every reason, but reaching for it too early often erases the distinction the runtime is maintaining for you.

Not every unpleasant outcome belongs in `E` at all: a correct negative answer ("not eligible", "no band on file") is a success value. [Designing the error model](../foundations/errors-option-result#designing-the-error-model) has the channel-selection table and a worksheet to fill in before writing error classes.

Official guide: [Two Types of Errors](https://effect.website/docs/v4/error-management/two-error-types).

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

The error union is a protocol. Composing effects infers the union of their `E` types, and `Effect.gen` stops at the first failure, so the signature of a use case lists exactly the failures that can still escape it. Keep variants stable at service and transport boundaries, and map low-level errors into domain/integration errors at the layer that owns the dependency — [`Effect.mapError`](../foundations/errors-option-result#transforming-the-error-channel) is the operator for that translation. Do not leak every driver or SDK error through every use case. The `cause` field makes `HrisUnavailable` an *internal* error: a `Schema.TaggedError` encodes every field, so declaring this class on an HTTP or RPC endpoint would publish the wrapped error's name and message. Translate to a public variant with safe identifiers at that edge.

### Route each variant to the layer that decides its policy

Before choosing a catch operator, write down which boundary owns the policy for each variant. For the three errors above:

| Variant | Owner | Policy at that owner |
| --- | --- | --- |
| `InvalidRaise` | the API edge | reject the request; never retried |
| `EmployeeNotFound` | the use case that knows whether absence is acceptable | recover to an alternative, or let the edge answer 404 |
| `HrisUnavailable` | the retry boundary around the HRIS call | bounded backoff while `retryable`, then typed for the caller |
| a violated invariant | nobody; it is a defect, not a member of `E` | reported once at the process edge |

When one boundary must classify the *whole* union, make the classification exhaustive so that adding a variant fails compilation exactly where policy must change. Here the retry boundary owns "is this transient?".

> **Example status — Contextual:** the exhaustive classifier drives the retry predicate.

```ts
import { Effect, Match, Schedule, Schema } from "effect"

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
  { operation: Schema.String, retryable: Schema.Boolean }
) {}

type RaiseFailure = EmployeeNotFound | InvalidRaise | HrisUnavailable

// No default branch: a new RaiseFailure member is a compile error here.
const isTransient = Match.type<RaiseFailure>().pipe(
  Match.tagsExhaustive({
    EmployeeNotFound: () => false,
    InvalidRaise: () => false,
    HrisUnavailable: (error) => error.retryable
  })
)

declare const syncRaise: Effect.Effect<number, RaiseFailure>

const guarded = syncRaise.pipe(
  Effect.retry({
    while: isTransient,
    times: 3,
    schedule: Schedule.exponential("200 millis")
  })
)
```

Completeness is mechanical: the compiler proves every tag has a row, not that the row is right. [Classifying an error union](../foundations/errors-option-result#classifying-an-error-union) compares `Match.exhaustive`, `Match.tagsExhaustive`, and a `satisfies Record<...>` table.

## Recover at the narrowest owner

Recovery belongs where the fallback has business meaning:

- A repository maps “row absent” into `EmployeeNotFound` because it owns storage semantics.
- A use case may turn `EmployeeNotFound` into a domain alternative if absence is acceptable there.
- An HTTP handler maps unhandled domain errors to statuses because it owns transport semantics — a terminal fold, shown below.
- The process edge reports any remaining `Cause` and chooses an exit code.

Every handler should be one of four things: *recover* (a truthful value for the handled condition), *translate* (`mapError` at an abstraction boundary), *compensate* (undo, then re-fail), or *observe*. Use `tapError` or `tapCause` to observe without recovering. Use `Effect.result` when the outcome itself is data. Use `orDie` only when a typed failure is genuinely unrecoverable at and above that boundary; it converts the error into a defect and removes it from `E`.

**Accept `orDie` only through a gate.** All three must hold:

1. Validated construction makes the failure impossible, *or* a process owner deliberately makes a startup failure fatal.
2. No caller could recover, retry, compensate, or translate it.
3. Nothing else of value can travel in the same `Cause`: `orDie` swaps the entire `Cause` for one `Die`, so a defect recorded alongside the typed failure disappears.

`orDie` is never a way to shrink a union that is inconvenient to handle.

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

### Fold at the edge that owns the response

Selective recovery keeps a workflow alive. The terminal owner does something different: it must produce exactly one ordinary shape — an HTTP response, a CLI summary, a worker acknowledgement — so it *folds* both channels with `Effect.match` (or `matchEffect` when the handlers log or record metrics).

> **Example status — Contextual:** after the fold `E` is `never`, which documents that this boundary has accounted for every expected failure.

```ts
import { Effect, Match, Schema } from "effect"

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
  { operation: Schema.String, retryable: Schema.Boolean }
) {}

declare const approveRaise: (
  employeeId: string,
  percent: number
) => Effect.Effect<
  { readonly employeeId: string; readonly percent: number },
  EmployeeNotFound | InvalidRaise | HrisUnavailable
>

const toStatus = Match.type<EmployeeNotFound | InvalidRaise | HrisUnavailable>().pipe(
  Match.tagsExhaustive({
    EmployeeNotFound: () => 404 as const,
    InvalidRaise: () => 422 as const,
    HrisUnavailable: () => 503 as const
  })
)

const handle = (employeeId: string, percent: number) =>
  approveRaise(employeeId, percent).pipe(
    Effect.match({
      onFailure: (error) => ({ status: toStatus(error), body: { error: error._tag } }),
      onSuccess: (raise) => ({ status: 200 as const, body: raise })
    })
  ) // Effect<{ status: ...; body: ... }, never>
```

Lower layers should not fold: a repository that turns `HrisUnavailable` into a "success" DTO has stolen the retry and status decisions from every caller. The fold sees typed failures only, so a defect still reaches the process edge; `matchCause` is the variant that also folds defects and interruption, with the same caution as `catchCause`.

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

**Build the attempt inside the retried Effect.** `Effect.retry` re-runs an *Effect*, not a Promise. If a Promise is started once and the retried Effect merely awaits it, every "retry" replays the same settled rejection and the foreign call runs exactly once; call the Promise-returning function inside `Effect.tryPromise({ try: (signal) => ... })` so each attempt starts new work. Retry the transient operation, not the whole use case around it.

For simple policies `Effect.retry` also accepts an options object, `{ times, while, until, schedule }`, as used in [the classifier example](#route-each-variant-to-the-layer-that-decides-its-policy); [Scheduling & Time](../concurrency/scheduling-time#schedule) owns the Schedule API inventory.

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

The downstream system must enforce idempotency for `operationId`; merely sending the field is not enough. A local SQL transaction can make local writes atomic, but it cannot atomically commit an unrelated remote API. Use an outbox, durable Workflow Activity, or an idempotent remote operation when the crash boundary crosses systems; [Transactional write with an outbox](../recipes/transactional-write-with-outbox) works through the local half.

### Degrade when the policy is exhausted

`Effect.retry` followed by a separate `catchTag` cannot tell "the policy ran out" from "the first failure was never retryable", and it discards the schedule's output. `Effect.retryOrElse(effect, schedule, orElse)` states "retry by policy, then degrade" in one combinator: the fallback receives the last typed error *and* the schedule's final output. It takes a `Schedule`, not the options object.

> **Example status — Contextual:** after two recurrences the live lookup gives way to the last published snapshot.

```ts
import { Effect, Schedule, Schema } from "effect"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()(
  "HrisUnavailable",
  { operation: Schema.String, retryable: Schema.Boolean }
) {}

declare const liveBandMidpoint: Effect.Effect<number, HrisUnavailable>
declare const snapshotBandMidpoint: Effect.Effect<number>

const bandMidpoint = Effect.retryOrElse(
  liveBandMidpoint,
  Schedule.recurs(2),
  (error, recurrences) =>
    Effect.logWarning("HRIS still unavailable; serving snapshot", {
      operation: error.operation,
      recurrences
    }).pipe(Effect.andThen(snapshotBandMidpoint))
) // Effect<number, never>
```

Official guides: [Retrying](https://effect.website/docs/v4/error-management/retrying), [Scheduling Examples](https://effect.website/docs/v4/scheduling/examples).

## Bound waiting and preserve cancellation

Timeout is a cancellation policy. `Effect.timeout(effect, duration)` interrupts the operation if the deadline wins and fails with `TimeoutError`; a source failure that arrives before the deadline is preserved unchanged. `timeoutOption` represents expiry as `Option.none` — only the expiry, so source failures stay in `E`; use it when a timeout genuinely means "absent". `timeoutOrElse({ duration, orElse })` supplies another Effect, and it finishes interrupting the source, finalizers included, *before* it evaluates the fallback, so the two never overlap.

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

Interruption is cooperative at Effect boundaries. Finalizers are uninterruptible by default so cleanup can finish. Use `uninterruptible` sparingly around the smallest commit region; a large uninterruptible operation makes shutdown and timeouts unresponsive. `uninterruptibleMask` lets setup/commit stay protected while `restore(effect)` re-opens cancellation around slow work. [Core Runtime & Execution](../foundations/core-runtime-execution#6-interruption-resource-safety) covers the mechanics, including forwarding the `AbortSignal` so that an interrupted attempt really stops its network call.

### Where the timeout sits relative to retry

"What bounds attempts and elapsed time?" has two different answers depending on operator order, and production code usually wants both:

- **`timeout` before `retry` is a per-attempt budget.** Each attempt is interrupted at its own deadline, and `TimeoutError` becomes an *input to the retry policy* — it is retried only if the policy classifies it as retryable.
- **`timeout` after `retry` is a whole-operation budget.** It caps the entire sequence, delays included, and interrupts whichever attempt or sleep is in flight when it expires.

> **Example status — Contextual:** a two-second budget per attempt inside a ten-second budget for the operation.

```ts
import { Cause, Effect, Schedule, Schema } from "effect"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()(
  "HrisUnavailable",
  { operation: Schema.String, retryable: Schema.Boolean }
) {}

declare const fetchRoster: Effect.Effect<ReadonlyArray<string>, HrisUnavailable>

const guardedRoster = fetchRoster.pipe(
  Effect.timeout("2 seconds"), // per attempt: E is now HrisUnavailable | TimeoutError
  Effect.retry({
    // The policy must say whether a timed-out attempt is worth repeating.
    while: (error) => Cause.isTimeoutError(error) || error.retryable,
    times: 3,
    schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered)
  }),
  Effect.timeout("10 seconds") // whole operation, backoff included
)
```

A per-attempt timeout on a write has the same hazard as any other retry of a write: the interrupted attempt may already have committed remotely.

Official guide: [Timing Out](https://effect.website/docs/v4/error-management/timing-out).

## Inspect the full Cause without flattening it

Concurrent Effects can fail together, and finalizers can fail while another operation is already failing. `Cause` keeps every one of those reasons — typed failures, defects, and interruptions — instead of forcing them into one exception. In `rc.116` a `Cause<E>` is a **flat** `reasons` array of `Fail`, `Die`, and `Interrupt` values; there are no sequential or parallel nodes to walk. `Cause.combine(left, right)` concatenates two causes and drops reasons that are equal by value.

Use `Effect.exit` when code needs to inspect how an Effect ended without failing. Use `Cause.pretty` for diagnostics; `hasFails` / `hasDies` / `hasInterrupts` for whole-cause questions; `findError` (a `Result`) or `findErrorOption` (an `Option`) for the first typed failure, and `findDefect` for the first defect; and the `is*Reason` guards when looping over `cause.reasons`. `Cause.squash` is a last-mile bridge to an exception-shaped API; it collapses the list to a single value, so do not use it as the application's internal error model.

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

Do not `catchCause(() => Effect.void)` around a long-running service. That swallows defects and can turn interruption into an accidental restart loop. Recover specific typed failures inside the loop and let unexpected causes terminate the owner. When a boundary does recover at the `Cause` level, it propagates what it does not own with `Effect.failCause(cause)` — the same cause, unchanged.

### Typed recovery replaces the whole Cause

Every typed-channel operator is built on the same lookup: find the **first `Fail` reason** in the flat `Cause`.

- **No `Fail` reason** (a pure defect, a pure interruption): the `Cause` passes through untouched. This is the case people have in mind when they say "`catch` does not catch defects".
- **A `Fail` reason that the selector does not match** (`catchTag("Other", ...)`): the original `Cause` is re-raised, every reason intact.
- **A `Fail` reason that is handled:** the handler's result becomes the *entire* outcome. A `Die` or `Interrupt` recorded next to it is dropped.

The third case applies to `Effect.catch`, `catchTag` / `catchTags`, `catchIf`, `catchFilter`, `catchReason(s)`, `mapError`, `orDie`, `orElseSucceed`, `firstSuccessOf`, `match` / `matchEffect`, `result`, `option`, `ignore`, and `retry` (a mixed `Cause` is retried like any typed failure, and the defect from the failed attempt is gone). `catchDefect` is the mirror image: it looks for the first `Die` and, when it recovers, drops a typed failure recorded beside it. Only the *first* `Fail` is inspected, so `catchTag("B", ...)` does not fire for reasons `[Fail(A), Fail(B)]`.

Mixed causes are not exotic. They arise whenever outcomes combine: a failing operation whose finalizer then dies, a concurrent sibling whose cleanup dies while it is being interrupted, an `Effect.race` in which every contender fails, or an explicit `Cause.combine`.

> **Example status — Runnable:** one typed failure plus a dying finalizer, recovered four ways.

```ts
import { Cause, Effect, Exit, Schema } from "effect"

class ExportFailed extends Schema.TaggedError<ExportFailed>()(
  "ExportFailed",
  { batchId: Schema.String }
) {}

// A typed failure whose finalizer then dies: one Cause, two reasons.
const exportBatch = Effect.fail(new ExportFailed({ batchId: "b-7" })).pipe(
  Effect.ensuring(Effect.die(new Error("ledger handle already closed")))
)

// 1. Typed recovery: the handler's result replaces the whole Cause.
const lossy = exportBatch.pipe(
  Effect.catchTag("ExportFailed", () => Effect.succeed("skipped"))
)

// 2. Guarded catchCause: re-fail when anything besides typed failures is present.
const guarded = exportBatch.pipe(
  Effect.catchCause((cause) =>
    Cause.hasDies(cause) || Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.succeed("skipped")
  )
)

// 3. Reason inspection: recover one specific failure, and only when it is the whole story.
const specific = exportBatch.pipe(
  Effect.catchCause((cause) => {
    const [first, ...rest] = cause.reasons
    return first !== undefined && rest.length === 0 &&
        Cause.isFailReason(first) && first.error._tag === "ExportFailed"
      ? Effect.succeed(`skipped ${first.error.batchId}`)
      : Effect.failCause(cause)
  })
)

// 4. Sandbox: move the Cause into E, decide with ordinary catch, restore with failCause.
const sandboxed = exportBatch.pipe(
  Effect.sandbox,
  Effect.catch((cause) =>
    cause.reasons.every(Cause.isFailReason)
      ? Effect.succeed("skipped")
      : Effect.failCause(cause)
  )
)

const reasonTags = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? "Success"
    : exit.cause.reasons.map((reason) => reason._tag).join("+")

console.log(reasonTags(await Effect.runPromiseExit(exportBatch))) // Fail+Die
console.log(reasonTags(await Effect.runPromiseExit(lossy))) // Success — the defect is gone
console.log(reasonTags(await Effect.runPromiseExit(guarded))) // Fail+Die
console.log(reasonTags(await Effect.runPromiseExit(specific))) // Fail+Die
console.log(reasonTags(await Effect.runPromiseExit(sandboxed))) // Fail+Die
console.log(reasonTags(await Effect.runPromiseExit(Effect.orDie(exportBatch)))) // Die — only ExportFailed, as a defect
```

Practical rules:

- **Where a mixed `Cause` is possible and the other reasons matter, recover through `catchCause` with an explicit guard** (or `sandbox`), and re-fail with the unchanged cause otherwise. Around plain domain logic with no fallible finalizers, ordinary `catchTag` is still the right tool.
- **`tapError`, `tapCause`, and `tapDefect` lose nothing**: they re-raise the original `Cause` after a successful observer.
- **Never use `orDie` as union cleanup**; it discards the defect you would most want to see.
- **`Effect.sandbox` has no `unsandbox` counterpart in `rc.116`** (a stale doc comment still names one); restore the ordinary error model with `Effect.catch((cause) => Effect.failCause(cause))`.
- **Multiple domain errors are better modeled as data** — `Effect.validate` or `Effect.partition` — than as several `Fail` reasons, because typed handlers see only the first.

[Core Runtime & Execution](../foundations/core-runtime-execution#cause) documents the `Cause` API itself.

Official guides: [Parallel and Sequential Errors](https://effect.website/docs/v4/error-management/parallel-and-sequential-errors), [Cause](https://effect.website/docs/v4/data-types/cause), [Sandboxing](https://effect.website/docs/v4/error-management/sandboxing).

## Roll back partial work with exit-aware finalizers

A release function receives the `Exit` its scope closed with. That turns a sequence of `acquireRelease` steps inside one `Effect.scoped` into an in-process compensating transaction: each step's release undoes its creation *only when the scope closes with a failure*, and the undo steps run in reverse order of acquisition, so a dependent record is removed before the thing it depends on.

> **Example status — Runnable:** the third step fails, so the ledger entry and then the grant are undone; on success nothing is undone.

```ts
import { Effect, Exit, Schema } from "effect"

class PayrollDown extends Schema.TaggedError<PayrollDown>()(
  "PayrollDown",
  { operationId: Schema.String }
) {}

const log: Array<string> = []

const step = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      log.push(`create ${name}`)
      return name
    }),
    // Undo only when the enclosing scope closes with a failure (or interruption).
    (created, exit) =>
      Exit.isFailure(exit)
        ? Effect.sync(() => { log.push(`undo ${created}`) })
        : Effect.void
  )

const issueGrant = (payrollUp: boolean) =>
  Effect.gen(function*() {
    yield* step("equity-grant")
    yield* step("ledger-entry")
    if (!payrollUp) {
      return yield* new PayrollDown({ operationId: "grant:2026:e-42" })
    }
    return "issued"
  }).pipe(Effect.scoped)

await Effect.runPromiseExit(issueGrant(false))
console.log(log) // ["create equity-grant", "create ledger-entry", "undo ledger-entry", "undo equity-grant"]

log.length = 0
await Effect.runPromise(issueGrant(true))
console.log(log) // ["create equity-grant", "create ledger-entry"]
```

Two limits keep this honest:

- **A finalizer cannot fail in `E`.** The release of `acquireRelease`, `Effect.ensuring`, and `Effect.addFinalizer` has error type `never`, so a fallible undo forces a decision up front: log and ignore (`Effect.ignore({ log: true })`), bound it with a timeout and ignore, or `orDie` when a failed undo is a bug. `Effect.acquireUseRelease` and `Effect.onExit` are the forms whose cleanup *may* fail in `E`. Whatever you choose, the original failure is not overwritten: a failing use and a failing release both appear in the resulting `Cause`, so tests should assert through `Effect.exit`.
- **It does not survive process death.** This is rung zero of the [durability ladder](durability-and-distribution-ladder); when the crash boundary crosses systems, use an outbox, an idempotent remote operation, or a durable Workflow with compensation.

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

Use ordinary `catchTag` when the fallback is a different value or business path. Use `ExecutionPlan` when the computation stays the same and the provided implementation changes. Between the two sit the value-level fallbacks: `Effect.firstSuccessOf([a, b, c])` tries *different effects* in order and fails with the last error, `Effect.retryOrElse` degrades after a policy is exhausted, and `Effect.orElseSucceed` replaces every typed failure with a value computed from the error (the function receives it since rc.116) — narrow with `catchTag` first if only one variant should default. All of them act on typed failures only; see [Fallback values and ignoring failures](../foundations/errors-option-result#fallback-values-and-ignoring-failures).

Official guide: [Fallback](https://effect.website/docs/v4/error-management/fallback).

## Observe once, where ownership is clear

Retries and fallbacks multiply attempts, so telemetry needs two levels:

- One span for the logical operation (`Effect.fn("Payroll.recordRaise")`).
- Attempt events from `Schedule.tap` or the `onEvent` option of `Effect.withExecutionPlan`, tagged with attempt/step metadata.
- One terminal log or metric at the boundary that owns the operation.

Avoid logging the same failure in repository, service, handler, and process code. Lower levels should enrich typed errors or spans; the owner decides whether an outcome is noteworthy. Never put secrets or rejected personal data into annotations merely because structured logging makes it convenient.

Pick the narrowest tap for the job: `Effect.tapErrorTag("HrisUnavailable", f)` observes one member of a tagged union (it also accepts an array of tags), `Effect.tapDefect(f)` fires only for defects — the natural "report a bug" hook that leaves typed failures alone — and `Effect.tapCause(f)` sees everything, interruption included. When the observer succeeds, the original `Cause` is re-raised unchanged. **When the observer itself fails, its failure replaces the original one** (the signature shows this as `E | E2`), so keep observers infallible: log, or wrap a fallible metric or audit call in `Effect.ignore({ log: true })`.

> **Example status — Contextual:** targeted observation that cannot change the outcome.

```ts
import { Effect, Schema } from "effect"

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()(
  "EmployeeNotFound",
  { employeeId: Schema.String }
) {}

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()(
  "HrisUnavailable",
  { operation: Schema.String, retryable: Schema.Boolean }
) {}

declare const loadEmployee: (
  id: string
) => Effect.Effect<{ readonly id: string }, EmployeeNotFound | HrisUnavailable>

declare const recordOutage: (operation: string) => Effect.Effect<void, "MetricsDown">

const observed = (id: string) =>
  loadEmployee(id).pipe(
    Effect.tapErrorTag("HrisUnavailable", (error) =>
      // A failing metrics backend must not turn HrisUnavailable into "MetricsDown".
      recordOutage(error.operation).pipe(Effect.ignore({ log: true }))
    ),
    Effect.tapDefect((defect) => Effect.logError("bug in employee lookup", defect))
  ) // E is still EmployeeNotFound | HrisUnavailable
```

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

Also test a permanent error stops immediately, an exhausted policy returns the last typed failure, interrupting a blocked attempt releases its resources, and an idempotency key stays identical across attempts. Assert each outcome with the matching tool — tag *and* fields through `Exit.findErrorOption` for a typed failure, `Exit.hasDies` for a defect, `Exit.hasInterrupts` plus the observed cleanup for interruption — as laid out in [The three failure buckets](../foundations/errors-option-result#the-three-failure-buckets).

## Operational checklist

- Keep expected failures in `E`; reserve defects for bugs and impossible invariants; return a correct negative answer as a success value.
- Give error variants decision-relevant fields rather than parseable message strings.
- Decide each variant at the layer responsible for its policy, and classify a whole union with `Match.exhaustive` / `Match.tagsExhaustive` so a new variant fails compilation there.
- Handle an error at the narrowest layer that owns a meaningful recovery; fold with `Effect.match` only at the terminal boundary.
- Use `tapError`/`tapCause` for observation and `catchTag(s)` for recovery; keep observers infallible.
- Accept `orDie` only through the three-condition gate, never to shrink a union.
- Remember that typed recovery replaces the whole `Cause`; guard with `catchCause` or `sandbox` wherever a finalizer or sibling can add a defect.
- Retry only classified transient failures, with both attempt and time/delay bounds, and decide whether each timeout is per attempt or for the whole operation.
- Prove the whole retried Effect is repeatable or supply enforced idempotency.
- Remember that timeout/interruption does not prove a remote write was rolled back.
- Keep uninterruptible regions small; place slow waits inside restored interruptibility.
- Let scoped acquisition own cleanup and test that interruption runs finalizers.
- Decide what a failing cleanup means — finalizers cannot fail in `E`, so choose log-and-ignore, time-bound-and-ignore, or `orDie` — and assert through `Effect.exit`, because a failing use and a failing release both stay in the `Cause`.
- Use exit-aware finalizers for in-process rollback, and a durable mechanism once the crash boundary crosses systems.
- Use `ExecutionPlan` when fallback changes provided implementations.
- Preserve every `Cause` reason internally; squash only at exception-shaped edges.
- Emit one logical-operation span, explicit attempt telemetry, and one terminal outcome.
- Drive Schedule and timeout tests with `TestClock`, never real sleeps.

The reliable sequence is: **classify the failure, decide whether the operation is repeatable, bound retries, preserve cancellation and cleanup, then choose recovery or a different implementation explicitly.**
