# State & Mutable References

Effect provides fiber-safe shared-state types (`Ref`, `SynchronizedRef`, `SubscriptionRef`) and unsynchronised in-place data structures (`MutableRef`, `MutableList`, `MutableHashMap`, `MutableHashSet`) for hot paths where Effect overhead is undesirable.

> **Official guides:** [Ref](https://effect.website/docs/v4/state-management/ref); section-specific guides are linked where they apply. These track Effect's `main` branch rather than the tagged `4.0.0` release, so where they differ, this page and the tagged source win.

## Ref

`effect/Ref` — stable

An atomic mutable cell exposed as Effects. A `Ref<A>` holds one value; reads, writes, and transformations are Effect values — composable with fibers, timeouts, and retries. Internally wraps a `MutableRef` (a plain JS object with a `.current` field). Each pure `update` / `modify` runs synchronously without suspension, so another fiber cannot interleave its own operation inside that transition. The Effect wrapper makes the operation lazy and composable; it is not a lock around a sequence of separate calls.

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

### One transition, one call

**Each `Ref` operation is atomic; a sequence of them is not.** `Ref.get` followed by `Ref.set` is two transitions, and any suspension between them — an HRIS call, a log line, a `sleep`, even `Effect.yieldNow` — lets every fiber compute its write from the same stale read. Express the whole read-compute-write as one call and pick the call by what you need back:

| You need back | Use | Updater shape |
| --- | --- | --- |
| Nothing | `Ref.update(ref, f)` | `(a) => a` |
| The new state | `Ref.updateAndGet(ref, f)` | `(a) => a` |
| The previous state | `Ref.getAndUpdate(ref, f)` / `Ref.getAndSet(ref, a)` | `(a) => a` |
| A value derived from the old state (an id, an approve/deny decision) | `Ref.modify(ref, f)` | `(a) => [result, next]` |
| A change only in some states | `Ref.updateSome` / `Ref.modifySome` | return `Option.none()` to keep the current value |

```ts
import { Effect, Ref } from "effect"

const lostUpdates = Effect.gen(function*() {
  const approvedCount = yield* Ref.make(0)

  // Anti-pattern: two atomic steps with a suspension point between them.
  const racy = Effect.gen(function*() {
    const seen = yield* Ref.get(approvedCount)
    yield* Effect.yieldNow // stands in for any asynchronous work
    yield* Ref.set(approvedCount, seen + 1)
  })
  yield* Effect.all(Array.from({ length: 5 }, () => racy), { concurrency: "unbounded" })
  const afterRacy = yield* Ref.get(approvedCount) // 1 — four approvals were overwritten

  // One transition per approval: nothing can interleave inside `update`.
  const counted = yield* Ref.make(0)
  const safe = Effect.andThen(Effect.yieldNow, Ref.update(counted, (n) => n + 1))
  yield* Effect.all(Array.from({ length: 5 }, () => safe), { concurrency: "unbounded" })
  const afterSafe = yield* Ref.get(counted) // 5

  // `modify` hands back a value computed from the state it replaced.
  const sequence = yield* Ref.make(7)
  const raiseId = yield* Ref.modify(sequence, (n) => [`raise-${n}`, n + 1] as const) // "raise-7"

  return { afterRacy, afterSafe, raiseId }
})
```

- **Store immutable snapshots.** A `Ref` protects the *cell*, not the object inside it. For a `Map`, array, or record, build a new value and install it in one `update` (`(m) => new Map(m).set(dept, bps)`); mutating the stored object in place bypasses the atomic transition and changes values other fibers already read.
- **Updaters are pure, synchronous functions.** The moment the next state needs an Effect (a fetch, a decode, a log), move to `SynchronizedRef` rather than reading, running the effect, and writing back.
- **A `Ref` is a handle, not an Effect.** `yield* ref` does not type-check, and the same holds for `SynchronizedRef`, `SubscriptionRef`, `TxRef`, `Deferred`, `Queue`, and `Fiber` handles. Yield the operation on the handle — `Ref.get(ref)`, `Deferred.await(deferred)`, `Fiber.join(fiber)` — not the handle itself.

### Sharing one Ref through a service

To share one cell between separately written parts of a program, make the `Ref` the implementation of a service and build it once. `Ref.make` is an Effect, so provisioning is effectful: `Layer.effect` for an application, `Effect.provideServiceEffect` for a one-off program or test.

```ts
import { Context, Effect, Layer, Ref } from "effect"

class MeritBudget extends Context.Service<MeritBudget, Ref.Ref<number>>()("app/MeritBudget") {
  static readonly layer = Layer.effect(MeritBudget, Ref.make(300))
}

const spend = Effect.fn("spend")(function*(bps: number) {
  const budget = yield* MeritBudget
  return yield* Ref.updateAndGet(budget, (remaining) => remaining - bps)
})

// One cell for the whole program: [285, 270]
const shared = Effect.all([spend(15), spend(15)]).pipe(Effect.provide(MeritBudget.layer))

// Provided at each use site, `Ref.make` runs twice and the cells are unrelated: [285, 285]
const separate = Effect.all([
  spend(15).pipe(Effect.provideServiceEffect(MeritBudget, Ref.make(300))),
  spend(15).pipe(Effect.provideServiceEffect(MeritBudget, Ref.make(300)))
])
```

**Provide the cell once, at the edge that owns its lifetime**, exactly like any other [Layer](../foundations/services-context-layers#layer); wrapping the `Ref` in a narrower service interface (`spend`, `remaining`) keeps callers from writing arbitrary values.

Use when multiple fibers share mutable state (counters, caches, toggles).

## SynchronizedRef

`effect/SynchronizedRef` — stable

A separate reference type whose update operations are serialised even when the update is an Effect. It pairs a backing `Ref` with an internal `Semaphore` (single permit) so only one transition is in flight at a time. The API mirrors `Ref` and adds `*Effect` variants: `updateEffect`, `modifyEffect`, `getAndUpdateEffect`, `updateSomeEffect`, `modifySomeEffect`, etc.

> **Note:** `SynchronizedRef` is not a subtype of `Ref`, so `Ref.get(syncRef)` and the other `Ref.*` combinators reject it at compile time. Call the `SynchronizedRef.*` function of the same name instead.

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

Semantics worth knowing before you rely on it:

- **Every write takes the permit, reads never do.** `set`, `update`, and `modify` queue behind an in-flight `updateEffect`; `SynchronizedRef.get` returns immediately with the last *committed* value, so a reader never blocks on a slow refresh and never sees a half-finished transition.
- **The new value is stored only if the updater succeeds.** A failing or interrupted updater leaves the previous value in place, which is what makes "fetch, then install" safe to retry.
- **The permit is not reentrant.** Writing to the same `SynchronizedRef` from inside its own updater waits for a permit the fiber already holds and never completes; read with `get` inside the updater, or return the final value from it.
- **`*Some*` variants can skip the write.** The updater given to `updateSomeEffect` produces `Option<A>`, and the one given to `modifySomeEffect` produces `[B, Option<A>]`; `Option.none()` keeps the current value. Both have the usual data-first and pipeable (`ref.pipe(SynchronizedRef.modifySomeEffect(f))`) forms.

Use when the next state value depends on an asynchronous computation and transitions must be serialized: load-once caches, OAuth token refresh, connection pooling, lazy config loading, circuit-breaker state transitions. Serialization prevents overlapping updaters; it does not by itself make an external side effect exactly once across interruption or retry.

Official guide: [SynchronizedRef](https://effect.website/docs/v4/state-management/synchronizedref).

## SubscriptionRef

`effect/SubscriptionRef` — stable

A serialised reference that can also be observed as a `Stream`. It is its own type — not a subtype of `Ref` or `SynchronizedRef` — with the same operation names (`get`, `set`, `update`, `modify`, the `*Effect` and `*Some*` variants). Every state change is published to an internal unbounded `PubSub` with `replay: 1`, and `SubscriptionRef.changes(ref)` returns a `Stream<A>` over it: a subscriber receives the value current at the moment it subscribes, then every later update. Writes hold a single-permit semaphore while they store and publish, so no update is lost between the two.

```ts
import { Deferred, Effect, Fiber, Stream, SubscriptionRef } from "effect"

// Live headcount ref: write on every hire/departure, stream to dashboards
const headcountDashboard = Effect.gen(function*() {
  type Headcount = { total: number; byDepartment: Record<string, number> }
  const headcount = yield* SubscriptionRef.make<Headcount>({
    total: 0,
    byDepartment: {}
  })
  const subscribed = yield* Deferred.make<void>()

  // A fiber that streams every headcount change to a dashboard sink
  const watcher = yield* SubscriptionRef.changes(headcount).pipe(
    Stream.tap((hc) =>
      Effect.andThen(
        Effect.log(`Headcount updated: total=${hc.total}`),
        Deferred.succeed(subscribed, undefined) // first element = subscription is live
      )
    ),
    // Initial value plus the two updates below; a bare changes stream is live
    // forever, so joining it without a bound would never complete.
    Stream.take(3),
    Stream.runDrain,
    Effect.forkScoped
  )
  // A forked fiber has not run yet. Without this gate both updates could land
  // before the watcher subscribes; it would then see only the latest value and
  // `take(3)` would wait forever.
  yield* Deferred.await(subscribed)

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

> **Warning:** `changes` replays the *latest* value, not history. A subscriber that starts after three updates receives one element (the current state) and then waits for the next change, so never size a `Stream.take(n)` by counting writes that may precede the subscription. Treat the stream as "current state, then deltas", and bound it with a condition (`Stream.takeUntil`) or the consumer's scope.

### Keep the ref private, expose a Stream

`SubscriptionRef` is a decoupling tool: the writer is typed against the ref, every reader against `Stream<A>` only. Put the ref inside a service, export `changes` plus the few transitions you allow, and no consumer can write state or even learn that a `SubscriptionRef` exists.

```ts
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"

type CycleStatus = "planning" | "approvals" | "frozen"

class MeritCycleStatus extends Context.Service<MeritCycleStatus, {
  readonly current: Effect.Effect<CycleStatus>
  readonly changes: Stream.Stream<CycleStatus>
  readonly advance: (next: CycleStatus) => Effect.Effect<void>
}>()("app/MeritCycleStatus") {
  static readonly layer = Layer.effect(
    MeritCycleStatus,
    Effect.gen(function*() {
      const ref = yield* SubscriptionRef.make<CycleStatus>("planning")
      return {
        current: SubscriptionRef.get(ref),
        changes: SubscriptionRef.changes(ref),
        advance: (next: CycleStatus) => SubscriptionRef.set(ref, next)
      }
    })
  )
}

// A dashboard only knows about a Stream. One that starts during "planning" collects
// ["planning", "approvals", "frozen"]; one that joins during "approvals" collects
// ["approvals", "frozen"].
const untilFrozen = Effect.gen(function*() {
  const status = yield* MeritCycleStatus
  return yield* status.changes.pipe(
    Stream.takeUntil((s) => s === "frozen"),
    Stream.runCollect
  )
})
```

Use when shared state must be subscribed to reactively: live data feeds for dashboards, feature flags driving live reconfiguration, status machines, or bridging Effect state into a streaming pipeline. For a transactional equivalent see [TxSubscriptionRef](./software-transactional-memory#txsubscriptionref); for fan-out of *events* rather than state, use [PubSub](./concurrency-coordination#pubsub).

Official guide: [SubscriptionRef](https://effect.website/docs/v4/state-management/subscriptionref).

> **Concurrency boundary:** JavaScript fibers do not interleave inside a synchronous, non-suspending operation. A pure `MutableRef.update` is therefore atomic with respect to other fibers, just like the synchronous transition inside `Ref.update`. A read–suspend–write sequence can lose updates with **either** type. `Mutable*` APIs are eager and do not serialize effectful protocols or protect aliased mutable values. Prefer `Ref` for lazy, composable shared-state operations, `SynchronizedRef` for effectful transitions, and encapsulated `Mutable*` values for synchronous algorithms.

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

A mutable linked-list-of-buckets optimised for high-throughput append/prepend and front-draining. Uses chunked arrays (buckets) internally: append is amortised O(1), batch takes are nearly free. Tracks `.length`. Supports `append`, `prepend`, `take`, `takeN`, `takeAll`, `appendAll`, `prependAll`, `filter`, `remove`, `clear`. `take` returns the special `MutableList.Empty` symbol (not `null` or `undefined`) when the list is empty. There is no `modify` — `filter(list, predicate)` prunes in place, and `toArray` / `toArrayN` copy without draining. Counts passed to `takeN` / `toArrayN` are normalised: a fractional count is floored, and `NaN` or a non-positive count takes nothing. This is the buffer Effect itself uses inside `Queue` and `PubSub`.

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

For a set that is shared across fibers, stored in a `Ref`, or returned from a function, use the immutable [HashSet](../data/data-structures#hashset) instead: every change produces a new value, so nobody observes a half-built set.

Official guide: [HashSet](https://effect.website/docs/v4/data-types/hash-set) (documents the immutable and mutable variants side by side).

## Choosing the right state tool

| Module | Updates | Effect API | Reactive stream | Best for |
| --- | --- | --- | --- | --- |
| `Ref` | Pure, synchronous | Yes | No | Shared merit budget pool, counters, flags |
| `SynchronizedRef` | Pure or effectful, serialised | Yes | No | Load-once comp band cache, HRIS refresh, state machines with async transitions |
| `SubscriptionRef` | Pure or effectful, serialised + published | Yes | Yes (`changes`) | Live headcount feed, reactive merit-cycle status, anything that drives a Stream |
| `MutableRef` | Synchronous, in-place | No | No | Single-fiber raise tallies, counters and flags in tight loops |
| `MutableList` | Synchronous, in-place | No | No | Raise recommendation batches, BFS of org hierarchy |
| `MutableHashMap` | Synchronous, in-place | No | No | Per-department raise tallies, comp band grouping, adjacency lists |
| `MutableHashSet` | Synchronous, in-place | No | No | Visited sets for org traversal, employee ID deduplication |

> **Rule of thumb:** Start with `Ref` for shared state in an Effect program; move to `SynchronizedRef` when the update itself is effectful, to `SubscriptionRef` when consumers need a stream, and to a `Mutable*` type for an encapsulated synchronous algorithm. None of these makes an arbitrary sequence of separate reads and writes atomic.
