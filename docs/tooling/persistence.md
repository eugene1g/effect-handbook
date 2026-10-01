# Persistence

The stack has three levels. `KeyValueStore` supplies raw string/binary storage and swappable backends; `Persistence` stores schema-typed request `Exit` values in named stores; `PersistedCache` and `PersistedQueue` add cache and queue behavior on top. Browser, SQL, Redis, and filesystem modules provide concrete storage layers without changing the typed interface.

> **Warning:** All modules in this chapter live under `effect/persistence/...`. Expect API changes between minor versions. Pin your Effect version and read the changelog before upgrading.

## What each primitive guarantees

Pick the primitive from the guarantee you need, and read the right-hand column before relying on it.

| Primitive | Gives you | Does **not** give you |
| --- | --- | --- |
| `KeyValueStore` | Durable strings / bytes behind a swappable backend | Atomic read-modify-write, transactions across keys, typed values (add `toSchemaStore`) |
| `Persistence` | Schema-typed `Exit` values with TTL, shared by every process on the same backing store | Freshness: a stored `Exit` is replayed until it expires or is removed |
| `PersistedCache` | A lookup that survives restarts; concurrent gets for one key share one lookup **inside a process** | A fleet-wide single flight (two processes that both miss both run the lookup), or a source of truth |
| `PersistedQueue` | **At-least-once** processing with durable attempt counts, retry delays, and a dead-letter state | Exactly-once effects, ordering across retries, or atomicity with your domain tables — except through [the SQL store on a shared client](#using-the-sql-store-as-a-transactional-outbox) |
| `RateLimiter` | Atomic counters; shared across processes with the Redis store | Coordination with the memory store (it is node-local); availability or fairness guarantees from Redis itself |
| `Redis` pub/sub | A wake-up signal | Delivery: messages published while a subscriber is away are gone |

## KeyValueStore

`effect/persistence/KeyValueStore` — unstable

Effectful key-value store service for string and binary (`Uint8Array`) values. The lowest layer of the persistence stack — a uniform interface that `Persistence` and `PersistedCache` sit on top of. Swap the backend by swapping the layer.

**Mental model.** A service with `get`, `set`, `remove`, `has`, `size`, `clear`, and `modify`. `get` returns `string | undefined` (not an `Option`) — `undefined` on a miss. For typed structured data, use `KeyValueStore.toSchemaStore` to get a schema-aware wrapper whose `get` returns `Option<A>`.

`modify` updates an **existing** key: on a miss it returns `undefined` without calling the callback or writing a value. Its default implementation reads and then writes in separate Effects, so concurrent callers can lose updates. The interface does not promise atomic read-modify-write; use a backend transaction or native atomic operation when that guarantee matters.

```ts
import { Effect, Option, Schema } from "effect"
import { KeyValueStore } from "effect/persistence"

// CompBand snapshot: level -> JSON band data (min/mid/max)
class CompBand extends Schema.Class<CompBand>("CompBand")({
  level: Schema.String,
  min: Schema.Finite,
  mid: Schema.Finite,
  max: Schema.Finite
}) {}

const program = Effect.gen(function*() {
  const store = yield* KeyValueStore.KeyValueStore

  // Basic string operations — store a serialised snapshot key
  yield* store.set("snapshot:cycle:2024:L4", '{"min":90000,"mid":110000,"max":130000}')
  const raw = yield* store.get("snapshot:cycle:2024:L4")
  // raw is string | undefined — not an Option
  if (raw !== undefined) {
    console.log("snapshot found:", raw)
  }

  // Initialise once, then update an existing key (single-writer example).
  yield* store.set("snapshot:cycle:2024:L4:version", "0")
  const version = yield* store.modify("snapshot:cycle:2024:L4:version", (v) =>
    String(Number(v) + 1)
  )
  // version is "1" here; a missing key would return undefined, not be created.

  // Namespaced sub-view — prefix all keys automatically
  const bandStore = KeyValueStore.prefix(store, "compband:")
  yield* bandStore.set("L5", '{"min":130000,"mid":155000,"max":180000}')
  // stored in the backing store as "compband:L5"

  // Schema-typed store — values encoded/decoded with Schema
  const typedStore = KeyValueStore.toSchemaStore(store, CompBand)
  yield* typedStore.set("L6", new CompBand({ level: "L6", min: 160000, mid: 195000, max: 230000 }))
  const band = yield* typedStore.get("L6") // Option<CompBand>
  if (Option.isSome(band)) {
    console.log("L6 mid-point:", band.value.mid)
  }
})

// Plug in the backend via a layer
const TestLayer = KeyValueStore.layerMemory  // in-process, volatile
// Production alternatives:
// KeyValueStore.layerFileSystem("./data")        — files on disk
// KeyValueStore.layerSql({ table: "kv_store" })  — SQL-backed (needs SqlClient)
// KeyValueStore.layerStorage(() => localStorage) — browser localStorage
```

### Available layers

- **layerMemory** — In-process `Map`. Zero deps, great for tests. Volatile — wiped on restart.
- **layerFileSystem(dir)** — One file per key under `dir` (keys are percent-encoded into file names, so they are only guaranteed distinct on a case-sensitive file system). Needs the `FileSystem` + `Path` services, supplied by a host layer such as `NodeServices.layer` from `@effect/platform-node`. `clear` removes the directory recursively — never point it at a directory shared with other data.
- **layerSql(options?)** — SQL table (default: `effect_key_value_store`). Works with any `SqlClient` dialect.
- **layerStorage(evaluate)** — Wraps a lazily-evaluated `Storage`-shaped object (browser `localStorage`, etc.).
- **Browser layers** — `BrowserKeyValueStore.layerLocalStorage`, `layerSessionStorage`, and `layerIndexedDb(options?)` from `@effect/platform-browser`. The IndexedDB layer needs the `IndexedDb` service and is the asynchronous alternative to the synchronous Web Storage layers; IndexedDB can be unavailable in private or restricted browsing contexts.

**Reach for it when** you need lightweight durable string storage without an opinionated client, or when building a custom persistence backend for higher-level modules.

## Persistence

`effect/persistence/Persistence` — unstable

Service that creates named stores for schema-typed `Exit` values keyed by `Persistable` requests. Where `KeyValueStore` speaks raw strings, `Persistence` speaks typed success/failure results — it serializes an `Exit<A, E>` using the request's success and error schemas, and deserializes it on the next read.

**Mental model.** A factory yielding scoped `PersistenceStore` instances. Each store is bound to a `storeId` (a namespace in the backing store) and an optional TTL function. Call `store.get(request)` to retrieve a previously persisted `Exit` (`undefined` on a miss); call `store.set(request, exit)` after computing a fresh result. The store handles encoding, decoding, and expiry.

```ts
import { Effect, Exit, Schema } from "effect"
import {
  Persistence,
  Persistable
} from "effect/persistence"

// A persistable request for fetching a CompBand by level
class BandNotFound extends Schema.TaggedError<BandNotFound>()("BandNotFound", {
  level: Schema.String
}) {}

class CompBand extends Schema.Class<CompBand>("CompBand")({
  level: Schema.String,
  min: Schema.Finite,
  mid: Schema.Finite,
  max: Schema.Finite
}) {}

class GetCompBand extends Persistable.Class<{
  payload: { level: string }
}>()("GetCompBand", {
  primaryKey: (payload) => `compband:${payload.level}`,
  success: CompBand,
  error: BandNotFound
}) {}

const program = Effect.gen(function*() {
  // Obtain the Persistence service and create a named store
  const persistence = yield* Persistence.Persistence
  const store = yield* persistence.make({
    storeId: "comp-bands",
    // Keep successful band data for 1 hour, errors for 5 minutes
    timeToLive: (exit, _req) =>
      Exit.isSuccess(exit) ? "1 hour" : "5 minutes"
  })

  const req = new GetCompBand({ level: "L5" })

  // Check for a persisted result. The operation is an Effect whose success
  // value is Exit | undefined and whose errors include persistence/decoding.
  const cached = yield* store.get(req)
  if (cached !== undefined) {
    // cached is Exit<CompBand, BandNotFound> — yield it to get the value or re-raise the error
    const band = yield* cached
    console.log("persisted band:", band)
    return
  }

  // Miss — fetch from HRIS and persist the result
  const band = new CompBand({ level: "L5", min: 130000, mid: 155000, max: 180000 })
  yield* store.set(req, Exit.succeed(band))
  console.log("fetched and stored:", band)
}).pipe(
  Effect.scoped // PersistenceStore is scoped — released when done
)

// Wire up: memory for dev, Redis or SQL for prod
const layers = Persistence.layerMemory
// Persistence.layerRedis       — needs Redis service
// Persistence.layerSql         — needs SqlClient
// Persistence.layerKvs         — needs KeyValueStore
```

### Backing layers

| Layer | Storage | Requires |
| --- | --- | --- |
| `Persistence.layerMemory` | Process-local map; entries expire by TTL and vanish on restart | — |
| `Persistence.layerKvs` | Any `KeyValueStore` backend | `KeyValueStore` |
| `Persistence.layerSql` | One shared `effect_persistence` table, rows partitioned by store id | `SqlClient` |
| `Persistence.layerSqlMultiTable` | One table per store id | `SqlClient` |
| `Persistence.layerRedis` | Redis keys with native expiry | `Redis.Redis` |

- **The TTL function decides whether anything is stored.** Omitting `timeToLive` keeps entries forever; returning a zero or negative duration for an `Exit` skips the write entirely, which is how you keep failures out of the store.
- **Stored bytes are a compatibility contract.** The `storeId`, the primary key, and the success / error schemas together define what a later release must still be able to read. After an incompatible schema change, `store.get` fails with `SchemaError` for the old entry instead of reporting a miss. Version the `storeId` (or the key) when the shape changes, and never build keys by concatenating ambiguous user strings.

> **Security note:** the SQL-backed stores bind `getMany` keys as query parameters rather than splicing them into the statement text. Keys come from `PrimaryKey.value(request)`, so this holds even when untrusted input reaches a `Persistable` primary key (including through `PersistedCache` or `RequestResolver.persisted`).

**Reach for it when** you want cross-restart memoization for expensive effectful computations and need the full typed `Exit` (success or failure) to survive a process restart.

## Persistable

`effect/persistence/Persistable` — unstable

The protocol connecting a request value to its persistence schemas. A `Persistable<A, E>` is a `PrimaryKey` (provides a stable string key) that also carries a success schema `A` and an error schema `E` at the type level. `Persistence` and `PersistedCache` use those schemas to encode and decode the stored `Exit` value.

**Mental model.** An extended `Request` that declares not just the result type but also how to serialize it. `Persistable.Class` is the idiomatic constructor — it combines `Request.Class` with schema attachment and primary-key derivation. The `primaryKey` callback receives the payload fields directly as its argument.

```ts
import { PrimaryKey, Schema } from "effect"
import { Persistable } from "effect/persistence"

class Employee extends Schema.Class<Employee>("Employee")({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String,
  level: Schema.String,
  baseSalary: Schema.Finite
}) {}

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {
  id: Schema.Int.check(Schema.isGreaterThan(0))
}) {}

// Persistable.Class combines: Request + PrimaryKey + serialization schemas.
// The primaryKey callback receives the payload fields directly.
class GetEmployee extends Persistable.Class<{
  payload: { id: number }
}>()("GetEmployee", {
  primaryKey: (payload) => `employee:${payload.id}`,
  success: Employee,
  error: EmployeeNotFound
}) {}

// Construct a request
const req = new GetEmployee({ id: 42 })
console.log(PrimaryKey.value(req)) // "employee:42"
console.log(req._tag)                                            // "GetEmployee"

// GetEmployee also extends Request.Request<Employee, EmployeeNotFound | ...>
// so it can be passed to Effect.request + a RequestResolver.
// Passing it to RequestResolver.persisted transparently adds cross-restart
// caching without changing the call site.
```

> **Tip:** A class generated by `Persistable.Class` is simultaneously a valid `Request` (can be passed to `Effect.request`), a valid `PrimaryKey` (has a stable string key), and a `Persistable` (carries schemas). This lets `RequestResolver.persisted` transparently wrap any resolver to add cross-restart caching without changing the call site.

`RequestResolver.persisted(resolver, { storeId, timeToLive?, staleWhileRevalidate? })` needs `Persistence` and a `Scope`. Stored results are loaded before the wrapped resolver runs, and only the misses are resolved and written back; an entry that `staleWhileRevalidate` marks stale is answered from the store *and* resolved again so the refreshed result replaces it. A failure of the wrapped resolver propagates to the waiting requests, while results that already completed are preserved. See [RequestResolver](../operations/caching-batching#requestresolver).

**Reach for it when** building a `PersistedCache` or using `RequestResolver.persisted` — schemas must be declared upfront so the persistence layer can serialize results.

## PersistedCache

`effect/persistence/PersistedCache` — unstable

A two-tier cache: in-process `Cache` in front of a durable `Persistence` store. On a miss, it checks the persistence store before running the lookup. A persistence-layer hit restores the result without calling the lookup effect — across process restarts.

**Mental model.** L1 = in-memory (fast, lost on restart). L2 = persistence store (slower, survives restarts). The lookup is only called on a true L2 miss. Results are written to both layers simultaneously. Invalidation clears both.

```ts
import { Effect, Schema } from "effect"
import {
  Persistable,
  PersistedCache,
  Persistence
} from "effect/persistence"

// Durable cache for employee compensation lookups —
// avoids hammering the HRIS on every org-chart render.

class Employee extends Schema.Class<Employee>("Employee")({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String,
  level: Schema.String,
  baseSalary: Schema.Finite
}) {}

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {
  id: Schema.Int.check(Schema.isGreaterThan(0))
}) {}

class GetEmployee extends Persistable.Class<{
  payload: { id: number }
}>()("GetEmployee", {
  primaryKey: (payload) => `employee:${payload.id}`,
  success: Employee,
  error: EmployeeNotFound
}) {}

// Simulate an HRIS fetch
declare const fetchEmployeeFromHris: (id: number) => Effect.Effect<Employee, EmployeeNotFound>

const program = Effect.scoped(
  Effect.gen(function*() {
    const empCache = yield* PersistedCache.make(
      // Lookup: called only on a true L1+L2 miss
      (req: GetEmployee) => fetchEmployeeFromHris(req.id),
      {
        storeId: "employees",
        // timeToLive receives (exit, request) — keep successes 1 hour, errors 5 min
        timeToLive: (exit, _req) =>
          exit._tag === "Success" ? "1 hour" : "5 minutes",
        inMemoryCapacity: 512,
        inMemoryTTL: () => "5 minutes"
      }
    )

    // First call: L1 miss → L2 miss → calls HRIS
    const emp1 = yield* empCache.get(new GetEmployee({ id: 101 }))
    // Same process: L1 hit — no HRIS call
    const emp2 = yield* empCache.get(new GetEmployee({ id: 101 }))
    // After restart: L1 cold, L2 hit — still no HRIS call
    console.log(emp1.name, emp2.name)

    // Invalidate both tiers (e.g. after a salary change)
    yield* empCache.invalidate(new GetEmployee({ id: 101 }))
  })
)

// Provide Persistence — swap for Redis/SQL in production
const layers = Persistence.layerMemory
```

- **Failures are cached too.** The whole `Exit` is persisted, so a failed lookup is replayed — across restarts and across processes — until its TTL expires. That includes defects: a lookup function that *throws synchronously* is captured and persisted the same way. Return `Duration.zero` from `timeToLive` for the exits you do not want stored, or give failures a short TTL as above.
- **Defaults:** `inMemoryCapacity` is `1024` and `inMemoryTTL` is 10 seconds, so without overrides most reads after the first 10 seconds go to the persistence store rather than memory.
- **An incompatible stored entry fails the read.** After a success-schema change, `get` fails with `SchemaError` without running the lookup; `invalidate` the key or move to a new `storeId`.
- **It is a cache, not a record.** Do not read business state back out of it, and do not rely on it to suppress duplicate work across a fleet.

**Reach for it when** you want `Cache` semantics with durability — expensive lookups that should survive restarts and be shared across multiple worker processes connected to the same backing store.

## PersistedQueue

`effect/persistence/PersistedQueue` — unstable

A durable work queue backed by persistent storage. Items are schema-encoded before enqueueing; workers call `queue.take(handler)` to claim and process one item at a time. If the handler succeeds the item is acknowledged as processed; if it fails the item becomes visible again after a delay chosen by the queue's retry schedule, until `maxAttempts` is exhausted and the item is **dead-lettered** (marked failed and kept). Restarts replay unacknowledged items automatically.

**Mental model.** Outbox-style queue — producer writes the intent, consumer processes idempotently. Useful for any work that must not be lost if the process dies mid-flight. Delivery is at-least-once, so the handler's side effect needs its own idempotency key.

The retry policy belongs to the **queue**, not to an individual `take` call:

- `maxAttempts` defaults to `10`. An attempt is counted **when the item is claimed**, so `attempts` in the handler metadata is 1-based ("this is attempt 3") and a handler crash that kills the process still consumes an attempt.
- `retrySchedule` defaults to an exponential delay starting at 1 second and capped at 5 minutes. Its input is the attempt number, and the persisted attempt count *is* the schedule state — the schedule is replayed up to the current attempt on each failure, so delays keep progressing even when consecutive retries run in different processes. Attempt-driven schedules are therefore exact; a wall-clock schedule such as `Schedule.upTo` bounds the *summed* delays, not real elapsed time.
- An item that no longer decodes with the queue's schema is dead-lettered immediately and the next item is taken, so a schema change can never wedge the consumer — but it also means an incompatible schema change silently diverts old items. Evolve the item schema compatibly.

```ts
import { Effect, Layer, Schedule, Schema } from "effect"
import { PersistedQueue } from "effect/persistence"

// Each item in the queue is a pending raise approval request.
const RaiseApprovalSchema = Schema.Struct({
  employeeId: Schema.Int.check(Schema.isGreaterThan(0)),
  managerId: Schema.Int.check(Schema.isGreaterThan(0)),
  currentSalary: Schema.Finite,
  proposedSalary: Schema.Finite,
  meritCycleId: Schema.String
})
type RaiseApproval = Schema.Schema.Type<typeof RaiseApprovalSchema>

const program = Effect.gen(function*() {
  // Obtain a named queue via PersistedQueueFactory (provided by PersistedQueue.layer).
  // The retry policy is part of the queue definition.
  const queue = yield* PersistedQueue.make({
    name: "raise-approvals",
    schema: RaiseApprovalSchema,
    maxAttempts: 5,
    retrySchedule: Schedule.exponential("2 seconds")
  })

  // Producer: enqueue a raise recommendation (returns the assigned item id)
  const itemId = yield* queue.offer({
    employeeId: 42,
    managerId: 7,
    currentSalary: 120000,
    proposedSalary: 132000,
    meritCycleId: "cycle:2024"
  })
  console.log("enqueued raise approval:", itemId)

  // Idempotent offer: pass a custom id to avoid double-queueing on retry
  yield* queue.offer(
    { employeeId: 42, managerId: 7, currentSalary: 120000, proposedSalary: 132000, meritCycleId: "cycle:2024" },
    { id: `raise:${42}:cycle:2024` }
  )

  // Consumer: process one approval at a time.
  // On success → acknowledged. On failure → retried on the queue's schedule,
  // then dead-lettered once maxAttempts is reached.
  yield* queue.take((approval: RaiseApproval, { id, attempts }) =>
    Effect.log(
      `[attempt ${attempts}] processing raise for employee ${approval.employeeId} (item ${id})`
    )
  )
})

// In-memory store: volatile, great for tests.
// layer provides PersistedQueueFactory from PersistedQueueStore.
const StoreLayer = PersistedQueue.layerStoreMemory
const layers = Layer.mergeAll(
  PersistedQueue.layer,
  // Retention: run in ONE instance of a deployment, not on every worker.
  PersistedQueue.layerCleanup({ interval: "1 hour", timeToLive: "30 days" })
).pipe(Layer.provide(StoreLayer))
// Production stores:
// PersistedQueue.layerStoreRedis(redisConfig)
// PersistedQueue.layerStoreSql(sqlConfig)
```

> **Tip:** Pass a custom `id` to `queue.offer(value, { id })` and the queue will silently skip re-enqueueing if that id is already present. This gives idempotent producers — safe to call on retry without double-queueing. De-duplication **outlives completion**: the id keeps suppressing duplicates until `layerCleanup` removes the completed element (`timeToLive`, default 30 days), so size that window to your longest producer replay.

`PersistedQueue.layerCleanup` deletes completed elements after `timeToLive`. Failed elements are the dead-letter record and are kept **forever** unless you set `failedTimeToLive` — monitor and drain them deliberately. The SQL store creates and upgrades its tables through versioned migrations.

The SQL and Redis stores claim an item with a per-worker lock that is refreshed while the handler runs (`lockRefreshInterval`, default 30 seconds) and expires after `lockExpiration` (default 2 minutes for SQL, 90 seconds for Redis); both poll every second by default. **Interrupting the handler releases the item without consuming the attempt**, so a graceful shutdown does not push work toward the dead-letter state. A hard kill cannot run that release: the attempt stays counted and the item becomes claimable again once its lock expires.

### Using the SQL store as a transactional outbox

**`PersistedQueue.layerStoreSql()` built on the same `SqlClient` as your repositories makes `queue.offer` part of your transaction.** The offer is a single insert on that client, so inside `sql.withTransaction` it commits or rolls back with the domain write — the [transactional outbox](../interfaces/sql#external-effects-after-commit-outbox) without a hand-written relay.

```ts
import { Effect, Schema } from "effect"
import { PersistedQueue } from "effect/persistence"
import { SqlClient } from "effect/sql"

const RaiseApproved = Schema.Struct({
  employeeId: Schema.Int,
  cycle: Schema.String,
  newSalary: Schema.Int
})

const approveRaise = Effect.fn("approveRaise")(
  function*(employeeId: number, cycle: string, newSalary: number) {
    const sql = yield* SqlClient.SqlClient
    const events = yield* PersistedQueue.make({ name: "raise-approved", schema: RaiseApproved })
    yield* sql.withTransaction(
      Effect.gen(function*() {
        yield* sql`update employees set base_salary = ${newSalary} where id = ${employeeId}`
        // Same client, same transaction: a rollback removes the queued event as well.
        // The id is derived from the business fact, so a replayed request cannot enqueue it twice.
        yield* events.offer({ employeeId, cycle, newSalary }, { id: `raise-approved:${cycle}:${employeeId}` })
      })
    )
  }
)
```

The memory and Redis stores share no transaction with your database: a crash between the domain commit and the `offer` loses the item, and an `offer` placed before the commit can announce a change that rolls back. With those stores, write the intent row yourself — see [Recipe: A Transactional Write with an Outbox](../recipes/transactional-write-with-outbox).

### Failure windows and honest guarantees

Start from an invariant ("every accepted raise reaches *delivered* or *dead-letter*") and mark the crash windows on the path `input → durable state → claim → external effect → result persisted → acknowledged`.

| Outcome of an external call | What is known | What to do |
| --- | --- | --- |
| Failed **before** dispatch | Nothing reached the sink | Retry freely. |
| **Known** failure after dispatch | The sink rejected it | Retry only if the rejection is transient; otherwise dead-letter. |
| **Unknown** — timeout, interruption, or crash after dispatch | The sink may have applied it | Never replay a mutation blindly. Reconcile through the sink's idempotency key or status API, or park the item for operator repair. |

- **Acknowledging after the effect means at-least-once.** A crash between "the sink accepted" and "the item is acknowledged" re-runs the handler, so the side effect needs an idempotency key derived from the item id — not one generated per attempt.
- **A lock is a lease, not a fence.** A worker that stalls longer than `lockExpiration` loses its claim while it is still running, and a second worker starts the same item. Nothing in these modules supplies a fencing token: when a stale owner must not commit, the *sink* has to reject it — a monotonic token, a compare-and-set, or a uniqueness constraint that your protocol creates, persists, and checks.
- **Process death skips finalizers.** Restart behavior must never depend on a release action having run; graceful shutdown should acknowledge only outcomes that are already committed.
- **Keep defects and interruption out of business retry.** A defect is a bug to fix, and interruption is cancellation — neither is evidence that the sink is unavailable.
- **Label each guarantee by its evidence:** proved by the library (attempt counting, dead-lettering), dependent on the adapter (Redis persistence settings, SQL isolation), dependent on the deployment (one cleanup instance, clock skew), or design guidance you must implement (idempotent sinks, fencing).

### Recovery testing and operations

Test recovery in three separate lanes: a deterministic state machine on `layerStoreMemory` with `TestClock`; the real adapter with a kill-and-restart of the worker; and the built artifact. Cover the crash matrix — before the effect · after the sink accepted but before the result is stored · after the result but before the acknowledgement · during a retry delay · after lock expiry with the old owner paused · store outage · mixed old/new item schemas · a corrupt payload · restore from backup. Operator actions (inspect, cancel, redrive, release from dead-letter) change business outcomes, so authorize and audit them, and rehearse a restore rather than trusting that a backup exists. Workflows and cluster delivery add their own replay rules — see [the durability and distribution ladder](../deep-dives/durability-and-distribution-ladder).

**Reach for it when** you need guaranteed-at-least-once delivery of background jobs that must survive process restarts and can be retried on failure.

## RateLimiter

`effect/persistence/RateLimiter` — unstable

A persistent token-bucket/fixed-window rate limiter. Stores counters in a shared backing store (memory or Redis), so limits apply across fibers and—with Redis—across multiple processes or pods.

**Mental model.** Each call to `limiter.consume(options)` atomically updates limiter state: fixed-window increments usage, while token-bucket consumes available tokens. The returned `ConsumeResult` carries `delay`, `remaining`, `limit`, and `resetAfter`. The `onExceeded` option controls whether to fail immediately (`"fail"`) or return a delay to wait (`"delay"`). Use `makeWithRateLimiter` to wrap effects automatically, or `sleep(limiter, options)` to consume and sleep until the limiter allows the next call.

```ts
import { Duration, Effect, Layer } from "effect"
import { RateLimiter } from "effect/persistence"

// Cap calls to the HRIS and payroll API to respect their published quotas.
const program = Effect.gen(function*() {
  // Low-level: consume tokens directly
  const limiter = yield* RateLimiter.make
  const result = yield* limiter.consume({
    key: "hris-api:read",
    limit: 200,
    window: "1 minute",
    algorithm: "fixed-window",
    onExceeded: "fail",  // throws RateLimiterError when exceeded
    tokens: 1
  })
  console.log(`remaining HRIS quota: ${result.remaining}, resets in: ${result.resetAfter}`)

  // High-level wrapper: automatically sleeps when limit is exceeded ("delay" strategy)
  const withLimiter = yield* RateLimiter.makeWithRateLimiter
  yield* Effect.log("submitting payroll change").pipe(
    withLimiter({
      key: "payroll-api:write",
      limit: 50,
      window: "1 minute",
      algorithm: "token-bucket",
      onExceeded: "delay"
    })
  )

  // Sleep helper: consume a token and sleep for the delay before returning
  yield* RateLimiter.sleep(limiter, {
    key: "hris-api:read",
    limit: 200,
    window: "1 minute",
    algorithm: "fixed-window"
  })
  // Continues only after the HRIS quota allows the next call

  // Adaptive lane: honor observed 429/Retry-After feedback, then learn a rate.
  const adaptive = yield* limiter.adaptiveConsume({
    key: "payroll-api:adaptive",
    tokens: 1,
    fallbackLimit: 50,
    fallbackWindow: Duration.minutes(1)
  })
  yield* Effect.sleep(adaptive.delay)

  const response = { status: 429, retryAfter: Duration.seconds(30) }
  yield* limiter.adaptiveFeedback({
    key: "payroll-api:adaptive",
    epoch: adaptive.epoch, // correlate feedback with the state used for this request
    tokens: 1,
    status: response.status,
    retryAfter: response.retryAfter
  })
})

// Provide the store layer — RateLimiter.make requires RateLimiterStore
const layers = RateLimiter.layer.pipe(
  Layer.provide(RateLimiter.layerStoreMemory) // in-process counter (not cross-process)
)
// For cross-process:
// RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreRedis(redisConfig)))
```

### Algorithms

- **fixed-window** — Count requests within a time bucket. Cheap to compute; can allow 2x the limit at window boundaries if producers are synchronized. Best for loose API quota enforcement.
- **token-bucket** — Tokens refill continuously over the window. Smoother than fixed-window; prevents burst spikes at boundaries. Better for tight throughput control against write quotas.

Adaptive limiting is a separate feedback API, not another `algorithm` string. Call `adaptiveConsume` before the request, retain its `epoch`, then report the response with `adaptiveFeedback`. The state progresses through `inactive`, `cooldown`, `learning`, and `learned`: a `429` with `Retry-After` starts or extends cooldown, later traffic measures an accepted rate, and learned state schedules future requests accordingly. The in-memory store coordinates only one process; use the Redis store when this learned state must be shared by several workers.

> **Note:** Writing a custom `RateLimiterStore`? `tokenBucket` must return `[remaining, elapsedMillis]` from **one atomic operation** — the tokens left after consuming, and the time since the current refill interval started (at least `0`, less than the refill interval). The limiter derives `delay` and `resetAfter` from both; returning `[remaining, 0]` reproduces the old timing error. Token-bucket timing follows whole-token refill boundaries, and fixed-window `resetAfter` reports the exact remaining window under `onExceeded: "delay"` instead of rounding up to a full window.

**Reach for it when** you need rate limits that work across multiple fibers or processes — protecting external APIs or enforcing per-tenant quotas in a multi-worker deployment.

## Redis

`effect/persistence/Redis` — unstable

A thin service wrapper around a Redis client used internally by the other persistence modules. Provides three primitives: `send` for raw Redis commands, `subscribe(channel)` for a scoped pub/sub subscription delivered as a `Queue.Dequeue<RedisMessage, RedisError>`, and `eval` for executing typed Lua scripts via `EVALSHA` (with automatic script loading and SHA caching via `SCRIPT LOAD`).

**Mental model.** The barrel exports a `Redis` module namespace; the service tag inside it is `Redis.Redis`. Prefer a ready-made platform layer: `NodeRedis.layer(options)` / `NodeRedis.layerConfig(...)` from `@effect/platform-node` (backed by `node-redis`), or the `BunRedis` / `DenoRedis` equivalents. They acquire a scoped client, close it when the layer scope ends, and also expose the raw client through a `NodeRedis` service. To bring your own client instead, wrap it with `Redis.make({ send, subscribe })` — **both** operations are required. Every module in this chapter with a `layerXxxRedis` variant requires `Redis.Redis`. Scripts are described with `Redis.script(paramsToArgs, { lua, numberOfKeys })` — a two-argument form where the first argument maps typed parameters to Redis argument arrays.

```ts
import { Effect, Layer } from "effect"
import { Redis } from "effect/persistence"

// Imagine `redisClient` comes from ioredis or node-redis.
declare const redisClient: {
  call(command: string, ...args: string[]): Promise<unknown>
  // Registers a listener and resolves to an unsubscribe function.
  subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>>
}

// Redis.make returns an Effect — provide it with Layer.effect
const RedisLayer = Layer.effect(
  Redis.Redis,
  Redis.make({
    send: <A = unknown>(command: string, ...args: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: () => redisClient.call(command, ...args) as Promise<A>,
        catch: (e) => new Redis.RedisError({ cause: e })
      }),
    // Scoped subscription: register the listener, unsubscribe when the scope closes,
    // and return an Effect that fails if the subscriber connection later breaks.
    subscribe: (channel, onMessage) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => redisClient.subscribe(channel, (message) => onMessage({ channel, message })),
          catch: (e) => new Redis.RedisError({ cause: e })
        }),
        (unsubscribe) => Effect.promise(() => unsubscribe())
      ).pipe(Effect.as(Effect.never))
  })
)

// With the Redis layer provided, the persistence modules pick it up:
// Persistence.layerRedis
// RateLimiter.layerStoreRedis(config)
// PersistedQueue.layerStoreRedis(config)

// Lua scripting: Redis.script takes (paramsToArgs, { lua, numberOfKeys })
// Use .withReturnType<R>() to type the return value.
const atomicIncrScript = Redis.script(
  // First arg: maps typed params to the Redis args array
  (key: string, amount: string) => [key, amount],
  {
    lua: `
      local current = redis.call('GET', KEYS[1])
      local next = (tonumber(current) or 0) + tonumber(ARGV[1])
      redis.call('SET', KEYS[1], tostring(next))
      return next
    `,
    numberOfKeys: 1  // constant — or pass a function (key, amount) => number
  }
).withReturnType<number>()

// Example: atomically increment a per-department merit-budget draw-down counter
const program = Effect.gen(function*() {
  const redis = yield* Redis.Redis
  const evalScript = redis.eval(atomicIncrScript)

  // First call: SCRIPT LOAD → EVALSHA. Subsequent calls: EVALSHA directly.
  // On NOSCRIPT error (Redis restart): automatically reloads and retries.
  const newTotal = yield* evalScript("budget:dept:engineering:drawn", "5000")
  console.log("total drawn this cycle:", newTotal)
})
```

`redis.subscribe(channel)` lives for the current scope and shuts its queue down when that scope closes. Reconnection is host-specific: the Node and Deno subscribers reconnect and re-subscribe after an interruption, so messages published during recovery appear as **delivery gaps**; the Bun subscriber does not reconnect — a dropped connection fails the dequeue and the caller must subscribe again. Redis pub/sub is fire-and-forget either way, so treat it as a wake-up signal and keep the source of truth in a durable store.

> **Note:** `Redis.make` creates an internal `Cache` of loaded script SHAs. The first call to `redis.eval(script)(...)` issues `SCRIPT LOAD` and caches the SHA. Subsequent calls use `EVALSHA` directly. If Redis restarts and loses the script, the module detects the `NOSCRIPT` error and reloads automatically.

**Reach for it when** you want Redis backing for any persistence module, or when you need to run Lua scripts with automatic SHA caching and error handling.
