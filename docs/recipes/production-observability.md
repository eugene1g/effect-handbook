# Recipe: Production Observability

Instrument business work once with structured logs, metrics, and spans; select a local JSON logger or the OTLP exporter at the Layer boundary.

## Contract

- **Classification:** Runnable example; complete `observability.ts`.
- **Install:** `pnpm add effect@4.0.0-rc.108`
- **Run locally:** Node 26+: `OTEL_EXPORTER_OTLP_ENDPOINT= node observability.ts`
- **Run with an OTLP collector:** `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node observability.ts`
- **Expected local output:** one JSON log event containing `order accepted`, `service=orders`, and `orderId=ord-42`, followed by `{"orderId":"ord-42","status":"accepted"}`. Timestamp and fiber/span identifiers vary.
- **Program type:** after the observability Layer is supplied, `Effect<OrderResult, Config.ConfigError, never>`; configuration-provider or string-decoding failures remain typed startup failures. This example does not validate URL syntax.
- **Required Layers:** local mode installs `Logger.consoleJson` and runtime metrics. OTLP mode additionally provides `FetchHttpClient.layer` internally.
- **Lifetime and interruption:** OTLP log/metric/span exporters are scoped. Layer shutdown flushes registered exporters; process interruption reaches Layer finalizers. The local JSON logger has no acquired resource.

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
    const endpoint = yield* Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
      Config.withDefault("")
    )

    if (endpoint === "") {
      return Logger.layer([Logger.consoleJson])
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
      tracerExportInterval: "1 second"
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

## Common wrong alternative

Do not scatter vendor SDK calls, `console.log`, `Date.now`, or exporter construction through service methods. Do not create an OTLP Layer per request. Provide one observability graph at the application root, use `Effect.withSpan`/`Effect.fn`, structured log annotations, and Metric operations inside the program, and let the owning Scope flush and close exporters.
