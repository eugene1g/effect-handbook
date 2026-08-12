# Concurrency & Coordination

Effect's coordination primitives let fibers share permits, queues, broadcasts, pooled resources, and replaceable scoped values without abandoning typed errors or structured concurrency. Start with `Semaphore`, `Queue`, or `PubSub`; use the partitioned, reference-counted, and scoped variants when ownership or lifecycle becomes the harder part.

## Semaphore

`effect/Semaphore` — stable

A counting semaphore with a fixed permit pool. Fibers that need to do work acquire one or more permits; if none are free they suspend in FIFO order until permits are released.

`withPermits(n)(effect)` acquires n permits, runs the effect, and releases them on success, failure, or interruption. `withPermit` is the single-permit mutual-exclusion alias. `withPermitsIfAvailable` is the non-blocking variant that runs only if permits are currently free.

For a lower-level protocol, `take(n)` manually acquires permits and `release(n)` returns them; `takeIfAvailable(n)` returns `false` immediately without acquiring when the count is unavailable. Prefer the bracketed `with*` helpers unless ownership genuinely spans multiple operations, because manual acquisition must be released on every exit.

```ts
import { Effect, Semaphore } from "effect"

// Cap concurrent calls to the HRIS API at 5 — HRIS rate-limits at 10 rps
// and we share the quota across multiple services.
const program = Effect.gen(function*() {
  const sem = yield* Semaphore.make(5)

  // sem.withPermit(task) acquires 1 permit, runs the task, then releases.
  const fetchEmployee = (id: string) =>
    sem.withPermit(Effect.gen(function*() {
      yield* Effect.log(`fetching employee ${id} from HRIS`)
      // ... real HRIS HTTP call here
      return { id, name: "Alice Example", level: 6 }
    }))

  // Fire 20 lookups at once; at most 5 hit the HRIS simultaneously.
  const ids = Array.from({ length: 20 }, (_, i) => `emp-${i}`)
  const employees = yield* Effect.all(ids.map(fetchEmployee), { concurrency: "unbounded" })
  yield* Effect.log(`loaded ${employees.length} employees`)
})
```

For the non-blocking variant:

```ts
import { Effect, Option, Semaphore } from "effect"

// Try to push a real-time payroll recalculation — skip if the slot is taken.
const tryRecalculate = (sem: Semaphore.Semaphore, employeeId: string) =>
  sem.withPermitsIfAvailable(1)(
    Effect.log(`recalculating payroll for ${employeeId}`)
  )

const program = Effect.gen(function*() {
  const sem = yield* Semaphore.make(1)
  const result = yield* tryRecalculate(sem, "emp-42")
  // Option.Some(void) if a permit was free; Option.None if the slot was busy
  yield* Effect.log(Option.isSome(result) ? "recalculation queued" : "skipped — already running")
})
```

Use when you need global concurrency limiting — "at most N concurrent fibers" — across many fibers sharing one semaphore.

## PartitionedSemaphore

`effect/PartitionedSemaphore` — stable

A semaphore with a shared permit pool where waiters are grouped by a partition key. Released permits are distributed to waiting partitions in round-robin order (not global FIFO), preventing any one busy partition from starving others.

API mirrors plain `Semaphore` but every acquire/wrap call takes a partition key first. `PartitionedSemaphore.make` takes `{ permits }`; the type parameter `K` is the partition key type.

```ts
import { Effect, PartitionedSemaphore } from "effect"

// 10 shared HRIS API permits split fairly across department IDs.
const program = Effect.gen(function*() {
  const sem = yield* PartitionedSemaphore.make<string>({ permits: 10 })

  // sem.withPermit(key) acquires 1 permit for that partition key.
  const fetchPayrollForDept = (deptId: string, work: Effect.Effect<void>) =>
    sem.withPermit(deptId)(work)

  // engineering and facilities share the same 10 permits fairly;
  // neither partition starves the other when releases occur.
  yield* Effect.all([
    fetchPayrollForDept("engineering", Effect.log("eng: bulk adjustment")),
    fetchPayrollForDept("engineering", Effect.log("eng: another adjustment")),
    fetchPayrollForDept("facilities",  Effect.log("fac: quick adjustment"))
  ], { concurrency: "unbounded" })
})
```

`sem.withPermits(key, n)(effect)` acquires n permits for a key. `withPermitsIfAvailable` remains available for non-blocking checks against the shared pool without a partition key.

Use when a shared resource has multiple independent consumer categories and fairness across groups (not a single FIFO line) is required.

## Queue

`effect/Queue` — stable

A fiber-safe FIFO queue for passing values from producers to consumers. Supports bounded and unbounded variants, three back-pressure strategies, explicit end-of-stream signaling via `Queue.end`, and failure/interruption propagation.

- **bounded** — Fixed capacity. Producers suspend when full. Downstream controls the pace.
- **sliding** — Fixed capacity. When full, oldest item is silently dropped. Use for "latest value wins" patterns.
- **dropping** — Fixed capacity. When full, new offers are rejected (return `false`). Use when shedding load is correct.
- **unbounded** — No capacity limit. Producers never block. Use carefully — can exhaust memory if consumers lag.

```ts
import { Cause, Effect, Queue } from "effect"

// Payroll batch work queue: producer loads employee IDs from HRIS,
// consumers process each payroll calculation in parallel.
const program = Effect.gen(function*() {
  // 500-slot bounded queue; producer back-pressures when full
  const queue = yield* Queue.bounded<string, Cause.Done>(500)

  // Producer fiber: enqueue employee IDs for this pay cycle, then signal done
  yield* Effect.forkChild(Effect.gen(function*() {
    const employeeIds = ["emp-001", "emp-002", "emp-003"] // from HRIS in practice
    yield* Queue.offerAll(queue, employeeIds)
    yield* Queue.end(queue)
  }))

  // Consumer: drain all items until the queue signals Done
  const processed = yield* Queue.collect(queue)
  yield* Effect.log(`payroll batch complete: ${processed.length} employees processed`)
})
```

`Queue` splits into `Enqueue` (write-only) and `Dequeue` (read-only) interfaces. Use `Queue.asEnqueue(q)` for producers and `Queue.asDequeue(q)` for consumers. Consume as a `Stream` with `Stream.fromQueue(queue)`; the stream ends when the queue ends.

Use for producer-consumer decoupling with back-pressure inside a single process: batch pipelines, worker pools, actor-style mailboxes, rate-limited ingestion.

## PubSub

`effect/PubSub` — stable

An in-process publish/subscribe bus. Producers call `PubSub.publish`; every active subscriber receives a copy. Unlike `Queue` (one message to one consumer), `PubSub` fans every message to all subscribers simultaneously. Late subscribers miss messages unless a replay buffer is configured.

Subscriptions are scoped: `PubSub.subscribe` returns a `Subscription` cleaned up when the surrounding scope closes. Use `Stream.fromPubSub(pubsub)` for managed subscribe/unsubscribe lifecycle.

```ts
import { Context, Effect, Layer, PubSub, Stream } from "effect"

// Domain event for the annual merit cycle
type MeritCycleEvent =
  | { readonly _tag: "CycleOpened";  readonly cycleId: string; readonly budgetUsd: number }
  | { readonly _tag: "RaiseApproved"; readonly cycleId: string; readonly employeeId: string }
  | { readonly _tag: "CycleClosed";  readonly cycleId: string }

// Expose the PubSub as an Effect service
export class MeritCycleEvents extends Context.Service<MeritCycleEvents, {
  publish(event: MeritCycleEvent): Effect.Effect<void>
  readonly subscribe: Stream.Stream<MeritCycleEvent>
}>()("hr/MeritCycleEvents") {
  static readonly layer = Layer.effect(
    MeritCycleEvents,
    Effect.gen(function*() {
      const pubsub = yield* PubSub.bounded<MeritCycleEvent>({
        capacity: 256,
        replay: 50  // late subscribers see the last 50 events on connect
      })

      // Shut down the bus when the layer is released
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

      const publish = Effect.fn("MeritCycleEvents.publish")(function*(event: MeritCycleEvent) {
        yield* PubSub.publish(pubsub, event)
      })

      // Each Stream.fromPubSub call creates its own independent subscription
      const subscribe = Stream.fromPubSub(pubsub)

      return MeritCycleEvents.of({ publish, subscribe })
    })
  )
}

// Subscriber: notify managers when a raise for one of their reports is approved
const managerNotifier = Effect.gen(function*() {
  const events = yield* MeritCycleEvents
  yield* events.subscribe.pipe(
    Stream.filter((e) => e._tag === "RaiseApproved"),
    Stream.tap((e) => Effect.log(`raise approved for employee ${e.employeeId}`)),
    Stream.runDrain
  )
})
```

Back-pressure strategies mirror `Queue`: `PubSub.bounded` suspends publishers when any subscriber is slow; `PubSub.dropping` drops messages when the buffer is full; `PubSub.sliding` evicts the oldest. Use `bounded` for correctness (e.g., audit log), `sliding` for latest-state, `dropping` for acceptable load shedding.

Use for one-to-many event fan-out within a process where multiple independent consumers should each see every message.

## Pool

`effect/Pool` — stable

A managed pool of scoped resources. A fixed pool preallocates its configured size asynchronously; an elastic pool preallocates `min` and grows toward `max` on demand. It lends items through a fiber's `Scope` and reclaims idle elastic items after a configurable TTL. `Pool.invalidate` removes a broken item so the next borrower gets a fresh one.

| Constructor | When to use |
| --- | --- |
| `Pool.make({ acquire, size })` | Fixed-size pool. Items are acquired eagerly up to `size`. Requires a `Scope`. |
| `Pool.makeWithTTL({ acquire, min, max, timeToLive })` | Elastic pool. Grows to `max` under load; shrinks idle items after TTL. Requires a `Scope`. |
| `Pool.makeWithStrategy({ ... })` | Full control over resizing and reclamation via a custom `Strategy`. Requires a `Scope`. |

```ts
import { Context, Duration, Effect, Layer, Pool, Scope } from "effect"

// A thin wrapper around a live HRIS HTTP session
interface HrisConnection {
  readonly fetchEmployee: (id: string) => Effect.Effect<{ id: string; name: string }>
  readonly close: Effect.Effect<void>
}

const acquireHrisConnection: Effect.Effect<HrisConnection, never, Scope.Scope> =
  Effect.acquireRelease(
    Effect.succeed<HrisConnection>({
      fetchEmployee: (id) => Effect.succeed({ id, name: `Employee ${id}` }),
      close: Effect.void
    }),
    (conn) => conn.close
  )

// Service tag for the pool
export class HrisPool extends Context.Service<HrisPool, Pool.Pool<HrisConnection>>()("hr/HrisPool") {
  // Elastic pool: keep 2 warm connections, allow up to 10 under load,
  // reclaim idle connections after 30 s.
  static readonly layer = Layer.effect(
    HrisPool,
    Pool.makeWithTTL({
      acquire: acquireHrisConnection,
      min: 2,
      max: 10,
      timeToLive: Duration.seconds(30)
    })
  )
}

// Usage: Pool.get requires a Scope and returns the connection back on scope close
const fetchEmployee = (id: string) =>
  Effect.gen(function*() {
    const pool = yield* HrisPool
    return yield* Effect.scoped(
      Effect.gen(function*() {
        const conn = yield* Pool.get(pool)
        return yield* conn.fetchEmployee(id)
      })
    )
  })
```

The `concurrency` option allows multiple fibers to share a single pooled item simultaneously — useful for thread-safe libraries where serialization is not needed. Set `targetUtilization` to control how full existing items must be before a new one is created; it defaults to `1` and the implementation clamps it to the inclusive range `0.1`–`1`.

Use when expensive resource acquisition (connections, client handles, API sessions) must be amortized across many fibers with automatic lifecycle and health management.

## RcRef

`effect/RcRef` — stable

A reference-counted handle for a single scoped resource. The resource is acquired lazily on the first `RcRef.get`, shared among all active borrowers, and finalized when the last borrower's scope closes. An optional `idleTimeToLive` keeps it alive after all borrows end to avoid churn.

Each `RcRef.get` increments the count; closing the borrowing scope decrements it; when the count hits zero the resource is released.

```ts
import { Duration, Effect, RcRef } from "effect"

// One shared PayrollClient across many concurrent payroll calculations.
// The client is expensive to create (auth handshake), so we share it.
const program = Effect.scoped(
  Effect.gen(function*() {
    const clientRef = yield* RcRef.make({
      acquire: Effect.acquireRelease(
        Effect.succeed({ run: (cmd: string) => Effect.log(`payroll> ${cmd}`) }),
        (_client) => Effect.log("PayrollClient disconnected")
      ),
      idleTimeToLive: Duration.seconds(30) // stay open 30 s after last borrow
    })

    // Two fibers share the same client; it is acquired exactly once.
    yield* Effect.all([
      Effect.scoped(Effect.gen(function*() {
        const client = yield* RcRef.get(clientRef)
        yield* client.run("PROCESS emp-001 cycle-2025")
      })),
      Effect.scoped(Effect.gen(function*() {
        const client = yield* RcRef.get(clientRef)
        yield* client.run("PROCESS emp-002 cycle-2025")
      }))
    ], { concurrency: 2 })

    // After both scopes close, the idle timer starts.
    // "PayrollClient disconnected" is logged 30 s later (or immediately if no TTL).
  })
)
```

`RcRef.invalidate(ref)` forces the next `get` to acquire a fresh resource. Existing borrows are unaffected and keep their already-acquired value until their scope closes.

Use when multiple concurrent scopes need to share one expensive resource and you want automatic acquire-on-first-use and release-when-idle without a full pool.

## RcMap

`effect/RcMap` — stable

Like `RcRef`, but keyed. An `RcMap<K, A>` runs a `lookup` effect the first time a given key is requested, shares the resource among all active borrows for that key, and releases it when the last borrow closes (with optional idle TTL). Multiple keys are fully independent with separate reference counts. An optional `capacity` caps live entries; exceeding it fails with `Cause.ExceededCapacityError`.

```ts
import { Duration, Effect, RcMap } from "effect"

// One PayrollClient per region — clients authenticate against a regional endpoint.
interface PayrollClient {
  readonly run: (cmd: string) => Effect.Effect<string>
  readonly close: Effect.Effect<void>
}

const connectToRegion = (region: string): Effect.Effect<PayrollClient, never, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    Effect.succeed<PayrollClient>({
      run: (cmd) => Effect.succeed(`[${region}] ${cmd} ok`),
      close: Effect.log(`disconnected payroll client for region ${region}`)
    }),
    (c) => c.close
  )

const program = Effect.scoped(
  Effect.gen(function*() {
    const clients = yield* RcMap.make({
      lookup: connectToRegion,
      idleTimeToLive: Duration.minutes(5), // keep idle regional clients warm
      capacity: 10                         // at most 10 regional clients alive
    })

    // Two fibers borrow the "us-east" client — one connection, shared
    yield* Effect.all([
      Effect.scoped(Effect.gen(function*() {
        const client = yield* RcMap.get(clients, "us-east")
        return yield* client.run("PROCESS cycle-2025 batch-1")
      })),
      Effect.scoped(Effect.gen(function*() {
        const client = yield* RcMap.get(clients, "us-east")
        return yield* client.run("PROCESS cycle-2025 batch-2")
      }))
    ], { concurrency: 2 })

    // "us-east" client stays live for 5 min after last borrow, then disconnects.
  })
)
```

`RcMap.keys(map)` inspects active keys. `RcMap.invalidate(map, key)` forces re-acquisition on next use. `touch` resets a key's idle TTL without using the resource.

Use for per-key resource management where keys are dynamic and resources should be released when no longer needed.

## ScopedRef

`effect/ScopedRef` — stable

A `Ref` whose value owns a `Scope`. Setting a new value first acquires the replacement in a fresh scope, then finalizes the old scope, and only then publishes the replacement. Reads are lock-free and synchronous; writes are serialized (one swap at a time).

```ts
import { Effect, ScopedRef } from "effect"

interface PayrollClient {
  readonly endpoint: string
  readonly run: (cmd: string) => Effect.Effect<void>
}

const acquireClient = (endpoint: string): Effect.Effect<PayrollClient, never, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    Effect.succeed<PayrollClient>({
      endpoint,
      run: (cmd) => Effect.log(`[${endpoint}] ${cmd}`)
    }),
    (c) => Effect.log(`closing client for ${c.endpoint}`)
  )

// ScopedRef.fromAcquire requires a Scope; wrap in Effect.scoped to provide one.
const program = Effect.scoped(
  Effect.gen(function*() {
    // Start with the primary regional payroll endpoint
    const clientRef = yield* ScopedRef.fromAcquire(acquireClient("payroll-us-east.internal"))

    // Read the current value — lock-free and synchronous
    const current = yield* ScopedRef.get(clientRef)
    yield* Effect.log(`connected to ${current.endpoint}`)

    // Hot-swap to the DR endpoint — acquire new, close old, then publish new
    yield* ScopedRef.set(clientRef, acquireClient("payroll-us-east-dr.internal"))

    const updated = yield* ScopedRef.get(clientRef)
    yield* Effect.log(`failed over to ${updated.endpoint}`)
    // Logs: "closing client for payroll-us-east.internal"
    //       "failed over to payroll-us-east-dr.internal"
  })
)
```

The `set` operation is uninterruptible by default. If replacement acquisition fails, its fresh scope is closed and the old value remains current. During a successful swap the newly acquired resource and the still-current old resource can both be live briefly while the old scope closes; readers continue to see the old value until the final assignment. This is atomic visibility, not zero-overlap resource lifetime.

`ScopedRef.make(() => value)` for a plain initial constant. `ScopedRef.fromAcquire(effect)` when the initial value requires resource acquisition. Both constructors require a `Scope` in the environment — wrap with `Effect.scoped` or run inside a scoped layer.

Use when a long-lived, resource-backed value must occasionally be replaced and the swap must be atomic and leak-free.
