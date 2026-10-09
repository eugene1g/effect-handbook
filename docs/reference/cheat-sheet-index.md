# Cheat Sheet & Index

This page is the short retrieval layer for the handbook: one representative service, then a task-to-module map. Use search or the sidebar for the complete module treatment.

## The house style, distilled

```ts
import { Context, Effect, Layer, Schema } from "effect"

// 1. Errors are tagged schema classes.
class BandViolation extends Schema.TaggedError<BandViolation>()("BandViolation", {
  reason: Schema.String
}) {}

// 2. Services are classes; the implementation is a static Layer.
class CompService extends Context.Service<CompService, {
  readonly applyRaise: (employeeId: string, pct: number) => Effect.Effect<number, BandViolation>
}>()("comp/CompService") {
  static layer = Layer.effect(CompService, Effect.gen(function*() {
    return CompService.of({
      applyRaise: Effect.fn("CompService.applyRaise")(function*(employeeId, pct) {
        if (pct > 0.2) return yield* new BandViolation({ reason: "raise exceeds band max" })
        return pct
      })
    })
  }))
}

// 3. Compose with gen; handle errors by tag; run at the edge.
const program = Effect.gen(function*() {
  const comp = yield* CompService
  return yield* comp.applyRaise("emp_42", 0.08)
}).pipe(
  Effect.catchTag("BandViolation", (e) => Effect.logError(e.reason).pipe(Effect.as(0))),
  Effect.provide(CompService.layer)
)
```

> **Note:** **Four habits** the codebase enforces: use `Effect.gen`/`Effect.fn` (never `async/await` or `try/catch` inside them); use `Clock`/`DateTime` (never `Date.now`); write callbacks as lambdas — `Effect.forEach(ids, (id) => loadBand(id))`, not `Effect.forEach(ids, loadBand)`, because `forEach` also passes the index and point-free passing can erase overloads and generics; and reach for an existing module before hand-rolling — there's almost certainly one for your problem.

## Start here

| You are… | Go to |
| --- | --- |
| Installing Effect 4, configuring TypeScript, or writing a first program | [Getting Started](../foundations/getting-started) |
| Choosing between primitives that all look plausible | [Choosing Effect Primitives](choosing-effect-primitives) |
| Looking at a symptom, or checking generated code against known mistakes | [Troubleshooting & Anti-Patterns](../troubleshooting/troubleshooting-and-anti-patterns) |
| Reviewing a design or a diff | [Review Checklists](review-checklists) |
| Coming from Effect 3 | [Migration guide](https://github.com/Effect-TS/effect/blob/effect%404.0.2/MIGRATION.md) |
| Moving an existing Promise codebase over, one leaf at a time | [Adopting Effect in an Existing TypeScript Codebase](../deep-dives/adopting-effect-in-an-existing-codebase) |
| Wanting a connected walkthrough rather than a lookup | [Deep Dives](../deep-dives/) |

## When several primitives look right

The companion [Choosing Effect Primitives](choosing-effect-primitives) page is the contrastive layer: it compares error channels, required services, ownership, backpressure, durability, distribution, and the situations where each plausible choice is wrong.

| Decision | Detailed comparison |
| --- | --- |
| Where a fact may be collapsed: absence, failure, `unknown`, requirements, execution, lifetime | [Boundary rules before primitives](choosing-effect-primitives#boundary-rules-before-primitives) |
| Which constructor wraps this JavaScript | [Constructor by source convention](choosing-effect-primitives#constructor-by-source-convention) |
| Which runner the host needs | [Runner by host contract](choosing-effect-primitives#runner-by-host-contract) |
| Absence, pure failure, a recorded outcome, or effectful work | [`Option` vs `Result` vs `Effect`](choosing-effect-primitives#option-vs-result-vs-effect) |
| Which recovery operator expresses the intent | [Recovery operator by intent](choosing-effect-primitives#recovery-operator-by-intent) |
| Stop at the first failure or collect them all | [Fail fast or accumulate](choosing-effect-primitives#fail-fast-or-accumulate) |
| `provideService`, a Layer, `{ local: true }`, or `Layer.fresh` | [Providing dependencies by seam](choosing-effect-primitives#providing-dependencies-by-seam) |
| Which fork, by who owns the fiber | [Fork by owner](choosing-effect-primitives#fork-by-owner) |
| Which bracket, by how long the resource lives | [Resource lifetime and bracket](choosing-effect-primitives#resource-lifetime-and-bracket) |
| One cell, effectful update, live changes, or atomic multi-value state | [`Ref` vs `SynchronizedRef` vs `SubscriptionRef` vs transactions](choosing-effect-primitives#ref-vs-synchronizedref-vs-subscriptionref-vs-transactions) |
| One result, a gate, worker handoff, or broadcast | [`Deferred` vs `Latch` vs `Queue` vs `PubSub`](choosing-effect-primitives#deferred-vs-latch-vs-queue-vs-pubsub) |
| Wait, shed, keep the latest, or grow without bound | [Overload semantics at a glance](choosing-effect-primitives#overload-semantics-at-a-glance) |
| Local parallelism, a shared permit budget, or reusable objects | [Per-call concurrency vs `Semaphore` vs `Pool`](choosing-effect-primitives#per-call-concurrency-vs-semaphore-vs-pool) |
| One effect repeated, one key repeated, or many keys at once | [Single-flight, cache, or batching](choosing-effect-primitives#single-flight-cache-or-batching) |
| Cached values, cached resources, refresh, or batching | [`Cache` vs `ScopedCache` vs `Resource` vs `RequestResolver`](choosing-effect-primitives#cache-vs-scopedcache-vs-resource-vs-requestresolver) |
| Finite collections or incremental protocols | [`Array`/`Chunk`/`Iterable` vs `Stream`/`Sink`/`Channel`](choosing-effect-primitives#array-chunk-iterable-vs-stream-sink-channel) |
| Buffer depth, batch size, or rate | [Stream buffering and batching operators](choosing-effect-primitives#stream-buffering-and-batching-operators) |
| JSON, NDJSON, SSE, or schema-derived binary frames | [Wire codec: JSON, NDJSON, or SchemaBinary](choosing-effect-primitives#wire-codec-json-ndjson-or-schemabinary) |
| Outbound HTTP, low-level routing, contract HTTP, or procedures | [`HttpClient` vs `HttpRouter` vs `HttpApi` vs RPC](choosing-effect-primitives#httpclient-vs-httprouter-vs-httpapi-vs-rpc) |
| Failed attempts, successful repetition, polling, or restart survival | [Retry vs repeat vs polling vs Workflow](choosing-effect-primitives#retry-vs-repeat-vs-polling-vs-workflow) |
| Durable state, history, orchestration, or distributed identity | [Persistence vs EventLog vs Workflow vs Cluster](choosing-effect-primitives#persistence-vs-eventlog-vs-workflow-vs-cluster) |
| Which test tool proves which claim | [Test tool by claim](choosing-effect-primitives#test-tool-by-claim) |
| Who owns the runtime and what cancels work | [Host and runtime ownership](choosing-effect-primitives#host-and-runtime-ownership) |

## What to reach for when…

### Build and run

| You want to… | Reach for |
| --- | --- |
| Run async/fallible code with typed errors | [`Effect`](../foundations/core-runtime-execution#effect) (`tryPromise`, `callback`, `gen`, `fn`) |
| Wrap a Promise or callback API so that a timeout really cancels it | [Cancellable adapters](../foundations/core-runtime-execution#8-cancellable-adapters-for-promises-and-callbacks): forward the `signal` |
| Branch or loop (there is no `Effect.if`, `unless`, or `loop`) | [plain `if` / `for` in `Effect.gen`, `Effect.when`](../foundations/core-runtime-execution#9-branching-and-looping) |
| Run an effect from a host, keeping cancellation distinct | [`runPromiseExit` with `{ signal }`](../foundations/core-runtime-execution#11-running-effects-at-an-owned-edge) |
| Call Effect from Express, Hono, a UI, or a plugin API | [`ManagedRuntime`](../foundations/fibers-scopes-runtimes#managedruntime), the [ManagedRuntime recipe](../recipes/managed-runtime-integration), and its [production-shaped bridge](../recipes/managed-runtime-integration#a-production-shaped-bridge) |
| Carry a host request's abort through to the SDK call | [Recipe: Request Cancellation Through a Host](../recipes/request-cancellation-through-a-host) |
| Start a process and shut it down gracefully | [platform `runMain`](../foundations/fibers-scopes-runtimes#runtime), the [graceful entrypoint recipe](../recipes/graceful-entrypoint-and-shutdown), and [readiness plus a bounded drain](../recipes/graceful-entrypoint-and-shutdown#adding-readiness-and-a-bounded-drain) |
| Choose the host: process, Web handler, framework callback, browser, worker, test | [Choosing a host](../interfaces/platform-runtime-hosts#choosing-a-host) |
| Fall back across providers or models | [`ExecutionPlan`](../foundations/core-runtime-execution#executionplan) |

### Fail and recover

| You want to… | Reach for |
| --- | --- |
| Decide whether an outcome is a result, a typed failure, or a defect | [Designing the error model](../foundations/errors-option-result#designing-the-error-model) |
| Recover from some failures and leave the rest typed | [`catchTag`, `catchIf`, `catchFilter`, `catchReason`](../foundations/errors-option-result#selective-recovery-beyond-one-tag) |
| Translate an error, or fail an unacceptable success | [`mapError`, `filterOrFail`](../foundations/errors-option-result#transforming-the-error-channel) |
| Turn every outcome into one response | [`Effect.match` / `matchEffect`](../foundations/errors-option-result#folding-both-channels-at-a-boundary) |
| Collect every validation problem | [`Effect.validate`, `Effect.partition`, `mode: "result"`](../foundations/errors-option-result#accumulating-errors-instead-of-failing-fast) |
| Map an error union to statuses or policies exhaustively | [`Match.exhaustive` / `tagsExhaustive`](../foundations/errors-option-result#classifying-an-error-union) |
| Keep a defect that sits beside a typed failure | [a guarded `catchCause`](../foundations/fibers-scopes-runtimes#recovering-from-a-mixed-cause) |
| Move between `Option`, `Result`, and `Effect` (they are not yieldable) | [`Effect.fromOption`, `Effect.fromResult`](../foundations/errors-option-result#moving-between-option-result-and-effect) |
| Decide what a failed cleanup means | [When cleanup can fail](../foundations/core-runtime-execution#10-when-cleanup-can-fail) |
| Undo partial in-process work | [exit-aware finalizers](../deep-dives/failure-retry-fallback-and-interruption#roll-back-partial-work-with-exit-aware-finalizers) |
| Combine retry with a timeout | [Where the timeout sits relative to retry](../deep-dives/failure-retry-fallback-and-interruption#where-the-timeout-sits-relative-to-retry) |
| Report defects at the process edge | [`ErrorReporter`](../foundations/errors-option-result#errorreporter) |

### Depend and configure

| You want to… | Reach for |
| --- | --- |
| Inject a dependency | [`Context.Service` + `Layer`](../foundations/services-context-layers) and the [service recipe](../recipes/service-and-layers) |
| Shape a service contract (`R = never`, no throws, domain verbs) | [Designing a service contract](../foundations/services-context-layers#designing-a-service-contract) |
| Provide one fake in a test without building a Layer | [`Effect.provideService`](../foundations/services-context-layers#providing-one-value-or-building-a-graph) |
| Know whether a pool is shared or rebuilt | [What is shared, and what is rebuilt](../foundations/services-context-layers#what-is-shared-and-what-is-rebuilt) |
| Own a connection or client for the application's lifetime | [Resourceful services](../foundations/services-context-layers#resourceful-services) |
| Use a capability only if the host installed it | [`Effect.serviceOption`](../foundations/services-context-layers#optional-services) |
| Ambient, override-able settings | [`Context.Reference` / `References`](../foundations/services-context-layers#references) and the [default services](../foundations/services-context-layers#default-services) |
| Keep a value fresh in the background | [`Resource`](../foundations/services-context-layers#resource) |
| One Layer per tenant or key | [`LayerMap`](../foundations/services-context-layers#layermap) |
| Read config / hide secrets | [`Config` + `ConfigProvider` / `Redacted`](../foundations/configuration-secrets) (PascalCase constructors: `Config.String`, `Config.Int`, `Config.Redacted`, `Config.Duration`, `Config.URL`) |
| Define what a valid deployment looks like, once | [Designing the startup contract](../foundations/configuration-secrets#designing-the-startup-contract) |
| Default a setting without hiding a typo | [`Config.withDefault`, not `Config.orElse`](../foundations/configuration-secrets#absence-is-not-malformed-input) |
| Layer CLI overrides over environment over defaults | [Precedence and composition](../foundations/configuration-secrets#precedence-and-composition) |
| Decode a secret from a payload without ever encoding it back | [`Schema.RedactedFromValue` with `disallowEncode`](../foundations/configuration-secrets#secrets-that-arrive-through-a-schema) |

### Own lifetimes and fibers

| You want to… | Reach for |
| --- | --- |
| Fork work with the right owner | [Choosing a fork by its owner](../foundations/fibers-scopes-runtimes#choosing-a-fork-by-its-owner) |
| Make sure a forked listener is registered before you publish | [`{ startImmediately: true }`](../foundations/fibers-scopes-runtimes#when-a-forked-fiber-starts) |
| Coordinate fibers | [`Deferred`, `Latch`, `Fiber`, `FiberHandle`/`Map`/`Set`](../foundations/fibers-scopes-runtimes#fiber) |
| List every long-lived thing with its owner, bound, and release | [the ownership ledger](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#write-the-ownership-ledger-first) |
| Start up all-or-nothing; separate liveness, readiness, and draining | [Owning Lifetimes — Startup, Readiness, and Shutdown](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown) |
| Run a heartbeat only while the main task runs | [`Effect.raceFirst`](../concurrency/scheduling-time#running-a-side-task-for-as-long-as-the-main-task-runs) |
| Run a worker with bounded admission and a drain | [the bounded-worker recipe](../recipes/resource-safe-bounded-worker) and [deep dive](../deep-dives/structured-concurrency-through-a-bounded-worker) |

### Coordinate, share state, and stream

| You want to… | Reach for |
| --- | --- |
| Cap concurrency | [`Semaphore`, `PartitionedSemaphore`](../concurrency/concurrency-coordination#semaphore), or the `{ concurrency }` option |
| Hand work to workers with backpressure | [`Queue`](../concurrency/concurrency-coordination#queue), with [roles in signatures](../concurrency/concurrency-coordination#put-queue-roles-in-function-signatures) and an explicit [lifecycle](../concurrency/concurrency-coordination#queue-lifecycle-who-ends-it-and-what-a-failure-does) |
| Fan events out to every subscriber | [`PubSub`](../concurrency/concurrency-coordination#pubsub) and its [delivery semantics](../concurrency/concurrency-coordination#delivery-semantics-queue-or-pubsub) |
| Shed load deliberately and count it | [Make loss observable](../concurrency/concurrency-coordination#make-loss-observable) |
| Share expensive connections | [`Pool`](../concurrency/concurrency-coordination#pool) |
| Hold shared state | [`Ref` / `SynchronizedRef`; reactive → `SubscriptionRef`](../concurrency/state-mutable-references), always as [one transition per call](../concurrency/state-mutable-references#one-transition-one-call) |
| Mutate several pieces of state atomically | [STM: `TxRef` and friends](../concurrency/software-transactional-memory), run with `Effect.tx` |
| Process a sequence or stream over time | [`Stream` + `Sink` + `Channel`](../concurrency/streaming-channels) |
| Merge, zip, partition, or broadcast streams | [Combining and splitting streams](../concurrency/streaming-channels#4-combining-and-splitting-streams) |
| Recover, retry, or time out a stream | [Handling stream failures](../concurrency/streaming-channels#5-handling-stream-failures) |
| Keep a file or cursor open exactly as long as a stream is consumed | [`Stream.unwrap` over a scoped acquisition](../concurrency/streaming-channels#6-owning-resources-inside-a-stream) |
| Find every place a pipeline buffers | [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides) |
| Batch by size or time | [`Stream.grouped` / `groupedWithin`](../concurrency/streaming-channels#2-transforming-streams), [`Stream.transduce`](../concurrency/streaming-channels#adapting-leftovers-and-repeatable-batching) |
| Frame bytes on a socket or file | [`Ndjson`](../concurrency/streaming-channels#ndjson), [`Sse`](../concurrency/streaming-channels#sse), [`SchemaBinary`](../concurrency/streaming-channels#schemabinary) |
| Import a large file without buffering it | [Streaming Ingestion Without Accidental Buffering](../deep-dives/streaming-ingestion-without-accidental-buffering) |

### Time and scheduling

| You want to… | Reach for |
| --- | --- |
| Retry, repeat, or poll | [`Schedule` + `Duration` + `Cron`](../concurrency/scheduling-time), the [retry policy checklist](../concurrency/scheduling-time#retry-policy-checklist), and the [`{ schedule, while, until, times }` options](../concurrency/scheduling-time#shorthand-options-for-retry-and-repeat) |
| See the delays a composed schedule will produce | [`Schedule.toStep`](../concurrency/scheduling-time#inspecting-a-schedule) |
| Prove a retry policy's shape | [Testing a policy](../concurrency/scheduling-time#testing-a-policy) and the [TestClock recipe](../recipes/retry-with-test-clock) |
| Work with time correctly | [`DateTime` + `Clock`](../concurrency/scheduling-time#datetime) (never `Date.now`) |
| Parse a duration from config or a payload | [`Config.Duration`, `Schema.DurationFromString`](../concurrency/scheduling-time#parsing-untrusted-durations-and-interop-edges) |
| Build a zoned time from wall-clock input; format for people | [Constructing zoned values](../concurrency/scheduling-time#constructing-zoned-values-from-wall-clock-input), [Formatting](../concurrency/scheduling-time#formatting) |
| Build a cron expression from fields | [`Cron.make`](../concurrency/scheduling-time#building-a-cron-from-structured-fields) |

### Data and boundaries

| You want to… | Reach for |
| --- | --- |
| Validate / parse / encode data | [`Schema` + `JsonSchema`](../data/schema) and the [Schema deep dive](../deep-dives/schema-from-external-input-to-domain-and-back) |
| Pick the decode runner | [by who consumes the failure](../data/schema#1-decoding-and-encoding-pick-your-result-style) |
| Reject or strip unknown keys, collect all issues | [Parse options are boundary policy](../data/schema-in-depth#5-parse-options-are-boundary-policy) |
| Model an optional, nullable, or `Option` field | [Optional fields, null, and Option](../data/schema-in-depth#6-optional-fields-null-and-option) |
| Put `Option`, `Result`, `Exit`, `Duration`, maps, sets, or `Redacted` on the wire | [Effect data types at the boundary](../data/schema-in-depth#7-effect-data-types-at-the-boundary) |
| Write human-readable validation messages | [Custom error messages](../data/schema-in-depth#8-custom-error-messages) |
| Validate against a service (uniqueness, lookup) | [Effectful schemas and services](../data/schema-in-depth#9-effectful-schemas-and-services) |
| Hand a schema to a form library or router | [`Schema.toStandardSchemaV1`](../data/schema-tooling#standardschema) |
| Generate JSON Schema (open objects by default) | [`JsonSchema`](../data/schema-tooling#jsonschema) |
| Pattern-match exhaustively | [`Match`](../data/functional-toolkit#match) and [how to close a matcher](../data/functional-toolkit#closing-a-matcher) |
| Compare or hash values structurally | [`Equal`](../data/functional-toolkit#equal) and its [pitfalls](../data/functional-toolkit#equality-pitfalls-and-opt-outs) |
| Deeply update immutable data | [`Optic`](../data/functional-toolkit#optic) |
| Branded / nominal types | [`Brand` + `Newtype`](../data/functional-toolkit#brand) |
| Exact decimal math (money) | [`BigDecimal`](../data/functional-toolkit#bigdecimal) |
| Exact byte counts and size limits | [`ByteSize`](../data/functional-toolkit#bytesize) (replaces `FileSystem.MiB` and friends) |
| Model and analyze a graph (org chart, approval chain) | [`Graph`](../data/data-structures#graph) and its [witnesses, reductions, and matchings](../data/data-structures#witnesses-reductions-and-matchings) |

### Interfaces

| You want to… | Reach for |
| --- | --- |
| Call an HTTP API | [`HttpClient`](../interfaces/http-client), with [budgets and safe retries](../interfaces/http-client#retries-time-budgets-and-cancellation) and [three failure classes](../interfaces/http-client#three-failure-classes) |
| Fetch a URL a user supplied | [User-controlled destinations](../interfaces/http-client#user-controlled-destinations) |
| Build a contract-first HTTP API | [`HttpApi`](../interfaces/http-api), its [status mapping](../interfaces/http-api#status-mapping-is-part-of-the-contract), and [authentication vs authorization](../interfaces/http-api#authentication-is-not-authorization) |
| Serve HTTP and set edge limits | [`HttpServer`](../interfaces/http-server#httpserver) and the [edge policy checklist](../interfaces/http-server#edge-policy-checklist) |
| Work with status codes and media types | [`HttpStatus`](../interfaces/http-server#httpstatus), [`Mime`](../interfaces/http-server#mime) |
| Typed client⇄server calls | [the RPC modules](../interfaces/rpc), [contract evolution](../interfaces/rpc#evolving-a-contract), and [operational defaults](../interfaces/rpc#operational-defaults) |
| Talk to a database | [the SQL modules](../interfaces/sql) (`SqlClient`, `SqlModel`) and [where SQL belongs](../interfaces/sql#where-sql-belongs-in-an-application) |
| Write state and an external effect atomically | [the outbox](../interfaces/sql#external-effects-after-commit-outbox) and [Recipe: A Transactional Write with an Outbox](../recipes/transactional-write-with-outbox) |
| Give a repository one stable error | [Normalizing errors at a repository boundary](../interfaces/sql#normalizing-errors-at-a-repository-boundary) |
| Run migrations and operate pools in production | [Operating migrations](../interfaces/sql#operating-migrations), [Operating SQL in production](../interfaces/sql#operating-sql-in-production) |
| Upgrade `@effect/sql-pg` | [Upgrading to the native client](../interfaces/sql#native-client-behavior-codecs-json-and-listen) |
| Go end to end from Schema to HttpApi to SQL | [the boundary recipe](../recipes/schema-httpapi-sql-boundary) |
| Files, sockets, workers, child processes | [Platform & Runtime Hosts](../interfaces/platform-runtime-hosts); sockets are pull-based (`reader` / `writer`) |
| Parse and match IP addresses and networks | [`NetAddress`](../interfaces/platform-runtime-hosts#netaddress), [`IpNetwork`](../interfaces/platform-runtime-hosts#ipnetwork), [`IpInterface`](../interfaces/platform-runtime-hosts#ipinterface) |
| Test file code without a disk | [`FileSystem.layerNoop`](../interfaces/platform-runtime-hosts#testing-without-a-disk) |

### Operate

| You want to… | Reach for |
| --- | --- |
| Logs, traces, metrics (+ export) | [`Logger` / `Tracer` / `Metric` + exporters](../operations/observability) and the [production observability recipe](../recipes/production-observability) |
| Decide which signal to add, and bound its cardinality | [Designing signals](../operations/observability#designing-signals) |
| Swap the log format without losing log-to-span correlation | [Installing and swapping loggers](../operations/observability#installing-and-swapping-loggers) |
| Set the minimum log level from config, or for one operation | [Scoping and configuring the minimum level](../operations/observability#scoping-and-configuring-the-minimum-level) |
| Count, time, and gauge an effect without touching its body | [`Effect.track*`](../operations/observability#tracking-effects-with-metrics), [lifetime gauges](../operations/observability#gauges-that-follow-a-lifetime) |
| Choose OTLP, the OpenTelemetry SDK, or Prometheus | [Choosing and owning an export path](../operations/telemetry-export#choosing-and-owning-an-export-path) |
| Memoize one expensive effect | [`Effect.cached` / `cachedWithTTL`](../operations/caching-batching#caching-a-single-effect) |
| Memoize expensive lookups by key | [`Cache` / `ScopedCache`](../operations/caching-batching), with a [failure TTL](../operations/caching-batching#failure-and-freshness-policy) |
| Kill N+1 queries (batch) | [`Request` + `RequestResolver`](../operations/caching-batching#request) (or [`SqlResolver`](../interfaces/sql#sqlresolver)), honoring the [resolver obligations](../operations/caching-batching#resolver-obligations) |

### Durable and distributed systems

| You want to… | Reach for |
| --- | --- |
| Persist across restarts | [`KeyValueStore`, `PersistedQueue`, `PersistedCache`](../tooling/persistence), after reading [what each guarantees](../tooling/persistence#what-each-primitive-guarantees) |
| Process durable jobs at least once | [`PersistedQueue`](../tooling/persistence#persistedqueue) (retry policy lives on `make`) and its [failure windows](../tooling/persistence#failure-windows-and-honest-guarantees) |
| Run a durable, resumable process | [`Workflow`](../systems/workflows-durable-execution), with [replay and versioning rules](../systems/workflows-durable-execution#replay-versioning-and-rollout) |
| Distribute stateful entities | [the cluster modules](../systems/cluster-sharding), their [transport options](../systems/cluster-sharding#transport-options) and [capacity limits](../systems/cluster-sharding#capacity-limits-and-their-defaults) |
| Event-source / local-first sync | [the event-log modules](../systems/event-log-event-sourcing) |
| Decide how much durability the problem needs | [The Durability and Distribution Ladder](../deep-dives/durability-and-distribution-ladder) |
| Reactive UI state | [`Atom` + framework bindings](../systems/reactivity-atom), or the [deep dive](../deep-dives/reactivity-from-atoms-to-mastery) |
| Call an LLM (provider-agnostic) | [`LanguageModel` + an `@effect/ai-*` provider](../systems/ai-language-models), under the [production rules](../systems/ai-language-models#production-rules-for-model-calls) |
| Gate tool calls behind approval, or bound their concurrency | [Tool-call resolution](../systems/ai-language-models#tool-call-resolution-concurrency-and-manual-dispatch) |
| Expose tools over MCP | [`McpServer`](../systems/mcp#mcpserver) |
| Ship an AI feature with budgets, gates, and tests | [Building a Production AI Capability](../deep-dives/building-a-production-ai-capability) |

### Test and tool

| You want to… | Reach for |
| --- | --- |
| Test effects deterministically | [`@effect/vitest` + `TestClock`](../tooling/testing-dev-tooling) and [Testing an Effect Application](../deep-dives/testing-an-effect-application) |
| Property-test from a Schema | [`Arbitrary`](../tooling/testing-dev-tooling#arbitrary) (`effect/Arbitrary`; the fast-check bridge was removed) |
| Know what an in-memory harness does *not* prove | [In-memory test runtimes shipped with Effect](../tooling/testing-dev-tooling#in-memory-test-runtimes-shipped-with-effect) |
| Test laziness and the exact `E` and `R` | [Prove laziness and the static contract](../tooling/testing-dev-tooling#prove-laziness-and-the-static-contract) |
| Capture `Effect.log*` records or spans in a test | [a test Logger](../deep-dives/testing-an-effect-application#capture-effect-log-records-with-a-test-logger), [structural span tests](../deep-dives/testing-an-effect-application#test-spans-structurally) |
| Audit a green suite for false greens | [When green means nothing](../deep-dives/testing-an-effect-application#when-green-means-nothing) |
| Catch floating Effects and removed APIs in the editor and CI | [`@effect/tsgo`](../tooling/testing-dev-tooling#effect-language-service-effect-tsgo) and [diagnostics setup](../foundations/getting-started#effect-diagnostics-in-the-editor-and-in-ci) |
| Build a command-line app | [the CLI modules](../tooling/cli-framework) (PascalCase constructors; boolean flags need `Flag.withDefault(false)`), and [testing a command](../tooling/cli-framework#testing-a-command) |

## Recipes and deep dives by task

| Task | Recipe (one complete file) | Deep dive (connected walkthrough) |
| --- | --- | --- |
| Define a service with live and test Layers | [Service and Layers](../recipes/service-and-layers) | [Anatomy of a Real Effect Application](../deep-dives/anatomy-of-a-real-effect-application) |
| Decode a request, serve it, store it | [Schema to HttpApi to SQL](../recipes/schema-httpapi-sql-boundary) | [Schema — From External Input to Domain and Back](../deep-dives/schema-from-external-input-to-domain-and-back) |
| Bounded, resource-safe background work | [Resource-Safe Bounded Worker](../recipes/resource-safe-bounded-worker) | [Structured Concurrency Through a Bounded Worker](../deep-dives/structured-concurrency-through-a-bounded-worker) |
| Classified retry, proven with virtual time | [Typed Retry with TestClock](../recipes/retry-with-test-clock) | [Failure, Retry, Fallback, and Interruption](../deep-dives/failure-retry-fallback-and-interruption) |
| Logs, traces, and metrics wired for production | [Production Observability](../recipes/production-observability) | — |
| A process that starts, serves, and stops cleanly | [Graceful Node Entrypoint](../recipes/graceful-entrypoint-and-shutdown) | [Owning Lifetimes — Startup, Readiness, and Shutdown](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown) |
| Effect inside a framework you do not control | [ManagedRuntime at an Imperative Boundary](../recipes/managed-runtime-integration), [Request Cancellation Through a Host](../recipes/request-cancellation-through-a-host) | [Adopting Effect in an Existing TypeScript Codebase](../deep-dives/adopting-effect-in-an-existing-codebase) |
| A database write plus an external effect | [Transactional Write with an Outbox](../recipes/transactional-write-with-outbox) | [The Durability and Distribution Ladder](../deep-dives/durability-and-distribution-ladder) |
| Large imports and live feeds | — | [Streaming Ingestion Without Accidental Buffering](../deep-dives/streaming-ingestion-without-accidental-buffering) |
| A test strategy for a whole service | — | [Testing an Effect Application](../deep-dives/testing-an-effect-application) |
| Reactive UI state | — | [Reactivity — From Atoms to Mastery](../deep-dives/reactivity-from-atoms-to-mastery) |
| An LLM feature with tools and budgets | — | [Building a Production AI Capability](../deep-dives/building-a-production-ai-capability) |
| An MCP server other agents can call, with auth and approvals | [`McpServer`](../systems/mcp#mcpserver) | [Exposing an Effect Application over MCP](../deep-dives/exposing-an-effect-application-over-mcp) |

> **Tip:** Most of what you import from `"effect"` is `@stability stable` and covered by semver. The exceptions carry an explicit `@stability unstable` tag and an unstable badge here: root-barrel modules such as `Arbitrary`, `FileSystem`, `Path`, `ExecutionPlan`, `LayerMap`, `Graph`, and `ByteSize` (the full list is in [Stability and support](../#stability-and-support)), plus a set of advanced `Schema` APIs. The big subsystems — `http`, `http-api`, `rpc`, `sql`, `cluster`, `workflow`, `eventlog`, `ai`, `cli`, `reactivity`, `persistence`, `observability`, `devtools`, `socket`, `workers`, `process`, `net`, `schema/Model` — live under `"effect/<area>"`, carry `@stability unstable`, and may shift in minor releases. They're built to be used; just pin your version, read the changelog, and keep each unstable import [behind one app-owned capability](../interfaces/platform-runtime-hosts#keep-platform-and-unstable-imports-behind-a-capability).
