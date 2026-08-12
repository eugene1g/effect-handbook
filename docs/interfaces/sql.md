# SQL

> **Note:** The query API, schema adapters, resolvers, models, and migrator live in the stable-but-`unstable/`-namespaced core at `effect/unstable/sql/*`. They are database-agnostic. A driver package like `@effect/sql-pg` contributes one thing: a `Layer` producing the `SqlClient` service wired to a real connection pool and the correct dialect compiler. Write your service against `SqlClient`; swap the driver layer to change databases.

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
| `stmt.unprepared` | Execute without a prepared statement (needed for multi-statement SQL). |
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
import { Effect, Schedule } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"

// One employee, one active equity grant: a unique index on (employee_id, status).
const grantEquity = Effect.fn("grantEquity")(
  function*(employeeId: number, shares: number) {
    const sql = yield* SqlClient.SqlClient
    return yield* sql`insert into equity_grants ${
      sql.insert({ employee_id: employeeId, shares, status: "active" })
    }`.pipe(
      // Retry only the transient reasons (deadlock, serialization, lock/statement timeout, connection)
      Effect.retry({
        while: (e: SqlError.SqlError) => e.isRetryable,
        schedule: Schedule.exponential("10 millis")
      }),
      // Turn a unique-constraint violation into a domain decision
      Effect.catchTag("SqlError", (e): Effect.Effect<
        never,
        SqlError.SqlError | "grant-already-exists"
      > =>
        e.reason._tag === "UniqueViolation"
          ? Effect.fail("grant-already-exists" as const)
          : Effect.fail(e))
    )
  }
)
```

Reasons marked retryable: `ConnectionError`, `DeadlockError`, `SerializationError`, `LockTimeoutError`, `StatementTimeoutError`. Not retryable: `AuthenticationError`, `AuthorizationError`, `SqlSyntaxError`, `UniqueViolation` (carries the violated `constraint`), `ConstraintError`, `UnknownError`. Guards `isSqlError` / `isSqlErrorReason` and the SQLite classifier `classifySqliteError` are included. `ResultLengthMismatch` lives here too (raised by `SqlResolver.ordered`).

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

Loaders: `fromFileSystem(dir)` imports numbered `.js`/`.ts`/`.mjs`/`.mts` files, requires both `FileSystem` and a host-aware `Path`, and converts absolute paths to file URLs for Windows-safe ESM loading. Aggregate host layers satisfy both requirements—do not pair it with core's POSIX-only `Path.layer` on Windows. `fromGlob(importMap)` is the bundler-friendly route; `fromRecord` / `fromBabelGlob` cover in-code or transpiled setups. Failures are typed as `MigrationError` with a `kind` of `BadState | ImportError | Failed | Duplicates | Locked`.

> **Tip:** On Postgres the migrator takes an `ACCESS EXCLUSIVE` lock on the migrations table; a concurrent deploy that loses the race sees `kind: "Locked"` and no-ops instead of double-applying. Safe to run on every instance at startup.

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

Pass `softDeleteColumn` and deletes flip that column to `CURRENT_TIMESTAMP` while every read filters out soft-deleted rows automatically. `SqlModel.makeResolvers` returns `RequestResolver`s (`insert`, `insertVoid`, `findById`, `delete`) so model lookups participate in request batching.

**Reach for it when** a schema model maps cleanly to a table and you want standard CRUD without re-typing insert/update/select shapes — drop to a raw `sql` tagged template for anything bespoke.

## The driver packages

Each driver is a thin satellite package contributing a `Layer` producing `SqlClient` wired to a real connection and the correct dialect compiler. All expose `layer(config)` and `layerConfig(Config.Wrap<...>)`, and most ship a matching `*Migrator`.

- **pkg @effect/sql-pg** — PostgreSQL over `pg` pools. Dialect `pg` with `$1` placeholders and `RETURNING`. Adds `listen`/`notify`, JSON helpers, and `PgMigrator` with `pg_dump` schema dumps.

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

- **pkg @effect/sql-pglite** — PGlite: Postgres compiled to WASM. Genuine pg dialect that runs in-process or in the browser — great for tests and local dev. Its extended client adds `listen`/`notify`, `dumpDataDir(compression?)` for portable snapshots, and `refreshArrayTypes` after extensions or schema changes introduce array types.

> **Note:** Typical usage: build `SqlLive = PgClient.layer({ ... })`, run `PgMigrator.layer({ loader })` on top at startup, define table models as `Model.Class`, derive repositories with `SqlModel.makeRepository`, reach for `SqlResolver` in resolvers to batch lookups, and drop to the `sql` tagged-template API plus `SqlSchema` for anything custom. One client service, swappable driver, typed all the way down.
