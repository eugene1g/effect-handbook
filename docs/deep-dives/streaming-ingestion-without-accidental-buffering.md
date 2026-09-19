# Streaming Ingestion Without Accidental Buffering

> Audited **2026-09-18** against `effect@4.0.0-rc.115`. Stable stream primitives come from `effect`; the NDJSON codec used here is the unstable `effect/unstable/encoding` surface and should be version-pinned.

A streaming import is not constant-memory merely because its type is `Stream`. Constant-memory behavior comes from the whole pipeline: a pull-based source, incremental framing, bounded records, bounded concurrency, bounded batches, and a terminal consumer that does not collect the complete input.

Examples are labelled **Runnable**, **Contextual**, or **Illustrative**. Each code block includes its external imports; contextual files also name their local imports. Use [Streaming & Channels](../concurrency/streaming-channels) for the operator catalog, [Schema](../data/schema) for boundary decoding, and [Platform & Runtime Hosts](../interfaces/platform-runtime-hosts) for filesystem and stdin sources.

## Start with the memory equation

For an ingestion pipeline, approximate live memory as:

```text
source chunks in flight
+ incomplete frame or line
+ decoded records in flight
+ current database batch
+ retries and observability payloads retained by your code
```

Pull-based back-pressure prevents the source from running arbitrarily far ahead, but operators can weaken that guarantee:

- `Stream.runCollect` retains every output until completion.
- `Stream.buffer({ capacity: "unbounded" })` explicitly removes a memory bound.
- `Stream.callback` and `Stream.fromEventListener` buffer **without bound by default**; nothing in the pipeline's types shows it. Pass `bufferSize`.
- `Stream.mapEffect(..., { concurrency: "unbounded" })` permits unbounded in-flight effects. A finite `concurrency: n` is itself a buffer of `n` inputs and results.
- `Stream.grouped(n)` retains up to `n` decoded elements per batch; choose `n` deliberately.
- `Stream.buffer` and concurrent stages run *ahead of demand*: a `take` placed after them does not stop the reads that already started.
- a framing decoder must retain an incomplete final record, so an unbounded record is still an unbounded allocation.
- retrying a materialized batch keeps that batch alive and may repeat its external effects.

The goal is bounded memory relative to documented maximum chunk, record, batch, and concurrency sizes—not a magical zero-buffer pipeline. Audit a pipeline stage by stage against the [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides) inventory: every row has a default, and several defaults are unbounded or larger than you would choose (`groupByKey` buffers up to 4096 elements per key and never retires a key unless `idleTimeToLive` is set).

## Prove framing across arbitrary chunks

Network and file chunks do not line up with UTF-8 code points or newlines. `Ndjson.decodeSchema` consumes byte chunks, carries incomplete text and lines across pulls, parses each completed line, and decodes it through a Schema.

**Runnable — Node 26+:**

```ts
import { Effect, Schema, Stream } from "effect"
import { Ndjson } from "effect/unstable/encoding"

class EmployeeRow extends Schema.Class<EmployeeRow>("EmployeeRow")({
  employeeId: Schema.String,
  salary: Schema.Finite
}) {}

const encoder = new TextEncoder()
const bytes = encoder.encode(
  '{"employeeId":"e-1","salary":95000}\n' +
  '{"employeeId":"e-2","salary":105000}\n'
)

// Deliberately split in the middle of JSON tokens. The decoder, not the
// source, owns framing.
const source = Stream.make(
  bytes.slice(0, 11),
  bytes.slice(11, 43),
  bytes.slice(43)
)

const program = source.pipe(
  Stream.pipeThroughChannel(Ndjson.decodeSchema(EmployeeRow)()),
  Stream.runCollect
)

console.log(await Effect.runPromise(program))
```

`runCollect` is appropriate in this tiny framing probe because the input is intentionally bounded. It is not the production sink.

## Put decoding at the boundary

Decode before business logic so downstream elements are domain values, not `unknown`. Refine numeric and textual domains in the Schema instead of checking them after persistence.

**Contextual — `src/import-domain.ts`:**

```ts
import { Schema } from "effect"

export const EmployeeId = Schema.String.pipe(Schema.brand("EmployeeId"))

export class EmployeeRow extends Schema.Class<EmployeeRow>("EmployeeRow")({
  employeeId: EmployeeId,
  cycleId: Schema.String,
  salary: Schema.Finite.check(Schema.isGreaterThan(0)),
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))
}) {}

export class ImportSourceError extends Schema.TaggedError<ImportSourceError>()(
  "ImportSourceError",
  { message: Schema.String }
) {}

export class ImportStoreError extends Schema.TaggedError<ImportStoreError>()(
  "ImportStoreError",
  { message: Schema.String }
) {}
```

The NDJSON channel contributes `NdjsonError` for framing/JSON failures and `SchemaError` for values that parse as JSON but violate `EmployeeRow`. Keep that distinction if operations need separate malformed-file and bad-record reporting.

## Batch only at the storage boundary

Batching is useful when the destination has a bulk API. Keep records as individual stream elements through decode and normalization, then group immediately before the bulk write.

**Contextual — `src/employee-import.ts`:**

```ts
import { Context, Effect, Stream } from "effect"
import { Ndjson } from "effect/unstable/encoding"
import {
  EmployeeRow,
  ImportStoreError
} from "./import-domain.ts"

export class EmployeeBatchStore extends Context.Service<EmployeeBatchStore, {
  readonly upsert: (
    rows: ReadonlyArray<EmployeeRow>
  ) => Effect.Effect<void, ImportStoreError>
}>()("app/EmployeeBatchStore") {}

export interface ImportSummary {
  readonly batches: number
  readonly rows: number
}

export const ingestEmployees = <SourceError, SourceRequirements>(
  source: Stream.Stream<Uint8Array, SourceError, SourceRequirements>
) => Effect.gen(function*() {
  const store = yield* EmployeeBatchStore

  return yield* source.pipe(
    Stream.pipeThroughChannel(
      Ndjson.decodeSchema(EmployeeRow)({ ignoreEmptyLines: true })
    ),
    // At most 250 decoded records are retained for this batch. The final batch
    // may be smaller.
    Stream.grouped(250),
    // Default concurrency is sequential: one transaction and one retained
    // batch at this stage.
    Stream.mapEffect((batch) =>
      store.upsert(batch).pipe(
        Effect.as({ batches: 1, rows: batch.length } as const)
      )
    ),
    Stream.runFold(
      (): ImportSummary => ({ batches: 0, rows: 0 }),
      (total, next) => ({
        batches: total.batches + next.batches,
        rows: total.rows + next.rows
      })
    )
  )
})
```

The terminal fold retains only two counters. `Stream.runDrain` would be simpler if no summary were required; `Stream.runForEach` is appropriate for one-record writes. Do not collect merely to compute a count.

If bulk writes benefit from overlap, set an explicit finite concurrency and confirm that the database pool, transaction semantics, ordering requirements, and retained batch memory all support it.

**Illustrative.** This operator is incomplete until `writeBatch` is bound to an idempotent application adapter.

<!-- effect-example id=streaming.write-bounded-overlap check=pseudocode -->
```ts
import { Stream } from "effect"

const writeWithBoundedOverlap = Stream.mapEffect(writeBatch, {
  concurrency: 2,
  unordered: true
})

declare const writeBatch: (
  batch: ReadonlyArray<unknown>
) => import("effect").Effect.Effect<void>
```

`unordered: true` improves completion throughput only when output order is irrelevant. It does not make database writes commute.

### Batch by size or time when the source is live

`Stream.grouped(250)` is right for a file: the stream ends, so the last partial batch flushes. On a queue-, socket-, or PubSub-backed source it is wrong: a partial batch waits for the 250th record indefinitely, holding its records in memory and making downstream latency unbounded. `Stream.groupedWithin(n, duration)` flushes on whichever limit is reached first.

**Illustrative:**

```ts
import { Stream } from "effect"

declare const hrisChangeFeed: Stream.Stream<{ readonly employeeId: string }>

// Write at most 250 rows per batch, and never hold a row longer than 2 seconds.
const changeBatches = hrisChangeFeed.pipe(Stream.groupedWithin(250, "2 seconds"))
```

**A buffer is not a batcher.** `Stream.buffer({ capacity: 250 })` and `Sink.forEachArray` look like batching and are not: a buffer sets flow-control depth, and `forEachArray` receives whatever chunk was pulled — single elements after any `mapEffect` stage. Only `grouped`, `groupedWithin`, `rechunk`, or a [transduced Sink](../concurrency/streaming-channels#adapting-leftovers-and-repeatable-batching) (for batches bounded by bytes instead of count) define the batch the destination sees.

Official guide: [Stream operations](https://effect.website/docs/v4/stream/operations) (see its grouping section).

## Connect a real source at the edge

Business ingestion accepts a `Stream<Uint8Array, E, R>`. The entrypoint chooses where those bytes come from.

**Contextual — filesystem source:**

```ts
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import { ingestEmployees, EmployeeBatchStore } from "./employee-import.ts"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const bytes = fs.stream("./imports/employees.ndjson", {
    chunkSize: 64 * 1024
  })
  return yield* ingestEmployees(bytes)
})

declare const EmployeeBatchStoreLive: Layer.Layer<EmployeeBatchStore>

const RuntimeLayer = Layer.merge(
  EmployeeBatchStoreLive,
  NodeFileSystem.layer
)

program.pipe(
  Effect.provide(RuntimeLayer),
  NodeRuntime.runMain
)
```

`FileSystem.stream` is lazy and scoped by the stream run. The platform implementation closes its handle when the stream completes, fails, or is interrupted.

**Contextual — HTTP response source:**

```ts
import { Effect } from "effect"
import {
  HttpClient,
  HttpClientResponse
} from "effect/unstable/http"
import { ingestEmployees } from "./employee-import.ts"

export const importFromUrl = (url: string) => Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk)
  )
  return yield* ingestEmployees(response.stream)
})
```

Do not call a full-body decoder such as `arrayBuffer`, `text`, `json`, or `schemaBodyJson` before constructing the stream. Those APIs intentionally materialize the body.

### When you write the source adapter yourself

`FileSystem.stream` and `response.stream` already own their handles. A hand-written adapter — a vendor SDK cursor, a database export, a message subscription — must make the same promise: **the handle is acquired inside the stream and released by the stream**, on completion, failure, interruption, and early stop alike.

**Illustrative — self-contained adapter.** `openVendorExport` stands in for the vendor SDK; the error mirrors `ImportSourceError` from `src/import-domain.ts`.

```ts
import { Cause, Effect, Option, Schema, Stream } from "effect"

class ImportSourceError extends Schema.TaggedError<ImportSourceError>()(
  "ImportSourceError",
  { message: Schema.String }
) {}

interface VendorExport {
  // One network read per call; None means the export is exhausted.
  readonly nextChunk: Effect.Effect<Option.Option<Uint8Array>, ImportSourceError>
  readonly close: Effect.Effect<void>
}

declare const openVendorExport: (
  exportId: string
) => Effect.Effect<VendorExport, ImportSourceError>

export const vendorExportBytes = (
  exportId: string
): Stream.Stream<Uint8Array, ImportSourceError> =>
  Stream.unwrap(
    Effect.acquireRelease(openVendorExport(exportId), (handle) => handle.close).pipe(
      Effect.map((handle) =>
        Stream.fromEffectRepeat(
          Effect.flatMap(
            handle.nextChunk,
            Option.match({ onNone: () => Cause.done(), onSome: (chunk) => Effect.succeed(chunk) })
          )
        )
      )
    )
  )
```

`Stream.unwrap` removes the `Scope` requirement and keeps the scope open for as long as the returned stream is being pulled. Two ways to get this wrong: opening the export *before* building the stream and closing it "after the import" leaks on the first decode failure, and a reader that downloads the whole export and then calls `Stream.fromIterable` is an all-at-once read wearing a stream's type. The scope-placement pitfall of `Stream.scoped` is covered in [Owning resources inside a stream](../concurrency/streaming-channels#6-owning-resources-inside-a-stream).

## Treat failure policy as part of the import contract

There are three common policies, and they are not interchangeable:

1. **Fail fast.** The first malformed record or failed batch fails the stream. This is the simplest choice for replace-all imports and transactional staging tables.
2. **Record and continue.** Convert a per-record validation failure into a typed dead-letter record, persist it, and continue. This requires framing JSON separately from Schema decoding so one bad decoded value can be handled without terminating the codec channel: decode each framed value inside `Stream.mapEffect` and turn its `SchemaError` into data there, or split the stream with `Stream.partition` and drain the rejected branch into the dead-letter store (both branches must be consumed concurrently inside one `Effect.scoped`).
3. **Quarantine the file.** Abort the import, preserve source identity and offset information, and move the entire object to a review path.

The capstone uses fail-fast semantics. `Ndjson.decodeSchema` fails the channel on the first invalid line; catching the error after the channel cannot recover the remaining lines because the decoder has terminated. If partial acceptance is a requirement, design it explicitly rather than adding a broad `Stream.catch` at the end.

This is the general rule for every stream recovery operator: a failure is terminal for the failed region, and `Stream.catch`, `catchTag`, or `catchCause` can only *append a different stream* after the elements already delivered — rows written before the failure stay written. The operator table, including `Stream.timeout` ending a stalled source **silently** rather than failing, is in [Handling stream failures](../concurrency/streaming-channels#5-handling-stream-failures).

Official guide: [Error handling in streams](https://effect.website/docs/v4/stream/error-handling) (its "timeoutFail"-style headings are v3 names; rc.115 has `Stream.timeoutOrElse`).

## Delivery and transaction semantics

A back-pressured stream provides flow control, not exactly-once persistence.

- If a batch commits and the process dies before its completion is checkpointed, rerunning the import can write it again.
- `Stream.retry(schedule)` takes an ordinary `Schedule` and recreates and reruns its upstream region, re-acquiring the source. Placing it around a database write can duplicate already committed effects. The schedule resets as soon as the restarted stream emits one element, so a long-lived feed gets a fresh backoff budget after each successful reconnect instead of exhausting `upTo({ times: 5 })` over its lifetime.
- Give each row or batch a stable source identity and use an upsert, unique constraint, idempotency key, or transactional staging table.
- Keep checkpoint advancement in the same transaction as the destination write when both live in one database.
- For a durable background job, move the file/import identity through `PersistedQueue` or a `Workflow`; streaming itself does not survive process restart.

Continue with [The Durability and Distribution Ladder](./durability-and-distribution-ladder) when an import must resume after deployment or machine failure.

## Back-pressure across push sources

`Stream.fromQueue` respects the Queue's capacity and strategy. A bounded Queue with the suspending strategy pushes back on Effect producers. Browser callbacks and third-party event emitters may not be able to suspend; the adapter must choose whether to buffer, drop, slide, pause the source, or fail.

`Stream.callback(register, { bufferSize, strategy })` is where that choice is written down — and **omitting the options chooses an unbounded buffer**. A synchronous listener can only call `Queue.offerUnsafe`, which never waits: on a full buffer it returns `false` under `"suspend"` and `"dropping"` (the new value is lost) and evicts the oldest value under `"sliding"`. So `"suspend"` protects nothing for a callback source; pick `"dropping"` or `"sliding"` as a stated loss policy and count the losses, or move the producer into an Effect that awaits `Queue.offer` on a bounded queue. The same queue ends the stream (`Queue.endUnsafe`) and fails it (`Queue.failCauseUnsafe`); an adapter that never does either leaves the import hanging when the socket closes. See [Creating streams](../concurrency/streaming-channels#1-creating-streams) for the full adapter and [Queue](../concurrency/concurrency-coordination#queue) for overload semantics.

`Stream.buffer({ capacity: n })` decouples producer and consumer by up to `n` elements. The default finite strategy is `"suspend"`; `"dropping"` and `"sliding"` intentionally lose values. `Stream.bufferArray` buffers pulled chunks instead of individual elements and preserves chunking. Neither is a free performance switch: measure throughput and memory with realistic record sizes. A buffer also reads ahead of demand — behind `Stream.buffer({ capacity: 64 })` a consumer that takes one element has already caused dozens of source reads — so put `take` and other demand limits *upstream* of buffers.

Official guide: [Stream operations](https://effect.website/docs/v4/stream/operations) (see its buffering section).

## A bounded runtime probe

This test verifies chunk-boundary independence, batching, and the final summary without using a file or database.

**Contextual — `test/employee-import.test.ts`:**

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import {
  EmployeeBatchStore,
  ingestEmployees
} from "../src/employee-import.ts"

it.effect("decodes split records and writes one bounded batch", () =>
  Effect.gen(function*() {
    const sizes = yield* Ref.make<ReadonlyArray<number>>([])
    const store = Layer.succeed(
      EmployeeBatchStore,
      EmployeeBatchStore.of({
        upsert: (rows) => Ref.update(sizes, (all) => [...all, rows.length])
      })
    )

    const encoded = new TextEncoder().encode(
      '{"employeeId":"e-1","cycleId":"fy27","salary":95000,"level":4}\n' +
      '{"employeeId":"e-2","cycleId":"fy27","salary":105000,"level":5}\n'
    )

    const summary = yield* ingestEmployees(Stream.make(
      encoded.slice(0, 7),
      encoded.slice(7, 71),
      encoded.slice(71)
    )).pipe(Effect.provide(store))

    assert.deepStrictEqual(summary, { batches: 1, rows: 2 })
    assert.deepStrictEqual(yield* Ref.get(sizes), [2])
  }))
```

### Prove laziness, prefix-sensitivity, and cleanup

The test above proves framing and batching. It does not prove that the pipeline is *incremental*, and it would still pass if the source were read completely before the first write. Three cheap, deterministic proofs close that gap, and each rejects one plausible wrong implementation:

| Proof | Assertion | Wrong implementation it rejects |
|---|---|---|
| Laziness | building the pipeline performs **zero** reads | a source that starts reading when it is constructed |
| Prefix-sensitivity | requesting `n` elements performs exactly `n` reads | collect-then-slice, or a buffer placed before the demand limit |
| Cleanup | the release counter is exactly `1` after early stop, after a mid-stream failure, and after interruption | a demand-correct pipeline that lost its finalizer |

Use a probe source that emits **one element per read** (`Stream.unfold`), because demand is satisfied per chunk: over `Stream.fromIterable` or a 64 KiB file chunk, `take(2)` legitimately reads a whole chunk, and the assertion has to be "at most one chunk past the prefix". Acquire the probe's resource *inside* the stream so the release counter observes every exit path. Assert the counters, not just the values — the values are identical in the correct and the leaking implementation.

**Runnable — `@effect/vitest`, self-contained (`test/stream-demand.test.ts`):**

```ts
import { assert, it } from "@effect/vitest"
import { Data, Deferred, Effect, Exit, Fiber, Ref, Stream } from "effect"

class CursorFailed extends Data.TaggedError("CursorFailed")<{
  readonly row: number
}> {}

// One read yields one row, so `reads` is an exact demand meter. The cursor is
// acquired inside the stream, so `releases` observes every exit path.
const makeProbeSource = (options?: { readonly failAt?: number }) =>
  Effect.gen(function*() {
    const reads = yield* Ref.make(0)
    const releases = yield* Ref.make(0)
    const rows = Stream.unwrap(
      Effect.acquireRelease(
        Effect.void,
        () => Ref.update(releases, (n) => n + 1)
      ).pipe(
        Effect.as(Stream.unfold(
          0,
          Effect.fnUntraced(function*(row: number) {
            yield* Ref.update(reads, (n) => n + 1)
            if (row === options?.failAt) {
              return yield* new CursorFailed({ row })
            }
            return [`emp_${row}`, row + 1] as const
          })
        ))
      )
    )
    return { rows, reads, releases }
  })

it.effect("is lazy, prefix-sensitive, and releases on early stop", () =>
  Effect.gen(function*() {
    const source = yield* makeProbeSource()

    const firstThree = source.rows.pipe(
      Stream.map((id) => id.toUpperCase()),
      Stream.take(3)
    )
    // Building the pipeline performs no reads: nothing runs until a runner pulls.
    assert.strictEqual(yield* Ref.get(source.reads), 0)

    const out = yield* Stream.runCollect(firstThree)
    assert.deepStrictEqual(out, ["EMP_0", "EMP_1", "EMP_2"])
    // Collect-then-slice over this infinite source would never get here.
    assert.strictEqual(yield* Ref.get(source.reads), 3)
    assert.strictEqual(yield* Ref.get(source.releases), 1)
  }))

it.effect("releases the source when a row fails", () =>
  Effect.gen(function*() {
    const source = yield* makeProbeSource({ failAt: 2 })
    const exit = yield* Effect.exit(Stream.runDrain(source.rows))
    assert.isTrue(Exit.isFailure(exit))
    assert.strictEqual(yield* Ref.get(source.reads), 3)
    assert.strictEqual(yield* Ref.get(source.releases), 1)
  }))

it.effect("releases the source when the consumer is interrupted", () =>
  Effect.gen(function*() {
    const source = yield* makeProbeSource()
    const writing = yield* Deferred.make<void>()

    const fiber = yield* source.rows.pipe(
      // The first write signals, then never finishes.
      Stream.mapEffect(() =>
        Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never))
      ),
      Stream.runDrain,
      Effect.forkChild
    )

    yield* Deferred.await(writing) // handshake, not a sleep
    yield* Fiber.interrupt(fiber)
    assert.strictEqual(yield* Ref.get(source.releases), 1)
  }))
```

The interruption test synchronizes on a `Deferred` handshake instead of a sleep: the fiber is interrupted only after the first write has provably started. When the stage under test is an ordered `mapEffect`, assert the exact output order; with `unordered: true`, compare as a set, because completion order is not part of the contract.

For load tests, track peak resident memory, destination latency, queue depth, batch duration, retry count, and records per second. A fast happy-path benchmark can hide a catastrophic retry or oversized-record path.

## Capstone design

A production ingestion feature should have these explicit pieces:

- a source adapter that acquires its handle inside the stream and closes it on completion, failure, interruption, and early stop;
- a wire codec that handles arbitrary chunk boundaries;
- a Schema that turns `unknown` into domain values;
- a documented maximum input and record size;
- a finite batch size (plus a time bound when the source is live) and finite concurrency;
- an explicit `bufferSize` and loss policy on every callback or event-listener source;
- a destination method with idempotent or transactional semantics;
- a typed decision for malformed records: fail, dead-letter, or quarantine;
- incremental counters and telemetry rather than collected records;
- a durable outer job identity if the import must resume after restart;
- tests that split input at hostile byte positions, count reads for a requested prefix, and assert the release counter after early stop, failure, and interruption.

## Operational checklist

- Never use `runCollect` on an unbounded or externally sized source.
- Avoid `"unbounded"` buffers and concurrency in ingestion paths — including the implicit one: `Stream.callback` without `bufferSize`.
- Limit demand, not the result: `Stream.take(n)` before the runner, and upstream of buffers and concurrent stages.
- Bound record size as well as source chunk and batch size.
- Keep decoding incremental; do not materialize an HTTP or file body first.
- Put `grouped(n)` next to the bulk-write boundary; use `groupedWithin(n, duration)` when the source never ends. A buffer's capacity is not a batch size.
- Acquire source handles inside the stream (`Stream.unwrap` over `Effect.acquireRelease`), never before it.
- Decide whether output order matters before enabling unordered concurrency.
- Make external writes idempotent before adding retry.
- Keep checkpoint and destination updates atomic where possible.
- Observe lag, in-flight work, failures, throughput, and retained memory.
- Remember that `Stream.timeout` ends a stalled source silently; use `Stream.timeoutOrElse` with a failing fallback when silence is an error.
- Verify cleanup by interrupting an active source in tests, and assert the release counter rather than the emitted values.

For the lower-level mechanics behind codecs, continue with [Streaming & Channels](../concurrency/streaming-channels). For deterministic tests around delays and interruption, continue with [Testing an Effect Application](./testing-an-effect-application).
