# Observability

_Effect ships structured logging, spans, and metrics as first-class runtime citizens. The export layer is separate — use a local collector for development, an OTLP endpoint for production, or skip export in tests._

> **Official examples:** Effect's release-matched [`ai-docs` observability examples](https://github.com/Effect-TS/effect/tree/effect%404.0.2/ai-docs/src/08_observability) cover production logging and OTLP tracing.

## Designing signals

Instrumentation is a design decision before it is an API call: every signal costs storage, exposes data, and needs an owner. Start from the question an operator will ask, pick the signal that answers it, and write its contract down before adding code.

### Which signal answers which question

| Signal | Answers | Does not answer |
| --- | --- | --- |
| Log (`Effect.log*`) | What happened to this one payroll run, request, or employee record? | Numeric trends, alert thresholds, or a tamper-proof audit trail |
| Span (`Effect.withSpan`, `Effect.fn`) | Where did this request spend its time, and which step failed? | Fleet totals, readiness, or proof that a write committed |
| Metric (`Metric.*`) | How many, how fast, how full — across all requests? | The story of one request |

**Start with rate, errors, duration, saturation, and one domain outcome** (for example approved raises per merit cycle), because those cover most alerts; add a signal only when a dashboard or alert names it.

Write one line per signal before shipping it: the question or alert it serves · a stable, bounded name · type, unit, and expected range · the allow-listed attributes and their series ceiling · how it correlates with other signals · privacy class and retention · volume budget · behavior under pressure (drop, truncate, aggregate) · owner. If no one can name the question a signal answers, it only adds spend and leaks data.

### Cardinality: names and attribute sets are bounded

- **A span name identifies an operation type, never an instance**, because backends group and index by name: `hris.fetchCompBand`, not `hris.fetchCompBand E-1042`. Employee ids, cycle ids, and normalized routes go in span `attributes`.
- **Every distinct combination of metric attribute values is a separate time series** that the backend stores, queries, and bills for. Label by bounded vocabularies — outcome, status class, error tag, department, job level — and never by employee, request, session, or message id, raw URL or path, SQL text, error message, or free-form tenant input.
- **High-cardinality detail belongs in logs and span attributes**, which are per-event records rather than aggregated series.
- **`Metric.frequency` needs a finite vocabulary too**, because its state keeps one count per distinct string it has seen.
- **Hashing an identifier does not reduce cardinality**; it only obscures the value.
- Treat label limits, sampling, and an overflow policy (drop, a bounded `other` bucket, or reject) as exporter-edge policy, and count what was dropped on a separate bounded metric so one noisy workflow cannot silently exhaust the series budget.

### Privacy: allow-list fields before they are buffered

- **Default-deny whole objects**: config records, headers, cookies, request and response bodies, SQL and its parameters, connection strings, employee records, prompts and model output. Build each telemetry record from fresh, named fields — never spread an untrusted object and try to redact it afterwards.
- **Classify every field** (public, internal, personal, credential, regulated) and apply drop, redact, truncate, or hash *before* the value reaches a logger queue or an exporter buffer; after that point it already sits in a production data store.
- **Sanitize keys as well as values** when attribute names derive from input, and bound string length, attribute/event/link counts, and nesting depth.
- **`Redacted` protects a value only while it stays wrapped** (see [Keeping secrets masked in log payloads](#keeping-secrets-masked-in-log-payloads)); once code calls `Redacted.value` and logs the result, nothing downstream can mask it.
- Logs and traces are production data: they need access control, retention, and deletion rules like any other store that holds compensation data.

### Telemetry is not readiness, liveness, or an audit log

| Concern | Question | Decided by |
| --- | --- | --- |
| Liveness | Should the host restart this process? | The process supervisor or probe |
| Readiness | Can this instance accept the work it promises? | The dependencies that work needs (database, HRIS) — never the collector |
| Telemetry | What happened over time, and why? | The exporter, best effort |

- **Keep an optional collector out of readiness checks**, because a collector outage would otherwise mark every instance unready at once and turn a telemetry problem into an outage. Decide fail-open or fail-closed per signal at startup; fail-open is the usual answer.
- **Absence of spans or logs is not absence of traffic** — sampling, a disabled exporter, or a dropped batch all produce silence.
- **OTLP export is lossy by design**: a batch is retried a few times and then dropped (see [OtlpExporter](#otlpexporter)). A regulated audit trail needs a durable, transactional store, not a log level.
- **Watch the exporter through a second path** (a scraped gauge, a local log line) so a failing exporter can still report its own drops and last-success age.

The lifetime side of this — startup order, drain, and shutdown deadlines — is covered in [Owning lifetimes: startup, readiness, and shutdown](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown), and the observability review items live in [Review checklists](../reference/review-checklists).

## Logger

`effect/Logger` — stable

A `Logger<Message, Output>` receives a log event (message, level, cause, fiber, timestamp, annotations, log spans) and produces output. The runtime calls every installed logger for every event. Multiple loggers run simultaneously; install with `Logger.layer([...])`.

**Mental model.** `Logger` is the sink of Effect's structured logging pipeline. Sources are `Effect.log`, `Effect.logInfo`, `Effect.logError`, etc. Annotations (`Effect.annotateLogs`) flow through the fiber automatically to every logger on every event. Logger is a service provided via layer — never threaded as an argument.

**Severity is not outcome.** An `Effect.logError` call can sit inside an effect that goes on to succeed, and a failing effect may log nothing, so alerts and tests should key "failed" off the `Exit` or the span status, never off the log level.

### The built-in loggers

- **defaultLogger** — The text logger every program starts with: `[time] LEVEL (#fiber) logSpan=12ms: message` followed by the annotations, written through the `Console` service.
- **tracerLogger** — Records each log call as an event on the active span (message as the event name; annotations, `effect.fiberId`, `effect.logLevel`, and `effect.cause` as attributes). It is the second member of the default logger set, which is why logs show up inside traces without any setup.
- **consolePretty()** — Human-readable TTY output with optional color. Development default. Options: `colors` (`"auto"` or a boolean — pass `false` for CI), `mode` (`"auto"`, `"tty"`, or `"browser"`), and `formatDate`. There is no `stderr` option — route pretty output to `console.error` instead with `Layer.succeed(Logger.LogToStderr, true)`. To pin one renderer regardless of detection use `Logger.consolePrettyTty` or `Logger.consolePrettyBrowser`.
- **consoleJson / formatJson** — One JSON object per line. For log aggregation pipelines (Datadog, Loki, CloudWatch).
- **consoleLogFmt / formatLogFmt** — logfmt (`key=value` pairs). Compact, grep-friendly, popular in Go/Kubernetes ecosystems; level names are uppercase.
- **consoleStructured / formatStructured** — Plain JS object per event. For in-memory inspection and custom transforms.
- **formatSimple** — Compact quoted `key=value` text; level names are uppercase (`INFO`, `WARN`, `ERROR`).
- **batched(logger, { window, flush })** — Collects entries for a time window then calls `flush` with the batch. Returns `Effect<Logger, never, Scope>`.
- **toFile(logger, path, options?)** — Pipes a string logger to a file. Requires `FileSystem` (`NodeFileSystem.layer` on Node.js). Returns `Effect<Logger, PlatformError, Scope | FileSystem>`. Options are `flag` (default `"a+"`, append), `mode`, and `batchWindow` (default 1 second). Output is always batched through `Logger.batched`; the pending batch is written when the logger's scope closes, so a hard crash can lose up to one window of lines. Only opening the file can fail with `PlatformError` — later write errors are ignored.

Official guide: [PlatformLogger](https://effect.website/docs/v4/platform/platformlogger) (there is no `PlatformLogger` module — the API is `Logger.toFile`, and the guide's "written as they arrive" remark does not match it: output is always batched, 1 second by default).

### Installing and swapping loggers

```ts
import { Config, Effect, Layer, Logger, References } from "effect"
import { NodeFileSystem } from "@effect/platform-node"

// Logger.layer REPLACES the active logger set. The default set is
// { Logger.defaultLogger, Logger.tracerLogger }, so list tracerLogger again
// to keep log calls attached to the active span as span events.
export const JsonLoggerLayer = Logger.layer([Logger.consoleJson, Logger.tracerLogger])

// Raise the minimum level — Debug/Info calls become no-ops below "Warn".
export const WarnLevelLayer = Layer.succeed(References.MinimumLogLevel, "Warn")

// File logger added NEXT TO the loggers already installed (mergeWithExisting).
// Logger.toFile is dual — first arg is the string-producing logger, second is the path.
export const FileLoggerLayer = Logger.layer(
  [Logger.toFile(Logger.formatLogFmt, "/var/log/comp-service.log", { batchWindow: "250 millis" })],
  { mergeWithExisting: true }
).pipe(Layer.provide(NodeFileSystem.layer))

// Batched remote logger — flush a whole batch at once.
// Logger.batched is dual: (logger, options) or curried. It requires Scope.
export const RemoteLoggerLayer = Logger.layer(
  [
    Logger.batched(Logger.formatStructured, {
      window: "2 seconds",
      flush: Effect.fn(function*(batch) {
        // send batch to your log aggregator here
        yield* Effect.log(`flushing ${batch.length} entries`)
      })
    })
  ],
  { mergeWithExisting: true }
)

// Pick logger based on NODE_ENV.
export const AppLoggerLayer = Layer.unwrap(
  Effect.gen(function*() {
    const env = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"))
    return env === "production"
      ? JsonLoggerLayer.pipe(Layer.provideMerge(WarnLevelLayer))
      : Logger.layer([Logger.consolePretty(), Logger.tracerLogger])
  })
)
```

`Logger.layer(loggers, { mergeWithExisting })` decides between replacing and extending the set, and the choice has visible consequences:

| Call | Resulting logger set | Consequence |
| --- | --- | --- |
| `Logger.layer([Logger.consoleJson])` | JSON only | The default text output is gone **and log calls stop becoming span events**, because `tracerLogger` was replaced too |
| `Logger.layer([Logger.consoleJson, Logger.tracerLogger])` | JSON + span events | A format swap that keeps log-to-span correlation |
| `Logger.layer([sink], { mergeWithExisting: true })` | Existing set + `sink` | Adds a sink; with a console logger already installed every event now prints twice |
| `Logger.layer([])` | Empty | Silences logging, for example in a test Layer |

> **Warning:** Console, logfmt, and file output do not carry trace or span ids, so once `tracerLogger` is dropped nothing ties a log line to its span. `OtlpLogger` and `OtelLogger` attach the active `traceId`/`spanId` to each exported record, and both merge with the existing set by default (`mergeWithExisting: true`).

- **Bound every logger's queue and I/O.** `Logger.batched` collects without an upper size limit for one window, so choose a window that fits the log rate, and keep the `flush` effect fast and unable to block on a dead aggregator (give it a timeout).
- **A file logger needs an owner for rotation and disk-full behavior**, because `toFile` ignores write errors once the file is open.

### Logging practice

| Level | Use for |
| --- | --- |
| `Debug` / `Trace` | Diagnosis; dropped by the default `Info` minimum |
| `Info` | Low-volume milestones: cycle opened, payroll run committed |
| `Warn` | Degradation that was recovered: retry succeeded, fallback band used |
| `Error` | An operation failed and someone should look; an expected rejection (raise above band) is a domain result, not automatically an error |
| `Fatal` | The process is about to end |

- **Keep the event text stable and put the variables in fields** — `Effect.logInfo("raise approved", { cycleId })`, not an interpolated sentence — so events can be grouped, counted, and asserted on.
- **Attach request or job annotations once at ingress** (`Effect.annotateLogs` around the handler); child effects and forked fibers inherit them.
- **Log a failure once, where recovery or translation is decided**, not at every layer it passes through.

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

Nested annotation scopes combine: an inner `Effect.annotateLogs` extends the enclosing fields (its value wins when a key repeats), and the outer set is restored when the inner effect ends. That is what lets a test assert on fields instead of scraping message text.

`Effect.annotateLogs` wraps one effect. `Effect.annotateLogsScoped` is a statement instead: it annotates every later log call until the surrounding `Scope` closes, which fits Layer construction and handlers that are already scoped. It adds `Scope` to the requirements.

```ts
import { Effect } from "effect"

export const runPayrollExport = (payrollRunId: string) =>
  Effect.scoped(
    Effect.gen(function*() {
      yield* Effect.logInfo("export requested") // no payrollRunId yet
      yield* Effect.annotateLogsScoped({ payrollRunId })
      yield* Effect.logInfo("export started") // carries payrollRunId
      yield* Effect.logInfo("export finished") // carries payrollRunId
    })
  ) // annotation removed when the scope closes
```

### Keeping secrets masked in log payloads

**Log a sensitive value as a `Redacted`, not as a string**, because the built-in loggers render a `Redacted` as `<redacted>` wherever it appears — in a message object or in an annotation — while the rest of the structure stays queryable. This is the first line of defense; it needs no custom logger.

```ts
import { Effect, Redacted } from "effect"

export const rotatePayrollToken = (employeeId: string, token: Redacted.Redacted<string>) =>
  Effect.logInfo("payroll token rotated", { employeeId, token }).pipe(
    Effect.annotateLogs({ service: "comp-service", apiKey: token })
  )
// Logger.consoleJson prints, among its other fields:
//   "message": ["payroll token rotated", { "employeeId": "E-1", "token": "<redacted>" }]
//   "annotations": { "service": "comp-service", "apiKey": "<redacted>" }
```

> **Warning:** The mask lasts only while the value stays wrapped. `Redacted.value(token)` inside a log call, a template string, or a span attribute emits the secret, and no logger can undo that. A custom logger also receives the original `Redacted` object, so it must not unwrap it either.

See [Redacted](../foundations/configuration-secrets#redacted) for construction and [`Config.Redacted`](../foundations/configuration-secrets#config) for loading secrets already wrapped.

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

This example redacts the top-level `employeeId` annotation and matching strings. **Treat a pattern-matching logger as the last line of defense, not the primary control**: a regex only catches the shapes someone thought of, and it runs after the value has already been attached. The primary controls are an allow-list of fields at the call site (see [Privacy](#privacy-allow-list-fields-before-they-are-buffered)) and `Redacted` for anything secret.

**Reach for it when** swapping log format, adding a file sink, shipping logs to a remote aggregator, or adding a redaction backstop on top of Effect's structured log events.

Official guide: [Logging](https://effect.website/docs/v4/observability/logging) (its "Built-in Loggers" subsection headings — `stringLogger`, `jsonLogger`, and so on — are names this module does not export; its code samples use the correct `Logger.format*` / `Logger.console*` names).

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

### Scoping and configuring the minimum level

The default minimum is `"Info"`, so `Effect.logDebug` and `Effect.logTrace` are dropped until something lowers it. Two shapes cover most needs: a process-wide level read from configuration, and a lower level around a single operation.

```ts
import { Config, Effect, Layer, References } from "effect"

// Process-wide: LOG_LEVEL=Debug node main.ts. Config.LogLevel accepts exactly the LogLevel literals.
export const LogLevelLive = Layer.unwrap(
  Effect.gen(function*() {
    const level = yield* Config.LogLevel("LOG_LEVEL").pipe(Config.withDefault("Info"))
    return Layer.succeed(References.MinimumLogLevel, level)
  })
)

declare const recalculateBand: (employeeId: string) => Effect.Effect<void>

// One operation: Debug logging for a single employee while everything else stays at Info.
export const debugOneEmployee = (employeeId: string) =>
  recalculateBand(employeeId).pipe(
    Effect.provideService(References.MinimumLogLevel, "Debug")
  )
```

- **The override is isolated to the wrapped effect and the fibers it forks.** Two concurrent operations with different levels do not affect each other, and the level reverts when the wrapped effect ends — a property a mutable global flag cannot give you, and what makes per-request debug logging practical.
- **Prefer `Effect.provideService` over `Effect.provide(Layer.succeed(...))` for a single effect**; it sets the same reference without building a Layer.
- **Do not model log level, tracing switches, or similar knobs as a custom service.** Services are for capabilities the application provides; a setting with a sensible default is a [Reference](../foundations/services-context-layers#references).

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

Value-formatting utility. `format(input)` applies a value's `Redactable` representation before pretty-printing arbitrary values (handles cycles, `BigInt`, typed arrays, class instances). `formatJson(input)` uses JSON semantics with the same redaction precedence, serializes a `bigint` as a quoted string with its `n` suffix, and omits circular object properties; other unsupported JSON values retain the normal `JSON.stringify` behavior. Also provides `formatDate`, `formatPath`, `formatPropertyKey`. Used internally by built-in loggers to render log messages and annotation values. When formatting an `Error`, `format` appends its `cause` — including a defined falsy one such as `0`, `false`, `""`, or `null` (`Error: band lookup failed (cause: 0)`); only a missing or `undefined` cause is omitted.

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

**The span tree is not the fiber tree.** Forking a fiber does not create a span; only `Effect.withSpan`, `Effect.fn("name")`, `Layer.withSpan`, and instrumented libraries do. A forked child inherits the current parent span, so its spans nest correctly, but spans should mirror the operations an operator cares about (load band → fetch rating → compute raise), not the concurrency structure. Use [FiberSet and friends](../foundations/core-runtime-execution#fiberset) when the question is "which fibers are alive".

**With the `@effect/opentelemetry` tracer, spans without an Effect parent inherit the active OpenTelemetry span.** When an Effect span has no Effect parent but the calling code already has an active OTel span (for example, an auto-instrumented HTTP framework), that OTel span becomes the Effect span's parent, so the tree connects across the OTel/Effect boundary without manual bridging. An Effect parent always takes precedence over the active OTel span. The native `OtlpTracer` does not read the OTel context API; with it, bridge explicitly with `Tracer.externalSpan` / `Effect.withParentSpan`.

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

**Keep identifiers out of span names.** `"merit.calculateIncrease"` stays one operation in every backend view, while the employee and cycle ids above travel as attributes; a name such as `` `merit.calculate ${employeeId}` `` would create one operation per employee (see [Cardinality](#cardinality-names-and-attribute-sets-are-bounded)). Span attributes are still exported data, so the [privacy allow-list](#privacy-allow-list-fields-before-they-are-buffered) applies to them too.

### What ends up on a span

The runtime and the exporters record several things without any code from you, so there is no need to mirror them by hand:

| Recorded automatically | Source |
| --- | --- |
| Each `Effect.log*` call inside the span becomes a span event: event name = message, attributes = log annotations + `effect.fiberId` + `effect.logLevel`, plus `effect.cause` when a `Cause` was logged | `Logger.tracerLogger` — only while it is in the logger set (see [Installing and swapping loggers](#installing-and-swapping-loggers)) |
| The span ends with the wrapped effect's `Exit` (`SpanStatus` = `Ended` with `exit`) on success, failure, **and interruption** | `Effect.withSpan` / `Effect.fn` |
| Success → status OK | `OtlpTracer` and `@effect/opentelemetry` |
| Failure or defect → status ERROR with the first error's message, plus one `exception` event per error (type, message, stack trace) | `OtlpTracer` and `@effect/opentelemetry` |
| Interruption only → status `Unset` with attribute `effect.fiber.interrupted: true` (no error event) | `OtlpTracer` and `@effect/opentelemetry` |

A failing child marks every enclosing span as failed too unless something in between recovers, because each span ends with the `Exit` of the effect it wraps. A span proves that an effect ran and how it exited; it proves neither that a transaction committed nor that cleanup finished.

### Span and correlation rules

- **Span stable operations**: a normalized route, a use case, a transaction, a queue publish or consume, an external call.
- **Parentage expresses causality.** For batch and fan-in work use `links` rather than inventing a parent — `RequestResolver.withSpan` does exactly this for [batched requests](./caching-batching#requestresolver).
- **Fiber context reaches forked fibers, not serialized boundaries.** Queues that carry plain data, workers, child processes, message buses, and third-party callbacks do not inherit the parent span: carry a standard trace header explicitly (`HttpTraceContext.toHeaders` / `fromHeaders`, see [HttpTraceContext](../interfaces/http-server#httptracecontext)) and rebuild the parent with `Tracer.externalSpan`. Inject trace headers only toward destinations you trust.
- **Malformed inbound trace context is dropped, never rejected**: `HttpTraceContext.fromHeaders` returns `Option.none()` for a missing or invalid header, and the built-in HTTP server middleware then creates the server span without a remote parent. Apply the same rule in custom adapters — bad trace headers must not fail otherwise valid traffic.
- **Correlate logs through the active trace**; keep a separate request or job id only when operators need one that survives sampling.
- **Expected business rejections, cancellations, defects, and transport failures need not share one error status** — decide which of them page someone.
- **Close a streaming span however the stream stops** (it drains, fails, or is interrupted) by wrapping the entire stream effect rather than only the success path.

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

Official guide: [Tracing](https://effect.website/docs/v4/observability/tracing) (annotated span dumps and a one-container local Grafana stack; the OpenTelemetry API and SDK packages are optional peers of `@effect/opentelemetry`, so install the ones you import explicitly).

## Metric

`effect/Metric` — stable

Typed, composable metrics registry. Define counters, gauges, histograms, summaries, and frequency maps as values; update them anywhere; read or export state. Metrics are stored in a registry keyed by name + attributes — the same metric referenced from different modules accumulates to the same series.

**Mental model.** Metrics are pull-based: declare them, update as side-effects, then an exporter (Prometheus scrape, OTLP push, DevTools request) reads the registry at its own cadence. No push-on-update hot path by default — the registry is an in-memory map.

The registry is itself a `Context.Reference`, `Metric.MetricRegistry` (a `Map`; its type is exported as `Metric.MetricRegistry`). Every context that does not override it shares one default map, which is what makes metrics feel global. Provide a fresh map — `Effect.provideService(Metric.MetricRegistry, new Map())` — to isolate a test or an embedded program: the same metric value then reads and updates the active registry, and each registry keeps its own state.

### The five metric types

| Type | Input | Use for |
| --- | --- | --- |
| `Metric.counter` | `number \| bigint` | Accumulated deltas: employees processed, errors, retries. Set `{ incremental: true }` to reject negative updates and enforce monotonic growth; without it a counter may go down, and OTLP export preserves the negative delta. |
| `Metric.gauge` | `number \| bigint` | Instantaneous values: budget remaining, active review workflows |
| `Metric.histogram` | `number` | Distributions with pre-defined buckets: merit-calc latency, raise amounts |
| `Metric.timer` | `Duration` | A histogram of durations in milliseconds, tagged `time_unit: milliseconds`, with exponential default boundaries — the natural target of `Effect.trackDuration` |
| `Metric.summary` | `number` | Rolling-window quantiles (p50/p99) without bucket pre-definition. Quantiles are computed per process over `maxAge`/`maxSize` and cannot be merged across instances — prefer a histogram for fleet-wide latency |
| `Metric.frequency` | `string` | String occurrence counts over a **finite** vocabulary: performance ratings, approval outcomes |

**`Metric.update` and `Metric.modify` differ only where it matters most.** For a counter both add the input. For a gauge, `update` *sets* the level and `modify` *adds* a delta — so budget drawdown and in-flight counts use `modify`, while "current queue depth as just measured" uses `update`.

Specify per metric, next to its definition: name, description, unit, where it is updated, expected range, attributes and their series ceiling, bucket boundaries, and the query that reads it.

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
    // ... apply raise logic ...
    yield* Effect.sleep("30 millis")

    yield* Metric.update(employeesProcessed, 1)
    yield* Metric.modify(meritBudgetRemaining, -raiseCents)    // subtract from the current gauge
    yield* Metric.update(raiseAmountMs, Number(raiseCents))
    yield* Metric.update(ratingFrequency, rating)
  },
  // Time the whole call with the runtime's monotonic clock instead of reading the clock twice.
  // trackDuration records on success, failure, and interruption alike.
  Effect.trackDuration(calcLatency, Duration.toMillis)
)
```

### Tracking effects with metrics

`Effect.track*` attaches a metric to an effect as an aspect, so the update cannot be forgotten on one branch and the effect's type does not change.

| Aspect | Feeds the metric with | Fires on |
| --- | --- | --- |
| `Effect.trackSuccesses(metric, f?)` | The success value, or `f(value)` | Success |
| `Effect.trackErrors(metric, f?)` | The typed error, or `f(error)` | Typed failure |
| `Effect.trackDefects(metric, f?)` | The defect, or `f(defect)` | Defect |
| `Effect.trackDuration(metric, f?)` | The elapsed `Duration` (monotonic clock), or `f(duration)` | Every exit, interruption included |
| `Effect.track(metric, f?)` | The whole `Exit`, or `f(exit)` | Every exit |

With a mapper, the mapper's parameter type bounds what it can be attached to: `Effect.track(metric, f)` and `Effect.trackErrors(metric, f)` reject an effect whose error type `f` does not accept, so a mapper written for one error union cannot silently be reused on a wider one.

```ts
import { Effect, Metric, Schema } from "effect"

class BandLookupFailed extends Schema.TaggedError<BandLookupFailed>()("BandLookupFailed", {
  reason: Schema.Literals(["timeout", "not-found"])
}) {}

declare const approveRaise: (employeeId: string) => Effect.Effect<{ readonly amountUsd: number }, BandLookupFailed>

// withConstantInput turns "count one" into a metric that ignores what it is fed.
const approved = Metric.counter("raise_approvals_total", { incremental: true }).pipe(
  Metric.withConstantInput(1)
)
const approvalFailures = Metric.frequency("raise_approval_failures") // keyed by a bounded reason
const approvalLatency = Metric.timer("raise_approval_duration")

export const approveRaiseInstrumented = (employeeId: string) =>
  approveRaise(employeeId).pipe(
    Effect.trackSuccesses(approved),
    Effect.trackErrors(approvalFailures, (error) => error.reason),
    Effect.trackDuration(approvalLatency)
  ) // still Effect<{ amountUsd: number }, BandLookupFailed>
```

### Gauges that follow a lifetime

**A gauge incremented when work starts must be decremented in a finalizer**, because only a finalizer runs on all three exits. Code placed after `yield* work` runs on success only, so a typed failure leaves the gauge high; `Effect.tap` plus `Effect.tapError` covers success and failure but still misses interruption, which is how timeouts, races, and shutdown end work.

```ts
import { Effect, Metric } from "effect"

const activeMeritCalculations = Metric.gauge("merit_calculations_active", {
  description: "Merit calculations currently in flight"
})

export const trackedAsActive = <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Metric.modify(activeMeritCalculations, 1).pipe(
    Effect.andThen(work.pipe(Effect.ensuring(Metric.modify(activeMeritCalculations, -1))))
  )
```

| Restore strategy | Success | Typed failure | Interruption |
| --- | --- | --- | --- |
| Statement after `yield* work` | restored | **leaks** | **leaks** |
| `Effect.tap` + `Effect.tapError` | restored | restored | **leaks** |
| `Effect.ensuring` / `Effect.acquireRelease` | restored | restored | restored |

`Effect.acquireUseRelease(Metric.modify(gauge, 1), () => work, () => Metric.modify(gauge, -1))` is the stricter spelling: the increment runs uninterruptibly, which also closes the narrow window where an interrupt lands after the increment but before the finalizer is installed. The same rule covers any "currently open" number: connections, queue consumers, leases.

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

> **Warning:** `department` and `cycleYear` are safe labels because both have a small, known set of values. `employeeId` here would create one time series per employee — tens of thousands of series that no dashboard reads. Put the employee id on the span or the log line instead (see [Cardinality](#cardinality-names-and-attribute-sets-are-bounded)).

Attributes can also be set for a whole region. `Metric.CurrentMetricAttributes` is a `Context.Reference`; providing it tags every metric updated inside the wrapped effect — the metric counterpart of `Effect.annotateLogs`. `Metric.value(metric)` returns the typed state (`count`, `value`, buckets, quantiles, or `occurrences`), which is how a test asserts on metrics without an exporter.

```ts
import { Effect, Metric } from "effect"

const raisesApplied = Metric.counter("raises_applied_total", { incremental: true })

declare const applyRaises: Effect.Effect<void>

export const applyRaisesForRegion = (region: "amer" | "emea" | "apac") =>
  Effect.gen(function*() {
    yield* applyRaises
    yield* Metric.update(raisesApplied, 1)
    // Read inside the same region: this is the { region } series.
    return (yield* Metric.value(raisesApplied)).count
  }).pipe(Effect.provideService(Metric.CurrentMetricAttributes, { region }))
```

- **A series is identified by name + the full attribute set**, so `Metric.value` read outside the region (or with different attributes) reports a different, usually empty, series.
- **Attribute order does not matter**: `{ a, b }` and `{ b, a }` address the same series.
- **Keep the region vocabulary bounded** for the same reason as call-site attributes — a `tenant` attribute is only safe when the tenant list is small and controlled.

### Runtime metrics

```ts
import { Effect, Metric } from "effect"

// Add built-in fiber lifecycle metrics (fiber count, duration, etc.).
// Provide this layer at the top of your program.
const program = mainEffect.pipe(
  Effect.provide(Metric.enableRuntimeMetricsLayer)
)
```

Runtime metrics describe the fiber runtime (how many fibers started, how long they lived); they are not evidence that the application is healthy or doing useful work. Pair them with the domain and saturation metrics above.

**Reach for it when** tracking throughput, budget drawdown, raise distributions, or any numeric signal. Pair with `OtlpMetrics` or `PrometheusMetrics` to export.

Official guide: [Metrics](https://effect.website/docs/v4/observability/metrics).

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
- Before production, review: package stability (`unstable/*`), flush and shutdown behavior, sampling, redaction, and label limits.

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
- Prometheus has no sampling and no per-request detail — every attribute combination is a stored series, so the [cardinality rules](#cardinality-names-and-attribute-sets-are-bounded) apply in full.

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
