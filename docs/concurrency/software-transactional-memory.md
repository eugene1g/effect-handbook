# Software Transactional Memory

> **Note:** Every transactional operation runs inside a boundary created by `Effect.tx`. There is no `Effect.atomic` and no `Effect.transaction` — just `Effect.tx(effect)`. The *outermost* `Effect.tx` opens the journal and commits (or rolls back) the whole thing; nested `Effect.tx` calls transparently join the parent transaction instead of starting a new one. To make a transaction block until some condition holds — say, until enough merit budget is free — call `Effect.txRetry`.

## The mental model

A transaction is an **optimistic**, **composable**, **all-or-nothing** block of reads and writes over transactional cells (`TxRef` and the collections built on it).

- **Journaled, not in-place.** Reads and writes go to a per-transaction journal recording version + value of every `TxRef` touched. Other fibers never see uncommitted writes.
- **Optimistic commit.** At commit time the runtime checks every journaled ref's `version` against the live ref. If nothing changed, it commits atomically (bumps versions, wakes waiters). If a ref changed underneath, the transaction is discarded and re-run from scratch.
- **Retry = block until change.** `Effect.txRetry` suspends the transaction; it wakes only when one of the refs it read is committed by another fiber, then retries. Zero busy-waiting.
- **Optimistic state does not acquire locks.** Transactions over `TxRef` and its collections resolve conflicts by retrying instead of waiting while holding a lock. Effect also exposes the explicit `TxReentrantLock`; once you coordinate several such locks, ordinary lock-ordering discipline still matters and deadlock is possible.

### The canonical example: draw down a shared merit budget

```ts
import { Effect, TxRef } from "effect"

const program = Effect.gen(function*() {
  // Department merit pool (in whole dollars) and one employee's allocation.
  const budget = yield* TxRef.make(50_000)
  const aliceRaise = yield* TxRef.make(0)

  // One atomic transaction: debit the pool + record the raise commit together.
  const recommendRaise = (
    pool: TxRef.TxRef<number>,
    allocation: TxRef.TxRef<number>,
    amount: number
  ) =>
    Effect.tx(Effect.gen(function*() {
      const remaining = yield* TxRef.get(pool)
      // Not enough budget yet? Suspend and retry when the pool next changes.
      if (remaining < amount) {
        return yield* Effect.txRetry
      }
      yield* TxRef.update(pool, (b) => b - amount)
      yield* TxRef.update(allocation, (b) => b + amount)
    }))

  yield* recommendRaise(budget, aliceRaise, 8_000)

  console.log(yield* TxRef.get(budget))     // 42000
  console.log(yield* TxRef.get(aliceRaise)) // 8000
})
```

`if (remaining < amount) return yield* Effect.txRetry` is the entire condition-variable mechanism — if the pool is exhausted the fiber parks and wakes when any fiber commits a change to that ref, then re-checks. Two concurrent transactions conflict: the optimistic engine retries the loser; the pool never goes negative.

> **Tip:** Most `Tx*` operations are *self-transactional*: a lone `yield* TxQueue.offer(q, rec)` runs in its own implicit one-shot transaction. Group several under one `Effect.tx` to commit them together. Constructors like `TxRef.make` return an `Effect` (use `yield*`); the `makeUnsafe` variants build synchronously outside an Effect.

## TxRef

`effect/TxRef` — stable

The atom of STM: a single mutable cell whose reads and writes participate in a transaction. Every other `Tx*` structure is one or more `TxRef`s under the hood.

**Mental model.** `Ref`, but transaction-aware. `TxRef.update` inside `Effect.tx` is atomic across *all* refs in the block, with automatic conflict retry. Reading a `TxRef` records it in the journal, enabling `txRetry` to wake the fiber when that value changes.

```ts
import { Effect, TxRef } from "effect"

const program = Effect.gen(function*() {
  // Remaining headcount slots for a department's req plan.
  const openReqs = yield* TxRef.make(5)

  // modify: claim a req AND return how many were left before, in one step.
  const before = yield* Effect.tx(
    TxRef.modify(openReqs, (n) => [n, n - 1])
  )

  console.log(before)                    // 5 (the returned value)
  console.log(yield* TxRef.get(openReqs)) // 4 (the committed value)
})
```

**Reach for it when** two or more pieces of state must change together and stay mutually consistent under concurrency, or when building custom transactional data structures.

## TxChunk

`effect/TxChunk` — stable

A transactional growable sequence — a `Chunk` wrapped in a `TxRef` — with `append`, `prepend`, `take`, `drop`, `slice`, `map`, `filter`, all transactional.

**Mental model.** Transactional analog of `Chunk`/array. Storage layer beneath `TxQueue`; use directly when you want ordered, indexable transactional state without queue semantics.

```ts
import { Effect, TxChunk } from "effect"

const program = Effect.gen(function*() {
  // An append-only audit trail of comp-plan changes.
  const auditLog = yield* TxChunk.empty<string>()

  // Append two entries atomically — reviewers see both or neither.
  yield* Effect.tx(Effect.gen(function*() {
    yield* TxChunk.append(auditLog, "budget:debit 8000")
    yield* TxChunk.append(auditLog, "raise:recorded E-1042")
  }))

  console.log(yield* TxChunk.size(auditLog)) // 2
})
```

**Reach for it when** you need a transactional ordered buffer or change-log and queue blocking semantics would be overkill.

## TxHashMap

`effect/TxHashMap` — stable

Transactional key/value map: `HashMap` behind a `TxRef`, with `get`, `set`, `remove`, `modify`, `modifyAt`, plus `map`, `filter`, `reduce`, `findFirst`, `union`.

**Mental model.** Transactional analog of `HashMap`. Use for shared in-memory indexes where multiple keys may need to update together atomically.

```ts
import { Effect, Option, TxHashMap } from "effect"

const program = Effect.gen(function*() {
  // Remaining merit budget per department (whole dollars).
  const pools = yield* TxHashMap.make(
    ["engineering", 120_000],
    ["sales", 80_000]
  )

  // Atomically reallocate budget from one department to another.
  yield* Effect.tx(Effect.gen(function*() {
    yield* TxHashMap.modify(pools, "engineering", (n) => n - 15_000)
    yield* TxHashMap.modify(pools, "sales", (n) => n + 15_000)
  }))

  const eng = yield* TxHashMap.get(pools, "engineering")
  console.log(eng) // Option.some(105000)
  console.log(Option.getOrNull(eng))
})
```

**Reach for it when** you have a shared mutable map and updates across several keys must be consistent (reallocations, reconciliation, multi-key invariants).

## TxHashSet

`effect/TxHashSet` — stable

Transactional set of unique values with `add`, `remove`, `has`, and set algebra: `union`, `intersection`, `difference`, `isSubset`.

**Mental model.** Transactional analog of `HashSet`. Use for shared membership state that is concurrently mutated.

```ts
import { Effect, TxHashSet } from "effect"

const program = Effect.gen(function*() {
  // Employees whose raise has already been recommended this cycle.
  const recommended = yield* TxHashSet.make("E-1042", "E-2087")

  yield* Effect.tx(TxHashSet.add(recommended, "E-3119"))

  console.log(yield* TxHashSet.has(recommended, "E-3119")) // true
  console.log(yield* TxHashSet.size(recommended))          // 3
})
```

**Reach for it when** you track a concurrently-mutated set of unique things and want atomic add/remove plus set operations.

## TxQueue

`effect/TxQueue` — stable

Transactional FIFO queue with `bounded`, `unbounded`, `dropping`, and `sliding` strategies. Interface-segregated into `TxEnqueue` (write-only) and `TxDequeue` (read-only).

**Mental model.** Transactional analog of `Queue`. `TxQueue.take` on an empty queue internally calls `Effect.txRetry`, blocking (by suspend-and-wake, not spin) until an item arrives. `offer` on a full bounded queue similarly blocks. Operations compose transactionally — debit the budget pool and enqueue atomically.

```ts
import { Effect, Fiber, TxQueue } from "effect"

const program = Effect.gen(function*() {
  // A bounded approval queue: HRBPs can only review so many at once.
  const approvals = yield* TxQueue.bounded<string>(8)

  // Managers submit raise recommendations from a forked fiber.
  yield* Effect.forkChild(
    Effect.forEach(
      ["E-1042", "E-2087", "E-3119"],
      (id) => TxQueue.offer(approvals, id)
    )
  )

  // Reviewer: take blocks (retries) until a recommendation is available.
  const first = yield* TxQueue.take(approvals)
  const second = yield* TxQueue.take(approvals)
  console.log(first, second) // E-1042 E-2087
})
```

**Reach for it when** you need a work queue with backpressure or blocking takes, especially when enqueue/dequeue must coordinate atomically with other transactional state.

## TxPubSub

`effect/TxPubSub` — stable

Transactional publish/subscribe hub. Publishers call `publish`; each subscriber gets a scoped `TxQueue` receiving messages sent after subscription. Strategies: `bounded`, `unbounded`, `dropping`, `sliding`. Subscriptions are scope-bound — leaving the scope cleans up the subscriber queue.

**Mental model.** Transactional analog of `PubSub`. Fan-out broadcast where the publish step can be part of a larger transaction.

```ts
import { Effect, TxPubSub, TxQueue } from "effect"

const program = Effect.gen(function*() {
  // Broadcast comp decisions to every downstream listener.
  const decisions = yield* TxPubSub.unbounded<string>()

  yield* Effect.scoped(Effect.gen(function*() {
    const payroll = yield* TxPubSub.subscribe(decisions)
    const ledger = yield* TxPubSub.subscribe(decisions)

    yield* TxPubSub.publish(decisions, "raise-approved:E-1042")

    // Each subscriber receives its own copy.
    console.log(yield* TxQueue.take(payroll)) // "raise-approved:E-1042"
    console.log(yield* TxQueue.take(ledger))  // "raise-approved:E-1042"
  }))
})
```

**Reach for it when** you need transactional broadcast to many consumers and want publishing to commit atomically alongside other state changes.

## TxSemaphore

`effect/TxSemaphore` — stable

Counting semaphore whose permit acquisition is transactional. `acquire`/`acquireN` block (retry) until enough permits are free; `tryAcquire` never blocks; `withPermit`/`withPermits` bracket an effect with auto-release.

**Mental model.** Transactional analog of `Semaphore`. Use scoped helpers — they acquire before the effect and release on success, failure, *or* interruption, so permits are never leaked.

```ts
import { Console, Effect, TxSemaphore } from "effect"

const program = Effect.gen(function*() {
  // The HRIS allows at most 2 concurrent sync calls.
  const hrisLimiter = yield* TxSemaphore.make(2)

  const syncEmployee = (id: string) =>
    TxSemaphore.withPermit(
      hrisLimiter,
      Effect.gen(function*() {
        yield* Console.log(`syncing ${id} to HRIS`)
        yield* Effect.sleep("100 millis")
      })
    )

  // Only two run at a time; the rest wait for a freed permit.
  yield* Effect.forEach(
    ["E-1042", "E-2087", "E-3119", "E-4201"],
    syncEmployee,
    { concurrency: "unbounded" }
  )
})
```

**Reach for it when** you need to cap concurrency or model a finite pool of resources, and want acquisition to compose transactionally with other STM state.

## TxReentrantLock

`effect/TxReentrantLock` — stable

Transactional reader-writer lock that is *reentrant*: the same fiber can re-acquire a lock it already holds. Multiple readers may share the read lock; a writer gets exclusive access. Helpers: `withReadLock`, `withWriteLock`, `withLock`, plus scoped `readLock`/`writeLock`.

**Mental model.** Transactional analog of a classic RW-lock. Use when optimistic retry is not the right shape — e.g., read-mostly state that many fibers read but only one rewrites, with reentrancy to prevent self-deadlock in nested calls.

```ts
import { Effect, TxReentrantLock } from "effect"

const program = Effect.gen(function*() {
  // Guards the published comp-band table during a cycle re-band.
  const bandLock = yield* TxReentrantLock.make()

  const result = yield* TxReentrantLock.withWriteLock(
    bandLock,
    Effect.succeed("comp bands re-published")
  )

  console.log(result) // "comp bands re-published"
})
```

**Reach for it when** you want explicit reader/writer access control with reentrancy rather than relying purely on optimistic transaction retry.

## TxDeferred

`effect/TxDeferred` — stable

Write-once transactional cell for a value produced later. `await` retries until completed; `succeed`/`fail`/`done` complete it exactly once (returning `true` on first completion, `false` thereafter); `poll` inspects without blocking.

**Mental model.** Transactional analog of `Deferred` — a one-shot promise that participates in transactions. `await` is built on `Effect.txRetry`: if the cell is empty the transaction parks and wakes when filled.

```ts
import { Effect, Fiber, TxDeferred } from "effect"

const program = Effect.gen(function*() {
  // Signalled exactly once when the comp cycle freezes (no more edits).
  const cycleFrozen = yield* TxDeferred.make<string>()

  // Workers await the freeze before finalizing their allocations.
  const worker = yield* Effect.forkChild(TxDeferred.await(cycleFrozen))

  // The cycle admin freezes it exactly once.
  yield* TxDeferred.succeed(cycleFrozen, "2026-Q2")

  console.log(yield* Fiber.await(worker)) // Exit.succeed("2026-Q2")
})
```

**Reach for it when** one fiber must wait for a single result or signal produced by another, and that handoff should compose with other transactional state.

## TxPriorityQueue

`effect/TxPriorityQueue` — stable

Transactional priority queue ordered by an `Order`. `take` returns the smallest element by that order. Constructors (`empty`, `make`, `fromIterable`) take the `Order` up front. Also `peek`, `takeUpTo`, `removeIf`, `retainIf`.

**Mental model.** Transactional analog of a priority queue/heap. Use for scheduling where the next item to process is the highest-priority one and atomic offer/take across coordinated state is required.

```ts
import { Effect, Order, TxPriorityQueue } from "effect"

const program = Effect.gen(function*() {
  // Process raises by employee level: lowest level number = reviewed first.
  const queue = yield* TxPriorityQueue.fromIterable(Order.Number, [5, 3, 4])

  console.log(yield* TxPriorityQueue.take(queue)) // 3
  console.log(yield* TxPriorityQueue.take(queue)) // 4
})
```

**Reach for it when** you need a transactional scheduler or work queue where ordering matters, not just FIFO arrival.

## TxSubscriptionRef

`effect/TxSubscriptionRef` — stable

Transactional `TxRef` that also publishes its changes. Holds a current value (`get`/`set`/`update`/`modify`) and exposes committed updates as a `Stream` via `changesStream` (or a transactional queue via `changes`), always starting with the current value.

**Mental model.** Transactional analog of `SubscriptionRef` — observable shared state. Only *committed* values are broadcast; subscribers never see mid-transaction values.

```ts
import { Effect, Stream, TxSubscriptionRef } from "effect"

const program = Effect.gen(function*() {
  // The merit cycle's lifecycle status, observable by dashboards.
  const status = yield* TxSubscriptionRef.make("planning")

  // Consume committed changes as a Stream (starts with current value).
  const seen = yield* Stream.runCollect(
    TxSubscriptionRef.changesStream(status).pipe(Stream.take(1))
  )
  console.log(seen) // ["planning"]

  yield* TxSubscriptionRef.set(status, "approvals")
})
```

**Reach for it when** you have transactional shared state that other fibers must observe reactively, and they should only ever see consistent, committed snapshots.

### Putting it together: a bounded approval pipeline with a freeze signal

```ts
import { Cause, Console, Effect, Option, TxDeferred, TxQueue } from "effect"

const run = Effect.gen(function*() {
  const approvals = yield* TxQueue.bounded<number, Cause.Done>(4) // raise amounts, in dollars
  const cycleFrozen = yield* TxDeferred.make<void>()

  // Managers: submit 10 raise recommendations, then close the intake.
  const managers = Effect.gen(function*() {
    yield* Effect.forEach(
      Array.from({ length: 10 }, (_, i) => (i + 1) * 1_000),
      (amount) => TxQueue.offer(approvals, amount) // blocks (retries) while full
    )
    yield* TxQueue.end(approvals) // intake closed for the cycle
  })

  // Reviewer: clear the queue until intake closes, then signal the freeze.
  const reviewer = Effect.gen(function*() {
    let allocated = 0
    yield* Effect.whileLoop({
      while: () => true,
      body: () =>
        Effect.gen(function*() {
          // poll inside a tx: Some while items remain, None once closed+empty
          const next = yield* Effect.tx(TxQueue.poll(approvals))
          if (Option.isSome(next)) {
            allocated += next.value
          } else {
            const open = yield* TxQueue.isOpen(approvals)
            if (!open) return yield* Effect.interrupt
            yield* Effect.yieldNow
          }
        }),
      step: () => {}
    }).pipe(Effect.ignoreCause)
    yield* Console.log(`total allocated: ${allocated}`) // 55000
    yield* TxDeferred.succeed(cycleFrozen, undefined)
  })

  yield* Effect.all([managers, reviewer], { concurrency: "unbounded" })
  yield* TxDeferred.await(cycleFrozen) // wait for the reviewer to drain + freeze
})
```

> **Warning:** A transaction body can be *re-run* any number of times before it commits. Never put real-world side effects (network calls, `Console` output, anything observable) inside an `Effect.tx` block — they fire on every retry. Do pure state changes transactionally, then perform side effects *after* the transaction commits.

> **Tip:** Reach for the smallest tool that fits: a single coordinated value &rarr; `TxRef`; keyed state &rarr; `TxHashMap`; membership &rarr; `TxHashSet`; ordered buffer &rarr; `TxChunk`; work queue with blocking/backpressure &rarr; `TxQueue` (priority ordering? `TxPriorityQueue`); broadcast &rarr; `TxPubSub`; observable value &rarr; `TxSubscriptionRef`; one-shot handoff &rarr; `TxDeferred`; concurrency cap &rarr; `TxSemaphore`; explicit reader/writer control &rarr; `TxReentrantLock`. They all compose under a single `Effect.tx`, so you can mix them in one atomic step.
