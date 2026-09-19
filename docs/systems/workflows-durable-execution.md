# Workflows & Durable Execution

> **Note:** A **Workflow** is the durable orchestration — deterministic glue code. The side-effecting steps inside it are **Activities**: a completed `Exit` is journaled, and later replay returns that result instead of deliberately re-running the step. Activity delivery is still **at least once** until the result is durably recorded, so external writes need an idempotency token, transaction, or outbox. **DurableClock** gives you sleeps that survive restarts; **DurableDeferred** gives you a wait-point an external system can complete later; **DurableQueue** hands work to background workers durably. The **WorkflowEngine** executes, persists, suspends, and resumes everything. **WorkflowProxy**/**WorkflowProxyServer** derive a typed RPC or HTTP surface so callers can start and resume runs without importing the handler.

> **Warning:** A workflow body is replayed from the journal after every suspension or crash. So the body itself must be **deterministic** — same inputs, same sequence of steps. Never read the clock, generate randomness, or perform a side effect *directly* in the workflow. Wrap every non-deterministic or effectful step in an `Activity` (or a durable primitive), and make external effects idempotent. A crash after the external system commits but before the Activity result is persisted can cause that Activity to be delivered again.

## Workflow

`effect/unstable/workflow` — unstable

`Workflow.make(tag, options)` records a stable tag, a `payload` Schema, optional `success`/`error` Schemas, and an `idempotencyKey` function that turns a payload into a string. The engine hashes `tag + idempotencyKey(payload)` into a deterministic **execution id**: starting the same logical work twice yields the same run, not two.

`workflow.toLayer(execute)` registers the body with the engine and returns a `Layer`. The body receives the decoded payload and execution id and returns an Effect. Drive runs with `workflow.execute(payload)` (await result), `execute(payload, { discard: true })` (fire-and-forget, returns execution id), `poll(id)`, `interrupt(id)`, and `resume(id)`.

```ts
import { Effect, Schema } from "effect"
import { Activity, DurableClock, Workflow } from "effect/unstable/workflow"

// Typed, recoverable failure — a normal Schema tagged error.
class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()("BudgetExceeded", {
  employeeId: Schema.String
}) {}

// 1. The contract: a merit raise to apply, a confirmation string out, BudgetExceeded as the typed failure.
export const ApproveMeritIncrease = Workflow.make("ApproveMeritIncrease", {
  payload: {
    employeeId: Schema.String,
    cycleId: Schema.String,
    // BigDecimal-as-string keeps currency exact over the wire.
    newBaseSalary: Schema.String
  },
  success: Schema.String,
  error: BudgetExceeded,
  // Deterministic execution id: re-submitting the same employee + cycle is a no-op, not a double-raise.
  idempotencyKey: ({ employeeId, cycleId }) => `${cycleId}:${employeeId}`
})

// 2. The implementation: deterministic glue around journaled activities + a durable wait.
export const ApproveMeritIncreaseLayer = ApproveMeritIncrease.toLayer(
  Effect.fn("ApproveMeritIncrease")(function*(payload, executionId) {
    // Each side effect lives in an Activity. Its recorded result is replayed,
    // while an interrupted delivery may run again before that result is recorded.
    const reservation = yield* Activity.make({
      name: "ReserveMeritBudget",
      success: Schema.String, // a budget reservation id
      error: BudgetExceeded,
      execute: Effect.gen(function*() {
        const idempotencyKey = yield* Activity.idempotencyKey("ReserveMeritBudget")
        return yield* reserveBudget(
          payload.cycleId,
          payload.employeeId,
          payload.newBaseSalary,
          idempotencyKey
        )
      })
    })

    // Survive a restart while we wait out the HRBP review SLA window.
    yield* DurableClock.sleep({ name: "HrbpReviewSla", duration: "2 days" })

    yield* Activity.make({
      name: "WriteSalaryToHris",
      execute: Effect.gen(function*() {
        const idempotencyKey = yield* Activity.idempotencyKey("WriteSalaryToHris")
        yield* writeSalary(payload.employeeId, payload.newBaseSalary, idempotencyKey)
      })
    })

    return `merit increase for ${payload.employeeId} applied (${reservation})`
  })
)

declare const reserveBudget: (
  cycleId: string,
  employeeId: string,
  amount: string,
  idempotencyKey: string
) => Effect.Effect<string, BudgetExceeded>
declare const writeSalary: (
  employeeId: string,
  amount: string,
  idempotencyKey: string
) => Effect.Effect<void>
```

> **Tip:** `Workflow.withCompensation(effect, (value, cause) => cleanup)` registers a saga-style rollback that runs only if the *whole* workflow fails. `Workflow.addFinalizer` provides unconditional cleanup. Compensation applies to top-level effects in the body, not steps nested inside an Activity. Two annotations change failure handling — attach them with `workflow.annotate(...)`: `Workflow.CaptureDefects` (default `true`: a defect becomes the run's recorded failure instead of crashing the attempt) and `Workflow.SuspendOnFailure` (default `false`: when `true`, any failure parks the run as `Suspended` so an operator can fix the cause and call `workflow.resume(executionId)`).

### Finalizers, compensation, and cancellation

Three cleanup mechanisms exist, and they answer to different owners.

| Mechanism | Runs when | Use it for |
| --- | --- | --- |
| `Workflow.addFinalizer((exit) => …)` | The **execution** reaches a terminal state (`Complete`), on whichever runner finishes it. Skipped when an owner merely abandons an attempt. | Durable, terminal-state work: publish "raise workflow finished", release a durable reservation. |
| `Workflow.withCompensation(step, undo)` | The execution terminates in failure **after** `step` succeeded. Built on `addFinalizer`, so it shares its rules. | Saga-style undo of a committed top-level step. |
| Scope finalizers under `Workflow.provideScope(effect)` / `Workflow.scope` | The workflow scope closes on **this owner** — including when the attempt is abandoned for replay. | Process-local resources: a socket, a lock handle, a temp file. |

```ts
import { Effect, Exit, Schema } from "effect"
import { Activity, DurableDeferred, Workflow } from "effect/unstable/workflow"

const HrbpDecision = DurableDeferred.make("HrbpDecision", {
  success: Schema.Literals(["approved", "rejected"])
})

export const EquityGrant = Workflow.make("EquityGrant", {
  payload: { grantId: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ grantId }) => grantId
})

export const EquityGrantLayer = EquityGrant.toLayer(
  Effect.fn("EquityGrant")(function*({ grantId }) {
    // Terminal-state work: runs when the EXECUTION completes, on whichever owner finishes it.
    yield* Workflow.addFinalizer((exit) =>
      publishGrantClosed(grantId, Exit.isSuccess(exit) ? "applied" : "abandoned-or-failed")
    )

    // Saga step: if the run later fails, release the shares that were reserved.
    const reservationId = yield* Activity.make({
      name: "ReserveShares",
      success: Schema.String,
      execute: reserveShares(grantId)
    }).pipe(
      Workflow.withCompensation((reservation) => releaseShares(reservation))
    )

    // Owner-local resource: closed with the workflow scope on THIS process.
    yield* Effect.acquireRelease(openAuditSocket(grantId), (socket) => socket.close).pipe(
      Workflow.provideScope
    )

    const decision = yield* DurableDeferred.await(HrbpDecision)
    return `${grantId}: ${decision} (${reservationId})`
  })
)

declare const publishGrantClosed: (grantId: string, status: string) => Effect.Effect<void>
declare const reserveShares: (grantId: string) => Effect.Effect<string>
declare const releaseShares: (reservationId: string) => Effect.Effect<void>
declare const openAuditSocket: (
  grantId: string
) => Effect.Effect<{ readonly close: Effect.Effect<void> }>
```

- **Never release a process-local resource from `addFinalizer`.** If the owner is lost the finalizer is skipped here, and when it eventually runs it may be on another machine.
- **Compensation is not an atomic rollback.** It is an ordinary effect that can fail, be interrupted, or run more than once; make it idempotent and record its own outcome.
- **Registration happens on every pass through the body.** `addFinalizer`, `withCompensation`, and scope finalizers are registered by running code, and the body runs again after each suspension. A probe against `WorkflowEngine.layerMemory` on `rc.115` shows a workflow that suspended once running each of them **twice** at completion (the journaled activity itself ran once). Treat every finalizer and compensation as at-least-once.
- **An `Effect.onExit` in the body cannot observe a workflow interrupt.** Interruption is deposited through the engine; use `addFinalizer` when terminal-state logic must see it.
- **Cancellation is not rollback.** Distinguish five events and decide the state and side effects of each: the *caller stops waiting* (the run continues); the run *receives an interrupt* via `workflow.interrupt(id)` (terminal, finalizers and compensation run); the run *suspends* on a clock, deferred, queue, or child (nothing is lost, no cleanup runs); the *owner is lost* and the attempt is abandoned (replay elsewhere); and *cancel races completion* (whichever is recorded first wins, so the canceller must read the final status rather than assume).

### Abandoned run attempts

With `ClusterWorkflowEngine`, a run can be interrupted for a purely transient reason: its runner is shutting down, or the shard moved. From `rc.113` the engine classifies that interrupt as an **abandoned attempt**:

- nothing about the attempt is persisted — no result, no failure, no suspension record;
- `addFinalizer` callbacks and compensations do **not** run, and a parent workflow is **not** resumed;
- owner-local scope finalizers still run, so process resources are released;
- the execution is replayed from its journal by the next owner, where completed activities return their recorded results.

The practical consequence is the same rule as for a crash: an activity that was in flight may execute again, so the idempotency token still matters. Interrupt finalization in the in-memory engine was aligned with the cluster engine in `rc.111` (and an interrupt now survives a replay there), so tests against `WorkflowEngine.layerMemory` exercise the same finalization rules — but the in-memory engine has no owners to lose, so it cannot produce an abandoned attempt.

**Reach for it when** you have a multi-step business process that must survive restarts, suppress replay after completed steps are recorded, and be resumable and idempotent by a stable key.

## Activity

`effect/unstable/workflow` — unstable

`Activity.make({ name, success, error, execute })` wraps an Effect so the engine runs it, persists its `Exit`, and — on later replay after that persistence succeeds — returns the stored result instead of re-executing. An `Activity` *is* an Effect (use `yield*`), so it composes like any other. Before the `Exit` is durably recorded, an interrupted or redelivered Activity may execute again.

The activity is the boundary between deterministic replayable glue and side-effecting work. Everything non-deterministic — external writes, clock reads, randomness — belongs inside one. The `name` is the journal key; it must be stable and unique within the workflow.

```ts
import { Effect, Schema } from "effect"
import { Activity } from "effect/unstable/workflow"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {}) {}

const PostSalaryChange = Effect.gen(function*() {
  // Activity.CurrentAttempt is a Context.Reference holding the retry attempt (starts at 1).
  const attempt = yield* Activity.CurrentAttempt
  const idempotencyKey = yield* Activity.idempotencyKey("WriteSalaryToHris")
  yield* Effect.log(`writing salary change to HRIS, attempt ${attempt}`)
  return yield* callHrisApi(idempotencyKey)
}).pipe(
  // Activity.retry bumps CurrentAttempt on each attempt; same options as Effect.retry minus `schedule`.
  Activity.retry({ times: 5 })
)

const WriteSalaryActivity = Activity.make({
  name: "WriteSalaryToHris",
  success: Schema.String, // the HRIS record revision id
  error: HrisUnavailable,
  execute: PostSalaryChange
})

declare const callHrisApi: (idempotencyKey: string) => Effect.Effect<string, HrisUnavailable>
```

The default `interruptRetryPolicy` is bounded and filters for interruption causes. If you replace it, its input is `Cause<unknown>`: retain an explicit `Cause.hasInterrupts` predicate and a finite attempt bound unless retrying typed failures and defects is intentional.

> **Tip:** `Activity.idempotencyKey(name)` derives a deterministic hash from the current execution id and the name (optionally folding in the attempt) — useful as a dedup token to pass to external systems so retried writes cannot post twice. `Activity.raceAll(name, [a, b, c])` runs several activities as a durable, success-biased race: the first success wins, or the collected failure wins only if every activity fails. The chosen result is journaled across restarts.

**Scope the idempotency key to the logical operation.** `Activity.idempotencyKey(name)` hashes the execution id and the name, so every retry and every replay of that activity sends the *same* token — right when all attempts are one logical operation, such as one payroll write. Pass `{ includeAttempt: true }` only when each attempt is meant to create a distinct external resource. Never mint a fresh random key inside the activity: a replay would produce a different one and defeat the dedup.

**Child workflows started from an activity.** An activity may execute child workflows, including several in parallel (`Effect.all([...], { concurrency })`). All children are dispatched before the parent suspends, the activity's resources are released while it waits durably, and the parent resumes when the children complete — including when they complete while the parent is still cleaning up. (Suspension waits for running activities to finish or suspend; from `rc.113` an activity whose start was interrupted no longer leaves that count raised, which could previously block a later suspension.)

For SQL-backed workflow storage, an activity can opt into the engine's storage transaction with `.annotate(ClusterSchema.WithTransaction, true)` (the default is `false`). With `SqlMessageStorage`, database effects that use the supplied `SqlClient` then commit with the activity result. This is a backend-specific local transaction boundary: it does not make an external HTTP/API write atomic, so those calls still need an idempotency token or an outbox.

**Reach for it when** a step inside a workflow touches the outside world or is otherwise non-deterministic, and its completed result must be remembered. Design the effect for at-least-once delivery with an idempotency token or transactional boundary.

## DurableClock

`effect/unstable/workflow` — unstable

`DurableClock.sleep({ name, duration })` pauses a workflow for a duration that may be minutes, hours, or days with no fiber kept alive. A normal `Effect.sleep` holds a fiber; if the process dies, the sleep is gone. A durable sleep schedules a wake-up in the engine and *suspends* the workflow. When the timer fires (even on a different machine after a redeploy), the engine resumes the run. Internally it uses an in-memory activity for short durations (≤ 60-second threshold by default) and a scheduled `DurableDeferred` wake-up for longer ones.

```ts
import { Effect, Schema } from "effect"
import { Activity, DurableClock, Workflow } from "effect/unstable/workflow"

export const EquityGrantApproval = Workflow.make("EquityGrantApproval", {
  payload: { employeeId: Schema.String, shares: Schema.Natural },
  idempotencyKey: ({ employeeId }) => employeeId
})

export const EquityGrantApprovalLayer = EquityGrantApproval.toLayer(
  Effect.fn("EquityGrantApproval")(function*({ employeeId, shares }) {
    yield* Activity.make({ name: "NotifyHrbp", execute: notifyHrbp(employeeId, shares) })

    // The engine resumes us here 5 days later if no one has acted — surviving any number of restarts.
    yield* DurableClock.sleep({ name: "vp-approval-sla", duration: "5 days" })

    yield* Activity.make({ name: "EscalateToVp", execute: escalateToVp(employeeId) })
  })
)

declare const notifyHrbp: (id: string, shares: number) => Effect.Effect<void>
declare const escalateToVp: (id: string) => Effect.Effect<void>
```

> **Warning:** Give every sleep a **stable, unique `name`** within the workflow — it's the journal key for that wake-up. Two sleeps sharing a name will collide on replay.

**`inMemoryThreshold` decides which kind of sleep you get.** A duration at or below the threshold (default 60 seconds) runs as an ordinary `Effect.sleep` inside a journaled activity named `DurableClock/<name>`: cheap, but if the owner dies mid-sleep the activity starts over, so the wait restarts from zero. A longer duration schedules a durable wake-up and suspends the run. Pass `inMemoryThreshold: 0` to force the durable path for every non-zero sleep (an explicit `0` is honored), or raise it when short waits dominate and restart precision does not matter. A zero `duration` returns immediately.

**Reach for it when** a workflow must wait a meaningful amount of time (minutes to months) without pinning a fiber while staying crash-proof.

## DurableDeferred

`effect/unstable/workflow` — unstable

`DurableDeferred.make(name, { success, error })` defines a durable, named wait-point. Inside a workflow, `DurableDeferred.await(deferred)` blocks by suspending the run until a result is recorded. Outside the workflow, complete it with a **token** via `DurableDeferred.succeed`, `fail`, or `done`.

The token is a branded string identifying the workflow name, execution id, and deferred name. Obtain one inside the run with `DurableDeferred.token(deferred)`, or derive one externally via `tokenFromExecutionId` / `tokenFromPayload`. The resolved value lives in storage and survives restarts; the completer can be a completely different program.

```ts
import { Effect, Schema } from "effect"
import { Activity, DurableDeferred, Workflow } from "effect/unstable/workflow"

// A wait-point for the VP's sign-off on an equity grant.
const VpSignOff = DurableDeferred.make("VpSignOff", {
  success: Schema.Literals(["approved", "rejected"])
})

// Inside the workflow body: capture a token to hand out, then suspend until the VP decides.
const awaitVpSignOff = Effect.gen(function*() {
  const token = yield* DurableDeferred.token(VpSignOff)
  yield* Activity.make({
    name: "NotifyVp",
    execute: Effect.gen(function*() {
      const idempotencyKey = yield* Activity.idempotencyKey("NotifyVp")
      yield* notifyVp(token, idempotencyKey)
    })
  })
  return yield* DurableDeferred.await(VpSignOff) // suspends the run until completed
})

// Elsewhere — e.g. an HTTP handler when the VP clicks "Approve" in the comp tool:
const resolveSignOff = (token: DurableDeferred.Token) =>
  DurableDeferred.succeed(VpSignOff, { token, value: "approved" })

declare const notifyVp: (
  token: DurableDeferred.Token,
  idempotencyKey: string
) => Effect.Effect<void>
```

> **Tip:** `DurableDeferred.into(effect, deferred)` runs an effect and records its `Exit` into the deferred, resuming waiters — the plumbing behind queues and races. `DurableDeferred.raceAll({ name, success, error, effects })` is success-biased: it persists the first success, or the collected failure only after all effects fail. A completion can wake an active parked workflow immediately, and replay observes the recorded result. Because `into` *records* an `Exit`, its requirements include the deferred's success and error schema **encoding** services as well as the decoding ones; a schema that needs a service to encode must have it provided where `into` runs.

**Reach for it when** a workflow must pause until an out-of-band signal arrives — an external approval, a third-party webhook.

## DurableQueue

`effect/unstable/workflow` — unstable

`DurableQueue.make({ name, payload, success, error, idempotencyKey })` defines a durable task queue. A workflow calls `DurableQueue.process(queue, payload)` to enqueue and suspend. A worker built with `DurableQueue.worker(queue, handler)` (a `Layer`) or `makeWorker` drains it.

`process` encodes the payload, offers it to a persisted queue, attaches a `DurableDeferred` token, and suspends the workflow. A worker takes the item, runs the handler, and records the handler's `Exit` through that token so the original run continues with the success or error. The worker supports configurable `concurrency` and can run in a separate deployment from the workflows that feed it.

```ts
import { Effect, Schema } from "effect"
import { DurableQueue } from "effect/unstable/workflow"

const StatementQueue = DurableQueue.make({
  name: "EquityStatements",
  payload: { grantId: Schema.String },
  success: Schema.String, // the rendered statement url
  idempotencyKey: ({ grantId }) => grantId
})

// Producer side, inside a workflow: enqueue and suspend until a worker finishes.
const renderStatement = (grantId: string) =>
  DurableQueue.process(StatementQueue, { grantId })

// Consumer side: a layer that runs 4 workers draining the queue.
const StatementWorker = DurableQueue.worker(
  StatementQueue,
  ({ grantId }) => renderEquityStatement(grantId),
  { concurrency: 4 }
)

declare const renderEquityStatement: (grantId: string) => Effect.Effect<string>
```

**Reach for it when** a workflow needs to offload a unit of work to a pool of durable background workers and wait for the typed result.

## WorkflowEngine

`effect/unstable/workflow` — unstable

`WorkflowEngine` is the service that registers workflow handlers, runs executions, journals activity results, stores durable-deferred completions, schedules clocks, polls status, and suspends/resumes runs. `WorkflowInstance` is the per-run state threaded through a single execution.

Everything else is a definition; the engine executes and persists. Its methods are called indirectly via `workflow.execute`, `Activity.make`, etc. Choose the engine layer to provide: `WorkflowEngine.layerMemory` is in-process and ephemeral (tests and local dev); for production provide a persistent engine such as `ClusterWorkflowEngine` from the cluster package.

```ts
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { Workflow, WorkflowEngine } from "effect/unstable/workflow"

const ProrateBonus = Workflow.make("ProrateBonus", {
  payload: {
    employeeId: Schema.String,
    monthsWorked: Schema.Natural.check(Schema.isLessThanOrEqualTo(12))
  },
  success: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  idempotencyKey: ({ employeeId }) => employeeId
})

const ProrateBonusLayer = ProrateBonus.toLayer(
  ({ monthsWorked }) => Effect.succeed(Math.round((monthsWorked / 12) * 100) / 100)
)

const program = Effect.gen(function*() {
  // Fire-and-forget: get the deterministic execution id back.
  const id = yield* ProrateBonus.execute({ employeeId: "emp_42", monthsWorked: 6 }, { discard: true })
  // Await a result (idempotent — same key => same run).
  const result = yield* ProrateBonus.execute({ employeeId: "emp_42", monthsWorked: 6 })
  // Inspect a run's status.
  const status = yield* ProrateBonus.poll(id)

  if (Option.isSome(status) && status.value._tag === "Complete") {
    yield* Effect.log(Exit.isSuccess(status.value.exit) ? "done" : "failed")
  }
  return result // 0.5
}).pipe(
  // Register the workflow, then back it with the in-memory engine.
  Effect.provide(ProrateBonusLayer.pipe(Layer.provideMerge(WorkflowEngine.layerMemory)))
)
```

> **Note:** A workflow `Result` is either `Complete` (carrying an `Exit`) or `Suspended` (the run is parked on a clock, deferred, or queue). That's how `poll` distinguishes "finished" from "waiting on something."

**What `layerMemory` proves, and what it does not.** It proves the contract, the control flow, replay determinism within one process, and interrupt/compensation ordering. It does not prove durability, redelivery after a kill, behavior under two owners, or compatibility of stored bytes with a new deployment. Those need the production engine and storage — see [Recovery testing and operations](#recovery-testing-and-operations).

**With `ClusterWorkflowEngine`,** each execution is a cluster entity with a fixed ten-second idle time, so a suspended or finished run releases its runner slot quickly and is rebuilt from storage on its next message; see [Cluster & Sharding](cluster-sharding#clusterworkflowengine).

**Reach for it when** wiring the app: `layerMemory` for tests/dev, a persistent engine for production, provided under your workflow layers.

## WorkflowProxy

`effect/unstable/workflow` — unstable

`WorkflowProxy.toRpcGroup(workflows)` produces an `RpcGroup`; `WorkflowProxy.toHttpApiGroup(name, workflows)` produces an `HttpApiGroup` of POST endpoints. For each workflow you get three operations: execute, discard (fire-and-forget), and resume-by-execution-id.

A caller can start or resume a run over the wire without importing the workflow's handler or the engine. The contract is generated from the workflow definitions.

| Operation | RPC tag (`toRpcGroup`, optional `{ prefix }`) | HTTP endpoint (`toHttpApiGroup`) | Success |
| --- | --- | --- | --- |
| Execute and await | `<Tag>` | `POST /<tag>` (the tag lower-cased) | the workflow's `success` |
| Start without waiting | `<Tag>Discard` | `POST /<tag>/discard` | the **execution id** (`Schema.String`) — keep it to `poll`, `interrupt`, or `resume` later |
| Resume a suspended run | `<Tag>Resume` | `POST /<tag>/resume` | — (payload `{ executionId }`) |

The workflow's annotations are merged onto all three generated operations, and the execute operation carries the workflow's `error` schema.

```ts
import { Schema } from "effect"
import { Workflow, WorkflowProxy } from "effect/unstable/workflow"

const ApproveMeritIncrease = Workflow.make("ApproveMeritIncrease", {
  payload: { employeeId: Schema.String, cycleId: Schema.String, newBaseSalary: Schema.String },
  idempotencyKey: ({ employeeId, cycleId }) => `${cycleId}:${employeeId}`
})

const compWorkflows = [ApproveMeritIncrease] as const

// One RpcGroup describing execute / discard / resume for every workflow.
export class CompWorkflowRpcs extends WorkflowProxy.toRpcGroup(compWorkflows) {}
```

**Reach for it when** something outside the workflow host needs to start or resume runs over RPC or HTTP with full types.

## WorkflowProxyServer

`effect/unstable/workflow` — unstable

`WorkflowProxyServer.layerRpcHandlers(workflows)` implements the RPC group produced by `toRpcGroup`; `WorkflowProxyServer.layerHttpApi(api, groupName, workflows)` implements the HTTP group from `toHttpApiGroup`. Each routes execute/discard/resume requests to the matching workflow operation, keeping the engine and handlers on the server side.

Mount under `RpcServer.layer` (or HTTP API builder) and wire calls land on real workflow executions.

```ts
import { Layer, Schema } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import { Workflow, WorkflowProxy, WorkflowProxyServer } from "effect/unstable/workflow"

const ApproveMeritIncrease = Workflow.make("ApproveMeritIncrease", {
  payload: { employeeId: Schema.String, cycleId: Schema.String, newBaseSalary: Schema.String },
  idempotencyKey: ({ employeeId, cycleId }) => `${cycleId}:${employeeId}`
})

const compWorkflows = [ApproveMeritIncrease] as const

class CompWorkflowRpcs extends WorkflowProxy.toRpcGroup(compWorkflows) {}

// Serve the generated RPCs by routing them to the workflows.
const ApiLayer = RpcServer.layer(CompWorkflowRpcs).pipe(
  Layer.provide(WorkflowProxyServer.layerRpcHandlers(compWorkflows))
)
```

**Reach for it when** you've derived a workflow RPC/HTTP surface and need to mount the handlers that actually run the executions.

## Replay, versioning, and rollout

A journal outlives the code that wrote it. Every name and schema a run has touched is a compatibility contract for as long as that run can still replay.

| Identity | Where it is stored | Changing it while runs are in flight |
| --- | --- | --- |
| Workflow tag and `idempotencyKey` output | Execution id (a hash of both) | Orphans live executions and lets the same business intent start a second run. |
| `Activity` `name` | Journal key for the recorded `Exit` | Replay finds no record and **executes the activity again**. |
| `DurableClock` / `DurableDeferred` / `DurableQueue` `name` | Journal key, and part of every deferred token | Outstanding tokens and wake-ups no longer match. |
| `payload`, `success`, `error` schemas (workflow, activity, deferred, queue) | Encoded bytes in storage | Old records fail to decode unless the new schema still accepts them. |
| Order and presence of steps in the body | Implicit: replay walks the same sequence | Reordering or removing a step changes which journal entries a replay consumes. |

Rules that keep upgrades boring:

- **Renaming an import is not a migration.** Only the string tags and names are persisted; keep them frozen and treat a new name as a new workflow.
- **Add, do not mutate.** Evolve schemas so that old encoded values still decode (new optional fields, widened unions). For an incompatible change, introduce `ApproveMeritIncreaseV2` with its own tag and let the old tag drain.
- **Inventory before rollout.** Know how many executions are running or suspended per workflow tag and how long the longest durable wait is; that is how long the old handler must stay registered.
- **Pick one rollout strategy deliberately:** drain old runs first; route by version; dual-read; migrate stored records with a verified tool; or start a new identity. "Deploy and hope" is the only wrong one.
- **Do not read mutable ambient configuration in the body.** A feature flag or limit that changes between the original run and a replay changes the path. Capture it once in an `Activity` (its recorded value is what replays see) or pass it in the payload.
- **Validate before interpreting.** Stored bytes are input: decode with the schema, check the version and tenant you expect, and park records you cannot decode for an operator instead of retrying them forever.

## Recovery testing and operations

The engine's guarantees are only as good as the backend and the deployment. Test the failure windows on the real storage, and label every claim by its evidence: *proved by the library*, *depends on the adapter*, *depends on the deployment*, or *design guidance*.

| Kill or fault the worker… | What must hold afterwards |
| --- | --- |
| before the activity's external effect | The activity runs once on replay. |
| after the external system accepted the write, before the `Exit` was recorded | The activity runs again with the **same** idempotency token; the sink deduplicates. |
| after the `Exit` was recorded, before the next step | Replay returns the recorded result; the external effect does not repeat. |
| during a `DurableClock` sleep, `DurableDeferred.await`, or queue wait | The run is `Suspended` in storage and resumes on another owner at the right time. |
| during compensation | Compensation runs again; it is idempotent. |
| while an old owner is paused past its lease (a long GC or VM pause) | The old owner's late write is rejected by the sink's idempotency/version check — the engine does not supply a fencing token. |
| with storage unavailable | New work is refused or waits; nothing is acknowledged that was not persisted. |
| with old and new code on the same store | Old runs replay on new code (or stay on old workers); fixtures of old journal bytes decode. |
| with a corrupt or undecodable record | The record is quarantined and visible to an operator; it does not become a hot retry loop. |

Run these in three separate lanes: a deterministic lane (`WorkflowEngine.layerMemory`, `TestClock`) for control flow and compensation order; an adapter lane against the production storage with real kill-and-restart; and an artifact lane that exercises the built deployable. A kill bypasses every finalizer, so restart behavior must never depend on cleanup having run.

**Operate it as a product surface.** Monitor suspended executions by age, activity attempt counts, replay failures, and dead-lettered queue items. Operator actions — inspect, `interrupt`, `resume`, redrive, release from quarantine — change business state, so authenticate, authorize, and audit them like any other write path. A backup that has never been restored is not a recovery plan; rehearse a restore and replay in-flight executions against it.

> **Tip:** A complete durable workflow app: one or more `Workflow.make` definitions, each `.toLayer(...)` with a deterministic body composed of `Activity`/`DurableClock`/`DurableDeferred`/`DurableQueue` steps; a `WorkflowEngine` layer (memory in dev, cluster in prod) provided under them; and — if external callers need access — a `WorkflowProxy` contract served by `WorkflowProxyServer`. Keep bodies deterministic, journal every side effect.
