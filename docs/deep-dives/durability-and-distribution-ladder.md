# The Durability and Distribution Ladder

Audited against `effect@4.0.0` and the matching Effect repository source on 2026-09-19.

An Effect application does not become durable by moving a fiber to another machine. It also does not become distributed merely because a value is in a database. Durability and distribution are separate axes:

- **durability** decides which facts, results, messages, and waits survive a crash;
- **distribution** decides where work runs, who owns a key, and how callers reach it.

This guide follows one business operation—applying an approved compensation change—up the ladder. Each rung adds a specific guarantee and a specific operational cost. Stop at the lowest rung that meets the failure model.

All workflow, persistence, event-log, and cluster APIs in this guide are tagged `@stability unstable`. Pin the version and re-audit before upgrading — event-log payloads and cluster runner traffic are `SchemaBinary`-encoded on the wire and in storage, so a future change to that encoding makes an upgrade a deployment event rather than a dependency bump.

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

### Start from an invariant and mark the crash windows

State the property first — "every accepted raise reaches *applied* or *dead-lettered*", "no stale owner commits after a handoff" — and then walk the path every unit of work takes:

```text
input -> durable state -> claim -> external effect -> result persisted -> acknowledged
       ^              ^        ^                  ^                   ^
       a crash in any of these gaps must leave the invariant intact
```

If domain state and delivery state live in **different stores**, assume there is no atomic commit between them unless a verified protocol closes the gap: an outbox/inbox, a uniqueness constraint, a compare-and-set, or a fencing token checked by the sink.

### Classify every outcome of an external write

An attempt at an external write ends in one of three ways, and only two of them are safe to act on automatically.

| Outcome | How you know | What to do |
| --- | --- | --- |
| Failed **before** dispatch | The request was never sent (validation, authorization, connection refused). | Retry under a bounded schedule, or fail the job. |
| Failed with a **known** answer after dispatch | The sink replied with a definite rejection. | Record it; retry only if the rejection is transient. |
| **Unknown** after dispatch | Timeout, interruption, a dropped connection, or a process death after the request left. | Never replay blindly. Re-send only with the same idempotency key, or query the sink's status API; otherwise park it for an operator. |

Two more rules fall out of the table. **Acknowledge only after the effect and its result are both persisted**, which is what makes delivery at-least-once rather than at-most-once. **Count attempts durably and persist exhaustion** (a dead-letter state), and keep defects and interruption out of ordinary business retry: a defect is a bug to surface, and an interrupt is cancellation, not a failure to try again.

### Label each guarantee by its evidence

When you write down what the system promises, tag every line: **library-proved** (the engine journals a completed `Exit`), **adapter-dependent** (the SQL backend commits the activity result with your row in one transaction), **deployment-dependent** (only one replica consumes this queue), **unsupported** (the library does not fence stale owners), or **design guidance** (we pass an idempotency key). Only the first kind survives a change of backend or topology unexamined.

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

Rung zero still has a rollback tool: a release function receives the closing `Exit`, so a sequence of `Effect.acquireRelease` steps inside one `Effect.scoped` can undo partial work in reverse order when — and only when — the scope closes with a failure. That is an in-process compensating transaction; see [Failure, Retry, Fallback, and Interruption](failure-retry-fallback-and-interruption). It does not survive process death, because a kill runs no finalizers. The durable counterpart is `Workflow.withCompensation` on rung three.

## Rung one: persist data or completed results

Use the persistence family when the unit that must survive is a value or a completed typed result:

- `KeyValueStore` stores raw strings or bytes behind interchangeable backends.
- `Persistence` stores schema-encoded `Exit` values in named stores.
- `PersistedCache` adds an in-memory cache in front of persisted results.
- `RequestResolver.persisted` adds cross-restart result reuse to persistable requests.

This rung avoids recomputation. It does not orchestrate a multi-step process and it does not create a worker queue. Memory layers are test implementations, not durability tests; use a filesystem, SQL, Redis, or browser-backed layer appropriate to the module.

Choose cache keys as durable domain identities, and include every input that changes the answer. Version a key or namespace when the encoded schema or computation semantics change.

Know what this rung is *not*. A persisted cache stores `Exit` values, so it **can replay a cached failure** until its TTL expires; it is not a fleet-wide single-flight (two nodes may compute the same miss concurrently) and it is not a transactional source of truth. A memory-backed `RateLimiter` store limits one process only; the Redis store adds atomic scripts across nodes, not availability, fairness, or persistence guarantees. The [Persistence](../tooling/persistence) page covers each store's layers and time-to-live rules.

## Rung two: persist independent jobs

Use `PersistedQueue` when the durable unit is an independent FIFO job. Producers can supply an id to suppress duplicate enqueueing. Consumers `take` work, acknowledge it on success, and retry failures up to the configured attempt limit.

**Contextual.** This snippet is complete at the Effect boundary; production wiring must provide a durable queue store and the application-specific payroll layer.

```ts
import { Context, Effect, Layer, Schema } from "effect"
import { PersistedQueue } from "effect/persistence"

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
  // The retry policy belongs to the queue definition, not to take().
  const queue = yield* PersistedQueue.make({
    name: "approved-raises",
    schema: RaiseJob,
    maxAttempts: 8
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
      )
  )
})

export const MemoryQueueLayer = PersistedQueue.layer.pipe(
  Layer.provide(PersistedQueue.layerStoreMemory)
)
```

The custom offer id makes producer retries idempotent: de-duplication survives completion until `PersistedQueue.layerCleanup` removes the finished element (30 days by default). An element that exhausts `maxAttempts` — or no longer decodes with the queue schema — is dead-lettered and kept until you drain it or set `failedTimeToLive`. None of this makes the external payroll operation atomic. Pass a stable domain key to payroll as well.

Use this rung for email delivery, document rendering, imports, and other retryable jobs whose lifecycle is essentially “pending, processing, done, or exhausted and awaiting operator recovery.” When the process must pause, branch, compensate, and remember multiple completed steps, move up one rung.

### A lease is not a fence

Every durable consumer on this ladder — a queue taker, a workflow owner, a shard-holding runner — holds a **lease**: a claim that expires. A lease alone cannot stop a paused former owner (a long GC pause, a frozen VM, a partitioned node) from waking up and committing *after* a new owner took over. Effect's persistence, workflow, and cluster modules do not hand you a fencing token for your external sink, so the application protocol has to supply the protection:

- give every protected write a **monotonic token or version** that the sink checks (compare-and-set, `WHERE version = $expected`, a uniqueness constraint on the idempotency key), and create, persist, propagate, and test that token yourself;
- or make duplicate ownership harmless, so that both owners converging on the same idempotent write is acceptable;
- size lease durations for the pauses you actually observe, not for the happy path.

**Process death skips finalizers.** `Effect.acquireRelease`, `Layer` teardown, and `Workflow.addFinalizer` run on graceful exit only. Restart behavior must therefore never depend on cleanup having run, and graceful shutdown should acknowledge only work whose outcome is already committed.

## Rung three: orchestrate a durable business process

`Workflow` describes deterministic orchestration. `Activity` contains every side effect and source of nondeterminism. The workflow engine journals completed activity `Exit` values; replay returns a recorded result instead of deliberately executing that activity again.

The activity can still run more than once if the worker is interrupted after the external side effect commits but before its `Exit` is durably recorded. Its `name` is a stable journal key, and `Activity.idempotencyKey(name)` produces a stable token for the external system.

**Contextual.** The contract and implementation compile as one module; `writePayroll` is the application adapter that the deployment supplies.

```ts
import { Effect, Schema } from "effect"
import { Activity, DurableClock, Workflow } from "effect/workflow"

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

Three behaviors of the cluster-backed engine shape how you write the body:

- **An owner can abandon an attempt.** If the runner that owns an execution shuts down or loses the shard, the interrupt it delivers is treated as an *abandoned run attempt*: nothing is persisted, compensations and `Workflow.addFinalizer` callbacks do **not** run, a parent workflow is not resumed, and the next owner replays the journal. An in-flight activity may therefore execute again — the same exposure as a crash, handled by the same idempotency token.
- **Durable finalizers and owner-local finalizers are different things.** `Workflow.addFinalizer` and `withCompensation` fire when the *execution* reaches a terminal state, possibly on another machine; scope finalizers registered under `Workflow.provideScope` fire when *this owner's* scope closes, including on abandonment. Release sockets, locks, and temp files through the second kind only.
- **Compensation is a saga action, not an undo.** It runs after a prior success, it can fail, be interrupted, or run more than once, and a body that replays registers it again. Give it its own idempotency key and record its outcome.

Workflow entities also passivate after a fixed ten seconds of idleness under `ClusterWorkflowEngine`, so a suspended execution holds no runner slot and no process-local state; everything it needs on resume must come from the journal. The [workflow chapter](../systems/workflows-durable-execution#finalizers-compensation-and-cancellation) has the full table, including the five cancellation events to test.

## Rung four: make immutable events authoritative

Use `effect/eventlog` when the durable unit is a domain fact and current state must be reproducible from history. An event log is not merely a queue with long retention. Events are immutable business facts, handlers update projections, and replay or replication can rebuild those projections.

Effect's `EventLog` is handler-first: it runs the matching handler and only commits the journal entry if the handler succeeds. With `SqlEventJournal`, SQL-backed handler work using the supplied `SqlClient` can share the journal transaction. IndexedDB cannot make arbitrary handler work and its later journal write one transaction, so backend choice changes the atomicity boundary.

**Illustrative.** This is the portable event contract; see the event-log chapter for handler, journal, identity, and sync layers.

<!-- effect-example id=eventlog.compensation-event-contract check=pseudocode -->
```ts
import { Schema } from "effect"
import { EventGroup, EventLog } from "effect/eventlog"

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

Journal entries and remote sync messages are `SchemaBinary`-encoded, and no compatibility reader ships for a different wire format. "Authoritative history" is only as durable as your ability to decode it: the event payload Schema is the persisted contract from the moment you write it, so changing its wire representation later needs a one-off re-encode (or a new store id with the old journal kept read-only), with clients and servers moved together.

Replication is at-least-once. The sync loop retries a failed remote write indefinitely on a capped backoff, re-authenticates and retries when the server answers `Forbidden`, and skips the remote call entirely when nothing is uncommitted; the receiving side de-duplicates by entry id. Design projections so that seeing an entry twice is harmless.

## Rung five: distribute ownership by key

Cluster entities are addressable actors whose ids are mapped to shards and owned by runners. They solve placement, routing, per-key serialization, passivation, and failover. By default, entity RPC messages are volatile. Annotate an RPC with `ClusterSchema.Persisted` when that message requires durable at-least-once delivery.

**Illustrative.** The entity contract shows the durability choice at the individual RPC boundary.

<!-- effect-example id=cluster.employee-entity-contract check=pseudocode -->
```ts
import { Schema } from "effect"
import { ClusterSchema, Entity } from "effect/cluster"
import { Rpc } from "effect/rpc"

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

Persisted delivery also changes what a caller sees during a rebalance. If the entity moves or is shut down before replying, the caller simply keeps waiting and receives the reply from message storage once the next owner has processed the request; if the caller's **own** runner is shutting down, the call is *interrupted* rather than failed with `EntityNotAssignedToRunner`, because the request is already durable. Do not translate that interrupt into a domain error or a retry. A volatile send has no storage behind it and still fails fast — including with `MailboxFull` when the target runner is at its `maxResidentEntities` cap (10,000 by default), a limit that delays persisted work instead of rejecting it. An interruptible volatile request is also tied to its caller's connection: if the calling runner disconnects, the remote handler is interrupted and its mailbox slot freed, so a lost volatile call may have stopped partway. Work that must finish regardless of the caller belongs in a persisted request.

**Runner wire format is a cluster-wide contract.** Runner-to-runner traffic is serialized with `SchemaBinary` by default (`serialization: "binary"` on `NodeClusterSocket.layer` / `NodeClusterHttp.layer` and the Bun and Deno equivalents); `serialization: "ndjson"` is the text-based alternative both generations of a rolling upgrade can share. A cluster cannot mix runners on different serialization settings, so a rollout that changes the default must pin every node to the same `serialization` option throughout the rollout and rehearse a mixed-version pair in staging first. See [Cluster & Sharding](../systems/cluster-sharding#transport-options).

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

## Treat persisted bytes as input, and their names as a contract

Everything above rung zero writes bytes that a *later* version of your program will read. Two rules follow.

**Stored records are untrusted input.** Persist an explicit envelope — protocol version, tenant, a stable operation id, a state tag, attempt metadata, a bounded payload, timestamps from a declared clock, and the fencing token if the sink needs one — and validate version, identity, and size *before* any business interpretation. A record you cannot decode is not a retryable failure: quarantine it durably where an operator can see it. `PersistedQueue` does this for you (an undecodable element is dead-lettered instead of being retried); for your own tables, do the equivalent.

**Names are identities.** A store id, queue name, workflow tag, activity name, deferred name, event tag, entity type, RPC tag, and the output of every `idempotencyKey` / `primaryKey` function are all keys into live data. Renaming one orphans that data; renaming the TypeScript import does not migrate it. Build composite keys with a canonical, versioned encoder rather than by concatenating user- or model-supplied strings, where `"a:b" + "c"` and `"a" + "b:c"` collide.

| Rollout strategy | Use it when |
| --- | --- |
| Drain, then deploy | In-flight work is short and you can pause intake. |
| Read-old / write-new | The new schema can still decode old records; keep old readers and handlers until the backlog is gone. |
| Route by version | Old and new code must coexist for long-lived executions; the version is part of the identity. |
| Verified migration | Records must be rewritten; test the migrator on production-shaped fixtures and keep a rollback copy. |
| New identity | Semantics changed; start `…V2` and let the old name finish. |

Before any of them, **inventory what is in flight** — suspended workflows and their longest wait, queue depth and dead letters, unacknowledged persisted messages — and test old fixtures against new code, plus old and new workers against one store. Do not read mutable ambient configuration during a replay; capture it once in a journaled step.

## Capstone validation plan

Validate the chosen guarantee, not only the happy-path return value:

1. Unit-test the domain services and idempotency-key derivation with ordinary test layers.
2. Redeliver the same queue item, activity, or persisted RPC and prove the external state changes once.
3. Kill the worker after the external commit but before acknowledgement; restart it and verify recovery.
4. For workflows, suspend and resume with the production storage backend and test replay of an older execution against the new deployment.
5. For event sourcing, rebuild a fresh projection from journal history and compare it with the live projection.
6. For cluster entities, passivate an instance and fail over a runner; prove state reconstruction and persisted-message behavior.
7. Test poison messages and permanent failures so retries terminate, surface diagnostics, and reach an operator-controlled recovery path.
8. Pause an owner past its lease (freeze the process, let another take over, then thaw it) and prove the stale owner's write is rejected by the sink.
9. Run old and new code against one store, and replay fixtures of old stored bytes on the new build; include a corrupt record and check it is quarantined, not retried.
10. Take storage away mid-operation and verify nothing is acknowledged that was not persisted; then restore from a backup and resume in-flight work.
11. For a cluster upgrade, rehearse the serialization pin with one old and one new runner before touching production.

Keep three lanes separate, because each proves something different: a **deterministic** lane (memory layers, `TestClock`) proves the state machine and compensation order; an **adapter** lane on the production backend with real kill-and-restart proves durability and redelivery; an **artifact** lane runs the built deployable with its real configuration and shutdown signals. A green deterministic lane says nothing about crash durability.

## Operational checklist

- Pin the exact Effect release while using unstable modules.
- Give stores, queues, workflows, activities, deferreds, events, entities, and RPCs stable names.
- Use domain idempotency keys at every external-write boundary.
- Decide retention, compaction, schema migration, encryption, backup, and restore policy for every durable store.
- Monitor queue age, attempts, exhausted items, suspended workflows, replay failures, shard ownership, and storage latency.
- Bound retries and distinguish transient failures from permanent typed failures.
- Verify the real production backend; memory layers cannot demonstrate crash durability.
- Document which record is authoritative and which records are delivery or projection state.
- Rehearse deployment compatibility while durable work is still in flight, including stored-format changes (event-log payloads) and wire-format changes (cluster `serialization`).
- Classify every external write outcome as before-dispatch, known, or unknown; never auto-replay an unknown.
- Protect sinks against stale owners with a version or fencing check; a lease alone is not enough.
- Never rely on finalizers for restart correctness; a kill skips them.
- Alert on cluster residency approaching `maxResidentEntities` and on persisted-message backlog age.
- Authenticate, authorize, and audit operator actions (inspect, interrupt, resume, redrive, quarantine release), and run restore drills rather than trusting that backups exist.

Continue with [Workflows & Durable Execution](../systems/workflows-durable-execution.md), [Persistence](../tooling/persistence.md), [EventLog & Event Sourcing](../systems/event-log-event-sourcing.md), [Cluster & Sharding](../systems/cluster-sharding.md), and [Testing an Effect Application](./testing-an-effect-application.md).
