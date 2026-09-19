# SQL

> **Note:** The query API, schema adapters, resolvers, models, and migrator live in the stable-but-`unstable/`-namespaced core at `effect/unstable/sql/*`. They are database-agnostic. A driver package like `@effect/sql-pg` contributes one thing: a `Layer` producing the `SqlClient` service wired to a real connection pool and the correct dialect compiler. Write your service against `SqlClient`; swap the driver layer to change databases.

> **Official example:** The release-matched [`ai-docs` SQL example](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.115/ai-docs/src/40_sql) defines a `Model.Class`, runs migrations, and exposes a derived repository through a service.

## Where SQL belongs in an application

**Dependencies point one way: transport → use case → domain repository → SQL implementation → `SqlClient`.** A route handler that holds the raw `SqlClient` has nowhere to put authorization, invariants, or error meaning, and every driver change reaches the edge.

| Layer | Owns | Does not own |
| --- | --- | --- |
| Transport ([HttpApi](./http-api), [RPC](./rpc)) | Decoding input, encoding output, mapping domain errors to statuses | SQL, transactions |
| Use case | The transaction boundary (`sql.withTransaction` around the smallest atomic unit), domain rules | Statement text |
| Domain repository (a `Context.Service`) | A domain-named capability, row decoding, [one stable storage error](#normalizing-errors-at-a-repository-boundary) | Connections — its Layer receives `SqlClient` once |
| Driver Layer | Pool, dialect, connection lifetime | Anything domain-shaped |

Generated repositories ([`SqlModel`](#sqlmodel)) remove CRUD boilerplate, but keep them *behind* the domain repository so library churn stays local. For each operation, decide up front: request and result Schemas · cardinality and what absence means · transaction and locking needs · expected domain failures · how `SqlError` / `SchemaError` surface · connection cost (a transaction, stream, or listener *holds* a connection; an ordinary statement borrows one briefly).

## SqlClient

`effect/unstable/sql/SqlClient` — unstable

`SqlClient` is the injected service used for every query. It is simultaneously a tagged-template query constructor (`sql` applied to a template literal), an identifier quoter (`sql("employees")`), and an object with helpers (`sql.in`, `sql.insert`, `sql.withTransaction`). `const sql = yield* SqlClient.SqlClient` gives you this callable. Each tagged-template statement is an `Effect` yielding `ReadonlyArray<Row>`.

### The star: parameterized tagged-template queries

Every value interpolated with `${}` becomes a bound parameter, never string-concatenated into the SQL text. The text around interpolations is literal; holes become placeholders (`$1`, `$2` on pg, `?` on sqlite/mysql).

```ts
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

const getEmployee = Effect.fn("getEmployee")(function*(id: number) {
  const sql = yield* SqlClient.SqlClient
  // `id` is bound as a parameter -> compiles to: select * from employees where id = $1
  const rows = yield* sql`select * from employees where id = ${id}`
  return rows[0]
})
```

> **Warning:** `sql(someString)` produces a quoted *identifier* (table/column name), escaped by the dialect. `sql.unsafe(text, params)` and `sql.literal(text)` splice raw text **unescaped** — reserve for trusted, static SQL only. Untrusted values always go through `${}` interpolation.

**A placeholder can stand for a value, never for a table, column, sort direction, or fragment.** Map a user's choice through a closed allow-list first, and only then hand the result to the identifier helper — quoting makes an identifier syntactically safe, not authorized.

```ts
import { SqlClient } from "effect/unstable/sql"

declare const sql: SqlClient.SqlClient
declare const requestedSort: string // untrusted: a query-string value

const sortColumns: Record<string, string> = { name: "name", hired: "hired_at", level: "level" }
const column = sortColumns[requestedSort] ?? "name" // unknown input falls back, it is never quoted through
const page = sql`select * from employees order by ${sql(column)} limit 20`
```

A statement is also an Effect and exposes execution views. `.values` returns rows as positional value arrays; `.valuesUnprepared` does the same through the driver's unprepared/text path. `.unprepared` keeps object rows, `.withoutTransform` skips result-name transforms, `.stream` streams rows, and `.compile()` returns SQL plus bound parameters. Choose an unprepared form only when the driver or proxy cannot use prepared statements.

### Helpers you'll use daily

```ts
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

const findEmployees = Effect.fn("findEmployees")(
  function*(levels: ReadonlyArray<string>, hiredBefore: Date) {
    const sql = yield* SqlClient.SqlClient

    // sql.in -> a safe, parameterized IN (...) list (handles the empty-array case too)
    // sql.and -> parenthesized AND chain of fragments
    const rows = yield* sql`
      select * from ${sql("employees")}
      where ${
      sql.and([
        sql.in("level", levels),
        sql`hired_at < ${hiredBefore}`
      ])
    }
    `
    return rows
  }
)

const addEmployee = Effect.fn("addEmployee")(
  function*(name: string, level: string, departmentId: number) {
    const sql = yield* SqlClient.SqlClient
    // sql.insert builds the (cols) VALUES (...) clause; .returning("*") adds RETURNING on pg
    return yield* sql`insert into employees ${
      sql.insert({ name, level, department_id: departmentId }).returning("*")
    }`
  }
)
```

Additional helpers: `sql.insert([...])` for bulk rows, `sql.update(record, [omitKeys])` for a single-row `SET` clause, `sql.updateValues([...], "alias")` for multi-row updates (not on sqlite), `sql.or`, and `sql.csv("order by", [...])` for comma lists.

> **Note:** Prefer the two-argument `sql.in("level", levels)`: with an empty array it compiles to `1=0` (no rows). The one-argument form `level in ${sql.in(levels)}` compiles an empty array to `in ()`, which PostgreSQL rejects as a syntax error. Bulk `sql.insert([...])` and long `IN` lists bind one parameter per value, so chunk large inputs to stay under the driver's parameter and statement-size limits.

### Fragments compose

A statement built with the `sql` tag is a *Fragment*, so it can be interpolated into another query to build queries conditionally without touching strings.

```ts
import { SqlClient } from "effect/unstable/sql"

declare const sql: SqlClient.SqlClient
declare const activeOnly: boolean

const filter = activeOnly ? sql`where terminated_at is null` : sql``
const page = sql`select * from employees ${filter} order by id limit 20`
```

### Transactions

`sql.withTransaction(effect)` runs every query in the effect on one reserved connection, inside a transaction. Success commits; failure or interruption rolls back. Nested `withTransaction` calls automatically become **savepoints** rather than a second `BEGIN`.

```ts
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

// Promote an employee and adjust their salary atomically.
const promote = Effect.fn("promote")(
  function*(employeeId: number, newLevel: string, newSalaryCents: number) {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function*() {
        yield* sql`update employees set level = ${newLevel} where id = ${employeeId}`
        yield* sql`update employees set base_salary = ${newSalaryCents} where id = ${employeeId}`
        // throw / fail / interrupt anywhere in here -> automatic ROLLBACK (no half-applied promotion)
      })
    )
  }
)
```

> **Tip:** `withTransaction` opens a `sql.transaction` tracing span and emits `db.transaction.commit` / `rollback` / `savepoint` events. Every query carries the client's span attributes.

**Commit or rollback is decided by exactly one thing: the `Exit` of the effect you pass in.** Sequencing only orders statements; `withTransaction` never inspects what ran inside. Two plausible mistakes therefore commit half a unit:

| Mistake | What happens | Fix |
| --- | --- | --- |
| **Recovering inside the body** — `Effect.ignore`, `Effect.catch`, or `Effect.orElseSucceed` around a failing step | The body's `Exit` is a success, so every write issued before the failure is **committed**. Re-raising afterwards is too late. | Let the failure leave the body; recover *outside* `withTransaction`. |
| **Opening the transaction late** — the first write runs before `withTransaction` | That write already committed on its own; the rollback cannot reach it. | Put the whole unit inside. |

```ts
import { Data, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

class BudgetExceeded extends Data.TaggedError("BudgetExceeded")<{ readonly cycle: string }> {}

declare const sql: SqlClient.SqlClient
// Decrements the merit budget; fails when the budget cannot cover the raise.
declare const drawMeritBudget: (cycle: string, amount: number) => Effect.Effect<void, BudgetExceeded>

const recordRaise = (employeeId: number, amount: number) =>
  sql`insert into raises ${sql.insert({ employee_id: employeeId, amount })}`

// WRONG — swallowed failure: the body succeeds, so the raise commits without its budget draw.
const swallowed = sql.withTransaction(
  Effect.gen(function*() {
    yield* recordRaise(42, 10_000)
    yield* drawMeritBudget("2026", 10_000).pipe(Effect.ignore)
  })
)

// WRONG — late transaction: the insert is committed before the transaction even opens.
const late = Effect.gen(function*() {
  yield* recordRaise(42, 10_000)
  yield* sql.withTransaction(drawMeritBudget("2026", 10_000))
})

// RIGHT — the whole unit inside, recovery outside.
const atomic = sql.withTransaction(
  Effect.gen(function*() {
    yield* recordRaise(42, 10_000)
    yield* drawMeritBudget("2026", 10_000)
  })
).pipe(
  Effect.catchTag("BudgetExceeded", () => Effect.succeed("rejected" as const))
)
```

Test the forced-rollback path: make the second step fail and assert that *every* related table is unchanged. An identity `withTransaction` fake proves nothing about atomicity.

Transaction rules:

- **Membership is by client identity.** The active connection travels in the fiber context under a key that is unique per constructed client, so every participant must use the *same* `SqlClient` instance. Two repositories built from one client Layer join one transaction; a second, separately constructed client — even one pointing at the same database — acquires its own connection and runs outside it.
- **Wrap the smallest database-only unit, at the use-case level.** A transaction holds one pooled connection and its locks for its whole duration. Remote calls, sleeps, and unbounded work do not belong inside: rollback cannot undo an email, and retrying the transaction would send it twice. See [External effects after commit](#external-effects-after-commit-outbox).
- **Do not fork work that outlives the transaction.** A fiber forked inside keeps the context entry that points at the transaction's connection, even after commit has returned that connection to the pool.
- **Concurrent branches still share the one reserved connection.** `Effect.all(..., { concurrency })` inside a transaction does not parallelize database work, and nested `withTransaction` calls made from sibling fibers are serialized.
- **Nested calls are savepoints, not isolation.** A failure that escapes an inner `withTransaction` rolls back to its savepoint; if you recover *around the inner call*, the outer transaction continues and commits without the inner writes — the one legitimate way to make a step optional. The helper does not prevent lost updates: pick an isolation level, `select … for update`, a version column, or a single atomic `update … set remaining = remaining - ${n}` from the invariant you need.
- **Retry the whole transaction, never an inner statement.** After a `DeadlockError` or `SerializationError` the database has already aborted the transaction, so retry `sql.withTransaction(unit)` as a unit, with a bounded schedule, and only when `unit` is database-only.
- **`BEGIN` and `SAVEPOINT` failures are typed; `COMMIT` and `ROLLBACK` failures are defects.** Failing to acquire the connection, to begin, or to create a savepoint fails with `SqlError` (before `rc.109` a failed `BEGIN` surfaced as a rollback defect). A failed `COMMIT` or `ROLLBACK` is converted with `Effect.orDie`: for example a `deferrable initially deferred` constraint that fires at commit arrives as a **defect** whose value is the `SqlError`. Alert on defects from `sql.transaction` spans, not only on typed failures, and inspect them with `SqlError.isSqlError`.

### External effects after commit (outbox)

**A transaction should contain database work only; deliver external effects after it commits.** Emails, webhooks, HTTP exports, and model calls are irreversible, while a transaction body can be rolled back after the send or retried after a deadlock. The reverse order — commit, then publish from the same request — loses the event when the process dies between the two steps.

The transactional outbox closes both gaps: write an **intent row** in the same transaction as the state change, and let a separate relay deliver pending rows after commit.

```ts
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

declare const sql: SqlClient.SqlClient
// Idempotent on `eventId` at the receiver.
declare const publish: (eventId: string, payload: string) => Effect.Effect<void, "delivery-failed">

const approveRaise = (employeeId: number, newSalary: number, eventId: string) =>
  sql.withTransaction(
    Effect.gen(function*() {
      yield* sql`update employees set base_salary = ${newSalary} where id = ${employeeId}`
      yield* sql`insert into outbox ${
        sql.insert({ id: eventId, topic: "RaiseApproved", payload: JSON.stringify({ employeeId, newSalary }) })
      }`
    })
  )

// Runs on a schedule, outside any transaction.
const deliverPending = Effect.gen(function*() {
  const rows = yield* sql<{ id: string; payload: string }>`
    select id, payload from outbox where delivered = false order by seq
  `
  for (const row of rows) {
    yield* publish(row.id, row.payload)
    // Acknowledge only after the send succeeded.
    yield* sql`update outbox set delivered = true where id = ${row.id} and delivered = false`
  }
})
```

**Name the guarantee honestly: at-least-once.** A failed send leaves the row pending and the same event id is sent again; a crash between the receiver accepting and the local acknowledgement re-sends an event that already arrived. Receivers must deduplicate on the event id — never write "exactly once". Count attempts durably and park rows that keep failing instead of retrying them forever.

The complete, runnable version — repository errors, forced rollback, acknowledgement loss, and consumer deduplication — is [Recipe: A Transactional Write with an Outbox](../recipes/transactional-write-with-outbox). When the queue itself can live in the same database, [PersistedQueue](../tooling/persistence#persistedqueue) with its SQL store is a ready-made outbox with retry schedules and dead-lettering; [the durability ladder](../deep-dives/durability-and-distribution-ladder) covers workflows and cluster delivery.

### Statement variants & dialect switches

Each statement exposes alternate execution modes (covered under Statement): `.stream`, `.values`, `.raw`, `.unprepared`, `.withoutTransform`, `.compile()`. For portable libraries, `sql.onDialect({ pg, sqlite, mysql, mssql, clickhouse })` / `sql.onDialectOrElse({ orElse, pg })` branch on the active database.

`sql.reserve` hands a scoped raw `Connection` for manual control. `sql.reactive(keys, effect)` turns a query into a `Stream` that re-runs when those keys are invalidated via the Reactivity service.

**Reach for it when** you talk to a database at all.

## Statement

`effect/unstable/sql/Statement` — unstable

A `Statement<A>` is a list of *segments* (literals, escaped identifiers, bound parameters, insert/update helpers) plus the machinery to compile them to a `[sqlText, params]` pair for the active dialect. It is both an `Effect` and a `Fragment`. The template literal is parsed once into segments; the dialect `Compiler` walks those segments to produce numbered placeholders and the params array.

| On a statement | Gives you |
| --- | --- |
| `yield* stmt` | Decoded/transformed rows — `ReadonlyArray<A>`. The default. |
| `stmt.stream` | A `Stream<A, SqlError>` for large result sets ([see `SqlStream`](#sqlstream)). |
| `stmt.values` | Rows as positional arrays (`ReadonlyArray<ReadonlyArray<unknown>>`) — skips object building. |
| `stmt.raw` | The driver's raw result object, untouched. |
| `stmt.unprepared` | Execute without the named prepared-statement cache (for poolers such as PgBouncer in transaction mode that cannot keep named statements). Driver-dependent: on the native `@effect/sql-pg` client a query string must still contain exactly **one** statement, because PostgreSQL's extended protocol rejects multi-statement strings. |
| `stmt.withoutTransform` | Skip the client's row/column name transform for this query. |
| `stmt.compile()` | `[sql, params]` — inspect what will actually run. |

```ts
import { SqlClient } from "effect/unstable/sql"

declare const sql: SqlClient.SqlClient

// Inspect the compiled output — exactly what the test suite does:
const [text, params] = sql`select * from ${sql("comp_bands")} where level in ${sql.in(["L3", "L4", "L5"])}`.compile()
// text:   select * from "comp_bands" where level in ($1,$2,$3)
// params: ["L3", "L4", "L5"]
```

Segment constructors (`literal`, `identifier`, `parameter`, `arrayHelper`, insert/update helpers, and `custom` for driver extensions) are exported for custom dialect or bespoke helper authoring. The `Dialect` type — `"sqlite" | "pg" | "mysql" | "mssql" | "clickhouse"` — is the same one `onDialect` keys on.

None of the execution views disables parameter binding: `.raw` and `.values` change the *projection*, `.unprepared` changes the *execution strategy*, and `${}` holes stay bound parameters in all of them.

> **Note:** Every execution opens a `sql.execute` client span carrying `db.operation.name` and `db.query.text` — the compiled SQL with placeholders, never the bound parameters. Text spliced in through `sql.literal` / `sql.unsafe` *is* part of that query text, one more reason to keep values in `${}`. Driver-level spans (connection acquisition, stream pulls) are not parented under `sql.execute` by default; opt in for a region with `Effect.provideService(Statement.SpanPropagationEnabled, true)` (added in `rc.113`, default `false`, ignored while tracing is disabled). `rc.113` also fixed `.returning(...)` helpers to escape identifiers per dialect and to number placeholders correctly when a cached fragment is reused.

**Reach for it when** you need a non-default execution mode (stream, raw, values, unprepared), want to `compile()` and assert on generated SQL, or you're authoring a custom dialect/helper.

## SqlSchema

`effect/unstable/sql/SqlSchema` — unstable

`SqlSchema` bridges a query and a `Schema`. It wraps execution so the request is encoded before running and every returned row is decoded through a result Schema. Each helper is a factory: provide a `Request` schema, a `Result` schema, and an `execute` callback; receive `(input) => Effect<decoded, SchemaError | ..., R>`. The difference between helpers is result cardinality.

```ts
import { Effect, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"

const Employee = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String,
  level: Schema.String,
  departmentId: Schema.Int.check(Schema.isGreaterThan(0))
})

const makeEmployeeQueries = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  // findOne: decode the first row, fail with NoSuchElementError if there are none
  const getById = SqlSchema.findOne({
    Request: Schema.Int.check(Schema.isGreaterThan(0)),
    Result: Employee,
    execute: (id) => sql`select * from employees where id = ${id}`
  })

  // findAll: a parameterized "employees in a department" query, every row decoded
  const inDepartment = SqlSchema.findAll({
    Request: Schema.Int.check(Schema.isGreaterThan(0)),
    Result: Employee,
    execute: (departmentId) =>
      sql`select * from employees where department_id = ${departmentId} order by level`
  })

  return { getById, inDepartment } as const
})

// getById(42):        Effect<Employee, SchemaError | NoSuchElementError | SqlError, ...>
// inDepartment(7):    Effect<Array<Employee>, SchemaError | SqlError, ...>
```

| Helper | Result type & empty-set behavior |
| --- | --- |
| `findAll` | `Array<A>` — empty is fine. |
| `findNonEmpty` | `NonEmptyArray<A>` — empty fails with `NoSuchElementError`. |
| `findOne` | `A` from first row — empty fails with `NoSuchElementError`. |
| `findOneOption` | `Option<A>` — empty is `None`. |
| `SqlSchema.void` | Encodes the request, runs the side-effecting statement, discards rows. |

> **Warning:** `findOne` and `findOneOption` mean **"first row"**, not "exactly one": both decode `rows[0]` and silently ignore any further rows. Exactly-one semantics need a unique constraint that the `where` clause targets, or `findAll` plus an explicit length check — a helper name containing "one" is not that proof.

**A row generic is not validation.** `sql<Row>` is a compile-time annotation only; database output is untrusted (schema drift, nullability, integer width, date and JSON representation, aliases), so decode before branding or constructing domain values. Keep three outcomes distinct:

| Outcome | Shows up as | Means |
| --- | --- | --- |
| Zero rows | `Option.none()` from `findOneOption`, `NoSuchElementError` from `findOne` / `findNonEmpty` | Domain absence — *when the operation defines one*. |
| A row that does not decode | `SchemaError` | Corrupt or incompatible stored data. Not "not found". |
| Statement or connection fault | `SqlError` | Infrastructure. Not "not found" either. |

Seed a deliberately malformed (or migration-old) row in a repository test to prove that decoding is active.

**Reach for it when** you want queries to return real domain types with validation at the boundary instead of hand-casting `unknown` rows.

## SqlResolver

`effect/unstable/sql/SqlResolver` — unstable

`SqlResolver` builds schema-aware `RequestResolver`s on top of Effect's Request/Batching machinery: many concurrent lookups collapse into one batched SQL query, with requests deduplicated by payload and results mapped back to callers. Describe one logical lookup (its `Id`/`Request` schema, its `Result` schema, and how to map a result back to the requesting caller). When N callers fire that lookup in one batching window, the resolver encodes all inputs, runs a single `IN (...)`-style query, decodes rows, and completes each request from the shared result set.

```ts
import { Effect, Schema } from "effect"
import { SqlClient, SqlResolver } from "effect/unstable/sql"

const CompBand = Schema.Struct({
  level: Schema.String,
  salaryMin: Schema.Finite,
  salaryMid: Schema.Finite,
  salaryMax: Schema.Finite
})

const makeCompBandLoader = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  // findById: batch many levels into one query; map each row back via ResultId
  const resolver = SqlResolver.findById({
    Id: Schema.String,
    Result: CompBand,
    ResultId: (band) => band.level,
    execute: (levels) => sql`select * from comp_bands where ${sql.in("level", levels)}`
  })

  // turn the resolver into a normal effectful function
  return SqlResolver.request(resolver)
})

// Pricing 100 raise recommendations? Each needs its level's band.
// These collapse into ONE "select ... where level in (...)" — and "L4" is deduped.
const program = Effect.gen(function*() {
  const bandFor = yield* makeCompBandLoader
  const [l4, l4Again, l5] = yield* Effect.all(
    [bandFor("L4"), bandFor("L4"), bandFor("L5")],
    { concurrency: "unbounded" }
  )
  return { l4, l4Again, l5 }
})
```

| Constructor | Use for |
| --- | --- |
| `findById` | One result per id, matched by `ResultId`; missing ids fail with `NoSuchElementError`. Auto-dedupes. |
| `grouped` | Many results per key, grouped by `ResultGroupKey` back to each request's `RequestGroupKey`. |
| `ordered` | Positional mapping: result row `i` answers request `i`; mismatched counts raise `ResultLengthMismatch`. |
| `SqlResolver.void` | Batched side-effect writes with no decoded result. |

> **Tip:** Batches are keyed by the active transaction connection, so lookups made inside a `withTransaction` never get merged with reads outside it.

**Reach for it when** you'd otherwise fire a query per item in a loop or per field in a GraphQL/RPC resolver.

Official guide: [Batching](https://effect.website/docs/v4/batching) (it enables batching with an `Effect.forEach` `batching` option that `rc.115` does not have — here requests batch when they are issued concurrently against the same resolver). The request/resolver model itself is covered in [Caching & Batching](../operations/caching-batching#requestresolver).

## SqlStream

`effect/unstable/sql/SqlStream` — unstable

`SqlStream` turns a driver's push-based cursor (event emitter, server-side cursor, callback firehose) into an Effect `Stream` with backpressure. It is plumbing that drivers use to implement `statement.stream` and `connection.executeStream`. `asyncPauseResume` registers an emitter with `single`/`array`/`fail`/`end` callbacks and pause/resume hooks; when the internal bounded queue fills, it calls the driver's `onPause` so the database stops pushing rows faster than they are consumed.

```ts
import { Effect, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"

// You almost always interact with it via `.stream` on a statement:
const streamAllEmployees = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`select * from employees order by id`.stream.pipe(
    Stream.runForEach((row) => Effect.log(row)) // rows arrive incrementally, backpressured
  )
})
```

**Reach for it when** writing a driver, or building a custom adapter from a row-emitting source into a `Stream`. For everyday large reads, use `statement.stream`.

## SqlError

`effect/unstable/sql/SqlError` — unstable

The single typed failure for the whole SQL stack. Every query, transaction, and connection acquire fails with `SqlError`. It wraps a structured `reason` — connection, auth, syntax, constraint, deadlock, serialization, timeout, unknown — each preserving the original driver cause and exposing whether a retry could help. The outer error delegates `message`, `cause`, and `isRetryable` to its reason.

```ts
import { Effect, Schedule, Schema } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"

class GrantAlreadyExists extends Schema.TaggedError<GrantAlreadyExists>()("GrantAlreadyExists", {
  employeeId: Schema.Int
}) {}

// One employee, one active equity grant: `unique (employee_id, status)`, which PostgreSQL
// names equity_grants_employee_id_status_key.
const grantEquity = Effect.fn("grantEquity")(
  function*(employeeId: number, shares: number) {
    const sql = yield* SqlClient.SqlClient
    return yield* sql`insert into equity_grants ${
      sql.insert({ employee_id: employeeId, shares, status: "active" })
    }`.pipe(
      // Retry only the transient reasons (deadlock, serialization, lock/statement timeout,
      // connection), at most 3 more times. `while`, `times`, and `schedule` must all allow a retry.
      Effect.retry({
        while: (e: SqlError.SqlError) => e.isRetryable,
        times: 3,
        schedule: Schedule.exponential("10 millis")
      }),
      // Translate the ONE constraint that means "already granted". Every other reason,
      // including a unique violation on a different index, stays a SqlError.
      Effect.catchTag("SqlError", (e): Effect.Effect<never, SqlError.SqlError | GrantAlreadyExists> =>
        e.reason._tag === "UniqueViolation" && e.reason.constraint === "equity_grants_employee_id_status_key"
          ? Effect.fail(new GrantAlreadyExists({ employeeId }))
          : Effect.fail(e))
    )
  }
)
```

Reasons marked retryable: `ConnectionError`, `DeadlockError`, `SerializationError`, `LockTimeoutError`, `StatementTimeoutError`. Not retryable: `AuthenticationError`, `AuthorizationError`, `SqlSyntaxError`, `UniqueViolation` (carries the violated `constraint`), `ConstraintError`, `UnknownError`. Guards `isSqlError` / `isSqlErrorReason` and the SQLite classifier `classifySqliteError` are included. `ResultLengthMismatch` lives here too (raised by `SqlResolver.ordered`).

**Match the constraint, not just the tag.** A primary-key collision is a `UniqueViolation` too (`equity_grants_pkey` on the table above), so translating every `UniqueViolation` into one domain conflict misreports unrelated bugs. Never map connectivity, authentication, timeout, syntax, or decode failures to not-found or conflict. Retrying the insert above is safe only because the unique index makes it idempotent: after a `ConnectionError` the first attempt may have committed, and the retry then reports the conflict instead of writing twice.

### Normalizing errors at a repository boundary

**A repository owns its failures: map the typed channel into one stable domain error, and leave defects alone.** Callers of `EmployeeRepository` should not import a driver error type, and should not have to guess which of `SqlError` or `SchemaError` a method can raise. The repository fails in exactly two places it owns — the statement and the row decode — so that is where the translation goes.

```ts
import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql"

class Employee extends Schema.Class<Employee>("Employee")({
  id: Schema.Int,
  name: Schema.String,
  email: Schema.String
}) {}

// One stable storage error. `cause` stays typed, so a caller that needs a domain
// decision can still look at `cause.reason` (for example a specific UniqueViolation).
class RepositoryError extends Data.TaggedError("RepositoryError")<{
  readonly operation: string
  readonly cause: SqlError.SqlError | Schema.SchemaError
}> {}

// mapError touches the typed channel only: a defect stays a defect, interruption stays interruption.
const owned = (operation: string) =>
<A, R>(self: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError, R>) =>
  Effect.mapError(self, (cause) => new RepositoryError({ operation, cause }))

class EmployeeRepository extends Context.Service<EmployeeRepository, {
  readonly findById: (id: number) => Effect.Effect<Option.Option<Employee>, RepositoryError>
  readonly create: (employee: Employee) => Effect.Effect<void, RepositoryError>
}>()("app/EmployeeRepository") {
  static readonly layer = Layer.effect(
    EmployeeRepository,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient // received once, never opened per method

      const selectById = SqlSchema.findOneOption({
        Request: Schema.Int,
        Result: Employee,
        execute: (id) => sql`select id, name, email from employees where id = ${id}`
      })
      const insert = SqlSchema.void({
        Request: Employee,
        execute: (employee) => sql`insert into employees ${sql.insert(employee)}`
      })

      return EmployeeRepository.of({
        findById: (id) => selectById(id).pipe(owned("EmployeeRepository.findById")),
        create: (employee) => insert(employee).pipe(owned("EmployeeRepository.create"))
      })
    })
  )
}
```

| Choice | Effect on callers | Use when |
| --- | --- | --- |
| `Effect.mapError` into one tagged error (`operation` + typed `cause`) | One storage failure to handle; defects and interruption untouched | The default for a service that can degrade, retry, or report storage trouble. |
| `Effect.orDie` at the repository | No storage error in the signature; every fault becomes a defect | The failure is genuinely outside the contract — small tools, or a transport that only ever answers 500. You give up `isRetryable` and constraint-based decisions. |
| `Effect.catchCause` to build the error | **Avoid.** It also captures defects, so a programming bug is reported as a routine storage failure | — |
| Leaking `SqlError` / `SchemaError` through the service API | Every caller couples to the SQL stack | Inside the SQL implementation only. |

Anti-patterns: opening connections inside methods, returning undecoded rows, and translating absence into an error the operation never defined. The transport maps `RepositoryError` to a declared endpoint error — see [HttpApi](./http-api); the [outbox recipe](../recipes/transactional-write-with-outbox) uses this exact shape across two repositories.

**Reach for it when** you handle database failures deliberately — retrying deadlocks, mapping unique violations, or surfacing typed causes upstream.

## SqlConnection

`effect/unstable/sql/SqlConnection` — unstable

The low-level, driver-facing contract under `SqlClient`. A `Connection` executes already-compiled SQL with positional params and can return transformed rows, raw results, a stream, value arrays, or unprepared results. It also defines the `Acquirer` (a scoped effect that checks a connection out of the pool) and the generic `Row` shape. `SqlClient` is the ergonomic front end; `Connection` is the raw executor a driver implements. Touch it directly only when using `sql.reserve` to pin a connection for an operation outside the statement abstraction.

```ts
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

const headcount = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  // sql.reserve is scoped: the connection returns to the pool when the scope closes
  const conn = yield* sql.reserve
  const values = yield* conn.executeValues("select count(*) from employees", [])
  return values // [[1234]]
}).pipe(Effect.scoped)
```

**Reach for it when** implementing a new driver, or needing a pinned raw connection for operations the statement API does not model.

## Migrator

`effect/unstable/sql/Migrator` — unstable

Versioned, transactional schema migrations. Records applied migration ids in a table (`effect_sql_migrations` by default), runs only pending ones in order inside a transaction, detects duplicate ids, and treats a concurrent run as locked rather than racing. A migration is a numbered file (`0003_create_equity_grants.ts`) whose default export is an `Effect` using `SqlClient`. A loader discovers them; the migrator diffs recorded vs. existing and applies the gap. Use the driver's `Migrator.layer({ loader })` so migrations run during layer construction, before the service starts.

```ts
// migrations/0003_create_equity_grants.ts
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    create table equity_grants (
      id serial primary key,
      employee_id integer not null references employees (id),
      shares bigint not null,
      strike_price numeric(12, 4),
      grant_date date not null,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      unique (employee_id, status)
    )
  `
})
```

```ts
// Wire migrations into your layer graph (pg shown). They run before the app boots.
import { Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { PgClient, PgMigrator } from "@effect/sql-pg"
import { Migrator } from "effect/unstable/sql"

const SqlLive = PgClient.layer({ database: "comp", username: "comp" })

const MigratorLive = PgMigrator.layer({
  loader: Migrator.fromFileSystem("migrations"),
  schemaDirectory: "migrations" // optional: dump schema via pg_dump after success
}).pipe(
  Layer.provide(SqlLive),
  Layer.provide(NodeServices.layer) // FileSystem + Path for the loader / dump
)
```

Loaders: `fromFileSystem(dir)` imports numbered `.js`/`.ts`/`.mjs`/`.mts` files, requires both `FileSystem` and a host-aware `Path`, and converts absolute paths to file URLs for Windows-safe ESM loading. Aggregate host layers satisfy both requirements—do not pair it with core's POSIX-only `Path.layer` on Windows. `fromGlob(importMap)` is the bundler-friendly route; `fromRecord` / `fromBabelGlob` cover in-code or transpiled setups. `MigrationError` carries a `kind` of `BadState | ImportError | Failed | Duplicates | Locked`, but the kinds do not all travel in the same channel: `ImportError` and `Duplicates` are typed failures; a migration whose own effect fails is wrapped as `kind: "Failed"` and raised as a **defect** (`Effect.die`), so it bypasses `Effect.catchTag("MigrationError", ...)`; `Locked` is handled internally and turns the run into a no-op that returns an empty list.

> **Tip:** All pending migrations run inside **one** `sql.withTransaction`. On PostgreSQL the migrator first takes an `ACCESS EXCLUSIVE` lock on the migrations table, so a concurrent instance waits and then finds nothing pending; on other dialects the loser's conflicting insert into the migrations table is reported as `Locked` and swallowed. Either way nothing is applied twice.

### Operating migrations

**Migrations are production code: append-only, tested from real snapshots, and compatible with the release that is still running.**

| Rule | Reason |
| --- | --- |
| **Never edit an applied migration, and only ever add higher ids.** | The migrator applies files whose id is greater than the **latest recorded id** and compares nothing else: an edited file is silently skipped wherever it already ran, and a lower-numbered migration merged late from another branch never runs at all. |
| **One pending batch is one transaction — where the database allows it.** | On PostgreSQL a failing migration rolls back the whole batch, earlier files included, and records nothing. Do not assume transactional DDL elsewhere: MySQL commits implicitly around DDL. |
| **Expand → migrate → contract across releases.** | During a rolling deploy old and new binaries share one schema, so additive changes ship first and destructive ones a release later. |
| **Keep long backfills out of startup.** | `Migrator.layer` runs during Layer construction, inside the migration transaction (and, on PostgreSQL, under the migrations-table lock); a long backfill blocks every replica's boot. Make backfills bounded, observable, restartable jobs. |
| **Decide who migrates.** | Running on every instance is safe against double-apply, but a dedicated migration job keeps DDL privileges out of the runtime role and keeps failure handling in one place. Verify the locking behavior on the real database. |
| **Recover forward.** | Ship a fixing migration and rely on restore-tested backups; a down migration is not a backup. |
| **Test the schema, not the ledger.** | Run migrations from empty *and* from a representative prior snapshot; assert constraints, indexes, defaults, and backfilled values — not merely rows in `effect_sql_migrations`. |

**Reach for it when** you need reproducible, ordered schema evolution checked into the repo and applied automatically on deploy.

## SqlModel

`effect/unstable/sql/SqlModel` — unstable

Define a table's shape once as a `Model` schema and derive a typed CRUD repository — `insert`, `update`, `findById`, `delete` — automatically. A `Model.Class` is a family of *variants* built on VariantSchema: the same definition yields a select schema, an `insert` schema (db-generated columns dropped), an `update` schema, and JSON-API variants (`json`, `jsonCreate`, `jsonUpdate`). `SqlModel.makeRepository` reads those variants to type each operation correctly. Insert/update inputs are encoded with the model's input variants, returned rows decoded with the full model, and dialect quirks (pg `RETURNING` vs. mysql `LAST_INSERT_ID`) are handled automatically.

```ts
import { Effect, Schema } from "effect"
import { Model } from "effect/unstable/schema"
import { SqlModel } from "effect/unstable/sql"

const EmployeeId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("EmployeeId"))

// One definition -> select / insert / update / json variants
class Employee extends Model.Class<Employee>("Employee")({
  // A repository needs its id in select + update, but not insert.
  id: EmployeeId.pipe(Model.FieldExcept(["insert"])),
  name: Schema.String,
  level: Schema.String,
  departmentId: Schema.Int.check(Schema.isGreaterThan(0)),
  baseSalary: Schema.Finite,
  createdAt: Model.DateTimeInsertFromDate,    // set on insert
  updatedAt: Model.DateTimeUpdateFromDate     // bumped on update
}) {}

// Derive a repository bound to the SqlClient in context
const makeEmployees = SqlModel.makeRepository(Employee, {
  tableName: "employees",
  spanPrefix: "Employees",
  idColumn: "id"
})

const program = Effect.gen(function*() {
  const employees = yield* makeEmployees

  // insert takes the insert variant (no id/createdAt to supply), returns a full Employee
  const created = yield* employees.insert(Employee.insert.make({
    name: "Ada Lovelace",
    level: "L5",
    departmentId: 7,
    baseSalary: 195_000
  }))

  const found = yield* employees.findById(created.id) // Effect<Employee, NoSuchElementError | ...>
  yield* employees.delete(created.id)
  return found
})
```

Pass `softDeleteColumn` and deletes flip that column to `CURRENT_TIMESTAMP` while every read filters out soft-deleted rows automatically. `SqlModel.makeResolvers` returns `RequestResolver`s (`insert`, `insertVoid`, `findById`, `delete`) so model lookups participate in request batching. It is scoped (`SqlClient | Scope`), and since `rc.113` requests made through the `insert` resolver also require the model's decoding services, because it decodes the returned row; use `insertVoid` when you do not need the row back.

**Reach for it when** a schema model maps cleanly to a table and you want standard CRUD without re-typing insert/update/select shapes — drop to a raw `sql` tagged template for anything bespoke.

## Operating SQL in production

### Pools, reservations, and streaming

- **Size pools from the database-wide budget, not per service.** Replicas × `maxConnections`, plus migration jobs, listeners, long streams, and an admin reserve, must fit under the server's connection limit. A bigger pool is not backpressure — bound application admission instead (see [Semaphore](../concurrency/concurrency-coordination#semaphore)).
- **Know what *holds* a connection.** A transaction, a `.stream`, `sql.reserve`, and a `listen` subscription keep one for their whole lifetime; an ordinary statement borrows one briefly. With `@effect/sql-pg`'s `multiplex`, plain statements share connections, but transactions, streams, and listeners still reserve one each.
- **Result streaming is driver-dependent.** The native PostgreSQL client streams incrementally on a pinned session and cancels the statement when the stream is abandoned; PGlite's `.stream` runs the query to completion and then emits the rows. Consume streams inside a scope, keep buffers bounded, and prefer keyset pagination over a stream that would hold a connection for hours.
- **Interruption expresses cancellation intent; the driver decides what reaches the server.** `@effect/sql-pg` sends a PostgreSQL `CancelRequest` for an interrupted statement, except on an unpinned multiplexed connection, where cancelling could hit another fiber's query. For other drivers, verify whether server-side work is cancelled or merely abandoned.
- **Give readiness probes a short deadline and their own headroom.** A probe that queues behind a saturated pool turns overload into a restart loop. Keep liveness independent of the database.

### Logging and telemetry safety

Never log connection strings, full parameter lists, or personal row values. Name operations with low-cardinality, allow-listed span names (`Effect.fn("Employees.findById")`) rather than interpolated text, and remember that `db.query.text` is exported with every `sql.execute` span.

### Verification levels

| Test | Replace | Proves | Does not prove |
| --- | --- | --- | --- |
| Use case | The **domain repository** Layer (not a partial fake `SqlClient`) | Domain rules, error mapping, orchestration | Any SQL, any atomicity — an identity `withTransaction` fake commits nothing and rolls back nothing |
| Repository contract suite | Nothing: a real database after real migrations, per supported driver | Decoding, cardinality, constraints, rollback, savepoints, date / integer / JSON / null behavior | Behavior of a *different* engine — SQLite does not prove PostgreSQL |
| Application graph | Only external systems | Layer wiring, pool sharing, startup order | Production load, contention |

Mandatory contract cases: valid and malformed rows; zero / one / many cardinality; the specific constraint each domain conflict maps from; rollback across **two repositories sharing one client**; savepoints; contention and transient-error classification; timeout and interruption; pool exhaustion; stream cleanup. In-process PGlite gives a genuine PostgreSQL dialect for the fast lane; pin the container image for the real-server lane, isolate a database per test worker, and keep logs on failure. An in-memory SQLite database may be per connection, which breaks pool assumptions.

## The driver packages

Each driver is a thin satellite package contributing a `Layer` producing `SqlClient` wired to a real connection and the correct dialect compiler. All expose `layer(config)` and `layerConfig(Config.Wrap<...>)`, and most ship a matching `*Migrator`.

- **pkg @effect/sql-pg** — PostgreSQL through Effect's **native wire-protocol client** (since `rc.113` there is no `pg`, `pg-pool`, or `pg-types` dependency). Dialect `pg` with `$1` placeholders and `RETURNING`. The native stack handles connection setup, binary codecs, named prepared statements, optional pipelining (`multiplex`), streaming, cancellation, and notifications. `PgClient.layer` / `layerConfig` are unchanged; `make(PgPoolConfig)` builds a pool and `makeClient(PgClientConfig)` a single connection — the old `fromPool`, `fromClient`, and `makeWith` constructors were removed. `PgMigrator` still shells out to `pg_dump` for schema dumps. **Upgrading is a behavior change, not just a dependency swap** — see [Upgrading `@effect/sql-pg` to the native client](#upgrading-effect-sql-pg-to-the-native-client).

- **pkg @effect/sql-mysql2** — MySQL / MariaDB via the `mysql2` driver. `?` placeholders; inserts/updates use the `LAST_INSERT_ID` + reselect path. Set `disablePreparedStatements: true` to use mysql2's text protocol globally, notably for proxies such as Cloudflare Hyperdrive that do not support `COM_STMT_PREPARE`.

- **pkg @effect/sql-mssql** — Microsoft SQL Server (Azure SQL). `mssql` dialect with its own identifier quoting and migrations table DDL. Its extended `MssqlClient` adds `param(type, value, options?)` for typed Tedious parameter fragments and `call(Procedure.compile(...))` for stored procedures; `Procedure.make`, `param`, `outputParam`, and `withRows` track inputs, outputs, and row types. TLS encryption and certificate validation are enabled by default; use `encrypt: false` only for a server without TLS, or `trustServer: true` for an explicitly trusted self-signed certificate.

- **pkg @effect/sql-sqlite-node** — SQLite through Node's built-in `node:sqlite` module. File-based and synchronous; ideal for tests, CLIs, and local-first apps. The extended client exposes `backup(destination)` with page-count metadata and `loadExtension(path)`; `updateValues` is unsupported. Its default five-second busy timeout and immediate transactions serialize competing writers and can block the event loop while SQLite is busy, so tune them for latency-sensitive applications.

- **pkg @effect/sql-sqlite-bun** — SQLite using Bun's built-in `bun:sqlite`. Same dialect, zero extra native deps on Bun.

- **pkg @effect/sql-sqlite-wasm** — SQLite compiled to WebAssembly — run in the browser or any WASM host.

- **pkg @effect/sql-d1** — Cloudflare D1, the edge SQLite service. Bind a D1 database and query it with the same `sql` tagged-template API from a Worker. Its `D1Client.batch(statements)` sends a fixed tuple as one atomic D1 batch and returns typed results in statement order; `updateValues` is unsupported.

- **pkg @effect/sql-sqlite-react-native** — SQLite on React Native (op-sqlite / expo). On-device persistence with the full Effect SQL surface.

- **pkg @effect/sql-sqlite-do** — SQLite backed by a Cloudflare Durable Object's storage — per-object strongly-consistent SQL at the edge.

- **pkg @effect/sql-clickhouse** — ClickHouse for analytics/OLAP. `clickhouse` dialect tuned for columnar, append-heavy workloads.

- **pkg @effect/sql-libsql** — libSQL / Turso — SQLite-compatible with remote HTTP/edge protocol and embedded replicas.

- **pkg @effect/sql-pglite** — PGlite: Postgres compiled to WASM. Genuine pg dialect that runs in-process or in the browser — great for tests and local dev. Its extended client adds `notify` and a scoped `listen(channel)` — an `Effect` yielding a `Queue.Dequeue<string>` of payloads, not a `Stream` — plus `dumpDataDir(compression?)` for portable snapshots, and `refreshArrayTypes` after extensions or schema changes introduce array types.

### Upgrading @effect/sql-pg to the native client

From `rc.113`, `@effect/sql-pg` speaks the PostgreSQL wire protocol itself instead of wrapping `pg`. `PgClient.layer` and the `sql` tagged template look the same, but what comes back — and what the server will accept — changed. Review each point before upgrading a production service:

| What changed | Before (`pg`) | Native client | What to do |
| --- | --- | --- | --- |
| Result decoding (binary codecs) | `int8` → string, `date` → `Date`, `timestamp`/`timestamptz` → `Date`, `bytea` → `Buffer` | `int8` → `bigint`, `date` → string, `timestamp`/`timestamptz` → Unix epoch **milliseconds** (`number`), `bytea` and unknown OIDs → `Uint8Array`, `inet` → `IpInterface`, `cidr` → `IpNetwork` | Re-check every row Schema over these column types: a `Schema.Number` over a `bigint` column, or a `Schema.Date` over a timestamp column, no longer matches the encoded value. |
| JSON parameters | a plain object parameter was inferred as JSON | not inferred | Wrap the value: `sql.json(value)`. |
| Statements per query string | multi-statement strings worked with simple queries | exactly **one** statement per string — the extended protocol rejects more, even through `stmt.unprepared` | Split migrations and seed scripts into separate statements. |
| Prepared statements | unnamed | **named prepared statements on by default**, cached per connection (`preparedStatementCacheSize`, default 100) | Behind a pooler that cannot keep named statements between queries (PgBouncer in transaction mode), set `prepare: false`. `Statement.unprepared` / `valuesUnprepared` use unnamed extended queries without touching the cache. |
| `listen(channel)` | a `Stream` of payload strings | a **scoped** `Effect` yielding `Queue.Dequeue<PgConnection.Notification>` (`{ processId, channel, payload }`), returned only after PostgreSQL confirms `LISTEN` | Take from the queue inside a scope. Because acquisition completes after confirmation, a notification sent right after it returns cannot be missed. The listener holds a connection until the scope closes. |
| Custom types | `pg.CustomTypesConfig` | `PgClientConfig.types: PgTypes.Registry` | Port custom parsers to the registry. |
| Raw results | `executeRaw` → `pg.Result` | `executeRaw` → `PgConnection.Result` | Adjust any code that inspects raw result metadata. |
| Constructors | `fromPool`, `fromClient`, `makeWith` | removed | `PgClient.make(poolConfig)` for a pool, `PgClient.makeClient(config)` for one connection. |

Inferred parameters stay permissive: strings bind untyped so the server derives the type from the statement, and safe integers beyond the `int4` range bind as `int8`. New tuning knobs include `multiplex` / `multiplexConcurrency` (pipelining several statements over one connection), `maxMessageSize`, and the pool options `minConnections`, `maxConnections`, `idleTimeout`, and `connectionTTL`. Pass `Statement.SpanPropagationEnabled` (default `false`) with `Effect.provideService` to parent driver spans under `sql.execute`.

> **Security note (`rc.115`):** the SQL-backed `Persistence` stores now parameterize lookup keys in `getMany`; earlier releases interpolated them into the query text. Upgrade if untrusted input can reach a persistence key.

> **Note:** Typical usage: build `SqlLive = PgClient.layer({ ... })`, run `PgMigrator.layer({ loader })` on top at startup, define table models as `Model.Class`, derive repositories with `SqlModel.makeRepository`, reach for `SqlResolver` in resolvers to batch lookups, and drop to the `sql` tagged-template API plus `SqlSchema` for anything custom. One client service, swappable driver, typed all the way down.
