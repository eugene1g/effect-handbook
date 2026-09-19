# Migrating from Effect 3

Effect 4 keeps the programming model — `Effect`, `Layer`, `Schema`, `Stream` — and changes almost everything around it: how packages are split and versioned, what many functions are called, which values can be yielded, and a handful of runtime behaviors that still type-check after the upgrade. This page is a map from Effect 3 spellings to `effect@4.0.0-rc.115`, an order to do the work in, and a way to prove it is finished.

> **Upstream sources (release-pinned):** [`MIGRATION.md`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.115/MIGRATION.md), the topic notes and the generated per-API rename reference under [`migration/`](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.115/migration), and [`ARBITRARY-MIGRATION.md`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.115/packages/effect/ARBITRARY-MIGRATION.md). Every Effect 3 spelling below comes from those files; every Effect 4 spelling was checked against the `rc.115` source and the installed package. There is no official website migration guide yet.

Three statements in those upstream notes do not hold on the published `rc.115` (a fourth, smaller one is flagged in the CLI table below); trust the right-hand column:

| Upstream note | What it says | What `rc.115` does |
| --- | --- | --- |
| `migration/yieldable.md` | `Option` and `Result` can be `yield*`-ed inside `Effect.gen` | Neither is yieldable: it is a compile error, and forced past the compiler it dies with `Not a valid effect`. Convert with `Effect.fromOption` / `Effect.fromResult`, or match. `Config` values, `Context.Service` classes, and yieldable errors still yield. |
| `migration/layer-memoization.md` | `program.pipe(Effect.provide(L), Effect.provide(L, { local: true }))` builds `L` twice | It builds once. `local` isolates the `provide` that carries it, so it must sit on the inner `provide` that would otherwise reuse the enclosing build; `Layer.fresh(L)` on either one rebuilds. |
| `migration/schema.md` | `Schema.arbitrary` was renamed `Schema.toArbitrary` | `Schema.toArbitrary` was removed in rc.113. Use `Arbitrary.schema` from `effect/unstable/arbitrary`. |

## Packages and imports

**All Effect 4 packages share one version number and are released together.** Pin `effect` and every `@effect/*` package to the same exact version; see [Getting Started](../foundations/getting-started) for the `rc` dist-tag trap.

| Effect 3 package | Effect 4 home |
| --- | --- |
| `@effect/platform` — `FileSystem`, `Path`, `Terminal`, `Error`, `ChannelSchema` | stable core: `effect/FileSystem`, `effect/Path`, `effect/Terminal`, `effect/PlatformError`, `effect/ChannelSchema` |
| `@effect/platform` — `Http*`, `Cookies`, `Headers`, `UrlParams`, `Multipart`, `FetchHttpClient` | `effect/unstable/http` (`HttpApp` became `HttpEffect`; `HttpMultiplex` was removed) |
| `@effect/platform` — `HttpApi*`, `OpenApi` | `effect/unstable/httpapi` |
| `@effect/platform` — `Command`, `CommandExecutor` | `effect/unstable/process`: `ChildProcess`, `ChildProcessSpawner` |
| `@effect/platform` — `KeyValueStore`; `Socket`, `SocketServer`; `Worker*`, `Transferable` | `effect/unstable/persistence`; `effect/unstable/socket`; `effect/unstable/workers` |
| `@effect/platform` — `Ndjson`, `MsgPack` | `effect/unstable/encoding`: `Ndjson`; MessagePack is gone, schema-aware binary framing is `SchemaBinary` |
| `@effect/platform` — `PlatformConfigProvider`, `PlatformLogger`, `Effectify` | `ConfigProvider.fromDotEnv` / `ConfigProvider.fromDir`, `Logger.toFile`, `Effect.effectify` |
| `@effect/rpc`, `@effect/sql`, `@effect/cli`, `@effect/cluster`, `@effect/workflow`, `@effect/ai` | `effect/unstable/rpc`, `…/sql`, `…/cli`, `…/cluster`, `…/workflow`, `…/ai` |
| `@effect/experimental` | split across `effect/unstable/devtools`, `…/eventlog`, `…/persistence`, `…/reactivity`, `…/encoding` (`Sse`), `…/schema` (`VariantSchema`) |
| `@effect/opentelemetry` — `Otlp*` | `effect/unstable/observability`; the package remains for the OpenTelemetry-SDK integration |
| `@effect/platform-node` — `NodeContext` | `NodeServices` (`NodeServices.layer`) |
| `@effect/typeclass` | removed; `Semigroup` and `Monoid` became `effect/Combiner` and `effect/Reducer` |
| `@effect/printer`, `@effect/printer-ansi`, `@effect/sql-kysely`, `@effect/ai-google`, `@effect/ai-amazon-bedrock` | removed with no replacement |

Packages that remain separate installs: `@effect/platform-*`, the `@effect/sql-*` drivers, the `@effect/ai-*` providers, `@effect/opentelemetry`, `@effect/atom-*`, and `@effect/vitest`. Modules under `effect/unstable/*` may break in a minor release; the rest of `effect` follows semantic versioning.

Core modules that disappeared:

| Effect 3 module | Effect 4 |
| --- | --- |
| `effect/Either` | `effect/Result` |
| `effect/FiberRef`, `FiberRefs`, `Differ`-based patches | `Context.Reference` values in `effect/References` |
| `effect/STM`, `TRef`, `TMap`, `TSet`, `TQueue`, `TPubSub`, `TSemaphore`, `TDeferred` | ordinary Effects inside `Effect.tx`, over `TxRef`, `TxHashMap`, `TxHashSet`, `TxQueue`, `TxPubSub`, `TxSemaphore`, `TxDeferred` — see [Software Transactional Memory](../concurrency/software-transactional-memory) |
| `effect/Mailbox` | `effect/Queue` (completion-aware: the error channel carries `Cause.Done`) |
| `effect/Secret` | `effect/Redacted` |
| `effect/ParseResult` | `effect/SchemaIssue` and `effect/SchemaParser` |
| `effect/JSONSchema` | `effect/JsonSchema` |
| `effect/Arbitrary`, `effect/FastCheck` | `effect/unstable/arbitrary`; import `fast-check` directly if you still need it |
| `effect/TestClock`, `TestContext`, `TestServices` | `effect/testing` (`TestClock`, `TestConsole`, `TestSchema`) |
| `effect/List`; `effect/SortedMap`; `effect/KeyedPool`; `effect/Micro` | `ReadonlyArray`; `HashMap` plus an external `Order`; `RcMap` of `Pool`; `Effect` |
| `effect/Runtime` (`Runtime<R>`) | a `Context` plus `Effect.runForkWith` / `runPromiseWith` / `runSyncWith`, or `ManagedRuntime`; the module keeps only `makeRunMain` and teardown helpers |

## API map

A change of spelling is mechanical. Rows marked **behavior** also change what the program does.

### Services, context, and layers

| Effect 3 | Effect 4 |
| --- | --- |
| `Context.Tag("id")<Self, Shape>()` | `Context.Service<Self, Shape>()("id")` — type parameters first, identifier second |
| `Context.GenericTag<T>("id")` | `Context.Service<T>("id")` |
| `Effect.Tag("id")<Self, Shape>()` and its static accessors | `Context.Service`; call through `yield* Service` or `Service.use((s) => s.method(...))` |
| `Effect.Service<Self>()("id", { effect, dependencies })` and the generated `.Default` | `Context.Service<Self>()("id", { make })`; **no Layer is generated** — write `static layer = Layer.effect(this, this.make).pipe(Layer.provide(...))` |
| `Context.Reference<Self>()("id", { defaultValue })` | `Context.Reference<Shape>("id", { defaultValue })` |
| `Context.unsafeGet`, `Context.isTag` | `Context.getUnsafe`, `Context.isKey` |
| `Layer.scoped`, `Layer.scopedDiscard`, `Layer.unwrapEffect` / `unwrapScoped` | `Layer.effect`, `Layer.effectDiscard`, `Layer.unwrap` — the build owns the `Scope` and removes it from the requirements |
| `Layer.catchAll`, `Layer.tapErrorCause`, `Layer.setConfigProvider(p)` | `Layer.catch`, `Layer.tapCause`, `ConfigProvider.layer(p)` |
| `Layer.toRuntime` | `Layer.build` plus `Effect.run*With(context)`, or `ManagedRuntime.make` |
| `Layer.memoize`; per-`provide` memoization | **behavior:** a `provide` nested inside a live build of the same Layer value reuses it; sibling provides still build separately. Opt out with `Layer.fresh` or `{ local: true }`. |
| `Effect.Effect.Context<T>`, `Layer.Layer.Context<T>` | `Effect.Services<T>`, `Layer.Services<T>` |

Handbook pages: [Services, Context & Layers](../foundations/services-context-layers), [Recipe: A Service with Live and Test Layers](../recipes/service-and-layers).

### Errors, Cause, and Exit

| Effect 3 | Effect 4 |
| --- | --- |
| `Effect.catchAll`, `catchAllCause`, `catchAllDefect` | `Effect.catch`, `Effect.catchCause`, `Effect.catchDefect` |
| `Effect.catchSome`, `catchSomeCause` | `Effect.catchFilter`, `Effect.catchCauseFilter` (take a `Filter`); `catchSomeDefect` was removed |
| `Effect.either`, `Effect.orElse`, `Effect.tapErrorCause`, `Effect.timeoutFail` | `Effect.result`, `Effect.catch`, `Effect.tapCause`, `Effect.timeoutOrElse` |
| `Effect.zipRight`, `Effect.zipLeft`, `Effect.if`, `Effect.unless`, `Effect.loop`, `Effect.iterate` | `Effect.andThen`; `Effect.zip` plus `Effect.map`; plain `if` inside `Effect.gen` (or `Effect.when`, which takes an `Effect<boolean>` and returns an `Option`); a loop inside `Effect.gen` |
| `Effect.validateAll`, `Effect.validateFirst` | `Effect.validate`, `Effect.firstSuccessOf` |
| `Cause` as a tree (`Sequential`, `Parallel`, `Empty`) | **behavior:** a flat `cause.reasons` array of `Fail`, `Die`, `Interrupt`; `Cause.sequential` / `parallel` became `Cause.combine` |
| `Cause.isFailure`, `isDie`, `isInterrupted`, `isInterruptedOnly` | `Cause.hasFails`, `hasDies`, `hasInterrupts`, `hasInterruptsOnly` |
| `Cause.failureOption`, `failureOrCause`, `dieOption` | `Cause.findErrorOption`, and `Cause.findError` / `Cause.findDefect`, which return a `Result` |
| `Cause.NoSuchElementException`, `TimeoutException`, `UnknownException`, … | `Cause.NoSuchElementError`, `TimeoutError`, `UnknownError`, … (`*Exception` became `*Error`) |
| `Exit.causeOption`, `Exit.isInterrupted` | `Exit.getCause`, `Exit.hasInterrupts` |
| `Runtime.FiberFailure` thrown by runners | removed; use an `Exit`-returning runner, or `Cause.squash` when a value must be thrown |

New in v4: `Effect.catchReason` / `Effect.catchReasons` handle one `reason` inside a tagged error without removing the parent from `E`. Handbook pages: [Errors, Option & Result](../foundations/errors-option-result), [Failure, Retry, Fallback, and Interruption](../deep-dives/failure-retry-fallback-and-interruption).

### Fibers, runtime, and yieldability

| Effect 3 | Effect 4 |
| --- | --- |
| `Effect.fork`, `Effect.forkDaemon` | `Effect.forkChild`, `Effect.forkDetach`; `forkScoped` and `forkIn` are unchanged; all accept `{ startImmediately, uninterruptible }` |
| `Effect.forkAll`, `Effect.forkWithErrorHandler` | removed: fork individually, observe with `Fiber.join` / `Fiber.await` |
| `yield* fiber`, `yield* ref`, `yield* deferred`, `yield* queue` | **behavior:** none of these is an Effect any more. Use `Fiber.join(fiber)`, `Ref.get(ref)`, `Deferred.await(deferred)`, `Queue.take(queue)`. |
| `yield* option`, `yield* either` inside `Effect.gen` | `yield* Effect.fromOption(option)`, `yield* Effect.fromResult(result)` (see the correction above) |
| `Effect.gen(function*(_) { yield* _(effect) })`, `Effect.gen(this, function*() {})` | `yield* effect`; `Effect.gen({ self: this }, function*() {})` |
| `Effect.async`, `Effect.asyncEffect` | `Effect.callback` |
| `Effect.makeSemaphore`, `Effect.makeLatch` | `Semaphore.make`, `Latch.make` |
| `Effect.runtime<R>()` plus `Runtime.runFork(runtime)` | `Effect.context<R>()` plus `Effect.runForkWith(context)` |
| `FiberRef.get(FiberRef.currentLogLevel)`, `Effect.locally(effect, ref, value)` | `yield* References.CurrentLogLevel`, `Effect.provideService(effect, reference, value)` |
| `Scope.extend`, `Scope.CloseableScope` | `Scope.provide`, `Scope.Closeable` |
| `*.unsafeMake`, `Queue.unsafeOffer`, `Deferred.unsafeDone` | the `Unsafe` suffix moved to the end: `Ref.makeUnsafe`, `Queue.offerUnsafe`, `Deferred.doneUnsafe` |
| Process exits while a fiber is suspended unless `runMain` holds it open | **behavior:** the core runtime keeps the process alive. `NodeRuntime.runMain` is still the right entrypoint for signal handling, error reporting, and exit codes. |

Handbook pages: [Core Runtime & Execution](../foundations/core-runtime-execution), [References](../foundations/services-context-layers#references).

### Option, Result, Data, and equality

| Effect 3 | Effect 4 |
| --- | --- |
| `Either.right`, `Either.left`, `isRight`, `isLeft`, `mapLeft`, `getRight`, `getLeft` | `Result.succeed`, `Result.fail`, `isSuccess`, `isFailure`, `mapError`, `getSuccess`, `getFailure`; fields are `.success` / `.failure`; `match` takes `onSuccess` / `onFailure` |
| `Option.fromNullable`, `Either.fromNullable`, `Effect.fromNullable` | `Option.fromNullishOr`, `Result.fromNullishOr`, `Effect.fromNullishOr` |
| `Option.getEquivalence`, `Option.getOrder` | `Option.makeEquivalence`, `Option.makeOrder` |
| `Data.struct`, `Data.tuple`, `Data.array`, `Data.case` | removed — plain objects, tuples, and arrays already compare structurally; keep `Data.Class`, `Data.TaggedClass`, `Data.TaggedError` |
| `Equal.equals({ a: 1 }, { a: 1 })` is `false` | **behavior:** `true`. `Equal.equals` is structural for plain objects, arrays, `Map`, `Set`, and `Date`, and `NaN` equals `NaN`. Opt out with `Equal.byReference`. `Equal.equivalence` became `Equal.asEquivalence`. |

### Config, secrets, and logging

| Effect 3 | Effect 4 |
| --- | --- |
| `Config.string`, `number`, `integer`, `boolean`, `duration`, `port`, `url`, `logLevel`, `nonEmptyString` | PascalCase constructors: `Config.String`, `Number` (or `Finite`), `Int`, `Boolean`, `Duration`, `Port`, `URL`, `LogLevel`, `NonEmptyString` |
| `Config.secret`, `Config.redacted`; `Secret.Secret` | `Config.Redacted`; `Redacted.Redacted<string>` |
| `Config.literal("a", "b")("NAME")`, `Config.array(config, "NAME")` | `Config.Literals(["a", "b"], "NAME")`, `Config.Array(schema, "NAME")` |
| `Config.mapAttempt`, `Config.mapOrFail`, `Config.validate`, `Config.withDescription` | `Config.mapEffect`; `Config.schema(schema.check(...), "NAME")`; `Config.schema(schema.annotate({ description }), "NAME")` |
| `ConfigError` ADT (`MissingData`, `InvalidData`, `And`, `Or`) | one `Config.ConfigError` class whose `cause` is a `ConfigProvider.SourceError` or a `Schema.SchemaError` |
| `Logger.json`, `Logger.pretty`, `Logger.logFmt`, `Logger.structured` | `Logger.layer([Logger.consoleJson, Logger.tracerLogger])` and friends. **behavior:** `Logger.layer` replaces the whole logger set, so list `Logger.tracerLogger` to keep log events on spans. |
| `Logger.minimumLogLevel(level)`, `Logger.add`, `Logger.replace` | `Layer.succeed(References.MinimumLogLevel, level)`; `Logger.layer([logger], { mergeWithExisting: true })`; `Logger.layer([...])` |
| `Metric.tagged`, `Metric.increment`, `Metric.set` | `Metric.withAttributes`, `Metric.update` (counters, gauges) and `Metric.modify` (relative gauge change) |

Handbook pages: [Configuration & Secrets](../foundations/configuration-secrets), [Observability](../operations/observability).

### Schema constructors, filters, and transformations

| Effect 3 | Effect 4 |
| --- | --- |
| `Schema.Union(A, B)`, `Tuple(A, B)`, `Literal("a", "b")`, `Record({ key, value })` | `Schema.Union([A, B])`, `Tuple([A, B])`, `Literals(["a", "b"])`, `Record(key, value)` |
| `Schema.decodeUnknown`, `decode`, `encode`, `decodeUnknownEither` | `Schema.decodeUnknownEffect`, `decodeEffect`, `encodeEffect`, `decodeUnknownExit`; the `Sync`, `Option`, and `Promise` runners keep their names |
| `Schema.compose(B)`, `Schema.transform(from, to, { decode, encode })` | `Schema.decodeTo(B)`, `from.pipe(Schema.decodeTo(to, SchemaTransformation.transform({ decode, encode })))` |
| `Schema.transformOrFail` with `ParseResult.fail` | `Schema.decodeTo(to, { decode: SchemaGetter.transformEffect(...), encode })`, failing with a `SchemaIssue` such as `new SchemaIssue.InvalidValue(...)` |
| `Schema.filter(predicate)`, `Schema.filter(refinement)`, `Schema.filterEffect` | `schema.check(Schema.makeFilter(predicate))`, `Schema.refine(refinement)`, `Schema.decode({ decode: SchemaGetter.checkEffect(...), encode: SchemaGetter.passthrough() })` |
| `Schema.pattern(r)`, `minLength`, `greaterThan`, `between`, `int`, `nonEmptyString` | `schema.check(Schema.isPattern(r))`, `isMinLength`, `isGreaterThan`, `isBetween`, `isInt`, `isNonEmpty`; `positive`, `negative`, `nonNegative` were removed |
| `Schema.pick("a")`, `omit("a")`, `partial`, `extend(B)` | `schema.mapFields(Struct.pick(["a"]))`, `Struct.omit`, `Struct.map(Schema.optional)`, `Struct.assign(fieldsB)` (or `Schema.fieldsAssign`) |
| `Schema.optionalWith(s, { exact: true })`, `{ default }` | `Schema.optionalKey(s)`, `s.pipe(Schema.withDecodingDefaultType(...))` |
| `Schema.Date` (ISO string to `Date`), `DateFromSelf`, `DateFromNumber` | **behavior:** `Schema.DateFromString`, `Schema.Date`, `Schema.DateFromMillis`. v4 `Schema.Date` expects a `Date` instance, and old code still type-checks while rejecting every string. |
| other `*FromSelf` schemas; `Schema.Redacted`; `Schema.Either` | the suffix is dropped (`Schema.Option`, `Schema.Duration`, `Schema.BigInt`, …); `Schema.RedactedFromValue` (v4 `Schema.Redacted` is the old `RedactedFromSelf`); `Schema.Result` |
| `Schema.parseJson(S)`, `annotations(a)`, `typeSchema`, `encodedSchema`, `asserts(S)(u)` | `Schema.fromJsonString(S)`, `annotate(a)`, `toType`, `toEncoded`, `asserts(S, u)` |
| `Schema.equivalence`, `pretty`, `standardSchemaV1`, `arbitrary` | `Schema.toEquivalence`, `toFormatter`, `toStandardSchemaV1`; `Arbitrary.schema` from `effect/unstable/arbitrary` |
| `Schema.TaggedRequest` | removed; define RPC requests with `Rpc.make` from `effect/unstable/rpc` |
| `Schema.validate*`, `Schema.keyof`, `Schema.Data`, `ParseResult.ArrayFormatter` | removed; decode and project with `toType`, and format issues with `SchemaIssue.makeFormatterDefault` or `makeFormatterStandardSchemaV1` |

`Schema.Class`, `Schema.TaggedClass`, `Schema.TaggedError`, `Schema.Struct`, `Schema.brand`, and `Schema.optional` keep their names. Two rc.113 changes matter if you upgraded from an early v4 beta: the parse option `onExcessProperty: "preserve"` no longer exists, and generated JSON Schema is open (`additionalProperties: true`) unless you pass `{ onExcessProperty: "error" }`. Handbook pages: [Schema](../data/schema), [Schema — From External Input to Domain and Back](../deep-dives/schema-from-external-input-to-domain-and-back).

### Schedule, Stream, and Queue

| Effect 3 | Effect 4 |
| --- | --- |
| `Schedule.intersect`, `Schedule.union`, `Schedule.andThen` | `Schedule.max` (slowest delay), `Schedule.min` (fastest delay), `Schedule.concat` |
| `Schedule.whileInput` / `whileOutput` / `untilInput` / `recurWhile`, `tapInput` / `tapOutput`, `recurUpTo` | `Schedule.while` (predicate over `metadata.input` and `metadata.output`), `Schedule.tap`, `Schedule.during` |
| `Stream.async` / `asyncPush` / `asyncScoped`, `catchAll`, `either`, `unwrapScoped` | `Stream.callback`, `Stream.catch`, `Stream.result`, `Stream.unwrap` |
| `Stream.fromChunk`, `mapChunks`, `flattenChunks`, `repeatEffect` | `Stream.fromArray`, `mapArray`, `flattenArray`, `fromEffectRepeat`. **behavior:** `Stream.runCollect` returns an `Array`, not a `Chunk`. |
| `Mailbox.make(capacity)`, `Queue.backPressureStrategy()` | `Queue.make({ capacity, strategy })` with `"suspend"`, `"dropping"`, or `"sliding"` |

Handbook pages: [Scheduling & Time](../concurrency/scheduling-time), [Streaming & Channels](../concurrency/streaming-channels), [Concurrency & Coordination](../concurrency/concurrency-coordination).

### Testing, CLI, and platform

| Effect 3 | Effect 4 |
| --- | --- |
| `it.scoped`, `it.scopedLive` | `it.effect`, `it.live` — both provide a `Scope` |
| `TestContext.TestContext` | provided by `it.effect` (a `TestClock` and a `TestConsole`); by hand, `Layer.mergeAll(TestConsole.layer, TestClock.layer())` |
| `import { TestClock } from "effect"` | `import { TestClock } from "effect/testing"` |
| raw fast-check arbitraries in `it.prop`, `{ fastCheck: { numRuns } }` | Schemas or native `Arbitrary` values, `{ arbitrary: { runs } }`; `Arbitrary.sampleEffect` and `Arbitrary.checkEffect` replace `FastCheck.sample` and `FastCheck.assert` |
| `@effect/cli` `Args`, `Options`, `ValidationError`, `BuiltInOptions` | `Argument`, `Flag`, `CliError`, `GlobalFlag` from `effect/unstable/cli` |
| `Options.text`, `integer`, `float`, `choice`; `Args.text`, `Args.repeated`; `Prompt.text` | `Flag.String`, `Int`, `Finite`, `Literals`; `Argument.String`, `Argument.variadic`; `Prompt.String` |
| `Options.repeated` | `Flag.atLeast(n)`, `Flag.atMost(n)`, or `Flag.between(min, max)` — the upstream rename map says `Flag.variadic`, which `rc.115` does not export (`variadic` exists on `Argument` only) |
| `Options.boolean("dry-run")` defaults to `false` | **behavior:** a bare `Flag.Boolean("dry-run")` is required; add `Flag.withDefault(false)` |
| `CliApp.make` and `CliApp.run`; a `Command.run` that is handed `argv` | `Command.make` plus `Command.withHandler`, then `Command.run` (reads arguments from `Stdio`) or `Command.runWith` (accepts an argv array) |
| `NodeContext.layer` | `NodeServices.layer` — adds `Crypto` and `Stdio`, replaces `CommandExecutor` with `ChildProcessSpawner`, and no longer includes the worker manager |

`@effect/vitest` now requires Vitest 5 (`>=5.0.0 <6.0.0`). Handbook pages: [Testing & Dev Tooling](../tooling/testing-dev-tooling), [CLI Framework](../tooling/cli-framework), [Platform & Runtime Hosts](../interfaces/platform-runtime-hosts), [HTTP Client](../interfaces/http-client), [HTTP Server](../interfaces/http-server), [RPC](../interfaces/rpc), [SQL](../interfaces/sql).

## One service, before and after

```diff
-import { Config, Context, Data, Effect, Layer } from "effect"
+import { Config, Context, Data, Effect, Fiber, Layer } from "effect"

 class HrisUnavailable extends Data.TaggedError("HrisUnavailable")<{ readonly employeeId: string }> {}

-class Hris extends Context.Tag("comp/Hris")<Hris, {
-  readonly salary: (employeeId: string) => Effect.Effect<number, HrisUnavailable>
-}>() {}
+class Hris extends Context.Service<Hris, {
+  readonly salary: (employeeId: string) => Effect.Effect<number, HrisUnavailable>
+}>()("comp/Hris") {}

-const HrisLive = Layer.scoped(Hris, Effect.gen(function*() {
-  const url = yield* Config.string("HRIS_URL")
+const HrisLive = Layer.effect(Hris, Effect.gen(function*() {
+  const url = yield* Config.String("HRIS_URL")
   const connection = yield* Effect.acquireRelease(connect(url), (c) => c.close)
   return Hris.of({ salary: (employeeId) => connection.salary(employeeId) })
 }))

 const program = Effect.gen(function*() {
   const hris = yield* Hris
-  const fiber = yield* Effect.fork(hris.salary("e-1"))
-  return yield* fiber
+  const fiber = yield* Effect.forkChild(hris.salary("e-1"))
+  return yield* Fiber.join(fiber)
 }).pipe(
-  Effect.catchAll((error) => Effect.logWarning("HRIS unavailable", error).pipe(Effect.as(0)))
+  Effect.catch((error) => Effect.logWarning("HRIS unavailable", error).pipe(Effect.as(0)))
 )
```

## Upgrade order

1. **Inventory before editing.** List every `effect` and `@effect/*` dependency, every import path, and every place that relies on a row marked **behavior** above: repeated `Effect.provide` calls, `Cause` traversal, `Equal.equals` on plain data, `Schema.Date`, logger installation, boolean CLI flags, and code that runs without `runMain`.
2. **Prepare on Effect 3.** Several v4 spellings already work in v3: read state through `Ref.get`, `Deferred.await`, and `Fiber.join` instead of yielding the handle; drop the generator adapter; replace `Secret` with `Redacted`; stop using `Effect.Tag` accessors. Each of these shrinks the upgrade diff and ships on its own.
3. **Move every package in one commit.** Remove the merged packages, pin `effect` and all remaining `@effect/*` packages to one exact v4 version, and confirm a single copy of `effect` is installed. A half-upgraded dependency graph cannot type-check.
4. **Fix compile errors leaf-first**, in dependency order: import paths; pure data (`Either` to `Result`, `Option` renames, `Data`); error handling and `Cause`; services and Layers; `Config`; `Schema`; fibers, queues, and transactions; the unstable families (HTTP, RPC, SQL, CLI); tests last, because they exercise everything else.
5. **Do not buy a green build.** No compatibility module that re-exports old names, no `as` casts, no widened `E` or `R` to make an error disappear. Each one hides exactly the information the migration exists to recover.
6. **Walk the behavior rows** from step 1 with a test for each before calling it done.

## How to verify

"It type-checks", "the tests pass", and "the behavior is verified" are three different claims; a migration needs all three.

- **Strict compile.** `tsc --noEmit` with `strict` and `exactOptionalPropertyTypes`, with zero `@ts-expect-error` added during the migration.
- **Effect diagnostics.** Run `effect-tsgo diagnostics --project tsconfig.json --strict`. The language service has rules aimed at this migration — APIs removed or renamed in v4, the generator adapter, a second copy of an Effect package, chained `Effect.provide` calls — alongside its everyday checks for floating Effects and leaked requirements. Setup is in [Getting Started](../foundations/getting-started).
- **Behavior tests for the semantic changes.** Count Layer acquisitions instead of assuming sharing. Assert on `Exit` and `Cause` structure rather than rendered text. Decode a real ISO string through every date schema. Start the CLI without its boolean flags. Send `SIGTERM` to the process and check that finalizers ran.
- **Widen in rings.** Pure modules, then services with test Layers, then real adapters, then the assembled application, then the built artifact. Each ring proves only itself.

When a symptom does not match a row here, continue in [Troubleshooting & Anti-Patterns](troubleshooting-and-anti-patterns); for the review pass at the end, use the [Review Checklists](../reference/review-checklists).
