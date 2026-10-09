# Telemetry Export

Getting logs, spans, and metrics out of the process. Instrumentation stays in business code ([Observability](observability)); export is a Layer chosen once per process. This page covers choosing and owning an export path, Effect's native OTLP exporters, Prometheus, the Effect DevTools, and the bridge to the OpenTelemetry Node and Web SDKs.

## Choosing and owning an export path

Instrumentation lives in business code; export is a Layer decision made once per process. The decisions below are about ownership — which component exports each signal, in what order it starts, who samples, and how long shutdown may wait.

### One export path per signal

| Path | Choose it when | Know before you ship |
| --- | --- | --- |
| Direct OTLP — [`Otlp`](#otlp) / `OtlpTracer` / `OtlpLogger` / `OtlpMetrics` | You want a small, dependency-free stack that posts straight to a collector | Unstable module. Retry and shutdown flush are best effort, not delivery (see [OtlpExporter](#otlpexporter)) |
| OpenTelemetry SDK bridge — [`NodeSdk` / `WebSdk`](#otelnodesdk) | A platform team owns span processors, vendor exporters, samplers, or auto-instrumentation | Keep OpenTelemetry package versions aligned, and register auto-instrumentation before importing the modules it patches |
| Prometheus pull — [`PrometheusMetrics`](#prometheusmetrics) | Infrastructure already scrapes `/metrics` | Metrics only. Restrict who can reach the endpoint, and do not treat a `200` from it as health |

**Export each signal through exactly one path.** With the SDK bridge and a direct OTLP layer both installed, logs and metrics are reported twice (both loggers sit in the logger set, and both exporters read the same registry), while for traces only one `Tracer` can be current, so one path silently replaces the other. Mixing paths *across* signals (OTLP traces, Prometheus metrics) is fine.

**Install one exporter graph in the application scope** — not per request, not inside a workflow, and not inside a library. A per-request exporter pays connection setup and a shutdown flush on every call, and a library that installs its own competes with the application's.

### Layer order and shutdown

Build the root so that telemetry exists before anything that logs, traces, or forks:

1. Transport and resource prerequisites (`FetchHttpClient.layer`, `OtlpSerialization`, resource attributes).
2. Tracer, logger, and metric export Layers.
3. Application Layers, including any that fork background fibers at construction — a fiber forked before the tracer and logger are installed keeps the context it was forked with.

`App.pipe(Layer.provide(ObservabilityLayer))` (or `provideMerge`) gives exactly this order: the provided Layer is built first and released last, so fibers forked while `App` is constructed — and the logs written by `App`'s finalizers — go through the installed logger and tracer. On shutdown the sequence runs in reverse: stop admitting work, let application finalizers run while exporters still work, flush, finalize exporters, then release the HTTP client they post through.

> **Warning:** `Layer.merge(App, ObservabilityLayer)` builds the two side by side. `App` is then constructed *without* the telemetry references in its context: logs from its eager fibers and finalizers bypass the merged logger, and the exporter may be released before `App` is. Merge is for independent Layers; telemetry is a dependency, so provide it.

- **Every flush needs a deadline**, or a dead collector holds the process open. The OTLP layers bound their scope-close flush with `shutdownTimeout` (default 3 seconds per exporter); a hand-rolled exporter should wrap its release in `Effect.timeoutOption`, and so should a manual `Flusher.flush`.
- **Only a host that awaits shutdown can promise a completed flush.** On `pagehide` in a browser or a serverless freeze, assert only that a best-effort flush *started*.
- Before production, review: package stability (`@stability unstable` modules such as `effect/observability`), flush and shutdown behavior, sampling, redaction, and label limits.

### Sampling has one owner per path

| Path | Who decides whether a span is recorded |
| --- | --- |
| Core tracer | `sampled` is `options.sampled` if given; otherwise `false` under an unsampled parent; otherwise the span's level compared with `Tracer.MinimumTraceLevel` (default `"All"`). There is no probabilistic sampler in core |
| Direct `OtlpTracer` | Exports only spans whose `sampled` flag is already `true`; it makes no sampling decision of its own |
| `@effect/opentelemetry` bridge | The configured OpenTelemetry sampler owns new-root decisions |
| Prometheus | No sampling — metrics are aggregates |

- **A trace-level threshold is a filter, not a sampler**: it drops whole classes of spans, not a percentage.
- **Tail sampling in a collector can only keep traces that reached it**; it cannot recover what a head sampler dropped.
- **Never compute SLIs from sampled spans.** Rates, error ratios, and latency objectives come from unsampled metrics.
- Write down the head decision, parent-based behavior, tail rules, and how errors and slow traces are treated — and monitor the effective sampling rate.

### Verifying telemetry

Work up this ladder; each rung catches what the previous one cannot:

1. **Recording Layers in unit tests.** A capturing `Logger.make`, a `Tracer.make` that records spans, and a fresh `Metric.MetricRegistry` let a test assert fields, annotation inheritance, parent and link structure, span exit status, and that each span ends exactly once.
2. **Privacy and cardinality tests on encoded output.** Feed canary secrets and adversarial attribute keys through the real formatter and assert they are absent or masked, and that the series count stays under its ceiling.
3. **Real exporter or scrape integration.** Decode the OTLP body or parse the Prometheus exposition; asserting that "an HTTP call happened" proves nothing about content.
4. **Propagation across real HTTP and queue boundaries**, including malformed headers and unsampled parents.
5. **Outage behavior**: a `429`, a slow collector, an exporter in its disabled window — the application keeps serving.
6. **Shutdown of the built artifact** with the collector absent and slow: the process exits within its deadline.
7. **Operational proof**: a cost and cardinality budget, an SLO query run against synthetic traffic, and an alert that actually routes.

A topology fixture should acquire telemetry before a Layer that forks an eager fiber and assert that the fiber records through the intended logger and tracer.

The first rung needs nothing but core modules:

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Logger, Metric, References } from "effect"

const approvals = Metric.counter("raise_approvals_total", { incremental: true })

const approveRaise = (cycleId: string) =>
  Effect.gen(function*() {
    yield* Metric.update(approvals, 1)
    yield* Effect.logInfo("raise approved")
  }).pipe(Effect.annotateLogs({ cycleId }))

it.effect("records one approval with its fields", () =>
  Effect.gen(function*() {
    const records: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
    const recording = Logger.make<unknown, void>((options) => {
      records.push({
        message: options.message,
        annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) }
      })
    })

    const count = yield* Effect.gen(function*() {
      yield* approveRaise("2026-merit")
      return (yield* Metric.value(approvals)).count // read inside the same registry
    }).pipe(
      Effect.provide(Logger.layer([recording])),
      // A fresh registry: counts from other tests cannot leak in.
      Effect.provideService(Metric.MetricRegistry, new Map())
    )

    assert.strictEqual(count, 1)
    assert.deepStrictEqual(records, [
      { message: ["raise approved"], annotations: { cycleId: "2026-merit" } }
    ])
  }))
```

## Otlp

`effect/observability/Otlp` — unstable

All-in-one OTLP layer. Wires `OtlpLogger`, `OtlpMetrics`, and `OtlpTracer` from a single config, posting to `/v1/logs`, `/v1/metrics`, and `/v1/traces` under a shared `baseUrl`.

**Mental model.** `Otlp.layerJson({ baseUrl, resource })` activates full observability. Bundles serialization, batching, retry-on-429, and graceful flush at shutdown. Requires `HttpClient`. Per-signal export intervals: `loggerExportInterval`, `metricsExportInterval`, `tracerExportInterval`.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp } from "effect/observability"

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

Options beyond the ones shown:

| Option | Default | Effect |
| --- | --- | --- |
| `shutdownTimeout` | `"3 seconds"` per exporter | Upper bound on the flush that runs when the Layer's scope closes. With a dead collector the process exits after this long instead of hanging; raise it only if the host's termination grace period allows |
| `loggerMergeWithExisting` | `true` | Keeps the loggers already installed (so console output and `tracerLogger` span events survive). Set `false` to make OTLP the only log sink |
| `loggerExcludeLogSpans` | `false` | Omits `Effect.withLogSpan` timings from exported records |
| `maxBatchSize` | `1000` (logs and traces) | Buffer size that triggers an early export |
| `headers` | none | Extra request headers on every export, for example collector authentication |

Default export intervals are 1 second for logs, 5 seconds for traces, and 10 seconds for metrics. `Otlp.layerFromConfig` reads the endpoint, headers, schedule, and timeouts from the standard `OTEL_*` environment variables instead (an `OTEL_EXPORTER_OTLP_TIMEOUT` value becomes the `shutdownTimeout`), and installs no exporter when `OTEL_SDK_DISABLED=true` or no endpoint is set.

**Reach for it when** you want a single layer for logs + metrics + traces with zero boilerplate. Recommended starting point for new projects.

## OtlpLogger

`effect/observability/OtlpLogger` — unstable

An Effect `Logger` that serializes log records as OTLP log records and ships them via HTTP. Includes log level, message, annotations, cause, fiber id, and current trace/span ids. Batches are flushed on scope finalization to prevent log loss on graceful shutdown.

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpLogger, OtlpSerialization } from "effect/observability"

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

`effect/observability/OtlpMetrics` — unstable

Periodically reads the Effect metric registry and posts snapshots to an OTLP metrics endpoint. Supports `"cumulative"` and `"delta"` aggregation temporality.

A `Metric.summary` is exported as one OTLP `Summary` metric named by its id (quantiles, count, and sum together), always cumulative regardless of `temporality`; common unit names such as `milliseconds` are mapped to UCUM units. Dashboards that matched separate `<id>_quantiles`, `<id>_count`, or `<id>_sum` series need updating.

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpMetrics, OtlpSerialization } from "effect/observability"

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

`effect/observability/OtlpTracer` — unstable

Replaces the Effect runtime's `Tracer` with one that batches and exports finished spans over OTLP/HTTP. Spans include trace and span IDs, parent links, attributes, events, timing, kind, and status.

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpSerialization, OtlpTracer } from "effect/observability"

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

`effect/observability/OtlpExporter` — unstable

Shared batch-export engine used internally by `OtlpLogger`, `OtlpMetrics`, and `OtlpTracer`. Buffers items, posts encoded batches at a configurable interval, retries transient errors, honors HTTP 429 `Retry-After`, temporarily disables export after repeated failures (60 s backoff), and flushes on scope close. Typically not used directly.

For an explicit graceful-shutdown checkpoint, provide the shared `OtlpExporter.layerFlusher`, acquire `OtlpExporter.Flusher`, and run `flusher.flush`; it concurrently drains every registered signal exporter and cannot fail. There is no built-in timeout, so wrap it in `Effect.timeoutOption` when shutdown has a deadline. Registration is scoped, and exporters inside their temporary disabled window are skipped.

Delivery semantics, so nobody mistakes export for a guarantee:

- **The scope-close flush is bounded** by the exporter's `shutdownTimeout` (3 seconds unless configured); whatever is still buffered after that is lost.
- **A failed export is dropped, not queued.** Transient HTTP failures are retried a few times; if the export still fails, the buffer is cleared, the exporter disables itself for 60 seconds, and everything pushed during that window is discarded.
- **The exporter announces its own failure only at `Debug` level** ("Disabling exporter for 60 seconds"), which the default `Info` minimum hides — another reason to watch export health through a second path.
- The exporter's own HTTP calls run with tracing disabled and without trace-header propagation, so exporting does not generate more spans to export.

**Reach for it when** implementing a custom OTLP signal type that needs the same batching, retry, and graceful-shutdown behaviour as the built-in exporters.

## OtlpResource

`effect/observability/OtlpResource` — unstable

Builds the OTLP `Resource` object (service name, version, arbitrary attributes) attached to every exported signal. `OtlpResource.make({ serviceName, serviceVersion, attributes })` returns a `Resource`; `fromConfig` reads from a config record. Helpers `entriesToAttributes` and `unknownToAttributeValue` convert JS values to OTLP `KeyValue`/`AnyValue`.

**Reach for it when** building a custom OTLP exporter that needs standard resource metadata, or inspecting how Effect maps JS values to OTLP attribute types.

## OtlpSerialization

`effect/observability/OtlpSerialization` — unstable

A `Context.Service` class with three methods — `traces(data)`, `metrics(data)`, `logs(data)` — that convert in-memory OTLP data structures to `HttpBody` instances. Two implementations: `OtlpSerialization.layerJson` (JSON, default) and `OtlpSerialization.layerProtobuf` (binary protobuf, `application/x-protobuf`).

```ts
import { OtlpSerialization } from "effect/observability"

// JSON — zero extra deps, works everywhere.
export const JsonSerialization = OtlpSerialization.layerJson

// Protobuf — smaller on the wire, required by some collectors.
export const ProtobufSerialization = OtlpSerialization.layerProtobuf
```

**Reach for it when** choosing or swapping serialization format, or writing a custom signal exporter in the same service graph.

## PrometheusMetrics

`effect/observability/PrometheusMetrics` — unstable

Renders the Effect metric registry in Prometheus exposition format (text/plain version 0.0.4). `PrometheusMetrics.format()` returns `Effect<string>`; `PrometheusMetrics.layerHttp()` registers a `GET /metrics` route on the `HttpRouter` service in context.

```ts
import { Effect, Metric } from "effect"
import { PrometheusMetrics } from "effect/observability"
import { HttpRouter } from "effect/http"
import { Layer } from "effect"

// Standalone: format on demand — for a debug dump or a custom scrape route.
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

- **Restrict who can reach `/metrics`**: metric names and attribute values describe the business, so serve the route on an internal listener or behind authentication.
- **A `200` from `/metrics` is not health.** It proves the HTTP server answers, nothing about the database or HRIS; keep it out of readiness checks.
- Prometheus has no sampling and no per-request detail — every attribute combination is a stored series, so the [cardinality rules](observability#cardinality-names-and-attribute-sets-are-bounded) apply in full.

**Reach for it when** running a Prometheus-compatible stack (Prometheus + Grafana, Victoria Metrics, etc.) and want metrics scraped via a pull endpoint.

> **Tip:** **New project?** Use `effect/observability/Otlp*`. No peer dependencies, works in Node, Bun, Deno, and browsers, purpose-built for Effect's data model. A single `Otlp.layerJson({ baseUrl, resource })` covers logs, metrics, and traces.
> **Existing OpenTelemetry SDK in the picture?** Use `@effect/opentelemetry`. It bridges Effect tracing/logging/metrics into the OTel API/SDK so existing `SpanProcessor`, `MetricReader`, and `LogRecordProcessor` pipelines keep working. The bridge is load-order sensitive for auto-instrumentation — read the NodeSdk docs carefully.
> You can also mix them: use `OtlpTracer` for lightweight span export while keeping `@effect/opentelemetry`'s `NodeSdk` for an existing metrics reader.

## DevTools

`effect/devtools/DevTools` — unstable

Application-side entry point for connecting to the Effect DevTools desktop app. `DevTools.layer(url?)` opens a WebSocket to `ws://localhost:34437` (or a custom URL) and mirrors spans and metric snapshots to the DevTools process. Zero configuration required for local development.

**Mental model.** DevTools is a development-only OTLP exporter that streams to a local GUI instead of a collector. Add `DevTools.layer()` alongside your `ObservabilityLayer` in development. Gate on `NODE_ENV` or remove in production.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Config, Layer } from "effect"
import { DevTools } from "effect/devtools"

const DevToolsLayer = Layer.unwrap(
  Config.String("NODE_ENV").pipe(
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

`effect/devtools/DevToolsClient` — unstable

Low-level socket protocol layer underneath `DevTools`. Drives the NDJSON duplex channel, queues `Ping` heartbeats, sends span starts/events/completions, responds to `MetricsRequest` messages by snapshotting the metric registry, and exposes `DevToolsClient.layerTracer` which installs a tracer that wraps the existing tracer and forwards events to the socket.

**Reach for it when** building a custom DevTools integration or embedding the DevTools protocol into a different transport (e.g. TCP socket, Unix pipe).

## DevToolsServer

`effect/devtools/DevToolsServer` — unstable

Server-side half of the DevTools protocol. `DevToolsServer.run` accepts a `Client` (a socket connection from a connected Effect application) and drives the conversation: receives span and metric data, sends metric snapshot requests and pong responses. Used by the Effect DevTools desktop app itself; not typically used in application code.

## DevToolsSchema

`effect/devtools/DevToolsSchema` — unstable

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

- **Install the OpenTelemetry packages you import.** `@effect/opentelemetry` declares the OpenTelemetry API and SDK packages as optional peers, so a package manager will not add `@opentelemetry/sdk-trace-base`, an exporter, or the others for you.
- **For a first look without a collector**, swap the exporter for `new ConsoleSpanExporter()` from `@opentelemetry/sdk-trace-base`; finished spans print to stdout. Any OpenTelemetry `SpanProcessor`, including a vendor's, fits the same `spanProcessor` slot.
- **Do not also install `OtlpTracer` for traces** once the bridge owns them (see [One export path per signal](#one-export-path-per-signal)); with the bridge, sampling belongs to the OpenTelemetry sampler.

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
