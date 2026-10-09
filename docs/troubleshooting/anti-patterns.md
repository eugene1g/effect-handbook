# Generated-Code Anti-Patterns

This is the list to check generated or pasted code against. Each row names the shape to search for, why it is wrong on `4.0.2`, the preferred shape, and the section that owns the explanation. For a reviewer's yes/no version of the same material, use the [Review Checklists](../reference/review-checklists).

## Effect 3 names that do not exist in Effect 4

Generated code most often breaks on a name carried over from Effect 3. Each of these fails to compile against `effect@4.0.2`; use the Effect 4 spelling instead.

| Effect 3 name | Effect 4 |
| --- | --- |
| `Effect.catchAll` | `Effect.catch` |
| `Effect.catchAllCause` | `Effect.catchCause` |
| `Effect.catchSome` | `Effect.catchIf` or `Effect.catchTag` |
| `Effect.either` | `Effect.result` (returns a `Result`) |
| `Effect.tapErrorCause` | `Effect.tapCause` |
| `Effect.zipLeft` / `Effect.zipRight` | `Effect.tap` / `Effect.andThen` |
| `Context.Tag`, `Effect.Service` | `Context.Service` — see [Services, Context & Layers](../foundations/services-context-layers) |
| `Layer.scoped` | `Layer.effect` (it already handles a `Scope` requirement) |
| `@effect/platform`, `@effect/rpc`, `@effect/sql`, `@effect/cli` | modules inside `effect`: `FileSystem` and `Path` from `"effect"`, HTTP from `"effect/http"`, and so on; host Layers from `@effect/platform-node` — see [Getting Started](../foundations/getting-started#install-effect-4) |
| `NodeRuntime` from `"effect"` | `NodeRuntime` from `@effect/platform-node` |

## Anti-patterns: construction and running

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| `Effect.succeed(sideEffect())`, `Effect.fail(buildError())` | The argument is evaluated while the program is built; every run and retry replays one captured value. | `Effect.sync(() => ...)`, `Effect.failSync`, or `Effect.suspend`. | [Creating effects](../foundations/core-runtime-execution#1-creating-effects) |
| `Effect.sync(() => JSON.parse(text))` or any throwing code in `Effect.sync` | `sync` asserts "cannot throw"; the throw becomes a defect, invisible to `catchTag` and retry. | `Effect.try({ try, catch })` with a real error mapper. | [Creating effects](../foundations/core-runtime-execution#1-creating-effects) |
| `Effect.promise(() => fetch(url))` | A rejection becomes a defect, and no `signal` is forwarded. | `Effect.tryPromise({ try: (signal) => fetch(url, { signal }), catch })`. | [Creating effects](../foundations/core-runtime-execution#1-creating-effects) |
| `Effect.tryPromise({ try: () => sdk.call(x), ... })` | No `signal` parameter is declared, so no `AbortController` exists; timeouts and races abandon the I/O instead of cancelling it. | Declare and forward `signal` in every adapter. | [Cancellable adapters](../foundations/core-runtime-execution#8-cancellable-adapters-for-promises-and-callbacks) |
| `catch: (cause) => new SdkError({ cause })` for every rejection | A `TypeError` inside the adapter becomes an "expected outage" and gets retried. | Recognize the failures the contract allows; `Effect.die` the rest. | [Cancellable adapters](../foundations/core-runtime-execution#8-cancellable-adapters-for-promises-and-callbacks) |
| `async`/`await` throughout Effect services | Native Promise work escapes typed errors, services, cancellation, and test services. | Compose Effects; wrap a real Promise boundary once with `Effect.tryPromise`. | [Sequencing with gen & fn](../foundations/core-runtime-execution#2-sequencing-with-gen-fn) |
| `Effect.runPromise` inside a service method or handler | Creates a root fiber with an empty context: interruption, provided services, and the typed failure are lost. | Return `Effect<A, E, R>`; run at an owned edge. | [Running effects at an owned edge](../foundations/core-runtime-execution#11-running-effects-at-an-owned-edge) |
| `Effect.runSync(parse(x))` while building a description | Construction is no longer inert, and `runSync` throws at the first asynchronous boundary. | Compose the effect; run once at the edge. | [Running effects at an owned edge](../foundations/core-runtime-execution#11-running-effects-at-an-owned-edge) |
| `Effect.map(() => someEffect)`; an Effect built in a callback and discarded | Produces a nested or dropped Effect that never runs. | `Effect.flatMap`, `Effect.andThen`, or `yield*`. | [“My Effect never ran”](troubleshooting-and-anti-patterns#my-effect-never-ran) |
| Point-free callbacks: `Effect.forEach(ids, loadBand)`, `Effect.map(f)` with an overloaded `f`, `flow(...)` | `forEach` calls `f(element, index)`, so an optional second parameter silently receives the index; overloads and generics can be erased. | Write the lambda: `(id) => loadBand(id)`. | Official guide: [Guidelines](https://effect.website/docs/v4/code-style/guidelines) |
| `Effect.if`, `Effect.unless`, `Effect.whenEffect`, `Effect.loop`, `Effect.iterate`, `Effect.zipLeft`, `Effect.zipRight` | Not exported in `4.0.2`. | Plain `if` / `for` in `Effect.gen`; `Effect.when(conditionEffect)`; `Effect.andThen` / `Effect.tap`. | [Branching and looping](../foundations/core-runtime-execution#9-branching-and-looping) |
| `Date.now()`, `new Date()`, `Math.random()` in domain work | Bypasses Clock/Random services and deterministic tests; direct workflow use also breaks replay determinism. | Effect Clock/DateTime/Random APIs; TestClock and seeded services. Put nondeterminism in a Workflow Activity. | [Clock](../foundations/fibers-scopes-runtimes#clock), [Random](../concurrency/scheduling-time#random) |
| `process.exit()` in application code | Skips finalizers and the drain. | Let the platform `runMain` translate the `Exit` into an exit code. | [Signals, exit codes, and the time budget](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#signals-exit-codes-and-the-time-budget) |

## Anti-patterns: errors and recovery

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| `Effect.catch(() => fallback)` everywhere | Erases domain distinctions and often hides operational failures. | Recover by tag/reason at the layer that owns the policy; preserve unexpected failures. | [Selective recovery beyond one tag](../foundations/errors-option-result#selective-recovery-beyond-one-tag) |
| Retrying every failure forever | Retries permanent failures and amplifies outages. | Typed retryable errors, `Schedule.while`, jitter, and hard time/attempt bounds. | [Retry policy checklist](../concurrency/scheduling-time#retry-policy-checklist) |
| Retrying or defaulting a defect | Hides a bug behind a plausible value. | Let it fail; report it at a process or request boundary. | [The three failure buckets](../foundations/errors-option-result#the-three-failure-buckets) |
| `Effect.orDie` to tidy an error union; `Effect.die` on an expected failure | Callers lose a condition they could act on, and a defect recorded beside it is replaced. | Keep it typed; translate with `Effect.mapError`; declare it on the endpoint. | [Recovering from a mixed Cause](../foundations/fibers-scopes-runtimes#recovering-from-a-mixed-cause) |
| `Effect.catchCause(() => Effect.void)`, `Effect.ignoreCause` in domain code | Swallows defects and interruption; can block shutdown. | A guarded `catchCause` that re-fails, or `catchDefect` that re-dies the unknown. | [Typed failure versus defect and interruption](troubleshooting-and-anti-patterns#typed-failure-versus-defect-and-interruption) |
| Translating interruption into a domain error, retrying it, or logging it as a fault | Interruption is cancellation, not failure. | Let it propagate; finalizers do the work. | [The three failure buckets](../foundations/errors-option-result#the-three-failure-buckets) |
| `Option.getOrThrow`, or re-throwing `result.failure`, in domain code | Reintroduces the hidden branch the type removed. | `Effect.fromOption` / `Effect.fromResult`, or collapse at a real boundary. | [Fallbacks and boundary exits](../foundations/errors-option-result#fallbacks-and-boundary-exits) |
| `switch` with `default`, or `Match.orElse`, in an error-policy match | Tomorrow's variant is silently assigned to today's fallback. | `Match.exhaustive` / `Match.tagsExhaustive`. | [Classifying an error union](../foundations/errors-option-result#classifying-an-error-union) |
| Folding (`Effect.match`) or catching everything in a low-level function | Steals policy from every caller. | Fold once, at the terminal boundary that owns the response. | [Folding both channels at a boundary](../foundations/errors-option-result#folding-both-channels-at-a-boundary) |
| Mapping a timeout, pool exhaustion, or driver error to `NotFound` / `404` | Clients act on a lie. | Only a query that succeeded and returned nothing is "not found". | [Designing the error model](../foundations/errors-option-result#designing-the-error-model) |
| A `throw` inside a service method or a test fake | It becomes a defect; tests then exercise a different channel than production. | `Effect.fail(new DomainError(...))`. | [Designing a service contract](../foundations/services-context-layers#designing-a-service-contract) |
| A correct negative answer modeled as an error | Retry schedules and alerts treat a right answer as a fault. | Return it in `A`. | [Designing the error model](../foundations/errors-option-result#designing-the-error-model) |

## Anti-patterns: services, Layers, and configuration

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| Providing a live Layer or service inside business logic | `R` looks clean while production I/O is hard-wired; tests reach the network and each call is its own build. | Provide live implementations at application edges, fakes at test edges. | [Providing one value or building a graph](../foundations/services-context-layers#providing-one-value-or-building-a-graph) |
| Per-request `Effect.provide(DbLive)`; a `ManagedRuntime`, pool, or exporter per request | Sibling provides each build the Layer: a pool per request. | One enclosing build at the edge, or one `ManagedRuntime` per host. | [What is shared, and what is rebuilt](../foundations/services-context-layers#what-is-shared-and-what-is-rebuilt) |
| Rebuilding Layers inline at multiple branches | Different Layer identities may acquire duplicate pools/resources. | Name and reuse one Layer value inside the composition graph. | [What is shared, and what is rebuilt](../foundations/services-context-layers#what-is-shared-and-what-is-rebuilt) |
| `Layer.fresh` or `{ local: true }` "to fix the types" | Duplicates pools, caches, and subscriptions. | Read the remaining requirements and wire exactly that. | [Reading and composing the graph](../foundations/services-context-layers#reading-and-composing-the-graph) |
| `Layer.succeed` for something that needs teardown | It packages a finished value and cannot register a finalizer. | `Layer.effect` with `Effect.acquireRelease`. | [Resourceful services](../foundations/services-context-layers#resourceful-services) |
| A service method typed `Effect<A, E, SomeDependency>` | Every caller and test must provide what only the implementation needs. | Capture dependencies in the Layer constructor; public methods have `R = never`. | [Designing a service contract](../foundations/services-context-layers#designing-a-service-contract) |
| A service per helper, or one god service | Boundaries that exist only for mocking, or none at all. | One service per capability with a substitution reason. | [Designing a service contract](../foundations/services-context-layers#designing-a-service-contract) |
| Module-level `createServer()`, `Ref`, or counter | Shared by every build of the Layer: two tests or tenants share state. | Allocate during Layer acquisition. | [Own the listener](../interfaces/http-server#own-the-listener-acquire-late-bind-port-0-prove-release) |
| Casting `R` away, or `as any` on a Layer | The missing service fails at run time instead. | Find the tag, provide its Layer at the right level. | [A service is still present in R](troubleshooting-and-anti-patterns#a-service-is-still-present-in-r) |
| `process.env` reads in services | A second, untyped definition of "valid deployment". | One `Config` program, decoded during a Layer build. | [Designing the startup contract](../foundations/configuration-secrets#designing-the-startup-contract) |
| `Config.orElse(() => Config.succeed(d))` as a default; a logical-or fallback | Masks a malformed value; treats `0` and `false` as absent. | `Config.withDefault(d)`. | [Absence is not malformed input](../foundations/configuration-secrets#absence-is-not-malformed-input) |
| Choosing live or fake infrastructure from whether a token is set | A missing secret silently selects the fake in production. | An explicit mode: `Config.Literals(["live", "sandbox"], "MODE")`. | [Deciding required, optional, and defaulted](../foundations/configuration-secrets#deciding-required-optional-and-defaulted) |
| `Layer.mergeAll(Service.layer, ConfigLive)` | The provider override does not reach its sibling. | `Service.layer.pipe(Layer.provide(ConfigLive))`, or provide it outermost. | [Precedence and composition](../foundations/configuration-secrets#precedence-and-composition) |
| Node platform imports (`@effect/platform-node`, `node:*`) in domain code or in a browser or edge bundle | The module now knows which host it runs in, and the bundle breaks elsewhere. | Depend on the capability; import the platform package in one module at the edge. | [Keep platform and unstable imports behind a capability](../interfaces/platform-runtime-hosts#keep-platform-and-unstable-imports-behind-a-capability) |
| `Redacted.value` early, then passing the string around | Nothing downstream can mask it again. | Keep it `Redacted` until the single call that needs the bytes. | [Redacted](../foundations/configuration-secrets#redacted) |

## Anti-patterns: resources, fibers, and state

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| Manual acquire/use without a finalizer | Failure or interruption leaks the handle. | `Effect.acquireRelease`, `acquireUseRelease`, a scoped Layer, Pool, ScopedCache, or another owner-aware primitive. | [Interruption & resource safety](../foundations/core-runtime-execution#6-interruption-resource-safety) |
| Cleanup attached with `Effect.tap` / `andThen`, or written after `yield*` | Runs on success only; misses failure and interruption. | `Effect.ensuring`, `Effect.onExit`, `Effect.acquireRelease`. | [Success-only cleanup](troubleshooting-and-anti-patterns#success-only-cleanup) |
| One `acquireRelease` that opens two handles | A failure on the second leaks the first. | One bracket per resource. | [One bracket per resource](../deep-dives/anatomy-of-a-real-effect-application#one-bracket-per-resource) |
| An unbounded or fallible finalizer | Finalizers run uninterruptibly: an unbounded finalizer is an unbounded shutdown. | Bound it, then apply a stated failure policy. | [When cleanup can fail](../foundations/core-runtime-execution#10-when-cleanup-can-fail) |
| `Effect.forkDetach` without a named owner and stop path | Nothing closes, bounds, or observes the fiber. | `forkChild`, `forkScoped`, `forkIn`, or a `FiberSet` owned by a Layer. | [Choosing a fork by its owner](../foundations/fibers-scopes-runtimes#choosing-a-fork-by-its-owner) |
| An interior `Effect.runFork` or `forkDetach` "so the write survives the request" | Shutdown cannot interrupt it, and it keeps using a pool after release. | Transfer the work to a Layer-owned, bounded supervisor. | [Bridge into a host that is not Effect](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#bridge-into-a-host-that-is-not-effect) |
| `Ref.get` then `Ref.set` | Two transitions; a suspension between them loses updates. | One `Ref.update` / `Ref.modify`; `SynchronizedRef` when the transition is effectful. | [One transition, one call](../concurrency/state-mutable-references#one-transition-one-call) |
| Mutating the object stored in a `Ref` | Bypasses the atomic transition and changes values other fibers already read. | Install a new immutable value in one `update`. | [One transition, one call](../concurrency/state-mutable-references#one-transition-one-call) |
| Reading a `MutableRef`, suspending, then writing from the stale value | Another fiber can update it during the suspension; replacing it with separate `Ref.get` / `Ref.set` calls has the same race. | One synchronous `MutableRef.update`, one `Ref.update`, or `SynchronizedRef` for an effectful transition. | [MutableRef](../concurrency/state-mutable-references#mutableref) |
| Non-idempotent I/O inside `Effect.tx` | A transaction body can rerun on conflict. | Keep external effects outside the transaction. | [The mental model](../concurrency/software-transactional-memory#the-mental-model) |
| Reusing a completed `Deferred` for the next generation | The next generation is "ready" instantly. | A fresh `Deferred` per generation; complete it on every outcome. | [Deferred](../foundations/fibers-scopes-runtimes#deferred) |
| `Queue.shutdown` as end-of-input | Discards the buffer and interrupts parked fibers. | `Queue.end`, then join the workers. | [Queue lifecycle](../concurrency/concurrency-coordination#queue-lifecycle-who-ends-it-and-what-a-failure-does) |
| Readiness published before acquisition, or left true while draining | Traffic is routed to a process that cannot serve. | Readiness is a Layer acquired last and released first. | [Liveness, readiness, and draining](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#liveness-readiness-and-draining-are-different-questions) |

## Anti-patterns: concurrency, streams, and caching

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| `{ concurrency: "unbounded" }` over uncontrolled input | Can exhaust sockets, memory, API quotas, or database connections. | Use a numeric bound, shared Semaphore, bounded Queue/Stream stage, or Pool. | [Capacity is part of the contract](../deep-dives/structured-concurrency-through-a-bounded-worker#capacity-is-part-of-the-contract) |
| `Queue.unbounded` chosen because a test hung | Hides the deadlock and removes backpressure. | Find the missing consumer or end signal; test with capacity `1`. | [Queue lifecycle](../concurrency/concurrency-coordination#queue-lifecycle-who-ends-it-and-what-a-failure-does) |
| `dropping` / `sliding` as a performance switch; an unchecked `offerUnsafe` result | Silent data loss. | Treat it as a stated loss policy and count what was shed. | [Make loss observable](../concurrency/concurrency-coordination#make-loss-observable) |
| `Stream.callback` without `bufferSize` | The buffer is unbounded by default. | `{ bufferSize, strategy }`, and say which loss policy it is. | [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides) |
| `Stream.runCollect` on unknown or infinite input | Materializes the full stream and may never return or exhaust memory. | Incremental `runForEach`, a bounded Sink, batching, or streaming output. | [Running streams](../concurrency/streaming-channels#3-running-streams) |
| `runCollect` then `slice` for a preview; `take` after `buffer` | Reads far more than the prefix. | `Stream.take(n)` upstream of buffers and concurrent stages. | [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides) |
| Opening a handle before the stream and closing it "when done" | Leaks on early stop or decode failure. | `Stream.unwrap` over a scoped acquisition. | [Owning resources inside a stream](../concurrency/streaming-channels#6-owning-resources-inside-a-stream) |
| `Stream.buffer({ capacity: n })` to get batches of `n` | Capacity is flow-control depth, not batch size. | `Stream.grouped(n)`, `groupedWithin(n, d)`, or `rechunk(n)`. | [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides) |
| `Stream.timeout` as a failure detector | It ends the stream with no error. | `Stream.timeoutOrElse` with `Stream.fail(...)`. | [Handling stream failures](../concurrency/streaming-channels#5-handling-stream-failures) |
| Pairing resolver rows to entries by position, or skipping entries without a row | Callers receive each other's data, or die with "did not complete request". | Index rows by id; iterate the entries and settle each. | [Resolver obligations](../operations/caching-batching#resolver-obligations) |
| A hand-written promise map or lock for single-flight | `Cache.get` already shares one lookup among concurrent misses. | `Cache`, or `Effect.cached` for a keyless effect. | [Which problem do you have?](../operations/caching-batching#which-problem-do-you-have) |
| `Cache.make` with a long TTL over a fallible lookup | One transient failure is replayed for the full TTL. | `Cache.makeWith` with a short failure TTL. | [Failure and freshness policy](../operations/caching-batching#failure-and-freshness-policy) |
| Whole records or un-normalized strings as cache keys | Equal real-world things produce different keys. | Normalize at ingress; a small key class. | [Keys are logical values](../operations/caching-batching#keys-are-logical-values) |

## Anti-patterns: Schema and boundaries

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| `Schema.Number` for every external number | Accepts `NaN` and infinities and says nothing about integer/range constraints. | `Schema.Finite`, `Schema.Int`, `Schema.Natural`, BigDecimal/BigInt codecs, and explicit checks. | [Refinements](../data/schema#5-refinements-check-and-refine) |
| `JSON.parse(raw) as Model`, `raw as EmployeeId` | A cast validates nothing. | Decode once at ingress; obtain brands through the decoder. | [Branded schemas](../data/schema#7-branded-schemas) |
| `Effect.sync(() => Schema.decodeUnknownSync(S)(x))` | Bad input becomes a defect. | `Schema.decodeUnknownEffect(S)(x)`. | [Decoding and encoding — pick your result style](../data/schema#1-decoding-and-encoding-pick-your-result-style) |
| Decode, then `Effect.orElseSucceed(() => default)` | Malformed input is hidden behind a plausible value. | A declared decoding default for *absence*; fail on malformed input. | [Construction and deliberate fallbacks](../data/schema-in-depth#4-construction-and-deliberate-fallbacks) |
| `withConstructorDefault` expected to fill a missing key while decoding | It applies to `make` / `new` only. | `withDecodingDefault` / `withDecodingDefaultKey`. | [Default values](../data/schema#8-default-values) |
| Never choosing `onExcessProperty` | Undeclared keys are stripped silently. | Decide per boundary and test the policy. | [Parse options are boundary policy](../data/schema-in-depth#5-parse-options-are-boundary-policy) |
| Decoding the same value again at internal function boundaries | Cost with no new information, and a second place for drift. | Decode once at ingress; pass the `Type`. | [Schema Type and Encoded mismatch](troubleshooting-and-anti-patterns#schema-type-and-encoded-mismatch) |
| `Schema.RedactedFromValue` without `disallowEncode` on a model that is also encoded | Every derived codec writes the secret back in clear text. | Set the option, or keep secrets out of encodable models. | [Secrets that arrive through a schema](../foundations/configuration-secrets#secrets-that-arrive-through-a-schema) |
| The endpoint's `success` schema is the table row | A persistence detail becomes a published contract. | Separate DTOs; map in the use case or repository. | [Handlers are lazy adapters](../interfaces/http-api#handlers-are-lazy-adapters) |

## Anti-patterns: HTTP, RPC, and SQL

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| A handler that runs an Effect, builds a client, or yields `SqlClient` | Breaks request ownership and absorbs policy no other entry point shares. | Return one use-case Effect. | [Handlers are lazy adapters](../interfaces/http-api#handlers-are-lazy-adapters) |
| Decoding the success schema before checking the status | A `404` body is reported as a schema failure. | `filterStatusOk` or `matchStatus` first. | [Three failure classes](../interfaces/http-client#three-failure-classes) |
| `retryTransient` on a client that sends mutations | It replays a `POST` as readily as a `GET`. | Two derived clients; idempotency keys the server honors. | [Retries, time budgets, and cancellation](../interfaces/http-client#retries-time-budgets-and-cancellation) |
| Fetching a user-supplied URL directly | Server-side request forgery. | Allow-list scheme and port, reject non-public addresses, re-validate every redirect. | [User-controlled destinations](../interfaces/http-client#user-controlled-destinations) |
| Treating a valid token, a reachable route, or a client middleware as authorization | None of them checks actor, action, tenant, and resource. | Authenticate in middleware (`401`); authorize in the use case (`403`). | [Authentication is not authorization](../interfaces/http-api#authentication-is-not-authorization) |
| A catch-all that serializes `error.message` into a response | Leaks internals; defects are already sanitized to a content-free `500`. | Declared errors with safe fields only. | [Status mapping is part of the contract](../interfaces/http-api#status-mapping-is-part-of-the-contract) |
| Mapping every RPC failure to one "RPC failed" error | Discards whether a retry is safe and whose bug it is. | Keep the six categories distinguishable. | [Keep six failure categories distinguishable](../interfaces/rpc#keep-six-failure-categories-distinguishable) |
| `Effect.ignore` / `Effect.catch` around a step inside `withTransaction` | The body succeeds, so the earlier writes **commit**. | Let the failure leave the body; recover outside. | [Transactions](../interfaces/sql#transactions) |
| Sending an email, webhook, or model call inside a transaction | Irreversible work inside a body that can roll back or retry. | Intent row in the transaction; deliver after commit. | [External effects after commit (outbox)](../interfaces/sql#external-effects-after-commit-outbox) |
| Mapping every `UniqueViolation` to one domain error | The wrong conflict is reported when another constraint fires. | Check which constraint fired. | [Normalizing errors at a repository boundary](../interfaces/sql#normalizing-errors-at-a-repository-boundary) |
| Editing an applied migration, or merging a lower-numbered one late | The migrator compares only the latest recorded id; the file never runs. | Append-only, higher ids. | [Operating migrations](../interfaces/sql#operating-migrations) |
| Assuming exactly-once delivery | A crash can occur after an external commit and before acknowledgement/journaling. | Idempotency keys, uniqueness constraints, transactions/outbox, and at-least-once-safe handlers. | [Failure windows and honest guarantees](../tooling/persistence#failure-windows-and-honest-guarantees) |

## Anti-patterns: observability and tests

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| Metric attributes with unbounded cardinality: employee, request, or session ids, raw URLs, error messages | Every distinct combination is a stored, billed time series. | Bounded vocabularies; detail in logs and span attributes. | [Cardinality](../operations/observability#cardinality-names-and-attribute-sets-are-bounded) |
| Instance data in a span name: `hris.fetchCompBand E-1042` | Backends group and index by name. | A stable operation name; ids in `attributes`. | [Cardinality](../operations/observability#cardinality-names-and-attribute-sets-are-bounded) |
| Logging whole objects: config, headers, bodies, rows, prompts | Secrets and personal data reach a production store. | Build each record from named, allow-listed fields. | [Privacy](../operations/observability#privacy-allow-list-fields-before-they-are-buffered) |
| `Logger.layer([Logger.consoleJson])` as a drop-in format swap | Replaces the whole logger set; logs stop becoming span events. | Add `Logger.tracerLogger`, or `{ mergeWithExisting: true }`. | [Installing and swapping loggers](../operations/observability#installing-and-swapping-loggers) |
| `Layer.merge(App, ObservabilityLayer)`; an exporter per request or inside a library | The application is built without the telemetry references; exporters compete. | One exporter graph at the root, provided beneath the application. | [Layer order and shutdown](../operations/telemetry-export#layer-order-and-shutdown) |
| The collector in a readiness check; SLIs computed from sampled spans | A telemetry outage becomes an outage; ratios are wrong. | Readiness from serving dependencies; SLIs from unsampled metrics. | [Telemetry is not readiness, liveness, or an audit log](../operations/observability#telemetry-is-not-readiness-liveness-or-an-audit-log) |
| An Effect returned from plain `it(...)` | Vitest never runs it: a green test that proves nothing. | `it.effect`. | [When green means nothing](../deep-dives/testing-an-effect-application#when-green-means-nothing) |
| Tests that assert elapsed milliseconds or pretty-printed failure strings | Flaky, and brittle across releases. | `TestClock` timelines; structural assertions on `Exit`, `_tag`, and fields. | [Assert typed failures as data](../deep-dives/testing-an-effect-application#assert-typed-failures-as-data) |
| `Effect.yieldNow` sprinkled to order fibers | Turn counting passes until something adds a turn. | A handshake per phase. | [Synchronize on phases, not on turns](../deep-dives/testing-an-effect-application#synchronize-on-phases-not-on-turns) |
| Fakes that never fail; socket, signal, or filesystem behavior asserted only against a fake | The failure path and the adapter are never exercised. | Fakes honor the contract; adapters get a real fixture. | [In-memory test runtimes shipped with Effect](../tooling/testing-dev-tooling#in-memory-test-runtimes-shipped-with-effect) |
| An identity `withTransaction` fake | Commits nothing and rolls back nothing, so atomicity is untested. | A repository contract suite against a real database. | [Verification levels](../interfaces/sql#verification-levels) |
| Using `declare const` in a supposedly runnable example | It type-checks only because the actual dependency is missing. | Label it contextual, or supply a complete fixture/runnable program. | — |

## Anti-patterns: durable systems and AI

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| Renaming an `Activity`, workflow tag, or durable primitive while runs are in flight | The name is the journal key: replay re-executes or orphans. | Freeze persisted names; add a `V2` identity. | [Replay, versioning, and rollout](../systems/workflows-durable-execution#replay-versioning-and-rollout) |
| Reading a feature flag or ambient config in a workflow body | The replay can take a different path. | Capture it in an `Activity` or the payload. | [Replay, versioning, and rollout](../systems/workflows-durable-execution#replay-versioning-and-rollout) |
| An idempotency key generated per attempt | It deduplicates nothing. | Derive it from the intent or item id. | [Failure windows and honest guarantees](../tooling/persistence#failure-windows-and-honest-guarantees) |
| Treating a lock or lease as a fence | A stalled owner keeps running after losing the claim. | The sink rejects stale owners. | [A lease is not a fence](../deep-dives/durability-and-distribution-ladder#a-lease-is-not-a-fence) |
| Taking actor, tenant, or approval from model output | Model output is untrusted input. | Trusted request context only. | [Production rules for model calls](../systems/ai-language-models#production-rules-for-model-calls) |
| An agent loop with no turn limit, or tool handlers with default concurrency | Unbounded cost and load. | A bounded loop with a typed exhaustion error; a numeric `concurrency`. | [Bound every agentic loop](../deep-dives/building-a-production-ai-capability#bound-every-agentic-loop) |
