# State & Mutable References

Effect provides fiber-safe shared-state types (`Ref`, `SynchronizedRef`, `SubscriptionRef`) and unsynchronised in-place data structures (`MutableRef`, `MutableList`, `MutableHashMap`, `MutableHashSet`) for hot paths where Effect overhead is undesirable.

## Ref

`effect/Ref` — stable

An atomic mutable cell exposed as Effects. A `Ref<A>` holds one value; reads, writes, and transformations are Effect values — composable with fibers, timeouts, and retries. Internally wraps a `MutableRef` (a plain JS object with a `.current` field); reads/writes are synchronous internally but presented as Effects so the fiber scheduler can interleave them correctly. Every update is atomic at the JS level: no intermediate state leaks to another fiber.

Key APIs: make, get, set, update, updateAndGet, modify, getAndSet, getAndUpdate, updateSome, modifySome, makeUnsafe, getUnsafe

`modify` atomically reads the current value, computes a result and a new value, and stores the new value in one step. `update` is the shortcut when no extra return value is needed.

```ts
import { Effect, Ref } from "effect"

// Track remaining merit budget across concurrent raise recommendations
const meritBudgetExample = Effect.gen(function*() {
  // Budget pool in basis points (e.g. 300 = 3.0% of payroll)
  const budget = yield* Ref.make(300)

  // Simulate 20 concurrent raise recommendations each consuming 15 bps
  yield* Effect.all(
    Array.from({ length: 20 }, () =>
      Ref.update(budget, (remaining) => Math.max(0, remaining - 15))
    ),
    { concurrency: "unbounded" }
  )

  const remaining = yield* Ref.get(budget)
  console.log(`Remaining merit budget: ${remaining} bps`) // 0 — no lost updates
})

// modify: atomically claim a raise amount and return whether it was approved
const claimBudget = Effect.fn("claimBudget")(function*(
  budgetRef: Ref.Ref<number>,
  requestedBps: number
) {
  return yield* Ref.modify(budgetRef, (remaining) => {
    if (remaining >= requestedBps) {
      return [true, remaining - requestedBps] as const
    }
    return [false, remaining] as const
  })
})
```

`Ref.makeUnsafe(value)` creates a `Ref` synchronously without wrapping in an Effect — for use inside class constructors or module top-levels before concurrent fibers have started.

Use when multiple fibers share mutable state (counters, caches, toggles).

## SynchronizedRef

`effect/SynchronizedRef` — stable

A `Ref` whose update operations are serialised even when the update is an Effect. Wraps an internal `Semaphore` (single permit) so only one effectful transition is in flight at a time. The API mirrors `Ref` but adds `*Effect` variants: `updateEffect`, `modifyEffect`, `getAndUpdateEffect`, etc.

```ts
import { Effect, SynchronizedRef } from "effect"

// Load comp bands from the HRIS once, then serve from cache.
// On a refresh signal, any single fiber re-fetches; others wait for the result.
interface CompBand { level: string; min: number; mid: number; max: number }
type CompBandCache = ReadonlyArray<CompBand> | null

const makeCompBandCache = Effect.fn("makeCompBandCache")(function*(
  fetchBands: Effect.Effect<ReadonlyArray<CompBand>>
) {
  const cache = yield* SynchronizedRef.make<CompBandCache>(null)

  const get = Effect.fn("get")(function*() {
    // modifyEffect serialises access — no thundering herd on the HRIS
    return yield* SynchronizedRef.modifyEffect(
      cache,
      (current) =>
        Effect.gen(function*() {
          if (current !== null) return [current, current] as const
          // Only ONE fiber will ever run this fetch at a time;
          // every other fiber that arrives during the fetch will wait,
          // then receive the already-populated cache on the next turn.
          const bands = yield* fetchBands
          return [bands, bands] as const
        })
    )
  })

  const refresh = Effect.fn("refresh")(function*() {
    yield* SynchronizedRef.updateEffect(cache, () =>
      Effect.map(fetchBands, (bands) => bands)
    )
  })

  return { get, refresh }
})
```

The semaphore is held for the entire duration of the Effect inside `updateEffect`. If the updater performs a slow async call, other fibers queue and wait. This serialisation prevents two fibers simultaneously deciding "cache is empty, I'll fetch" and firing duplicate requests. For fast atomic swaps on pure values, prefer plain `Ref`.

Use when the next state value depends on an asynchronous computation and transitions must be serialized: load-once caches, OAuth token refresh, connection pooling, lazy config loading, circuit-breaker state transitions. Serialization prevents overlapping updaters; it does not by itself make an external side effect exactly once across interruption or retry.

## SubscriptionRef

`effect/SubscriptionRef` — stable

A `SynchronizedRef` that is also a `Stream`. Every state change is published to an internal `PubSub`. Subscribers receive the current value immediately on subscribe (replay-1), then every subsequent update. Exposes a `changes` property of type `Stream<A>` derived from `Stream.fromPubSub`. Writes go through the same serialising semaphore as `SynchronizedRef`, so no update is lost between store and publish.

```ts
import { Effect, Fiber, Stream, SubscriptionRef } from "effect"

// Live headcount ref: write on every hire/departure, stream to dashboards
const headcountDashboard = Effect.gen(function*() {
  type Headcount = { total: number; byDepartment: Record<string, number> }
  const headcount = yield* SubscriptionRef.make<Headcount>({
    total: 0,
    byDepartment: {}
  })

  // A fiber that streams every headcount change to a dashboard sink
  const watcher = yield* SubscriptionRef.changes(headcount).pipe(
    Stream.tap((hc) =>
      Effect.log(`Headcount updated: total=${hc.total}`)
    ),
    // Initial value plus the two updates below; a bare changes stream is live
    // forever, so joining it without a bound would never complete.
    Stream.take(3),
    Stream.runDrain,
    Effect.forkScoped
  )

  // Approve a new hire in Engineering — all subscribers see the update
  yield* SubscriptionRef.update(headcount, (hc) => ({
    total: hc.total + 1,
    byDepartment: {
      ...hc.byDepartment,
      Engineering: (hc.byDepartment["Engineering"] ?? 0) + 1
    }
  }))

  // A departure in Sales
  yield* SubscriptionRef.update(headcount, (hc) => ({
    total: hc.total - 1,
    byDepartment: {
      ...hc.byDepartment,
      Sales: (hc.byDepartment["Sales"] ?? 0) - 1
    }
  }))

  yield* Fiber.join(watcher)
})
```

> **Tip:** Each call to `SubscriptionRef.changes` creates a new independent subscriber to the underlying `PubSub`. Two calls yield two streams both receiving the same updates. Unsubscribing (finishing or interrupting the stream) is automatic.

Use when shared state must be subscribed to reactively: live data feeds for dashboards, feature flags driving live reconfiguration, status machines, or bridging Effect state into a streaming pipeline.

> **Warning:** `Ref`, `SynchronizedRef`, and `SubscriptionRef` are *fiber-safe*. The `Mutable*` types below are plain JavaScript objects with no synchronisation primitives. Sharing a `MutableRef` across fibers is a data race. Keep the Mutable* family strictly inside a single-owner scope — an initialisation block, a single fiber, or an encapsulated algorithm — and never hand a reference to another fiber.

## MutableRef

`effect/MutableRef` — stable

A tiny synchronous mutable box. Exposes a `.current` field for direct read/write plus a pipeable API: `get`, `set`, `update`, `compareAndSet`, numeric helpers `increment`/`decrement`, and `toggle` for booleans. No Effects, no fiber scheduler involvement. This is the backing store for `Ref` — `Ref` allocates a `MutableRef` internally.

```ts
import { MutableRef } from "effect"

// Accumulate per-department raise totals in a tight synchronous loop —
// no Effect allocation overhead, no fiber involvement.
interface DeptSummary { raises: number; totalBps: number }

function tallyRaises(
  recommendations: ReadonlyArray<{ department: string; bps: number; approved: boolean }>
): DeptSummary {
  const approvedCount = MutableRef.make(0)
  const totalBps = MutableRef.make(0)

  for (const rec of recommendations) {
    if (!rec.approved) continue
    MutableRef.increment(approvedCount)
    MutableRef.update(totalBps, (n) => n + rec.bps)
  }

  return {
    raises: MutableRef.get(approvedCount),
    totalBps: MutableRef.get(totalBps)
  }
}

// compareAndSet: claim "first to process this merit cycle" in a single fiber
const processed = MutableRef.make(false)
const claimed = MutableRef.compareAndSet(processed, false, true)
// claimed === true if this fiber is first; false if already claimed
```

Use inside a synchronous, single-fiber algorithm when the pipeable Effect style is wanted without any Effect overhead.

## MutableList

`effect/MutableList` — stable

A mutable linked-list-of-buckets optimised for high-throughput append/prepend and front-draining. Uses chunked arrays (buckets) internally: append is amortised O(1), batch takes are nearly free. Tracks `.length`. Supports `append`, `prepend`, `take`, `takeN`, `takeAll`, `appendAll`, `prependAll`, `filter`, `remove`, `clear`. `take` returns the special `MutableList.Empty` symbol (not `null` or `undefined`) when the list is empty. There is no `modify` — use `filter` or direct iteration to transform elements in place. This is Effect's internal work queue — the structure that backs the fiber scheduler.

```ts
import { MutableList } from "effect"

interface RaiseRecommendation {
  employeeId: string
  department: string
  bps: number
}

// Build up approved raise recommendations for a department in a tight loop,
// then flush the whole batch to the payroll client in one shot.
function collectApprovedRaises(
  recommendations: ReadonlyArray<RaiseRecommendation>,
  targetDept: string
): ReadonlyArray<RaiseRecommendation> {
  const approved = MutableList.make<RaiseRecommendation>()

  for (const rec of recommendations) {
    if (rec.department === targetDept && rec.bps > 0) {
      MutableList.append(approved, rec)
    }
  }

  // takeAll drains the list in one shot — returns the internal array directly
  // when possible, avoiding a copy
  return MutableList.takeAll(approved)
}

// Chunk-process a large raise list — drain 50 at a time to batch-write
const pending = MutableList.make<RaiseRecommendation>()
// ... append all recommendations ...

while (pending.length > 0) {
  const batch = MutableList.takeN(pending, 50)
  // hand batch to PayrollClient.submitRaises(batch) ...
}
```

Use for an efficient, growable, front-drainable queue inside a single-fiber context.

## MutableHashMap

`effect/MutableHashMap` — stable

An in-place mutable key/value map supporting both JS reference equality and Effect structural equality (for keys implementing `Equal`/`Hash`). Internally layers a native `Map` for ordinary keys with hash-bucket collision chains for structural keys. Is `Iterable<[K, V]>`.

Key operations: `empty`, `make`, `fromIterable`, `get` (returns `Option`), `set`, `has`, `remove`, `modify`, `modifyAt`, `forEach`, `keys`, `values`, `size`, `isEmpty`, `clear`.

`modify(map, key, f)` takes `f: (v: V) => V` and is a no-op when the key is absent. `modifyAt(map, key, f)` takes `f: (Option<V>) => Option<V>`: return `Option.none()` to delete, `Option.some(newValue)` to insert or update — handles upsert, increment, and conditional delete in one pass.

```ts
import { MutableHashMap, Option } from "effect"

// Per-department raise tally: accumulate total approved bps by department
// in a tight single-fiber loop across all raise recommendations.
interface DeptTally { count: number; totalBps: number }

function tallyByDepartment(
  recommendations: ReadonlyArray<{ department: string; bps: number }>
): MutableHashMap.MutableHashMap<string, DeptTally> {
  const tally = MutableHashMap.empty<string, DeptTally>()

  for (const rec of recommendations) {
    // modifyAt handles both "first rec for dept" (None) and "subsequent" (Some)
    MutableHashMap.modifyAt(tally, rec.department, (current) =>
      Option.some(
        Option.match(current, {
          onNone: () => ({ count: 1, totalBps: rec.bps }),
          onSome: (existing) => ({
            count: existing.count + 1,
            totalBps: existing.totalBps + rec.bps
          })
        })
      )
    )
  }

  return tally
}

const recs = [
  { department: "Engineering", bps: 150 },
  { department: "Sales", bps: 200 },
  { department: "Engineering", bps: 100 }
]

const result = tallyByDepartment(recs)
for (const [dept, summary] of result) {
  console.log(`${dept}: ${summary.count} raises, ${summary.totalBps} bps total`)
}
// Engineering: 2 raises, 250 bps total
// Sales: 1 raises, 200 bps total
```

> **Tip:** `modifyAt(map, key, f)` passes `Option.none()` when the key is absent and `Option.some(current)` when present. Return `Option.none()` to delete the key, or `Option.some(newValue)` to insert or update. This is the single function that handles upsert, increment, and conditional delete in one pass. `modify(map, key, f)` is the simpler sibling — it takes `f: (v: V) => V` and is a no-op when the key is absent, so use it only when you know the key exists.

Use for a fast mutable accumulator map inside a single-fiber context: tallying per-key counts, building adjacency lists, grouping data during pipeline steps.

## MutableHashSet

`effect/MutableHashSet` — stable

A mutable set built on `MutableHashMap` — each element is a map key pointing to `true`. Supports structural equality via `Equal`/`Hash`: elements are deduplicated by value, not reference. Is `Iterable<V>`. Supports `add`, `has`, `remove`, `size`, `clear`, `make`, `fromIterable`, `empty`.

```ts
import { MutableHashSet } from "effect"

// Walk the approval chain for a raise recommendation, collecting each
// approver's employee ID exactly once (cycles in the org graph are safe).
function collectApprovalChain(
  reportsTo: ReadonlyMap<string, string>, // employeeId -> managerId
  startEmployeeId: string
): ReadonlyArray<string> {
  const visited = MutableHashSet.empty<string>()
  const queue = [startEmployeeId]

  while (queue.length > 0) {
    const id = queue.pop()!
    if (MutableHashSet.has(visited, id)) continue
    MutableHashSet.add(visited, id)
    const managerId = reportsTo.get(id)
    if (managerId !== undefined) queue.push(managerId)
  }

  return Array.from(visited)
}

// Deduplicate employee IDs from a bulk-import event feed
// (the HRIS sometimes emits duplicate change events for the same person).
function deduplicateEmployeeIds(
  events: ReadonlyArray<{ employeeId: string; type: string }>
): ReadonlyArray<string> {
  const seen = MutableHashSet.empty<string>()
  for (const ev of events) {
    MutableHashSet.add(seen, ev.employeeId)
  }
  return Array.from(seen)
}
```

Use for fast deduplicated membership tracking inside a synchronous algorithm: visited sets during graph traversal, deduplication of IDs during bulk imports.

## Choosing the right state tool

| Module | Updates | Fiber-safe | Reactive stream | Best for |
| --- | --- | --- | --- | --- |
| `Ref` | Pure, synchronous | Yes | No | Shared merit budget pool, counters, flags |
| `SynchronizedRef` | Pure or effectful, serialised | Yes | No | Load-once comp band cache, HRIS refresh, state machines with async transitions |
| `SubscriptionRef` | Pure or effectful, serialised + published | Yes | Yes (`changes`) | Live headcount feed, reactive merit-cycle status, anything that drives a Stream |
| `MutableRef` | Synchronous, in-place | No | No | Single-fiber raise tallies, counters and flags in tight loops |
| `MutableList` | Synchronous, in-place | No | No | Raise recommendation batches, BFS of org hierarchy |
| `MutableHashMap` | Synchronous, in-place | No | No | Per-department raise tallies, comp band grouping, adjacency lists |
| `MutableHashSet` | Synchronous, in-place | No | No | Visited sets for org traversal, employee ID deduplication |

> **Rule of thumb:** Start with fiber-safe `Ref`; move to `SynchronizedRef` only when the update itself is effectful, to `SubscriptionRef` when consumers need a stream, and to a `Mutable*` type only inside a deliberately synchronous, single-fiber algorithm.
