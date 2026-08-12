# Caching & Batching

Caching avoids repeating the same lookup result; batching combines many logically independent requests into fewer physical calls. `Cache` stores both successful and failed lookup `Exit` values, while `ScopedCache` owns resource lifetimes. `Request` and `RequestResolver` describe data fetching so Effect can deduplicate and batch it safely.

> **Official example:** The release-matched [`ai-docs` batching example](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/05_batching) builds a batched `RequestResolver`.

## Cache

`effect/Cache` — stable

Effectful memoization table with bounded capacity and optional TTL. A lookup effect is provided at construction; the cache handles concurrent requests, LRU eviction, and TTL expiry. Two fibers racing for the same missing key share one in-flight lookup.

**Mental model.** Bounded `Map<Key, Deferred<A, E>>` that deduplicates concurrent misses. The first fiber to request a missing key starts the lookup and parks a deferred; subsequent fibers await that same deferred. On completion its full `Exit` is stored, so failures are cached too. Reading an existing entry—including a pending or failed one—moves it to the end of the map, and capacity pressure evicts the least recently accessed entry.

```ts
import { Cache, Effect } from "effect"

// CompBand describes the salary range for a job level (e.g. L3, L4, L5).
// Fetching from the HRIS is slow; cache bands for 30 minutes so every
// render of the org chart hits memory instead of the API.
interface CompBand {
  readonly level: string
  readonly minSalary: number
  readonly midSalary: number
  readonly maxSalary: number
}

const fetchCompBandFromHris = (level: string): Effect.Effect<CompBand, string> =>
  Effect.suspend(() => {
    const bands = new Map<string, CompBand>([
      ["L3", { level: "L3", minSalary: 90_000, midSalary: 105_000, maxSalary: 120_000 }],
      ["L4", { level: "L4", minSalary: 120_000, midSalary: 140_000, maxSalary: 160_000 }],
      ["L5", { level: "L5", minSalary: 160_000, midSalary: 185_000, maxSalary: 210_000 }]
    ])
    const band = bands.get(level)
    return band
      ? Effect.succeed(band)
      : Effect.fail(`No comp band found for level ${level}`)
  })

const program = Effect.gen(function*() {
  const compBandCache = yield* Cache.make<string, CompBand, string>({
    capacity: 50,           // at most 50 levels cached at once
    timeToLive: "30 minutes", // bands re-fetched after 30 min
    lookup: fetchCompBandFromHris
  })

  // First call hits the HRIS; second call is instant (cache hit)
  const l4Band = yield* Cache.get(compBandCache, "L4")
  const l4Again = yield* Cache.get(compBandCache, "L4") // no HRIS hit
  console.log(l4Band, l4Again)

  // Force a fresh HRIS lookup after a comp cycle update
  yield* Cache.refresh(compBandCache, "L4")

  // Invalidate a single level after an out-of-cycle band change
  yield* Cache.invalidate(compBandCache, "L5")

  // Inspect cache state
  const size = yield* Cache.size(compBandCache)
  const keys = yield* Cache.keys(compBandCache)
  console.log(`${size} bands cached, levels:`, [...keys])
})
```

### Key API surface

| Function | What it does |
| --- | --- |
| `Cache.make({ lookup, capacity, timeToLive? })` | Create a cache. `timeToLive` is a `Duration.Input` string or millis. |
| `Cache.makeWith(lookup, { capacity, timeToLive: (exit, key) => Duration })` | Dynamic TTL — vary per-key or per-error. |
| `Cache.get(cache, key)` | Get or compute. Concurrent misses share one lookup. |
| `Cache.getOption(cache, key)` | Read without starting a lookup. Returns `None` if absent/expired, awaits an existing pending entry, returns `Some<A>` on success, and fails with the cached lookup error on failure. |
| `Cache.refresh(cache, key)` | Force and await a new lookup. An existing entry remains readable by other fibers until it completes, then is replaced. Unlike concurrent `get` misses, concurrent `refresh` calls are not deduplicated. |
| `Cache.invalidate(cache, key)` | Remove one entry. |
| `Cache.invalidateAll(cache)` | Clear everything. |
| `Cache.set(cache, key, value)` | Manually populate an entry (useful for seeding). |
| `Cache.has(cache, key)` | Check for an unexpired entry without lookup. |

> **Tip:** By default, services needed by `lookup` are captured at construction time. Pass `requireServicesAt: "lookup"` to instead capture them at call time — useful when the lookup needs request-scoped services that weren't available when the cache was built.

**When to use:** effectful computation (HTTP call, expensive decode) hit by many callers with the same keys, where you want deduplication of in-flight requests plus time-bounded staleness.

## ScopedCache

`effect/ScopedCache` — stable

`Cache` variant for entries that own resources. Each cached value gets its own `Scope`; on eviction, invalidation, or TTL expiry, that scope closes and all acquired resources are released. The cache itself lives inside an outer scope; closing it tears down every remaining entry.

**Mental model.** One live resource per key (e.g., a connection per tenant shard) with automatic teardown when a key falls out of use. The lookup receives `Scope.Scope` in its environment, so `Effect.acquireRelease` works directly inside it — the cache wires up the lifetimes.

```ts
import { ScopedCache, Effect, Scope } from "effect"

// A live streaming connection to a payroll-system tenant shard.
interface PayrollShardConn {
  readonly query: (sql: string) => Effect.Effect<unknown[]>
  readonly close: Effect.Effect<void>
}

const openPayrollConn = (
  shardId: string
): Effect.Effect<PayrollShardConn, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const conn: PayrollShardConn = {
        query: (sql) => Effect.succeed([{ shardId, sql }]),
        close: Effect.sync(() => console.log(`closing payroll shard ${shardId}`))
      }
      console.log(`opened payroll shard ${shardId}`)
      return conn
    }),
    (conn) => conn.close
  )

const program = Effect.scoped(
  Effect.gen(function*() {
    // ScopedCache itself needs a Scope — it's scoped!
    const cache = yield* ScopedCache.make<string, PayrollShardConn>({
      capacity: 10,
      timeToLive: "5 minutes",
      lookup: (shardId) => openPayrollConn(shardId)
    })

    // Connection is opened lazily and kept alive while the entry exists
    const conn = yield* ScopedCache.get(cache, "us-west-2")
    const rows = yield* conn.query("SELECT employee_id, gross_pay FROM payroll_run")
    console.log(rows)

    // Invalidating the shard closes its scope → conn.close runs
    yield* ScopedCache.invalidate(cache, "us-west-2")
  })
)
// When the outer Effect.scoped closes, any remaining shard connections are released.
```

> **Warning:** If your value has no resources to release, use `Cache` instead. `ScopedCache` runs scope machinery on every entry. Reach for it only when your lookup calls `Effect.acquireRelease`, opens a socket, or otherwise needs cleanup on eviction.

**When to use:** the cached value holds a resource (live connection, file handle, in-process child) that must be released precisely on expiry or eviction.

## Request

`effect/Request` — stable

Typed, data-only description of one thing to fetch from a data source. A `Request<A, E>` is not an effect — it is a plain object carrying the input fields a resolver needs, plus phantom types for success (`A`) and error (`E`). Used by `RequestResolver` and `Effect.request` for batching and deduplication.

**Mental model.** A record in a to-do list processed in bulk by a resolver. Multiple fibers each add their own request; when the resolver runs it receives the whole batch and completes each entry exactly once via `entry.completeUnsafe(exit)`.

```ts
import { Request } from "effect"

// Option 1: Request.Class — the idiomatic, typed constructor.
// First type param = field shape, second = success type, third = error type.
class GetEmployeeById extends Request.Class<
  { readonly id: number },
  Employee,
  EmployeeNotFound
> {}

// Option 2: for tagged unions, use Request.TaggedClass.
// The tag is automatically set as _tag; remaining fields come from the shape param.
class GetManagerById extends Request.TaggedClass("GetManagerById")<
  { readonly id: number },
  Manager,
  EmployeeNotFound
> {}

// Constructing requests — fields are passed to the constructor as an object
const req = new GetEmployeeById({ id: 42 })
console.log(req.id) // 42

// Type utilities
type EmployeeSuccess = Request.Success<GetEmployeeById> // Employee
type EmployeeError   = Request.Error<GetEmployeeById>   // EmployeeNotFound
```

Key APIs: Request.Class, Request.TaggedClass, Request.tagged, Request.of, Request.complete, Request.succeed, Request.fail, Request.Success, Request.Error, Request.Services, Request.Result

**When to use:** building a `RequestResolver`. `Request` is the typed declaration of what each resolver call produces; it is rarely used in isolation.

## RequestResolver

`effect/RequestResolver` — stable

Executes batches of `Request` values. Core job: receive an array of pending request entries, fetch data (ideally in one batch call), then call `entry.completeUnsafe(Exit.succeed/fail(...))` on each entry. Pairing with `Effect.request` collapses concurrent N+1 queries into a single round-trip.

**Mental model.** Effect collects all concurrent `Effect.request` calls within a configurable batching window, groups them by resolver, and fires one `resolver.runAll(entries)` call. The resolver fans the single response out to each waiting fiber. Equivalent to DataLoader, but typed and composable.

```ts
import { Context, Effect, Exit, Layer, Request, RequestResolver, Schema, Tracer } from "effect"

// --- Domain errors --------------------------------------------------------

export class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()(
  "EmployeeNotFound",
  { id: Schema.Int.check(Schema.isGreaterThan(0)) }
) {}

// --- Domain models --------------------------------------------------------

export class Employee extends Schema.Class<Employee>("Employee")({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String,
  level: Schema.String,
  managerId: Schema.Int.check(Schema.isGreaterThan(0))
}) {}

export class Manager extends Schema.Class<Manager>("Manager")({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String,
  departmentId: Schema.Int.check(Schema.isGreaterThan(0))
}) {}

// --- Request definitions --------------------------------------------------

class GetEmployeeById extends Request.Class<
  { readonly id: number },
  Employee,
  EmployeeNotFound
> {}

class GetManagerById extends Request.Class<
  { readonly id: number },
  Manager,
  EmployeeNotFound
> {}

// --- Hris service with batched resolvers ----------------------------------
// Building an org chart fires one GetEmployeeById and one GetManagerById per
// node. Without batching that's 2N HRIS calls. With batching it's 2.

export class Hris extends Context.Service<Hris, {
  getEmployeeById(id: number): Effect.Effect<Employee, EmployeeNotFound>
  getManagerById(id: number): Effect.Effect<Manager, EmployeeNotFound>
}>()("app/Hris") {
  static readonly layer = Layer.effect(
    Hris,
    Effect.gen(function*() {
      // Simulate HRIS data store
      const employees = new Map<number, Employee>([
        [1, new Employee({ id: 1, name: "Ada Lovelace", level: "L5", managerId: 10 })],
        [2, new Employee({ id: 2, name: "Alan Turing", level: "L4", managerId: 10 })],
        [3, new Employee({ id: 3, name: "Grace Hopper", level: "L4", managerId: 11 })]
      ])
      const managers = new Map<number, Manager>([
        [10, new Manager({ id: 10, name: "Charles Babbage", departmentId: 1 })],
        [11, new Manager({ id: 11, name: "Emmy Noether", departmentId: 2 })]
      ])

      // One batch call satisfies every fiber waiting for an Employee.
      const employeeResolver = yield* RequestResolver.make<GetEmployeeById>(
        Effect.fn(function*(entries) {
          for (const entry of entries) {
            const emp = employees.get(entry.request.id)
            entry.completeUnsafe(
              emp
                ? Exit.succeed(emp)
                : Exit.fail(new EmployeeNotFound({ id: entry.request.id }))
            )
          }
        })
      ).pipe(
        RequestResolver.setDelay("10 millis"),
        RequestResolver.withSpan("Hris.getEmployeeById.resolver"),
        RequestResolver.withCache({ capacity: 2048 })
      )

      // Separate resolver for Manager lookups — same batching pattern.
      const managerResolver = RequestResolver.make<GetManagerById>(
        Effect.fn(function*(entries) {
          for (const entry of entries) {
            const mgr = managers.get(entry.request.id)
            entry.completeUnsafe(
              mgr
                ? Exit.succeed(mgr)
                : Exit.fail(new EmployeeNotFound({ id: entry.request.id }))
            )
          }
        })
      ).pipe(
        RequestResolver.setDelay("10 millis"),
        RequestResolver.withSpan("Hris.getManagerById.resolver")
      )

      const getEmployeeById = (id: number) =>
        Effect.request(new GetEmployeeById({ id }), employeeResolver).pipe(
          Effect.withSpan("Hris.getEmployeeById", { attributes: { employeeId: id } })
        )

      const getManagerById = (id: number) =>
        Effect.request(new GetManagerById({ id }), managerResolver).pipe(
          Effect.withSpan("Hris.getManagerById", { attributes: { managerId: id } })
        )

      return { getEmployeeById, getManagerById } as const
    })
  )
}

// --- Build an org chart — all lookups collapsed into two batch calls ------

export const buildOrgChart = Effect.gen(function*() {
  const { getEmployeeById, getManagerById } = yield* Hris
  const employeeIds = [1, 2, 3, 1, 2] // duplicates deduplicated by withCache

  // All five GetEmployeeById requests arrive concurrently →
  // resolver sees at most [1, 2, 3] after dedup.
  const employees = yield* Effect.forEach(employeeIds, getEmployeeById, {
    concurrency: "unbounded"
  })

  // Now fetch each unique manager in one batch.
  const managerIds = [...new Set(employees.map((e) => e.managerId))]
  yield* Effect.forEach(managerIds, getManagerById, { concurrency: "unbounded" })
})
```

### Resolver combinators

| Combinator | Effect |
| --- | --- |
| `RequestResolver.setDelay(duration)` | Wait before draining — more entries collected, higher latency on first call. |
| `RequestResolver.withSpan(name)` | Wrap each batch in an OTel span and add each distinct requesting parent span as a span link. |
| `RequestResolver.withCache({ capacity })` | Add an LRU in-memory cache so repeated equal requests are served from memory. |
| `RequestResolver.asCache({ capacity, timeToLive? })` | Convert the resolver into a `Cache` (requests are the keys). |
| `RequestResolver.persisted({ storeId, timeToLive })` | Back the resolver with a `Persistence` store (cross-restart caching). |
| `RequestResolver.makeGrouped({ key, resolver })` | Group entries by a computed key `K`; `resolver` receives `(entries, key)`. |
| `RequestResolver.fromFunctionBatched(f)` | Quick path: map entries to successes with a pure function; no explicit completions needed. |
| `RequestResolver.batchN(n)` | Limit maximum batch size to `n`. |
| `RequestResolver.race(a, b)` | Run two resolvers concurrently and use whichever responds first. |
| `RequestResolver.around(before, after)` | Bracket each batch run with setup/teardown effects. |

> **Tip:** Two `Request` instances are deduplicated if structurally equal via `Equal`. `Request.Class` derives equality from fields automatically. Plain objects must implement `Equal` manually; otherwise each instance is unique and deduplication will not fire.

> **Note:** Inside the resolver, `entry.context` holds the `Context` from the issuing fiber. `RequestResolver.withSpan` collects the distinct `Tracer.ParentSpan` values and records them as links on the batch span, rather than making multiple caller spans its children. Custom resolvers can inspect the same context with `Context.getOption(entry.context, Tracer.ParentSpan)`.

**When to use:** service methods that individual fibers call independently but which support batch APIs underneath (lookups, permission checks, external API calls). The N+1 problem on deeply nested data is the canonical trigger.

## PrimaryKey

`effect/PrimaryKey` — stable

Tiny protocol: define `[PrimaryKey.symbol](): string` on a class or object to advertise a stable string identifier. Effect's persistence layer uses this key to store and retrieve serialized exits.

**Mental model.** Natural key in a database: a deterministic, human-readable string uniquely identifying a particular request or entity. Anything implementing `PrimaryKey` can be used as a key in a `Persistable` store without a separate keyspace function.

```ts
import { PrimaryKey, Request } from "effect"

// Adding PrimaryKey to a request lets the persistence layer
// store the result under a stable key derived from the employee ID.
class GetEmployeeById
  extends Request.TaggedClass("GetEmployeeById")<
    { readonly id: number },
    Employee,
    EmployeeNotFound
  >
  implements PrimaryKey.PrimaryKey
{
  [PrimaryKey.symbol](): string {
    return `employee:${this.id}`
  }
}

const req = new GetEmployeeById({ id: 42 })
console.log(PrimaryKey.value(req))       // "employee:42"
console.log(PrimaryKey.isPrimaryKey(req)) // true
```

**When to use:** building a `Persistable` request or any custom type that needs a stable string key for caching, logging, or deduplication across process restarts.
