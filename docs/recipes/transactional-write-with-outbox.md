# Recipe: A Transactional Write with an Outbox

Commit a domain change and the event that announces it in one SQL transaction, then deliver the event after commit with honest at-least-once semantics.

## Contract

- **Classification:** Runnable example; complete `raise-outbox.ts`. It runs on an embedded PGlite database and a scripted in-memory broker, so no network, port, or Docker is required.
- **Install:** `pnpm add effect@4.0.0 @effect/sql-pglite@4.0.0`
- **Run:** Node 26+: `node raise-outbox.ts`
- **Expected output:** six JSON lines, reproduced byte for byte under [Expected output](#expected-output).
- **Before provision:** `program` is `Effect<Array<unknown>, EmployeeNotFound | MeritBudgetExceeded | RepositoryError, Raises | Outbox | Payroll | Publisher>`; one relay pass is `Effect<{ delivered: number; failed: number }, RepositoryError, Outbox | Publisher>`. No `SqlError`, `SchemaError`, or driver type appears in either signature.
- **After provision:** `Effect<Array<unknown>, EmployeeNotFound | MeritBudgetExceeded | RepositoryError | SqlError, never>`. The only `SqlError` left is the one that building the database Layer (opening PGlite, running the migrations) can raise.
- **Required Layers:** PGlite supplies the generic `SqlClient`; `Outbox.layer` and `Raises.layer` are both built from that **one** client, which is what lets the outbox insert join the transaction that `Raises.approve` opens. `Publisher` and `Payroll` are the demo's broker and idempotent consumer.
- **Lifetime and interruption:** the embedded database is scoped by its Layer. `SqlClient.withTransaction` commits only when its body succeeds and rolls back on typed failure, defect, or interruption. The relay runs outside any transaction; interrupting it between the publish and the acknowledgement leaves the row pending, so the next pass redelivers the same outbox id.

### Expected output

```text
{"step":"approve ada","salary":130000,"outbox":[{"id":"raise-approved:2026:1","delivered":false,"attempts":0}],"received":0}
{"step":"approve grace","outcome":"MeritBudgetExceeded overBy=5000","salary":150000,"outboxRows":1}
{"step":"relay 1","delivered":0,"failed":1,"outbox":[{"id":"raise-approved:2026:1","delivered":false,"attempts":1}]}
{"step":"relay 2","delivered":1,"failed":0,"outbox":[{"id":"raise-approved:2026:1","delivered":true,"attempts":2}]}
{"step":"relay 3","delivered":0,"failed":0}
{"step":"payroll","received":2,"duplicates":1,"applied":["raise-approved:2026:1"]}
```

| Line | What it proves |
| --- | --- |
| `approve ada` | The salary change and its `RaiseApproved` outbox row committed together, and nothing has been delivered yet (`received: 0`). |
| `approve grace` | The merit-budget rule failed *after* both writes, inside the transaction: the salary is unchanged and no second outbox row exists. |
| `relay 1` | Payroll accepted the event but the acknowledgement was lost, so the row is still pending with `attempts: 1`. |
| `relay 2` | The same outbox id was redelivered; only now is the row marked delivered. |
| `relay 3` | Nothing is pending, so nothing is sent. |
| `payroll` | Two deliveries, one application: the consumer deduplicated on the outbox id. |

## Complete file

**Runnable example.**

<!-- effect-example id=transactional-outbox check=run runtime=transactional-outbox -->
```ts
import { PgliteClient } from "@effect/sql-pglite"
import { Context, Data, Effect, Layer, Option, Ref, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { SqlError } from "effect/sql"

// --- Domain -----------------------------------------------------------------

class RaiseApproved extends Schema.Class<RaiseApproved>("RaiseApproved")({
  employeeId: Schema.Int,
  cycle: Schema.String,
  newSalary: Schema.Int
}) {}

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {
  employeeId: Schema.Int
}) {}

class MeritBudgetExceeded extends Schema.TaggedError<MeritBudgetExceeded>()("MeritBudgetExceeded", {
  cycle: Schema.String,
  overBy: Schema.Int
}) {}

class DeliveryFailed extends Schema.TaggedError<DeliveryFailed>()("DeliveryFailed", {
  messageId: Schema.String,
  reason: Schema.String
}) {}

// The one storage error both repositories expose. The cause stays typed, so a
// caller can still inspect `cause.reason` for a domain decision.
class RepositoryError extends Data.TaggedError("RepositoryError")<{
  readonly operation: string
  readonly cause: SqlError.SqlError | Schema.SchemaError
}> {}

// Maps only the typed channel. Defects and interruption pass through untouched.
const owned = (operation: string) =>
<A, R>(self: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError, R>) =>
  Effect.mapError(self, (cause) => new RepositoryError({ operation, cause }))

// --- Outbox repository --------------------------------------------------------

class OutboxMessage extends Schema.Class<OutboxMessage>("OutboxMessage")({
  id: Schema.String,
  topic: Schema.String,
  payload: Schema.fromJsonString(RaiseApproved),
  attempts: Schema.Int,
  delivered: Schema.Boolean
}) {}

class Outbox extends Context.Service<Outbox, {
  readonly enqueue: (id: string, topic: string, event: RaiseApproved) => Effect.Effect<void, RepositoryError>
  readonly all: Effect.Effect<Array<OutboxMessage>, RepositoryError>
  readonly pending: Effect.Effect<Array<OutboxMessage>, RepositoryError>
  readonly recordAttempt: (id: string) => Effect.Effect<void, RepositoryError>
  readonly markDelivered: (id: string) => Effect.Effect<void, RepositoryError>
}>()("app/Outbox") {
  static readonly layer = Layer.effect(
    Outbox,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const insert = SqlSchema.void({
        Request: OutboxMessage,
        execute: (row) => sql`insert into outbox ${sql.insert(row)}`
      })
      const select = SqlSchema.findAll({
        Request: Schema.Struct({ pendingOnly: Schema.Boolean }),
        Result: OutboxMessage,
        execute: ({ pendingOnly }) =>
          sql`select id, topic, payload, attempts, delivered from outbox ${
            pendingOnly ? sql`where delivered = false` : sql``
          } order by seq`
      })

      return Outbox.of({
        enqueue: (id, topic, event) =>
          insert(new OutboxMessage({ id, topic, payload: event, attempts: 0, delivered: false })).pipe(
            owned("Outbox.enqueue")
          ),
        all: select({ pendingOnly: false }).pipe(owned("Outbox.all")),
        pending: select({ pendingOnly: true }).pipe(owned("Outbox.pending")),
        recordAttempt: (id) =>
          sql`update outbox set attempts = attempts + 1 where id = ${id}`.pipe(
            Effect.asVoid,
            owned("Outbox.recordAttempt")
          ),
        markDelivered: (id) =>
          sql`update outbox set delivered = true where id = ${id} and delivered = false`.pipe(
            Effect.asVoid,
            owned("Outbox.markDelivered")
          )
      })
    })
  )
}

// --- Raises use case: owns the transaction boundary ---------------------------

const Salary = Schema.Struct({ salary: Schema.Int })
const Remaining = Schema.Struct({ remaining: Schema.Int })

class Raises extends Context.Service<Raises, {
  readonly approve: (input: {
    readonly employeeId: number
    readonly cycle: string
    readonly amount: number
  }) => Effect.Effect<RaiseApproved, EmployeeNotFound | MeritBudgetExceeded | RepositoryError>
  readonly salaryOf: (employeeId: number) => Effect.Effect<number, EmployeeNotFound | RepositoryError>
}>()("app/Raises") {
  static readonly layer = Layer.effect(
    Raises,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const outbox = yield* Outbox

      const applyRaise = SqlSchema.findOneOption({
        Request: Schema.Struct({ employeeId: Schema.Int, amount: Schema.Int }),
        Result: Salary,
        execute: ({ amount, employeeId }) =>
          sql`update employees set salary = salary + ${amount} where id = ${employeeId} returning salary`
      })
      const drawBudget = SqlSchema.findOneOption({
        Request: Schema.Struct({ cycle: Schema.String, amount: Schema.Int }),
        Result: Remaining,
        execute: ({ amount, cycle }) =>
          sql`update merit_budgets set remaining = remaining - ${amount} where cycle = ${cycle} returning remaining`
      })
      const selectSalary = SqlSchema.findOneOption({
        Request: Schema.Int,
        Result: Salary,
        execute: (employeeId) => sql`select salary from employees where id = ${employeeId}`
      })

      const approve = Effect.fn("Raises.approve")(function*(input: {
        readonly employeeId: number
        readonly cycle: string
        readonly amount: number
      }) {
        const unit = Effect.gen(function*() {
          // Zero rows is domain absence; a bad row or a failed statement is not.
          const raised = yield* applyRaise(input).pipe(owned("Raises.approve.applyRaise"))
          if (Option.isNone(raised)) {
            return yield* new EmployeeNotFound({ employeeId: input.employeeId })
          }
          const event = new RaiseApproved({
            employeeId: input.employeeId,
            cycle: input.cycle,
            newSalary: raised.value.salary
          })
          // Same SqlClient, same fiber context: this insert joins the transaction.
          yield* outbox.enqueue(`raise-approved:${input.cycle}:${input.employeeId}`, "RaiseApproved", event)
          const budget = yield* drawBudget(input).pipe(owned("Raises.approve.drawBudget"))
          // A cycle without a budget row has nothing to draw from.
          const remaining = Option.match(budget, { onNone: () => -input.amount, onSome: (row) => row.remaining })
          // The rule is checked AFTER both writes. Failing here fails the body,
          // so the salary update and the outbox row roll back together.
          if (remaining < 0) {
            return yield* new MeritBudgetExceeded({ cycle: input.cycle, overBy: -remaining })
          }
          return event
        })
        // No recovery inside the body: commit or rollback is decided by its Exit.
        return yield* sql.withTransaction(unit).pipe(
          Effect.catchTag("SqlError", (cause) => Effect.fail(new RepositoryError({ operation: "Raises.approve", cause })))
        )
      })

      const salaryOf = Effect.fn("Raises.salaryOf")(function*(employeeId: number) {
        const row = yield* selectSalary(employeeId).pipe(owned("Raises.salaryOf"))
        if (Option.isNone(row)) {
          return yield* new EmployeeNotFound({ employeeId })
        }
        return row.value.salary
      })

      return Raises.of({ approve, salaryOf })
    })
  )
}

// --- Relay: runs after commit, outside any transaction ------------------------

class Publisher extends Context.Service<Publisher, {
  readonly publish: (message: OutboxMessage) => Effect.Effect<void, DeliveryFailed>
}>()("app/Publisher") {}

const relayPass = Effect.gen(function*() {
  const outbox = yield* Outbox
  const publisher = yield* Publisher
  const pending = yield* outbox.pending
  const outcomes = yield* Effect.forEach(pending, (message) =>
    outbox.recordAttempt(message.id).pipe(
      Effect.andThen(publisher.publish(message)),
      // Acknowledge only after the publish succeeded.
      Effect.andThen(outbox.markDelivered(message.id)),
      Effect.as(true),
      // A failed delivery is an expected outcome: the row stays pending.
      Effect.catchTag("DeliveryFailed", () => Effect.succeed(false))
    ))
  return {
    delivered: outcomes.filter((ok) => ok).length,
    failed: outcomes.filter((ok) => !ok).length
  }
})

// --- A scripted broker and an idempotent consumer for the demo ---------------

interface PayrollStats {
  readonly received: number
  readonly duplicates: number
  readonly applied: ReadonlyArray<string>
}

class Payroll extends Context.Service<Payroll, {
  readonly receive: (message: OutboxMessage) => Effect.Effect<void>
  readonly stats: Effect.Effect<PayrollStats>
}>()("app/Payroll") {
  static readonly layer = Layer.effect(
    Payroll,
    Effect.gen(function*() {
      const state = yield* Ref.make<PayrollStats>({ received: 0, duplicates: 0, applied: [] })
      return Payroll.of({
        // Deduplicate on the outbox id: a redelivery is acknowledged, not re-applied.
        receive: (message) =>
          Ref.update(state, ({ applied, duplicates, received }) =>
            applied.includes(message.id)
              ? { received: received + 1, duplicates: duplicates + 1, applied }
              : { received: received + 1, duplicates, applied: [...applied, message.id] }),
        stats: Ref.get(state)
      })
    })
  )
}

// Loses the acknowledgement of the first publish AFTER the consumer accepted it.
const PublisherLosesFirstAck = Layer.effect(
  Publisher,
  Effect.gen(function*() {
    const payroll = yield* Payroll
    const acksToLose = yield* Ref.make(1)
    return Publisher.of({
      publish: Effect.fn("Publisher.publish")(function*(message: OutboxMessage) {
        yield* payroll.receive(message)
        const lose = yield* Ref.modify(acksToLose, (n) => [n > 0, Math.max(0, n - 1)] as const)
        if (lose) {
          return yield* new DeliveryFailed({ messageId: message.id, reason: "acknowledgement lost" })
        }
      })
    })
  })
)

// --- Wiring ---------------------------------------------------------------------

const Migrations = Layer.effectDiscard(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`create table employees (id integer primary key, name text not null, salary integer not null)`
    yield* sql`create table merit_budgets (cycle text primary key, remaining integer not null)`
    yield* sql`
      create table outbox (
        seq serial,
        id text primary key,
        topic text not null,
        payload text not null,
        attempts integer not null default 0,
        delivered boolean not null default false
      )
    `
    yield* sql`insert into employees ${
      sql.insert([
        { id: 1, name: "Ada", salary: 120000 },
        { id: 2, name: "Grace", salary: 150000 }
      ])
    }`
    yield* sql`insert into merit_budgets ${sql.insert({ cycle: "2026", remaining: 12000 })}`
  })
)

// One named database Layer value: `Raises` and `Outbox` share one SqlClient, which
// is what lets `outbox.enqueue` join the transaction opened by `Raises.approve`.
const DatabaseLive = Migrations.pipe(Layer.provideMerge(PgliteClient.layer()))

const ApplicationLive = Raises.layer.pipe(
  Layer.provideMerge(Outbox.layer),
  Layer.provide(DatabaseLive),
  Layer.merge(PublisherLosesFirstAck.pipe(Layer.provideMerge(Payroll.layer)))
)

const program = Effect.gen(function*() {
  const raises = yield* Raises
  const outbox = yield* Outbox
  const payroll = yield* Payroll
  const lines: Array<unknown> = []
  const outboxView = Effect.map(outbox.all, (rows) =>
    rows.map(({ attempts, delivered, id }) => ({ id, delivered, attempts })))

  // 1. The salary change and its event commit together; nothing is delivered yet.
  yield* raises.approve({ employeeId: 1, cycle: "2026", amount: 10000 })
  lines.push({
    step: "approve ada",
    salary: yield* raises.salaryOf(1),
    outbox: yield* outboxView,
    received: (yield* payroll.stats).received
  })

  // 2. A business rule that fails inside the transaction rolls both writes back.
  const outcome = yield* raises.approve({ employeeId: 2, cycle: "2026", amount: 7000 }).pipe(
    Effect.as("approved"),
    Effect.catchTag("MeritBudgetExceeded", (error) => Effect.succeed(`${error._tag} overBy=${error.overBy}`))
  )
  lines.push({
    step: "approve grace",
    outcome,
    salary: yield* raises.salaryOf(2),
    outboxRows: (yield* outbox.all).length
  })

  // 3 + 4. Deliver after commit. The first pass loses the acknowledgement, so the
  // row stays pending and the second pass redelivers the same outbox id.
  lines.push({ step: "relay 1", ...(yield* relayPass), outbox: yield* outboxView })
  lines.push({ step: "relay 2", ...(yield* relayPass), outbox: yield* outboxView })
  lines.push({ step: "relay 3", ...(yield* relayPass) })
  lines.push({ step: "payroll", ...(yield* payroll.stats) })
  return lines
})

const runnable = program.pipe(Effect.provide(ApplicationLive))

for (const line of await Effect.runPromise(runnable)) {
  console.log(JSON.stringify(line))
}
```

## Why it is shaped this way

**The intent row is part of the state change.** `Raises.approve` wraps the salary update, the outbox insert, and the budget draw in one `sql.withTransaction`. Commit or rollback is decided solely by the `Exit` of that body, so the body contains no recovery: `MeritBudgetExceeded` leaves it as a failure and takes both writes with it. Publishing from inside the transaction would be wrong in both directions — a rollback cannot recall a delivered event, and a retried transaction would deliver it twice.

**Two repositories, one client.** `Outbox.enqueue` is an ordinary method on another service, yet it joins the transaction because both Layers were built from the same `SqlClient` and the active connection travels in the fiber context. A separately constructed client would run outside it.

**A failed `COMMIT` is a defect, not a caught `SqlError`.** `sql.withTransaction` issues `BEGIN` (or a `SAVEPOINT` when nested), runs the body, then `COMMIT` on success or `ROLLBACK` on failure. Only a failure to acquire the connection or start the transaction surfaces as the typed `SqlError` that `Effect.catchTag("SqlError", ...)` above turns into `RepositoryError`; a failed `COMMIT` or `ROLLBACK` itself is promoted to a defect, because the driver's state at that point — did it commit or not? — is not something a typed error can describe safely. Letting the fiber die is the honest outcome; catching it and reporting a normal `RepositoryError` would let a caller believe the write definitely failed when it may have gone through.

**Repositories own their failures.** `owned(operation)` uses `Effect.mapError` at the two places a repository can fail — the statement (`SqlError`) and the row decode (`SchemaError`) — and produces one `RepositoryError` with a typed `cause`. Defects and interruption pass through untouched; `Effect.catchCause` would have reported a programming bug as a storage failure. Zero rows is a different outcome: `findOneOption` returns `Option.none()`, which the use case turns into `EmployeeNotFound`.

**The guarantee is at-least-once, by construction.** The relay records the attempt, publishes, and acknowledges *in that order*. Every failure between "the consumer accepted" and "the row is marked delivered" — a lost acknowledgement, a crash, an interrupted relay, a failed `update` — produces a redelivery, never a loss. That is why the consumer deduplicates on the outbox id, and why the id is derived from the business fact (`raise-approved:<cycle>:<employee>`) rather than generated per attempt.

The rules behind each step are in [SQL: Transactions](../interfaces/sql#transactions), [External effects after commit](../interfaces/sql#external-effects-after-commit-outbox), and [Normalizing errors at a repository boundary](../interfaces/sql#normalizing-errors-at-a-repository-boundary).

## Variations

- **Run the relay continuously.** `relayPass.pipe(Effect.repeat(Schedule.spaced("1 second")))` forked into the application scope turns the pass into a poller; on PostgreSQL, `listen` / `notify` can wake it early, with polling kept as the safety net. With `@effect/sql-pg` a dropped listener connection fails the notification queue with its `SqlError`, so wrap the listener in `Stream.retry` and run one pass after every re-registration, because notifications sent in the gap are not replayed ([Dates, enums, and LISTEN queues](../interfaces/sql#native-client-behavior-codecs-json-and-listen)).
- **Several relay instances.** Claim rows before sending — for example an `update … set claimed_until = … where id in (select … for update skip locked) returning …` that commits *before* the publish — so two relays do not send the same row concurrently. The claim shortens duplicates; it does not remove the need for consumer deduplication.
- **Poison messages.** `attempts` is already durable. Stop selecting rows above a threshold, surface them on a dashboard, and redrive them deliberately instead of retrying forever.
- **Ordering.** This relay continues past a failed row. If a topic needs per-key order, stop the pass at the first failure for that key.
- **Let the library run the queue.** [PersistedQueue](../tooling/persistence#persistedqueue) with its SQL store on the same `SqlClient` is a ready-made outbox: `queue.offer(event, { id })` inside `sql.withTransaction` commits or rolls back with the domain write, and `queue.take` adds retry schedules and dead-lettering.
- **Expose it over HTTP.** Map `EmployeeNotFound`, `MeritBudgetExceeded`, and `RepositoryError` to declared endpoint errors in [HttpApi](../interfaces/http-api); the shared-Schema wiring is shown in [Recipe: Schema to HttpApi to SQL](./schema-httpapi-sql-boundary).
- **Beyond one database.** When the work spans services or must survive long waits, move up [the durability and distribution ladder](../deep-dives/durability-and-distribution-ladder) to workflows and cluster messaging.
