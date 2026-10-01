# Troubleshooting & Anti-Patterns

Debug Effect code in this order: read `Effect<A, E, R>`, inspect the complete `Cause` or `Exit`, check ownership and termination, and only then change the implementation. Most “Effect bugs” are mismatches between the intended success, failure, requirement, or lifetime and the type that was actually built.

## Fast symptom map

Find the symptom, apply the first correction, and follow **Details** to the section that owns the explanation. Rows are grouped by where the symptom shows up, not by module. Each owning page carries the evidence; many of these causes were confirmed by running probes against the installed release rather than read off the types.

### Symptoms: construction, running, and cancellation

| Symptom | Likely cause | First correction | Details |
| --- | --- | --- | --- |
| Nothing happened | An Effect was constructed but never executed, or a branch was never composed into the returned Effect. | Return/yield the Effect; run only the fully provided top-level program. | [“My Effect never ran”](#my-effect-never-ran) |
| Work happened before anything was run; a "lazy" value is stale; every retry reuses the first result | `Effect.succeed(sideEffect())` or `Effect.fail(build())`: arguments are evaluated while the program is being built. | `Effect.sync` / `Effect.try` for run-time work, `Effect.suspend` when choosing the next effect must wait. | [Creating effects](../foundations/core-runtime-execution#1-creating-effects) |
| A timeout or race "won" but the slow request kept running | The Promise adapter is `() => fetch(url)`. `Effect.tryPromise` creates an `AbortController` only when the thunk declares the `signal` parameter, so there is nothing to abort. | `try: (signal) => fetch(url, { signal })` in every adapter. | [Cancellable adapters](../foundations/core-runtime-execution#8-cancellable-adapters-for-promises-and-callbacks) |
| Work continues after the client disconnected | The host's `AbortSignal` never reached the runner, or the adapter ignores Effect's signal. Cancellation crosses two hops and either one can be dropped. | `runPromise(effect, { signal })` **and** the adapter's own `signal`; check `signal.aborted` before calling the runtime. | [The two broken versions](../recipes/request-cancellation-through-a-host#the-two-broken-versions) |
| Interrupting the outer fiber does not stop inner work; `TestClock`, the logger, or the current span is missing inside it | An interior `Effect.runPromise(inner)` created a separate root fiber with an empty context, and flattened its typed failure into a rejection. | Return the Effect. If a nested runner is unavoidable, forward `signal` and carry the `Exit` across. | [Running effects at an owned edge](../foundations/core-runtime-execution#11-running-effects-at-an-owned-edge) |
| `Effect.runSync` throws `AsyncFiberError` | The effect reached an asynchronous boundary; the types cannot rule that out. | `runPromise` / `runPromiseExit`, or make the edge asynchronous. | [Running effects at an owned edge](../foundations/core-runtime-execution#11-running-effects-at-an-owned-edge) |
| `yield* fiber`, `yield* ref`, or `yield* someOption` does not compile, or dies with `Not a valid effect` | Handles, `Option`, and `Result` are not Effects and cannot be yielded inside `Effect.gen` in `4.0.0`, whatever the guides say. | `Fiber.join`, `Ref.get`, `Deferred.await`, `Effect.fromOption`, `Effect.fromResult`. | [Moving between Option, Result, and Effect](../foundations/errors-option-result#moving-between-option-result-and-effect) |
| `Effect.if`, `Effect.unless`, `Effect.loop`, `Effect.iterate`, `Effect.zipLeft`, or `Effect.zipRight` is not exported | They do not exist in Effect 4, though generated code still emits them. | Ordinary `if` / `for` inside `Effect.gen`; `Effect.when(conditionEffect)`; `Effect.andThen` / `Effect.tap`. | [Branching and looping](../foundations/core-runtime-execution#9-branching-and-looping) |
| A forked listener misses the first event | Forking only *schedules* the child; the parent published before the child subscribed. | `{ startImmediately: true }`, or a handshake the child completes after registering. | [When a forked fiber starts](../foundations/core-runtime-execution#when-a-forked-fiber-starts) |
| A cancel call blocks the request for seconds | `Fiber.interrupt` completes only after the target's finalizers have run. | Decide between *request cancellation* and *await cleanup*; bound the finalizer. | [Requesting cancellation versus awaiting cleanup](../foundations/core-runtime-execution#requesting-cancellation-versus-awaiting-cleanup) |
| A helper receives a number where it expected an optional argument | A function was passed by name: `Effect.forEach(ids, loadBand)` calls `loadBand(id, index)`. | Write the lambda: `(id) => loadBand(id)`. | [Generated-code anti-pattern index](#generated-code-anti-pattern-index) |

### Symptoms: errors and recovery

| Symptom | Likely cause | First correction | Details |
| --- | --- | --- | --- |
| `catch` does not handle a crash | The failure is a defect or interruption, not a typed `E`. | Inspect `Cause`; fix defects rather than silently widening recovery. | [Typed failure versus defect and interruption](#typed-failure-versus-defect-and-interruption) |
| A defect disappeared after `catchTag`, or `orDie` replaced it with the typed error | Typed recovery looks at the first `Fail` reason and replaces the **whole** `Cause`; a `Die` or `Interrupt` recorded beside it is dropped. | A guarded `Effect.catchCause` that re-fails when `Cause.hasDies` or `Cause.hasInterrupts`. | [Recovering from a mixed Cause](../foundations/core-runtime-execution#recovering-from-a-mixed-cause) |
| `catchTag("B")` never fires although `B` failed | Only the first `Fail` reason is inspected, so `[Fail(A), Fail(B)]` never matches `B`. | Accumulate as data with `Effect.validate` / `Effect.partition` instead of several `Fail` reasons. | [Recovery replaces the whole Cause](../foundations/errors-option-result#recovery-replaces-the-whole-cause) |
| `catchTag("SchemaError")` never fires | A synchronous decoder was wrapped in `Effect.sync`, so bad input is a defect. | `Schema.decodeUnknownEffect(S)(input)`. | [Decoding and encoding — pick your result style](../data/schema#1-decoding-and-encoding-pick-your-result-style) |
| `Effect.ignore` did not swallow a crash | It discards typed failures only. | Fix the defect; reserve `Effect.ignoreCause` for best-effort cleanup. | [Fallback values and ignoring failures](../foundations/errors-option-result#fallback-values-and-ignoring-failures) |
| A new error variant shipped with no handling | A `switch` with `default`, or `Match.orElse`, assigned it to the old fallback. | `Match.exhaustive` / `Match.tagsExhaustive`. | [Classifying an error union](../foundations/errors-option-result#classifying-an-error-union) |
| Retries and alerts fire on a correct "no" | A negative answer every caller treats as ordinary output was modeled in `E`. | Return it in `A` as a tagged value, `Option`, or `Result`. | [Designing the error model](../foundations/errors-option-result#designing-the-error-model) |
| A timeout or permission error is reported as "not found" or `404` | An infrastructure fault was collapsed into absence. | Only a query that succeeded and returned nothing is "not found". | [Status mapping is part of the contract](../interfaces/http-api#status-mapping-is-part-of-the-contract) |
| A client can read a wrapped driver message | A public error declares `cause: Schema.Defect()`, and every declared field is serialized. | Keep diagnostic causes on internal errors; publish stable tags and safe identifiers. | [Designing the error model](../foundations/errors-option-result#designing-the-error-model) |
| The main task failed but the program keeps waiting | A heartbeat was combined with `Effect.race`, which waits for the first *success*. | `Effect.raceFirst`, with the side task made infallible. | [Running a side task for as long as the main task runs](../concurrency/scheduling-time#running-a-side-task-for-as-long-as-the-main-task-runs) |

### Symptoms: services, Layers, and configuration

| Symptom | Likely cause | First correction | Details |
| --- | --- | --- | --- |
| A service remains in `R` | Its Layer was not provided, or it was hidden under the wrong Layer composition. | Trace the missing service tag and provide its live/test Layer at the composition root. | [A service is still present in R](#a-service-is-still-present-in-r) |
| A sibling Layer cannot see a provider | `Layer.merge` does not feed siblings, or a plain `Layer.provide` consumed the output. | `Layer.provide` for a private dependency, `Layer.provideMerge` when it must stay visible. | [Reading and composing the graph](../foundations/services-context-layers#reading-and-composing-the-graph) |
| A pool is opened once per call although "layers are memoized"; two pools exist | Sibling `Effect.provide(PoolLive)` calls each build their own; so do re-created Layer expressions, `{ local: true }`, and `Layer.fresh`. | Provide the graph once at the edge (or one `ManagedRuntime`) and reuse one named Layer value. | [What is shared, and what is rebuilt](../foundations/services-context-layers#what-is-shared-and-what-is-rebuilt) |
| A test reached a live system | A live `Effect.provide` is buried in reusable code, or the fake was declared but never provided. | Remove the deep `provide`; assert on something only the fake can produce. | [Test layers and substitution](../foundations/services-context-layers#test-layers-and-substitution) |
| A test `ConfigProvider`, `Clock`, or logger override is silently ignored | Default services are references that never appear in `R`, and a Layer merged *beside* its consumer does not reach it. | Provide the override beneath the consumer, or outermost at the edge. | [Default services](../foundations/services-context-layers#default-services) |
| Setting `X=0` or `X=false` is ignored | A falsy fallback with the logical-or operator outside `Config`. | `Config.withDefault`, which falls back on absence only. | [Absence is not malformed input](../foundations/configuration-secrets#absence-is-not-malformed-input) |
| `PORT=eighty` silently became the default | `Config.orElse` rescues **any** `ConfigError`, including a malformed value. | `Config.withDefault`; keep `Config.orElse` for a renamed key. | [Absence is not malformed input](../foundations/configuration-secrets#absence-is-not-malformed-input) |
| A pool opened before the configuration error was reported | Resources are acquired before the whole startup contract has decoded. | One `Config` program, decoded in a Layer that resource Layers depend on. | [Designing the startup contract](../foundations/configuration-secrets#designing-the-startup-contract) |
| A secret appears in a response, queue message, or stored row | `Schema.RedactedFromValue` encodes back to plaintext unless `{ disallowEncode: true }`. | Set the option on every schema whose encoded side leaves the process. | [Secrets that arrive through a schema](../foundations/configuration-secrets#secrets-that-arrive-through-a-schema) |
| Every call through a `ManagedRuntime` fails after one bad start | The Layer build runs once and a failed build is replayed to every later call. | Warm the runtime at boot and treat the failure as fatal. | [Bridge into a host that is not Effect](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#bridge-into-a-host-that-is-not-effect) |
| An inferred Layer type is unreadable | One monolithic inline graph. | Name feature Layers and close them only at the composition root. | [Reading and composing the graph](../foundations/services-context-layers#reading-and-composing-the-graph) |
| Missing `FileSystem`, `HttpClient`, `Path`, or server service | A capability was imported without a platform implementation Layer. | Provide the Node/Bun/Deno/browser/fetch implementation at the outer edge. | [Missing platform Layer](#missing-platform-layer) |
| Structurally incompatible unstable types | `effect` and `@effect/*` packages are from different releases. | Pin every Effect package to the exact same version and inspect the installed graph. | [Incompatible unstable package versions](#incompatible-unstable-package-versions) |

### Symptoms: resources, fibers, and coordination

| Symptom | Likely cause | First correction | Details |
| --- | --- | --- | --- |
| “Scope closed” or a handle stops working | A scoped value escaped its owning scope. | Move its use inside `Effect.scoped`, or expose it through a scoped Layer/ManagedRuntime. | [Scope closed or resource leaked](#scope-closed-or-resource-leaked) |
| Cleanup ran on success only | Cleanup was attached with `tap` / `andThen`, or written after `yield*`. | `Effect.ensuring`, `Effect.acquireRelease`, or `Effect.onExit`. | [Success-only cleanup](#success-only-cleanup) |
| One handle leaks when acquisition fails halfway | A single `acquireRelease` opened two handles; the release is registered only after the whole acquire succeeds. | One bracket per resource. | [One bracket per resource](../deep-dives/anatomy-of-a-real-effect-application#one-bracket-per-resource) |
| Process never exits | A live server/stream/fiber is intentionally running, or a child is waiting on Queue/Deferred/Latch. | Decide the termination protocol; bound, end, interrupt, or supervise it. | [Fiber, Queue, Deferred, Latch, and TestClock hangs](#fiber-queue-deferred-latch-and-testclock-hangs) |
| A background failure was never reported | A detached or unobserved fiber died and nobody joined it. | Own it (`forkScoped`, `FiberSet`) and observe its `Exit`. | [Choosing a fork by its owner](../foundations/core-runtime-execution#choosing-a-fork-by-its-owner) |
| A counter or status loses updates under concurrency | `Ref.get` followed by `Ref.set`, with a suspension between them. | One `Ref.update` / `Ref.modify` transition. | [One transition, one call](../concurrency/state-mutable-references#one-transition-one-call) |
| Two reads of related `TxRef`s report a total that never existed | Each `TxRef.get` ran in its own transaction. | Read both inside one `Effect.tx`. | [Failure rolls back; snapshots need one transaction](../concurrency/software-transactional-memory#failure-rolls-back-snapshots-need-one-transaction) |
| Accepted jobs vanish at shutdown | `Queue.shutdown` was used as end-of-input; it discards the buffer. | `Queue.end`, then join the workers. | [Queue lifecycle](../concurrency/concurrency-coordination#queue-lifecycle-who-ends-it-and-what-a-failure-does) |
| A batch consumer hangs at the end of a queue, or gets a short batch | `Queue.takeN` / `takeBetween` with `min > 1`: honored only when that many values are already buffered, and never completes on an ended queue holding fewer. | `takeBetween(q, 1, max)` or `takeAll`, then check the length. | [Consuming: the consumer picks its waiting policy](../concurrency/concurrency-coordination#consuming-the-consumer-picks-its-waiting-policy) |
| Consumers hang after the producer died | The producer's failure never reached the queue. | `Queue.fail`, `Queue.end`, or wrap the producer with `Queue.into(q)`. | [Queue lifecycle](../concurrency/concurrency-coordination#queue-lifecycle-who-ends-it-and-what-a-failure-does) |
| Events vanish under load with no error | A dropping or sliding buffer, or an unchecked `offerUnsafe` / `publish` result from a synchronous callback. | Choose the loss policy explicitly and count the `false` results. | [Make loss observable](../concurrency/concurrency-coordination#make-loss-observable) |
| Only one observer saw an event, or every worker did the same job | `Queue` and `PubSub` delivery semantics were swapped. | One taker per value → `Queue`; a copy per subscriber → `PubSub`. | [Delivery semantics: Queue or PubSub](../concurrency/concurrency-coordination#delivery-semantics-queue-or-pubsub) |
| A restarted component reports "ready" instantly | A completed `Deferred` was reused for the next lifecycle generation. | A fresh `Deferred` per generation; fail the retired one. | [Deferred](../foundations/core-runtime-execution#deferred) |
| Results arrive in the wrong order | Completion order was mistaken for input or commit order. | Name which order the contract promises. | [Five kinds of order](../deep-dives/structured-concurrency-through-a-bounded-worker#five-kinds-of-order) |
| Requests are cut off at shutdown, or shutdown stalls | `ManagedRuntime.dispose()` is not a drain; or waits are cyclic and unbounded. | Stop intake, drain with a bound, interrupt survivors, then release. | [One shutdown operation](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#one-shutdown-operation) |
| A pool churns connections whenever queries fail | `Pool.invalidate` on every failure. | Invalidate only an item you believe is broken. | [TTL is not a health check](../concurrency/concurrency-coordination#ttl-is-not-a-health-check) |

### Symptoms: streams and buffers

| Symptom | Likely cause | First correction | Details |
| --- | --- | --- | --- |
| Heap grows behind a callback stream | `Stream.callback` and `Stream.fromEventListener` buffer without bound by default. | Pass `{ bufferSize, strategy }`. | [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides) |
| Memory grows somewhere in a pipeline | An unbounded queue, a lagging subscriber, `runCollect`, or `concurrency: "unbounded"`. | Inventory every stage and bound it. | [Unbounded by default](#unbounded-by-default) |
| A preview of a large source reads everything | `runCollect` then `slice`, or `take` placed *after* a `buffer`, which runs ahead of demand. | `Stream.take(n)` before buffers and before the runner. | [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides) |
| A merged stream never ends | `Stream.merge` defaults to `haltStrategy: "both"`, so an infinite ticker keeps it alive. | Pass `"left"`, `"right"`, or `"either"`. | [Combining and splitting streams](../concurrency/streaming-channels#4-combining-and-splitting-streams) |
| A stream "finished" when the source merely went quiet | `Stream.timeout` ends the stream with no error; it is an idle timeout per pull. | `Stream.timeoutOrElse` with `Stream.fail(...)`. | [Handling stream failures](../concurrency/streaming-channels#5-handling-stream-failures) |
| A retry repeated writes | `Stream.retry` re-runs the entire upstream region. | Place `retry` directly after the source; recover per element inside `mapEffect`. | [Handling stream failures](../concurrency/streaming-channels#5-handling-stream-failures) |
| A handle closes before the first row is read | `Stream.scoped` wrapped only the one-element acquisition stream. | `Stream.unwrap` over the scoped acquisition. | [Owning resources inside a stream](../concurrency/streaming-channels#6-owning-resources-inside-a-stream) |
| The sink receives batches of unpredictable size | Buffer capacity is not batch size; chunks after `mapEffect` have one element. | `Stream.grouped(n)` or `Stream.rechunk(n)` directly before the consumer. | [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides) |
| The last partial batch of a live feed never flushes | `Stream.grouped(n)` waits for `n` elements or the end. | `Stream.groupedWithin(n, duration)`. | [Batch by size or time when the source is live](../deep-dives/streaming-ingestion-without-accidental-buffering#batch-by-size-or-time-when-the-source-is-live) |

### Symptoms: time, retry, and caching

| Symptom | Likely cause | First correction | Details |
| --- | --- | --- | --- |
| TestClock test hangs | The sleeping Effect was joined before virtual time advanced. | Fork work, adjust the TestClock, then join. | [Fiber, Queue, Deferred, Latch, and TestClock hangs](#fiber-queue-deferred-latch-and-testclock-hangs) |
| A clock test passes only with `Effect.yieldNow` sprinkled in, then flakes | Turn counting: the fiber registered its `sleep` after the adjustment. | A handshake per sleep boundary. | [Synchronize on phases, not on turns](../deep-dives/testing-an-effect-application#synchronize-on-phases-not-on-turns) |
| Dates read 1970 in tests | Virtual time starts at `0`. | `TestClock.setTime` whenever a calendar rule is under test. | [TestClock](../tooling/testing-dev-tooling#testclock) |
| Retry never happens | The error was converted to a defect, caught earlier, or rejected by the Schedule. | Keep retryable failures typed until after a bounded, filtered retry. | [Retrying the wrong error channel](#retrying-the-wrong-error-channel) |
| Retry hammers a dependency with no delay | The options form `{ while }` without `schedule` means zero delay and no bound. | Pair every predicate with `schedule`, `times`, or both. | [Shorthand options for retry and repeat](../concurrency/scheduling-time#shorthand-options-for-retry-and-repeat) |
| Every retry returns the same settled result | The Promise was created outside the retried Effect. | Create it inside `Effect.tryPromise`. | [Retry policy checklist](../concurrency/scheduling-time#retry-policy-checklist) |
| A retry storm after an outage | Wrong classification, or synchronized callers. | Classify, cap, back off, and add `Schedule.jittered`. | [Retry policy checklist](../concurrency/scheduling-time#retry-policy-checklist) |
| "Identical" cache keys keep missing | Keys compare structurally, so the difference is in the input: `"L4"`, `"l4"`, and `" L4 "` are three keys. | Normalize at ingress; carry the key as a small value class. | [Keys are logical values](../operations/caching-batching#keys-are-logical-values) |
| The cache keeps returning an error after the dependency recovered | With `Cache.make`, a failed `Exit` lives for the full success TTL. | `Cache.makeWith` with a short failure TTL; `Cache.invalidate` on the retry path. | [Failure and freshness policy](../operations/caching-batching#failure-and-freshness-policy) |
| A request dies with `RequestResolver did not complete request` | The resolver skipped an entry, usually for a missing row. | Iterate the *entries* and settle each one. | [Resolver obligations](../operations/caching-batching#resolver-obligations) |
| Batched callers receive each other's data | Rows were paired to entries by position. | Index rows by id, then iterate the entries. | [Resolver obligations](../operations/caching-batching#resolver-obligations) |
| Duplicate ids reach the backend in one batch | Base batching collects entries; it does not collapse equal requests. | Deduplicate in the resolver, or add `RequestResolver.withCache`. | [Resolver obligations](../operations/caching-batching#resolver-obligations) |

### Symptoms: Schema and boundaries

| Symptom | Likely cause | First correction | Details |
| --- | --- | --- | --- |
| Schema types seem reversed | Application `Type` and external `Encoded` were used at the wrong boundary. | Decode inbound `Encoded` to `Type`; encode `Type` before storage/wire output. | [Schema Type and Encoded mismatch](#schema-type-and-encoded-mismatch) |
| Extra or misspelled keys are silently accepted | The default `onExcessProperty: "ignore"` strips undeclared keys. | Choose the policy per boundary and test it. | [Parse options are boundary policy](../data/schema#14-parse-options-are-boundary-policy) |
| `{ key: undefined }` fails to decode | `Schema.optionalKey` rejects an explicit `undefined`; only `Schema.optional` accepts it. | Pick the field helper from the five input states; enable `exactOptionalPropertyTypes`. | [Optional fields, null, and Option](../data/schema#15-optional-fields-null-and-option) |
| An omitted key decodes as absent despite a default | `withConstructorDefault` applies to `make` / `new` only. | `withDecodingDefault` / `withDecodingDefaultKey`. | [Default values](../data/schema#8-default-values) |
| Raw JSON fails with `Expected Option` | `Schema.Option(S)` is not a wire codec. | The `OptionFrom*` family. | [Optional fields, null, and Option](../data/schema#15-optional-fields-null-and-option) |
| `decodeUnknownSync` throws a plain `Error` wrapping `AsyncFiberError` | The schema does asynchronous work. | An Effect runner (`decodeUnknownEffect`). | [Decoding and encoding — pick your result style](../data/schema#1-decoding-and-encoding-pick-your-result-style) |
| "Malformed JSON" and "wrong shape" produce the same response | The two outcomes were folded together. | Keep them distinct to the boundary. | [Keep "malformed" and "does not match" as different outcomes](../deep-dives/schema-from-external-input-to-domain-and-back#keep-malformed-and-does-not-match-as-different-outcomes) |
| A round-trip property fails for a valid codec | The asserted law is the wrong one. | Assert the law that holds for that codec. | [Assert the law that actually holds](../deep-dives/schema-from-external-input-to-domain-and-back#assert-the-law-that-actually-holds) |

### Symptoms: HTTP, RPC, and SQL

| Symptom | Likely cause | First correction | Details |
| --- | --- | --- | --- |
| A peer's `404` is reported as a schema failure | The success schema decoded the error body because the status was never checked. | `filterStatusOk` or `matchStatus` before decoding. | [Three failure classes](../interfaces/http-client#three-failure-classes) |
| A retried `POST` was applied twice | `retryTransient` does not look at the method. | Retry only replay-safe requests; use a server-honored idempotency key. | [Retries, time budgets, and cancellation](../interfaces/http-client#retries-time-budgets-and-cancellation) |
| A large upload exhausts memory | Collected request bodies and multipart parts have **no limit** by default. | `HttpIncomingMessage.MaxBodySize`, `Multipart.MaxParts`, `Multipart.MaxFileSize`. | [Edge policy checklist](../interfaces/http-server#edge-policy-checklist) |
| Clients receive a `400` the OpenAPI document never mentions | The implicit decode failure is not in the contract until declared. | Add `HttpApiError.BadRequestNoContent` to the endpoint's errors. | [Status mapping is part of the contract](../interfaces/http-api#status-mapping-is-part-of-the-contract) |
| Every in-flight RPC call on a connection fails at once | A handler defect is sent as a connection-level `Defect` by default. | Fix the defect; `disableFatalDefects: true` confines it to the failing request. | [Operational defaults](../interfaces/rpc#operational-defaults) |
| `concurrency: 1` on `RpcServer`, yet handlers overlap | `Rpc.fork` skips the server-wide semaphore. | Audit every `Rpc.fork`. | [Operational defaults](../interfaces/rpc#operational-defaults) |
| A procedure silently changed after merging groups | A duplicate tag replaces the earlier definition. | Prefix groups, or assert tag uniqueness in a test. | [Evolving a contract](../interfaces/rpc#evolving-a-contract) |
| Old clients fail with defects right after a deploy | A required payload field, tighter check, or new error member reached a peer that cannot decode it. | Evolve additively; add a new procedure for incompatible changes. | [Evolving a contract](../interfaces/rpc#evolving-a-contract) |
| A retried RPC mutation ran twice | `RpcClientError` means the outcome is unknown. | One idempotency key per intent, recorded with the mutation. | [Retried mutations need a ledger](../interfaces/rpc#retried-mutations-need-a-ledger) |
| Rows are left behind after a failed multi-write | The failure was caught **inside** `withTransaction` (the body then succeeds and commits), or the first write ran before it. | Put the whole unit inside; recover outside. | [Transactions](../interfaces/sql#transactions) |
| A duplicate email or webhook after a retry or rollback | An external effect ran inside a transactional or retried body. | Write an intent row in the transaction; deliver after commit with the event id as idempotency key. | [External effects after commit (outbox)](../interfaces/sql#external-effects-after-commit-outbox) |
| An edited migration never ran | The migrator compares only the latest recorded id. | Append-only migrations with higher ids. | [Operating migrations](../interfaces/sql#operating-migrations) |
| Overload turns into a restart loop | The readiness probe queues behind a saturated pool. | A short probe deadline with its own headroom; liveness independent of the database. | [Pools, reservations, and streaming](../interfaces/sql#pools-reservations-and-streaming) |

### Symptoms: observability

| Symptom | Likely cause | First correction | Details |
| --- | --- | --- | --- |
| An "active" gauge never returns to zero | The decrement runs on the success path only, or misses interruption. | Decrement in `Effect.ensuring`. | [Gauges that follow a lifetime](../operations/observability#gauges-that-follow-a-lifetime) |
| Metric series and backend cost explode | Ids, URLs, or error text used as metric attributes. | Bounded vocabularies; detail goes in logs and span attributes. | [Cardinality: names and attribute sets are bounded](../operations/observability#cardinality-names-and-attribute-sets-are-bounded) |
| Logs stopped appearing as span events after a logger change | `Logger.layer([...])` replaces the whole default set, including `Logger.tracerLogger`. | List `Logger.tracerLogger` again, or pass `{ mergeWithExisting: true }`. | [Installing and swapping loggers](../operations/observability#installing-and-swapping-loggers) |
| Logs from startup fibers and finalizers bypass the installed logger | `Layer.merge(App, ObservabilityLayer)` builds the two side by side. | `App.pipe(Layer.provide(ObservabilityLayer))`. | [Layer order and shutdown](../operations/observability#layer-order-and-shutdown) |
| Logs and metrics are reported twice, or one trace path is silent | Two export paths installed for the same signal. | Exactly one export path per signal. | [One export path per signal](../operations/observability#one-export-path-per-signal) |
| The process hangs on exit with a dead collector | A hand-rolled exporter flushes without a deadline. | `shutdownTimeout` on the OTLP layers; `Effect.timeoutOption` around any manual flush. | [Layer order and shutdown](../operations/observability#layer-order-and-shutdown) |
| A secret appears in logs | It was logged after `Redacted.value`. | Log the `Redacted`; allow-list fields before they are buffered. | [Keeping secrets masked in log payloads](../operations/observability#keeping-secrets-masked-in-log-payloads) |
| A trace breaks at a queue, worker, or message bus | Fiber context does not cross serialized boundaries. | Carry a trace header and rebuild the parent with `Tracer.externalSpan`. | [Span and correlation rules](../operations/observability#span-and-correlation-rules) |

### Symptoms: durable systems and AI

| Symptom | Likely cause | First correction | Details |
| --- | --- | --- | --- |
| An activity executed again after a refactor | The `Activity` `name` is the journal key; renaming it orphans the recorded `Exit`. | Freeze persisted names; introduce a `V2` identity for incompatible changes. | [Replay, versioning, and rollout](../systems/workflows-durable-execution#replay-versioning-and-rollout) |
| Workflow finalizers or compensation did not run when a runner shut down | The interrupt was classified as an abandoned attempt; the next owner replays. | Expected: keep activities idempotent. | [Abandoned run attempts](../systems/workflows-durable-execution#abandoned-run-attempts) |
| The same persisted job ran on two workers | A lock is a lease: a stalled worker loses its claim while still running. | Make the sink reject stale owners; derive the idempotency key from the item id. | [Failure windows and honest guarantees](../tooling/persistence#failure-windows-and-honest-guarantees) |
| `MailboxFull` during a cold start | Per-runner resident-entity or mailbox limits engaged. | Size the limits from memory and alert on the gauges. | [Capacity limits and their defaults](../systems/cluster-sharding#capacity-limits-and-their-defaults) |
| One model turn floods a rate-limited dependency | Tool-call resolution runs with `concurrency: "unbounded"` by default. | Set a number. | [Tool-call resolution](../systems/ai-language-models#tool-call-resolution-concurrency-and-manual-dispatch) |
| A mutating tool ran before approval | The framework resolves tool calls during the generation call. | `disableToolCallResolution: true`, then dispatch through your own gates. | [Keep the framework from executing a mutation before your gates run](../deep-dives/building-a-production-ai-capability#keep-the-framework-from-executing-a-mutation-before-your-gates-run) |
| An MCP client sees only a generic error instead of the tool's failure | The failure was undeclared, a defect, or failed to encode; those are logged and reported server-side, and the client gets a generic message. Declared failures reach the client as `isError: true` in either `failureMode`. | Declare the failure schema on the tool; look for the logged cause. | [McpServer](../systems/ai-language-models#mcpserver) |
| An MCP client receives JSON-RPC error `-32021` with `requiredCapabilities` | The tool needs a client capability the request did not declare (elicitation, sampling with tools, roots). | Declare the capability on the client, or gate the tool with `McpSchema.EnabledWhen` so clients that lack it never see it. | [McpServer](../systems/ai-language-models#mcpserver), [Exposing an Effect Application over MCP](../deep-dives/exposing-an-effect-application-over-mcp) |
| A resumed `tools/call` on the stateless protocol fails with `InvalidParams` | The handler rejected the echoed `requestState`: tampered, expired, or minted for another caller. | Seal the state with an HMAC, bind it to the principal, give it a TTL, and treat a rejection as the client error it is. | [Exposing an Effect Application over MCP](../deep-dives/exposing-an-effect-application-over-mcp) |
| `McpServer.elicit` cannot be used, or a confirmation never reaches a `2026-07-28` client | `elicit` pushes `elicitation/create` to a session-era client; the stateless protocol has no server-initiated requests. | Register the tool through the low-level `McpServer.McpServer.addTool` and return `McpSchema.InputRequired`; read the answer from `McpRequestContext.inputResponses` on the retry. | [Exposing an Effect Application over MCP](../deep-dives/exposing-an-effect-application-over-mcp) |
| Model retries loop or re-bill the prompt | Non-retryable reasons are retried, or retries continue after output exists. | Branch on `error.isRetryable`; bound the schedule. | [Classifying a failure before retrying](../systems/ai-language-models#classifying-a-failure-before-retrying) |

### Symptoms: tests

| Symptom | Likely cause | First correction | Details |
| --- | --- | --- | --- |
| A test is green but never ran | An Effect was returned from plain `it(...)`. | `it.effect`; enable the `floatingEffectInVitest` diagnostic. | [When green means nothing](../deep-dives/testing-an-effect-application#when-green-means-nothing) |
| A property test ends `Exhausted` | An opaque `filter` rejects too many generated candidates. | Constructive Schema checks (`isBetween`, `isPattern`) instead of rejection filters. | [Shrinking, composition, and wire-side samples](../tooling/testing-dev-tooling#shrinking-composition-and-wire-side-samples) |
| A `FileSystem.layerNoop` test fails with `NotFound` or dies with `not implemented` | A method the code calls was not overridden. | Supply that method. | [Testing without a disk](../interfaces/platform-runtime-hosts#testing-without-a-disk) |
| `catchTag("InvalidValue")` on `Command.run` never fires | Parse failures arrive wrapped in one `ShowHelp`. | Inspect `ShowHelp.errors`. | [CliError](../tooling/cli-framework#clierror) |
| A test flakes | Real sleeps, polling, shared Layer state, or fixed ports. | Follow the flake protocol before adding a retry. | [When a test flakes](../deep-dives/testing-an-effect-application#when-a-test-flakes) |

### Symptoms: after an upgrade

| Symptom | Likely cause | First correction | Details |
| --- | --- | --- | --- |
| RPC or cluster peers cannot decode each other; an EventLog journal written by another release is unreadable | The peers or the journal do not share a wire format. `SchemaBinary` is the binary format for RPC, cluster runner transports, and EventLog journals and remote messages; there is no MessagePack codec. | Use `RpcSerialization.layerSchemaBinary()` on both peers together; upgrade both ends of a binary link in one rollout and rehearse mixed-version deployments. | [SchemaBinary](../concurrency/streaming-channels#schemabinary), [RpcSerialization](../interfaces/rpc#rpcserialization) |
| A CLI fails with `MissingOption` for a boolean flag nobody passed | An omitted boolean flag is no longer an implicit `false`. | `Flag.withDefault(false)`, `Flag.optional`, or a fallback. | [Flag](../tooling/cli-framework#flag) |
| `Config.string is not a function`; `Flag.integer` is missing | Constructors are PascalCase. | `Config.String`, `Config.Redacted`, `Flag.Int`, `Prompt.String`, and so on. | [Built-in constructors](../foundations/configuration-secrets#built-in-constructors), [Flag constructors at a glance](../tooling/cli-framework#flag-constructors-at-a-glance) |
| `Schema.toArbitrary` or `effect/testing/FastCheck` is missing; saved seeds no longer reproduce; tests report `Exhausted` | The fast-check bridge was replaced by the native `Arbitrary` engine. | `Arbitrary.schema(S)`, `{ arbitrary: { runs } }`; re-record saved failures. | [Arbitrary](../tooling/testing-dev-tooling#arbitrary) |
| `Stream.partition` branches are swapped, or `bufferSize` is rejected | It returns `[passes, fails]` and the option is `capacity`. Swapped names still type-check. | Reorder the destructuring; rename the option. | [Combining and splitting streams](../concurrency/streaming-channels#4-combining-and-splitting-streams) |
| `Stream.mapBoth` rejects `onSuccess`/`onFailure`; `Stream.scan` rejects a plain seed | Stream signatures mirror Effect's. | `{ onElement, onError }`; `Stream.scan(() => seed, f)`. | [Transforming streams](../concurrency/streaming-channels#2-transforming-streams) |
| `"1.5 KiB"` is not assignable to `ByteSize.Input` | `ByteSize.Input` literals must be a whole number and a unit. | Parse text with `ByteSize.fromString`. | [ByteSize](../data/functional-toolkit#bytesize) |
| YAML that used to load now throws `SyntaxError` | The parser rejects unquoted plain scalars containing `: ` or ending in `:`, compact nested sequences, and multi-document input. | Quote the value. | [Yaml](../concurrency/streaming-channels#yaml) |
| `getter.compose`, `new SchemaGetter.Getter`, `SchemaGetter.onSome`, or `SchemaTransformation.make` is missing | Getters and transformations are plain data with standalone combinators. | `SchemaGetter.compose` / `map` / `run`, `transformOptionalEffect`, `SchemaTransformation.composeTransformation`, `makeTransformation`. | [SchemaGetter](../data/schema#schemagetter), [SchemaTransformation](../data/schema#schematransformation) |
| Saved `Arbitrary` replay tokens no longer reproduce | Replay tokens encode the generator's shrinking and replay paths, which may change between releases while `Arbitrary` is unstable. | Re-run the property, re-record the token, and keep important failing inputs as regression tests. | [Arbitrary](../tooling/testing-dev-tooling#arbitrary) |
| A custom `OpenRouterClient.Service` mock no longer type-checks | The service interface includes `createDecisions`. | Implement it in the mock. | [Provider packages](../systems/ai-language-models#provider-packages) |
| `HttpServerResponse.file` rejects `contentLength` | The option does not exist; lengths come from the file and the requested range. | Delete the option. | [HttpPlatform](../interfaces/http-server#httpplatform) |
| Generated JSON Schema now says `"additionalProperties": true` | JSON Schema generation is open by default. | `{ onExcessProperty: "error" }`; refresh snapshots. | [JsonSchema](../data/schema#jsonschema) |
| PostgreSQL rows decode differently than a row Schema expects: `bigint` for `int8`, `Date` for `timestamp` / `timestamptz`, text for an enum, `Uint8Array` for `bytea`, or `SqlError` in a `listen` queue type | `@effect/sql-pg` is a native wire-protocol client with its own result codecs: `int8` is `bigint`, timestamps are `Date`, unregistered types such as enums are UTF-8 text, and `listen` queues are typed with `SqlError`. | Match the row Schema to those types or register a codec (enum arrays need one); wrap JSON parameters in `sql.json`; send one statement per query string; wrap `listen` consumers in `Stream.retry`. | [SQL](../interfaces/sql) |
| `onExcessProperty: "preserve"` or `propertyOrder` is rejected | Both parse options were removed. | Model unknown keys with `Schema.Record` / `Schema.StructWithRest`. | [Parse options are boundary policy](../data/schema#14-parse-options-are-boundary-policy) |
| Logs vanished from traces after installing a custom logger | `Logger.layer` replaces the whole logger set, `tracerLogger` included. | `Logger.layer([Logger.consoleJson, Logger.tracerLogger])`. | [Installing and swapping loggers](../operations/observability#installing-and-swapping-loggers) |
| Anything else that used to compile | The code was written for a 4.0 release candidate or for Effect 3. | Fix import paths first (`effect/unstable/<area>` → `effect/<area>`, `httpapi` → `http-api`, `Arbitrary` from `"effect"`, `effect/Encoding` → `effect/encoding/*`), then check the per-package `CHANGELOG.md` and the migration guide. | [Stability and support](../#stability-and-support), [Migration guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0/MIGRATION.md) |

## “My Effect never ran”

An Effect is a lazy description. Calling a function that returns an Effect, placing an Effect inside `Effect.sync`, or constructing one inside an unreturned callback does not execute it.

**Contextual fragment — wrong and corrected composition.**

```ts
// Wrong: the callback constructs an Effect and discards it.
const wrong = Effect.sync(() => saveEmployee(employee))

// Correct: compose the returned Effect.
const correct = Effect.flatMap(validateEmployee(employee), saveEmployee)

// Also correct inside Effect.gen: yield the operation.
const correctGen = Effect.gen(function*() {
  const valid = yield* validateEmployee(employee)
  return yield* saveEmployee(valid)
})
```

Run with `Effect.runPromise`, `runSync`, or a platform `runMain` only at an edge that owns the fiber and only after `R` is fully supplied. Calling a runner inside a service creates a separate root fiber with an empty context, so interruption, provided services (including `TestClock`), and the typed failure are all lost; [Running effects at an owned edge](../foundations/core-runtime-execution#11-running-effects-at-an-owned-edge) has the runner table and the one safe shape for an unavoidable nested runner.

The opposite mistake looks the same from the outside: **work that ran too early.** `Effect.succeed(Date.now())` and `Effect.fail(buildError())` evaluate their argument while the program is being built, so every run and every retry replays one captured value. Use `Effect.sync` or `Effect.suspend`, and pin the behavior with a laziness test — build the effect, assert the spy count is `0`, run it, assert `1` ([Prove laziness and the static contract](../tooling/testing-dev-tooling#prove-laziness-and-the-static-contract)).

If a branch appears skipped, inspect the returned structure. `Effect.when(self, condition)` takes an `Effect<boolean>` — not a plain boolean and not a thunk — and returns `Effect<Option<A>>`, with `Option.none()` for the skipped case; `4.0.0` has no `Effect.unless`, `Effect.if`, `Effect.whenEffect`, or `Effect.unlessEffect`, so negate the condition or use an ordinary `if` inside `Effect.gen` ([Branching and looping](../foundations/core-runtime-execution#9-branching-and-looping)). `Option`/`Result` combinators can select another branch, and `Effect.as` changes only the success value—it does not execute a discarded Effect hidden in a callback. Passing a function by name can also skip or corrupt a call: `Effect.forEach(ids, loadBand)` invokes `loadBand(id, index)`.

Official guide: [Running Effects](https://effect.website/docs/v4/getting-started/running-effects) (it names the `runFork` result `RuntimeFiber`; in `4.0.0` it is `Fiber<A, E>`).

## A service is still present in R

`R` is a set of unsatisfied service tags. Read a diagnostic such as `Effect<User, DbError, Users | SqlClient>` literally: the program still needs both services.

**Contextual fragment — provide dependencies at the edge.**

```ts
const UsersLive = Layer.effect(Users, makeUsers).pipe(
  Layer.provide(SqlLive) // SqlLive is used to build Users and is not re-exposed.
)

const main = program.pipe(
  Effect.provide(UsersLive)
)
```

Use `Layer.provide(dependency)` when the dependency exists only to construct that Layer. Use `Layer.provideMerge(dependency)` when the dependency must also remain in the output for other consumers. `Layer.merge` combines sibling outputs; it does not automatically feed one sibling into another.

Reuse the same named Layer value when several branches must share one pool or scoped resource. Layer memoization is based on object identity inside one build graph; reconstructing equivalent expressions can acquire separate instances. Sharing also needs one enclosing build: two sibling `Effect.provide(PoolLive)` calls — sequential or concurrent — build two pools, because each writes to its own memo map, while the same provides nested under an enclosing build of `PoolLive` reuse it. `{ local: true }` and `Layer.fresh` rebuild on purpose. The measured matrix is in [What is shared, and what is rebuilt](../foundations/services-context-layers#what-is-shared-and-what-is-rebuilt).

A clean `R` is not proof of correct wiring. `Clock`, `ConfigProvider`, `Console`, `Random`, and `Tracer` are references with live defaults, so a forgotten test override compiles and silently uses the real one ([Default services](../foundations/services-context-layers#default-services)); and an `Effect.provide(LiveLayer)` buried inside reusable logic makes `R` look satisfied while hard-wiring production I/O into every test.

Do not silence a missing service with a cast. Find the tag in `R`, locate its implementation Layer, and decide whether it belongs under one component or at the application root.

## Typed failure versus defect and interruption

`Effect.fail(error)` contributes to `E`. `Effect.die(defect)`, thrown exceptions not captured by an Effect constructor, and impossible-state bugs are defects. Interruption records that a fiber was cancelled. All are represented in `Cause`, but ordinary typed recovery sees only failures.

**Contextual fragment — preserve the intended channel.**

```ts
const request = Effect.tryPromise({
  try: () => fetch(url),
  catch: (cause) => new NetworkError({ cause })
})

const recovered = request.pipe(
  Effect.catchTag("NetworkError", () => cachedResponse)
)

// Use at a deliberate boundary only: this removes NetworkError from E by
// turning it into a defect. Effect.catchTag can no longer recover it afterward.
const unrecoverable = request.pipe(Effect.orDie)
```

The fragment keeps the adapter short to show the channels. A production adapter also declares and forwards the `signal` that `Effect.tryPromise` offers — `try: (signal) => fetch(url, { signal })` — because without the parameter no `AbortController` is created and an interrupted fiber leaves the request running ([Cancellable adapters](../foundations/core-runtime-execution#8-cancellable-adapters-for-promises-and-callbacks)).

Defects come from `Effect.die(value)`, from `Effect.orDie`, from a rejection inside `Effect.promise`, and from any `throw` the runtime catches outside a `try` constructor — inside `Effect.sync`, an `Effect.map` callback, or the body of `Effect.gen`. When a boundary promotes a typed failure deliberately, `Effect.mapError` it into a descriptive `Error` first so the defect is diagnosable.

Use `Effect.exit` when success/failure should become data and `Effect.catchCause` when cleanup, reporting, or a true boundary must examine the complete cause. Do not catch every Cause and pretend interruption or defects are ordinary domain failures; doing so can prevent shutdown and hide bugs.

**Typed recovery can also lose a defect.** A `Cause` is a flat list of reasons and may hold a `Fail` *and* a `Die` — a failing operation whose finalizer dies is the common case. `Effect.catch`, `catchTag`, `match`, `result`, `mapError`, `orDie`, and `retry` all act on the first `Fail` reason and replace the whole `Cause`, so the defect beside it disappears. Where that matters, recover through `Effect.catchCause` and re-fail with `Effect.failCause(cause)` when `Cause.hasDies(cause)` or `Cause.hasInterrupts(cause)`; the truth table is in [Recovering from a mixed Cause](../foundations/core-runtime-execution#recovering-from-a-mixed-cause).

Where a boundary must survive a crash — a plugin host, a per-job worker — `Effect.catchDefect` is the narrow tool: typed failures and interruption pass through it untouched. Recover only the defect you recognize and re-raise the rest.

**Boundary shape — isolate a recognized defect, re-die everything else.**

```ts
import { Effect, Predicate } from "effect"

declare const runBandImportPlugin: Effect.Effect<string, "BandFileMissing">

const isolated = runBandImportPlugin.pipe(
  Effect.catchDefect((defect) =>
    Predicate.isError(defect) && defect.name === "PluginCrash"
      ? Effect.logError("band import plugin crashed", { message: defect.message }).pipe(
        Effect.as("plugin disabled")
      )
      : Effect.die(defect) // not ours: do not swallow an unknown bug
  )
)
```

Official guide: [Unexpected Errors](https://effect.website/docs/v4/error-management/unexpected-errors).

## Scope closed or resource leaked

A value acquired with `Effect.acquireRelease`, `Pool.get`, `ScopedCache.get`, `PubSub.subscribe`, server Layers, or platform handles belongs to a Scope. The finalizer runs when that scope closes, regardless of success, typed failure, defect, or interruption.

**Contextual fragment — keep acquisition and use under one scope.**

```ts
const query = Effect.scoped(
  Effect.gen(function*() {
    const connection = yield* Pool.get(pool)
    return yield* connection.execute("select 1")
  })
)
```

Returning `connection` from `Effect.scoped` is a bug: its borrow has already ended. Return plain data, move the caller into the same scope, or expose the owned resource through a scoped Layer whose consumers run while that Layer is alive.

For a whole Effect application, use `Layer.launch` and a platform `runMain`. For repeated calls from a non-Effect host, use one `ManagedRuntime` and always call `dispose()` (or use `await using`). Do not allocate a new ManagedRuntime, pool, client Layer, or Scope per request unless isolation is intentional. `dispose()` is not a drain — it interrupts running fibers while the Layer scope closes — so stop admission and wait for in-flight work first ([Bridge into a host that is not Effect](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#bridge-into-a-host-that-is-not-effect)).

Three more leak shapes have the same root, a lifetime nobody chose:

- **`Scope` left in `R` means nobody owns the lifetime yet.** Each discharge (`Effect.scoped`, `Layer.effect`, a hand-made scope) is a decision about how long the resource lives; a Layer provided inside a request handler is acquired and released once per request ([Write the ownership ledger first](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#write-the-ownership-ledger-first)).
- **One `acquireRelease` per handle.** The release is registered only after the acquire effect succeeds, so an acquire that opens two handles and fails on the second leaks the first ([One bracket per resource](../deep-dives/anatomy-of-a-real-effect-application#one-bracket-per-resource)).
- **Acquire inside a stream, never before it.** A handle opened outside and closed "when the consumer is done" leaks on the first `take(n)` or decode failure ([Owning resources inside a stream](../concurrency/streaming-channels#6-owning-resources-inside-a-stream)).

Finalizers are infallible by type and run uninterruptibly: a fallible `close()` needs a stated policy (log and ignore, bound then ignore, `orDie`, or report through `acquireUseRelease`), and an unbounded finalizer is an unbounded shutdown ([When cleanup can fail](../foundations/core-runtime-execution#10-when-cleanup-can-fail)).

Official guide: [Scope](https://effect.website/docs/v4/resource-management/scope).

## Success-only cleanup

One mistake keeps reappearing under different names: a closing action attached to the happy path only. Code placed after `yield* work` runs on success; `Effect.tap` plus `Effect.tapError` still misses interruption, which is how timeouts, races, and shutdown end work. **Anything opened, incremented, awaited, or promised needs its closing action attached structurally** — `Scope`, `Effect.ensuring`, `Effect.acquireRelease`, `Effect.onExit`, or "iterate the entries" — so success, typed failure, defect, and interruption all pass through it.

| Instance | What goes wrong | Structural fix | Details |
| --- | --- | --- | --- |
| A `Deferred` completed after a fallible step | Waiters hang when the step fails or is interrupted | Complete it from `Effect.onExit`, or with the step's `Exit` | [Deferred](../foundations/core-runtime-execution#deferred) |
| An "in-flight" gauge decremented after the work | The gauge stays high after a failure or timeout | Decrement in `Effect.ensuring` | [Gauges that follow a lifetime](../operations/observability#gauges-that-follow-a-lifetime) |
| A subscription or file closed when the consumer finishes | It leaks on early stop, failure, or interruption | A scoped acquisition; `Stream.unwrap` for streams | [Proving a subscription did not leak](../concurrency/concurrency-coordination#proving-a-subscription-did-not-leak) |
| A resolver entry settled only when a row exists | The caller dies with `RequestResolver did not complete request` | Iterate the entries and settle every one | [Resolver obligations](../operations/caching-batching#resolver-obligations) |
| A span or exporter closed only on clean shutdown | Telemetry from the failing path — the interesting one — is lost | A scoped exporter Layer, provided beneath the application | [Layer order and shutdown](../operations/observability#layer-order-and-shutdown) |
| Partial multi-step setup left behind on failure | Earlier steps stay created | Exit-aware releases inside one `Effect.scoped` | [Roll back partial work with exit-aware finalizers](../deep-dives/failure-retry-fallback-and-interruption#roll-back-partial-work-with-exit-aware-finalizers) |

To prove the fix, assert the closing action under all three exits, not just success: [Test lifetimes, not just values](../deep-dives/testing-an-effect-application#test-lifetimes-not-just-values).

## Fiber, Queue, Deferred, Latch, and TestClock hangs

A hang usually means the program has no event capable of satisfying its wait:

- `Fiber.join` waits for that fiber’s completion. Joining a server, `Effect.never`, or an unbounded stream is intentionally permanent.
- `Queue.take` waits for an element; a bounded `Queue.offer` waits for capacity. Supply a producer/consumer and call `Queue.end` or `Queue.fail` when the protocol finishes.
- `Deferred.await` needs one completion path on every outcome. If completion follows a fallible operation, use `Effect.exit`/`Deferred.complete` or an ensuring/finalizer strategy.
- `Latch.await` waits until open. Decide which supervised fiber owns `Latch.open` and what happens on its failure.
- A bare `SubscriptionRef.changes`, PubSub stream, or Queue stream is live. Tests and finite consumers should use `Stream.take`, timeout, or an explicit end signal.
- `Queue.takeN(q, n)` and `Queue.takeBetween(q, min, max)` with `min > 1` never complete on a queue that has already ended with fewer than `min` values left, and can return fewer than `min` after waiting. Batch consumers of a queue that can end should use `takeBetween(q, 1, max)` or `takeAll` and check the length ([Consuming](../concurrency/concurrency-coordination#consuming-the-consumer-picks-its-waiting-policy)).
- A consumer blocked in `take` learns nothing from a producer fiber that died. Propagate a terminal signal with `Queue.end`, `Queue.fail`, or `Queue.into(q)` ([Queue lifecycle](../concurrency/concurrency-coordination#queue-lifecycle-who-ends-it-and-what-a-failure-does)).
- `Queue.shutdown` finishes the queue by interruption: fibers parked on `take`, `offer`, or `Queue.await` end as interrupted, so follow-up logic chained with `andThen` never runs and `Fiber.join` on them re-raises the interruption. Attach reactions with `Effect.onExit` and observe with `Fiber.await`.
- A forked subscriber can miss the first events: forking only schedules the child, so a parent that publishes straight away runs first. Pass `{ startImmediately: true }` or wait for a handshake ([When a forked fiber starts](../foundations/core-runtime-execution#when-a-forked-fiber-starts)).
- `Effect.race` waits for the first *success*. A main task that fails while a never-ending side task is healthy leaves `race` waiting forever; use `Effect.raceFirst` ([Running a side task](../concurrency/scheduling-time#running-a-side-task-for-as-long-as-the-main-task-runs)).

**Contextual fragment — virtual time must be driven from another fiber.**

```ts
const fiber = yield* Effect.sleep("10 seconds").pipe(
  Effect.as("ready"),
  Effect.forkChild
)

yield* TestClock.adjust("10 seconds")
const result = yield* Fiber.join(fiber)
```

The deadlocking order is “join, then adjust”: execution can never reach the adjustment. `@effect/vitest` supplies TestClock to `it.effect`; use `it.live` only when real time is genuinely under test. `TestClock.adjust` gives already-forked fibers exactly one scheduling turn before it moves time, so a fiber that needs more turns to reach its `sleep` registers it too late and the join never completes. Do not count turns with `Effect.yieldNow`; have the operation announce each attempt and wait for that handshake before each adjustment ([Synchronize on phases, not on turns](../deep-dives/testing-an-effect-application#synchronize-on-phases-not-on-turns)). The warning "A test is using time, but is not advancing the test clock" means exactly this kind of missing adjustment.

Prefer `forkChild`, `forkScoped`, `FiberSet`, `FiberMap`, or another owner-aware supervisor. `forkDetach` deliberately escapes the parent and should be rare; detached work can keep resources or business work alive beyond the request that created it. Name the owner first and the fork function follows ([Choosing a fork by its owner](../foundations/core-runtime-execution#choosing-a-fork-by-its-owner)); work that must outlive its request is *transferred* to a named, Layer-owned, bounded supervisor, never detached.

Official guide: [Fibers](https://effect.website/docs/v4/concurrency/fibers) (its prose calls `Effect.yieldNow()`; in `4.0.0` `Effect.yieldNow` is a value, and the guide does not mention the `startImmediately` fork option).

## Unbounded by default

A buffer without a capacity is a memory leak waiting for load, a capacity without an overflow policy is an undecided design, and a loss nobody counts is invisible. Several defaults are unbounded, so "we never configured it" usually means "it has no limit". Audit these first when memory grows or a dependency is flooded:

| Default | What is unbounded | Bound it with | Details |
| --- | --- | --- | --- |
| `Stream.callback`, `Stream.fromEventListener` | values pushed but not yet pulled | `{ bufferSize, strategy }` | [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides) |
| `Queue.unbounded()`, `PubSub.unbounded()` | the backlog behind the slowest consumer | a bounded, dropping, or sliding constructor chosen as a policy | [Queue](../concurrency/concurrency-coordination#queue) |
| `SubscriptionRef.changes` | backlog of a permanently slow subscriber | a consumer that keeps up, or a bounded hand-off downstream | [SubscriptionRef](../concurrency/state-mutable-references#subscriptionref) |
| `{ concurrency: "unbounded" }` | in-flight effects and their results | a number, a shared `Semaphore`, or a `Pool` | [Write the execution policy first](../deep-dives/structured-concurrency-through-a-bounded-worker#write-the-execution-policy-first) |
| `RpcServer` `concurrency` | concurrently running handlers | a number; note that `Rpc.fork` bypasses it | [Operational defaults](../interfaces/rpc#operational-defaults) |
| AI tool-call resolution `concurrency` | tool handlers started by one model turn | a number on the generation call | [Tool-call resolution](../systems/ai-language-models#tool-call-resolution-concurrency-and-manual-dispatch) |
| HTTP request bodies, multipart part count and file size | bytes collected per request | `HttpIncomingMessage.MaxBodySize`, `Multipart.MaxParts`, `Multipart.MaxFileSize` | [Edge policy checklist](../interfaces/http-server#edge-policy-checklist) |
| `Ndjson` lines, `Stream.splitLines`, raw `SchemaBinary` frames | one incomplete line or frame from the peer | `Stream.limitBytes` upstream; `maxFrameSize` on `SchemaBinary` (the `RpcSerialization` NDJSON and SchemaBinary layers already default to 16 MiB) | [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides) |
| `Stream.groupByKey` | one queue per key, keys never retired | `bufferSize`, `idleTimeToLive` | [Transforming streams](../concurrency/streaming-channels#2-transforming-streams) |
| `Stream.runCollect`, `Sink.collect()` | the whole stream | `Stream.take`, a fold, or a bounded `Sink` | [Running streams](../concurrency/streaming-channels#3-running-streams) |
| Retry options with a predicate and no `schedule` or `times` | attempts, with zero delay | `schedule`, `times`, or both | [Shorthand options for retry and repeat](../concurrency/scheduling-time#shorthand-options-for-retry-and-repeat) |

## Retrying the wrong error channel

`Effect.retry` reacts to typed failure, not defects, and reruns the entire wrapped Effect. Place it around the smallest idempotent operation, before `orDie`, and filter by retryability.

**Contextual fragment — bounded and classified retry.**

```ts
const retryTransient = Schedule.exponential("200 millis").pipe(
  Schedule.setInputType<HttpError>(),
  Schedule.while(({ input }) => input.retryable),
  Schedule.upTo({ times: 5 })
)

const response = callProvider.pipe(
  Effect.retry(retryTransient),
  Effect.catchTag("HttpError", reportPermanentFailure)
)
```

Do not retry validation errors, authentication/authorization failures, schema defects, or permanent 4xx responses. Respect provider backoff and `Retry-After`, add jitter for many clients, and cap attempts or elapsed duration.

Retried external writes are not automatically exactly once. Use an idempotency key, database uniqueness/transaction, or outbox. Workflow Activities are also delivered at least once until their completed Exit is durably recorded.

Four more ways a retry policy goes wrong, each owned elsewhere:

- **A defect is never retried, and must not be.** Mapping every rejection of a foreign Promise to one retryable error makes a `TypeError` in the adapter look like an outage; recognize the failures the contract allows and `Effect.die` the rest ([Cancellable adapters](../foundations/core-runtime-execution#8-cancellable-adapters-for-promises-and-callbacks)).
- **The options form can be a hot loop.** `Effect.retry(effect, { while: isTransient })` with no `schedule` and no `times` retries immediately and without limit ([Shorthand options](../concurrency/scheduling-time#shorthand-options-for-retry-and-repeat)).
- **The side effect must be built inside the retried Effect.** Retrying `Effect.promise(() => pending)` over a Promise created earlier replays one settled result ([Retry policy checklist](../concurrency/scheduling-time#retry-policy-checklist)).
- **Timeout placement changes the meaning.** `Effect.timeout` before `retry` bounds each attempt and turns `TimeoutError` into a retry input the policy must classify; after `retry` it bounds the whole operation ([Where the timeout sits relative to retry](../deep-dives/failure-retry-fallback-and-interruption#where-the-timeout-sits-relative-to-retry)).

Transport-specific retries have their own traps: `HttpClient.retryTransient` replays a `POST` as readily as a `GET` ([HttpClient](../interfaces/http-client#retries-time-budgets-and-cancellation)), a failed RPC call has an unknown outcome ([RPC](../interfaces/rpc#retried-mutations-need-a-ledger)), and a model call must not be retried once output or a side effect exists ([AiError](../systems/ai-language-models#classifying-a-failure-before-retrying)).

Official guide: [Retrying](https://effect.website/docs/v4/error-management/retrying).

## Schema Type and Encoded mismatch

For a Schema `S`, `S["Encoded"]` is the boundary representation and `S["Type"]` is the domain value after decoding. A transformation makes the distinction visible—`Schema.NumberFromString` is encoded as a string and decoded as a number.

**Contextual fragment — decode inbound, encode outbound.**

```ts
const EmployeeId = Schema.NumberFromString

const id: Effect.Effect<number, Schema.SchemaError> =
  Schema.decodeUnknownEffect(EmployeeId)("42")

const encoded: Effect.Effect<string, Schema.SchemaError> =
  Schema.encodeEffect(EmployeeId)(42)
```

HttpApi decodes request params/query/payload before the handler and encodes handler successes/errors for the response. `SqlSchema` encodes its request before `execute` and decodes unknown driver rows afterward. Do not decode a value again merely because it crossed an internal function boundary.

Use `Schema.Unknown` only when the domain genuinely accepts arbitrary data. For numbers from untrusted input, choose the real domain: `Schema.Finite`, `Schema.Int`, `Schema.Natural`, or checks such as `Schema.isBetween`. `Schema.Number` accepts JavaScript `NaN` and infinities; it is not a default “safe JSON number” validator.

Three boundary mistakes compile cleanly and fail only at run time:

- **The excess-property policy was never chosen.** The default `onExcessProperty: "ignore"` strips undeclared keys, so `{ id, admin: true }` decodes successfully. That is right for a tolerant reader and wrong for a config file, a signed payload, or a PATCH body; decide per boundary and test it ([Parse options are boundary policy](../data/schema#14-parse-options-are-boundary-policy)).
- **A synchronous decoder inside `Effect.sync`.** `Effect.sync(() => Schema.decodeUnknownSync(S)(input))` has error type `never`, so bad input is a defect that no `catchTag("SchemaError")` can see; use `Schema.decodeUnknownEffect(S)(input)`. Decoding and then `orElseSucceed(default)` hides malformed input behind a plausible value.
- **Absence, `undefined`, and `null` were treated as one state.** `Schema.optionalKey` rejects an explicit `undefined`, `withConstructorDefault` never applies while decoding, and `Schema.Option(S)` is not a wire codec ([Optional fields, null, and Option](../data/schema#15-optional-fields-null-and-option)).

Official guide: [Introduction to Effect Schema](https://effect.website/docs/v4/schema/introduction).

## Missing platform Layer

Effect separates capabilities from host implementations. Importing `FileSystem`, `Path`, `HttpClient`, or server interfaces gives types and operations, not a Node/Bun/Deno/browser implementation.

Typical outer-edge choices include:

| Requirement | Example implementation Layer |
| --- | --- |
| outbound `HttpClient` | `FetchHttpClient.layer`, `NodeHttpClient.layerUndici` / `layerNodeHttp`, or the host equivalent |
| `FileSystem` | `NodeFileSystem.layer`, Bun/Deno equivalent, or `FileSystem.layerNoop` in a narrow test |
| `Path` | `Path.layer` |
| Node HTTP server | `NodeHttpServer.layer(createServer, options)` |
| terminal/worker/platform services | the corresponding `@effect/platform-*` Layer |

Keep platform imports at composition roots. Domain services should depend on the capability interface, so tests can provide deterministic Layers without importing Node globals. The host decides more than the package: who owns the runtime, what cancels work, and whether cleanup is awaited differ between a process, a Web handler, a foreign framework callback, a browser page, and a test ([Choosing a host](../interfaces/platform-runtime-hosts#choosing-a-host)). Quarantine platform and `effect/unstable/*` imports behind an app-owned capability so a release that reshapes one becomes a one-file change ([Keep platform and unstable imports behind a capability](../interfaces/platform-runtime-hosts#keep-platform-and-unstable-imports-behind-a-capability)).

## Incompatible unstable package versions

All `effect` and `@effect/*` packages in this handbook target `4.0.0`. Unstable packages share internal symbols, Schema types, Context tags, and peer dependencies; mixing release lines can produce huge structural errors or values that look identical but are not compatible.

Inspect the installed graph rather than only `package.json`:

**Runnable diagnostic command.**

```sh
pnpm list --depth Infinity --json
```

Pin exact versions—no caret or tilde—for `effect` and every `@effect/*` runtime package, update them together, and install with the committed lockfile. Tool-only packages can have separately documented version lines, but their Effect peer must still resolve coherently. Install by exact version ([Getting Started](../foundations/getting-started#install-effect-4)).

Mixed versions fail at run time as well as in the type checker. The internal type-id and service-key strings follow module paths (for example `"~effect/Option"` and `"effect/http-api/..."`), so a guard or a `Context` lookup from one copy of `effect` does not recognize values made by another copy or by a release that spelled the path differently.

**Version skew between processes is a wire problem, not a type problem.** `SchemaBinary` is the binary format for RPC, the default cluster runner transport, and EventLog journals and remote messages, and its bytes depend on the schemas and the codec version on both ends. Upgrade both peers of a binary link together, keep old journals readable by the release that wrote them until they are migrated, and rehearse mixed-version rollouts in staging; the per-package `CHANGELOG.md` files call out changes that alter bytes on the wire or on disk.

## Generated-code anti-pattern index

This is the list to check generated or pasted code against. Each row names the shape to search for, why it is wrong on `4.0.0`, the preferred shape, and the section that owns the explanation. For a reviewer's yes/no version of the same material, use the [Review Checklists](../reference/review-checklists).

### Anti-patterns: construction and running

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
| `Effect.map(() => someEffect)`; an Effect built in a callback and discarded | Produces a nested or dropped Effect that never runs. | `Effect.flatMap`, `Effect.andThen`, or `yield*`. | [“My Effect never ran”](#my-effect-never-ran) |
| Point-free callbacks: `Effect.forEach(ids, loadBand)`, `Effect.map(f)` with an overloaded `f`, `flow(...)` | `forEach` calls `f(element, index)`, so an optional second parameter silently receives the index; overloads and generics can be erased. | Write the lambda: `(id) => loadBand(id)`. | Official guide: [Guidelines](https://effect.website/docs/v4/code-style/guidelines) |
| `Effect.if`, `Effect.unless`, `Effect.whenEffect`, `Effect.loop`, `Effect.iterate`, `Effect.zipLeft`, `Effect.zipRight` | Not exported in `4.0.0`. | Plain `if` / `for` in `Effect.gen`; `Effect.when(conditionEffect)`; `Effect.andThen` / `Effect.tap`. | [Branching and looping](../foundations/core-runtime-execution#9-branching-and-looping) |
| `Date.now()`, `new Date()`, `Math.random()` in domain work | Bypasses Clock/Random services and deterministic tests; direct workflow use also breaks replay determinism. | Effect Clock/DateTime/Random APIs; TestClock and seeded services. Put nondeterminism in a Workflow Activity. | [Clock](../foundations/core-runtime-execution#clock), [Random](../concurrency/scheduling-time#random) |
| `process.exit()` in application code | Skips finalizers and the drain. | Let the platform `runMain` translate the `Exit` into an exit code. | [Signals, exit codes, and the time budget](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#signals-exit-codes-and-the-time-budget) |

### Anti-patterns: errors and recovery

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| `Effect.catch(() => fallback)` everywhere | Erases domain distinctions and often hides operational failures. | Recover by tag/reason at the layer that owns the policy; preserve unexpected failures. | [Selective recovery beyond one tag](../foundations/errors-option-result#selective-recovery-beyond-one-tag) |
| Retrying every failure forever | Retries permanent failures and amplifies outages. | Typed retryable errors, `Schedule.while`, jitter, and hard time/attempt bounds. | [Retry policy checklist](../concurrency/scheduling-time#retry-policy-checklist) |
| Retrying or defaulting a defect | Hides a bug behind a plausible value. | Let it fail; report it at a process or request boundary. | [The three failure buckets](../foundations/errors-option-result#the-three-failure-buckets) |
| `Effect.orDie` to tidy an error union; `Effect.die` on an expected failure | Callers lose a condition they could act on, and a defect recorded beside it is replaced. | Keep it typed; translate with `Effect.mapError`; declare it on the endpoint. | [Recovering from a mixed Cause](../foundations/core-runtime-execution#recovering-from-a-mixed-cause) |
| `Effect.catchCause(() => Effect.void)`, `Effect.ignoreCause` in domain code | Swallows defects and interruption; can block shutdown. | A guarded `catchCause` that re-fails, or `catchDefect` that re-dies the unknown. | [Typed failure versus defect and interruption](#typed-failure-versus-defect-and-interruption) |
| Translating interruption into a domain error, retrying it, or logging it as a fault | Interruption is cancellation, not failure. | Let it propagate; finalizers do the work. | [The three failure buckets](../foundations/errors-option-result#the-three-failure-buckets) |
| `Option.getOrThrow`, or re-throwing `result.failure`, in domain code | Reintroduces the hidden branch the type removed. | `Effect.fromOption` / `Effect.fromResult`, or collapse at a real boundary. | [Fallbacks and boundary exits](../foundations/errors-option-result#fallbacks-and-boundary-exits) |
| `switch` with `default`, or `Match.orElse`, in an error-policy match | Tomorrow's variant is silently assigned to today's fallback. | `Match.exhaustive` / `Match.tagsExhaustive`. | [Classifying an error union](../foundations/errors-option-result#classifying-an-error-union) |
| Folding (`Effect.match`) or catching everything in a low-level function | Steals policy from every caller. | Fold once, at the terminal boundary that owns the response. | [Folding both channels at a boundary](../foundations/errors-option-result#folding-both-channels-at-a-boundary) |
| Mapping a timeout, pool exhaustion, or driver error to `NotFound` / `404` | Clients act on a lie. | Only a query that succeeded and returned nothing is "not found". | [Designing the error model](../foundations/errors-option-result#designing-the-error-model) |
| A `throw` inside a service method or a test fake | It becomes a defect; tests then exercise a different channel than production. | `Effect.fail(new DomainError(...))`. | [Designing a service contract](../foundations/services-context-layers#designing-a-service-contract) |
| A correct negative answer modeled as an error | Retry schedules and alerts treat a right answer as a fault. | Return it in `A`. | [Designing the error model](../foundations/errors-option-result#designing-the-error-model) |

### Anti-patterns: services, Layers, and configuration

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
| Casting `R` away, or `as any` on a Layer | The missing service fails at run time instead. | Find the tag, provide its Layer at the right level. | [A service is still present in R](#a-service-is-still-present-in-r) |
| `process.env` reads in services | A second, untyped definition of "valid deployment". | One `Config` program, decoded during a Layer build. | [Designing the startup contract](../foundations/configuration-secrets#designing-the-startup-contract) |
| `Config.orElse(() => Config.succeed(d))` as a default; a logical-or fallback | Masks a malformed value; treats `0` and `false` as absent. | `Config.withDefault(d)`. | [Absence is not malformed input](../foundations/configuration-secrets#absence-is-not-malformed-input) |
| Choosing live or fake infrastructure from whether a token is set | A missing secret silently selects the fake in production. | An explicit mode: `Config.Literals(["live", "sandbox"], "MODE")`. | [Deciding required, optional, and defaulted](../foundations/configuration-secrets#deciding-required-optional-and-defaulted) |
| `Layer.mergeAll(Service.layer, ConfigLive)` | The provider override does not reach its sibling. | `Service.layer.pipe(Layer.provide(ConfigLive))`, or provide it outermost. | [Precedence and composition](../foundations/configuration-secrets#precedence-and-composition) |
| Node platform imports (`@effect/platform-node`, `node:*`) in domain code or in a browser or edge bundle | The module now knows which host it runs in, and the bundle breaks elsewhere. | Depend on the capability; import the platform package in one module at the edge. | [Keep platform and unstable imports behind a capability](../interfaces/platform-runtime-hosts#keep-platform-and-unstable-imports-behind-a-capability) |
| `Redacted.value` early, then passing the string around | Nothing downstream can mask it again. | Keep it `Redacted` until the single call that needs the bytes. | [Redacted](../foundations/configuration-secrets#redacted) |

### Anti-patterns: resources, fibers, and state

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| Manual acquire/use without a finalizer | Failure or interruption leaks the handle. | `Effect.acquireRelease`, `acquireUseRelease`, a scoped Layer, Pool, ScopedCache, or another owner-aware primitive. | [Interruption & resource safety](../foundations/core-runtime-execution#6-interruption-resource-safety) |
| Cleanup attached with `Effect.tap` / `andThen`, or written after `yield*` | Runs on success only; misses failure and interruption. | `Effect.ensuring`, `Effect.onExit`, `Effect.acquireRelease`. | [Success-only cleanup](#success-only-cleanup) |
| One `acquireRelease` that opens two handles | A failure on the second leaks the first. | One bracket per resource. | [One bracket per resource](../deep-dives/anatomy-of-a-real-effect-application#one-bracket-per-resource) |
| An unbounded or fallible finalizer | Finalizers run uninterruptibly: an unbounded finalizer is an unbounded shutdown. | Bound it, then apply a stated failure policy. | [When cleanup can fail](../foundations/core-runtime-execution#10-when-cleanup-can-fail) |
| `Effect.forkDetach` without a named owner and stop path | Nothing closes, bounds, or observes the fiber. | `forkChild`, `forkScoped`, `forkIn`, or a `FiberSet` owned by a Layer. | [Choosing a fork by its owner](../foundations/core-runtime-execution#choosing-a-fork-by-its-owner) |
| An interior `Effect.runFork` or `forkDetach` "so the write survives the request" | Shutdown cannot interrupt it, and it keeps using a pool after release. | Transfer the work to a Layer-owned, bounded supervisor. | [Bridge into a host that is not Effect](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#bridge-into-a-host-that-is-not-effect) |
| `Ref.get` then `Ref.set` | Two transitions; a suspension between them loses updates. | One `Ref.update` / `Ref.modify`; `SynchronizedRef` when the transition is effectful. | [One transition, one call](../concurrency/state-mutable-references#one-transition-one-call) |
| Mutating the object stored in a `Ref` | Bypasses the atomic transition and changes values other fibers already read. | Install a new immutable value in one `update`. | [One transition, one call](../concurrency/state-mutable-references#one-transition-one-call) |
| Reading a `MutableRef`, suspending, then writing from the stale value | Another fiber can update it during the suspension; replacing it with separate `Ref.get` / `Ref.set` calls has the same race. | One synchronous `MutableRef.update`, one `Ref.update`, or `SynchronizedRef` for an effectful transition. | [MutableRef](../concurrency/state-mutable-references#mutableref) |
| Non-idempotent I/O inside `Effect.tx` | A transaction body can rerun on conflict. | Keep external effects outside the transaction. | [The mental model](../concurrency/software-transactional-memory#the-mental-model) |
| Reusing a completed `Deferred` for the next generation | The next generation is "ready" instantly. | A fresh `Deferred` per generation; complete it on every outcome. | [Deferred](../foundations/core-runtime-execution#deferred) |
| `Queue.shutdown` as end-of-input | Discards the buffer and interrupts parked fibers. | `Queue.end`, then join the workers. | [Queue lifecycle](../concurrency/concurrency-coordination#queue-lifecycle-who-ends-it-and-what-a-failure-does) |
| Readiness published before acquisition, or left true while draining | Traffic is routed to a process that cannot serve. | Readiness is a Layer acquired last and released first. | [Liveness, readiness, and draining](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#liveness-readiness-and-draining-are-different-questions) |

### Anti-patterns: concurrency, streams, and caching

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

### Anti-patterns: Schema and boundaries

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| `Schema.Number` for every external number | Accepts `NaN` and infinities and says nothing about integer/range constraints. | `Schema.Finite`, `Schema.Int`, `Schema.Natural`, BigDecimal/BigInt codecs, and explicit checks. | [Refinements](../data/schema#5-refinements-check-and-refine) |
| `JSON.parse(raw) as Model`, `raw as EmployeeId` | A cast validates nothing. | Decode once at ingress; obtain brands through the decoder. | [Branded schemas](../data/schema#7-branded-schemas) |
| `Effect.sync(() => Schema.decodeUnknownSync(S)(x))` | Bad input becomes a defect. | `Schema.decodeUnknownEffect(S)(x)`. | [Decoding and encoding — pick your result style](../data/schema#1-decoding-and-encoding-pick-your-result-style) |
| Decode, then `Effect.orElseSucceed(() => default)` | Malformed input is hidden behind a plausible value. | A declared decoding default for *absence*; fail on malformed input. | [Construction and deliberate fallbacks](../data/schema#13-construction-and-deliberate-fallbacks) |
| `withConstructorDefault` expected to fill a missing key while decoding | It applies to `make` / `new` only. | `withDecodingDefault` / `withDecodingDefaultKey`. | [Default values](../data/schema#8-default-values) |
| Never choosing `onExcessProperty` | Undeclared keys are stripped silently. | Decide per boundary and test the policy. | [Parse options are boundary policy](../data/schema#14-parse-options-are-boundary-policy) |
| Decoding the same value again at internal function boundaries | Cost with no new information, and a second place for drift. | Decode once at ingress; pass the `Type`. | [Schema Type and Encoded mismatch](#schema-type-and-encoded-mismatch) |
| `Schema.RedactedFromValue` without `disallowEncode` on a model that is also encoded | Every derived codec writes the secret back in clear text. | Set the option, or keep secrets out of encodable models. | [Secrets that arrive through a schema](../foundations/configuration-secrets#secrets-that-arrive-through-a-schema) |
| The endpoint's `success` schema is the table row | A persistence detail becomes a published contract. | Separate DTOs; map in the use case or repository. | [Handlers are lazy adapters](../interfaces/http-api#handlers-are-lazy-adapters) |

### Anti-patterns: HTTP, RPC, and SQL

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

### Anti-patterns: observability and tests

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| Metric attributes with unbounded cardinality: employee, request, or session ids, raw URLs, error messages | Every distinct combination is a stored, billed time series. | Bounded vocabularies; detail in logs and span attributes. | [Cardinality](../operations/observability#cardinality-names-and-attribute-sets-are-bounded) |
| Instance data in a span name: `hris.fetchCompBand E-1042` | Backends group and index by name. | A stable operation name; ids in `attributes`. | [Cardinality](../operations/observability#cardinality-names-and-attribute-sets-are-bounded) |
| Logging whole objects: config, headers, bodies, rows, prompts | Secrets and personal data reach a production store. | Build each record from named, allow-listed fields. | [Privacy](../operations/observability#privacy-allow-list-fields-before-they-are-buffered) |
| `Logger.layer([Logger.consoleJson])` as a drop-in format swap | Replaces the whole logger set; logs stop becoming span events. | Add `Logger.tracerLogger`, or `{ mergeWithExisting: true }`. | [Installing and swapping loggers](../operations/observability#installing-and-swapping-loggers) |
| `Layer.merge(App, ObservabilityLayer)`; an exporter per request or inside a library | The application is built without the telemetry references; exporters compete. | One exporter graph at the root, provided beneath the application. | [Layer order and shutdown](../operations/observability#layer-order-and-shutdown) |
| The collector in a readiness check; SLIs computed from sampled spans | A telemetry outage becomes an outage; ratios are wrong. | Readiness from serving dependencies; SLIs from unsampled metrics. | [Telemetry is not readiness, liveness, or an audit log](../operations/observability#telemetry-is-not-readiness-liveness-or-an-audit-log) |
| An Effect returned from plain `it(...)` | Vitest never runs it: a green test that proves nothing. | `it.effect`. | [When green means nothing](../deep-dives/testing-an-effect-application#when-green-means-nothing) |
| Tests that assert elapsed milliseconds or pretty-printed failure strings | Flaky, and brittle across releases. | `TestClock` timelines; structural assertions on `Exit`, `_tag`, and fields. | [Assert typed failures as data](../deep-dives/testing-an-effect-application#assert-typed-failures-as-data) |
| `Effect.yieldNow` sprinkled to order fibers | Turn counting passes until something adds a turn. | A handshake per phase. | [Synchronize on phases, not on turns](../deep-dives/testing-an-effect-application#synchronize-on-phases-not-on-turns) |
| Fakes that never fail; socket, signal, or filesystem behavior asserted only against a fake | The failure path and the adapter are never exercised. | Fakes honor the contract; adapters get a real fixture. | [In-memory test runtimes shipped with Effect](../tooling/testing-dev-tooling#in-memory-test-runtimes-shipped-with-effect) |
| An identity `withTransaction` fake | Commits nothing and rolls back nothing, so atomicity is untested. | A repository contract suite against a real database. | [Verification levels](../interfaces/sql#verification-levels) |
| Using `declare const` in a supposedly runnable example | It type-checks only because the actual dependency is missing. | Label it contextual, or supply a complete fixture/runnable program. | — |

### Anti-patterns: durable systems and AI

| Anti-pattern | Why it is wrong | Preferred shape | Details |
| --- | --- | --- | --- |
| Renaming an `Activity`, workflow tag, or durable primitive while runs are in flight | The name is the journal key: replay re-executes or orphans. | Freeze persisted names; add a `V2` identity. | [Replay, versioning, and rollout](../systems/workflows-durable-execution#replay-versioning-and-rollout) |
| Reading a feature flag or ambient config in a workflow body | The replay can take a different path. | Capture it in an `Activity` or the payload. | [Replay, versioning, and rollout](../systems/workflows-durable-execution#replay-versioning-and-rollout) |
| An idempotency key generated per attempt | It deduplicates nothing. | Derive it from the intent or item id. | [Failure windows and honest guarantees](../tooling/persistence#failure-windows-and-honest-guarantees) |
| Treating a lock or lease as a fence | A stalled owner keeps running after losing the claim. | The sink rejects stale owners. | [A lease is not a fence](../deep-dives/durability-and-distribution-ladder#a-lease-is-not-a-fence) |
| Taking actor, tenant, or approval from model output | Model output is untrusted input. | Trusted request context only. | [Production rules for model calls](../systems/ai-language-models#production-rules-for-model-calls) |
| An agent loop with no turn limit, or tool handlers with default concurrency | Unbounded cost and load. | A bounded loop with a typed exhaustion error; a numeric `concurrency`. | [Bound every agentic loop](../deep-dives/building-a-production-ai-capability#bound-every-agentic-loop) |

## What to capture in a bug report

Record the exact package versions and lockfile, the inferred `Effect<A, E, R>`, the complete pretty-printed Cause/Exit, whether the program was interrupted, the owning Scope, and a minimal reproducer using the same platform Layer. For time/concurrency bugs, record the queue capacity/strategy, concurrency bound, fiber ownership, schedule, and whether TestClock or the live clock was installed.

Then consult [Core Runtime & Execution](../foundations/core-runtime-execution), [Services, Context & Layers](../foundations/services-context-layers), [Errors, Option & Result](../foundations/errors-option-result), [Concurrency & Coordination](../concurrency/concurrency-coordination), [Schema](../data/schema), and [Testing & Dev Tooling](../tooling/testing-dev-tooling) for the full API surface. To choose between plausible primitives, use [Choosing Effect Primitives](../reference/choosing-effect-primitives); to review a change before it ships, use the [Review Checklists](../reference/review-checklists).
