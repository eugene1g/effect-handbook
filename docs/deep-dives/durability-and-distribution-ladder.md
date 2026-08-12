# The Durability and Distribution Ladder

Audited against `effect@4.0.0-rc.108` and the matching Effect repository source on 2026-08-12.

An Effect application does not become durable by moving a fiber to another machine. It also does not become distributed merely because a value is in a database. Durability and distribution are separate axes:

- **durability** decides which facts, results, messages, and waits survive a crash;
- **distribution** decides where work runs, who owns a key, and how callers reach it.

This guide follows one business operation—applying an approved compensation change—up the ladder. Each rung adds a specific guarantee and a specific operational cost. Stop at the lowest rung that meets the failure model.

All workflow, persistence, event-log, and cluster APIs in this guide are unstable in RC 108. Pin the version and re-audit before upgrading.

## Begin with the failure boundary

Suppose `applyApprovedRaise` must validate an approval, update payroll, and publish a notification. Before choosing an API, write down what must remain true after each failure:

| Failure | Question that chooses the primitive |
| --- | --- |
| The current request is interrupted | May the caller retry the whole operation? |
| The process restarts | Must queued work, cached results, or a wait survive? |
| A worker crashes after payroll accepted the write | Can the write safely be delivered again? |
| A deployment changes the workflow code | Can an older execution still replay deterministically? |
| A cluster node disappears | Which node should own `employee-42` next? |
| A projection is lost | Can authoritative history rebuild it? |

“Exactly once” is usually not an end-to-end guarantee. Effect can durably record messages or completed activity results, but an external API and the Effect store do not share a transaction. A crash can occur after the external commit and before the acknowledgement is stored. Design external writes for **at-least-once delivery** with a stable idempotency key, a uniqueness constraint, or a transactional outbox.

## Rung zero: ordinary Effects and scoped resources

Start with normal services, `Effect`, `Layer`, `Ref`, `Queue`, fibers, schedules, and scopes. They provide typed composition, concurrency, cancellation, and resource safety inside one running process. They do not survive process loss.

**Runnable.** This is the correct baseline when an HTTP caller can retry and the destination deduplicates the command.

```ts
import { Context, Effect, Schema } from "effect"

class PayrollError extends Schema.TaggedError<PayrollError>()("PayrollError", {
  message: Schema.String
}) {}

class Payroll extends Context.Service<Payroll, {
  readonly applyRaise: (input: {
    readonly employeeId: string
    readonly newSalary: string
    readonly idempotencyKey: string
  }) => Effect.Effect<void, PayrollError>
}>()("app/Payroll") {}

const applyApprovedRaise = (input: {
  readonly approvalId: string
  readonly employeeId: string
  readonly newSalary: string
}) =>
  Effect.gen(function*() {
    const payroll = yield* Payroll
    yield* payroll.applyRaise({
      employeeId: input.employeeId,
      newSalary: input.newSalary,
      idempotencyKey: `approval:${input.approvalId}`
    })
  })
```

If the process dies, an in-memory `Queue`, `Ref`, cache, scheduled fiber, or retry state disappears. Do not describe those as durable because they are wrapped in a `Layer`.

## Rung one: persist data or completed results

Use the persistence family when the unit that must survive is a value or a completed typed result:

- `KeyValueStore` stores raw strings or bytes behind interchangeable backends.
- `Persistence` stores schema-encoded `Exit` values in named stores.
- `PersistedCache` adds an in-memory cache in front of persisted results.
- `RequestResolver.persisted` adds cross-restart result reuse to persistable requests.

This rung avoids recomputation. It does not orchestrate a multi-step process and it does not create a worker queue. Memory layers are test implementations, not durability tests; use a filesystem, SQL, Redis, or browser-backed layer appropriate to the module.

Choose cache keys as durable domain identities, and include every input that changes the answer. Version a key or namespace when the encoded schema or computation semantics change.

## Rung two: persist independent jobs

Use `PersistedQueue` when the durable unit is an independent FIFO job. Producers can supply an id to suppress duplicate enqueueing. Consumers `take` work, acknowledge it on success, and retry failures up to the configured attempt limit.

**Contextual.** This snippet is complete at the Effect boundary; production wiring must provide a durable queue store and the application-specific payroll layer.

```ts
import { Context, Effect, Layer, Schema } from "effect"
import { PersistedQueue } from "effect/unstable/persistence"

const RaiseJob = Schema.Struct({
  approvalId: Schema.String,
  employeeId: Schema.String,
  newSalary: Schema.String
})
type RaiseJob = Schema.Schema.Type<typeof RaiseJob>

class Payroll extends Context.Service<Payroll, {
  readonly apply: (
    job: RaiseJob,
    idempotencyKey: string
  ) => Effect.Effect<void, Error>
}>()("app/Payroll") {}

export const enqueueAndConsume = Effect.gen(function*() {
  const payroll = yield* Payroll
  const queue = yield* PersistedQueue.make({
    name: "approved-raises",
    schema: RaiseJob
  })

  yield* queue.offer(
    {
      approvalId: "approval-917",
      employeeId: "employee-42",
      newSalary: "132000.00"
    },
    { id: "raise:approval-917" }
  )

  yield* queue.take(
    (job, item) =>
      payroll.apply(job, `raise:${job.approvalId}`).pipe(
        Effect.annotateLogs({ queueItemId: item.id, attempt: item.attempts })
      ),
    { maxAttempts: 8 }
  )
})

export const MemoryQueueLayer = PersistedQueue.layer.pipe(
  Layer.provide(PersistedQueue.layerStoreMemory)
)
```

The custom offer id makes producer retries idempotent while the item remains represented in the queue. It does not make the external payroll operation atomic. Pass a stable domain key to payroll as well.

Use this rung for email delivery, document rendering, imports, and other retryable jobs whose lifecycle is essentially “pending, processing, done, or exhausted and awaiting operator recovery.” When the process must pause, branch, compensate, and remember multiple completed steps, move up one rung.

## Rung three: orchestrate a durable business process

`Workflow` describes deterministic orchestration. `Activity` contains every side effect and source of nondeterminism. The workflow engine journals completed activity `Exit` values; replay returns a recorded result instead of deliberately executing that activity again.

The activity can still run more than once if the worker is interrupted after the external side effect commits but before its `Exit` is durably recorded. Its `name` is a stable journal key, and `Activity.idempotencyKey(name)` produces a stable token for the external system.

**Contextual.** The contract and implementation compile as one module; `writePayroll` is the application adapter that the deployment supplies.

```ts
import { Effect, Schema } from "effect"
import { Activity, DurableClock, Workflow } from "effect/unstable/workflow"

class PayrollUnavailable extends Schema.TaggedError<PayrollUnavailable>()(
  "PayrollUnavailable",
  { message: Schema.String }
) {}

export const ApplyApprovedRaise = Workflow.make("ApplyApprovedRaise", {
  payload: {
    approvalId: Schema.String,
    employeeId: Schema.String,
    newSalary: Schema.String
  },
  success: Schema.String,
  error: PayrollUnavailable,
  idempotencyKey: ({ approvalId }) => approvalId
})

export const ApplyApprovedRaiseLayer = ApplyApprovedRaise.toLayer(
  Effect.fn("ApplyApprovedRaise")(function*(payload) {
    yield* Activity.make({
      name: "WritePayroll",
      error: PayrollUnavailable,
      execute: Effect.gen(function*() {
        const key = yield* Activity.idempotencyKey("WritePayroll")
        yield* writePayroll(payload.employeeId, payload.newSalary, key)
      })
    })

    yield* DurableClock.sleep({
      name: "PayrollPropagationWindow",
      duration: "10 minutes"
    })

    return `raise ${payload.approvalId} applied`
  })
)

declare const writePayroll: (
  employeeId: string,
  newSalary: string,
  idempotencyKey: string
) => Effect.Effect<void, PayrollUnavailable>
```

The workflow body will run again during replay. Never read the ordinary clock, generate random values, call an external service, or mutate process state directly in it. Put that work in a named `Activity` or use a durable primitive:

- `DurableClock` for a sleep that survives restarts;
- `DurableDeferred` for an out-of-band approval or webhook;
- `DurableQueue` to hand a step to separately deployed workers;
- compensation or finalizers when the process needs explicit cleanup semantics.

The in-memory workflow engine proves contracts and control flow only. A production engine needs durable storage, and workflow changes need compatibility discipline: retain stable workflow, activity, sleep, and deferred names for in-flight executions.

## Rung four: make immutable events authoritative

Use `effect/unstable/eventlog` when the durable unit is a domain fact and current state must be reproducible from history. An event log is not merely a queue with long retention. Events are immutable business facts, handlers update projections, and replay or replication can rebuild those projections.

Effect's `EventLog` is handler-first: it runs the matching handler and only commits the journal entry if the handler succeeds. With `SqlEventJournal`, SQL-backed handler work using the supplied `SqlClient` can share the journal transaction. IndexedDB cannot make arbitrary handler work and its later journal write one transaction, so backend choice changes the atomicity boundary.

**Illustrative.** This is the portable event contract; see the event-log chapter for handler, journal, identity, and sync layers.

<!-- effect-example id=eventlog.compensation-event-contract check=pseudocode -->
```ts
import { Schema } from "effect"
import { EventGroup, EventLog } from "effect/unstable/eventlog"

export const CompensationEvents = EventGroup.empty.add({
  tag: "RaiseApplied",
  payload: Schema.Struct({
    approvalId: Schema.String,
    employeeId: Schema.String,
    newSalary: Schema.String
  }),
  primaryKey: ({ employeeId }) => employeeId
})

export const CompensationEventSchema = EventLog.schema(CompensationEvents)
```

Choose the event log when audit, offline replication, rebuildable projections, or event-sourced domain decisions are product requirements. Do not add it only to obtain background retries; `PersistedQueue` is smaller for that job. Keep event tags, primary keys, and payload schemas compatible with stored history.

## Rung five: distribute ownership by key

Cluster entities are addressable actors whose ids are mapped to shards and owned by runners. They solve placement, routing, per-key serialization, passivation, and failover. By default, entity RPC messages are volatile. Annotate an RPC with `ClusterSchema.Persisted` when that message requires durable at-least-once delivery.

**Illustrative.** The entity contract shows the durability choice at the individual RPC boundary.

<!-- effect-example id=cluster.employee-entity-contract check=pseudocode -->
```ts
import { Schema } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"

const ApplyRaise = Rpc.make("ApplyRaise", {
  payload: {
    approvalId: Schema.String,
    newSalary: Schema.String
  },
  success: Schema.Void
}).annotate(ClusterSchema.Persisted, true)

const ReadCurrentSalary = Rpc.make("ReadCurrentSalary", {
  success: Schema.String
})

export const Employee = Entity.make("Employee", [
  ApplyRaise,
  ReadCurrentSalary
])
```

Entity handlers run sequentially per live instance unless a handler opts into concurrent execution. In-memory state held by an entity disappears when it is passivated or moved. Persist authoritative state elsewhere, reconstruct it on activation, or derive it from an event log. Persisted messages make delivery durable; they do not automatically make a handler's arbitrary external effects exactly once. For a volatile RPC sent with `discard: true`, success acknowledges delivery to the owning runner rather than an entity reply; delivery failures still propagate and may be retried. A persisted discard is recoverable from storage and is not coupled to the immediate notification transport result.

Use entities when many keys need single-owner logic spread across machines. Use a singleton for one cluster-wide process. Distribution may sit below a workflow engine, host workers for a persisted queue, or expose an event-sourced aggregate, but those are compositions—not substitutes for one another.

## Compose rungs by assigning one owner to each truth

A production raise application might use only a workflow and an idempotent payroll adapter. A larger system might use this composition:

1. An HTTP command starts `ApplyApprovedRaise` with `approvalId` as its workflow idempotency key.
2. A named activity writes payroll with an activity-derived idempotency token.
3. After payroll confirms, another activity appends `RaiseApplied` to the authoritative event log.
4. Projections serve reads; cluster entities are introduced only if per-employee distributed ownership is required.

Do not let a queue row, workflow journal, event, and entity `Ref` all claim to be the authoritative status. Name one source of truth and treat the others as delivery state, orchestration state, projections, or caches. Record a durable handoff before acknowledging its predecessor, or use a transaction/outbox when both records share a database.

### A compact selection guide

| Need | Smallest fitting primitive |
| --- | --- |
| Retry during one process lifetime | `Effect.retry` and `Schedule` |
| Cache a typed result across restarts | `PersistedCache` or persisted resolver |
| Deliver an independent job after restart | `PersistedQueue` |
| Resume a multi-step process and durable waits | `Workflow`, `Activity`, durable primitives |
| Preserve immutable domain history and rebuild projections | `EventLog` |
| Route typed commands to one owner per key across nodes | Cluster `Entity` |
| Make selected entity messages survive failover | `ClusterSchema.Persisted` plus durable `MessageStorage` |

## Capstone validation plan

Validate the chosen guarantee, not only the happy-path return value:

1. Unit-test the domain services and idempotency-key derivation with ordinary test layers.
2. Redeliver the same queue item, activity, or persisted RPC and prove the external state changes once.
3. Kill the worker after the external commit but before acknowledgement; restart it and verify recovery.
4. For workflows, suspend and resume with the production storage backend and test replay of an older execution against the new deployment.
5. For event sourcing, rebuild a fresh projection from journal history and compare it with the live projection.
6. For cluster entities, passivate an instance and fail over a runner; prove state reconstruction and persisted-message behavior.
7. Test poison messages and permanent failures so retries terminate, surface diagnostics, and reach an operator-controlled recovery path.

## Operational checklist

- Pin the exact Effect release while using unstable modules.
- Give stores, queues, workflows, activities, deferreds, events, entities, and RPCs stable names.
- Use domain idempotency keys at every external-write boundary.
- Decide retention, compaction, schema migration, encryption, backup, and restore policy for every durable store.
- Monitor queue age, attempts, exhausted items, suspended workflows, replay failures, shard ownership, and storage latency.
- Bound retries and distinguish transient failures from permanent typed failures.
- Verify the real production backend; memory layers cannot demonstrate crash durability.
- Document which record is authoritative and which records are delivery or projection state.
- Rehearse deployment compatibility while durable work is still in flight.

Continue with [Workflows & Durable Execution](../systems/workflows-durable-execution.md), [Persistence](../tooling/persistence.md), [EventLog & Event Sourcing](../systems/event-log-event-sourcing.md), [Cluster & Sharding](../systems/cluster-sharding.md), and [Testing an Effect Application](./testing-an-effect-application.md).
