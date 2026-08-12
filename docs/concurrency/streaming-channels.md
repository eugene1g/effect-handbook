# Streaming & Channels

`Stream<A, E, R>` is a pull-based source: the consumer requests the next chunk, the stream computes it (possibly failing with `E`, needing services `R`), emits the chunk, and waits. This pull loop provides automatic back-pressure. `Sink<A, In, L, E, R>` folds chunks into a final answer. `Channel` is the bidirectional primitive both are built from. In practice: live in `Stream` 95% of the time; reach for `Channel` only when authoring a new operator.

> **Official examples:** Effect's release-matched [`ai-docs` Stream examples](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/03_stream) cover creation, transformation, consumption, and NDJSON/Msgpack encoding.

## Stream

`effect/Stream` — stable

`Stream<A, E, R>` is a lazy, pull-based, possibly-infinite sequence of `A`s that can fail with `E` and needs services `R`. Pulling provides automatic back-pressure and supports constant-memory pipelines when each stage keeps bounded state. Collecting, unbounded grouping/buffering, or letting producers outrun consumers can still consume memory proportional to the data. Combinators cover three operations: create, transform, run.

### 1. Creating streams

| Source type | Constructor |
|---|---|
| In-memory data | `fromIterable` / `fromArray` / `make` |
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
import { Array, Clock, Effect, Option, Queue, Schedule, Schema, Stream } from "effect"

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

// Any callback/event API: push into the Queue, end it to finish.
class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {
  cause: Schema.Defect()
}) {}

// Bridge a WebSocket that streams live payroll-run events into a typed Stream.
const payrollEvents = Stream.callback<{ runId: string; status: string }, HrisUnavailable>(
  Effect.fn(function*(queue) {
    const ws = new WebSocket("wss://hris.example.com/payroll-events")
    const onMessage = (e: MessageEvent) =>
      Queue.offerUnsafe(queue, JSON.parse(e.data as string) as { runId: string; status: string })
    yield* Effect.acquireRelease(
      Effect.sync(() => ws.addEventListener("message", onMessage)),
      () => Effect.sync(() => ws.removeEventListener("message", onMessage))
    )
  })
)
```

### 2. Transforming streams

- `map` / `filter` / `filterMap` — pure per-element transforms.
- `mapEffect` — effectful per-element, accepts `{ concurrency: n | "unbounded" }`.
- `flatMap` — fans each element into a sub-stream; also concurrency-aware.
- `grouped` — batch into chunks.
- `throttle` — rate-limit.
- `changes` — dedupe consecutive equal elements.

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

> **Tip:** `mapEffect`, `flatMap`, `mergeAll`, and friends all accept `{ concurrency: n }` or `{ concurrency: "unbounded" }`. Ordering is preserved unless `{ unordered: true }` is passed. In-flight fibers are interrupted when downstream stops pulling.

### 3. Running streams

| Runner | Behavior |
|---|---|
| `runCollect` | Gathers all elements into an array (bounded streams only). |
| `runDrain` | Executes for effects, discards output. |
| `runForEach` | Runs an effect per element. |
| `runFold` | Reduces to one value. |
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

For byte streams, `Stream.limitBytes(n)` fails once the limit is exceeded and `Stream.mkArrayBuffer` collects an `ArrayBuffer` without losing the concrete backing-buffer type. Web Streams are first-class: `Stream.fromReadableStream` bridges a browser/WHATWG source, while the Channel layer below also supports writable and transform streams. In Node, `NodeStream.fromReadable({ evaluate, onError, closeOnDone? })` lazily evaluates a `node:stream` `Readable`, maps its errors into the typed channel, and closes it when done by default; see [Platform & Runtime Hosts](../interfaces/platform-runtime-hosts).

**Use when** you need back-pressured, incrementally-produced data with typed errors and bounded concurrency; choose bounded-state operators when constant-memory behavior matters.

## Sink

`effect/Sink` — stable

`Sink<A, In, L, E, R>` consumes elements of type `In`, may fail with `E`, needs `R`, and produces a result `A` plus unconsumed leftover `L`. The leftover slot enables early termination without discarding unused elements — two sinks can be sequenced so the second picks up exactly where the first stopped.

Key APIs: `Sink.sum`, `Sink.count`, `Sink.head()`, `Sink.last()`, `Sink.take(n)`, `Sink.fold`, `Sink.reduce`, `Sink.forEach`, `Sink.drain`. The collect-all sink is `Sink.collect()` (function call, not `Sink.collectAll`).

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

`Sink.fromWritableStream({ evaluate, onError })` adapts a WHATWG `WritableStream` into a back-pressured Sink. Construction is scoped and cancellation/close follows the Sink lifecycle, so use it for browser responses, compression streams, or other host-native writable targets.

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

The Web Streams interop set is complete at this level: `fromReadableStream`, `fromWritableStream`, and `fromTransformStream` adapt host streams, while `pullIntoWritableStream` exposes a channel that writes into an existing target. Each constructor takes an explicit host-error mapper so failures stay typed and interruption cancels outstanding I/O.

> **Note:** The common reason to touch `Channel` directly is `Stream.pipeThroughChannel`. The `Sse`, `Ndjson`, and `Msgpack` modules are channels spliced into stream pipelines via that combinator.

**Use when** authoring a new stream/sink operator, writing a stateful byte codec, or implementing a genuinely bidirectional protocol. For normal data flow, stay in `Stream`.

## ChannelSchema

`effect/ChannelSchema` — stable

Adapter layer that attaches a `Schema` to a channel boundary. `ChannelSchema.encode(schema)()` converts typed values to the schema's encoded form; `ChannelSchema.decode(schema)()` validates the inverse. `duplex` wraps a bidirectional channel so callers see typed I/O while the inner channel speaks the wire format.

Schema failures surface as `SchemaError` in the error channel. Encoding/decoding service requirements propagate as channel requirements. The `Ndjson.decodeSchema`, `Sse.decodeSchema`, and `Msgpack.decodeSchema` helpers all stack `ChannelSchema.decode` internally — typically consumed transitively.

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

An omitted or empty `event:` field decodes as the standard event type `"message"`. Decoding limits the pending event to 10 MiB by default; set `{ maxEventSize }` on `decode` / `decodeDataSchema` when the protocol needs a different bound, and handle an oversized event as `SseError` with an `EventTooLarge` reason.

**Use when** consuming an SSE endpoint for live typed events with built-in reconnect signalling.

## Msgpack

`effect/unstable/encoding/Msgpack` — unstable

MessagePack codecs as channels — the same decode/encode/`*Schema`/`duplex` family as `Ndjson`, but wire form is compact binary. `Msgpack.decode()` takes `Uint8Array` chunks and emits unpacked values. `Msgpack.decodeSchema(schema)()` adds schema validation. Failures are a tagged `MsgPackError`. Channel interface is identical to `Ndjson`, so swapping a pipeline between the two is mostly find-and-replace.

```ts
import { Schema, Stream } from "effect"
import { Msgpack } from "effect/unstable/encoding"

// Payroll-run telemetry frame: compact binary between internal services.
const PayrollFrame = Schema.Struct({
  runId: Schema.String,
  employeeId: Schema.String,
  grossPay: Schema.Finite,
  netPay: Schema.Finite
})

// Encode payroll frames to compact MessagePack bytes for inter-service transport.
const packed = Stream.make(
  { runId: "run_2025_06", employeeId: "e1", grossPay: 8333.33, netPay: 6100.00 },
  { runId: "run_2025_06", employeeId: "e2", grossPay: 10000.00, netPay: 7300.00 }
).pipe(
  Stream.pipeThroughChannel(Msgpack.encodeSchema(PayrollFrame)()),
  Stream.runCollect // Array<Uint8Array>
)

// Decode incoming binary frames from the PayrollClient back into typed records.
declare const binaryFrames: Stream.Stream<Uint8Array<ArrayBuffer>>
const payrollFrames = binaryFrames.pipe(
  Stream.pipeThroughChannel(Msgpack.decodeSchema(PayrollFrame)()),
  Stream.runCollect
)
```

The decoder buffers an incomplete MessagePack value across input chunks, but if the stream ends before that value is complete it fails with `MsgPackError` instead of silently dropping the truncated final frame.

**Use when** you need a compact, schema-validated binary frame format over a socket or file where human readability is not required.

> **Tip:** Every codec is a channel composed the same way: `stream.pipe(Stream.pipeThroughChannel(Codec.decodeSchema(MySchema)()))`. Bytes in, typed objects out — or reverse with `encodeSchema`. `Ndjson`, `Sse`, and `Msgpack` are all the same shape with different wires.

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
