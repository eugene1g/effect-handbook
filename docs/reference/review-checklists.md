# Review Checklists

Use this page three ways: in a **design review**, read a section before code exists and treat every "not decided yet" as an open design question; in a **code review**, answer each question from the diff alone; as a **coding-agent self-check**, run the relevant sections over generated code before proposing it. Every question is phrased so that **yes** is the safe answer — a "no" or "cannot tell from the diff" is a finding, and the link leads to the section that owns the rule and its evidence.

The items describe Effect `4.0.0-rc.115`. They are deliberately short; the owning pages carry the reasoning, the probed behavior, and the examples. For symptoms rather than rules, start from [Troubleshooting & Anti-Patterns](../troubleshooting/troubleshooting-and-anti-patterns); for choosing between primitives, from [Choosing Effect Primitives](choosing-effect-primitives).

## Effect construction and running

- Is every constructor chosen by how the wrapped code fails — `Effect.try` / `Effect.tryPromise` for code that can throw or reject, `Effect.sync` / `Effect.promise` only for code that cannot? [Creating effects](../foundations/core-runtime-execution#1-creating-effects)
- Is every argument to `Effect.succeed` and `Effect.fail` a value that is safe to compute while the program is being built — no clock reads, counters, or side effects? [Creating effects](../foundations/core-runtime-execution#1-creating-effects)
- Does every `Effect.tryPromise` / `Effect.promise` thunk declare the `signal` parameter and pass it to the foreign API? [Cancellable adapters for promises and callbacks](../foundations/core-runtime-execution#8-cancellable-adapters-for-promises-and-callbacks)
- Does each adapter's `catch` recognize the failures its contract allows and turn everything else into a defect, instead of mapping every rejection to one retryable error? [Cancellable adapters for promises and callbacks](../foundations/core-runtime-execution#8-cancellable-adapters-for-promises-and-callbacks)
- Is the diff free of runners (`runPromise`, `runSync`, `runFork`, a second `ManagedRuntime`) inside services, handlers, and domain functions? [Running effects at an owned edge](../foundations/core-runtime-execution#11-running-effects-at-an-owned-edge)
- Where a host can represent cancellation, does the edge use `runPromiseExit` (or `runFork`) with `{ signal }` rather than collapsing every outcome into a rejection? [Running effects at an owned edge](../foundations/core-runtime-execution#11-running-effects-at-an-owned-edge)
- Is every Effect that is constructed also returned, yielded, or composed — none built inside a callback and dropped, none nested by `Effect.map`? [“My Effect never ran”](../troubleshooting/troubleshooting-and-anti-patterns#my-effect-never-ran)
- Are callbacks written as lambdas rather than functions passed by name to `Effect.forEach`, `Effect.map`, and similar operators? [Generated-code anti-pattern index](../troubleshooting/troubleshooting-and-anti-patterns#generated-code-anti-pattern-index)
- Does branching and looping use ordinary `if` / `for` inside `Effect.gen` (and `Effect.when` with an `Effect<boolean>`), with none of the removed `Effect.if` / `unless` / `loop` / `zipRight` family? [Branching and looping](../foundations/core-runtime-execution#9-branching-and-looping)
- Do effect-returning functions use `Effect.fn("name")`, so they carry a span and a readable stack? [Sequencing with gen & fn](../foundations/core-runtime-execution#2-sequencing-with-gen-fn)
- Is pure, synchronous, dependency-free logic left as plain functions instead of being wrapped in Effect? [Decide what to leave out](../deep-dives/adopting-effect-in-an-existing-codebase#decide-what-to-leave-out)

## Errors and recovery

- Is each new unpleasant outcome placed deliberately: ordinary negative answers in `A`, caller-actionable conditions in `E`, broken invariants as defects, and interruption left alone? [Designing the error model](../foundations/errors-option-result#designing-the-error-model)
- Does every error variant carry the facts its policy needs as fields (`retryable`, ids, limits) rather than a message to parse? [Designing the error model](../foundations/errors-option-result#designing-the-error-model)
- Are missing, conflict, unavailable, timeout, corrupt, and forbidden kept distinct wherever their policies differ — and is "not found" produced only by a query that succeeded and returned nothing? [Designing the error model](../foundations/errors-option-result#designing-the-error-model)
- Does each `catch*` use the narrowest selector that expresses the policy, leaving the undecided variants in `E`? [Selective recovery beyond one tag](../foundations/errors-option-result#selective-recovery-beyond-one-tag)
- Is every handler clearly one of recover, translate, compensate, or observe — with no catch that exists only to empty `E`? [Recover at the narrowest owner](../deep-dives/failure-retry-fallback-and-interruption#recover-at-the-narrowest-owner)
- Does folding (`Effect.match`, `matchEffect`) happen only at the terminal boundary that owns the response? [Folding both channels at a boundary](../foundations/errors-option-result#folding-both-channels-at-a-boundary)
- Is every whole-union classification closed with `Match.exhaustive` or `Match.tagsExhaustive`, with no `default` branch or unexplained `Match.orElse`? [Classifying an error union](../foundations/errors-option-result#classifying-an-error-union)
- Where a finalizer or sibling can add a defect next to a typed failure, does recovery go through a guarded `Effect.catchCause` so the other reasons survive? [Recovering from a mixed Cause](../foundations/core-runtime-execution#recovering-from-a-mixed-cause)
- Is the diff free of `Effect.orDie`, `Effect.ignoreCause`, and `catchCause(() => Effect.void)` used only to tidy types? [Fallback values and ignoring failures](../foundations/errors-option-result#fallback-values-and-ignoring-failures)
- Is every retry classified, bounded in attempts and elapsed time, paced with backoff, and wrapped around the smallest idempotent operation? [Retry policy checklist](../concurrency/scheduling-time#retry-policy-checklist)
- Is it clear whether each timeout bounds one attempt or the whole retried operation? [Where the timeout sits relative to retry](../deep-dives/failure-retry-fallback-and-interruption#where-the-timeout-sits-relative-to-retry)
- Do public error values expose only stable tags and safe identifiers — no `cause`, driver message, SQL text, or `Redacted`? [Designing the error model](../foundations/errors-option-result#designing-the-error-model)
- When several problems must be reported together, are they accumulated as data (`Effect.validate`, `Effect.partition`, `mode: "result"`)? [Accumulating errors instead of failing fast](../foundations/errors-option-result#accumulating-errors-instead-of-failing-fast)

## Services and Layers

- Is each service named for a business capability, with domain-verb methods that return Effects and never throw? [Designing a service contract](../foundations/services-context-layers#designing-a-service-contract)
- Do all public service methods have `R = never`, with construction dependencies captured in the Layer? [Designing a service contract](../foundations/services-context-layers#designing-a-service-contract)
- Is the service shape free of implementation details: no SQL client, transaction handle, logger, or concrete class in parameters or fields? [Designing a service contract](../foundations/services-context-layers#designing-a-service-contract)
- Does a new service have a substitution reason (test, tenant, vendor, lifetime) rather than existing to make one helper mockable? [Designing a service contract](../foundations/services-context-layers#designing-a-service-contract)
- Are live implementations provided only at application or module edges, and fakes only at test edges? [Providing one value or building a graph](../foundations/services-context-layers#providing-one-value-or-building-a-graph)
- Is the application graph provided once — one enclosing `Effect.provide`, `Layer.launch`, or `ManagedRuntime` — rather than per request or per call? [What is shared, and what is rebuilt](../foundations/services-context-layers#what-is-shared-and-what-is-rebuilt)
- Is every Layer that must be shared a single named value, not an inline expression or a function called twice? [What is shared, and what is rebuilt](../foundations/services-context-layers#what-is-shared-and-what-is-rebuilt)
- Does every `{ local: true }` and `Layer.fresh` have a stated isolation reason? [What is shared, and what is rebuilt](../foundations/services-context-layers#what-is-shared-and-what-is-rebuilt)
- Does anything that needs teardown use `Layer.effect` with `Effect.acquireRelease`, not `Layer.succeed`? [Resourceful services](../foundations/services-context-layers#resourceful-services)
- Does a Layer that must see another's output receive it through `Layer.provide` / `provideMerge` rather than sitting beside it in `Layer.merge`? [Reading and composing the graph](../foundations/services-context-layers#reading-and-composing-the-graph)
- Do test Layers honor the production contract, including typed failures, and does each test prove that the fake — not a live default — answered? [Test layers and substitution](../foundations/services-context-layers#test-layers-and-substitution)
- Is there exactly one composition root per executable, and does it install configuration and observability before dependents acquire anything? [What the composition root owns](../deep-dives/anatomy-of-a-real-effect-application#what-the-composition-root-owns)

## Configuration and secrets

- Is there one `Config` program that defines a valid deployment, with no `process.env` reads or second hand-written parser elsewhere? [Designing the startup contract](../foundations/configuration-secrets#designing-the-startup-contract)
- Is each setting explicitly required, optional, or defaulted — and do credentials, bind addresses, CORS origins, and destructive modes have no silent default? [Deciding required, optional, and defaulted](../foundations/configuration-secrets#deciding-required-optional-and-defaulted)
- Do defaults use `Config.withDefault` or `Config.option` (absence only), with `Config.orElse` reserved for an alternative source? [Absence is not malformed input](../foundations/configuration-secrets#absence-is-not-malformed-input)
- Are numeric bounds, duration syntax, and URL shape validated in the `Config` itself, not after startup? [Validating more than syntax](../foundations/configuration-secrets#validating-more-than-syntax)
- Is live-versus-fake infrastructure selected by an explicit mode rather than by whether a token is present? [Deciding required, optional, and defaulted](../foundations/configuration-secrets#deciding-required-optional-and-defaulted)
- Is source precedence written down next to the provider composition, and is key mapping done in one place? [Precedence and composition](../foundations/configuration-secrets#precedence-and-composition)
- Is a custom `ConfigProvider` Layer provided *beneath* the Layers that read it, not merged beside them? [Precedence and composition](../foundations/configuration-secrets#precedence-and-composition)
- Does a configuration failure cause zero resource acquisitions — do pool, listener, and exporter Layers depend on the typed config service? [Install configuration before anything that depends on it](../foundations/configuration-secrets#install-configuration-before-anything-that-depends-on-it)
- Are secrets read with `Config.Redacted`, kept wrapped until the single call that needs the bytes, and never logged after `Redacted.value`? [Redacted](../foundations/configuration-secrets#redacted)
- Do schemas that decode a secret set `disallowEncode` / `disallowJsonEncode` wherever their encoded side leaves the process? [Secrets that arrive through a schema](../foundations/configuration-secrets#secrets-that-arrive-through-a-schema)
- Do config tests use an in-memory provider and cover absent, malformed, and boundary values without mutating `process.env`? [Testing the contract](../foundations/configuration-secrets#testing-the-contract)

## Resources, scopes, and fibers

- Can the reviewer name, for every new resource, fiber, and runtime, who closes it, what bounds it, and what runs when it loses? [Three questions for anything that runs](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#three-questions-for-anything-that-runs)
- Does every acquired handle have its own `acquireRelease`, registered in the scope that matches its lifetime? [One bracket per resource](../deep-dives/anatomy-of-a-real-effect-application#one-bracket-per-resource)
- Is every `Scope` in a signature discharged by a deliberate choice (`Effect.scoped`, a Layer, a held scope), never by accident at the entrypoint? [`Scope` left in `R` means nobody owns it yet](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#scope-left-in-r-means-nobody-owns-it-yet)
- Do scoped values stay inside their scope — nothing returned from `Effect.scoped` that is still borrowed? [Scope closed or resource leaked](../troubleshooting/troubleshooting-and-anti-patterns#scope-closed-or-resource-leaked)
- Is all cleanup attached structurally (`ensuring`, `onExit`, `acquireRelease`), so it also runs on failure and interruption? [Success-only cleanup](../troubleshooting/troubleshooting-and-anti-patterns#success-only-cleanup)
- Does every finalizer have a time bound and a stated policy for its own failure? [When cleanup can fail](../foundations/core-runtime-execution#10-when-cleanup-can-fail)
- Is each fork chosen by its owner — `forkChild`, `forkScoped`, `forkIn`, or a `FiberSet` / `FiberMap` — and does every `forkDetach` name who stops it? [Choosing a fork by its owner](../foundations/core-runtime-execution#choosing-a-fork-by-its-owner)
- Is work that must outlive its request handed to a Layer-owned, bounded supervisor rather than detached? [Bridge into a host that is not Effect](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#bridge-into-a-host-that-is-not-effect)
- Where a forked fiber must be listening before the parent continues, is that guaranteed by `startImmediately` or a handshake rather than by `yieldNow`? [When a forked fiber starts](../foundations/core-runtime-execution#when-a-forked-fiber-starts)
- Does every `Deferred` and `Latch` have a completion path on success, failure, and interruption, and a fresh instance per lifecycle generation? [Deferred](../foundations/core-runtime-execution#deferred)
- Does a public cancel operation say whether it requests cancellation or awaits cleanup? [Requesting cancellation versus awaiting cleanup](../foundations/core-runtime-execution#requesting-cancellation-versus-awaiting-cleanup)

## Concurrency, queues, and streams

- Is the execution policy written down before the code: bound, order, failure mode, and shutdown behavior? [Write the execution policy first](../deep-dives/structured-concurrency-through-a-bounded-worker#write-the-execution-policy-first)
- Does every traversal over external input have a numeric `concurrency`, and is a shared limit a `Semaphore` or `Pool` owned by one Layer? [Put shared limits around the actual bottleneck](../deep-dives/structured-concurrency-through-a-bounded-worker#put-shared-limits-around-the-actual-bottleneck)
- Does every queue, PubSub, and buffer have a capacity and an overflow strategy chosen as a policy? [Queue](../concurrency/concurrency-coordination#queue)
- Wherever `dropping`, `sliding`, or `offerUnsafe` is used, is the loss counted and documented? [Make loss observable](../concurrency/concurrency-coordination#make-loss-observable)
- Is it decided who ends each queue, and does a producer failure reach its consumers (`Queue.end`, `Queue.fail`, `Queue.into`) — with `Queue.shutdown` reserved for abandoning work? [Queue lifecycle](../concurrency/concurrency-coordination#queue-lifecycle-who-ends-it-and-what-a-failure-does)
- Do producers accept `Queue.Enqueue` and consumers `Queue.Dequeue`, so only wiring code sees the full queue? [Put queue roles in function signatures](../concurrency/concurrency-coordination#put-queue-roles-in-function-signatures)
- Do batch consumers avoid relying on `takeN` / `takeBetween` with `min > 1` on a queue that can end? [Consuming: the consumer picks its waiting policy](../concurrency/concurrency-coordination#consuming-the-consumer-picks-its-waiting-policy)
- Was the delivery semantics — one taker or every subscriber, late joiners, nobody listening — chosen explicitly? [Delivery semantics: Queue or PubSub](../concurrency/concurrency-coordination#delivery-semantics-queue-or-pubsub)
- Is every shared-state transition one `Ref.update` / `modify` call over an immutable value, with `SynchronizedRef` for effectful transitions and `Effect.tx` for multi-cell atomicity? [One transition, one call](../concurrency/state-mutable-references#one-transition-one-call)
- Is every stream stage bounded, including `Stream.callback` (`bufferSize`), `mapEffect` (`concurrency`), and framing decoders (frame or line limits)? [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides)
- Are resources acquired inside the stream (`Stream.unwrap`, `Stream.scoped`) so they close on early stop as well as completion? [Owning resources inside a stream](../concurrency/streaming-channels#6-owning-resources-inside-a-stream)
- Is `Stream.retry` placed directly after the source it reconnects, upstream of any non-idempotent write, and is silence detected with `timeoutOrElse` rather than `timeout`? [Handling stream failures](../concurrency/streaming-channels#5-handling-stream-failures)
- Is batch size set with `grouped` / `groupedWithin` / `rechunk` rather than inferred from a buffer capacity, and is `runCollect` used only on sources known to be small? [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides)

## Schema boundaries

- Is untrusted input decoded exactly once, at ingress, with no casts (`as Model`, `as EmployeeId`) standing in for a decode? [The boundary pipeline](../deep-dives/schema-from-external-input-to-domain-and-back#the-boundary-pipeline)
- Were the boundary questions answered before the schema was written: who produces the input, what absence means, which keys are allowed, who reads the errors? [Answer eight questions before writing the schema](../deep-dives/schema-from-external-input-to-domain-and-back#answer-eight-questions-before-writing-the-schema)
- Is the excess-property policy chosen per boundary and covered by a test? [Parse options are boundary policy](../data/schema#14-parse-options-are-boundary-policy)
- Is the decode runner chosen by who consumes the failure, with `decodeUnknownEffect` inside Effect code and no synchronous decoder inside `Effect.sync`? [Decoding and encoding — pick your result style](../data/schema#1-decoding-and-encoding-pick-your-result-style)
- Does every optional field state what absent, `undefined`, and `null` mean, using the matching helper? [Optional fields, null, and Option](../data/schema#15-optional-fields-null-and-option)
- Are decoding defaults (`withDecodingDefault*`) and constructor defaults (`withConstructorDefault`) used for the side they actually affect? [Default values](../data/schema#8-default-values)
- Do external numbers use `Schema.Finite`, `Schema.Int`, or explicit checks rather than bare `Schema.Number`? [Refinements](../data/schema#5-refinements-check-and-refine)
- Are transport, domain, and stored-row shapes separate schemas, with transformations that are reversible where data is written back? [Treat stored rows as another encoded form](../deep-dives/schema-from-external-input-to-domain-and-back#treat-stored-rows-as-another-encoded-form)
- Are "malformed" and "does not match" kept as different outcomes, and are issue details kept out of user-facing text? [Keep "malformed" and "does not match" as different outcomes](../deep-dives/schema-from-external-input-to-domain-and-back#keep-malformed-and-does-not-match-as-different-outcomes)
- When JSON Schema or OpenAPI is published, does its excess-property setting match the runtime parser's? [JsonSchema](../data/schema#jsonschema)
- Does a change to a persisted or wire schema keep old encoded values decodable, or introduce a new versioned identity? [Evolve persisted and wire schemas safely](../deep-dives/schema-from-external-input-to-domain-and-back#evolve-persisted-and-wire-schemas-safely)
- Do codec tests use named malformed fixtures as well as generated valid values, and assert the round-trip law that actually holds? [Assert the law that actually holds](../deep-dives/schema-from-external-input-to-domain-and-back#assert-the-law-that-actually-holds)

## HTTP and RPC boundaries

- Does each handler only translate one decoded request into one use-case Effect — no runner, no `SqlClient`, no client construction? [Handlers are lazy adapters](../interfaces/http-api#handlers-are-lazy-adapters)
- Does all request work stay in the request fiber, so a disconnect or shutdown can interrupt it? [Request work stays in the request fiber](../interfaces/http-server#request-work-stays-in-the-request-fiber)
- Is every member of the public error union mapped to a truthful status through an exhaustive matcher, with the implicit `400` declared? [Status mapping is part of the contract](../interfaces/http-api#status-mapping-is-part-of-the-contract)
- Is authentication done in middleware with a narrow decoded principal, and authorization checked per operation against actor, action, tenant, and resource? [Authentication is not authorization](../interfaces/http-api#authentication-is-not-authorization)
- Are body size, multipart limits, CORS origins, redacted headers, proxy trust, and the shutdown window set explicitly? [Edge policy checklist](../interfaces/http-server#edge-policy-checklist)
- Is the listener allocated during Layer acquisition, bound to port `0` in tests, and proven released? [Own the listener](../interfaces/http-server#own-the-listener-acquire-late-bind-port-0-prove-release)
- Does every outbound call have a finite time budget, and are retries limited to replay-safe requests? [Retries, time budgets, and cancellation](../interfaces/http-client#retries-time-budgets-and-cancellation)
- Is the response status checked before the success schema is decoded, and are transport, status, and decode failures kept distinct? [Three failure classes](../interfaces/http-client#three-failure-classes)
- Is every user-supplied URL allow-listed, resolved to a public address, and re-validated on each redirect? [User-controlled destinations](../interfaces/http-client#user-controlled-destinations)
- Is each RPC contract change classified as compatible or not, deployed in the right order, and covered by a version-skew test through a real serializer? [Evolving a contract](../interfaces/rpc#evolving-a-contract)
- Are `RpcServer` `concurrency`, `disableFatalDefects`, `streamBufferSize`, and every `Rpc.fork` chosen deliberately? [Operational defaults](../interfaces/rpc#operational-defaults)
- Do retried RPC or HTTP mutations carry one idempotency key per intent that the server records with the mutation? [Retried mutations need a ledger](../interfaces/rpc#retried-mutations-need-a-ledger)
- Is enforcement done at the server edge, with client middleware treated as a convenience only? [Client middleware attaches; only the server edge enforces](../interfaces/rpc#client-middleware-attaches-only-the-server-edge-enforces)
- Do both peers of a framed link agree on serialization, and is a frame-size limit set for untrusted peers? [RpcSerialization](../interfaces/rpc#rpcserialization)

## SQL and persistence

- Do dependencies point one way — transport, use case, domain repository, SQL implementation, `SqlClient` — with the transaction boundary owned by the use case? [Where SQL belongs in an application](../interfaces/sql#where-sql-belongs-in-an-application)
- Is every value interpolated through the `sql` tagged template or its helpers, never concatenated into statement text? [The star: parameterized tagged-template queries](../interfaces/sql#the-star-parameterized-tagged-template-queries)
- Is the whole atomic unit inside `withTransaction`, and does every failure leave the body so that recovery happens outside? [Transactions](../interfaces/sql#transactions)
- Are external effects (email, webhook, HTTP export, model call) kept out of the transaction and delivered after commit from an intent row? [External effects after commit (outbox)](../interfaces/sql#external-effects-after-commit-outbox)
- Does each repository expose one stable storage error, check which constraint fired before reporting a conflict, and leave defects alone? [Normalizing errors at a repository boundary](../interfaces/sql#normalizing-errors-at-a-repository-boundary)
- Are rows decoded through a Schema that matches the driver's actual result types? [Upgrading @effect/sql-pg to the native client](../interfaces/sql#upgrading-effect-sql-pg-to-the-native-client)
- Are migrations append-only with increasing ids, compatible with the release still running, and free of long backfills at startup? [Operating migrations](../interfaces/sql#operating-migrations)
- Is the pool sized from the database-wide budget, and is everything that *holds* a connection (transaction, stream, listener) bounded in time? [Pools, reservations, and streaming](../interfaces/sql#pools-reservations-and-streaming)
- Is there a repository contract suite against a real database, rather than an identity `withTransaction` fake? [Verification levels](../interfaces/sql#verification-levels)
- For durable work, is the guarantee stated honestly (at-least-once), with an idempotency key derived from the item and a sink that rejects stale owners? [Failure windows and honest guarantees](../tooling/persistence#failure-windows-and-honest-guarantees)
- Is each external-write outcome classified as failed-before, known-failed, or unknown, with no blind replay of the unknown case? [Classify every outcome of an external write](../deep-dives/durability-and-distribution-ladder#classify-every-outcome-of-an-external-write)
- Are persisted names — workflow tags, activity names, queue and deferred names — frozen while runs are in flight? [Replay, versioning, and rollout](../systems/workflows-durable-execution#replay-versioning-and-rollout)

## Caching and batching

- Was the waste shape measured first, and does the tool match it: one effect, one repeated key, or many keys at once? [Which problem do you have?](../operations/caching-batching#which-problem-do-you-have)
- Are cache keys normalized at ingress and carried as small value classes rather than whole records or raw strings? [Keys are logical values](../operations/caching-batching#keys-are-logical-values)
- Does every cache have a capacity, a TTL, and a separate, deliberately short lifetime for failures? [Failure and freshness policy](../operations/caching-batching#failure-and-freshness-policy)
- Is known staleness handled with `Cache.invalidate` / `refresh` as an event rather than by shortening the TTL? [Failure and freshness policy](../operations/caching-batching#failure-and-freshness-policy)
- Do cached values that own resources live in a `ScopedCache`? [ScopedCache](../operations/caching-batching#scopedcache)
- Does every resolver settle every entry exactly once, join rows to entries by identity, and decide what a missing row means? [Resolver obligations](../operations/caching-batching#resolver-obligations)
- Does the resolver deduplicate ids before calling the backend, or use `withCache` / `asCache`? [Resolver obligations](../operations/caching-batching#resolver-obligations)
- Is a memoized single effect (`Effect.cached`, `cachedWithTTL`) constructed once where its owner lives, not per call? [Caching a single Effect](../operations/caching-batching#caching-a-single-effect)
- Are cache and resolver behavior tested with counters and virtual time rather than sleeps? [Testing a cache deterministically](../operations/caching-batching#testing-a-cache-deterministically)

## Observability signals and export

- Does each new signal name the question or alert it serves, and is it the right kind — log, span, or metric? [Which signal answers which question](../operations/observability#which-signal-answers-which-question)
- Are span names operation types and metric attributes bounded vocabularies — no ids, raw URLs, SQL text, or error messages? [Cardinality: names and attribute sets are bounded](../operations/observability#cardinality-names-and-attribute-sets-are-bounded)
- Is every logged or attributed field allow-listed and classified, with no whole objects (config, headers, bodies, rows, prompts) passed to a logger? [Privacy: allow-list fields before they are buffered](../operations/observability#privacy-allow-list-fields-before-they-are-buffered)
- Are secrets logged as `Redacted`, never after `Redacted.value`? [Keeping secrets masked in log payloads](../operations/observability#keeping-secrets-masked-in-log-payloads)
- Is a failure logged once, where recovery or translation is decided, with stable event text and variables in fields? [Logging practice](../operations/observability#logging-practice)
- Does a custom `Logger.layer([...])` keep `Logger.tracerLogger` (or use `mergeWithExisting`) when logs should still appear on spans? [Installing and swapping loggers](../operations/observability#installing-and-swapping-loggers)
- Is trace context carried explicitly across queues, workers, and message buses, and is malformed inbound context dropped rather than rejected? [Span and correlation rules](../operations/observability#span-and-correlation-rules)
- Are in-flight gauges decremented in a finalizer? [Gauges that follow a lifetime](../operations/observability#gauges-that-follow-a-lifetime)
- Is each signal exported through exactly one path, installed once at the root and provided *beneath* the application Layers? [One export path per signal](../operations/observability#one-export-path-per-signal)
- Does every flush have a deadline, and is the collector kept out of readiness checks? [Layer order and shutdown](../operations/observability#layer-order-and-shutdown)
- Is the sampling owner written down, and are SLIs computed from unsampled metrics? [Sampling has one owner per path](../operations/observability#sampling-has-one-owner-per-path)
- Is telemetry verified with recording Layers and privacy or cardinality tests, not only by eyeballing a dashboard? [Verifying telemetry](../operations/observability#verifying-telemetry)

## Tests

- Does each test state its claim, boundary, replaced requirements, and oracle — and would a believable wrong implementation fail it? [Model the proof before writing the test](../deep-dives/testing-an-effect-application#model-the-proof-before-writing-the-test)
- Is every Effect-returning test written with `it.effect` (or `it.live`), never returned from plain `it(...)`? [When green means nothing](../deep-dives/testing-an-effect-application#when-green-means-nothing)
- Is there at least one typed-failure case per operation, and an interruption or cleanup case for resourceful code? [Test interruption and cleanup](../deep-dives/testing-an-effect-application#test-interruption-and-cleanup)
- Are failures asserted structurally through `Exit` — tag and fields — rather than by message text or `Cause` snapshots? [Assert typed failures as data](../deep-dives/testing-an-effect-application#assert-typed-failures-as-data)
- Is time driven with `TestClock` in fork–adjust–join order, synchronized on handshakes rather than `yieldNow` counts or real sleeps? [Synchronize on phases, not on turns](../deep-dives/testing-an-effect-application#synchronize-on-phases-not-on-turns)
- Does a retry or TTL test assert the timeline and the non-retryable path, not just the final value? [Testing a policy](../concurrency/scheduling-time#testing-a-policy)
- Do fakes record what they received and choose each scripted answer when the returned Effect runs, so forwarding, call counts, and retries are asserted rather than assumed? [Spy, lazy, and clock-driven fakes](../deep-dives/testing-an-effect-application#spy-lazy-and-clock-driven-fakes)
- Is each test classified by the boundary it really crosses, with no in-memory harness used to claim socket, serializer, or database behavior? [In-memory test runtimes shipped with Effect](../tooling/testing-dev-tooling#in-memory-test-runtimes-shipped-with-effect)
- Do real fixtures come from scoped Layers, with unique names per worker, a real readiness probe, and loud cleanup failures? [A contract for real fixtures](../deep-dives/testing-an-effect-application#a-contract-for-real-fixtures)
- Do property tests derive generators from Schemas with constructive checks, and keep each shrunk counterexample as a permanent example test? [What a derived generator cannot test](../tooling/testing-dev-tooling#what-a-derived-generator-cannot-test)
- Are laziness and the exact `E` and `R` pinned where they are part of the contract? [Prove laziness and the static contract](../tooling/testing-dev-tooling#prove-laziness-and-the-static-contract)
- Did the CI command collect the tests this change added, and is the built artifact launched somewhere in the pipeline? [The built-artifact lane](../deep-dives/testing-an-effect-application#the-built-artifact-lane)

## Hosts, startup, and shutdown

- Is there exactly one runner per host: one platform `runMain` per process, or one warmed `ManagedRuntime` per foreign host? [Choosing a host](../interfaces/platform-runtime-hosts#choosing-a-host)
- Is every long-lived thing a row in an ownership ledger with an owner scope, a bounded release, and a proof? [Write the ownership ledger first](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#write-the-ownership-ledger-first)
- Is startup all-or-nothing: closed to traffic, acquire in dependency order, probe through the assembled graph, publish ready last? [Startup is a transaction](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#startup-is-a-transaction)
- Are liveness, readiness, and draining separate answers, with liveness never checking dependencies and readiness false while draining? [Liveness, readiness, and draining are different questions](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#liveness-readiness-and-draining-are-different-questions)
- Is shutdown one operation — closing the root scope — that stops intake, drains within a deadline, interrupts survivors, and releases in reverse order? [One shutdown operation](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#one-shutdown-operation)
- Is ordering that matters expressed as a Layer dependency rather than as a convention between `Layer.mergeAll` peers? [One shutdown operation](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#one-shutdown-operation)
- Does the sum of shutdown bounds fit inside the platform's grace period, and is the code free of `process.exit()`? [Signals, exit codes, and the time budget](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#signals-exit-codes-and-the-time-budget)
- In a foreign host, is the host's `AbortSignal` forwarded to the runner, admission stopped before `dispose()`, and shutdown memoized? [A production-shaped bridge](../recipes/managed-runtime-integration#a-production-shaped-bridge)
- Do platform and `effect/unstable/*` imports sit behind app-owned capabilities, imported by one module each? [Keep platform and unstable imports behind a capability](../interfaces/platform-runtime-hosts#keep-platform-and-unstable-imports-behind-a-capability)
- Does each cross-cutting policy — time, recurrence, configuration, capacity, execution, export, atomicity — have exactly one owning value? [One owner per policy](../deep-dives/anatomy-of-a-real-effect-application#one-owner-per-policy)
- Do lifetime tests assert live state before close and terminal state after, including a failed startup? [Test the lifetime, not just the behavior](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#test-the-lifetime-not-just-the-behavior)

## Upgrading Effect versions

- Are `effect` and every `@effect/*` package pinned to one exact version, with a single installed copy of `effect`? [Incompatible unstable package versions](../troubleshooting/troubleshooting-and-anti-patterns#incompatible-unstable-package-versions)
- Was the delta table read for changes that alter bytes on the wire or on disk, and is there a coordinated rollout plan for them? [What changed from rc.108 to rc.115](../#what-changed-from-rc-108-to-rc-115)
- Do both peers of every binary RPC, cluster, or EventLog link move to `SchemaBinary` together, with old journals accounted for? [SchemaBinary](../concurrency/streaming-channels#schemabinary)
- Do all boolean CLI flags have `Flag.withDefault(false)`, `Flag.optional`, or a fallback? [Flag](../tooling/cli-framework#flag)
- Were `Config`, `Flag`, and `Prompt` constructors renamed to PascalCase, and `Config.mapOrFail` to `Config.mapEffect`? [Built-in constructors](../foundations/configuration-secrets#built-in-constructors)
- Were property tests moved to `Arbitrary.schema` and `{ arbitrary: { runs } }`, opaque filters replaced with constructive checks, and saved failures re-recorded? [Arbitrary](../tooling/testing-dev-tooling#arbitrary)
- Were PostgreSQL row Schemas re-checked against the native client's result types, JSON parameters wrapped in `sql.json`, and multi-statement strings split? [Upgrading @effect/sql-pg to the native client](../interfaces/sql#upgrading-effect-sql-pg-to-the-native-client)
- Were JSON Schema consumers and snapshots checked against open-by-default output? [JsonSchema](../data/schema#jsonschema)
- Is the code free of `yield*` on `Option`, `Result`, fibers, refs, and deferreds? [Moving between Option, Result, and Effect](../foundations/errors-option-result#moving-between-option-result-and-effect)
- Were `PersistedQueue` retry options moved to `make`, and are dead-lettered items monitored? [PersistedQueue](../tooling/persistence#persistedqueue)
- Do Effect diagnostics run in CI so removed APIs and floating Effects fail the build? [Effect diagnostics in the editor and in CI](../foundations/getting-started#effect-diagnostics-in-the-editor-and-in-ci)

## Deeper checklists on other pages

These sections go further than a review question can. Use them when a section above turns up more than one "no".

| Area | Checklist |
| --- | --- |
| Application shape, composition root, policies | [Anatomy — Operational checklist](../deep-dives/anatomy-of-a-real-effect-application#operational-checklist) |
| Lifetimes, startup, readiness, shutdown | [Owning Lifetimes — Operational checklist](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#operational-checklist) |
| Failure, retry, fallback, interruption | [Failure — Operational checklist](../deep-dives/failure-retry-fallback-and-interruption#operational-checklist), [Retry policy checklist](../concurrency/scheduling-time#retry-policy-checklist) |
| Bounded workers and structured concurrency | [Structured Concurrency — Operational checklist](../deep-dives/structured-concurrency-through-a-bounded-worker#operational-checklist) |
| Streaming ingestion | [Streaming Ingestion — Operational checklist](../deep-dives/streaming-ingestion-without-accidental-buffering#operational-checklist) |
| Schema boundaries | [Schema — Operational checklist](../deep-dives/schema-from-external-input-to-domain-and-back#operational-checklist), [Proving the boundary](../recipes/schema-httpapi-sql-boundary#proving-the-boundary) |
| HTTP edge limits | [Edge policy checklist](../interfaces/http-server#edge-policy-checklist), [What each test ring proves](../interfaces/http-api#what-each-test-ring-proves) |
| Durability, queues, workflows, cluster | [Durability Ladder — Operational checklist](../deep-dives/durability-and-distribution-ladder#operational-checklist), [Recovery testing and operations](../systems/workflows-durable-execution#recovery-testing-and-operations) |
| Observability before production | [Before production](../recipes/production-observability#before-production), [Verifying telemetry](../operations/observability#verifying-telemetry) |
| Tests | [Testing — Operational checklist](../deep-dives/testing-an-effect-application#operational-checklist), [When green means nothing](../deep-dives/testing-an-effect-application#when-green-means-nothing) |
| Host bridges | [How to test this seam](../recipes/managed-runtime-integration#how-to-test-this-seam) |
| AI capabilities | [Production rules for model calls](../systems/ai-language-models#production-rules-for-model-calls), [AI — Operational checklist](../deep-dives/building-a-production-ai-capability#operational-checklist) |
| Reactive UI state | [Performance & correctness checklist](../deep-dives/reactivity-from-atoms-to-mastery#performance-correctness-checklist) |
| Brownfield adoption | [How to know you are done](../deep-dives/adopting-effect-in-an-existing-codebase#how-to-know-you-are-done) |
