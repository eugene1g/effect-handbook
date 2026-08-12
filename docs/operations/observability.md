# Observability

_Effect ships structured logging, spans, and metrics as first-class runtime citizens. The export layer is separate — use a local collector for development, an OTLP endpoint for production, or skip export in tests._

> **Official examples:** Effect's release-matched [`ai-docs` observability examples](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/08_observability) cover production logging and OTLP tracing.

## Logger

`effect/Logger` — stable

A `Logger<Message, Output>` receives a log event (message, level, cause, fiber, timestamp, annotations, log spans) and produces output. The runtime calls every installed logger for every event. Multiple loggers run simultaneously; install with `Logger.layer([...])`.

**Mental model.** `Logger` is the sink of Effect's structured logging pipeline. Sources are `Effect.log`, `Effect.logInfo`, `Effect.logError`, etc. Annotations (`Effect.annotateLogs`) flow through the fiber automatically to every logger on every event. Logger is a service provided via layer — never threaded as an argument.

### The built-in loggers

- **consolePretty()** — Human-readable TTY output with optional color. Development default. Options: `{ colors: false }` for CI; also `stderr`, `mode`, `formatDate`.
- **consoleJson / formatJson** — One JSON object per line. For log aggregation pipelines (Datadog, Loki, CloudWatch).
- **consoleLogFmt / formatLogFmt** — logfmt (`key=value` pairs). Compact, grep-friendly, popular in Go/Kubernetes ecosystems; level names are uppercase.
- **consoleStructured / formatStructured** — Plain JS object per event. For in-memory inspection and custom transforms.
- **formatSimple** — Compact quoted `key=value` text; level names are uppercase (`INFO`, `WARN`, `ERROR`).
- **batched(logger, { window, flush })** — Collects entries for a time window then calls `flush` with the batch. Returns `Effect<Logger, never, Scope>`.
- **toFile(logger, path)** — Pipes a string logger to a file. Requires `FileSystem` (`NodeFileSystem.layer` on Node.js). Returns `Effect<Logger, PlatformError, Scope | FileSystem>`.

### Installing and swapping loggers

```ts
import { Config, Effect, Layer, Logger, References } from "effect"
import { NodeFileSystem } from "@effect/platform-node"

// Replace the default logger with JSON-lines (production).
export const JsonLoggerLayer = Logger.layer([Logger.consoleJson])

// Raise the minimum level — Debug/Info calls become no-ops below "Warn".
export const WarnLevelLayer = Layer.succeed(References.MinimumLogLevel, "Warn")

// File logger: write simple-format logs to disk, scoped lifecycle.
// Logger.toFile is dual — first arg is the string-producing logger, second is the path.
export const FileLoggerLayer = Logger.layer([
  Logger.toFile(Logger.formatSimple, "/var/log/comp-service.log")
]).pipe(Layer.provide(NodeFileSystem.layer))

// Batched remote logger — flush a whole batch at once.
// Logger.batched is dual: (logger, options) or curried. It requires Scope.
export const RemoteLoggerLayer = Logger.layer([
  Logger.batched(Logger.formatStructured, {
    window: "2 seconds",
    flush: Effect.fn(function*(batch) {
      // send batch to your log aggregator here
      yield* Effect.log(`flushing ${batch.length} entries`)
    })
  })
])

// Pick logger based on NODE_ENV.
export const AppLoggerLayer = Layer.unwrap(
  Effect.gen(function*() {
    const env = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"))
    return env === "production"
      ? JsonLoggerLayer.pipe(Layer.provideMerge(WarnLevelLayer))
      : Logger.layer([Logger.consolePretty()])
  })
)
```

### Structured log calls and annotations — merit-cycle run

```ts
import { Effect } from "effect"

// Annotate every log line inside a merit-calculation run with structured context.
// Effect.annotateLogs injects key/value pairs into every log event emitted by the
// wrapped effect. Effect.withLogSpan adds an elapsed-ms field named "merit-run".
const runMeritCycle = (cycleId: string, employeeId: string) =>
  Effect.fn("MeritCycle.run")(
    function*() {
      yield* Effect.logDebug("loading employee comp band")
      yield* Effect.logInfo("calculating merit increase", { cycleId, employeeId })
      yield* Effect.logWarning("employee near band ceiling", { employeeId, bandMax: 180_000 })
      yield* Effect.logError("HRIS lookup failed", { employeeId })
    },
    // Every log line emitted inside gets these key/value pairs attached.
    Effect.annotateLogs({
      service: "comp-service",
      reviewCycle: cycleId,
      employeeId // PII — see the redaction example below
    }),
    // Adds a "merit-run=<elapsed_ms>" field to every log line.
    Effect.withLogSpan("merit-run")
  )
```

### Custom loggers — redacting PII

```ts
import { Formatter, Logger, References } from "effect"

// Logger.make receives an Options object: { message, logLevel, cause, fiber, date }.
// Log messages are commonly arrays, and annotations live in a fiber reference rather
// than directly on the Options object.
const piiRedactingLogger = Logger.make<unknown, void>((opts) => {
  const redactText = (value: unknown) =>
    typeof value === "string"
      ? value.replace(/\b[Ee]mployee[Ii]d["\s:=]+[\w-]+/g, "employeeId=REDACTED")
      : value
  const messages = globalThis.Array.isArray(opts.message) ? opts.message : [opts.message]
  const safeMessage = messages.map((message) => Formatter.format(redactText(message))).join(" ")

  const annotations = opts.fiber.getRef(References.CurrentLogAnnotations)
  const safeAnnotations = Object.fromEntries(
    Object.entries(annotations).map(([key, value]) => [
      key,
      key.toLowerCase() === "employeeid" ? "<redacted>" : redactText(value)
    ])
  )
  const suffix = Formatter.format(safeAnnotations)
  if (opts.logLevel === "Error" || opts.logLevel === "Fatal") {
    console.error(`[${opts.logLevel}] ${safeMessage} ${suffix}`)
  } else {
    console.log(`[${opts.logLevel}] ${safeMessage} ${suffix}`)
  }
})
```

This example redacts the top-level `employeeId` annotation and matching strings. Production PII policy should recurse through structured messages/annotations or, better, avoid attaching sensitive values in the first place.

**Reach for it when** swapping log format, adding a file sink, shipping logs to a remote aggregator, or building a custom audit trail (e.g. PII-redacting logger) on top of Effect's structured log events.

## LogLevel

`effect/LogLevel` — stable

`LogLevel` is the union `"All" | "Fatal" | "Error" | "Warn" | "Info" | "Debug" | "Trace" | "None"`, plus helpers `LogLevel.Order`, `isGreaterThan`, `isEnabled`, and ordinal comparison. The runtime compares each event's level against `References.MinimumLogLevel` before dispatching to any logger.

**Mental model.** Levels form a linear severity scale. `"All"` is below every real level (lets everything through). `"None"` is above every real level (silences everything). Events *below* the minimum are dropped before any logger sees them.

```ts
import { Effect, Layer, References } from "effect"

// Silence all Debug/Trace logs during a merit-cycle batch run to reduce noise.
const quietMeritRun = runMeritBatch.pipe(
  Effect.provide(Layer.succeed(References.MinimumLogLevel, "Info"))
)

// Completely disable logging inside a tight payroll-calculation hot path.
const silentPayrollCalc = calculateAllRaises.pipe(
  Effect.provide(Layer.succeed(References.MinimumLogLevel, "None"))
)

// Read the current minimum level from the fiber context.
const checkLevel = Effect.gen(function*() {
  const min = yield* References.MinimumLogLevel
  yield* Effect.log(`comp-service minimum log level: ${min}`)
})
```

**Reach for it when** adjusting log verbosity for a specific scope, comparing levels programmatically, or setting a global minimum via config.

## Console

`effect/Console` — stable

A service wrapping the browser/Node.js `console` object. Every method (`Console.log`, `Console.error`, `Console.warn`, `Console.group`, `Console.time`, etc.) returns `Effect<void>`. The `Console` reference in context can be swapped for testing.

**Mental model.** Use `Console.*` for raw, unstructured side-effect output (debug dumps, CLI feedback). For production structured logging use `Effect.log*` + a `Logger`.

```ts
import { Console, Effect } from "effect"

// Debug-dump an employee's comp snapshot to the console during local development.
const dumpEmployeeComp = (employeeId: string, baseSalary: number, band: { min: number; max: number }) =>
  Effect.gen(function*() {
    yield* Console.log(`comp snapshot for ${employeeId}`)
    yield* Effect.scoped(Effect.gen(function*() {
      yield* Console.group({ label: "band details", collapsed: true })
      yield* Console.table([
        { field: "baseSalary", value: baseSalary },
        { field: "bandMin", value: band.min },
        { field: "bandMax", value: band.max }
      ])
    }))
    if (baseSalary > band.max) {
      yield* Console.error("salary exceeds band ceiling — review required")
    }
  })

// In tests: swap Console to suppress output.
import { Layer } from "effect"

const SilentConsole = Layer.succeed(Console.Console, {
  log: () => Effect.void,
  error: () => Effect.void,
  warn: () => Effect.void,
  // ...rest of Console interface
} as any)
```

**Reach for it when** you need testable console output or mix Effect with raw console calls in a CLI tool.

## Formatter

`effect/Formatter` — stable

Value-formatting utility. `format(input)` applies a value's `Redactable` representation before pretty-printing arbitrary values (handles cycles, `BigInt`, typed arrays, class instances). `formatJson(input)` uses JSON semantics with the same redaction precedence, serializes a `bigint` as a quoted string with its `n` suffix, and omits circular object properties; other unsupported JSON values retain the normal `JSON.stringify` behavior. Also provides `formatDate`, `formatPath`, `formatPropertyKey`. Used internally by built-in loggers to render log messages and annotation values.

**Mental model.** Rarely called directly. `Effect.log("msg", someObject)` renders `someObject` via `Formatter.format` inside the default logger. Reach for it explicitly when building a custom logger or serializing values in a custom Schema codec.

```ts
import { Formatter } from "effect"

// Pretty-print a merit recommendation object (handles BigInt salaries, nested objects)
const rec = { employeeId: "E-001", newSalary: 145_000n, meritPct: 0.05 }
console.log(Formatter.format(rec))
// => '{ employeeId: "E-001", newSalary: 145000n, meritPct: 0.05 }'

// formatJson safely preserves bigint's printed identity as a JSON string.
console.log(Formatter.formatJson({ baseSalary: 130_000n, grantDate: "2025-01-15" }))
// => '{"baseSalary":"130000n","grantDate":"2025-01-15"}'
```

**Reach for it when** building a custom logger that needs to render Effect values consistently with the default logger, or for cycle-safe pretty-printing outside a logging context.

## Tracer

`effect/Tracer` — stable

Low-level tracing model. A `Tracer` service creates `Span` objects when the runtime forks or executes traced operations. Each `Span` records name, parent, `SpanKind`, attributes, links, events, start/end time (as `bigint` nanoseconds), and whether it was sampled. Drive it through higher-level Effect APIs and swap the backend via layer.

**Mental model.** Every `Effect.withSpan("name")` creates a child span under the currently active span in fiber context (`Tracer.ParentSpan`). With no parent it becomes a trace root. The `Tracer` reference (`Context.Reference`) determines where spans go — the default in-memory `NativeSpan` is a no-op exporter; swap in an OTLP or OTel tracer to ship them.

### Core tracing APIs — wrapping a merit-calculation run

```ts
import { Effect, Tracer } from "effect"

// Wrap a merit calculation in a span so the entire run is visible in traces.
const calculateMeritIncrease = (employeeId: string, cycleId: string) =>
  Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({
      "employee.id": employeeId,
      "merit.cycleId": cycleId
    })

    // Each sub-step gets its own child span.
    const band = yield* fetchCompBand(employeeId).pipe(
      Effect.withSpan("hris.fetchCompBand", {
        attributes: { "db.table": "comp_bands", "employee.id": employeeId },
        kind: "client"
      })
    )

    const rating = yield* fetchPerformanceRating(employeeId, cycleId).pipe(
      Effect.withSpan("review.fetchRating", { kind: "client" })
    )

    return yield* computeRaise(band, rating)
  }).pipe(
    Effect.withSpan("merit.calculateIncrease")
  )

// Mark the nightly payroll export as a trace root so it starts a fresh trace,
// not a child of whatever triggered it.
const nightlyPayrollExport = runPayrollExport.pipe(
  Effect.withSpan("payroll.nightlyExport", { root: true })
)

// Bridge an incoming W3C trace-context header from the HRIS webhook.
const bridgedSpan = Tracer.externalSpan({
  traceId: webhookHeaders["x-trace-id"],
  spanId: webhookHeaders["x-span-id"],
  sampled: true
})
const handleHrisWebhook = processHrisEvent.pipe(
  Effect.withSpan("hris.webhook", { parent: bridgedSpan })
)
```

### Effect.fn traces automatically

```ts
import { Effect } from "effect"

// Effect.fn("label") creates a span named "label" for every invocation.
// This is the idiomatic way to add tracing to service methods.
const applyMeritIncrease = Effect.fn("CompService.applyMeritIncrease")(
  function*(employeeId: string, increaseAmount: bigint) {
    yield* Effect.annotateCurrentSpan({
      "employee.id": employeeId,
      "merit.amount": Number(increaseAmount)
    })
    yield* Effect.sleep("30 millis") // simulated HRIS write
  }
)
```

### Span links — fan-in across approval steps

```ts
import { Effect, Tracer } from "effect"

// After all approvers sign off on raise recommendations, link their spans.
const finalizeApprovalChain = (priorApprovalSpan: Tracer.AnySpan) =>
  Effect.annotateCurrentSpan({ "approval.step": "vp-review" }).pipe(
    Effect.withSpan("approvalChain.finalize", {
      links: [{ span: priorApprovalSpan, attributes: { "link.type": "prior-approval" } }]
    })
  )
```

**Reach for it when** implementing a custom tracer backend, bridging an external trace context, or tuning sampling. For day-to-day use, `Effect.withSpan` and `Effect.fn` suffice.

## Metric

`effect/Metric` — stable

Typed, composable metrics registry. Define counters, gauges, histograms, summaries, and frequency maps as values; update them anywhere; read or export state. Metrics are stored in a global registry keyed by name + attributes — the same metric referenced from different modules accumulates to the same counter.

**Mental model.** Metrics are pull-based: declare them, update as side-effects, then an exporter (Prometheus scrape, OTLP push, DevTools request) reads the registry at its own cadence. No push-on-update hot path by default — the registry is an in-memory map.

### The five metric types

| Type | Input | Use for |
| --- | --- | --- |
| `Metric.counter` | `number \| bigint` | Accumulated deltas: employees processed, errors, retries. Set `{ incremental: true }` to reject negative updates and enforce monotonic growth. |
| `Metric.gauge` | `number \| bigint` | Instantaneous values: budget remaining, active review workflows |
| `Metric.histogram` | `number` | Distributions with pre-defined buckets: merit-calc latency, raise amounts |
| `Metric.summary` | `number` | Rolling-window quantiles (p50/p99) without bucket pre-definition |
| `Metric.frequency` | `string` | String occurrence counts: performance ratings, approval outcomes |

```ts
import { Duration, Effect, Metric } from "effect"

// Counter — total employees processed in a merit cycle.
const employeesProcessed = Metric.counter("merit_employees_processed_total", {
  description: "Total employees processed in merit cycles"
})

// Gauge — remaining merit budget pool (BigInt for currency precision).
const meritBudgetRemaining = Metric.gauge("merit_budget_remaining_usd", {
  description: "Remaining merit budget pool in USD cents",
  bigint: true
})

// Histogram — distribution of individual raise amounts.
const raiseAmountMs = Metric.histogram("merit_raise_amount_usd", {
  description: "Distribution of approved raise amounts in USD",
  boundaries: Metric.linearBoundaries({ start: 0, width: 1000, count: 20 })
  // normalized boundaries: $1000, $2000, ..., $18000, Infinity
})

// Summary — rolling-window merit-calculation latency quantiles.
const calcLatency = Metric.summary("merit_calc_latency_ms", {
  maxAge: Duration.minutes(5),
  maxSize: 1000,
  quantiles: [0.5, 0.9, 0.99]
})

// Frequency — count each PerformanceRating value across a cycle.
const ratingFrequency = Metric.frequency("merit_performance_ratings")

const processMeritRecommendation = Effect.fn("merit.processRecommendation")(
  function*(employeeId: string, raiseCents: bigint, rating: string) {
    const start = yield* Effect.clockWith((c) => Effect.sync(() => c.currentTimeMillisUnsafe()))

    // ... apply raise logic ...
    yield* Effect.sleep("30 millis")

    const end = yield* Effect.clockWith((c) => Effect.sync(() => c.currentTimeMillisUnsafe()))
    yield* Metric.update(employeesProcessed, 1)
    yield* Metric.modify(meritBudgetRemaining, -raiseCents)    // subtract from the current gauge
    yield* Metric.update(raiseAmountMs, Number(raiseCents))
    yield* Metric.update(calcLatency, end - start)
    yield* Metric.update(ratingFrequency, rating)
  }
)
```

### Tagging metrics at call sites — per-department breakdown

```ts
import { Effect, Metric } from "effect"

const employeesProcessed = Metric.counter("merit_employees_processed_total")

// Add attributes at a specific call site without creating a new metric object.
const processDepartmentBatch = (departmentId: string) =>
  Metric.update(
    Metric.withAttributes(employeesProcessed, { department: departmentId, cycleYear: "2025" }),
    1
  )
```

### Runtime metrics

```ts
import { Effect, Metric } from "effect"

// Add built-in fiber lifecycle metrics (fiber count, duration, etc.).
// Provide this layer at the top of your program.
const program = mainEffect.pipe(
  Effect.provide(Metric.enableRuntimeMetricsLayer)
)
```

**Reach for it when** tracking throughput, budget drawdown, raise distributions, or any numeric signal. Pair with `OtlpMetrics` or `PrometheusMetrics` to export.

## Otlp

`effect/unstable/observability/Otlp` — unstable

All-in-one OTLP layer. Wires `OtlpLogger`, `OtlpMetrics`, and `OtlpTracer` from a single config, posting to `/v1/logs`, `/v1/metrics`, and `/v1/traces` under a shared `baseUrl`.

**Mental model.** `Otlp.layerJson({ baseUrl, resource })` activates full observability. Bundles serialization, batching, retry-on-429, and graceful flush at shutdown. Requires `HttpClient`. Per-signal export intervals: `loggerExportInterval`, `metricsExportInterval`, `tracerExportInterval`.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"

// layerJson bakes in JSON serialization — no OtlpSerialization dep needed.
export const ObservabilityLayer = Otlp.layerJson({
  baseUrl: "http://localhost:4318",
  resource: {
    serviceName: "comp-service",
    serviceVersion: "2.0.0",
    attributes: { "deployment.environment": "production" }
  },
  // Optional per-signal tuning:
  // loggerExportInterval: "2 seconds",
  // metricsExportInterval: "30 seconds",
  // tracerExportInterval: "5 seconds",
  // metricsTemporality: "delta"
}).pipe(Layer.provide(FetchHttpClient.layer))

Layer.launch(Main.pipe(Layer.provide(ObservabilityLayer))).pipe(
  NodeRuntime.runMain
)
```

Prefer `layerJson` for most projects. Use `layerProtobuf` when the collector requires protobuf encoding. Use the lower-level `layer` when providing `OtlpSerialization` yourself.

**Reach for it when** you want a single layer for logs + metrics + traces with zero boilerplate. Recommended starting point for new projects.

## OtlpLogger

`effect/unstable/observability/OtlpLogger` — unstable

An Effect `Logger` that serializes log records as OTLP log records and ships them via HTTP. Includes log level, message, annotations, cause, fiber id, and current trace/span ids. Batches are flushed on scope finalization to prevent log loss on graceful shutdown.

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization } from "effect/unstable/observability"

// Ship comp-service structured logs (with employeeId/cycleId annotations) to
// a local OTLP collector. OtlpLogger.layer merges with existing loggers by default.
export const CompServiceLogLayer = OtlpLogger.layer({
  url: "http://localhost:4318/v1/logs",
  resource: { serviceName: "comp-service" },
  exportInterval: "1 second",
  // excludeLogSpans: true  — omit withLogSpan metadata from records
}).pipe(
  Layer.provide(OtlpSerialization.layerJson),
  Layer.provide(FetchHttpClient.layer)
)
```

Use `OtlpLogger.layerFromConfig()` to read endpoint URL and headers from `OTEL_EXPORTER_OTLP_*` environment variables.

**Reach for it when** exporting only logs, or assembling a custom observability stack per signal.

## OtlpMetrics

`effect/unstable/observability/OtlpMetrics` — unstable

Periodically reads the Effect metric registry and posts snapshots to an OTLP metrics endpoint. Supports `"cumulative"` and `"delta"` aggregation temporality.

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpMetrics, OtlpSerialization } from "effect/unstable/observability"

// Export merit-cycle throughput counters and budget gauges every 30 seconds.
export const MeritMetricsLayer = OtlpMetrics.layer({
  url: "http://localhost:4318/v1/metrics",
  resource: { serviceName: "comp-service" },
  exportInterval: "30 seconds",
  temporality: "delta"  // or "cumulative"
}).pipe(
  Layer.provide(OtlpSerialization.layerJson),
  Layer.provide(FetchHttpClient.layer)
)
```

**Reach for it when** using metrics only, or assembling a custom per-signal stack.

## OtlpTracer

`effect/unstable/observability/OtlpTracer` — unstable

Replaces the Effect runtime's `Tracer` with one that batches and exports finished spans over OTLP/HTTP. Spans include trace and span IDs, parent links, attributes, events, timing, kind, and status.

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability"

// Export merit-calculation spans to a staging collector using protobuf encoding.
export const CompTracingLayer = OtlpTracer.layer({
  url: "http://localhost:4318/v1/traces",
  resource: {
    serviceName: "comp-service",
    serviceVersion: "1.0.0",
    attributes: { "deployment.environment": "staging" }
  },
  exportInterval: "5 seconds",
  maxBatchSize: 512
}).pipe(
  Layer.provide(OtlpSerialization.layerProtobuf), // protobuf encoding
  Layer.provide(FetchHttpClient.layer)
)
```

**Reach for it when** exporting traces only, or composing a custom per-signal observability stack.

## OtlpExporter

`effect/unstable/observability/OtlpExporter` — unstable

Shared batch-export engine used internally by `OtlpLogger`, `OtlpMetrics`, and `OtlpTracer`. Buffers items, posts encoded batches at a configurable interval, retries transient errors, honors HTTP 429 `Retry-After`, temporarily disables export after repeated failures (60 s backoff), and flushes on scope close. Typically not used directly.

For an explicit graceful-shutdown checkpoint, provide the shared `OtlpExporter.layerFlusher`, acquire `OtlpExporter.Flusher`, and run `flusher.flush`; it concurrently drains every registered signal exporter and cannot fail. There is no built-in timeout, so wrap it in `Effect.timeoutOption` when shutdown has a deadline. Registration is scoped, and exporters inside their temporary disabled window are skipped.

**Reach for it when** implementing a custom OTLP signal type that needs the same batching, retry, and graceful-shutdown behaviour as the built-in exporters.

## OtlpResource

`effect/unstable/observability/OtlpResource` — unstable

Builds the OTLP `Resource` object (service name, version, arbitrary attributes) attached to every exported signal. `OtlpResource.make({ serviceName, serviceVersion, attributes })` returns a `Resource`; `fromConfig` reads from a config record. Helpers `entriesToAttributes` and `unknownToAttributeValue` convert JS values to OTLP `KeyValue`/`AnyValue`.

**Reach for it when** building a custom OTLP exporter that needs standard resource metadata, or inspecting how Effect maps JS values to OTLP attribute types.

## OtlpSerialization

`effect/unstable/observability/OtlpSerialization` — unstable

A `Context.Service` class with three methods — `traces(data)`, `metrics(data)`, `logs(data)` — that convert in-memory OTLP data structures to `HttpBody` instances. Two implementations: `OtlpSerialization.layerJson` (JSON, default) and `OtlpSerialization.layerProtobuf` (binary protobuf, `application/x-protobuf`).

```ts
import { OtlpSerialization } from "effect/unstable/observability"

// JSON — zero extra deps, works everywhere.
export const JsonSerialization = OtlpSerialization.layerJson

// Protobuf — smaller on the wire, required by some collectors.
export const ProtobufSerialization = OtlpSerialization.layerProtobuf
```

**Reach for it when** choosing or swapping serialization format, or writing a custom signal exporter in the same service graph.

## PrometheusMetrics

`effect/unstable/observability/PrometheusMetrics` — unstable

Renders the Effect metric registry in Prometheus exposition format (text/plain version 0.0.4). `PrometheusMetrics.format()` returns `Effect<string>`; `PrometheusMetrics.layerHttp()` registers a `GET /metrics` route on the `HttpRouter` service in context.

```ts
import { Effect, Metric } from "effect"
import { PrometheusMetrics } from "effect/unstable/observability"
import { HttpRouter } from "effect/unstable/http"
import { Layer } from "effect"

// Standalone: format on demand — useful in a health-check endpoint.
const printMeritMetrics = Effect.gen(function*() {
  const text = yield* PrometheusMetrics.format({ prefix: "comp" })
  yield* Effect.log(text)
})

// HTTP route: Prometheus scrapes this to collect merit-cycle throughput metrics.
// PrometheusMetrics.layerHttp requires HttpRouter in context; provide HttpRouter.layer.
const MetricsLayer = PrometheusMetrics.layerHttp({ prefix: "comp", path: "/metrics" }).pipe(
  Layer.provide(HttpRouter.layer)
)
```

> **Tip:** Prometheus naming conventions expect `snake_case`. If Effect metrics use camelCase names, pass a `metricNameMapper` to `format` or `layerHttp`: `metricNameMapper: (n) => n.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()`.

**Reach for it when** running a Prometheus-compatible stack (Prometheus + Grafana, Victoria Metrics, etc.) and want metrics scraped via a pull endpoint.

> **Tip:** **New project?** Use `effect/unstable/observability/Otlp*`. No peer dependencies, works in Node, Bun, Deno, and browsers, purpose-built for Effect's data model. A single `Otlp.layerJson({ baseUrl, resource })` covers logs, metrics, and traces.
> **Existing OpenTelemetry SDK in the picture?** Use `@effect/opentelemetry`. It bridges Effect tracing/logging/metrics into the OTel API/SDK so existing `SpanProcessor`, `MetricReader`, and `LogRecordProcessor` pipelines keep working. The bridge is load-order sensitive for auto-instrumentation — read the NodeSdk docs carefully.
> You can also mix them: use `OtlpTracer` for lightweight span export while keeping `@effect/opentelemetry`'s `NodeSdk` for an existing metrics reader.

## DevTools

`effect/unstable/devtools/DevTools` — unstable

Application-side entry point for connecting to the Effect DevTools desktop app. `DevTools.layer(url?)` opens a WebSocket to `ws://localhost:34437` (or a custom URL) and mirrors spans and metric snapshots to the DevTools process. Zero configuration required for local development.

**Mental model.** DevTools is a development-only OTLP exporter that streams to a local GUI instead of a collector. Add `DevTools.layer()` alongside your `ObservabilityLayer` in development. Gate on `NODE_ENV` or remove in production.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Config, Layer } from "effect"
import { DevTools } from "effect/unstable/devtools"

const DevToolsLayer = Layer.unwrap(
  Config.string("NODE_ENV").pipe(
    Config.withDefault("development"),
    Config.map((env) =>
      env === "development"
        ? DevTools.layer()               // connects to ws://localhost:34437
        : Layer.empty
    )
  )
)

Layer.launch(Main.pipe(Layer.provide(DevToolsLayer))).pipe(
  NodeRuntime.runMain
)
```

`DevTools.layerWebSocket(url)` requires an explicit `Socket.WebSocketConstructor` in context. `DevTools.layerSocket` is the lowest-level variant accepting any `Socket.Socket`.

**Reach for it when** visually inspecting fiber topology, span trees, and live gauge values during development without setting up a collector.

## DevToolsClient

`effect/unstable/devtools/DevToolsClient` — unstable

Low-level socket protocol layer underneath `DevTools`. Drives the NDJSON duplex channel, queues `Ping` heartbeats, sends span starts/events/completions, responds to `MetricsRequest` messages by snapshotting the metric registry, and exposes `DevToolsClient.layerTracer` which installs a tracer that wraps the existing tracer and forwards events to the socket.

**Reach for it when** building a custom DevTools integration or embedding the DevTools protocol into a different transport (e.g. TCP socket, Unix pipe).

## DevToolsServer

`effect/unstable/devtools/DevToolsServer` — unstable

Server-side half of the DevTools protocol. `DevToolsServer.run` accepts a `Client` (a socket connection from a connected Effect application) and drives the conversation: receives span and metric data, sends metric snapshot requests and pong responses. Used by the Effect DevTools desktop app itself; not typically used in application code.

## DevToolsSchema

`effect/unstable/devtools/DevToolsSchema` — unstable

Schema definitions for the DevTools wire protocol — `Span`, `SpanEvent`, `Ping`/`Pong`, `MetricsRequest`, `MetricsSnapshot`, and the `Request`/`Response` discriminated unions. Both client and server use these schemas to encode/decode NDJSON frames over the WebSocket.

## OtelNodeSdk

`@effect/opentelemetry — import { NodeSdk } from "@effect/opentelemetry"` — @effect/opentelemetry

Bridge between Effect and the official OpenTelemetry Node.js SDK. `NodeSdk.layer(config)` accepts a lazy config factory (or an Effect) returning a `Configuration` object, and installs tracing (`spanProcessor`), metrics (`metricReader`), and logging (`logRecordProcessor`) based on which are present. Always provides `Resource.Resource`, reading from `OTEL_*` environment variables plus any explicit resource metadata.

**Mental model.** `NodeSdk` is not a replacement for OTLP exporters — it plugs Effect signals into the OTel SDK's own export pipeline. Your OTel SDK setup (exporters, batch processors, propagators) works as usual; `NodeSdk.layer` is the glue that routes `Effect.withSpan`, `Metric.counter`, and `Effect.log` into it.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Layer } from "effect"
import { NodeSdk } from "@effect/opentelemetry"

// Wire comp-service tracing into OTel's BatchSpanProcessor → OTLP exporter.
// NodeSdk.layer takes a lazy factory: () => Configuration
const OtelLayer = NodeSdk.layer(() => ({
  resource: {
    serviceName: "comp-service",
    serviceVersion: "1.0.0"
  },
  spanProcessor: new BatchSpanProcessor(
    new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" })
  )
  // Add metricReader / logRecordProcessor to enable metrics / log export too.
}))

Layer.launch(Main.pipe(Layer.provide(OtelLayer))).pipe(
  NodeRuntime.runMain
)
```

> **Warning:** If using `@opentelemetry/auto-instrumentations-node`, register it *before* importing any modules to be patched. Node.js instrumentations hook module loading, so registration must come first in the entry point.

**Reach for it when** your platform team manages an OTel SDK setup, you need OTel-native auto-instrumentation (HTTP, gRPC, DB drivers), or integrating with a service that uses `@opentelemetry/sdk-node`.

## OtelWebSdk

`@effect/opentelemetry — import { WebSdk } from "@effect/opentelemetry"` — @effect/opentelemetry

Browser equivalent of `NodeSdk`. Structurally identical API — pass `spanProcessor`, `metricReader`, `logRecordProcessor` — but uses the OTel *web* tracer provider. Use in browser bundler targets where `NodeSdk` would pull in Node-only internals.

```ts
import { WebSdk } from "@effect/opentelemetry"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"

const OtelLayer = WebSdk.layer(() => ({
  resource: { serviceName: "comp-planning-ui" },
  spanProcessor: new SimpleSpanProcessor(
    new OTLPTraceExporter({ url: "/otlp/v1/traces" })
  )
}))
```

**Reach for it when** running Effect in a browser and bridging into an existing OTel web SDK setup.

## OtelTracer

`@effect/opentelemetry — import { OtelTracer } from "@effect/opentelemetry"` — @effect/opentelemetry

Effect↔OTel tracer bridge. `OtelTracer.layer` installs an Effect `Tracer` that creates `OtelSpan` instances backed by the active OTel `TracerProvider`. Exposes `OtelTracer`, `OtelTracerProvider`, `OtelTraceFlags`, `OtelTraceState` services, and `currentOtelSpan` to retrieve the live OTel span from fiber context.

**Reach for it when** composing Effect's span model with OTel-native span APIs (e.g. setting OTel-specific span status or accessing the raw OTel `Span` for a library that requires it).

## OtelMetrics

`@effect/opentelemetry — import { OtelMetrics } from "@effect/opentelemetry"` — @effect/opentelemetry

Bridges Effect's metric registry into an OTel `MetricReader`. `OtelMetrics.layer(evaluate, options?)` accepts a lazy factory returning a `MetricReader` or non-empty array of readers and registers a `MetricProducer` that converts Effect metric snapshots to OTel metric data on each collection cycle. Supports cumulative and delta temporality via the `temporality` option.

```ts
import { OtelMetrics } from "@effect/opentelemetry"
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus"

// Expose merit-cycle metrics via Prometheus scrape endpoint through OTel SDK.
const MetricsLayer = OtelMetrics.layer(() => new PrometheusExporter({ port: 9464 }))
```

**Reach for it when** you have an existing OTel metric reader (Prometheus, OTLP push) managed by your platform team and want Effect's built-in metrics to flow into it.

## OtelLogger

`@effect/opentelemetry — import { OtelLogger } from "@effect/opentelemetry"` — @effect/opentelemetry

An Effect `Logger` that forwards log records to an OTel `LoggerProvider`. `OtelLogger.layer({ mergeWithExisting })` installs it alongside or instead of the default logger. `OtelLogger.layerLoggerProvider` builds and scopes the OTel `LoggerProvider` from one or more `LogRecordProcessor`s.

**Reach for it when** Effect logs (including structured annotations) need to flow through an existing OTel logging pipeline, e.g. a `BatchLogRecordProcessor` shipping to a vendor.

## OtelResource

`@effect/opentelemetry — import { Resource } from "@effect/opentelemetry"` — @effect/opentelemetry

Provides the OTel `Resource` service used by all `@effect/opentelemetry` modules. `Resource.layer({ serviceName, serviceVersion, attributes })` builds from explicit config; `Resource.layerFromEnv(additionalAttributes?)` merges additional attributes with `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`; `Resource.layerEmpty` provides a minimal no-attribute resource. `NodeSdk.layer` and `WebSdk.layer` manage this automatically — only needed directly when composing individual OTel bridge layers.

```ts
import { OtelTracer, Resource } from "@effect/opentelemetry"
import { Layer } from "effect"

// Manually compose: Resource (from env) → TracerProvider → Effect Tracer.
// Resource.layerFromEnv merges OTEL_SERVICE_NAME/OTEL_RESOURCE_ATTRIBUTES env vars
// with any additional attributes passed as a plain Record<string, unknown>.
const CustomTracingLayer = OtelTracer.layer.pipe(
  Layer.provide(OtelTracer.layerGlobalProvider),
  Layer.provide(Resource.layerFromEnv({
    "service.name": "comp-service",
    "service.version": "1.0.0"
  }))
)
```

**Reach for it when** composing individual `@effect/opentelemetry` bridge layers manually rather than using `NodeSdk` / `WebSdk`.
