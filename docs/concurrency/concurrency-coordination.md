# Concurrency & Coordination

Effect's coordination primitives let fibers share permits, queues, broadcasts, pooled resources, and replaceable scoped values without abandoning typed errors or structured concurrency. Start with `Semaphore`, `Queue`, or `PubSub`; use the partitioned, reference-counted, and scoped variants when ownership or lifecycle becomes the harder part.

> **Official guides:** the Semaphore, Queue, and PubSub guides are linked from the matching sections below. These track Effect's `main` branch rather than the pinned `rc.115` release, so where they differ, this page and the tagged source win.

Fork variants and fiber ownership live in [Core Runtime & Execution](../foundations/core-runtime-execution#fiber); stream-level buffering and backpressure live in [Streaming & Channels](./streaming-channels#stream). This page owns what happens *between* fibers: who waits, who is told "no", and what is lost.

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

Two placement rules decide whether a semaphore enforces anything:

- **Share one semaphore value among every caller that participates in the limit.** A semaphore constructed inside the job gives each job its own permits and limits nothing; build it once in a Layer or the wiring code and pass it down.
- **Wrap the scarce call only.** Parsing, validation, and mapping that happen before or after the HRIS request do not consume the quota, so holding a permit across them lowers throughput without protecting anything.

> **Note:** **`concurrency: "unbounded"` is justified only when something else is the bound.** Above, the collection is a fixed 20 elements and the semaphore caps the real work, so 20 mostly suspended fibers are harmless. Over input of unknown size the same option starts one fiber per element before any of them holds a permit. Give the traversal a number too, and derive both numbers from the resource being protected (vendor quota, pool size, sockets, CPU), not from whatever made a benchmark faster.

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

Official guide: [Semaphore](https://effect.website/docs/v4/concurrency/semaphore).

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

> **Note:** The key buys fairness, not isolation. Every partition draws from the same `permits` total, so one tenant can still hold all ten permits while nobody else is waiting. When each tenant needs its own independent ceiling, keep one plain `Semaphore` per key instead.

Use when a shared resource has multiple independent consumer categories and fairness across groups (not a single FIFO line) is required.

## Queue

`effect/Queue` — stable

A fiber-safe FIFO queue for passing values from producers to consumers: each value is delivered to exactly one taker. Supports bounded and unbounded variants, three overflow strategies, explicit end-of-stream signaling via `Queue.end`, and failure/interruption propagation.

**Decide what happens when the queue is full before you pick a constructor.** Overflow behavior is part of the queue's contract, not a tuning knob:

| Constructor | When full | What the producer observes | What is lost | Choose when |
| --- | --- | --- | --- | --- |
| `Queue.bounded(n)` | `offer` suspends until a consumer frees a slot | The producing fiber waits; `offer` then returns `true` | Nothing | Every value must be processed and the producer is an Effect that can wait |
| `Queue.dropping(n)` | The new value is rejected | `offer` returns `false`; `offerAll` returns the rejected remainder | The newest values | Shedding load is an accepted policy and you count what was shed |
| `Queue.sliding(n)` | The oldest buffered value is evicted | `offer` returns `true` — the eviction is **not** reported | The oldest values | Only the latest state matters (progress, presence, prices) |
| `Queue.unbounded()` | Never full | Nothing | Nothing, until memory runs out | The producer is already bounded by something else you can name |

`Queue.make({ capacity, strategy })` is the general constructor: omit `capacity` for an unbounded queue, and `strategy` defaults to `"suspend"`. `Queue.bounded(0)` is a rendezvous queue — it buffers nothing, and an `offer` completes only when a consumer takes the value. In every variant `offer` also returns `false` once the queue has ended, failed, or shut down.

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

### Consuming: the consumer picks its waiting policy

| Operator | Waits? | Returns |
| --- | --- | --- |
| `Queue.take(q)` | Until one value is available | `A`; fails with the queue's terminal error (`Cause.Done` after `end`) |
| `Queue.takeBetween(q, min, max)` | Only when fewer than `min` are buffered | At most `max` values; with `min` of `1` it is the "batch whatever is ready" operator |
| `Queue.takeN(q, n)` | As `takeBetween(q, n, n)` | `n` values when that many are already buffered (see the warning below) |
| `Queue.takeAll(q)` | Until at least one is available | A non-empty array of everything buffered (`takeBetween(q, 1, Infinity)`) |
| `Queue.poll(q)` | Never | `Option<A>`; `None` when empty or finished |
| `Queue.clear(q)` | Never | Everything buffered, possibly `[]` — the non-waiting drain |
| `Queue.peek(q)` | Until one value is available | The head, without removing it |
| `Queue.collect(q)` | Until the queue ends | Every value until `Cause.Done`; a queue failure fails the effect |

> **Warning:** In `rc.115` a `min` above `1` is honored only when that many values are already buffered. If `takeBetween` / `takeN` has to wait, it resumes on the next arrival and returns what is buffered then, which can be fewer than `min`; and on a queue that has already ended with fewer than `min` values left, it never completes. **Batch consumers of a queue that can end should use `takeBetween(q, 1, max)` or `takeAll` and check the length**, never rely on `takeN` for an exact batch.

`Queue.size(q)` and `Queue.isFull(q)` are snapshots for metrics and tests, not coordination: another fiber can change the answer before you act on it. After `Queue.end`, `size` keeps reporting the buffered values until consumers drain them.

```ts
import { Effect, Queue } from "effect"

// A payroll exporter that writes whatever is ready, up to 50 rows per batch.
const exportReadyRows = Effect.gen(function*() {
  const rows = yield* Queue.bounded<string>(500)
  yield* Queue.offerAll(rows, ["emp-001", "emp-002", "emp-003"])

  const probe = yield* Queue.poll(rows)               // Option.some("emp-001") — never waits
  const batch = yield* Queue.takeBetween(rows, 1, 50) // ["emp-002", "emp-003"] — waits only for the first
  const leftovers = yield* Queue.clear(rows)          // [] — nothing buffered, returns immediately
  return { probe, batch, leftovers }
})
```

> **Note:** `Queue.offerUnsafe` appends synchronously and releases waiting takers on a scheduled task. `Queue.flush(q)` (or `Queue.flushUnsafe(q)`) runs that release pass immediately — useful in an adapter that offers from a synchronous callback and wants consumers woken before it returns.

### Put queue roles in function signatures

**Producers accept `Queue.Enqueue<A, E>`, consumers accept `Queue.Dequeue<A, E>`, and only the wiring code sees the full `Queue`.** `Queue.offer` takes an `Enqueue` and `Queue.take` takes a `Dequeue`, so the compiler enforces the protocol: a scheduler cannot take work back, and a worker cannot quietly enqueue follow-up jobs. A full `Queue` is assignable to either role, so call sites need no conversion.

`Stream.fromQueue` and `Queue.collect` are the default consumers. When a worker needs a bespoke loop, take in a `while (true)` and close the loop on `Cause.Done`: `Queue.end` lets buffered values drain, the next `take` fails with `Cause.Done`, and `Effect.catchIf(Cause.isDone, …)` removes it from the error channel.

```ts
import { Cause, Effect, Fiber, Queue } from "effect"

interface RaiseApproval {
  readonly employeeId: string
  readonly amountUsd: number
}

// Write-only role: this function cannot take from the queue.
const produce = (
  outbox: Queue.Enqueue<RaiseApproval, Cause.Done>,
  approvals: ReadonlyArray<RaiseApproval>
) =>
  Queue.offerAll(outbox, approvals).pipe(
    Effect.andThen(Queue.end(outbox))
  )

// Read-only role: this function cannot offer follow-up work.
const consume = (
  inbox: Queue.Dequeue<RaiseApproval, Cause.Done>,
  handle: (approval: RaiseApproval) => Effect.Effect<void>
) =>
  Effect.gen(function*() {
    while (true) {
      yield* handle(yield* Queue.take(inbox))
    }
  }).pipe(
    // Done is the protocol's normal ending, not a failure of this worker.
    Effect.catchIf(Cause.isDone, () => Effect.void)
  )

// Only the wiring code holds the full Queue.
const program = Effect.gen(function*() {
  const queue = yield* Queue.bounded<RaiseApproval, Cause.Done>(64)
  const worker = yield* consume(queue, (approval) =>
    Effect.log(`applying raise for ${approval.employeeId}`)
  ).pipe(Effect.forkChild)

  yield* produce(queue, [
    { employeeId: "emp-001", amountUsd: 4_000 },
    { employeeId: "emp-002", amountUsd: 2_500 }
  ])
  yield* Fiber.join(worker) // join before the owning scope exits
})
```

### Make loss observable

**A suspend strategy only exerts pressure on a producer that is itself an Effect and can wait on `Queue.offer`.** A synchronous callback — a driver hook, an event emitter, a webhook SDK listener — cannot wait. `Queue.offerUnsafe` on a full `bounded` queue does not suspend anyone; it returns `false` and the value is gone. Any bounded buffer in front of such a producer is therefore a loss policy whether or not it is named one, so do not describe that adapter as backpressured.

The practice: choose `dropping` or `sliding` explicitly, count what was shed, and document the loss.

- **Dropping:** the boolean from `offer` / `offerUnsafe` is the signal.
- **Sliding:** `offer` returns `true` even when it evicts, so check `Queue.isFullUnsafe` immediately before `Queue.offerUnsafe` in the same synchronous callback; a full queue means this offer evicts one value.

```ts
import { Effect, Metric, Queue } from "effect"

interface HrisChange {
  readonly employeeId: string
}

// The HRIS SDK pushes changes through a listener it never awaits.
declare const onHrisChange: (listener: (change: HrisChange) => void) => void

const shed = Metric.counter("hris_changes_shed_total", { incremental: true })

const hrisChanges = Effect.gen(function*() {
  const changes = yield* Queue.dropping<HrisChange>(1_024)
  const context = yield* Effect.context<never>()

  onHrisChange((change) => {
    if (!Queue.offerUnsafe(changes, change)) {
      shed.updateUnsafe(1, context) // loss is a metric, not a silent overflow
    }
  })

  // Consumers only ever see the read side.
  return Queue.asDequeue(changes)
})

// An Effect producer can use the same signal without the unsafe API.
const offerOrCount = <A>(queue: Queue.Enqueue<A>, value: A) =>
  Queue.offer(queue, value).pipe(
    Effect.tap((accepted) => accepted ? Effect.void : Metric.update(shed, 1))
  )
```

"No loss" plus "the producer cannot slow down" is inconsistent without durable storage or admission control upstream. `Stream.callback` builds the same kind of queue from its `{ bufferSize, strategy }` options; see [Streaming & Channels](./streaming-channels#stream) for the stream-side policy.

### Queue lifecycle: who ends it, and what a failure does

Decide three things when you create a queue: who owns it and its worker fibers, who signals the end, and whether shutdown drains or discards.

- **A producer failure must not strand consumers.** A consumer blocked in `take` learns nothing from a producer fiber that died. Propagate a terminal signal: `Queue.end` for normal completion, `Queue.fail(q, error)` for a typed failure (both let buffered values drain first), or wrap the producer with `Queue.into(q)`, which ends the queue on success and fails it with the producer's cause otherwise.
- **`Queue.shutdown` discards the buffer and interrupts every fiber parked on `offer`, `take`, or `Queue.await`.** Reserve it for abandoning work. The full termination table is in [Structured Concurrency Through a Bounded Worker](../deep-dives/structured-concurrency-through-a-bounded-worker).
- **Test with capacity `1`.** Large buffers hide deadlocks and ordering bugs that a one-slot queue exposes immediately. Also interrupt a blocked `offer` and a blocked `take` and assert the next value still reaches a live consumer.
- **An in-memory queue is lost with the process.** Work that must survive a restart belongs in [PersistedQueue](../tooling/persistence#persistedqueue) or an outbox table.

```ts
import { Cause, Effect, Queue, Schema } from "effect"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()(
  "HrisUnavailable",
  { status: Schema.Int }
) {}

declare const loadEmployeeIds: Effect.Effect<ReadonlyArray<string>, HrisUnavailable>

const program = Effect.gen(function*() {
  const queue = yield* Queue.bounded<string, HrisUnavailable | Cause.Done>(100)

  // Success ends the queue; HrisUnavailable fails it. Either way consumers wake up.
  yield* loadEmployeeIds.pipe(
    Effect.flatMap((ids) => Queue.offerAll(queue, ids)),
    Queue.into(queue),
    Effect.forkChild
  )

  // Every id, or the producer's HrisUnavailable — never a consumer that waits forever.
  return yield* Queue.collect(queue)
})
```

Smells worth a second look in review: `Queue.unbounded` chosen because a test hung, "exactly once" inferred from one happy-path run, and a poison job re-offered to the same in-memory queue forever.

Use for producer-consumer decoupling with back-pressure inside a single process: batch pipelines, worker pools, actor-style mailboxes, rate-limited ingestion.

Official guides: [Queue](https://effect.website/docs/v4/concurrency/queue) (its `takeAll` description and `takeUpTo` heading do not match `rc.115` — use the table above — and it predates the `Queue<A, E>` completion protocol); the callback constructor in [Creating Streams](https://effect.website/docs/v4/stream/creating) drives the same `offerUnsafe` / `endUnsafe` / `failCauseUnsafe` API.

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

### Delivery semantics: Queue or PubSub

Name the delivery you need before choosing; most "missing event" and "duplicated work" bugs come from picking the wrong column.

| Question | `Queue` | `PubSub` |
| --- | --- | --- |
| Who receives a value? | Exactly one taker; competing consumers split the work | Every subscriber that is subscribed at publish time gets its own copy |
| A consumer joins late | It takes whatever is still buffered | It sees only later messages, plus the last `replay` messages if configured |
| Nobody is listening | Values wait in the buffer | `publish` returns `true` and the message is discarded (only a replay buffer keeps it) |
| One consumer is slow | The others keep taking | The slowest subscriber fills the shared buffer and triggers the overflow strategy for everyone |
| How it ends | `end` / `fail` let consumers drain, then takers see `Cause.Done` or the error | Only `shutdown`: pending takes are interrupted; there is no typed completion signal |
| Durability | In memory; gone on restart | In memory; gone on restart — not an event log |

A message is retained until every current subscriber has taken it, which is why one lagging subscriber is enough to fill a `bounded` PubSub.

### Overflow strategies and the publish result

Overflow strategies mirror `Queue`: `PubSub.bounded` suspends publishers while any subscriber lags by a full buffer; `PubSub.dropping` discards the new message for every subscriber and `publish` returns `false`; `PubSub.sliding` evicts the oldest message — only lagging subscribers miss it — and `publish` still returns `true`. `PubSub.unbounded` never pushes back and grows with the slowest subscriber. Use `bounded` for correctness (e.g., audit log), `sliding` for latest-state, `dropping` for acceptable load shedding.

**Treat `dropping` and `sliding` as stated loss policies, never as performance switches**, and make the loss visible. As with [Queue](#make-loss-observable), suspension only works for a publisher that is an Effect; `PubSub.publishUnsafe` from a synchronous callback returns `false` on a full `bounded` PubSub instead of waiting. `publish` also returns `false` after `shutdown`.

### Reading a subscription directly

`Stream.fromPubSub` is the default consumer. Tests, batch readers, and load-shedding code sometimes need the lower-level protocol: open a scoped `PubSub.Subscription` **first**, then publish, then read. A subscription is not a `Queue.Dequeue`; read it with `PubSub.take` (waits for one), `PubSub.takeAll` (waits for at least one), `PubSub.takeBetween(sub, min, max)`, `PubSub.takeUpTo(sub, max)` (never waits, may return `[]`), and `PubSub.remaining(sub)`. Wrap one as a stream with `Stream.fromSubscription`.

```ts
import { Effect, Metric, PubSub } from "effect"

const dropped = Metric.counter("merit_events_dropped_total", { incremental: true })

// Publish, and turn a shed message into a number someone can alert on.
const publishOrCount = <A>(bus: PubSub.PubSub<A>, event: A) =>
  PubSub.publish(bus, event).pipe(
    Effect.tap((accepted) => accepted ? Effect.void : Metric.update(dropped, 1))
  )

const program = Effect.scoped(Effect.gen(function*() {
  const bus = yield* PubSub.dropping<string>(1)
  const inbox = yield* PubSub.subscribe(bus) // subscribe before publishing

  const kept = yield* publishOrCount(bus, "cycle-opened") // true
  const shed = yield* publishOrCount(bus, "cycle-closed") // false: buffer full, counted
  const first = yield* PubSub.take(inbox)                 // "cycle-opened"
  const pending = yield* PubSub.remaining(inbox)          // 0

  return { kept, shed, first, pending }
}))
```

`PubSub.publishAll(bus, events)` publishes a batch. `PubSub.capacity(bus)` is a plain number, while `PubSub.size(bus)` is an effect that reports messages still held for at least one subscriber. `PubSub.shutdown` interrupts every pending `take`; observe it with `PubSub.isShutdown` or `PubSub.awaitShutdown`.

### Proving a subscription did not leak

A scoped subscription is a claim you can test: once the subscribing scope closes, the bus must hold nothing on behalf of the departed subscriber. `PubSub.size` returning to its baseline is a cheap regression test for listener-array style leaks.

```ts
import { assert, it } from "@effect/vitest"
import { Effect, PubSub } from "effect"

it.effect("a closed subscription retains nothing", () =>
  Effect.gen(function*() {
    const bus = yield* PubSub.bounded<string>(16)

    yield* Effect.scoped(Effect.gen(function*() {
      yield* PubSub.subscribe(bus)
      yield* PubSub.publish(bus, "cycle-opened")
      assert.strictEqual(yield* PubSub.size(bus), 1) // held for the live subscriber
    }))

    yield* PubSub.publish(bus, "cycle-closed")
    assert.strictEqual(yield* PubSub.size(bus), 0) // nobody left to hold it for
  }))
```

Use for one-to-many event fan-out within a process where multiple independent consumers should each see every message.

Official guide: [PubSub](https://effect.website/docs/v4/concurrency/pubsub) (its prose calls the subscription a `Dequeue`; in `rc.115` it is a `PubSub.Subscription` read with `PubSub.take`, and the guide omits the `{ capacity, replay }` constructor form).

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

// One operation: Pool.use borrows an item, runs the effect, and returns the
// item on success, failure, or interruption — no Scope required.
const fetchEmployee = (id: string) =>
  Effect.gen(function*() {
    const pool = yield* HrisPool
    return yield* Pool.use(pool, (conn) => conn.fetchEmployee(id))
  })

// Several steps on the same connection: Pool.get lends it to the current Scope
// and returns it when that Scope closes.
const fetchManagerAndReport = (managerId: string, reportId: string) =>
  Effect.scoped(
    Effect.gen(function*() {
      const pool = yield* HrisPool
      const conn = yield* Pool.get(pool)
      const manager = yield* conn.fetchEmployee(managerId)
      const report = yield* conn.fetchEmployee(reportId)
      return { manager, report }
    })
  )
```

| Borrowing API | Lifetime of the loan | Requirements |
| --- | --- | --- |
| `Pool.use(pool, f)` | Exactly the effect returned by `f` | none — prefer it for a single operation |
| `Pool.get(pool)` | Until the surrounding `Scope` closes | `Scope` |
| `Pool.reserve(pool, item)` | Takes an already-leased item out of shared circulation until the `Scope` closes; only meaningful when `concurrency > 1` | `Scope` |

Both `use` and `get` wait when every item is busy and the pool is at `max`, and fail with the acquisition error `E` when creating a new item fails. After the pool's scope closes they are interrupted.

The `concurrency` option allows multiple fibers to share a single pooled item simultaneously — useful for thread-safe libraries where serialization is not needed. Set `targetUtilization` to control how full existing items must be before a new one is created; it defaults to `1` and the implementation clamps it to the inclusive range `0.1`–`1`.

### TTL is not a health check

- **`timeToLive` bounds idle capacity, not item health.** With the default `timeToLiveStrategy: "usage"`, each TTL interval reclaims items in excess of current demand and never shrinks below `min`. With `"creation"`, every item — including the `min` ones — is retired `timeToLive` after it was acquired and replaced, which is the setting for credentials or connections that must be recycled by age. Neither says anything about whether a checked-out item still works.
- **Invalidate only a resource you believe is broken.** `Pool.invalidate(pool, item)` is for a dead socket or a corrupted session. An ordinary query failure or domain error should surface as a typed error and leave the item in the pool; recycling on every failure turns one bad request into connection churn.
- **`invalidate` matches by identity (`===`)**, so pass the borrowed value itself. Invalidating an item that is still on loan starts its replacement immediately and runs the old item's finalizer once the last borrower returns it.
- **Validate pool bounds before constructing the pool.** Decode `min`, `max`, and `timeToLive` from configuration into a typed startup failure; a nonsensical size should never reach `acquire`.
- **Test TTL with virtual time.** Build the scoped pool under `TestClock`, borrow a burst, `TestClock.adjust` past the TTL, and assert on acquire/release counters.

```ts
import { Effect, Pool, Schema } from "effect"
import type { Scope } from "effect"

class ConnectionLost extends Schema.TaggedError<ConnectionLost>()("ConnectionLost", {}) {}

class QueryRejected extends Schema.TaggedError<QueryRejected>()("QueryRejected", {
  reason: Schema.String
}) {}

interface HrisConnection {
  readonly query: (sql: string) => Effect.Effect<ReadonlyArray<unknown>, ConnectionLost | QueryRejected>
}

declare const connect: Effect.Effect<HrisConnection, ConnectionLost, Scope.Scope>

const makeQuery = Effect.gen(function*() {
  const pool = yield* Pool.makeWithTTL({
    acquire: connect,
    min: 2,
    max: 10,
    timeToLive: "30 seconds"
  })

  return (sql: string) =>
    Pool.use(pool, (conn) =>
      conn.query(sql).pipe(
        // Only a broken transport retires the connection.
        // QueryRejected stays a typed failure and the connection stays pooled.
        Effect.tapErrorTag("ConnectionLost", () => Pool.invalidate(pool, conn))
      ))
})
```

`pool.config`, `pool.state`, and `Pool.PoolItem` exist for custom `Pool.Strategy` implementations. Their fields changed during the release candidates (the pool now tracks a usage counter and a linked list of available items), so application code should not read them.

Use when expensive resource acquisition (connections, client handles, API sessions) must be amortized across many fibers with automatic lifecycle management.

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

`RcMap.keys(map)` inspects active keys. `RcMap.invalidate(map, key)` forces re-acquisition on next use. `touch` resets a key's idle TTL without using the resource. `RcMap.getOption(map, key)` borrows an entry only if it already exists: it returns `Option.none()` without running `lookup` for an absent key, and otherwise retains the entry for the current `Scope` exactly like `get` — useful for "flush the regional client if one is open" paths that must not open a connection just to close it.

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
