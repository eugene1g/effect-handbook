# Caching & Batching

Caching avoids repeating the same lookup result; batching combines many logically independent requests into fewer physical calls. `Cache` stores both successful and failed lookup `Exit` values, while `ScopedCache` owns resource lifetimes. `Request` and `RequestResolver` describe data fetching so Effect can deduplicate and batch it safely.

> **Official example:** The release-matched [`ai-docs` batching example](https://github.com/Effect-TS/effect/tree/effect%404.0.2/ai-docs/src/05_batching) builds a batched `RequestResolver`.

> **Official guides:** [Batching](https://effect.website/docs/v4/batching) (it enables batching with `Effect.forEach(..., { batching: true })`, an option `Effect.forEach` does not have — see [RequestResolver](#requestresolver) for what triggers a batch here). These guides track Effect's `main` branch rather than the tagged `4.0.2` release, so where they differ, this page and the tagged source win.

## Which problem do you have?

Repeated work shows up on a dashboard as "too many HRIS calls", but it has several shapes, and each tool fixes exactly one of them. Measure first — hit ratio, lookup count per request, resolver batch size — then pick the smallest tool.

| Waste shape | What the measurement looks like | Tool | Why the neighbors do not help |
| --- | --- | --- | --- |
| **One expensive effect, no key** — load all comp bands, fetch a service token | The same effect runs once per caller instead of once per freshness window | [`Effect.cached` / `cachedWithTTL`](#caching-a-single-effect) | A keyed cache is machinery you do not need |
| **Repeat lookup** — the same key again inside a freshness window | Lookup count ≈ request count; the same keys recur | [`Cache`](#cache): key, capacity, TTL | Batching shrinks one burst; it remembers nothing afterwards |
| **Cold stampede** — many callers, same key, nothing warm yet | A burst of identical lookups at startup or right after expiry | Already solved by `Cache.get`: concurrent misses for one key share a single lookup. No promise map or lock needed | — |
| **N+1** — many *different* keys at once that the backend could answer together | Lookups scale with rows; every backend call carries one id | [`RequestResolver`](#requestresolver) + `Effect.request` | A cache cannot help: remembering `L4` does nothing for `L5` and `L6` |
| **Entries own resources** — a connection per tenant shard | Handles leak or linger after eviction | [`ScopedCache`](#scopedcache) | `Cache` drops the value without releasing it |
| **Results must survive a restart** | Cold start repeats work another instance already did | `RequestResolver.persisted` or [PersistedCache](../tooling/persistence#persistedcache) | In-memory caches die with the process |

**Single-flight is not batching.** Single-flight collapses concurrent cold gets of the *same* key into one lookup. Batching collapses concurrent requests for *different* keys into one backend call. A service often needs both, and they compose: `RequestResolver.withCache` and `RequestResolver.asCache` put a cache in front of a batched resolver.

For the neighboring choices (`Resource`, `Pool`, `Semaphore`) see [Cache vs ScopedCache vs Resource vs RequestResolver](../reference/choosing-effect-primitives#cache-vs-scopedcache-vs-resource-vs-requestresolver).

## Caching a single Effect

`effect/Effect` — stable

`Effect.cached(effect)` has the type `Effect<Effect<A, E, R>>`: running the *outer* effect creates a memo cell and returns a handle; the first evaluation of the *handle* runs the work, and later and concurrent evaluations share that one stored `Exit`.

**Mental model.** A lazy, single-slot, single-flight cache with no key. Construct it once where the owner lives — usually a `Layer` — and hand out the handle.

```ts
import { Context, Effect, Exit, Layer, Schema } from "effect"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {}) {}

declare const loadAllCompBands: Effect.Effect<ReadonlyMap<string, number>, HrisUnavailable>

export class CompBands extends Context.Service<CompBands, {
  readonly all: Effect.Effect<ReadonlyMap<string, number>, HrisUnavailable>
  readonly invalidate: Effect.Effect<void>
}>()("app/CompBands") {
  static readonly layer = Layer.effect(
    CompBands,
    Effect.gen(function*() {
      // Yield the outer effect ONCE; every caller of `all` shares the inner handle.
      const [all, invalidate] = yield* Effect.cachedInvalidateWithTTL(loadAllCompBands, "5 minutes")
      return { all, invalidate }
    })
  )
}

// Exit-based TTL: successes live 5 minutes; failures and interruptions are not retained.
export const makeCompBandsHandle = Effect.cachedWithTTL(
  loadAllCompBands,
  (exit) => Exit.isSuccess(exit) ? "5 minutes" : 0
)
```

| API | Keeps the result | Reset |
| --- | --- | --- |
| `Effect.cached(e)` | For as long as the handle lives | None |
| `Effect.cachedWithTTL(e, ttl)` | For `ttl`, a `Duration.Input` **or** `(exit) => Duration.Input` | Expiry, read from the `Clock` — `TestClock.adjust` controls it in tests |
| `Effect.cachedInvalidateWithTTL(e, ttl)` | For `ttl`, a `Duration.Input` **or** `(exit) => Duration.Input` | Expiry, or the returned `invalidate` effect |

- **Yield the outer effect once and share the handle.** `yield* Effect.cached(load)` at every call site builds a fresh, empty cell each time and caches nothing.
- **Failures are stored — interruptions are not.** With `Effect.cached` or a fixed-TTL `cachedWithTTL`, a transient `HrisUnavailable` is replayed to every caller until expiry, which for `cached` is never. Branch on the `Exit` and return `0` for non-success so the next caller retries. Interrupted computations are never cached: the pending work is interrupted only after every waiting caller has been interrupted (abandonment), and the next caller then starts a fresh computation.
- **`Cache` applies the same abandonment rule**: an interrupted `Cache.get` lookup is never retained; the next caller starts fresh.
- **Reach for [`Cache`](#cache) as soon as there is a key**, and for [`Resource`](../foundations/services-context-layers#resource) when the value needs scheduled refresh or owns a resource.

Official guide: [Caching Effects](https://effect.website/docs/v4/caching/caching-effects) (its "once" heading is not an API name; the code under it uses `Effect.cached`).

## Cache

`effect/Cache` — stable

Effectful memoization table with bounded capacity and optional TTL. A lookup effect is provided at construction; the cache handles concurrent requests, LRU eviction, and TTL expiry. When several fibers ask for an absent key at once, the lookup runs once and all of them await its result.

**Mental model.** Bounded `Map<Key, Deferred<A, E>>` that deduplicates concurrent misses. The first fiber to request a missing key starts the lookup and parks a deferred; subsequent fibers await that same deferred. On completion its full `Exit` is stored, so failures are cached too. Reading an existing entry—including a pending or failed one—moves it to the end of the map, and capacity pressure evicts the least recently accessed entry.

| Lookup outcome | Stored? | Consequence |
| --- | --- | --- |
| Success | Yes, until its TTL passes or it is evicted | Later `get` calls are hits |
| Typed failure or defect | **Yes, for the same TTL** | Every caller receives the stored failure without a new lookup — protection against a stampede on a failing backend, and a recovery delay if the TTL is long (see [Failure and freshness policy](#failure-and-freshness-policy)) |
| Interruption | No — interrupted results are never cached | Concurrent callers share the lookup; the lookup is interrupted only once every waiting caller has been interrupted (abandonment). A call made while the abandoned computation is still finalizing starts a fresh lookup. Keep lookups safe to interrupt and to repeat |

The TTL is measured from the moment the lookup completes and is read from the `Clock`; a hit moves the entry to the fresh end of the eviction order but does not extend its TTL.

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

### Keys are logical values

`Cache` stores entries in a `MutableHashMap`, so keys are compared with Effect's `Equal` and `Hash`. That comparison is structural for primitives, plain objects, arrays, dates, and `Data`/`Schema` classes alike: two separately built `{ region: "us", level: "L4" }` values address the same entry. Identity problems therefore come from the *input*, not from object references — `"L4"`, `"l4"`, and `" L4 "` are three keys, and so are `hris.example` and `HRIS.example`.

1. **Normalize where raw input enters** (trim, case-fold, canonical URL, sorted id list), so equal real-world things become equal values before anything looks them up.
2. **Carry the key as a small value class** — `Data.Class` or `Schema.Class` — so the type says "this is a stable identity", there is one constructor to normalize in, and nobody passes a whole employee record as a key.

```ts
import { Cache, Data, Effect } from "effect"

class BandKey extends Data.Class<{ readonly region: string; readonly level: string }> {
  // The only way in: normalize once, at ingress.
  static fromInput(region: string, level: string): BandKey {
    return new BandKey({ region: region.trim().toLowerCase(), level: level.trim().toUpperCase() })
  }
}

declare const fetchBandMidpoint: (key: BandKey) => Effect.Effect<number>

export const program = Effect.gen(function*() {
  const midpoints = yield* Cache.make({ capacity: 500, timeToLive: "30 minutes", lookup: fetchBandMidpoint })

  yield* Cache.get(midpoints, BandKey.fromInput("US", "l4")) // lookup
  yield* Cache.get(midpoints, BandKey.fromInput(" us ", "L4")) // hit — same logical key
})
```

- **Keep keys small and immutable.** Hashing and equality walk the key's structure, and a key mutated after insertion may never be found again.
- **Symptom of a skipped step:** a low hit ratio and duplicate lookups for keys that look identical in the logs.
- To opt a value *out* of structural comparison, wrap it with `Equal.byReference`.

### Key API surface

| Function | What it does |
| --- | --- |
| `Cache.make({ lookup, capacity, timeToLive? })` | Create a cache. `timeToLive` is a `Duration.Input` string or millis; omitted means entries never expire. |
| `Cache.makeWith(lookup, { capacity, timeToLive: (exit, key) => Duration })` | Dynamic TTL — vary per key or per outcome. A zero TTL means "share the in-flight lookup, retain nothing afterwards". |
| `Cache.get(cache, key)` | Get or compute. Concurrent misses share one lookup. |
| `Cache.getOption(cache, key)` | Read without starting a lookup. Returns `None` if absent/expired, awaits an existing pending entry, returns `Some<A>` on success, and fails with the cached lookup error on failure. |
| `Cache.getSuccess(cache, key)` | Non-blocking peek: `Some<A>` only for an entry that has already resolved successfully; `None` for missing, expired, pending, or failed entries. Never fails. |
| `Cache.refresh(cache, key)` | Force and await a new lookup. An existing entry remains readable by other fibers until it completes, then is replaced. Unlike concurrent `get` misses, concurrent `refresh` calls are not deduplicated. |
| `Cache.invalidate(cache, key)` | Remove one entry, whatever its outcome. |
| `Cache.invalidateWhen(cache, key, predicate)` | Remove the entry only if it holds a *successful* value matching the predicate; returns whether it did. A cached failure is never removed this way. |
| `Cache.invalidateAll(cache)` | Clear everything. |
| `Cache.set(cache, key, value)` | Manually populate an entry (useful for seeding). |
| `Cache.has(cache, key)` | Check for an unexpired entry without lookup. |
| `Cache.size` / `keys` / `values` / `entries` | Inspect the table. Expiry is lazy: `size` counts stored entries, including ones whose TTL has passed but that nothing has touched yet, while `keys`, `values`, and `entries` skip (and drop) expired ones; `values` and `entries` list successful entries only. |

> **Tip:** By default, services needed by `lookup` are captured at construction time. Pass `requireServicesAt: "lookup"` to instead capture them at call time — useful when the lookup needs request-scoped services that weren't available when the cache was built.

### Failure and freshness policy

**A cached failure lives exactly as long as a cached success unless you say otherwise.** With `Cache.make({ timeToLive: "30 minutes" })`, one transient `HrisUnavailable` is replayed to every caller for thirty minutes after the HRIS has recovered. Give failures their own, deliberately chosen lifetime with `Cache.makeWith` and branch on the `Exit`:

```ts
import { Cache, Effect, Exit, Schema } from "effect"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {}) {}

declare const fetchBandMidpoint: (level: string) => Effect.Effect<number, HrisUnavailable>

export const makeMidpointCache = Cache.makeWith(fetchBandMidpoint, {
  capacity: 500,
  // Long for successes, short for failures. The key is available as the second argument.
  timeToLive: (exit) => Exit.isSuccess(exit) ? "30 minutes" : "5 seconds"
})
```

| Failure TTL | Behavior | Choose it when |
| --- | --- | --- |
| Same as success (the `Cache.make` default) | The failure is served for the full TTL | Almost never what you want |
| Short (seconds) | Callers share one failure briefly, then one of them retries | The usual answer: it shields a struggling backend from a stampede and still recovers quickly |
| Zero | Concurrent callers share the in-flight lookup; the next caller starts a new one | The lookup is cheap, or an outer retry policy already paces the calls |

**TTL is a deadline; invalidation is an event.** When something tells you an entry is wrong *now* — a comp-band update arrived, a retry path just saw a transient failure — call `Cache.invalidate` (any outcome), `Cache.invalidateWhen` (successful values only), or `Cache.refresh` (replace while readers keep the old value). Do not shorten the TTL to approximate an event you could have handled.

> **Correctness guarantees.** `invalidateWhen` never deletes a replacement entry that was written while it was reading the old value; an interrupted or zero-TTL `refresh` of a missing key never removes a newer value written by `Cache.set`; `refresh` never pushes the table past `capacity` when its key is evicted mid-refresh; and a synchronously interrupted lookup is never retained. A cache hit also re-stores the entry under the key instance you just passed to `get`/`getOption`, not the instance used to create it, so replacing an equal-but-distinct key object (for example, a rebuilt `Data.Class`) does not keep the old object pinned in the map. The same guarantees apply to `ScopedCache`.

### Testing a cache deterministically

Count lookups with a `Ref`, move time with `TestClock`, and prove overlap with a `Deferred` gate instead of a sleep. Assert just before and just after each deadline.

```ts
import { assert, describe, it } from "@effect/vitest"
import { Cache, Deferred, Effect, Exit, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"

describe("band midpoint cache", () => {
  it.effect("retries a failure after its own TTL, keeps a success for the long one", () =>
    Effect.gen(function*() {
      const lookups = yield* Ref.make(0)
      const cache = yield* Cache.makeWith(
        (_level: string) =>
          Ref.updateAndGet(lookups, (n) => n + 1).pipe(
            Effect.flatMap((n) => n === 1 ? Effect.fail("HrisUnavailable" as const) : Effect.succeed(140_000))
          ),
        { capacity: 10, timeToLive: (exit) => Exit.isSuccess(exit) ? "30 minutes" : "5 seconds" }
      )

      assert.isTrue(Exit.isFailure(yield* Effect.exit(Cache.get(cache, "L4"))))
      yield* TestClock.adjust("4 seconds")
      assert.isTrue(Exit.isFailure(yield* Effect.exit(Cache.get(cache, "L4")))) // replayed
      assert.strictEqual(yield* Ref.get(lookups), 1)

      yield* TestClock.adjust("1 second") // failure TTL reached
      assert.strictEqual(yield* Cache.get(cache, "L4"), 140_000)
      yield* TestClock.adjust("29 minutes")
      assert.strictEqual(yield* Cache.get(cache, "L4"), 140_000)
      assert.strictEqual(yield* Ref.get(lookups), 2)
    }))

  it.effect("collapses concurrent cold gets into one lookup", () =>
    Effect.gen(function*() {
      const lookups = yield* Ref.make(0)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const cache = yield* Cache.make({
        capacity: 10,
        lookup: (_level: string) =>
          Ref.update(lookups, (n) => n + 1).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as(140_000)
          )
      })

      const callers = yield* Effect.forkChild(
        Effect.all([Cache.get(cache, "L4"), Cache.get(cache, "L4"), Cache.get(cache, "L4")], {
          concurrency: "unbounded"
        })
      )
      yield* Deferred.await(started) // the lookup is running; no caller has a value yet
      assert.strictEqual(yield* Ref.get(lookups), 1)

      yield* Deferred.succeed(release, undefined)
      assert.deepStrictEqual(yield* Fiber.join(callers), [140_000, 140_000, 140_000])
      assert.strictEqual(yield* Ref.get(lookups), 1)
    }))
})
```

`TestClock` is provided by `it.effect`; see [TestClock](../tooling/testing-dev-tooling#testclock) for the clock itself.

**When to use:** effectful computation (HTTP call, expensive decode) hit by many callers with the same keys, where you want deduplication of in-flight requests plus time-bounded staleness.

Official guide: [Cache](https://effect.website/docs/v4/caching/cache) (it shows `timeToLive` as a required option; the API makes it optional and defaults to no expiry).

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

`ScopedCache.makeWith` accepts the same `(exit, key) => Duration` policy as `Cache.makeWith`, and the [key](#keys-are-logical-values) and [failure TTL](#failure-and-freshness-policy) guidance applies unchanged. Two lifetime details are specific to it: `ScopedCache.invalidateAll` detaches every entry from the table *before* closing the entry scopes (concurrently), so an entry that a finalizer re-creates is kept and released later instead of being discarded unreleased; and after the cache's own scope has closed, `get`, `set`, `refresh`, and the invalidation operations are interrupted rather than reopening anything. A shared lookup also survives any single caller's interruption — if every waiter leaves while the lookup is still pending, the lookup itself is interrupted and its scope closed, and missing-key lookups (including `refresh`) run in a daemon fiber so one caller's cancellation never corrupts the entry for the others.

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

The completion helpers are Effect-returning counterparts of `entry.completeUnsafe(exit)`, so they drop straight into `Effect.forEach` inside a resolver:

| Helper | Completes the entry with |
| --- | --- |
| `Request.succeed(entry, value)` | A success |
| `Request.fail(entry, error)` | A typed failure |
| `Request.failCause(entry, cause)` | A full `Cause` (defects, interruption) |
| `Request.complete(entry, exit)` | An `Exit` you already hold |
| `Request.completeEffect(entry, effect)` | Whatever `effect` produces — runs it, then completes with its success or typed failure |

An entry can be completed once; later completions are ignored.

**When to use:** building a `RequestResolver`. `Request` is the typed declaration of what each resolver call produces; it is rarely used in isolation.

## RequestResolver

`effect/RequestResolver` — stable

Executes batches of `Request` values. Core job: receive an array of pending request entries, fetch data (ideally in one batch call), then call `entry.completeUnsafe(Exit.succeed/fail(...))` on each entry. Pairing with `Effect.request` collapses concurrent N+1 queries into a single round-trip.

**Mental model.** Effect collects all concurrent `Effect.request` calls within a configurable batching window, groups them by resolver, and fires one `resolver.runAll(entries)` call. The resolver fans the single response out to each waiting fiber. Equivalent to DataLoader, but typed and composable.

**What actually forms a batch.** Batching is a property of the resolver, not of the call site — `Effect.forEach` and `Effect.all` have no `batching` option. Every `Effect.request` registered against the same resolver (and the same [grouping key](#resolver-combinators)) before the resolver's `delay` effect finishes lands in one batch. The default delay is a single `Effect.yieldNow`, so only requests issued *concurrently* meet:

| Call site | Batches the resolver sees for ids `1, 2, 3` |
| --- | --- |
| `Effect.forEach(ids, get)` (sequential) | `[1]`, `[2]`, `[3]` — each request suspends its fiber until it is answered, so nothing else can join |
| `Effect.forEach(ids, get, { concurrency: 2 })` | `[1, 2]`, `[3]` — the concurrency limit caps the batch size |
| `Effect.forEach(ids, get, { concurrency: "unbounded" })` | `[1, 2, 3]` |

`RequestResolver.setDelay("10 millis")` widens the window so requests from *different* fibers and handlers can meet, at the price of that much latency on every batch.

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

> **Note:** A resolver cannot require services. `RequestResolver<A>` has no requirements parameter and `runAll` is typed with `R = never`, so a `yield* SomeService` inside `RequestResolver.make` is a type error. Build the resolver where the services are in scope — inside `Layer.effect`, as `Hris.layer` does, closing over the client it needs — and expose only query functions. `Effect.request` also accepts an `Effect<RequestResolver>` as its second argument and propagates that effect's errors and requirements to the caller. Per-caller context stays available as `entry.context`.

### Resolver obligations

A resolver is a small protocol, and part of it is enforced at runtime:

1. **Settle every entry you receive, exactly once** — with `entry.completeUnsafe(exit)` or the [`Request.*` helpers](#request). If `runAll` succeeds and leaves an entry untouched, that caller **dies** with the defect `Effect.request: RequestResolver did not complete request`. The classic trigger is a batch endpoint that silently omits unknown ids.
2. **Join results to entries by identity, never by position.** Index the rows by id once, then iterate the *entries*. Backend row order is not a contract, and positional pairing hands callers each other's data without any error.
3. **Decide what a missing row means** — a typed failure or a domain "empty" success — and complete the entry with it. Skipping is not a decision (see rule 1).
4. **Deduplicate the backend call yourself.** Base batching collects entries; it does not collapse equal requests, so ids `L4, L5, L4` reach the resolver as three entries. Send the distinct ids to the backend and still complete all three entries. Only [`withCache` / `asCache`](#resolver-combinators) collapse equal requests before they reach the resolver.
5. **Let a failed batch fail.** When `runAll` itself fails with `Request.Error<A>`, every still-pending entry in that batch receives the failure; there is no need to fail entries one by one. Fail individual entries only when the batch call succeeded and *that* row is the problem.

```ts
import { Effect, Request, RequestResolver, Schema } from "effect"

class CompSummaryUnavailable extends Schema.TaggedError<CompSummaryUnavailable>()(
  "CompSummaryUnavailable",
  { employeeId: Schema.String }
) {}

interface CompSummary {
  readonly employeeId: string
  readonly baseSalary: number
}

class GetCompSummary extends Request.Class<
  { readonly tenantId: string; readonly employeeId: string },
  CompSummary,
  CompSummaryUnavailable
> {}

// One payroll API call per tenant; rows come back in any order and may omit unknown ids.
declare const fetchCompSummaries: (
  tenantId: string,
  employeeIds: ReadonlyArray<string>
) => Effect.Effect<ReadonlyArray<CompSummary>, CompSummaryUnavailable>

export const CompSummaryResolver = RequestResolver.makeGrouped<GetCompSummary, string>({
  // The grouping key decides what may share a round trip: one batch per tenant.
  key: (entry) => entry.request.tenantId,
  resolver: Effect.fn("CompSummaryResolver.runAll")(function*(entries, tenantId) {
    // Rule 4: distinct ids only.
    const employeeIds = [...new Set(entries.map((entry) => entry.request.employeeId))]
    // Rule 5: if this fails, every pending entry of the batch fails with the same error.
    const rows = yield* fetchCompSummaries(tenantId, employeeIds)
    // Rule 2: join by identity.
    const byId = new Map(rows.map((row) => [row.employeeId, row]))
    // Rules 1 and 3: iterate ENTRIES (duplicates included) and settle each one.
    yield* Effect.forEach(entries, (entry) => {
      const row = byId.get(entry.request.employeeId)
      return row === undefined
        ? Request.fail(entry, new CompSummaryUnavailable({ employeeId: entry.request.employeeId }))
        : Request.succeed(entry, row)
    }, { discard: true })
  })
})
```

### Resolver combinators

| Combinator | Effect |
| --- | --- |
| `RequestResolver.make(runAll)` | Batched resolver: `runAll(entries, key)` answers a non-empty batch. Default window: one `Effect.yieldNow`. |
| `RequestResolver.makeGrouped({ key, resolver })` | Like `make`, with a grouping key computed from each *entry*: `key: (entry) => K`, `resolver: (entries, key) => …`. **The key decides what may share a round trip** — a constant key puts every request in one batch, while keying by tenant, shard, or data source batches within each group and never mixes requests bound for different backends. Keys are compared with `Equal`; keep their domain small and bounded, because the resolver remembers each distinct key it has seen. `RequestResolver.grouped(f)` adds the same grouping to an existing resolver. |
| `RequestResolver.fromEffect(f)` | No batch endpoint: `f(entry)` runs once per entry, concurrently, and its `Exit` completes that entry. You still get one call site for caching, tracing, and delay. |
| `RequestResolver.fromEffectTagged<Req>()({ Tag: (entries) => … })` | One handler per request `_tag`; each returns an iterable of results in the same order as its entries (arrays, iterators, and generators all work). A handler's typed error, defect, or interruption completes every entry of that tag with it. This is the one positional API — prefer `make` when the backend does not guarantee order. |
| `RequestResolver.fromFunctionBatched(f)` | Quick path: map entries to successes with a pure function; no explicit completions needed. Also positional. |
| `RequestResolver.setDelay(duration)` | Wait before draining — more entries collected, higher latency on first call. `setDelayEffect` takes an arbitrary effect. |
| `RequestResolver.batchN(n)` | Limit maximum batch size to `n`; a full batch runs immediately instead of waiting out the delay. |
| `RequestResolver.withSpan(name)` | Wrap each batch in an OTel span (attribute `batchSize`) and add each distinct requesting parent span as a span link. |
| `RequestResolver.withCache({ capacity, strategy? })` | Put a bounded in-memory cache in front, keyed by request equality: equal requests in one batch collapse to one entry, and completed results are replayed. `strategy` is `"lru"` (default) or `"fifo"`. **Entries never expire by time and failures are cached like successes** (interrupted results are not), so a transient failure stays until it is evicted by capacity. |
| `RequestResolver.asCache({ capacity, timeToLive? })` | Convert the resolver into a `Cache` (requests are the keys). Use this instead of `withCache` when you need a TTL — `timeToLive: (exit, request) => Duration`, so the [failure policy](#failure-and-freshness-policy) applies — or `invalidate` / `refresh`. |
| `RequestResolver.persisted({ storeId, timeToLive })` | Back the resolver with a `Persistence` store (cross-restart caching). |
| `RequestResolver.race(a, b)` | Run two resolvers concurrently and use whichever responds first. |
| `RequestResolver.around(before, after)` | Bracket each batch run with setup/teardown effects. |

> **Tip:** Request equality is structural. `Request.Class` and `Request.TaggedClass` instances with equal fields are equal, and so are plain objects built with `Request.of` / `Request.tagged`, because `Equal.equals` compares plain objects structurally. Equality only matters to `withCache` and `asCache`, though (`persisted` keys its store by [`PrimaryKey`](#primarykey)) — a resolver without one of them receives every entry, duplicates included. The same [key normalization](#keys-are-logical-values) rules apply: `{ id: "e-42" }` and `{ id: "E-42" }` are different requests.

> **Correctness guarantees.** `withCache` never retains an entry for a pending request whose caller was cancelled, and it keeps the completed result when the losing side of `RequestResolver.race` is interrupted, so the next equal lookup does not hit the backend again. `persisted` preserves completed results and propagates resolver failures. `fromEffectTagged` preserves a handler's typed errors, defects, and interrupts, and consumes its results as an iterable.

> **Note:** Inside the resolver, `entry.context` holds the `Context` from the issuing fiber. `RequestResolver.withSpan` collects the distinct `Tracer.ParentSpan` values and records them as links on the batch span, rather than making multiple caller spans its children. Custom resolvers can inspect the same context with `Context.getOption(entry.context, Tracer.ParentSpan)`.

### Testing a resolver

Give the fake backend the three behaviors a real one has — shuffled rows, an omitted id, a duplicated request — and assert the four properties of the [resolver obligations](#resolver-obligations): one backend call, distinct ids, results in caller order, every entry settled.

```ts
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Request, RequestResolver } from "effect"

class GetBandMidpoint extends Request.Class<{ readonly level: string }, number, "UnknownLevel"> {}

describe("band midpoint resolver", () => {
  it.effect("one call, distinct ids, caller order, every entry settled", () =>
    Effect.gen(function*() {
      const backendCalls: Array<ReadonlyArray<string>> = []
      const midpoints = new Map([["L5", 185_000], ["L4", 140_000]]) // reversed on purpose; no "L9"

      const resolver = RequestResolver.make<GetBandMidpoint>((entries) =>
        Effect.gen(function*() {
          const levels = [...new Set(entries.map((entry) => entry.request.level))]
          backendCalls.push(levels)
          const rows = [...midpoints].filter(([level]) => levels.includes(level))
          const byLevel = new Map(rows)
          yield* Effect.forEach(entries, (entry) => {
            const midpoint = byLevel.get(entry.request.level)
            return midpoint === undefined
              ? Request.fail(entry, "UnknownLevel" as const)
              : Request.succeed(entry, midpoint)
          }, { discard: true })
        })
      )

      const results = yield* Effect.forEach(
        ["L4", "L5", "L4", "L9"],
        (level) => Effect.exit(Effect.request(new GetBandMidpoint({ level }), resolver)),
        { concurrency: "unbounded" }
      )

      assert.deepStrictEqual(backendCalls, [["L4", "L5", "L9"]]) // one call, duplicates removed
      assert.deepStrictEqual(results, [
        Exit.succeed(140_000),
        Exit.succeed(185_000),
        Exit.succeed(140_000), // the duplicate entry was settled too
        Exit.fail("UnknownLevel" as const) // a typed failure, not the "did not complete request" defect
      ])
    }))
})
```

No clock is involved with the default `Effect.yieldNow` window. A resolver built with `setDelay` sleeps on the `Clock`, so under `it.effect` fork the callers, `TestClock.adjust` past the delay, then join.

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
