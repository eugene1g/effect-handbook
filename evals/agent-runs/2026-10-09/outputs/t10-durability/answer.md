# Payroll Approval: Effect Primitive Recommendation

## Chosen primitives

### Rung 3: Workflow + Activity (required)

The entire three-step approval sequence belongs in a single `Workflow`. The process spans days and the service redeploys multiple times per day; the Workflow engine journals completed activity `Exit` values so deterministic orchestration can replay across crashes and ownership moves. Each step — awaiting manager approval, awaiting finance approval, and calling the payment provider — becomes a named `Activity` or a `DurableDeferred`. The payment call specifically uses `Activity.idempotencyKey("CallPaymentProvider")` to derive a stable token to pass to the provider.

Waiting on human approvals (which may take days) uses `DurableDeferred`, a durable primitive that survives restarts. A process-local fiber sleep or `Effect.retry` would vanish on redeploy; `DurableDeferred` keeps the wait in the journal until an external signal resolves it.

### Rung 4: EventLog (required)

Auditors need a replayable history of every decision. `EventLog` stores immutable business facts (`ManagerApproved`, `FinanceApproved`, `PaymentDispatched`) and projections can be rebuilt from the ordered journal at any time. The handbook says: "Choose the event log when audit, offline replication, rebuildable projections, or event-sourced domain decisions are product requirements." After each activity completes, a second activity appends the corresponding event to the log. The SQL-backed journal makes the event append and any local projection update share one transaction.

## Rungs not needed

**Rung 1: Persistence / PersistedCache** — The Workflow engine already journals completed step results. A standalone persisted cache would duplicate that responsibility and is designed for caching single typed results, not for orchestrating a multi-step process.

**Rung 2: PersistedQueue** — A queue delivers independent, flat jobs. The payroll approval is not a flat job: it branches on approval outcomes, waits on human actors, and must compensate if a step fails. The handbook says: "When the process must pause, branch, compensate, and remember multiple completed steps, move up one rung."

**Rung 5: Cluster Entity** — Entities solve distributed ownership when many distinct keys need single-owner logic spread across machines. This process is one workflow per approval request with no competing owners. Adding cluster entities would introduce sharding and rebalancing complexity with no benefit for this shape of work.

## Guarantee on the payment call and what the provider must do

The payment activity gets **at-least-once execution** with a stable idempotency key. If the worker crashes after the payment provider accepts the request but before the activity `Exit` is journaled, the next owner replays the workflow and the activity executes again. Once the `Exit` is durably recorded, replay returns the stored result and the provider is not called again.

The payment provider must accept the idempotency key passed via `Activity.idempotencyKey("CallPaymentProvider")` and treat any subsequent call with that same key as a duplicate, returning the original result without processing the payment a second time. A uniqueness constraint on the key is the minimum; a status-query API covers the "unknown after dispatch" case (timeout or dropped connection before a response arrives).
