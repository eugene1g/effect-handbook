# Streaming Ingestion Without Accidental Buffering

> Audited **2026-08-12** against `effect@4.0.0-rc.108`. Stable stream primitives come from `effect`; the NDJSON codec used here is the unstable `effect/unstable/encoding` surface and should be version-pinned.

A streaming import is not constant-memory merely because its type is `Stream`. Constant-memory behavior comes from the whole pipeline: a pull-based source, incremental framing, bounded records, bounded concurrency, bounded batches, and a terminal consumer that does not collect the complete input.

Examples are labelled **Runnable**, **Contextual**, or **Illustrative**. Each code block includes its external imports; contextual files also name their local imports. Use [Streaming & Channels](../concurrency/streaming-channels.md) for the operator catalog, [Schema](../data/schema.md) for boundary decoding, and [Platform & Runtime Hosts](../interfaces/platform-runtime-hosts.md) for filesystem and stdin sources.

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
- `Stream.mapEffect(..., { concurrency: "unbounded" })` permits unbounded in-flight effects.
- `Stream.grouped(n)` retains up to `n` decoded elements per batch; choose `n` deliberately.
- a framing decoder must retain an incomplete final record, so an unbounded record is still an unbounded allocation.
- retrying a materialized batch keeps that batch alive and may repeat its external effects.

The goal is bounded memory relative to documented maximum chunk, record, batch, and concurrency sizes—not a magical zero-buffer pipeline.

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
    chunkSize: FileSystem.KiB(64)
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

## Treat failure policy as part of the import contract

There are three common policies, and they are not interchangeable:

1. **Fail fast.** The first malformed record or failed batch fails the stream. This is the simplest choice for replace-all imports and transactional staging tables.
2. **Record and continue.** Convert a per-record validation failure into a typed dead-letter record, persist it, and continue. This requires framing JSON separately from Schema decoding so one bad decoded value can be handled without terminating the codec channel.
3. **Quarantine the file.** Abort the import, preserve source identity and offset information, and move the entire object to a review path.

The capstone uses fail-fast semantics. `Ndjson.decodeSchema` fails the channel on the first invalid line; catching the error after the channel cannot recover the remaining lines because the decoder has terminated. If partial acceptance is a requirement, design it explicitly rather than adding a broad `catchAll` at the end.

## Delivery and transaction semantics

A back-pressured stream provides flow control, not exactly-once persistence.

- If a batch commits and the process dies before its completion is checkpointed, rerunning the import can write it again.
- `Stream.retry` recreates and reruns its upstream region. Placing it around a database write can duplicate already committed effects.
- Give each row or batch a stable source identity and use an upsert, unique constraint, idempotency key, or transactional staging table.
- Keep checkpoint advancement in the same transaction as the destination write when both live in one database.
- For a durable background job, move the file/import identity through `PersistedQueue` or a `Workflow`; streaming itself does not survive process restart.

Continue with [The Durability and Distribution Ladder](./durability-and-distribution-ladder.md) when an import must resume after deployment or machine failure.

## Back-pressure across push sources

`Stream.fromQueue` respects the Queue's capacity and strategy. A bounded Queue with the suspending strategy pushes back on Effect producers. Browser callbacks and third-party event emitters may not be able to suspend; the adapter must choose whether to buffer, drop, slide, pause the source, or fail.

`Stream.buffer({ capacity: n })` decouples producer and consumer by up to `n` elements. The default finite strategy is `"suspend"`; `"dropping"` and `"sliding"` intentionally lose values. `Stream.bufferArray` buffers pulled chunks instead of individual elements and preserves chunking. Neither is a free performance switch: measure throughput and memory with realistic record sizes.

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

For load tests, track peak resident memory, destination latency, queue depth, batch duration, retry count, and records per second. A fast happy-path benchmark can hide a catastrophic retry or oversized-record path.

## Capstone design

A production ingestion feature should have these explicit pieces:

- a source adapter that yields bytes and closes on interruption;
- a wire codec that handles arbitrary chunk boundaries;
- a Schema that turns `unknown` into domain values;
- a documented maximum input and record size;
- a finite batch size and finite concurrency;
- a destination method with idempotent or transactional semantics;
- a typed decision for malformed records: fail, dead-letter, or quarantine;
- incremental counters and telemetry rather than collected records;
- a durable outer job identity if the import must resume after restart;
- tests that split input at hostile byte positions and interrupt during writes.

## Operational checklist

- Never use `runCollect` on an unbounded or externally sized source.
- Avoid `"unbounded"` buffers and concurrency in ingestion paths.
- Bound record size as well as source chunk and batch size.
- Keep decoding incremental; do not materialize an HTTP or file body first.
- Put `grouped(n)` next to the bulk-write boundary.
- Decide whether output order matters before enabling unordered concurrency.
- Make external writes idempotent before adding retry.
- Keep checkpoint and destination updates atomic where possible.
- Observe lag, in-flight work, failures, throughput, and retained memory.
- Verify cleanup by interrupting an active source in tests.

For the lower-level mechanics behind codecs, continue with [Streaming & Channels](../concurrency/streaming-channels.md). For deterministic tests around delays and interruption, continue with [Testing an Effect Application](./testing-an-effect-application.md).
