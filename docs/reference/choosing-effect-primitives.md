# Choosing Effect Primitives

Most incorrect Effect code uses a real primitive for the wrong job. Choose first by semantics—absence, failure, coordination, ownership, durability, or distribution—and only then by API convenience.

The tables below describe Effect `4.0.0-rc.115`. “In-process” means that a restart loses the state unless the program explicitly writes it to a durable subsystem. `Scope` in the requirements column means that acquisition or borrowing is tied to structured cleanup. Every table ends with a **Details** line that names the section owning the full explanation; this page only decides. Official guide links track Effect's `main` branch rather than the pinned `rc.115` release, so where they differ, this page and the tagged source win.

## Boundary rules before primitives

One shape recurs in every table below: **keep a fact explicit inside the program and collapse it only at the edge that owns the decision.** If the collapse happens earlier, no primitive further down can recover the information.

| Keep explicit inside | Collapse it only at | Owning section |
| --- | --- | --- |
| Absence (`Option`) | a display or protocol edge that owns the fallback | [Fallbacks and boundary exits](../foundations/errors-option-result#fallbacks-and-boundary-exits) |
| Expected failure (`E`) | the terminal boundary that owns the response, with one fold | [Folding both channels at a boundary](../foundations/errors-option-result#folding-both-channels-at-a-boundary) |
| Untrusted representation (`unknown`) | ingress: decode once, with that boundary's parse options | [Parse options are boundary policy](../data/schema#14-parse-options-are-boundary-policy) |
| Requirements (`R`) | the application, module, or test edge that provides them | [Providing one value or building a graph](../foundations/services-context-layers#providing-one-value-or-building-a-graph) |
| Execution (laziness) | a runner at an edge that owns the fiber | [Running effects at an owned edge](../foundations/core-runtime-execution#11-running-effects-at-an-owned-edge) |
| Lifetime (`Scope` in `R`) | the narrowest owner that is still valid | [Write the ownership ledger first](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#write-the-ownership-ledger-first) |
| Secrets (`Redacted`) | the single call that needs the bytes | [Redacted](../foundations/configuration-secrets#redacted) |
| Units of time (`Duration`) | an interop edge that requires a number | [Parsing untrusted durations and interop edges](../concurrency/scheduling-time#parsing-untrusted-durations-and-interop-edges) |

**Not everything needs a primitive.** A deterministic, synchronous transformation with no dependency, expected failure, asynchronous step, interruption, concurrency, or lifetime stays a plain TypeScript function. Details: [Decide what to leave out](../deep-dives/adopting-effect-in-an-existing-codebase#decide-what-to-leave-out).

## Constructor by source convention

Choose the constructor by how the wrapped JavaScript reports failure and when it does its work, not by which one makes `E` smallest. `sync` and `promise` are assertions that the code cannot fail; when it fails anyway the result is a defect.

| You are wrapping | Constructor | A throw or rejection becomes | Avoid it when |
| --- | --- | --- | --- |
| A value you already hold | `Effect.succeed(value)` | not applicable: the argument is evaluated eagerly, while the program is built | the expression does work (`Date.now()`, `counter.next()`, a side effect); use `Effect.sync` |
| Synchronous code that cannot throw | `Effect.sync(() => ...)` | a defect | the code can throw: `JSON.parse`, `new URL`, a synchronous Schema decoder |
| Synchronous code that can throw | `Effect.try({ try, catch })` | the typed error `catch` returns | you would use the bare-thunk form and accept `Cause.UnknownError` without meaning to |
| A Promise that can reject | `Effect.tryPromise({ try: (signal) => ..., catch })` | the typed error `catch` returns | the thunk ignores `signal`: interruption then stops the fiber but not the I/O |
| A Promise that is not expected to reject | `Effect.promise((signal) => ...)` | a defect | the call touches a network, disk, or SDK; `Effect.promise(() => fetch(url))` moves every outage out of `E` |
| A one-shot callback API | `Effect.callback<A, E>((resume, signal) => ...)` | whatever is passed to `resume`; only the first call counts | the source emits many values; use a `Queue` or `Stream.callback` |
| Building the next effect is itself work | `Effect.suspend(() => effect)` | a defect if the thunk throws | a plain conditional inside `Effect.gen` already defers it |
| An `Option`, `Result`, or nullable value | `Effect.fromOption`, `Effect.fromResult`, `Effect.fromNullishOr` | not applicable | you expected `yield*` to accept the `Option` or `Result` directly; it does not in `rc.115` |

Details: [Creating effects](../foundations/core-runtime-execution#1-creating-effects), [Cancellable adapters for promises and callbacks](../foundations/core-runtime-execution#8-cancellable-adapters-for-promises-and-callbacks).

## Runner by host contract

Choose the runner by the outcome contract the host needs. Reusable code — services, domain functions, libraries — never calls one.

| Runner | Returns | Failure surfaces as | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- |
| `Effect.runSync` / `runSyncExit` | `A` / `Exit<A, E>` | a `throw` / a defect holding `AsyncFiberError` at the first asynchronous boundary | the effect is known to finish synchronously | anything may suspend; the types cannot tell you |
| `Effect.runPromise` | `Promise<A>` | a rejection with the squashed cause; failure, defect, and interruption are no longer distinct | a JavaScript edge wants value-or-rejection | the host must tell cancellation from failure |
| `Effect.runPromiseExit` | `Promise<Exit<A, E>>` | always resolves | an adapter, reporter, or test must keep the three outcomes apart | — |
| `Effect.runFork` | `Fiber<A, E>`, immediately | `Fiber.await` or an observer | the caller keeps the handle and owns its lifetime | nobody will join, observe, or interrupt the fiber |
| `Effect.runCallback` | an interruptor function | the `onExit` callback | callback-style hosts | a Promise or fiber handle fits |
| Platform `runMain` | `void` | a logged error and a process exit code | the process entry point, once | inside application code |
| `ManagedRuntime` | the same family as methods | as above | a non-Effect host calls in repeatedly against one Layer graph | one runtime per request, or disposing without draining first |

Every runner except `runSync` / `runSyncExit` accepts `{ signal }`, which turns a host abort into interruption. Details: [Running effects at an owned edge](../foundations/core-runtime-execution#11-running-effects-at-an-owned-edge), [ManagedRuntime](../foundations/core-runtime-execution#managedruntime), [Bridge into a host that is not Effect](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#bridge-into-a-host-that-is-not-effect).

## Option vs Result vs Effect

| Primitive | Error and requirements | Scope, lifetime, and backpressure | Durability and distribution | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- | --- |
| `Option<A>` | No error channel and no services. `None` says only “absent”; it carries no reason. | An eager immutable value. No execution, interruption, concurrency, or cleanup. | Data only. It can be encoded, but has no persistence or transport behavior itself. | A value may legitimately be absent and callers do not need to distinguish why. | Absence has domain meaning that callers must handle differently, or obtaining the value performs work. |
| `Result<A, E>` | An eager `Success<A>` or `Failure<E>` value; no `R`. Both branches are ordinary data and can be inspected repeatedly. | No runtime, scheduling, interruption, or lifetime. Useful for pure validation and for storing an already-computed outcome. | Data only. Durability depends on an explicit Schema/store. | A pure calculation has a meaningful failure value and execution has already happened. | The operation is lazy, asynchronous, interruptible, resource-owning, or requires services. |
| `Exit<A, E>` | An eager `Success<A>` or `Failure<Cause<E>>`; no `R`. The `Cause` keeps defects, interruption, and several reasons. | The recorded outcome of a finished run. No execution of its own. | Data only; it is what `Persistence`, `Deferred.done`, and request completion store. | The full outcome of a run must be inspected, stored, or replayed: test assertions, host adapters, `RequestResolver` completion. | A two-case answer is enough (`Result`), or the value is not the outcome of running anything. |
| `Effect<A, E, R>` | Typed failure `E`; required services `R`; defects and interruption remain in `Cause`. | A lazy description run by a fiber. Supports structured concurrency, retry, timeout, and scoped acquisition. | Ephemeral by default. It can call Persistence, Workflow, Cluster, or another durable/distributed subsystem. | Describing application work, including synchronous work that must compose with typed failure, services, or lifecycle. | You only need a small, eagerly available data value and no execution semantics. |

Do not turn every `None` into a defect, or every pure `Result` into a running Effect. Convert at the boundary where semantics change: `Option` to a typed failure when absence becomes exceptional, and `Result` to `Effect` when the outcome joins effectful control flow. `Effect.result` and `Effect.option` capture typed failures only; `Effect.exit` captures the whole `Cause`.

Before choosing a channel at all, decide whether the outcome is a *result* or a *failure*: a correct negative answer that every caller treats as ordinary output belongs in `A`, not in `E`. Details: [Designing the error model](../foundations/errors-option-result#designing-the-error-model), [Moving between Option, Result, and Effect](../foundations/errors-option-result#moving-between-option-result-and-effect), [Exit](../foundations/core-runtime-execution#exit).

Official guides: [Expected Errors](https://effect.website/docs/v4/error-management/expected-errors), [Exit](https://effect.website/docs/v4/data-types/exit).

## Recovery operator by intent

| Intent | Operator | What remains in `E` | Avoid it when |
| --- | --- | --- | --- |
| Handle one or several tagged variants | `Effect.catchTag("A")`, `catchTag(["A", "B"])`, `catchTags({ ... })` | every other variant | the policy depends on a field rather than the tag |
| Handle by predicate, refinement, or `Filter` | `Effect.catchIf`, `Effect.catchFilter` | what the selector rejects | a tag already says it; the narrowest selector documents the policy best |
| Handle one nested `reason` of a wrapper error | `Effect.catchReason`, `catchReasons` | the other reasons | the error has no `reason` union |
| Translate without recovering | `Effect.mapError` | the new error | nothing was learned at this layer; pass the error through unrenamed |
| Turn an unacceptable success into a failure | `Effect.filterOrFail` | the added error | the check belongs in a Schema at the boundary |
| Produce exactly one ordinary shape at a terminal edge | `Effect.match`, `Effect.matchEffect` | `never` | the code is not a terminal boundary; folding in a lower layer steals policy from callers |
| Default a value | `Effect.orElseSucceed` after narrowing with `catchTag` | `never` | only one variant should default; un-narrowed, it replaces every typed failure |
| Try different effects in order | `Effect.firstSuccessOf([...])` | the last error | the same effect should run under different services; that is `ExecutionPlan` |
| Observe only | `Effect.tapError`, `tapErrorTag`, `tapCause`, `tapDefect` | unchanged | you intended to recover |
| Treat the outcome as data | `Effect.result`, `Effect.option`, `Effect.exit` | `never` | `option` would discard an error value somebody needs |
| Inspect defects or interruption deliberately | `Effect.catchCause` with a guard, `Effect.catchDefect` that re-dies what it does not recognize | unchanged unless handled | inside domain logic; these belong to a request, job, or process boundary |
| Discard a best-effort failure | `Effect.ignore` (typed failures only), `Effect.ignoreCause` (defects and interruption too) | `never` | anything but best-effort cleanup or telemetry |
| Promote to a defect | `Effect.mapError` then `Effect.orDie` | `never` | the goal is only a tidier error union |

Typed recovery operators look at the **first `Fail` reason** and replace the whole `Cause` with the handler's result, so a defect or interruption recorded beside a typed failure disappears. Where mixed causes are possible and the other reasons matter, use a guarded `catchCause`. Details: [Effect error handling](../foundations/errors-option-result#effect-error-handling), [Recovery replaces the whole Cause](../foundations/errors-option-result#recovery-replaces-the-whole-cause), [Classifying an error union](../foundations/errors-option-result#classifying-an-error-union).

## Fail fast or accumulate

| Need | Use | Outcome | Avoid it when |
| --- | --- | --- | --- |
| Stop the batch at the first problem | `Effect.all` / `Effect.forEach` (the default mode; sequential unless `concurrency` is set) | fails with the first `E`; no partial successes are returned | the caller needs every problem at once |
| Every problem at once, or else every value | `Effect.validate(items, f, { concurrency? })` | `Array<B>`, or fails with `NonEmptyArray<E>` | successes matter even when some items fail |
| Act on both sides | `Effect.partition(items, f, { concurrency? })` | never fails: `[failures, successes]` | a failure should stop the caller |
| One outcome per member, in the input's shape | `Effect.all(effects, { mode: "result" })` | a `Result` per member | a flat list of failures is enough |
| Every Schema issue of one decode | the parse option `errors: "all"` | one `SchemaError` holding every reachable issue | you would read "no issue reported" as "every rule ran" |

A defect in any element still fails the whole call. Accumulate as data rather than as several `Fail` reasons in one `Cause`, because typed handlers inspect only the first one. Details: [Accumulating errors instead of failing fast](../foundations/errors-option-result#accumulating-errors-instead-of-failing-fast), [Parse options are boundary policy](../data/schema#14-parse-options-are-boundary-policy).

## Providing dependencies by seam

| Seam | Effect on `R` | What is built, and how often | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- |
| `Effect.provideService(Service, value)` | removes exactly one identifier | nothing is built; the value already exists | a focused test fake, a script, a per-request value set by middleware | the implementation needs state, configuration, other services, or teardown |
| `Effect.provide(context)` | removes every key in the `Context` | nothing is built | several ready values travel together | the values need construction |
| `Layer.succeed(Service, value)` | removes the output | a finished value, no finalizer | a constant implementation inside a Layer graph | anything must be closed; it cannot express teardown |
| `Layer.effect(Service, constructor)` | removes the output, adds the constructor's needs (minus `Scope`) | once per memo map; the Layer build owns the scope of `acquireRelease` | state, configuration, other services, or a lifetime | — |
| One `Effect.provide(AppLive)` at the edge, or one `ManagedRuntime` | closes `R` to `never` | every Layer value once, released at shutdown | the application root | repeated next to each use: sibling `Effect.provide(PoolLive)` calls build two pools |
| `Effect.provide(layer, { local: true })` | same | a brand-new memo map: the whole provided graph is rebuilt, then released when that effect ends | deliberate isolation per tenant, test, or transaction | silencing a type error; it duplicates pools, caches, and subscriptions |
| `Layer.fresh(layer)` | same | that Layer and its dependencies are private to one branch of a build | one branch needs its own instance | as a default; sharing is the resource-safety default |
| `Effect.serviceOption(Service)` | does not add the service | — | a capability the host may or may not install | the feature is required; the compiler will not remind anyone to provide it |

Provide live implementations only at application or module edges and fakes only at test edges. Details: [Providing one value or building a graph](../foundations/services-context-layers#providing-one-value-or-building-a-graph), [What is shared, and what is rebuilt](../foundations/services-context-layers#what-is-shared-and-what-is-rebuilt), [Resourceful services](../foundations/services-context-layers#resourceful-services), [Optional services](../foundations/services-context-layers#optional-services).

## Fork by owner

Name the owner first; the fork function follows.

| Function | Owner | Interrupted when | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- |
| `Effect.forkChild` | the current fiber | the parent ends, for any reason | the work must not outlive the code that started it | the work has to survive the function that forked it |
| `Effect.forkScoped` (adds `Scope` to `R`) | the surrounding `Scope` | that scope closes | background work owned by a Layer, a request scope, or a test | the nearest scope closes too early, such as an `Effect.scoped` around the fork itself |
| `Effect.forkIn(effect, scope)` | a `Scope` you were handed | that scope closes | "start it here, own it there" | the current scope is already the right owner |
| `Effect.forkDetach` | nobody | never, unless someone keeps the handle | process-lifetime work with a documented stop path | library and domain code; an unowned detached fiber is a leak |
| `FiberSet` / `FiberMap` / `FiberHandle` | a scoped supervisor | the supervisor's scope closes; `FiberMap` and `FiberHandle` also replace by key or slot | a dynamic population of fibers, keyed jobs, or "at most one running" | the population is static; `Effect.forEach` with `concurrency` is smaller |
| No fork: `Effect.all` / `forEach` / `race` | the combinator | the combinator ends | a finite batch or a race | — |

All four fork functions accept `{ startImmediately, uninterruptible }`; a forked fiber is otherwise only *scheduled* until the parent yields, so a listener forked just before a publish can miss it. Details: [Choosing a fork by its owner](../foundations/core-runtime-execution#choosing-a-fork-by-its-owner), [When a forked fiber starts](../foundations/core-runtime-execution#when-a-forked-fiber-starts), [Structured concurrency is ownership](../deep-dives/structured-concurrency-through-a-bounded-worker#structured-concurrency-is-ownership).

## Resource lifetime and bracket

| Shape | Lifetime unit | Who closes it | May cleanup fail in `E`? | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- | --- |
| `Effect.acquireUseRelease(acquire, use, release)` | one `use` call | the combinator | yes | the resource lives for exactly one operation and the caller must see a failed release, such as a commit or flush | the handle must outlive `use` |
| `Effect.acquireRelease` + `Effect.scoped` | the scoped region | `Effect.scoped` | no; the finalizer's error type is `never` | several resources share one region and release in reverse order | the value escapes the region; returning it is a use-after-release bug |
| `Effect.acquireRelease` inside `Layer.effect` | the Layer's owner: application, `ManagedRuntime`, or test | the Layer build's scope | no | pools, clients, exporters, listeners | the resource is per request; providing the Layer in a handler acquires it per request |
| `Effect.ensuring` / `Effect.onExit` / `Effect.onError` | one effect | the combinator | only `onExit` | cleanup with no handle to pass: a gauge decrement, a `Deferred` completion, a flag | there is a resource; pair it with its acquisition instead |
| `Effect.addFinalizer` | the current `Scope` | whoever owns that scope | no | registering cleanup from inside a scoped constructor | nothing will discharge the `Scope` it adds to `R` |
| `Stream.unwrap` over a scoped effect, `Stream.scoped` | the stream's consumption | the stream, on completion, failure, interruption, and early stop | no | a cursor, file, or subscription read incrementally | acquiring before the stream and closing "when done" |
| `Pool.get`, `ScopedCache`, `RcRef` / `RcMap` | a borrow or a cache entry | the pool, cache, or reference count | no | bounded sharing of expensive instances | one long-lived client is enough |

Give every handle its own bracket, because a release is registered only after its acquisition succeeds. `Scope` left in `R` means nobody owns the lifetime yet. Details: [Interruption & resource safety](../foundations/core-runtime-execution#6-interruption-resource-safety), [When cleanup can fail](../foundations/core-runtime-execution#10-when-cleanup-can-fail), [One bracket per resource](../deep-dives/anatomy-of-a-real-effect-application#one-bracket-per-resource), [Owning resources inside a stream](../concurrency/streaming-channels#6-owning-resources-inside-a-stream).

## Ref vs SynchronizedRef vs SubscriptionRef vs transactions

Effect 4 exposes software transactional memory through `Effect.tx`, `Effect.txRetry`, and the `Tx*` structures. There is no public `STM` namespace in this release.

| Primitive | Error and requirements | Scope, lifetime, and backpressure | Durability and distribution | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- | --- |
| `Ref<A>` | Reads and pure `modify`/`update` operations cannot fail and require no services. | One in-memory cell. Each pure modification is atomic; there is no waiting protocol or change stream. | In-process only. | Several fibers share one value and every transition is a fast, pure function. | A transition must run an Effect, several cells must commit together, or consumers need every update. |
| `SynchronizedRef<A>` | Effectful modifiers contribute their own `E` and `R`. | A one-permit semaphore serializes the whole effectful transition. Other updaters wait until it finishes. | In-process only. | Load-once state, token refresh, or another effectful read-modify-write must not overlap. | The slow transition should run concurrently, or several independent values need one atomic commit. Do not hold its permit around avoidable network latency. |
| `SubscriptionRef<A>` | Reads/writes are infallible; effectful modifiers contribute `E`/`R`. `changes` is a `Stream<A>`. | Serialized state plus an unbounded replay-one PubSub. A subscriber first sees the current value, then committed changes; a permanently slow subscriber can accumulate backlog. | In-process only. | Consumers need both the latest state and a live stream of subsequent changes. | You need bounded backpressure, durable replay, or only event fan-out without a current value. |
| `Effect.tx` + `TxRef` / `TxQueue` / other `Tx*` | The body retains its typed `E`/`R`; `Effect.tx` supplies the internal transaction service. `Effect.txRetry` waits without a typed error. | Optimistic journal over multiple transactional values. Conflicts rerun the entire body; commit is all-or-nothing. `txRetry` wakes when a read transactional value changes. | In-process only; this is not a database transaction. | Several related in-memory values must change atomically, or a condition should wait transactionally. | Work must survive restart, coordinate across processes, or perform an external side effect. A transaction body can rerun, so keep non-idempotent I/O outside it. |

Each `Ref` operation is atomic; a `Ref.get` followed by a `Ref.set` is two transitions and loses updates under concurrency. Details: [One transition, one call](../concurrency/state-mutable-references#one-transition-one-call), [Choosing the right state tool](../concurrency/state-mutable-references#choosing-the-right-state-tool), [Failure rolls back; snapshots need one transaction](../concurrency/software-transactional-memory#failure-rolls-back-snapshots-need-one-transaction).

## Deferred vs Latch vs Queue vs PubSub

Classify the communication before naming a primitive. Each of the four classic coordination bugs — a hang, a leaked listener, duplicated work, an event seen by only one observer — comes from answering one of these questions wrongly.

| Question | Answer | Primitive |
| --- | --- | --- |
| Do readers want the current value or each event? | current value | `Ref`, or `SubscriptionRef` when they also want changes |
| Does it happen once or repeatedly? | once | `Deferred` (a result) or `Latch` (a reopenable gate) |
| Should one consumer or every consumer see each value? | one / every | `Queue` / `PubSub` |
| Under overload, should the producer wait, should data be shed visibly, or does only the latest value matter? | wait / shed / latest | the `bounded`, `dropping`, or `sliding` constructor — see [Overload semantics at a glance](#overload-semantics-at-a-glance) |

| Primitive | Error and requirements | Scope, lifetime, and backpressure | Durability and distribution | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- | --- |
| `Deferred<A, E>` | Completed once with success, typed failure, or an Effect/Exit; awaiters observe that outcome. No service requirements. | Write-once cell. Any number of fibers may await the same result. No capacity or stream of values. | In-process only. | One result or readiness signal must be delivered to many waiters exactly once within the process. | The gate must reopen, or more than one value must be transferred. |
| `Latch` | No value or typed error; no services. | Repeatable open/close gate. `await` and `whenOpen` block while closed; opening releases current and future waiters until closed again. | In-process only. | Pausing and resuming work behind a lifecycle gate. | A result must be communicated, or each signal must be counted. For mutual exclusion use `Semaphore.make(1)` with `withPermit`: a latch lets every waiter through together and hands nothing back. |
| `Queue<A, E>` | Consumers can fail with queue error `E`; `Queue.end` uses the done cause. No service requirements. | Point-to-point: one offered element is taken by one consumer. Bounded queues suspend producers; dropping and sliding queues shed data explicitly. | In-process only. | Producer/consumer handoff, bounded mailboxes, worker pipelines, and local backpressure. | Every subscriber must see every event, or messages must survive process loss. |
| `PubSub<A>` | Publish is infallible at the typed level; subscriber dequeue lifetime is scoped. | One-to-many fan-out. Bounded mode can suspend publishers on slow subscribers; dropping/sliding modes shed data. Late subscribers miss history unless `replay` is configured. | In-process only. | Independent live consumers must each receive published events. | Work should be distributed among workers rather than copied, or delivery/replay must be durable. |

Details: [Delivery semantics: Queue or PubSub](../concurrency/concurrency-coordination#delivery-semantics-queue-or-pubsub), [Queue lifecycle: who ends it, and what a failure does](../concurrency/concurrency-coordination#queue-lifecycle-who-ends-it-and-what-a-failure-does), [Deferred](../foundations/core-runtime-execution#deferred), [Latch](../foundations/core-runtime-execution#latch).

Official guide: [Latch](https://effect.website/docs/v4/concurrency/latch).

## Overload semantics at a glance

Decide which failure mode you want **before** picking a constructor. `dropping` and `sliding` are stated loss policies, never performance switches.

| Strategy | `Queue.offer` | `PubSub.publish` | `Stream.buffer` / `Stream.callback` | What is lost | Choose it when |
| --- | --- | --- | --- | --- | --- |
| Suspend (`Queue.bounded`, `PubSub.bounded`, `strategy: "suspend"`) | the producing fiber waits, then gets `true` | waits while any subscriber lags by a full buffer | upstream is back-pressured | nothing | every value must be processed **and** the producer is an Effect that can wait |
| Dropping | returns `false`; `offerAll` returns the rejected remainder | returns `false`; the message is dropped for every subscriber | the newest elements are discarded | the newest values | shedding load is an accepted policy and the `false` results are counted |
| Sliding | returns `true`; the eviction is **not** reported | returns `true`; only lagging subscribers miss the evicted message | the oldest elements are evicted | the oldest values | only the latest state matters: progress, presence, prices |
| Unbounded (`Queue.unbounded`, `PubSub.unbounded`, `capacity: "unbounded"`, and the **default** of `Stream.callback`) | always `true` | always `true` | nothing pushes back | nothing, until memory runs out | something else you can name already bounds the producer |

A synchronous callback cannot wait: `Queue.offerUnsafe` and `PubSub.publishUnsafe` return `false` on a full bounded buffer instead of suspending, so a bounded buffer in front of a callback producer is a loss policy whether or not it is named one. Durable delivery semantics (at-least-once, leases, outbox) are a separate ladder. Details: [Queue](../concurrency/concurrency-coordination#queue), [Make loss observable](../concurrency/concurrency-coordination#make-loss-observable), [Overflow strategies and the publish result](../concurrency/concurrency-coordination#overflow-strategies-and-the-publish-result), [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides), [Durability and Distribution Ladder](../deep-dives/durability-and-distribution-ladder).

## Per-call concurrency vs Semaphore vs Pool

| Primitive | Error and requirements | Scope, lifetime, and backpressure | Durability and distribution | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- | --- |
| `{ concurrency }` on `Effect.all`, `Effect.forEach`, Stream operators | Combines each child’s `E` and `R`. Child fibers are structurally owned by the enclosing operation. | A local bound for one traversal: sequential by default, a positive number, or `"unbounded"`. It does not create a shared global quota. | In-process, for one invocation. | A finite batch or one stream stage needs a straightforward parallelism bound. | Several unrelated call sites must share the same quota, or the limited thing is a reusable resource. |
| `Semaphore` | Wrapped work keeps its own `E`/`R`; semaphore operations are infallible. No `Scope` is required. | Shared permit budget across arbitrary fibers. `withPermit(s)` releases on success, failure, or interruption. Waiters are scanned in registration order, but a smaller later request can overtake an earlier request that needs more free permits. | In-process only. | Rate/concurrency limiting or mutual exclusion must span several call sites. | You need to construct, health-check, invalidate, and release actual resource instances. |
| `Pool<A, E>` | Acquisition error is `E`; acquisition may require services. Pool construction and every borrowed `get` require `Scope`. | Fixed or elastic collection of acquired resources, with per-item concurrency, waiters, invalidation, TTL strategies, and finalizers. | In-process ownership; pooled clients may themselves talk to remote systems. | Expensive reusable resources such as connections or sessions need bounded sharing and cleanup. | The work has no reusable resource, or a simple semaphore around an existing client is sufficient. |

Never use `concurrency: "unbounded"` merely to make a batch faster. Use it only when the input is already tightly bounded and every downstream system can accept the resulting load. Several library defaults are unbounded and need an explicit number: `RpcServer` handler concurrency, AI tool-call resolution, and `Stream.callback` buffering. Details: [Write the execution policy first](../deep-dives/structured-concurrency-through-a-bounded-worker#write-the-execution-policy-first), [TTL is not a health check](../concurrency/concurrency-coordination#ttl-is-not-a-health-check), [Operational defaults](../interfaces/rpc#operational-defaults), [Tool-call resolution: concurrency and manual dispatch](../systems/ai-language-models#tool-call-resolution-concurrency-and-manual-dispatch).

## Single-flight, cache, or batching

Repeated work has three different shapes, and each tool fixes exactly one. Measure first: hit ratio, lookup count per request, resolver batch size.

| Waste shape | What the measurement shows | Tool | Why the neighbors do not help |
| --- | --- | --- | --- |
| One expensive effect, no key | the same effect runs once per caller instead of once per freshness window | `Effect.cached`, `Effect.cachedWithTTL`, `Effect.cachedInvalidateWithTTL` | a keyed cache is machinery you do not need |
| Repeat lookup of the same key | lookup count ≈ request count; keys recur | `Cache` with a key, capacity, and TTL | batching shrinks one burst and remembers nothing afterwards |
| Cold stampede on one key | a burst of identical lookups at startup or right after expiry | already solved by `Cache.get`: concurrent misses for one key share one lookup | a hand-written promise map or lock duplicates it |
| N+1 over *different* keys | backend calls scale with rows, one id each | `RequestResolver` + `Effect.request`; `SqlResolver` for SQL | a cache cannot help: remembering one key does nothing for the others |

**Single-flight is not batching**: the first collapses concurrent gets of the *same* key, the second collapses requests for *different* keys into one backend call. They compose through `RequestResolver.withCache` and `asCache`. Base batching does not deduplicate equal requests; only those two combinators do. Details: [Which problem do you have?](../operations/caching-batching#which-problem-do-you-have), [Caching a single Effect](../operations/caching-batching#caching-a-single-effect), [Resolver obligations](../operations/caching-batching#resolver-obligations).

## Cache vs ScopedCache vs Resource vs RequestResolver

| Primitive | Error and requirements | Scope, lifetime, and backpressure | Durability and distribution | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- | --- |
| `Cache<Key, A, E, R>` | Lookups expose `E`; lookup services can be captured at construction or required at lookup. | Capacity + TTL key cache. Concurrent misses for one key share the same lookup. Both successful and failed `Exit` values are cached. Values have no finalizers. | In-process only. | Pure/plain values are expensive to load repeatedly by key. | Cached values own resources, or results must survive restart. |
| `ScopedCache<Key, A, E, R>` | Same lookup error model; cache construction requires an owning `Scope`, but `get` itself does not require a caller Scope. | Per-entry scopes. Expiry, invalidation, eviction, and cache shutdown close the corresponding resources; `get` is not a per-caller lease, so callers must not retain a value past invalidation or cache closure. | In-process only. | Each cached value owns a connection, subscription, file, or other finalizable resource. | Values are plain data and a normal Cache is enough, or each caller needs a separately scoped lease such as `Pool.get`. |
| `Resource<A, E>` | Acquisition error is stored and re-exposed by `get`; construction needs acquisition services and `Scope`. | One refreshable value, not keyed. `manual` or schedule-driven `auto`; replacing a successful scoped value releases the previous value. A failed refresh leaves the previous stored result in place. | In-process only. | The application needs the latest configuration/snapshot/client and explicit or scheduled refresh. | You need many keys, per-request batching, or durable history. |
| `RequestResolver<Request>` + `Effect.request` | Each request declares its success/error type; resolver effects contribute services and failures while completing request entries. | Data-loader model: concurrent requests are collected and handed to batched resolvers. `withCache` adds equality-based sharing of in-flight/completed requests; TTL and resource ownership are not implicit. | In-process by default; `persisted` can add durable result reuse and the resolver may call a remote backend. | Many fibers make declarative lookups that should use one backend batch; add `withCache` when equal requests should also share results. | You need a general mutable cache, arbitrary resource ownership, or a continuously refreshed value. |

With `Cache.make`, a cached failure lives exactly as long as a cached success; give failures their own lifetime with `Cache.makeWith`. Details: [Failure and freshness policy](../operations/caching-batching#failure-and-freshness-policy), [Keys are logical values](../operations/caching-batching#keys-are-logical-values).

## Array, Chunk, Iterable vs Stream, Sink, Channel

| Primitive | Error and requirements | Scope, lifetime, and backpressure | Durability and distribution | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- | --- |
| `Array` / `ReadonlyArray` | Plain data; no `E` or `R`. | Eager and fully resident. JavaScript arrays are the interoperability default. | Data only. | The complete, reasonably sized collection is already in memory. | The source is unbounded or larger than the available memory. |
| `Chunk<A>` | Plain immutable collection; no `E` or `R`. | Strict, compact collection optimized for repeated functional concatenation/slicing and used at streaming boundaries. | Data only. | You need an immutable batch value or an efficient intermediate collection. | Data should be processed incrementally rather than materialized. |
| `Iterable<A>` | Lazy synchronous pull protocol; no typed failure/services in the protocol. | Consumer-driven but synchronous and generally single-pass. No async backpressure, interruption, or scoped cleanup contract. | Data only. | Values can be produced synchronously and cheaply as requested. | Production is asynchronous, fallible, resourceful, or must be interrupted safely. |
| `Stream<A, E, R>` | Typed stream failure `E` and services `R`. | High-level, lazy, chunked, interruptible pipeline. Operators express concurrency and buffering; a Sink runs it. | Ephemeral unless connected to durable input/output. | Processing zero-to-many asynchronous values without collecting them all. | A single Effect or already-materialized collection is simpler. |
| `Sink<A, In, L, E, R>` | Typed failure/services; emits a result `A` and may leave leftovers `L`. | Reusable consumer/fold attached with `Stream.run`. Can stop before the source ends and compose with other sinks. | Ephemeral unless the sink writes durably. | Consumption logic deserves a named, composable value: parsing, folding, batching, or validation. | A one-line `runCollect`/`runForEach` is sufficient. |
| `Channel<OutElem, OutErr, OutDone, InElem, InErr, InDone, R>` | Separately types input/output elements, errors, done values, and services. | Lowest-level bidirectional streaming algebra underneath Stream and Sink; precise leftovers, completion, piping, and codec protocols. | Ephemeral unless connected to durable transport. | Implementing transports, framing, codecs, or a reusable streaming primitive. | Ordinary business pipelines can be expressed with Stream and Sink. |

`Stream.runCollect` is an explicit decision to move the entire remaining stream into memory. Prefer a bounded Sink, incremental `runForEach`, or streaming output when the size is not proven small.

Official guides: [Introduction to Streams](https://effect.website/docs/v4/stream/introduction), [Sink introduction](https://effect.website/docs/v4/sink/introduction).

## Stream buffering and batching operators

Flow-control depth, batch size, and rate are three different knobs. **Buffer capacity is not batch size.**

| Need | Operator | What it retains | Avoid it when |
| --- | --- | --- | --- |
| Decouple a fast producer from a slow consumer | `Stream.buffer({ capacity, strategy? })` | up to `capacity` elements; `"suspend"` back-pressures, `"dropping"` / `"sliding"` lose data | you wanted batches, or a cheap prefix: `buffer` runs ahead of a downstream `take` |
| Fixed-size batches from a finite source | `Stream.grouped(n)` | the batch under construction | the source is live: a partial batch waits indefinitely |
| Batches by size **or** elapsed time | `Stream.groupedWithin(n, duration)` | the batch under construction | the source is a finite file import; `grouped` is simpler |
| A custom batch boundary (weight, cost) | `Stream.aggregateWithin(sink, schedule)`, `Stream.transduce(sink)` | whatever the `Sink` accumulates | size or time already expresses it |
| Resize chunks for an array-consuming sink | `Stream.rechunk(n)` | one chunk | the consumer needs arrays as *elements*; that is `grouped` |
| Bound in-flight effectful work | `Stream.mapEffect(f, { concurrency })` | up to `concurrency` inputs and results | `"unbounded"` over an uncontrolled source |
| Limit rate | `Stream.throttle`, `Stream.schedule` | one chunk / one element | the goal is load shedding by count; that is a dropping buffer |
| Keep only the latest after a quiet period | `Stream.debounce(duration)` | the latest value | every value matters |
| Bound a push source | `Stream.callback(register, { bufferSize, strategy })` | **unbounded unless `bufferSize` is set** | the listener is synchronous and you describe the adapter as back-pressured |

Pull-based back-pressure bounds a pipeline only if every stage is bounded. Details: [Transforming streams](../concurrency/streaming-channels#2-transforming-streams), [Where buffering hides](../concurrency/streaming-channels#7-where-buffering-hides), [Adapting, leftovers, and repeatable batching](../concurrency/streaming-channels#adapting-leftovers-and-repeatable-batching), [Batch by size or time when the source is live](../deep-dives/streaming-ingestion-without-accidental-buffering#batch-by-size-or-time-when-the-source-is-live).

## Wire codec: JSON, NDJSON, or SchemaBinary

| Codec | Framing | Failure type | Evolution | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- | --- |
| JSON through a Schema codec (`Schema.toCodecJson`, `Schema.fromJsonString`; `RpcSerialization.layerJson`) | none: one document per message | `Schema.SchemaError` | ordinary Schema evolution: optional keys, decoding defaults, unions of versions | one request, one response; public HTTP; human-readable storage | many messages share one long-lived connection |
| `Ndjson` (`RpcSerialization.layerNdjson`) — unstable | one JSON value per line | `NdjsonError` (`kind: "Pack"` or `"Unpack"`) for the JSON step, `Schema.SchemaError` for validation | as JSON | streaming, sockets, the peer is not an Effect program, frames must be inspectable | payload size dominates, or an unbounded line from an untrusted peer is not capped |
| `SchemaBinary`, default mode (`RpcSerialization.layerSchemaBinary()`) — unstable | binary frames whose layout is compiled once from the Schema's encoded side | `Schema.SchemaError` | tolerant: fields carry hashed ids, so peers may add optional fields independently; pin `SchemaBinary.fieldId(n)` before a rename | workers, TCP, cluster runners, high-throughput links between Effect programs | the peer cannot share the Schema, or frames must be read by humans |
| `SchemaBinary` with `{ fingerprint: true }` | positional layout plus a layout hash | `Schema.SchemaError`; a mismatched layout is rejected | none: both peers must deploy the same schema together | smallest frames under lock-step deployment | peers are upgraded independently |
| `Sse` — unstable | server-sent events text | a `Retry` failure carries the `retry:` directive | as JSON for the `data` payload | one-way server-to-browser push | bidirectional or binary traffic |

`SchemaBinary` replaced MessagePack in `rc.113` and is the default for cluster runner transports and EventLog journals and remote messages, so that upgrade changes bytes on the wire and on disk. `maxFrameSize` is unset by default on the raw codec; set it for untrusted peers. Details: [SchemaBinary](../concurrency/streaming-channels#schemabinary), [Ndjson](../concurrency/streaming-channels#ndjson), [RpcSerialization](../interfaces/rpc#rpcserialization), [Serialization codecs](../data/schema#11-serialization-codecs).

## HttpClient vs HttpRouter vs HttpApi vs RPC

These modules are under unstable families in `rc.115`; pin all Effect packages to exactly the same release.

| Primitive | Error and requirements | Scope, lifetime, and backpressure | Durability and distribution | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- | --- |
| `HttpClient` | Typed request/response/client errors; requires an implementation such as `FetchHttpClient.layer`. Response bodies are scoped when streamed. | Outbound HTTP with middleware, retries, tracing, redirects, cookies, and streaming bodies. | Remote request/response; HTTP itself supplies no durable orchestration. | Calling arbitrary HTTP services or building a provider-specific client. | You own both ends and want one shared typed contract. |
| `HttpRouter` | Handlers retain typed errors/services until served; platform/server Layers supply runtime requirements. | Low-level inbound routes and middleware over HTTP requests/responses, including streaming. Server lifetime is scoped. | Remote HTTP endpoint, not durable by itself. | Webhooks, static/custom responses, or routing that does not fit a schema-first API. | A contract-first API with generated client and OpenAPI is desired. |
| `HttpApi` | Endpoint Schemas define decoded inputs, success, and typed HTTP errors; middleware declares services. Server/client platform Layers add requirements. | Contract-first HTTP groups/endpoints. Derives handlers, client, OpenAPI, security, docs, and in-memory tests. | Remote HTTP endpoint, not durable by itself. | Browser/public REST semantics, status codes, headers, and OpenAPI matter. | The interface is internal procedure calls with no need for HTTP resource semantics. |
| `RPC` | Each request has payload, success, and error Schemas; routers/middleware/transports add services and transport errors. | Typed request/response and streaming procedures over HTTP, sockets, workers, or in-memory transports. | Distributed transport, not durable by default. | Services share a typed procedure contract and may need streaming or multiple transports. | Public REST/OpenAPI compatibility matters, or calls must survive outages/restarts as workflows. |

Details: [Three failure classes](../interfaces/http-client#three-failure-classes), [Status mapping is part of the contract](../interfaces/http-api#status-mapping-is-part-of-the-contract), [Evolving a contract](../interfaces/rpc#evolving-a-contract), [Keep six failure categories distinguishable](../interfaces/rpc#keep-six-failure-categories-distinguishable).

## Retry vs repeat vs polling vs Workflow

| Primitive | Error and requirements | Scope, lifetime, and backpressure | Durability and distribution | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- | --- |
| `Effect.retry(schedule)` | Repeats only after typed failure. Final `E` remains if the schedule stops; schedule errors/services are added. `Effect.retryOrElse(effect, schedule, orElse)` runs a fallback with the last error and the schedule's output once the policy is exhausted. | One fiber reruns the whole Effect according to a Schedule. Interruption stops it. | Ephemeral; progress disappears on restart. | A transient operation is safe to attempt again with a bounded, classified policy. | Failures are permanent, external writes are not idempotent, or the retry window must survive restart. |
| `Effect.repeat(schedule)` | Repeats after success and stops immediately on typed failure; final success is determined by the Schedule output. | One fiber runs once immediately, then recurs by policy. | Ephemeral. | Periodic maintenance or repeated successful work while the process is alive. | You meant “recover from failure,” or missed work must be remembered. |
| Polling with `repeat`/`Schedule.passthrough` or a Stream | Poll errors remain typed; clock and schedule requirements compose normally. | Repeated reads until a terminal value, usually with `Schedule.while`. A Stream is preferable when callers consume multiple observations. | Ephemeral. | A remote system exposes status but no push callback, and loss of the polling fiber is acceptable. | The wait lasts across deployments or must resume without redoing prior steps. |
| `Workflow` + `Activity` / durable primitives | Payload, success, and failure are Schema-typed; the engine, storage, runner, and activity dependencies are required. | Journaled deterministic orchestration. Completed activity exits replay; durable sleeps/deferreds/queues suspend and later resume. Activity delivery is at least once until its result is recorded. | Durable and deployable across workers when backed by durable engine/storage. | Multi-step business work must survive restarts, be resumed/inspected, and use stable idempotency keys. | A short in-process retry is sufficient, or the body cannot be made deterministic and side effects idempotent. |

Always bound and classify retry. A retry policy that accepts every error can turn authorization, validation, or schema failures into an outage amplifier. The options form `{ while }` with no `schedule` or `times` is a zero-delay loop. `Effect.timeout` before `retry` bounds each attempt; after it, the whole operation. Details: [Retry policy checklist](../concurrency/scheduling-time#retry-policy-checklist), [Shorthand options for retry and repeat](../concurrency/scheduling-time#shorthand-options-for-retry-and-repeat), [Where the timeout sits relative to retry](../deep-dives/failure-retry-fallback-and-interruption#where-the-timeout-sits-relative-to-retry), [Replay, versioning, and rollout](../systems/workflows-durable-execution#replay-versioning-and-rollout).

Official guides: [Retrying](https://effect.website/docs/v4/error-management/retrying), [Introduction to scheduling](https://effect.website/docs/v4/scheduling/introduction) (it shows a three-parameter `Schedule` type; `rc.115` has four: output, input, error, and services).

## Persistence vs EventLog vs Workflow vs Cluster

| Primitive | Error and requirements | Scope, lifetime, and backpressure | Durability and distribution | Choose it when | Avoid it when |
| --- | --- | --- | --- | --- | --- |
| `Persistence` / `PersistedCache` | Schema encoding/decoding and backing-store errors are typed; Layers require the selected memory, SQL, Redis, filesystem, or browser backend. Stores are scoped. | Keyed storage of encoded `Exit` values, TTL caches, and durable queues. It stores results/state but does not orchestrate steps. | Durable only with a durable backing Layer; shared backends can serve multiple processes. | Results, idempotency records, cached computations, or queue items must survive restart. | You need an append-only domain history or deterministic multi-step orchestration. |
| `EventLog` | Event payload/success/error Schemas plus journal, identity, handler, encryption, and optional remote services. | Append-only facts with handlers/projections, replay, compaction, and local/remote synchronization. Handler/journal atomicity depends on the backend. | Durable with IndexedDB/SQL journal; optional encrypted or unencrypted replication. | Audit history, event-sourced state, offline-first convergence, and rebuildable projections are central. | You only need current keyed state or an imperative job runner. |
| `Workflow` | Schema-typed workflow/activity outcomes plus engine/storage requirements. | Persistent execution journal, suspension, resumption, compensation, and operational control. Non-deterministic work belongs in Activities. | Durable orchestration; runners may execute resumed work on another process. | A business process has ordered steps, long waits, retries, and recovery semantics. | You need entity placement, low-latency messaging, or an event-sourced domain ledger rather than orchestration. |
| `Cluster` / Entity / Sharding | Entity request/reply Schemas and cluster transport/storage services; failures include domain, transport, and runner availability concerns. | Routes calls to the runner owning an entity shard; supports entity lifetimes, messaging, runners, singleton/cron facilities, and rebalancing. | Distributed. State durability depends on the entity/message storage and application design; sharding alone is not persistence. | Stateful or addressed capabilities must be located and invoked across a fleet. | One process is enough, or you merely need durable records/work without entity placement. |

These systems compose rather than replace one another. A clustered Workflow runner may use Persistence for journals; a Workflow Activity may append to an EventLog; an Entity may use SQL for state. Select the semantic owner first, then add transport and storage deliberately. A write plus an external effect that must both happen is an outbox, not a bigger transaction. Details: [What each primitive guarantees](../tooling/persistence#what-each-primitive-guarantees), [Failure windows and honest guarantees](../tooling/persistence#failure-windows-and-honest-guarantees), [External effects after commit (outbox)](../interfaces/sql#external-effects-after-commit-outbox), [A compact selection guide](../deep-dives/durability-and-distribution-ladder#a-compact-selection-guide).

## Test tool by claim

Pick the tool by the claim you need to prove; each is evidence for that claim and nothing beyond it.

| Claim under test | Tool | It does not prove |
| --- | --- | --- |
| A delay, timeout, retry spacing, or TTL behaves as specified | `TestClock` inside `it.effect`: fork, adjust, join | that a real driver or OS timer honors the same timing |
| Orchestration, typed failures, interruption, cleanup | `it.effect` plus replacement Layers; assert on `Exit` | the real adapter's behavior |
| `Console.*` output / `Effect.log*` records | `TestConsole` / a capturing test `Logger` | each other |
| A rule holds for every valid input | `Arbitrary.schema` via `it.effect.prop` | rejection of malformed wire input; generated values are already valid |
| A codec decodes, encodes, and round-trips | `TestSchema` | cross-field rules the schema does not state |
| HTTP or RPC contract, routing, middleware, status mapping | `HttpApiTest.groups`, `RpcTest.makeClient` | sockets, malformed wire input, and for `RpcTest` serialization |
| An adapter works against a real dependency | `layer(L, { excludeTestServices: true })` or `it.live`, with a scoped real fixture | that the packaged entry point starts, serves, and shuts down |
| Durable orchestration and storage *contracts* | `WorkflowEngine.layerMemory`, `Persistence.layerMemory`, `KeyValueStore.layerMemory` | durability across a restart |
| `E` and `R` are exactly what the contract says | `expectTypeOf` under the type checker | any runtime behavior |
| The shipped artifact starts, serves, and stops | launch the built bundle or container | — |

Details: [Testing & Dev Tooling](../tooling/testing-dev-tooling), [In-memory test runtimes shipped with Effect](../tooling/testing-dev-tooling#in-memory-test-runtimes-shipped-with-effect), [Model the proof before writing the test](../deep-dives/testing-an-effect-application#model-the-proof-before-writing-the-test), [The built-artifact lane](../deep-dives/testing-an-effect-application#the-built-artifact-lane).

## Host and runtime ownership

A platform Layer says how a capability is implemented; the host decides who owns the runtime, what cancels work, and whether cleanup is awaited.

| Host | Runner and owner | What cancels work | What it cannot promise | Avoid |
| --- | --- | --- | --- | --- |
| Node / Bun / Deno process | one platform `runMain` at the root; the launched Layer's scope owns everything | SIGINT and SIGTERM interrupt the main fiber; finalizers run before exit | surviving SIGKILL or an expired grace period | `process.exit()` in application code |
| Web-standard handler (serverless, edge) | `HttpRouter.toWebHandler` returns `{ handler, dispose }`; module scope owns the Layer, each request its own scope | `request.signal` interrupts the request fiber | that `dispose` is ever awaited, or that work continues after the response | `node:*` assumptions; work scheduled past the response |
| Foreign framework callback (Express, Hono, UI, plugin API) | one `ManagedRuntime`, created and warmed at boot, disposed by the host's shutdown hook | nothing, unless you forward the host's `AbortSignal` with `{ signal }` and stop admission yourself | a drain: `dispose()` interrupts running fibers while the Layer scope closes | a runtime per request |
| Browser page | `BrowserRuntime.runMain` | a non-persisted `pagehide` | completion of asynchronous finalizers or network flushes | relying on a final flush |
| Worker thread or child process | the parent's scope around the worker; the worker side runs a `WorkerRunner` | the parent scope closing | worker-side cleanup longer than the adapter's grace period | unscoped spawns |
| CLI | `Command.run` handed to the platform `runMain` | as a process | — | a second runner inside a command handler |
| Test | the scope of `it.effect` / `it.layer` | the end of the test; time is virtual | anything about real signals, ports, files, or bundling | claiming host behavior from fakes |

Business code is identical in every row; only the outermost line and the platform Layer change. Details: [Choosing a host](../interfaces/platform-runtime-hosts#choosing-a-host), [The host matrix](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown#the-host-matrix), [Choose the correct runtime edge](../deep-dives/anatomy-of-a-real-effect-application#choose-the-correct-runtime-edge).

## More choosers on their owning pages

| Decision | Owning section |
| --- | --- |
| Which Schema decode runner, by who consumes the failure | [Decoding and encoding — pick your result style](../data/schema#1-decoding-and-encoding-pick-your-result-style) |
| Optional key, `undefined`, `null`, or `Option` on the wire | [Optional fields, null, and Option](../data/schema#15-optional-fields-null-and-option) |
| A setting is required, optional, or defaulted | [Deciding required, optional, and defaulted](../foundations/configuration-secrets#deciding-required-optional-and-defaulted) |
| `Config.withDefault` vs `ConfigProvider.orElse` vs `Config.orElse` | [Absence is not malformed input](../foundations/configuration-secrets#absence-is-not-malformed-input) |
| Log, span, or metric | [Which signal answers which question](../operations/observability#which-signal-answers-which-question) |
| Direct OTLP, the OpenTelemetry SDK bridge, or Prometheus | [One export path per signal](../operations/observability#one-export-path-per-signal) |
| RPC transport: HTTP, WebSocket or socket, worker, stdio | [RpcServer](../interfaces/rpc#rpcserver) |
| Cluster runner transport and serialization | [Transport options](../systems/cluster-sharding#transport-options) |
| Combining or splitting streams: `merge`, `zip`, `partition`, `broadcast` | [Combining and splitting streams](../concurrency/streaming-channels#4-combining-and-splitting-streams) |
| Stream recovery: `catch*`, `retry`, `timeout`, `timeoutOrElse` | [Handling stream failures](../concurrency/streaming-channels#5-handling-stream-failures) |
| Workflow finalizer, compensation, or scope finalizer | [Finalizers, compensation, and cancellation](../systems/workflows-durable-execution#finalizers-compensation-and-cancellation) |
| Which durability rung | [A compact selection guide](../deep-dives/durability-and-distribution-ladder#a-compact-selection-guide) |
| Five kinds of order under concurrency | [Five kinds of order](../deep-dives/structured-concurrency-through-a-bounded-worker#five-kinds-of-order) |
| `Match.exhaustive` vs `Match.orElse` | [Closing a matcher](../data/functional-toolkit#closing-a-matcher) |

## A compact selection order

0. Is this outcome a result or a failure? A correct negative answer belongs in `A`; a condition some caller needs its own policy for belongs in `E`; a broken invariant is a defect; a departed caller is interruption.
1. Is this just data? Start with `Option`, `Result`, Array, Chunk, or Iterable. Keep pure, synchronous, dependency-free transformations as plain functions.
2. Is it one lazy operation? Use `Effect<A, E, R>`, model expected failure in `E`, and choose the constructor by the wrapped code's failure convention. Forward the `AbortSignal` in every Promise adapter.
3. Does it need something? Put it in `R`; provide one value with `provideService`, a graph with a Layer, and the live graph once at the edge.
4. Does it hold something open? Name the owner: one operation (`acquireUseRelease`), a region (`Effect.scoped`), a Layer, or a stream. For a fiber, name the owner before choosing the fork.
5. Is it a sequence? Choose Stream; add a Sink for reusable consumption and Channel only for protocol-level work. Bound every stage and choose batch size separately from buffer capacity.
6. Is shared state involved? Choose Ref, SynchronizedRef, SubscriptionRef, or `Effect.tx` according to update and observation semantics.
7. Is coordination involved? Classify the communication first — current value or events, once or repeatedly, one consumer or all, and the overload policy — then choose Deferred/Latch for signals, Queue for work distribution, PubSub for fan-out, Semaphore for a quota, and Pool for owned reusable resources.
8. Is work repeated? Measure the waste shape: one effect (`Effect.cached`), the same key (`Cache`), or many keys at once (`RequestResolver`).
9. Is the boundary remote? Choose HttpClient for outbound calls, HttpRouter for low-level inbound HTTP, HttpApi for REST contracts, and RPC for typed procedures; then choose the wire codec by who the peer is and how the two sides are deployed.
10. Must state or progress survive restart? Move to Persistence, EventLog, or Workflow. Add Cluster when work or addressed state must also be placed across processes.
11. Who runs it? One platform `runMain` per process, one `ManagedRuntime` per foreign host, a request scope per Web handler call — and a runner that keeps cancellation distinct when the host can represent it.
12. How will you know? Pick the test tool by the claim, and finish with the [Review Checklists](review-checklists).
