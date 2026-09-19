# Streaming & Channels

`Stream<A, E, R>` is a pull-based source: the consumer requests the next chunk, the stream computes it (possibly failing with `E`, needing services `R`), emits the chunk, and waits. This pull loop provides automatic back-pressure. `Sink<A, In, L, E, R>` folds chunks into a final answer. `Channel` is the bidirectional primitive both are built from. In practice: live in `Stream` 95% of the time; reach for `Channel` only when authoring a new operator.

> **Official examples:** Effect's release-matched [`ai-docs` Stream examples](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.115/ai-docs/src/03_stream) cover creation, transformation, consumption, and NDJSON encoding.
>
> **Official guides:** [Introduction to Streams](https://effect.website/docs/v4/stream/introduction), [Sink introduction](https://effect.website/docs/v4/sink/introduction); section-specific guides are linked where they apply. These track Effect's `main` branch rather than the pinned `rc.115` release, so where they differ, this page and the tagged source win.

## Stream

`effect/Stream` — stable

`Stream<A, E, R>` is a lazy, pull-based, possibly-infinite sequence of `A`s that can fail with `E` and needs services `R`. Pulling provides automatic back-pressure and supports constant-memory pipelines when each stage keeps bounded state. Collecting, unbounded grouping/buffering, or letting producers outrun consumers can still consume memory proportional to the data. Combinators cover three operations — create, transform, run — and the later subsections cover combining streams, failure handling, resource ownership, and where buffering hides.

### 1. Creating streams

| Source type | Constructor |
|---|---|
| In-memory data | `fromIterable` / `fromArray` / `make`; `fromArrays` emits one chunk per array |
| One effect, one constant, one failure | `fromEffect` / `succeed` / `fail` (also `failCause`, `die`, `empty`, `never`) |
| Effect that returns a collection | `fromIterableEffect` — "call the repository, then stream the rows" |
| Effect that returns a stream | `unwrap` — also the way to [own a resource](#6-owning-resources-inside-a-stream) |
| Repeat one effect, or a whole stream | `fromEffectRepeat` / `forever` / `repeat(schedule)` |
| Effectful, scheduled polling | `fromEffectSchedule` |
| Cursor-based API pagination | `paginate` |
| Async iterator | `fromAsyncIterable` |
| DOM event / callback | `fromEventListener` / `callback` |
| Concurrency primitives | `fromQueue` / `fromPubSub` |
| Web `ReadableStream` | `fromReadableStream` |
| Node.js `Readable` | `NodeStream.fromReadable` from `@effect/platform-node` |
| Schedule outputs | `fromSchedule` |
| Manual seed-and-step | `unfold` |
| Counters / timers | `range` / `iterate` / `tick` |

```ts
import { Array, Cause, Clock, Effect, Option, Queue, Schedule, Schema, Stream } from "effect"

// In-memory headcount snapshot — the simplest constructor.
const levels = Stream.fromIterable<string>(["IC3", "IC4", "IC5", "M1", "M2"])
const bandLiterals = Stream.make("IC3", "IC4", "IC5") // varargs -> Stream<string>

// Poll the HRIS health endpoint on a schedule.
// (v4 name: fromEffectSchedule, NOT repeatEffectWith.)
const hrisHeartbeat = Stream.fromEffectSchedule(
  Clock.currentTimeMillis.pipe(
    Effect.map((ts) => ({ status: "ok", ts }))
  ),
  Schedule.spaced("30 seconds")
)

// Walk the HRIS's cursor-paginated /employees endpoint.
// paginate(initialCursor, f) where f returns [thisPage, Option<nextCursor>].
const allEmployees = Stream.paginate(
  0, // start at page 0
  Effect.fn(function*(page: number) {
    yield* Effect.sleep("50 millis") // simulate network round-trip
    const rows = Array.range(0, 99).map((i) => ({
      id: `emp_${page * 100 + i}`,
      name: `Employee ${page * 100 + i}`,
      level: "IC4"
    }))
    const next = page < 10 ? Option.some(page + 1) : Option.none()
    return [rows, next] as const
  })
)

// Any callback/event API: the Queue is the whole protocol — offer values,
// end it to finish, fail it to fail the stream.
class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {
  cause: Schema.Defect()
}) {}

const PayrollEvent = Schema.Struct({ runId: Schema.String, status: Schema.String })
const decodePayrollEvent = Schema.decodeUnknownOption(Schema.fromJsonString(PayrollEvent))

// Bridge a WebSocket that streams live payroll-run events into a typed Stream.
const payrollEvents = Stream.callback<typeof PayrollEvent.Type, HrisUnavailable>(
  Effect.fn(function*(queue) {
    const ws = new WebSocket("wss://hris.example.com/payroll-events")
    const onMessage = (e: MessageEvent) => {
      // Decode at the boundary instead of casting JSON.parse output.
      const event = decodePayrollEvent(e.data)
      // A listener cannot wait, so it cannot use the suspending Queue.offer.
      if (Option.isSome(event)) Queue.offerUnsafe(queue, event.value)
    }
    const onClose = () => Queue.endUnsafe(queue) // buffered events drain, then the stream ends
    const onError = (cause: Event) =>
      Queue.failCauseUnsafe(queue, Cause.fail(new HrisUnavailable({ cause })))
    // The callback effect runs in the stream's scope: this release runs when the
    // consumer finishes, fails, stops early, or is interrupted.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        ws.addEventListener("message", onMessage)
        ws.addEventListener("close", onClose)
        ws.addEventListener("error", onError)
      }),
      () =>
        Effect.sync(() => {
          ws.removeEventListener("message", onMessage)
          ws.removeEventListener("close", onClose)
          ws.removeEventListener("error", onError)
          ws.close()
        })
    )
  }),
  // Without bufferSize the buffer is UNBOUNDED. Status events supersede each
  // other, so keep the newest 256 and evict the oldest under pressure.
  { bufferSize: 256, strategy: "sliding" }
)
```

> **Warning:** `Stream.callback` (and `Stream.fromEventListener`, which is built on it) buffers **without bound** unless you pass `bufferSize`: a fast emitter plus a slow consumer grows the heap silently. The strategy defaults to `"suspend"`, but suspension only helps a producer that can `yield* Queue.offer(...)`. A synchronous listener calls `Queue.offerUnsafe`, which never waits and returns a `boolean` instead.

| `strategy` | `offerUnsafe` on a full buffer | What is lost |
|---|---|---|
| `"suspend"` (default) | returns `false`; the value is not enqueued | the **newest** value — silently, unless the listener checks the `boolean` |
| `"dropping"` | returns `false`; the value is not enqueued | the newest value — the stated policy |
| `"sliding"` | returns `true`; evicts the oldest buffered value | the **oldest** value |

For a push source the real choices are a stated loss policy (`"dropping"` or `"sliding"`, ideally with a counter on every `false`), pausing the source externally, or restructuring so the producer is an Effect that awaits a bounded `Queue` and the stream is `Stream.fromQueue`. "No loss" together with "the producer cannot slow down" needs durable storage, not a bigger buffer. `fromEventListener` accepts `bufferSize` but no strategy, so a full buffer drops the newest events; with `{ once: true }` it ends the stream after the first event. Queue and PubSub overload semantics are covered in [Concurrency & Coordination](./concurrency-coordination#queue).

**`unfold` vs `paginate`.** The `unfold` step is always effectful and returns `[element, nextState]`, or `undefined` to stop — exactly one element per step. `paginate` returns a whole page plus `Option<nextState>` and still emits the last page when the next state is `None`, which is why it fits page-shaped APIs. There is no `unfoldEffect` or `paginateEffect`.

**Ending a repeated effect.** `Stream.fromEffectRepeat(effect)` re-runs an effect forever, one element per run. Fail it with `Cause.done()` to end the stream *normally* — the way to drain an imperative iterator or cursor without carrying `unfold` state (see [Pull](../foundations/core-runtime-execution#pull) for the `Done` signal).

```ts
import { Cause, Effect, Stream } from "effect"

// Drain any iterator lazily: one `next()` per pull, normal end on `done`.
const drainIterator = <A>(iterator: Iterator<A>): Stream.Stream<A> =>
  Stream.fromEffectRepeat(
    Effect.suspend(() => {
      const next = iterator.next()
      return next.done ? Cause.done() : Effect.succeed(next.value)
    })
  )
```

Official guide: [Creating Streams](https://effect.website/docs/v4/stream/creating) (its callback example passes no buffer options, and its "void" heading is not an API — use `Stream.succeed(undefined)`).

### 2. Transforming streams

| Need | Operators | Semantics that decide the choice |
|---|---|---|
| Per element, pure | `map` / `filter` / `filterMap` | `filterMap` takes a `Filter` (returns a `Result`), not an `Option`-returning function. |
| Per element, effectful | `mapEffect` / `tap` | `mapEffect` accepts `{ concurrency, unordered }`; ordered output is the default. |
| Fan out per element | `flatMap` / `switchMap` / `flattenIterable` | `flatMap` runs every inner stream to completion. `switchMap` interrupts the previous inner stream when the outer emits again — stale work is cancelled, not queued. `flattenIterable` is the inverse of `grouped`. |
| Carry state | `scan` / `mapAccum` (`scanEffect`, `mapAccumEffect`) | `scan(initial, f)` emits the seed and every intermediate value. `mapAccum(() => initial, (state, a) => [next, outputs])` has a lazy seed and returns an *array* of outputs, so one input can emit zero, one, or many; `{ onHalt }` flushes leftover state at the end. Both keep bounded state. |
| Stop early | `take` / `takeWhile` / `takeUntil` / `takeRight` / `haltWhen` / `interruptWhen` | `takeWhile` stops *before* the first failing element; `takeUntil` *includes* the element that matched unless `{ excludeLast: true }`. `takeRight(n)` must see the end, so it buffers `n` and never emits on an infinite source. `haltWhen(effect)` stops before the next pull; `interruptWhen(effect)` also interrupts the pull in progress. |
| Batch | `grouped(n)` / `groupedWithin(n, duration)` / `rechunk(n)` | `grouped` flushes only when `n` elements arrived or the stream ended. `groupedWithin` flushes on size **or** elapsed time, whichever is first — the right shape for live feeds. `rechunk` resizes the internal chunks without changing the element type. |
| Rate control | `throttle` / `debounce(duration)` / `schedule(schedule)` | `throttle` is a token bucket charged per *chunk* via `cost(chunk)`: `"shape"` delays, `"enforce"` drops the whole over-budget chunk (`rechunk(1)` first for per-element dropping), `burst` raises the bucket to `units + burst`. `debounce` emits only the last value after a quiet period. `schedule` spaces every element by a `Schedule`. |
| Keyed sub-streams | `groupByKey(f)` / `groupBy` | Emits `[key, Stream]` pairs; consume them with `flatMap(..., { concurrency: "unbounded" })` or a finite bound. Each key owns a queue (`bufferSize`, default 4096 elements); `idleTimeToLive` retires quiet keys, which matters when the key space is large. |
| Dedupe | `changes` | Drops consecutive elements that are `Equal.equals`. |
| Text framing | `decodeText` / `splitLines` / `encodeText` | `decodeText` decodes incrementally, so a multi-byte character may straddle chunks. `splitLines` accepts `\n`, `\r\n`, and a lone `\r`, and carries an incomplete line to the next pull. |
| Shape the output | `drain` / `intersperse` | `drain` keeps a stream's effects but emits nothing, so it can be `merge`d in as a background side-stream. `intersperse` inserts a separator between elements. |

```ts
import { Effect, Stream } from "effect"

interface Employee {
  readonly id: string
  readonly level: string
  readonly baseSalary: number
  readonly active: boolean
}

interface CompBand {
  readonly level: string
  readonly min: number
  readonly mid: number
  readonly max: number
}

declare const lookupCompBand: (level: string) => Effect.Effect<CompBand>

// Process a payroll batch: filter active employees, enrich with comp bands,
// throttle to avoid hammering the CompService, then batch for bulk writes.
const payrollBatch = (employees: Stream.Stream<Employee>) =>
  employees.pipe(
    // pure filter: active headcount only
    Stream.filter((e) => e.active),
    // pure transform: tag employees outside their band
    Stream.map((e) => ({ ...e, flagged: false as boolean })),
    // effectful enrichment with bounded concurrency (v4 sweet spot: one operator, one option)
    Stream.mapEffect(
      Effect.fn("enrichWithBand")(function*(e) {
        const band = yield* lookupCompBand(e.level)
        const inBand = e.baseSalary >= band.min && e.baseSalary <= band.max
        return { ...e, band, flagged: !inBand }
      }),
      { concurrency: 8 }
    ),
    // rate-limit: charge 1 unit per element, cap at 100/second, shape (don't drop)
    Stream.throttle({
      cost: (chunk) => chunk.length,
      units: 100,
      duration: "1 second",
      strategy: "shape"
    }),
    // batch into arrays of up to 200 for a bulk DB upsert
    Stream.grouped(200)
  )
```

> **Tip:** `mapEffect`, `flatMap`, and `mergeAll` all accept `{ concurrency: n }` or `{ concurrency: "unbounded" }`, but only `mapEffect` has `unordered`: its output keeps input order unless `{ unordered: true }` is passed. `flatMap` and `mergeAll` take `{ concurrency, bufferSize }`; above a concurrency of 1 their inner streams interleave as elements arrive, and there is no flag to restore a cross-stream order. In-flight fibers are interrupted when downstream stops pulling.

**Ordered does not mean serialized.** Ordered `mapEffect` with `concurrency: 8` still runs eight effects at once and only *emits* in input order, so a slow head element holds back finished successors. Choose `unordered: true` when downstream does not care, and serialize only the stage whose order is contractual.

**Batch by size or time on live sources.** A partial `grouped(n)` batch waits for more input indefinitely, so on a queue- or socket-backed stream latency becomes unbounded. `groupedWithin(n, duration)` is `aggregateWithin(Sink.take(n), Schedule.spaced(duration))` underneath; reach for `Stream.aggregateWithin` directly when the batch boundary is a custom `Sink`.

```ts
import { Stream } from "effect"

declare const auditEvents: Stream.Stream<{ readonly id: string }>

// Flush at 200 events or after 2 seconds of accumulation, whichever is first.
const auditBatches = auditEvents.pipe(Stream.groupedWithin(200, "2 seconds"))
```

Official guide: [Stream operations](https://effect.website/docs/v4/stream/operations) (its "mergeWith" heading and the `switch` option it mentions for `flatMap` are not rc.115 APIs — use `Stream.merge` over mapped inputs and `Stream.switchMap`).

### 3. Running streams

| Runner | Behavior |
|---|---|
| `runCollect` | Gathers all elements into an array (bounded streams only). |
| `runDrain` | Executes for effects, discards output. |
| `runForEach` | Runs an effect per element. `runForEachArray` runs it once per pulled chunk. |
| `runForEachWhile` | Runs an `Effect<boolean>` per element and stops pulling on the first `false`. v4 has no early-exit fold, so this plus local state is the replacement. |
| `runFold` | Reduces to one value; the initial state is a thunk. `runFoldEffect` for an effectful step. |
| `runHead` / `runLast` / `runCount` / `runSum` | One-value shortcuts. `runHead` stops after the first element; the other three consume the whole stream. |
| `mkString` / `mkUint8Array` / `mkArrayBuffer` | Concatenate a text or byte stream into one value — a full materialization, like `runCollect`. |
| `run(sink)` | Hands the stream to an arbitrary `Sink`. |

```ts
import { Effect, Sink, Stream } from "effect"

interface RaiseRecommendation {
  readonly employeeId: string
  readonly newSalary: number
  readonly approved: boolean
}

declare const recommendations: Stream.Stream<RaiseRecommendation>
declare const persistRaise: (r: RaiseRecommendation) => Effect.Effect<void>

const program = Effect.gen(function*() {
  // collect — bounded only; use for small review batches
  const allRaises = yield* Stream.runCollect(recommendations)

  // drain — run for side effects, discard output
  yield* recommendations.pipe(
    Stream.tap((r) => Effect.logInfo(`processing raise for ${r.employeeId}`)),
    Stream.runDrain
  )

  // fold — reduce approved raises to a total payroll delta
  const totalDelta = yield* recommendations.pipe(
    Stream.filter((r) => r.approved),
    Stream.runFold(() => 0, (acc, r) => acc + r.newSalary)
  )

  // run into a Sink — the general escape hatch
  const approvedCount = yield* recommendations.pipe(
    Stream.filter((r) => r.approved),
    Stream.run(Sink.count)
  )

  return { totalRaises: allRaises.length, totalDelta, approvedCount }
})
```

**Limit demand, not the result.** `Stream.take(n)` placed *before* the runner stops pulling after `n` elements and finalizes the source. `runCollect` followed by `slice(0, n)` has already drained the source — and never returns for a live one. Against a six-row counting source, `take(2)` before `runCollect` performs 2 reads; `runCollect` followed by `slice(0, 2)` performs all 7 (six rows plus the read that discovers the end). The finalizer runs once either way, so only a read counter tells the two apart.

```ts
import { Effect, Stream } from "effect"

declare const employeeIds: Stream.Stream<string> // live HRIS feed: never ends on its own
declare const loadProfile: (id: string) => Effect.Effect<{ readonly id: string }>

// Demand-limited: ten ids pass `take`, so exactly ten profiles are loaded.
const firstTen = employeeIds.pipe(
  Stream.take(10),
  Stream.mapEffect(loadProfile, { concurrency: 4 }),
  Stream.runCollect
)

// Same ten results, but take sits AFTER the concurrent stage: its window stays
// full, so extra lookups have already started when the tenth result arrives.
// They are interrupted, but the HRIS has already seen the requests.
const overshoots = employeeIds.pipe(
  Stream.mapEffect(loadProfile, { concurrency: 4 }),
  Stream.take(10),
  Stream.runCollect
)
```

Three details keep this honest. **Demand is per chunk, not per element**: `Stream.fromIterable` reads up to `chunkSize` items (default 4096) from a lazy iterable per pull, so `take(2)` over it still advances the iterator by a whole chunk — pass `{ chunkSize }` or use `unfold`/`paginate` when each read is expensive. **The deciding element has already been processed**: `takeUntil`, `takeWhile`, and `runForEachWhile` see an element before they can stop, so "stop before the budget is exceeded" must test the *projected* total. **`take` treats `NaN` and non-positive counts as zero** and returns an empty stream.

For byte streams, `Stream.limitBytes(limit, onLimitReached)` emits chunks until the next one would cross `limit` (any `ByteSize.Input`), drops that crossing chunk, and switches to the fallback stream — pass a fallback that is `Stream.fail(...)` to make an oversized body a typed error, or `() => Stream.empty` to truncate silently. `Stream.mkArrayBuffer` collects an `ArrayBuffer` without losing the concrete backing-buffer type. Web Streams are first-class: `Stream.fromReadableStream` bridges a browser/WHATWG source, while the Channel layer below also supports writable and transform streams. In Node, `NodeStream.fromReadable({ evaluate, onError, closeOnDone? })` lazily evaluates a `node:stream` `Readable`, maps its errors into the typed channel, and closes it when done by default; see [Platform & Runtime Hosts](../interfaces/platform-runtime-hosts).

Official guide: [Consuming Streams](https://effect.website/docs/v4/stream/consuming-streams).

### 4. Combining and splitting streams

| Goal | Operator | Termination and ordering |
|---|---|---|
| One after the other | `concat` / `flatten` (stream of streams) | The right side does not start until the left ends. |
| Both at once | `merge(that, { haltStrategy })` / `mergeAll({ concurrency, bufferSize })` | Arrival order; each side keeps its own order. **Default `haltStrategy` is `"both"`**: merging a finite stream with an infinite ticker never ends unless you pass `"left"`, `"right"`, or `"either"`. |
| Pair positionally | `zip` / `zipWith` | Ends with the shorter side, so the faster side is back-pressured to the slower one. |
| Pair with the latest | `zipLatest` / `zipLatestWith` | Emits when *either* side produces, after both have produced once. "Latest" is tracked per pulled chunk, so only the last element of each chunk is paired. |
| Pair with neighbors | `zipWithIndex` / `zipWithPrevious` / `zipWithNext` | The neighbor is an `Option`; no manual counter or `mapAccum` needed. |
| Alternate deterministically | `interleave` | Unlike `merge`, the order does not depend on timing. |
| Every combination | `cross` | Re-runs the right stream once per left element — expensive if the right side does I/O. |
| Two branches by a rule | `partition(filter)` / `partitionEffect(filter)` | Returns a scoped `Effect` of two queue-backed streams. Tuple order differs: `partition` yields `[excluded, satisfying]`, `partitionEffect` yields `[passes, fails]`; the buffer option is `bufferSize` (default 16) on the first and `capacity` (default 4096) on the second. |
| Same elements to several consumers | `broadcastN({ n, capacity })` / `broadcast` / `share` | Running one `Stream` value twice runs its source twice. These run it once behind a `PubSub`: with the default `"suspend"` strategy the source advances at most `capacity` chunks ahead of the **slowest** consumer. `share` is the ref-counted variant: upstream starts with the first subscriber and is finalized after the last. |

```ts
import { Effect, Filter, Stream } from "effect"

interface RaiseRequest {
  readonly employeeId: string
  readonly percent: number
}

declare const requests: Stream.Stream<RaiseRequest> // finite: one merit cycle
declare const approve: (request: RaiseRequest) => Effect.Effect<void>
declare const escalate: (request: RaiseRequest) => Effect.Effect<void>

// A progress ticker must not keep the merged stream alive after the data ends.
const withProgressTicks = Stream.merge(
  requests.pipe(Stream.map((request) => ({ _tag: "Request" as const, request }))),
  Stream.tick("5 seconds").pipe(Stream.map(() => ({ _tag: "Tick" as const }))),
  { haltStrategy: "left" }
)

const withinPolicy = Filter.fromPredicate((request: RaiseRequest) => request.percent <= 10)

const triage = Effect.scoped(
  Effect.gen(function*() {
    // Pure partition: the EXCLUDED branch comes first.
    const [overPolicy, inPolicy] = yield* Stream.partition(requests, withinPolicy, { bufferSize: 64 })
    // Both halves are bounded queues fed by one source: drain them concurrently,
    // or the branch nobody reads fills up and stalls the other one too.
    yield* Effect.all(
      [Stream.runForEach(inPolicy, approve), Stream.runForEach(overPolicy, escalate)],
      { concurrency: 2, discard: true }
    )
  })
)
```

**Use when** one pipeline must feed two policies (`partition`), two independent consumers (`broadcastN`), or must be joined with a clock, a config feed, or a fallback (`merge`, `zipLatest`, `concat`). For fan-out across fibers that outlive one pipeline, use a [`PubSub`](./concurrency-coordination#pubsub) directly.

### 5. Handling stream failures

A stream failure is **terminal for the failed region**. Recovery never resumes the broken source: it *appends a different stream* after the elements that were already delivered, so a non-idempotent consumer has already seen them.

| Operator | Recovers from | Notes |
|---|---|---|
| `catch` | every typed failure | Removes `E`; the handler returns the fallback stream. |
| `catchTag` / `catchTags` | tagged failures by `_tag` | Other failures stay in `E`. |
| `catchIf` / `catchFilter` | failures selected by a predicate, refinement, or `Filter` | Optional trailing `orElse` for the rest, as on `Effect.catchIf`. |
| `catchCause` / `catchCauseFilter` | the full `Cause`, defects included | Use when defects must be handled too. |
| `catchDefect` | defects only | Typed failures and interruption pass through untouched — the narrow tool for "a parser threw". |
| `orElseSucceed` / `orElseIfEmpty` | any typed failure / an empty stream | Append one constant element, or switch streams when nothing was emitted. |
| `mapError` / `orDie` | — | Translate the error, or turn it into a defect. |
| `onError` / `tapError` / `tapCause` | — | Observation only: run an effect, then re-raise. |
| `retry(schedule)` | typed failures the schedule accepts | Re-runs the **entire upstream region**, re-acquiring its resources. The schedule resets as soon as the restarted stream emits one element, so `upTo({ times: 5 })` means five *consecutive* failed attempts, not five over the feed's lifetime. |
| `timeout(duration)` | — | **Ends the stream with no error** when one pull waits longer than `duration`. |
| `timeoutOrElse({ duration, orElse })` | — | Switches to `orElse()` instead: `Stream.fail(...)` makes silence a typed failure; any other stream is a fallback source. |

```ts
import { Effect, Schedule, Schema, Stream } from "effect"

class FeedUnavailable extends Schema.TaggedError<FeedUnavailable>()("FeedUnavailable", {
  reason: Schema.String
}) {}

class HeartbeatLost extends Schema.TaggedError<HeartbeatLost>()("HeartbeatLost", {}) {}

interface Approval {
  readonly employeeId: string
  readonly approved: boolean
}

declare const liveApprovals: Stream.Stream<Approval, FeedUnavailable>
declare const cachedApprovals: Stream.Stream<Approval>

const resilientApprovals = liveApprovals.pipe(
  // Silence is a failure for this feed, not a normal end.
  Stream.timeoutOrElse({
    duration: "30 seconds",
    orElse: () => Stream.fail(new HeartbeatLost())
  }),
  // Observe and re-raise; onError never recovers.
  Stream.onError((cause) => Effect.logWarning("live approvals failed", cause)),
  // Reconnect: re-runs everything above, including the socket acquisition.
  Stream.retry(Schedule.exponential("1 second").pipe(Schedule.jittered, Schedule.upTo({ times: 5 }))),
  // Still failing: append the cache. Approvals already emitted stay emitted.
  Stream.catchTag("FeedUnavailable", () => cachedApprovals)
)
// Stream<Approval, HeartbeatLost>
```

> **Warning:** `Stream.timeout` does not behave like `Effect.timeout`. It is `timeoutOrElse` with `Stream.empty` as the fallback, so downstream cannot tell "the source finished" from "the source went quiet". The deadline is an **idle timeout per pull**, not a total budget — a feed that emits every 30 ms runs forever under `timeout("50 millis")` — and the fallback stream itself is not timed.

Two placement rules follow from "retry re-runs the upstream region". **Place `retry` directly after the source it should reconnect**, upstream of any non-idempotent write — everything above it in the pipe runs again on each attempt (see the [streaming deep dive](../deep-dives/streaming-ingestion-without-accidental-buffering)). **Put per-element recovery inside the element's effect** — `Stream.mapEffect((row) => write(row).pipe(Effect.catchTag(...)))` keeps the stream alive, whereas a `Stream.catch*` after it can only replace the rest of the stream. Retry classification and backoff policy are ordinary [`Schedule`](./scheduling-time#schedule) material.

Official guide: [Error handling in streams](https://effect.website/docs/v4/stream/error-handling) (its "timeoutFail", "timeoutFailCause", and "timeoutTo" headings are stale names; the code under them, and rc.115, use `Stream.timeoutOrElse`).

### 6. Owning resources inside a stream

A file handle, database cursor, or subscription behind a stream must stay open until the *consumer* stops pulling — and must close on completion, failure, interruption, **and early stop**. **Acquire inside the stream, never before it**: a handle opened outside and closed "when the consumer is done" leaks on the first `take(n)` or decode failure. There is no `Stream.acquireRelease` in rc.115; compose `Effect.acquireRelease` with one of these:

| Tool | Shape | Scope lifetime |
|---|---|---|
| `Stream.unwrap(effect)` | an `Effect` that returns a `Stream` | The effect's `Scope` is removed from `R` and lives as long as the returned stream. The default choice. |
| `Stream.scoped(stream)` | a stream whose stages need `Scope` | Opens a scope for the wrapped stream and closes it when *that* stream ends. |
| `Stream.ensuring(finalizer)` / `Stream.onExit(f)` | no resource, just cleanup | Runs after the stream's own finalizers on every exit path. An early stop such as `take` reports a `Success` exit. |

```ts
import { Cause, Effect, Option, Schema, Stream } from "effect"

class ExportUnavailable extends Schema.TaggedError<ExportUnavailable>()("ExportUnavailable", {
  path: Schema.String
}) {}

interface PayrollExportCursor {
  // One read per pull. The reader itself is lazy: None means end of export.
  readonly nextRow: Effect.Effect<Option.Option<string>, ExportUnavailable>
  readonly close: Effect.Effect<void>
}

declare const openPayrollExport: (
  path: string
) => Effect.Effect<PayrollExportCursor, ExportUnavailable>

// The cursor opens on the first pull and closes exactly once: on completion,
// on failure, on interruption, and when a consumer stops early with take(n).
const payrollExportRows = (path: string): Stream.Stream<string, ExportUnavailable> =>
  Stream.unwrap(
    Effect.acquireRelease(openPayrollExport(path), (cursor) => cursor.close).pipe(
      Effect.map((cursor) =>
        Stream.fromEffectRepeat(
          Effect.flatMap(
            cursor.nextRow,
            Option.match({ onNone: () => Cause.done(), onSome: (row) => Effect.succeed(row) })
          )
        )
      )
    )
  ).pipe(Stream.ensuring(Effect.logInfo("payroll export stream finished")))

// Stream.scoped: wrap EVERY stage that uses the handle.
declare const openCursor: Effect.Effect<PayrollExportCursor, ExportUnavailable>
declare const readAll: (cursor: PayrollExportCursor) => Stream.Stream<string, ExportUnavailable>

const scopedRows = Stream.scoped(
  Stream.fromEffect(Effect.acquireRelease(openCursor, (cursor) => cursor.close)).pipe(
    Stream.flatMap(readAll)
  )
)
```

> **Warning:** Scope placement is the whole contract. `Stream.scoped(Stream.fromEffect(acquire)).pipe(Stream.flatMap(readAll))` wraps only the one-element stream, so the handle closes as soon as *that* stream is exhausted. With a sequential `flatMap` the pull order happens to hide it; with `{ concurrency: 2 }` the release runs before the first row is read.

Two more rules. **The reader must itself be lazy**: a "stream" over an array produced by reading the whole file only disguises the all-at-once read. **Treat explicit completion as end-of-stream**, not one successful pull, and never reuse a possible element (or `undefined`) as an internal "done" sentinel — end with `Cause.done()`, `Option.none()`, or the constructor's own protocol. To prove the contract, assert the release flag rather than the values; the [streaming deep dive](../deep-dives/streaming-ingestion-without-accidental-buffering) has the three tests.

Official guide: [Resourceful streams](https://effect.website/docs/v4/stream/resourceful-streams).

### 7. Where buffering hides

Pull-based back-pressure bounds a pipeline only if **every stage** is bounded. Each row is a place where elements wait; peak memory is roughly the sum of `capacity × largest item` over all of them, and one unbounded row voids the claim.

| Stage | What it retains | Default | How to bound it |
|---|---|---|---|
| `Stream.callback`, `Stream.fromEventListener` | values pushed but not yet pulled | **unbounded** | `bufferSize` (+ `strategy` on `callback`) |
| `Stream.fromQueue`, `Stream.fromPubSub` | whatever the queue or subscription holds | the capacity it was built with | construct it `bounded` / `dropping` / `sliding`; see [Queue](./concurrency-coordination#queue) |
| `Stream.buffer({ capacity })` | up to `capacity` **elements**, plus what is in flight on either side | required; `"unbounded"` must be spelled out | finite `capacity`; `"suspend"` (default) back-pressures, `"dropping"` / `"sliding"` lose data |
| `Stream.bufferArray({ capacity })` | up to `capacity` **chunks** | required | bound is `capacity × max chunk size` |
| `mapEffect(f, { concurrency })` | up to `concurrency` inputs and results in flight | sequential | finite `concurrency`; `"unbounded"` is unbounded memory |
| `flatMap` / `mergeAll` with `concurrency` above 1 | the running inner streams plus one output queue | `bufferSize: 16`; sequential `flatMap` has no queue | finite `concurrency` and `bufferSize` |
| `grouped(n)`, `groupedWithin(n, d)` | the batch under construction | `n` | choose `n` from the destination's bulk limit |
| `groupByKey` / `groupBy` | one queue per live key | 4096 per key, keys never retired | `bufferSize`, `idleTimeToLive` |
| `partition` / `partitionEffect` | two queues | 16 / 4096 | `bufferSize` / `capacity` |
| `broadcast`, `broadcastN`, `share` | a `PubSub` | `capacity` is required | finite `capacity`; the slowest consumer sets the pace |
| `takeRight(n)`, `debounce`, `zipLatest` | the last `n` / the latest value | — | inherently bounded |
| `runCollect`, `Sink.collect()`, `mkString`, `mkUint8Array` | everything | — | only on sources you know are small; otherwise fold, `take`, or a bounded `Sink` |
| Framing decoders (`splitLines`, `Ndjson`, `Sse`, `SchemaBinary`) | one incomplete line, event, or frame | `Ndjson` and `splitLines`: no limit; `Sse`: 10 MiB; `SchemaBinary`: unset | `maxEventSize`, `maxFrameSize`, or `Stream.limitBytes` upstream |
| Source chunk size | one pulled chunk | `fromIterable`: 4096 elements; `FileSystem.stream`: 64 KiB | the source's `chunkSize` option |

**Buffer capacity is not batch size.** `Stream.buffer({ capacity: 3 })` sets flow-control depth: the arrays a downstream `Sink.forEachArray` or `runForEachArray` receives are whatever happened to be queued — one element at a time behind a slow producer, up to the capacity behind a fast one. Effectful stages reshape chunks too: everything after `mapEffect` arrives in chunks of one. When the destination needs batches of `n`, put `Stream.grouped(n)` (arrays as elements) or `Stream.rechunk(n)` (chunk size) immediately before the consumer.

**`buffer` also runs ahead of demand.** `source.pipe(Stream.buffer({ capacity: 64 }), Stream.take(1))` still reads dozens of elements from `source`; `take(1)` before the buffer reads one. Place `take` upstream of buffers and concurrent stages when each read costs something.

The end-to-end version of this inventory, with a memory equation and tests, is [Streaming Ingestion Without Accidental Buffering](../deep-dives/streaming-ingestion-without-accidental-buffering).

**Use when** you need back-pressured, incrementally-produced data with typed errors and bounded concurrency; choose bounded-state operators when constant-memory behavior matters.

## Sink

`effect/Sink` — stable

`Sink<A, In, L, E, R>` consumes elements of type `In`, may fail with `E`, needs `R`, and produces a result `A` plus unconsumed leftover `L`. The leftover slot enables early termination without discarding unused elements — two sinks can be sequenced so the second picks up exactly where the first stopped.

Key APIs: `Sink.sum`, `Sink.count`, `Sink.head()`, `Sink.last()`, `Sink.take(n)`, `Sink.fold`, `Sink.reduce`, `Sink.forEach`, `Sink.drain`. The collect-all sink is `Sink.collect()` (function call, not `Sink.collectAll`).

| Group | Sinks | Notes |
|---|---|---|
| Consume everything | `collect()`, `count`, `sum`, `last()`, `drain`, `reduce`, `reduceArray`, `forEach`, `forEachArray`, `timed` | `forEachArray` runs once per *pulled chunk*, whatever size that is. `timed` drains and returns the elapsed `Duration`. |
| Stop early (bounded) | `head()`, `take(n)`, `takeWhile`, `takeUntil`, `find`, `every`, `some`, `fold`, `foldUntil`, `reduceWhile`, `forEachWhile` | All but `forEachWhile` report leftovers (`L = In`). `fold(initial, continueWhile, step)` has a lazy seed and an *effectful* step; `reduceWhile` is the pure form and also covers size-capped set/map collection; `foldUntil(initial, max, step)` stops after `max` inputs. |
| No input needed | `succeed`, `fail`, `die`, `never` | Finish (or not) without pulling. |
| Adapt | `map` / `mapEffect` (result), `mapInput` / `mapInputEffect` / `mapInputArray` (input), `mapError`, `mapEnd`, `ignoreLeftover`, `flatMap`, `orElse` | `mapInput` is what makes a generic sink reusable across element types. |

```ts
import { Effect, Sink, Stream } from "effect"

interface MeritRecommendation {
  readonly employeeId: string
  readonly currentSalary: number
  readonly recommendedSalary: number
}

// Built-in folds run with Stream.run.
const recCount = Stream.make(
  { employeeId: "e1", currentSalary: 100_000, recommendedSalary: 105_000 },
  { employeeId: "e2", currentSalary: 120_000, recommendedSalary: 126_000 }
).pipe(Stream.run(Sink.count)) // Effect<number> = 2

const firstRec = Stream.make(
  { employeeId: "e1", currentSalary: 100_000, recommendedSalary: 105_000 }
).pipe(Stream.run(Sink.head<MeritRecommendation>())) // Effect<Option<MeritRecommendation>>

// A custom Sink: compute the arithmetic mean merit percentage in one pass.
// Sink.reduceArray folds whole pulled arrays into state — efficient batch-at-a-time.
const averageIncreasePct = Sink.reduceArray<
  { totalPct: number; n: number },
  MeritRecommendation
>(
  () => ({ totalPct: 0, n: 0 }),
  (acc, batch) => {
    let { totalPct, n } = acc
    for (const r of batch) {
      totalPct += (r.recommendedSalary - r.currentSalary) / r.currentSalary
      n += 1
    }
    return { totalPct, n }
  }
).pipe(Sink.map(({ totalPct, n }) => (n === 0 ? 0 : (totalPct / n) * 100)))

// Run: average merit increase percentage across all recommendations.
const avgIncrease = Stream.make(
  { employeeId: "e1", currentSalary: 100_000, recommendedSalary: 105_000 },
  { employeeId: "e2", currentSalary: 120_000, recommendedSalary: 126_000 }
).pipe(Stream.run(averageIncreasePct)) // Effect<number> ≈ 5.0

// Sinks can do effects — forEach turns a per-element effect into a Sink.
const auditLog = Sink.forEach((r: MeritRecommendation) =>
  Effect.logInfo(`merit rec: ${r.employeeId} -> ${r.recommendedSalary}`)
)
const _audit = Stream.make(
  { employeeId: "e1", currentSalary: 100_000, recommendedSalary: 105_000 }
).pipe(Stream.run(auditLog))
```

### Adapting, leftovers, and repeatable batching

**`Sink.mapInput` adapts the input; `Sink.map` adapts the result.** Write the aggregation once over a primitive and reuse it across streams of different shapes.

**Leftovers are the rest of the chunk already pulled — not the rest of the stream.** A sink finishes with an `End` tuple `[result, leftover?]`. `Sink.mapEnd` can read and rewrite both halves, `Sink.ignoreLeftover` narrows `L` to `never`, and `Sink.flatMap` hands the first sink's leftovers to the second, so "parse a header, then fold the body" composes. Because leftovers depend on chunking, `Sink.take(3)` over `Stream.make(1, 2, 3, 4, 5)` (one chunk) leaves `[4, 5]`, but over chunks `[1, 2]`, `[3, 4]`, `[5]` it leaves `[4]`. Ignoring leftovers never pulls more input.

**`Stream.transduce(sink)` re-applies a sink as an operator.** `Stream.run(sink)` applies it once; `transduce` runs it repeatedly, feeds each run's leftovers into the next, and emits every result — this is why `L` exists. `transduce(Sink.take(n))` is fixed-size batching; a `Sink.fold` whose predicate looks at accumulated cost gives **weighted** batching (there is no `Sink.foldWeighted`). Two edges: the element that crosses the limit is already in the batch, and an empty trailing result can be emitted when the input ends on a batch boundary, so filter empties.

```ts
import { Effect, Sink, Stream } from "effect"

interface Raise {
  readonly employeeId: string
  readonly delta: number
}

// One generic sink, adapted to a domain record.
const totalRaiseDelta = Sink.sum.pipe(Sink.mapInput((raise: Raise) => raise.delta))

// Header row first, then count the body: flatMap passes the leftovers along.
const headerThenRowCount = Sink.take<string>(1).pipe(
  Sink.flatMap(([header]) => Sink.count.pipe(Sink.map((rows) => ({ header, rows }))))
)

// Weighted batching: flush once roughly 1 MiB of payload has accumulated.
const upToOneMiB = Sink.fold<{ readonly rows: ReadonlyArray<string>; readonly bytes: number }, string>(
  () => ({ rows: [], bytes: 0 }),
  (state) => state.bytes < 1_048_576,
  (state, row) => Effect.succeed({ rows: [...state.rows, row], bytes: state.bytes + row.length })
).pipe(Sink.map((state) => state.rows))

declare const exportRows: Stream.Stream<string>

const byteBoundedBatches = exportRows.pipe(
  Stream.transduce(upToOneMiB),
  Stream.filter((batch) => batch.length > 0)
)
```

**`Sink.forEachArray` does not create batches.** It receives whatever arrays the stream happens to pull, and neither it nor `Stream.buffer({ capacity })` sets a batch size — see [Where buffering hides](#7-where-buffering-hides). Put `Stream.rechunk(n)` (or `Stream.grouped(n)` with `runForEach`) directly before it when the destination needs batches of `n`.

`Sink.fromWritableStream({ evaluate, onError })` adapts a WHATWG `WritableStream` into a back-pressured Sink. Construction is scoped and cancellation/close follows the Sink lifecycle, so use it for browser responses, compression streams, or other host-native writable targets.

Official guides: [Creating sinks](https://effect.website/docs/v4/sink/creating) (its HashSet/HashMap and "foldWeighted" headings are stale; the code folds with `Sink.reduce`, `Sink.reduceWhile`, and `Sink.fold`), [Sink operations](https://effect.website/docs/v4/sink/operations), [Leftovers](https://effect.website/docs/v4/sink/leftovers) (its `[4, 5]` leftover appears only because the input is a single chunk).

**Use when** the consumption logic is itself a reusable, composable unit — domain aggregations or writers that should be swappable independently of the stream feeding them.

## Channel

`effect/Channel` — stable

The primitive underlying `Stream` and `Sink`. `Channel<OutElem, OutErr, OutDone, InElem, InErr, InDone, Env>` — emits `OutElem`, may fail `OutErr`, finishes with `OutDone`; accepts upstream `InElem` that may fail `InErr` and finish `InDone`; needs `Env`. `Stream` is a channel that only outputs; `Sink` is a channel that consumes and produces a single done value.

Channels **pipe** (output of one becomes input of the next), **sequence**, and **concatenate**.

```ts
import { Channel } from "effect"

// The shape, annotated. Most params default sensibly — a plain source is just
// Channel<A>.
type EmployeeSource = Channel.Channel<{ id: string; level: string }>
// outputs employee objects, never fails, done = void

type GrantCodec = Channel.Channel<
  { employeeId: string; shares: number },  // OutElem — decoded grant objects
  Error,                                    // OutErr  — how emission can fail
  void,                                     // OutDone — terminal value when done
  Uint8Array,                               // InElem  — raw bytes from upstream
  Error,                                    // InErr   — how upstream can fail
  unknown,                                  // InDone  — upstream's terminal value
  never                                     // Env     — required services
>

// You consume a channel by running it or, far more often, by wrapping it back
// into a Stream — which is exactly what the encoding codecs hand you.
const drained = Channel.runDrain(Channel.fromArray([{ id: "e1", level: "IC4" }]))

// Efficiently concatenate a channel of byte chunks into one Uint8Array.
// Unlike repeated pairwise concatenation, collection is linear.
const bytes = Channel.mkUint8Array(
  Channel.fromArray([
    [new Uint8Array([1, 2])],
    [new Uint8Array([3, 4])]
  ] as const)
)
```

Two details for code that runs channels directly. **`Channel.runDrain` returns the channel's done value** (`Effect<OutDone, OutErr, Env>`); the separate `Channel.runDone` was removed in `rc.113`, so use `runDrain` when only the terminal value matters. **`Channel.catchDefect`** (and `Stream.catchDefect` above it) recovers from defects only — typed failures and interruption pass through — which keeps a throwing codec step from taking down a long-lived channel without hiding real cancellation.

The Web Streams interop set is complete at this level: `fromReadableStream`, `fromWritableStream`, and `fromTransformStream` adapt host streams, while `pullIntoWritableStream` exposes a channel that writes into an existing target. Each constructor takes an explicit host-error mapper so failures stay typed and interruption cancels outstanding I/O.

> **Note:** The common reason to touch `Channel` directly is `Stream.pipeThroughChannel`. The `Sse`, `Ndjson`, and `SchemaBinary` modules are channels spliced into stream pipelines via that combinator.

**Use when** authoring a new stream/sink operator, writing a stateful byte codec, or implementing a genuinely bidirectional protocol. For normal data flow, stay in `Stream`.

## ChannelSchema

`effect/ChannelSchema` — stable

Adapter layer that attaches a `Schema` to a channel boundary. `ChannelSchema.encode(schema)()` converts typed values to the schema's encoded form; `ChannelSchema.decode(schema)()` validates the inverse. `duplex` wraps a bidirectional channel so callers see typed I/O while the inner channel speaks the wire format.

Schema failures surface as `SchemaError` in the error channel. Encoding/decoding service requirements propagate as channel requirements. The `Ndjson.decodeSchema` and `Sse.decodeDataSchema` helpers stack `ChannelSchema.decode` internally — typically consumed transitively. `SchemaBinary` is different: it compiles its own binary layout from the schema instead of validating an already-parsed value.

```ts
import { ChannelSchema, Schema, Stream } from "effect"

// A typed EquityGrant that comes in over the wire in encoded form.
const EquityGrant = Schema.Struct({
  employeeId: Schema.String,
  shares: Schema.Natural,
  grantDate: Schema.String,
  strikePrice: Schema.Finite
})

// A channel that validates+decodes encoded EquityGrant chunks into typed grants.
// Note the thunk: decode(schema) returns a function you call () to specialize
// the input-error / done type params.
const decodeGrants = ChannelSchema.decode(EquityGrant)()

// Splice it into a stream of already-parsed JSON values to get typed, validated
// grants (SchemaError lands in the stream's error channel).
declare const rawGrants: Stream.Stream<{ employeeId: string; shares: number; grantDate: string; strikePrice: number }>
const grants = rawGrants.pipe(Stream.pipeThroughChannel(decodeGrants))
```

**Use when** building a custom typed codec over a channel boundary. For standard wire formats, prefer the `*.decodeSchema` helpers which wire this up automatically.

## Take

`effect/Take` — stable

`Take<A, E, Done>` is a reified single-pull result: either a `NonEmptyReadonlyArray<A>` (a batch), or an `Exit` that is a failure (`E`) or successful completion carrying `Done`. Used to store or transport "what the stream produced in one step" — e.g. bridging a stream through a `Queue` or `PubSub`.

`Take.toPull` converts it back into a live pull step. Paired with `Stream.toPubSubTake` / `fromPubSubTake` and `Stream.flattenTake` to ferry chunks-plus-termination across concurrency primitives intact.

```ts
import { Effect, Exit, Take } from "effect"

// A Take carries one pull's worth of news about a merit-cycle approval stream.
// It's a NonEmptyReadonlyArray when values arrive, or an Exit when the stream ends/fails.
const approvals: Take.Take<{ employeeId: string; approved: boolean }> =
  [{ employeeId: "e1", approved: true }, { employeeId: "e2", approved: false }]

const failed: Take.Take<never, string> = Exit.fail("ReviewServiceUnavailable")
const ended: Take.Take<never> = Exit.succeed(undefined) // stream completed

// Interpret a stored Take as a live pull step.
const step = Take.toPull(approvals)
// Pull<NonEmptyReadonlyArray<{ employeeId: string; approved: boolean }>, never, void>
const _ = Effect.runSync(step)
// [{ employeeId: "e1", approved: true }, { employeeId: "e2", approved: false }]
```

**Use when** routing a stream's output through a `Queue` or `PubSub` and the end/error signal must be preserved alongside values, or when implementing custom buffering.

**Wire codecs: streaming bytes ↔ typed values.**

All three modules below are under `effect/unstable/encoding` and are **unstable** (API may change). Each is a channel spliced via `Stream.pipeThroughChannel`. Decode: bytes/text in, typed objects out. Encode: objects in, bytes/text out. Each has a plain variant and a `*Schema*` variant that validates against a `Schema` at the boundary.

## Ndjson

`effect/unstable/encoding/Ndjson` — unstable

Newline-delimited JSON codecs as channels. `Ndjson.decodeString()` splits on newlines and `JSON.parse`s each line. `Ndjson.decode()` takes `Uint8Array` input (handles UTF-8). Failures are a tagged `NdjsonError` with `kind: "Pack"` (encoding) or `"Unpack"` (decoding). `decodeSchemaString(Schema)()` fuses split → parse → validate in one channel.

```ts
import { DateTime, Schema, Stream } from "effect"
import { Ndjson } from "effect/unstable/encoding"

// An equity-grant record exported by the EquityLedger as NDJSON.
class EquityGrant extends Schema.Class<EquityGrant>("EquityGrant")({
  employeeId: Schema.String,
  grantDate: Schema.DateTimeUtcFromString,
  shares: Schema.Natural,
  strikePrice: Schema.Finite
}) {}

// Decode a raw NDJSON export of equity grants → validated EquityGrant objects.
const decodeGrants = Stream.make(
  `{"employeeId":"e1","grantDate":"2023-01-15T00:00:00Z","shares":1000,"strikePrice":42.50}\n` +
    `{"employeeId":"e2","grantDate":"2024-03-01T00:00:00Z","shares":500,"strikePrice":61.00}\n`
).pipe(
  Stream.pipeThroughChannel(Ndjson.decodeSchemaString(EquityGrant)()),
  Stream.runCollect
)

// Round-trip: decode NDJSON export → filter recently granted → re-encode to NDJSON.
const recentGrants = Stream.make(
  `{"employeeId":"e1","grantDate":"2023-01-15T00:00:00Z","shares":1000,"strikePrice":42.50}\n` +
    `{"employeeId":"e2","grantDate":"2024-03-01T00:00:00Z","shares":500,"strikePrice":61.00}\n`
).pipe(
  Stream.pipeThroughChannel(Ndjson.decodeSchemaString(EquityGrant)()),
  Stream.filter((g) => g.shares >= 750),
  Stream.pipeThroughChannel(Ndjson.encodeSchemaString(EquityGrant)()),
  Stream.runCollect
)

// Build a grant to round-trip through the encoder (DateTime.makeUnsafe accepts ISO strings).
const sampleGrant = new EquityGrant({
  employeeId: "e3",
  grantDate: DateTime.makeUnsafe("2025-06-01T00:00:00Z"),
  shares: 2000,
  strikePrice: 75.00
})
```

> **Warning:** Blank lines raise `NdjsonError` by default. Pass `{ ignoreEmptyLines: true }` to `decodeString` / `decodeSchemaString` to skip them. Handle failures with `Stream.catchTag("NdjsonError", ...)`.

Both text lines and UTF-8 code points may straddle incoming chunks: the decoder buffers either boundary correctly. You do not need to align network chunks to newlines or character boundaries.

> **Warning:** The decoder has no maximum line length: it retains an incomplete line until its newline arrives, so one newline-free upload is one unbounded allocation. For untrusted input, cap the byte stream first with `Stream.limitBytes(limit, () => Stream.fail(...))`: the total cap is then also the largest line the decoder can ever hold.

**Use when** consuming or producing a streaming JSON HTTP body, tailing a JSON log file, or processing bulk exports line by line.

## Sse

`effect/unstable/encoding/Sse` — unstable

Server-Sent Events codec. `Sse.decode()` parses SSE text chunks into `Event` values with `id`, `event`, and `data` fields. An SSE `retry:` directive surfaces as a `Retry` failure in the error channel, making reconnect logic straightforward error handling. `Sse.encode()` renders `Event`s as SSE wire text. `Sse.decodeDataSchema(schema)` JSON-decodes the `data` payload while preserving `event` name and `id`.

```ts
import { Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"

// Parse a raw SSE stream of merit-cycle approval events.
const approvalEvents = Stream.make(
  "event: approved\ndata: {\"employeeId\":\"e1\",\"newSalary\":110000}\n\n",
  "event: rejected\ndata: {\"employeeId\":\"e2\",\"newSalary\":105000}\n\n"
).pipe(
  Stream.pipeThroughChannel(Sse.decode()),
  // A `retry:` directive arrives as a Retry failure — perfect hook for reconnect.
  Stream.catchTag("Retry", () => Stream.empty),
  Stream.runCollect
)

// JSON-decode just the `data` field against a schema, keep id/event metadata.
// This models live approval decisions streamed from the ReviewService.
const ApprovalDecision = Schema.Struct({
  employeeId: Schema.String,
  newSalary: Schema.Finite
})

const meritApprovals = Stream.make(
  `data: {"employeeId":"e1","newSalary":110000}\n\n`,
  `data: {"employeeId":"e2","newSalary":120000}\n\n`
).pipe(
  // decodeDataSchema decodes the `data` field and preserves the SSE envelope
  Stream.pipeThroughChannel(Sse.decodeDataSchema(ApprovalDecision)),
  // e.data is typed as { employeeId: string, newSalary: number }
  Stream.filter((e) => e.data.newSalary > 100_000),
  Stream.runCollect
)
```

An omitted or empty `event:` field decodes as the standard event type `"message"`. Decoding limits the pending event to 10 MiB by default; set `{ maxEventSize }` on `decode` / `decodeDataSchema` when the protocol needs a different bound, and handle an oversized event as `SseError` with an `EventTooLarge` reason. Line endings may be `\n`, `\r\n`, or `\r`, mixed freely within one stream. Generated [`HttpApiClient`](../interfaces/http-api#httpapiclient) methods accept the same decode options per call as `sseOptions`.

**Use when** consuming an SSE endpoint for live typed events with built-in reconnect signalling.

## SchemaBinary

`effect/unstable/encoding/SchemaBinary` — unstable

A compact binary codec **derived from a Schema** rather than from the runtime shape of a value. It replaced the MessagePack codec (`Msgpack`, `RpcSerialization.layerMsgPack`, and the `msgpackr` dependency were removed in `rc.113`), and it is now what EventLog persistence, EventLog remote messages, and TCP cluster transports put on the wire.

The layout is compiled once from the *encoded* side of the schema, so field names are not repeated per value: an array of structs is written as a row run that declares its shape once and back-references repeated strings. There are two wire modes:

- **Default** — tolerant of compatible schema evolution. Struct fields are identified by a hashed field id, so peers may add optional fields independently. Pin an id with `SchemaBinary.fieldId(n)` to survive a property rename or to resolve a hash collision.
- **`{ fingerprint: true }`** — positional layout plus an 8-byte layout hash. Frames are smaller, but both peers must use the *same* schema definition; a mismatch is rejected instead of being misread.

```ts
import { Schema, Stream } from "effect"
import { SchemaBinary } from "effect/unstable/encoding"

// Payroll-run telemetry frame: compact binary between internal services.
const PayrollFrame = Schema.Struct({
  // fieldId pins the wire identity, so renaming `runId` later stays compatible.
  runId: Schema.String.pipe(SchemaBinary.fieldId(1)),
  employeeId: Schema.String,
  grossPay: Schema.Finite,
  netPay: Schema.Finite
})

// One value ↔ one frame: toCodec is an ordinary Schema codec to Uint8Array.
const codec = SchemaBinary.toCodec(PayrollFrame)
const oneFrame = Schema.encodeUnknownSync(codec)({
  runId: "run_2025_06",
  employeeId: "e1",
  grossPay: 8333.33,
  netPay: 6100
})
const roundTripped = Schema.decodeUnknownSync(codec)(oneFrame)

// Streams: encode typed frames to bytes for inter-service transport.
const packed = Stream.make(
  { runId: "run_2025_06", employeeId: "e1", grossPay: 8333.33, netPay: 6100.00 },
  { runId: "run_2025_06", employeeId: "e2", grossPay: 10000.00, netPay: 7300.00 }
).pipe(
  Stream.pipeThroughChannel(SchemaBinary.encode(PayrollFrame)()),
  Stream.runCollect // Array<Uint8Array>
)

// Decode incoming bytes back into typed records. Frames may be split across
// chunks or concatenated within one; bound the buffered frame for untrusted peers.
declare const binaryFrames: Stream.Stream<Uint8Array<ArrayBuffer>>
const payrollFrames = binaryFrames.pipe(
  Stream.pipeThroughChannel(SchemaBinary.decode(PayrollFrame, { maxFrameSize: 1024 * 1024 })()),
  Stream.runCollect
)
```

Every failure is a `Schema.SchemaError` — there is no separate codec error type. The decoder keeps one frame parser for the life of the channel: values completed before a bad frame are still emitted, and an incomplete trailing frame fails when upstream ends instead of being dropped silently. `maxFrameSize` is **unset by default**, so set it whenever the peer is not trusted. `SchemaBinary.duplex({ inputSchema, outputSchema })` wraps a bidirectional byte channel the same way `Ndjson.duplexSchema` does.

Two ownership details matter in practice. Encoded results are arena-backed views that may share a larger buffer, so call `bytes.slice()` before retaining a frame beyond the current step. And for one long-lived connection, `SchemaBinary.encoder(schema, { dictionary: true })` with the matching `SchemaBinary.parser(...)` shares a string dictionary across frames: repeated strings cost one reference after first use, but frames no longer stand alone and must be decoded in order by the parser that saw the earlier ones.

> **Warning:** Because the layout comes from the schema, the schema *is* the wire contract. In the default mode, evolve it compatibly (add optional fields, pin ids before renaming). In fingerprint mode, deploy both peers together. Data persisted by a pre-`rc.113` EventLog journal is MessagePack and is not readable by the SchemaBinary codec.

**Use when** you need a compact, schema-validated binary frame format over a socket, worker, or file where human readability is not required and both ends share Effect schemas. Prefer `Ndjson` when the other side is not an Effect program or when frames must be inspectable.

> **Tip:** Every codec is a channel composed the same way: `stream.pipe(Stream.pipeThroughChannel(Codec.decode…(MySchema)()))`. Bytes in, typed objects out — or reverse with the encoder. `Ndjson`, `Sse`, and `SchemaBinary` are the same shape with different wires.

**Configuration formats.** The remaining parsers decode human-authored configuration text into unknown data. Schema-decode their results before trusting them at an application boundary.

## Ini

`effect/unstable/encoding/Ini` — unstable

A small, dependency-free INI decoder used by the CLI configuration-file primitive. `Ini.parse(text)` returns a null-prototype record: dotted section names become nested records, `key[]` repetitions become arrays, and `true`, `false`, and `null` become scalars. Other values — including numbers — remain strings.

```ts
import { Ini } from "effect/unstable/encoding"

const config = Ini.parse(`
enabled=true
region[]=eu-west-1
region[]=eu-south-2

[database.pool]
size=10
`)
// { enabled: true, region: ["eu-west-1", "eu-south-2"],
//   database: { pool: { size: "10" } } }
```

Use for conventional INI configuration input. Parse is synchronous and deliberately returns `unknown` values; decode the result with `Schema` before using it as application config.

## Toml

`effect/unstable/encoding/Toml` — unstable

A focused TOML parser covering tables, dotted keys, arrays and inline tables, arrays of tables, multiline strings, numeric formats, and TOML date/time forms. Tables are null-prototype records. Offset date-times become JavaScript `Date`s; local dates and times remain strings. Duplicate or malformed keys throw `SyntaxError`.

```ts
import { Toml } from "effect/unstable/encoding"

const config = Toml.parse(`
title = "Merit service"
ports = [8000, 8001]
[database]
enabled = true
credentials = { user = "service", roles = ["reader", "writer"] }
`)
```

Use when the CLI or another trusted boundary accepts TOML. Wrap `Toml.parse` with `Effect.try` if syntax failures belong in a typed effect channel, then validate its result with `Schema`.

## Yaml

`effect/unstable/encoding/Yaml` — unstable

A focused YAML 1.2 configuration parser. It supports block and flow collections, quoted and block scalars, anchors, and aliases. Invalid indentation, duplicate keys, malformed collections, and unknown aliases throw `SyntaxError`.

```ts
import { Yaml } from "effect/unstable/encoding"

const config = Yaml.parse(`
name: merit-service
enabled: true
ports: [3000, 3001]
database:
  host: localhost
  roles: [reader, writer]
`)
```

This is a configuration-focused parser, not a promise of every YAML feature. Treat parsed values as untrusted and schema-decode them before application use.
