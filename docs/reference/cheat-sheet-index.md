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

> **Note:** **Three habits** the codebase enforces: use `Effect.gen`/`Effect.fn` (never `async/await` or `try/catch` inside them); use `Clock`/`DateTime` (never `Date.now`); and reach for an existing module before hand-rolling — there's almost certainly one for your problem.

## When several primitives look right

The companion [Choosing Effect Primitives](choosing-effect-primitives) page is the contrastive layer: it compares error channels, required services, ownership, backpressure, durability, distribution, and the situations where each plausible choice is wrong.

| Decision | Detailed comparison |
| --- | --- |
| Absence, pure failure, or effectful work | [`Option` vs `Result` vs `Effect`](choosing-effect-primitives#option-vs-result-vs-effect) |
| One cell, effectful update, live changes, or atomic multi-value state | [`Ref` vs `SynchronizedRef` vs `SubscriptionRef` vs transactions](choosing-effect-primitives#ref-vs-synchronizedref-vs-subscriptionref-vs-transactions) |
| One result, a gate, worker handoff, or broadcast | [`Deferred` vs `Latch` vs `Queue` vs `PubSub`](choosing-effect-primitives#deferred-vs-latch-vs-queue-vs-pubsub) |
| Local parallelism, a shared permit budget, or reusable objects | [Per-call concurrency vs `Semaphore` vs `Pool`](choosing-effect-primitives#per-call-concurrency-vs-semaphore-vs-pool) |
| Cached values, cached resources, refresh, or batching | [`Cache` vs `ScopedCache` vs `Resource` vs `RequestResolver`](choosing-effect-primitives#cache-vs-scopedcache-vs-resource-vs-requestresolver) |
| Finite collections or incremental protocols | [`Array`/`Chunk`/`Iterable` vs `Stream`/`Sink`/`Channel`](choosing-effect-primitives#array-chunk-iterable-vs-stream-sink-channel) |
| Outbound HTTP, low-level routing, contract HTTP, or procedures | [`HttpClient` vs `HttpRouter` vs `HttpApi` vs RPC](choosing-effect-primitives#httpclient-vs-httprouter-vs-httpapi-vs-rpc) |
| Failed attempts, successful repetition, polling, or restart survival | [Retry vs repeat vs polling vs Workflow](choosing-effect-primitives#retry-vs-repeat-vs-polling-vs-workflow) |
| Durable state, history, orchestration, or distributed identity | [Persistence vs EventLog vs Workflow vs Cluster](choosing-effect-primitives#persistence-vs-eventlog-vs-workflow-vs-cluster) |

## What to reach for when…

| You want to… | Reach for |
| --- | --- |
| Run async/fallible code with typed errors | [`Effect`](../foundations/core-runtime-execution#effect) (`tryPromise`, `callback`, `gen`, `fn`) |
| Inject a dependency | [`Context.Service` + `Layer`](../foundations/services-context-layers) |
| Ambient, override-able settings | [`Context.Reference` / `References`](../foundations/services-context-layers#references) |
| Cap concurrency | [`Semaphore`, `PartitionedSemaphore`](../concurrency/concurrency-coordination#semaphore), or the `{ concurrency }` option |
| Coordinate fibers | [`Deferred`, `Latch`, `Fiber`, `FiberHandle`/`Map`/`Set`](../foundations/core-runtime-execution#fiber) |
| Mutate several pieces of state atomically | [STM: `TxRef` and friends](../concurrency/software-transactional-memory), run with `Effect.tx` |
| Hold shared state | [`Ref` / `SynchronizedRef`; reactive → `SubscriptionRef`](../concurrency/state-mutable-references) |
| Process a sequence or stream over time | [`Stream` + `Sink` + `Channel`](../concurrency/streaming-channels) |
| Retry, repeat, or poll | [`Schedule` + `Duration` + `Cron`](../concurrency/scheduling-time) |
| Work with time correctly | [`DateTime` + `Clock`](../concurrency/scheduling-time#datetime) (never `Date.now`) |
| Validate / parse / encode data | [`Schema` + `JsonSchema`](../data/schema) |
| Pattern-match exhaustively | [`Match`](../data/functional-toolkit#match) |
| Deeply update immutable data | [`Optic`](../data/functional-toolkit#optic) |
| Memoize expensive lookups | [`Cache` / `ScopedCache`](../operations/caching-batching) |
| Kill N+1 queries (batch) | [`Request` + `RequestResolver`](../operations/caching-batching#request) (or [`SqlResolver`](../interfaces/sql#sqlresolver)) |
| Call an HTTP API / build one | [`HttpClient`](../interfaces/http-client) / [`HttpApi`](../interfaces/http-api) |
| Typed client⇄server calls | [the RPC modules](../interfaces/rpc) |
| Talk to a database | [the SQL modules](../interfaces/sql) (`SqlClient`, `SqlModel`) |
| Keep a value fresh in the background | [`Resource`](../foundations/services-context-layers#resource) |
| Read config / hide secrets | [`Config` + `ConfigProvider` / `Redacted`](../foundations/configuration-secrets) |
| Logs, traces, metrics (+ export) | [`Logger` / `Tracer` / `Metric` + exporters](../operations/observability) |
| Reactive UI state | [`Atom` + framework bindings](../systems/reactivity-atom), or the [deep dive](../deep-dives/reactivity-from-atoms-to-mastery) |
| Call an LLM (provider-agnostic) | [`LanguageModel` + an `@effect/ai-*` provider](../systems/ai-language-models) |
| Run a durable, resumable process | [`Workflow`](../systems/workflows-durable-execution) |
| Distribute stateful entities | [the cluster modules](../systems/cluster-sharding) |
| Event-source / local-first sync | [the event-log modules](../systems/event-log-event-sourcing) |
| Build a command-line app | [the CLI modules](../tooling/cli-framework) |
| Persist across restarts | [`KeyValueStore`, `PersistedQueue`, `PersistedCache`](../tooling/persistence) |
| Test effects deterministically | [`@effect/vitest` + `TestClock`](../tooling/testing-dev-tooling) |
| Branded / nominal types | [`Brand` + `Newtype`](../data/functional-toolkit#brand) |
| Exact decimal math (money) | [`BigDecimal`](../data/functional-toolkit#bigdecimal) |

> **Tip:** Everything imported from `"effect"` is covered by semver. The big subsystems — `http`, `httpapi`, `rpc`, `sql`, `cluster`, `workflow`, `eventlog`, `ai`, `cli`, `reactivity`, `persistence`, `observability`, `devtools`, `socket`, `workers`, `process`, `schema/Model` — live under `"effect/unstable/*"` and may shift in minor releases. They're built to be used; just pin your version and read the changelog.
