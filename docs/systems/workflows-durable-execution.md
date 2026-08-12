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

> **Tip:** `Workflow.withCompensation(effect, (value, cause) => cleanup)` registers a saga-style rollback that runs only if the *whole* workflow fails. `Workflow.addFinalizer` provides unconditional cleanup. Compensation applies to top-level effects in the body, not steps nested inside an Activity. Two `Context.Reference`s can be set: `Workflow.CaptureDefects` and `Workflow.SuspendOnFailure`.

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

> **Tip:** `DurableDeferred.into(effect, deferred)` runs an effect and records its `Exit` into the deferred, resuming waiters — the plumbing behind queues and races. `DurableDeferred.raceAll({ name, success, error, effects })` is success-biased: it persists the first success, or the collected failure only after all effects fail. In RC 108 a completion can wake an active parked workflow immediately, and replay observes the recorded result.

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

**Reach for it when** wiring the app: `layerMemory` for tests/dev, a persistent engine for production, provided under your workflow layers.

## WorkflowProxy

`effect/unstable/workflow` — unstable

`WorkflowProxy.toRpcGroup(workflows)` produces an `RpcGroup`; `WorkflowProxy.toHttpApiGroup(name, workflows)` produces an `HttpApiGroup` of POST endpoints. For each workflow you get three operations: execute, discard (fire-and-forget), and resume-by-execution-id.

A caller can start or resume a run over the wire without importing the workflow's handler or the engine. The contract is generated from the workflow definitions.

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

> **Tip:** A complete durable workflow app: one or more `Workflow.make` definitions, each `.toLayer(...)` with a deterministic body composed of `Activity`/`DurableClock`/`DurableDeferred`/`DurableQueue` steps; a `WorkflowEngine` layer (memory in dev, cluster in prod) provided under them; and — if external callers need access — a `WorkflowProxy` contract served by `WorkflowProxyServer`. Keep bodies deterministic, journal every side effect.
