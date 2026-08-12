# Persistence

The stack has three levels. `KeyValueStore` supplies raw string/binary storage and swappable backends; `Persistence` stores schema-typed request `Exit` values in named stores; `PersistedCache` and `PersistedQueue` add cache and queue behavior on top. Browser, SQL, Redis, and filesystem modules provide concrete storage layers without changing the typed interface.

> **Warning:** All modules in this chapter live under `effect/unstable/persistence/...`. Expect API changes between minor versions. Pin your Effect version and read the changelog before upgrading.

## KeyValueStore

`effect/unstable/persistence/KeyValueStore` — unstable

Effectful key-value store service for string and binary (`Uint8Array`) values. The lowest layer of the persistence stack — a uniform interface that `Persistence` and `PersistedCache` sit on top of. Swap the backend by swapping the layer.

**Mental model.** A service with `get`, `set`, `remove`, `has`, `size`, `clear`, and `modify`. `get` returns `string | undefined` (not an `Option`) — `undefined` on a miss. For typed structured data, use `KeyValueStore.toSchemaStore` to get a schema-aware wrapper whose `get` returns `Option<A>`.

```ts
import { Effect, Option, Schema } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

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

  // Atomic modify — append a version tag to a snapshot record
  yield* store.modify("snapshot:cycle:2024:L4:version", (v) =>
    String(Number(v ?? "0") + 1)
  )
  // modify returns the resulting value (string | undefined)

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
- **layerFileSystem(dir)** — One file per key under `dir`. Needs `FileSystem` + `Path` services from `@effect/platform`.
- **layerSql(options?)** — SQL table (default: `effect_key_value_store`). Works with any `SqlClient` dialect.
- **layerStorage(evaluate)** — Wraps a lazily-evaluated `Storage`-shaped object (browser `localStorage`, etc.).

**Reach for it when** you need lightweight durable string storage without an opinionated client, or when building a custom persistence backend for higher-level modules.

## Persistence

`effect/unstable/persistence/Persistence` — unstable

Service that creates named stores for schema-typed `Exit` values keyed by `Persistable` requests. Where `KeyValueStore` speaks raw strings, `Persistence` speaks typed success/failure results — it serializes an `Exit<A, E>` using the request's success and error schemas, and deserializes it on the next read.

**Mental model.** A factory yielding scoped `PersistenceStore` instances. Each store is bound to a `storeId` (a namespace in the backing store) and an optional TTL function. Call `store.get(request)` to retrieve a previously persisted `Exit` (`undefined` on a miss); call `store.set(request, exit)` after computing a fresh result. The store handles encoding, decoding, and expiry.

```ts
import { Effect, Exit, Schema } from "effect"
import {
  Persistence,
  Persistable
} from "effect/unstable/persistence"

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

**Reach for it when** you want cross-restart memoization for expensive effectful computations and need the full typed `Exit` (success or failure) to survive a process restart.

## Persistable

`effect/unstable/persistence/Persistable` — unstable

The protocol connecting a request value to its persistence schemas. A `Persistable<A, E>` is a `PrimaryKey` (provides a stable string key) that also carries a success schema `A` and an error schema `E` at the type level. `Persistence` and `PersistedCache` use those schemas to encode and decode the stored `Exit` value.

**Mental model.** An extended `Request` that declares not just the result type but also how to serialize it. `Persistable.Class` is the idiomatic constructor — it combines `Request.Class` with schema attachment and primary-key derivation. The `primaryKey` callback receives the payload fields directly as its argument.

```ts
import { PrimaryKey, Schema } from "effect"
import { Persistable } from "effect/unstable/persistence"

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

**Reach for it when** building a `PersistedCache` or using `RequestResolver.persisted` — schemas must be declared upfront so the persistence layer can serialize results.

## PersistedCache

`effect/unstable/persistence/PersistedCache` — unstable

A two-tier cache: in-process `Cache` in front of a durable `Persistence` store. On a miss, it checks the persistence store before running the lookup. A persistence-layer hit restores the result without calling the lookup effect — across process restarts.

**Mental model.** L1 = in-memory (fast, lost on restart). L2 = persistence store (slower, survives restarts). The lookup is only called on a true L2 miss. Results are written to both layers simultaneously. Invalidation clears both.

```ts
import { Effect, Schema } from "effect"
import {
  Persistable,
  PersistedCache,
  Persistence
} from "effect/unstable/persistence"

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

**Reach for it when** you want `Cache` semantics with durability — expensive lookups that should survive restarts and be shared across multiple worker processes connected to the same backing store.

## PersistedQueue

`effect/unstable/persistence/PersistedQueue` — unstable

A durable FIFO work queue backed by persistent storage. Items are schema-encoded before enqueueing; workers call `queue.take(handler)` to process one item at a time. On handler failure, the item is retried (up to a configurable maximum); on success, the item is acknowledged and removed. Restarts replay unacknowledged items automatically.

**Mental model.** Outbox-style queue — producer writes the intent, consumer processes idempotently. Useful for any work that must not be lost if the process dies mid-flight.

```ts
import { Effect, Layer, Schema } from "effect"
import { PersistedQueue } from "effect/unstable/persistence"

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
  // Obtain a named queue via PersistedQueueFactory (provided by PersistedQueue.layer)
  const queue = yield* PersistedQueue.make({
    name: "raise-approvals",
    schema: RaiseApprovalSchema
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
  // On success → acknowledged and removed.
  // On failure → retried; defaults to max 10 attempts.
  yield* queue.take(
    (approval: RaiseApproval, { id, attempts }) =>
      Effect.log(
        `[attempt ${attempts}] processing raise for employee ${approval.employeeId} (item ${id})`
      ),
    { maxAttempts: 5 }
  )
})

// In-memory store: volatile, great for tests.
// layer provides PersistedQueueFactory from PersistedQueueStore.
const layers = PersistedQueue.layer.pipe(
  Layer.provide(PersistedQueue.layerStoreMemory)
)
// Production:
// PersistedQueue.layer.pipe(Layer.provide(PersistedQueue.layerStoreRedis(redisConfig)))
// PersistedQueue.layer.pipe(Layer.provide(PersistedQueue.layerStoreSql(sqlConfig)))
```

> **Tip:** Pass a custom `id` to `queue.offer(value, { id })` and the queue will silently skip re-enqueueing if that id is already present. This gives idempotent producers — safe to call on retry without double-queueing.

**Reach for it when** you need guaranteed-at-least-once delivery of background jobs that must survive process restarts and can be retried on failure.

## RateLimiter

`effect/unstable/persistence/RateLimiter` — unstable

A persistent token-bucket/fixed-window rate limiter. Stores counters in a shared backing store (memory or Redis), so limits apply across fibers and—with Redis—across multiple processes or pods.

**Mental model.** Each call to `limiter.consume(options)` atomically updates limiter state: fixed-window increments usage, while token-bucket consumes available tokens. The returned `ConsumeResult` carries `delay`, `remaining`, `limit`, and `resetAfter`. The `onExceeded` option controls whether to fail immediately (`"fail"`) or return a delay to wait (`"delay"`). Use `makeWithRateLimiter` to wrap effects automatically, or `sleep(limiter, options)` to consume and sleep until the limiter allows the next call.

```ts
import { Duration, Effect, Layer } from "effect"
import { RateLimiter } from "effect/unstable/persistence"

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

**Reach for it when** you need rate limits that work across multiple fibers or processes — protecting external APIs or enforcing per-tenant quotas in a multi-worker deployment.

## Redis

`effect/unstable/persistence/Redis` — unstable

A thin service wrapper around a Redis command sender used internally by the other persistence modules. Provides two primitives: `send` for raw Redis commands, and `eval` for executing typed Lua scripts via `EVALSHA` (with automatic script loading and SHA caching via `SCRIPT LOAD`).

**Mental model.** The barrel exports a `Redis` module namespace; the service tag inside it is `Redis.Redis`. Bring your own Redis client (e.g. `ioredis`, `node-redis`) and wrap its command method with `Redis.make({ send })`. Every module in this chapter with a `layerXxxRedis` variant requires `Redis.Redis`. Scripts are described with `Redis.script(paramsToArgs, { lua, numberOfKeys })` — a two-argument form where the first argument maps typed parameters to Redis argument arrays.

```ts
import { Effect, Layer } from "effect"
import { Redis } from "effect/unstable/persistence"

// Imagine `redisClient` comes from ioredis or node-redis.
declare const redisClient: {
  call(command: string, ...args: string[]): Promise<unknown>
}

// Redis.make returns an Effect — provide it with Layer.effect
const RedisLayer = Layer.effect(
  Redis.Redis,
  Redis.make({
    send: <A = unknown>(command: string, ...args: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: () => redisClient.call(command, ...args) as Promise<A>,
        catch: (e) => new Redis.RedisError({ cause: e })
      })
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

> **Note:** `Redis.make` creates an internal `Cache` of loaded script SHAs. The first call to `redis.eval(script)(...)` issues `SCRIPT LOAD` and caches the SHA. Subsequent calls use `EVALSHA` directly. If Redis restarts and loses the script, the module detects the `NOSCRIPT` error and reloads automatically.

**Reach for it when** you want Redis backing for any persistence module, or when you need to run Lua scripts with automatic SHA caching and error handling.
