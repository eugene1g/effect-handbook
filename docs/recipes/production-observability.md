# Recipe: Production Observability

Instrument business work once with structured logs, metrics, and spans; select a local JSON logger or the OTLP exporter at the Layer boundary.

## Contract

- **Classification:** Runnable example; complete `observability.ts`.
- **Install:** `pnpm add effect@4.0.0-rc.115`
- **Run locally:** Node 26+: `OTEL_EXPORTER_OTLP_ENDPOINT= node observability.ts`
- **Run with an OTLP collector:** `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node observability.ts`
- **Expected local output:** one JSON log event containing `order accepted`, `service=orders`, and `orderId=ord-42`, followed by `{"orderId":"ord-42","status":"accepted"}`. Timestamp and fiber/span identifiers vary.
- **Program type:** after the observability Layer is supplied, `Effect<OrderResult, Config.ConfigError, never>`; configuration-provider or string-decoding failures remain typed startup failures. This example does not validate URL syntax.
- **Required Layers:** local mode installs `Logger.consoleJson` plus `Logger.tracerLogger` and runtime metrics. OTLP mode additionally provides `FetchHttpClient.layer` internally.
- **Lifetime and interruption:** OTLP log/metric/span exporters are scoped. Layer shutdown flushes registered exporters, and each flush is bounded by `shutdownTimeout` (3 seconds here, which is also the default): with an unreachable collector the process still exits about three seconds after the work finishes instead of hanging, and whatever was still buffered is dropped. Process interruption reaches Layer finalizers. The local JSON logger has no acquired resource.
- **Local collector:** the official [Tracing guide](https://effect.website/docs/v4/observability/tracing) shows a single-container Grafana stack that accepts OTLP on port 4318 and how to find the trace in it. The guide tracks Effect's `main` branch rather than the pinned `rc.115` release, so where they differ, this recipe and the tagged source win.

## Complete file

**Runnable example.**

<!-- effect-example id=production-observability check=run runtime=production-observability -->
```ts
import { Config, Effect, Layer, Logger, Metric } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"

interface OrderResult {
  readonly orderId: string
  readonly status: "accepted"
}

const acceptedOrders = Metric.counter("orders_accepted_total", {
  description: "Accepted orders",
  incremental: true
})

const acceptOrder = (orderId: string): Effect.Effect<OrderResult> =>
  Effect.gen(function*() {
    yield* Metric.update(acceptedOrders, 1)
    yield* Effect.logInfo("order accepted")
    return { orderId, status: "accepted" as const }
  }).pipe(
    Effect.withSpan("orders.accept", {
      kind: "server",
      attributes: { "order.id": orderId }
    }),
    Effect.annotateLogs({ service: "orders", orderId })
  )

const Observability = Layer.unwrap(
  Effect.gen(function*() {
    const endpoint = yield* Config.String("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
      Config.withDefault("")
    )

    if (endpoint === "") {
      // Logger.layer replaces the default logger set, so re-add tracerLogger:
      // it is what turns each log call into an event on the active span.
      return Logger.layer([Logger.consoleJson, Logger.tracerLogger])
    }

    return Otlp.layerJson({
      baseUrl: endpoint,
      resource: {
        serviceName: "orders",
        serviceVersion: "1.0.0",
        attributes: { "deployment.environment": "production" }
      },
      loggerExportInterval: "1 second",
      metricsExportInterval: "10 seconds",
      tracerExportInterval: "1 second",
      // Upper bound for the flush on shutdown, per exporter.
      shutdownTimeout: "3 seconds"
    }).pipe(Layer.provide(FetchHttpClient.layer))
  })
)

const RuntimeLayer = Layer.merge(
  Observability,
  Metric.enableRuntimeMetricsLayer
)

const main: Effect.Effect<OrderResult, Config.ConfigError> = acceptOrder("ord-42").pipe(
  Effect.provide(RuntimeLayer)
)

console.log(JSON.stringify(await Effect.runPromise(main)))
```

## Why these primitives?

Logs, spans, and metrics are fiber-aware Effect operations, so annotations and parent spans propagate without parameter plumbing. The exporter remains a Layer: tests can omit it, local runs can use JSON, and production can install OTLP without changing business logic. `Otlp.layerJson` is the compact default for all three signals and owns batching, HTTP export, retry behavior, and shutdown flush.

Define metric values at module scope so updates with the same name/attributes share one registry entry. Avoid sensitive identifiers in annotations unless the telemetry policy explicitly permits them.

Three details in the file are deliberate:

- **The span name is the operation, the order id is an attribute.** `orders.accept` stays one operation in every backend view; `order.id` rides along as a span attribute and a log annotation, where per-event detail belongs. The counter has no order label at all — every distinct attribute value on a metric is a separate time series, so metric attributes must come from a small, fixed vocabulary (see [Cardinality](../operations/observability#cardinality-names-and-attribute-sets-are-bounded)).
- **`Logger.layer([...])` replaces the active logger set**, which by default is `Logger.defaultLogger` plus `Logger.tracerLogger`. Listing only `Logger.consoleJson` would silently stop log calls from becoming span events; the local branch therefore lists `tracerLogger` again. The OTLP branch needs no such care because `Otlp.layerJson` adds its logger with `loggerMergeWithExisting: true` by default, which is also why the default text logger keeps printing there.
- **The exporter has one owner and a deadline.** One `Otlp` Layer is provided at the root, and `shutdownTimeout` bounds how long its scope may hold the process open. Export is best effort: after repeated failures the exporter drops its buffer and pauses for a minute, so treat telemetry as explanation, never as an audit trail or a readiness signal.

## Before production

- Every metric attribute has a bounded vocabulary and a series ceiling; ids, raw paths, and error text live on spans and logs only.
- Every logged or exported field is on an allow-list; secrets travel as `Redacted` and are never unwrapped into telemetry (see [Privacy](../operations/observability#privacy-allow-list-fields-before-they-are-buffered)).
- Each signal has exactly one export path — no SDK bridge and direct OTLP for the same signal (see [One export path per signal](../operations/observability#one-export-path-per-signal)).
- The observability Layer is *provided to* the application Layer, not merged beside it, so eager fibers and finalizers log through it (see [Layer order and shutdown](../operations/observability#layer-order-and-shutdown)).
- Sampling has a named owner, and SLIs come from metrics rather than sampled spans.
- The collector is not part of any readiness check, and the process exits within its termination grace period with the collector down.
- A test asserts on recorded log fields, span structure, and `Metric.value` — see [Verifying telemetry](../operations/observability#verifying-telemetry).

## Common wrong alternative

Do not scatter vendor SDK calls, `console.log`, `Date.now`, or exporter construction through service methods. Do not create an OTLP Layer per request. Provide one observability graph at the application root, use `Effect.withSpan`/`Effect.fn`, structured log annotations, and Metric operations inside the program, and let the owning Scope flush and close exporters.
