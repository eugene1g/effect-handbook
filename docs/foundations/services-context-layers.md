# Services, Context & Layers

The `R` in `Effect<A, E, R>` is a typed set of required services. **Context** holds those services, **Layer** is the recipe for constructing them (with dependencies and lifecycles), and the runtime blocks execution until every requirement is satisfied.

> **Official examples:** Effect's release-matched [`ai-docs` service examples](https://github.com/Effect-TS/effect/tree/effect%404.0.2/ai-docs/src/01_effect/03_services) cover `Context.Service`, `Context.Reference`, Layer composition, and dynamically constructed Layers.

> **Official guides:** [Managing Services](https://effect.website/docs/v4/requirements-management/services). These track Effect's `main` branch rather than the tagged `4.0.2` release, so where they differ, this page and the tagged source win.

![Diagram: Layers build dependencies first (Config, Database, Repository, HttpServer), the program runs with the services, and teardown releases them in reverse order](/diagrams/layer-build-teardown.svg)

_A Layer graph builds dependencies first and each Layer once per memo map; when the owning Scope closes, everything it built is released in reverse order._

## Context

`effect/Context` — stable

A type-safe, immutable map from service tags to implementations. Declare services with `Context.Service` to get the tag, the accessor, and a default layer attachment point; the type system tracks requirements in `R`.

**Mental model.** A `Map<Tag, Impl>` whose keys are tracked at the type level, so requirements accumulate in `R` until provided.

Contexts are implemented as immutable overlays: `Context.add` is constant-time and later bindings shadow earlier ones; `Context.get` also resolves a `Context.Reference`'s default. Compose through public `add`, `merge`, `pick`, and `omit` operations—the old mutation and unsafe-reference internals are not public APIs.

```ts
import { Context, Effect, Layer, Schema } from "effect"

// Define a tagged error for HRIS connectivity failures.
class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {
  reason: Schema.String
}) {}

// The canonical v4 service: a class extending Context.Service.
class Hris extends Context.Service<Hris, {
  readonly getEmployee: (id: string) => Effect.Effect<
    { id: string; name: string; level: number; baseSalary: bigint; departmentId: string },
    HrisUnavailable
  >
  readonly listDepartmentEmployees: (departmentId: string) => Effect.Effect<
    ReadonlyArray<{ id: string; name: string; level: number }>,
    HrisUnavailable
  >
}>()("hr/Hris") {
  // Hang the implementation on a static layer.
  static readonly layer = Layer.effect(Hris, Effect.gen(function*() {
    yield* Effect.log("connecting to HRIS")
    return Hris.of({
      getEmployee: (id) =>
        Effect.succeed({ id, name: "Alice Nguyen", level: 4, baseSalary: 145000n, departmentId: "eng" }),
      listDepartmentEmployees: (departmentId) =>
        Effect.succeed([{ id: "e1", name: "Alice Nguyen", level: 4 }])
    })
  }))
}

// Consume it: `yield* Hris` reads it from context; R now includes Hris.
const getEngineeringHeadcount = Effect.gen(function*() {
  const hris = yield* Hris
  const employees = yield* hris.listDepartmentEmployees("eng")
  return employees.length
})
```

Use when defining any injectable capability.

> **Note:** The string key (`"hr/Hris"`) is the runtime identity: two classes that share a key resolve to the same context entry, so keep keys unique across the application and its libraries — a `package/Name` prefix is the usual convention.

### Reading a service

`yield* Service` inside `Effect.gen` is the default. Every service class also carries two static accessors for single calls: `Service.use(f)` resolves the service and runs an effect-returning callback, and `Service.useSync(f)` does the same for a pure projection. All three forms add the service to `R`.

```ts
import { Context, Effect } from "effect"

class CompBands extends Context.Service<CompBands, {
  readonly bandFor: (level: number) => Effect.Effect<{ readonly min: bigint; readonly max: bigint }>
  readonly currency: string
}>()("hr/CompBands") {}

// Effect<{ min; max }, never, CompBands>
const levelFourBand = CompBands.use((bands) => bands.bandFor(4))

// Effect<string, never, CompBands>
const currency = CompBands.useSync((bands) => bands.currency)

// Recover the implementation type for helper signatures and test doubles.
type CompBandsShape = Context.Service.Shape<typeof CompBands>
declare const auditBands: (bands: CompBandsShape) => Effect.Effect<void>
```

Use `use` for one-liners and adapters such as `runtime.runPromise(CompBands.use(...))`; inside a larger generator, `yield*` reads better and resolves the service once.

### Designing a service contract

The service shape is the part of a capability that every caller, fake, and future implementation must agree on. Decide it before writing a Layer.

- **Name the service for a business capability and its methods with domain verbs** — `RaiseApprovals.submit` tells a reviewer what may happen; `Manager.execute` or generic CRUD hides it.
- **Every method returns an `Effect` whose `E` lists the expected failures, and no method throws** — a `throw` inside a method body becomes a defect, so an upstream `Effect.catchTag` never sees it. Fakes obey the same rule (`Effect.fail(new HrisUnavailable(...))`, not `throw`); otherwise tests exercise a different failure channel than production.
- **Public methods have `R = never`** — configuration, clients, other services, and `Scope` are construction needs, so they belong to the Layer's inputs. A method typed `Effect<A, E, PayrollClient>` forces every caller and every test to provide `PayrollClient`, and an implementation that does not need it becomes a breaking change.
- **Do not leak the implementation through parameters or fields** — no transaction handle, SQL client, logger, mutable state, or concrete class in the shape. If callers must pass one, the boundary is in the wrong place.
- **One service per capability, not per method** — split when consumers use unrelated halves or implementations vary independently, not to make mocking easier.

Before adding a boundary, ask: which capability is this, which decisions hide behind it, would two honest implementations obey one contract, is substitution valuable (test, tenant, vendor), and does it point dependencies the right way? If most answers are "no", a plain function is enough.

```ts
import { Context, Effect, Layer, Schema } from "effect"

class PayrollRejected extends Schema.TaggedError<PayrollRejected>()("PayrollRejected", {
  employeeId: Schema.String
}) {}

class PayrollClient extends Context.Service<PayrollClient, {
  readonly post: (employeeId: string, amount: bigint) => Effect.Effect<void, PayrollRejected>
}>()("hr/PayrollClient") {}

class AuditLog extends Context.Service<AuditLog, {
  readonly record: (entry: string) => Effect.Effect<void>
}>()("hr/AuditLog") {}

// Leaky shape — every caller of `apply` would have to provide PayrollClient:
//   readonly apply: (...) => Effect.Effect<void, PayrollRejected, PayrollClient>

class RaiseApprovals extends Context.Service<RaiseApprovals, {
  // Business input, business failure, R = never.
  readonly apply: (employeeId: string, amount: bigint) => Effect.Effect<void, PayrollRejected>
}>()("hr/RaiseApprovals") {
  static readonly layer = Layer.effect(RaiseApprovals, Effect.gen(function*() {
    // Construction dependencies are captured once, here.
    const payroll = yield* PayrollClient
    const audit = yield* AuditLog
    return RaiseApprovals.of({
      apply: Effect.fn("RaiseApprovals.apply")(function*(employeeId: string, amount: bigint) {
        yield* payroll.post(employeeId, amount)
        yield* audit.record(`raise applied for ${employeeId}`)
      })
    })
  }))
}

// The Layer's inputs list what construction needs; the method's type does not.
const checked: Layer.Layer<RaiseApprovals, never, PayrollClient | AuditLog> = RaiseApprovals.layer
```

Review question: does any public method make its caller provide something only the implementation needs? If so, move that dependency into the Layer constructor.

### Providing one value or building a graph

Pick the cheapest seam that fits the implementation. **Move to a Layer as soon as the implementation needs state, configuration, an effectful constructor, other services, or a lifetime.**

| Seam | Use it when | Effect on `R` |
| --- | --- | --- |
| `Effect.provideService(Service, value)` | The implementation already exists as a value: a focused unit-test fake, a script, a per-request value set by middleware. | Removes exactly one identifier per call, so the type shows what is still unwired. |
| `Effect.provide(context)` | Several ready values travel together; build the bundle with `Context.make(A, a).pipe(Context.add(B, b))`. | Removes every key in the `Context`. |
| A test Layer (`Layer.succeed`, `Layer.effect`, `Layer.mock`) | The fake needs state, a constructor effect, or one shared instance for a whole test. | Removes the Layer's outputs and adds its inputs. |
| The live graph | The application edge: one composed Layer, provided once. | Closes `R` to `never`. |

```ts
import { Context, Effect, Schema } from "effect"

class HrisUnavailable extends Schema.TaggedError<HrisUnavailable>()("HrisUnavailable", {
  reason: Schema.String
}) {}

class Directory extends Context.Service<Directory, {
  readonly managerOf: (employeeId: string) => Effect.Effect<string, HrisUnavailable>
}>()("hr/Directory") {}

class Notifier extends Context.Service<Notifier, {
  readonly notify: (employeeId: string, message: string) => Effect.Effect<void>
}>()("hr/Notifier") {}

const notifyManager = Effect.fn("notifyManager")(function*(employeeId: string) {
  const directory = yield* Directory
  const notifier = yield* Notifier
  const manager = yield* directory.managerOf(employeeId)
  yield* notifier.notify(manager, `raise pending for ${employeeId}`)
})

// One value at a time: R shrinks from Directory | Notifier to Notifier to never.
const withDirectory = notifyManager("e42").pipe(
  Effect.provideService(Directory, Directory.of({ managerOf: () => Effect.succeed("m7") }))
)
const closed = withDirectory.pipe(
  Effect.provideService(Notifier, Notifier.of({ notify: () => Effect.void }))
)

// A failing fake still uses the typed channel.
const hrisDown = Directory.of({
  managerOf: () => Effect.fail(new HrisUnavailable({ reason: "maintenance window" }))
})

// Several ready values as one Context.
const fakes = Context.make(Directory, hrisDown).pipe(
  Context.add(Notifier, Notifier.of({ notify: () => Effect.void }))
)
const closedWithContext = Effect.provide(notifyManager("e42"), fakes)
```

**Provide live implementations only at application or module edges, and fakes only at test edges.** An `Effect.provide(PayrollClient.layer)` or `Effect.provideService(PayrollClient, liveClient)` buried inside a reusable function makes `R` look clean while hard-wiring production I/O: tests silently reach the network, callers cannot substitute a recorder or a retrying client, and each call is its own Layer build (see [What is shared, and what is rebuilt](#what-is-shared-and-what-is-rebuilt)). It is the Effect spelling of `new HttpClient()` inside a function body.

### Optional services

`Effect.serviceOption(Service)` returns `Effect<Option<Shape>>` and does **not** add the service to `R`. Use it for a capability the host may or may not install — an audit sink, a plugin, a telemetry hook — and handle both branches. Contrast it with a [`Context.Reference`](#references), which is always present because it has a default. The trade-off is that the compiler will not remind anyone to provide an optional service.

```ts
import { Context, Effect, Option } from "effect"

class AuditSink extends Context.Service<AuditSink, {
  readonly write: (event: string) => Effect.Effect<void>
}>()("hr/AuditSink") {}

// Effect<void, never, never> — AuditSink is not a requirement.
const recordApproval = Effect.gen(function*() {
  const sink = yield* Effect.serviceOption(AuditSink)
  if (Option.isSome(sink)) {
    yield* sink.value.write("raise-approved")
  }
})
```

### Declaring the constructor with `make`

`Context.Service<Self>()("key", { make })` infers the shape from the `make` effect and exposes it as a static, so the usual pair of Layers is one line each. Upstream code and the rest of this handbook use both styles; they produce the same kind of key.

```ts
import { Context, Effect, FileSystem, Layer } from "effect"

class OfferLetterTemplates extends Context.Service<OfferLetterTemplates>()("hr/OfferLetterTemplates", {
  make: Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return {
      load: (name: string) => fs.readFileString(`templates/${name}.html`)
    } as const
  })
}) {
  // Layer<OfferLetterTemplates, never, FileSystem> — dependencies still open.
  static readonly layerNoDeps = Layer.effect(this, this.make)
}
```

Name the dependency-free Layer `layerNoDeps` and reserve `layer` for the variant with its unambiguous production dependencies provided. (The official guides call the first one `layerWithoutDependencies`; it is a naming convention, not an API.) Prefer the explicit shape parameter, as in `Hris` above, when the contract should be reviewed separately from any implementation.

> **Note:** A few unstable library services — `LanguageModel`, `EmbeddingModel`, `Chat`, and `Reactivity` — have branded shapes that carry a `[TypeId]` field. Build custom implementations and fakes with the module's own constructors (for example `LanguageModel.make`) rather than an object literal, so the brand is present.

## Layer

`effect/Layer` — stable

A recipe that builds one or more services (possibly from other services) with acquisition and release. Layers are *memoized* and composed into a single dependency graph.

**Mental model.** A constructor with a lifecycle. `Layer.effect(Tag, build)` builds a service from an effect; if `build` uses `acquireRelease`, the layer manages cleanup. Wire layers with:

| Combinator | Use it to |
| --- | --- |
| `Layer.effect` / `succeed` / `sync` | Build a service from an effect / a ready value / a thunk. |
| `Layer.provide(dep)` | Satisfy a layer's dependencies — **without** re-exposing them to the rest of the app. |
| `Layer.provideMerge(dep)` | Same, but ALSO keep `dep` in the output (expose it upward). |
| `Layer.merge` / `mergeAll` | Combine independent layers side by side. |
| `Layer.unwrap` | Build a layer dynamically from an `Effect`/`Config`. |
| `Layer.effectDiscard` | Run a background/side-effecting layer with no service output. |
| `Layer.launch` | Turn a layer into a long-running program (your app entry point). |
| `Layer.tap` / `tapError` / `tapCause` | Observe a successful build (receives the built `Context`) or a failed one, without changing what the layer provides. |
| `Layer.catch` / `catchTag` / `catchCause` / `orDie` | Recover construction with a fallback layer, or turn a startup failure into a defect. |
| `Layer.fresh` | Build a private copy of a layer and its dependencies, outside the shared memo map. |
| `Layer.build` | Build a layer into a `Context` value for inspection or manual wiring. The result requires `Scope`, and the built services live only until that scope closes — use the `Context` inside the same `Effect.scoped` region. |
| `Layer.withSpan(name, options?)` | Trace a layer: the span starts with construction and ends when the layer's scope closes; `onEnd` receives the span and the scope's `Exit`. The usual span options apply in both call forms, including `captureStackTrace` (`false`, or a lazy stack string that points at your call site). |

Read a layer type as `Layer<Provides, ConstructionError, Requires>`. A composed application layer should end with `Requires = never`.

Memoization is by **Layer object identity within a build/MemoMap**. Reuse one named layer value when two branches must share one pool or resource; reconstructing an equivalent layer expression creates a different identity. `merge` / `mergeAll` build independent branches concurrently and share any repeated dependency value. `Layer.fresh(layer)` deliberately opts out and builds a separate instance.

For tests, `Layer.mock(Service, partial)` lets you provide only the effectful methods a test uses; an omitted Effect/Stream/Channel method dies with `UnimplementedError`, while ordinary non-effect fields remain required. Layer construction failures can be handled before wiring with `catchTag`, `catchCause`, or `orDie`. The advanced `makeMemoMap`, `forkMemoMap`, and `buildWithMemoMap` APIs support dynamic runtimes: a child memo map can reuse parent entries while keeping its new allocations isolated.

```ts
import { Config, Effect, Layer } from "effect"

// CompService depends on Hris and a config-driven PayrollClient.
// Provide Hris beneath CompService; PayrollClient is wired separately.
// The app only sees CompService + ReviewService in its R.
const AppLayer = Layer.mergeAll(
  CompService.layer.pipe(Layer.provide(Hris.layer)),
  ReviewService.layer.pipe(Layer.provide(Hris.layer))
)

// Layer.unwrap: choose which HRIS layer to build based on config.
const HrisLayer = Layer.unwrap(
  Effect.gen(function*() {
    const useSandbox = yield* Config.Boolean("HRIS_SANDBOX").pipe(Config.withDefault(false))
    return useSandbox ? Hris.layerSandbox : Hris.layer
  })
)

// Run the compensation-planning server as the application entry point.
const main = Layer.launch(CompPlanningServer.pipe(Layer.provide(AppLayer)))
```

Use when assembling a dependency graph or tying acquisition/release to a service's lifetime.

Official guides: [Managing Layers](https://effect.website/docs/v4/requirements-management/layers) (it names the dependency-free Layer `layerWithoutDependencies`; the actual property is `layerNoDeps`), [Layer Memoization](https://effect.website/docs/v4/requirements-management/layer-memoization) (its "providing locally" section describes only the sibling case; nested reuse and `{ local: true }` are covered below).

### Resourceful services

A service that owns a connection, pool, subscription, or background fiber is built with `Layer.effect(Service, Effect.gen(...))` whose constructor yields `Effect.acquireRelease(open, close)`. `acquireRelease` requires `Scope`, and `Layer.effect` returns `Layer<I, E, Exclude<R, Scope>>`: the layer build owns that scope, so callers depend on the capability while the Layer owns the client's lifetime.

```ts
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"

class PayrollUnavailable extends Schema.TaggedError<PayrollUnavailable>()("PayrollUnavailable", {
  reason: Schema.String
}) {}

interface PayrollConnection {
  readonly submit: (runId: string) => Promise<void>
  readonly close: () => Promise<void>
}
declare const connectPayroll: (url: URL, token: string) => Promise<PayrollConnection>

class PayrollGateway extends Context.Service<PayrollGateway, {
  readonly submitRun: (runId: string) => Effect.Effect<void, PayrollUnavailable>
}>()("hr/PayrollGateway") {
  // Layer<PayrollGateway, PayrollUnavailable | ConfigError> — no Scope in the inputs.
  static readonly layer = Layer.effect(PayrollGateway, Effect.gen(function*() {
    const url = yield* Config.URL("PAYROLL_URL")
    const token = yield* Config.Redacted("PAYROLL_TOKEN")
    const connection = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => connectPayroll(url, Redacted.value(token)),
        catch: (cause) => new PayrollUnavailable({ reason: String(cause) })
      }),
      (open) => Effect.promise(() => open.close())
    )
    return PayrollGateway.of({
      submitRun: (runId) =>
        Effect.tryPromise({
          try: () => connection.submit(runId),
          catch: (cause) => new PayrollUnavailable({ reason: String(cause) })
        })
    })
  }))
}
```

- **`Layer.succeed` packages a finished value, so it cannot express teardown.** Anything that must be closed needs `Layer.effect` with a scoped constructor.
- **There is no `Layer.scoped`.** `Layer.effect` already handles a `Scope` requirement.
- **Match the resource's lifetime to the Layer's owner.** Building the client or repository stack inside a request handler closes correctly on every request and still turns a traffic spike into a connection spike. App-lifetime resources belong in the application graph; per-key resources belong in a [`LayerMap`](#layermap).

### What is shared, and what is rebuilt

A **memo map** records each layer value it has built and hands the same result to every later request for that value. Entries are reference-counted: when the last scope using one closes, the entry is removed and the layer's finalizers run. "Is this pool shared?" therefore means "do both requests reach the same memo map, with the same layer value, while the first build is still alive?"

Every `Effect.provide(layer)` builds with a memo map **forked from the fiber's current one** — the map installed by an enclosing layer build — or with a new map when there is none. A fork reads its parent's entries and writes only to itself. The following counts were measured with an acquisition counter:

| Situation | Builds of `PoolLive` | Why |
| --- | --- | --- |
| One build reaches the same layer value through several branches (`merge`, `provide`, `provideMerge`, or `Effect.provide([A, B])`) | 1 | One memo map, one identity. |
| Two equivalent layer *expressions* (a layer-returning function called twice, an inline `Layer.effect(...)` repeated) | 2 | Different identities. |
| Two sibling `Effect.provide(PoolLive)` calls — sequential or concurrent, even under a shared outer provide of *other* layers | 2 | Each call writes to its own fork, siblings never see each other's entries, and a sequential sibling has already released its pool. |
| `Effect.provide(PoolLive)` nested inside a region whose enclosing build already built `PoolLive`: an outer `Effect.provide`, a `ManagedRuntime`, or a chained `.pipe(Effect.provide(A), Effect.provide(B))` | 1 | The inner build finds the live entry in the parent map — even when the outer graph kept the pool private with `Layer.provide`. |
| The same nested provide with `{ local: true }` | 2 | A brand-new memo map: the whole provided graph, dependencies included, is rebuilt and then released when that effect ends. |
| `Layer.fresh(layer)` inside a build | one more | The wrapped layer is built with a new memo map, so it and its dependencies are private to that branch. |

```ts
import { Context, Effect, Layer } from "effect"

class PayrollPool extends Context.Service<PayrollPool, { readonly id: number }>()("hr/PayrollPool") {}

let opened = 0
const PayrollPoolLive = Layer.effect(
  PayrollPool,
  Effect.acquireRelease(
    Effect.sync(() => ({ id: ++opened })),
    () => Effect.log("pool closed")
  )
)
const poolId = PayrollPool.useSync((pool) => pool.id)

// Siblings: two builds, two pools — [1, 2].
const siblings = Effect.all([
  Effect.provide(poolId, PayrollPoolLive),
  Effect.provide(poolId, PayrollPoolLive)
])

// The same two provides under one enclosing build reuse its pool — [1, 1].
const nested = siblings.pipe(Effect.provide(PayrollPoolLive))

// Deliberate isolation: a private pool, released when this effect ends.
const isolated = Effect.provide(poolId, PayrollPoolLive, { local: true })
```

- **Provide the application graph once, at the edge** (or build one [`ManagedRuntime`](fibers-scopes-runtimes#managedruntime)). "Build once, share, release at shutdown" comes from a single enclosing build, not from repeating `Effect.provide(sameLayer)` next to each use. A per-request or per-handler `Effect.provide(DbLive)` opens a pool per request.
- **Sharing is the resource-safety default.** Without it every dependent service would open its own client and register its own finalizer: a connection storm under load and more to unwind on failure.
- **A build that is interrupted still completes its memo-map entry.** Every requester already waiting on that layer value — including the one that triggered the build — receives the same interrupted `Exit` instead of hanging, and the shared entry is released once the owning scope closes.
- **`{ local: true }` and `Layer.fresh` are for required isolation** — per-tenant, per-test, or per-transaction resources. Never reach for them to silence a type error; they duplicate pools, caches, and subscriptions.
- **Test build-frequency claims.** Count acquisitions and assert `1` for a shared node and `n` only where isolation is intended. When you write "built once", name the scope and the memo map that make it true.

The `Effect.provide` API documentation says layers are "shared between provide calls" by default; that sentence describes the nested case in the table, not siblings. For dynamic runtimes, `Layer.makeMemoMap`, `Layer.forkMemoMap`, and `Layer.buildWithMemoMap` expose the same mechanism directly, and `ManagedRuntime.make(layer, { memoMap })` lets several runtimes share one map.

### Reading and composing the graph

Before composing, inventory each Layer: what it **provides**, what it **requires**, how often it should be **built**, and whether it is stateful, expensive, scoped, or deliberately fresh. Then apply one combinator at a time and restate the edge: required before, consumed by this step, still required, exposed.

| Step | Provides | Still requires |
| --- | --- | --- |
| `RaiseApprovals.layer` | `RaiseApprovals` | `PayrollClient`, `AuditLog` |
| `.pipe(Layer.provide(PayrollClient.layer))` | `RaiseApprovals` | `AuditLog`, plus whatever `PayrollClient.layer` requires |
| `.pipe(Layer.provideMerge(AuditLog.layer))` | `RaiseApprovals`, `AuditLog` | what `PayrollClient.layer` and `AuditLog.layer` require |

- **Keep feature graphs honestly open and close them only at the composition root.** A feature module exports a Layer that still requires the database or HTTP client; the root supplies them once.
- **Do not permute combinators until the compiler is quiet.** That can hide an output another branch needs or build an unintended topology. Read the remaining `Requires` and wire exactly that.
- **`Layer.merge` does not feed siblings.** A layer that must see another's output — including a `ConfigProvider`, logger, or tracer override — takes it through `Layer.provide` / `provideMerge`, not by sitting next to it.
- **Name feature Layers** (`const CompensationLive = ...`) so inferred types and error messages stay readable, and so the value has one identity to share.

### Observing and recovering construction

Layer construction is where startup failures surface: missing configuration, an unreachable database, a rejected credential. `Layer.tap` and `Layer.tapError` log those moments without changing the layer's type; `Layer.catch`, `catchTag`, and `catchCause` swap in a fallback layer; `Layer.orDie` declares the failure unrecoverable.

```ts
import { Context, Effect, Layer, Schema } from "effect"

class BandCatalogUnavailable extends Schema.TaggedError<BandCatalogUnavailable>()("BandCatalogUnavailable", {
  reason: Schema.String
}) {}

class BandCatalog extends Context.Service<BandCatalog, {
  readonly source: "remote" | "bundled-snapshot"
}>()("hr/BandCatalog") {}

declare const BandCatalogRemote: Layer.Layer<BandCatalog, BandCatalogUnavailable>
declare const BandCatalogSnapshot: Layer.Layer<BandCatalog>

// Layer<BandCatalog, never, never>
const BandCatalogLive = BandCatalogRemote.pipe(
  Layer.tapError((error) => Effect.logWarning("band catalog unreachable; serving bundled snapshot", error)),
  Layer.catchTag("BandCatalogUnavailable", () => BandCatalogSnapshot),
  Layer.tap((context) => Effect.logInfo(`band catalog ready: ${Context.get(context, BandCatalog).source}`))
)
```

A `tapError` / `tapCause` observer must accept the layer's complete error type; a callback typed for one member of the union does not compile. Make a fallback an explicit, logged decision like the one above — never recover from a configuration error by silently switching to fake infrastructure (see [Configuration & Secrets](configuration-secrets#deciding-required-optional-and-defaulted)).

### Test layers and substitution

The service-side rules are short; the strategy (stub, fake, recording fake, failure layer, contract suite) lives in [Testing & Dev Tooling](../tooling/testing-dev-tooling) and [Testing an Effect Application](../deep-dives/testing-an-effect-application).

- **A test implementation honors the production contract**, not just the happy value: same typed failures, same ordering and uniqueness guarantees the callers rely on. An always-succeeding fake cannot protect failure handling.
- **Keep fake state per test and observable through the fake itself** (a recorded-calls `Ref`, a probe service) rather than module-level variables shared across tests.
- **Prove the substitution.** A test Layer that is declared but never provided is a false green: assert on something only the fake can produce (a recorded call, a sentinel value), or make the live implementation unreachable in the fixture.
- **Remember that defaults hide missing wiring.** `ConfigProvider`, `Clock`, and the other [default services](#references) never appear in `R`, so forgetting to install a test override compiles and silently uses the real one.

## LayerMap

`effect/LayerMap` — unstable

A service that lazily builds, caches, and tears down layers keyed by a value. Creates resources on first use per key, releases them after an idle timeout.

**Mental model.** A `Map<Key, Layer>` with reference-counting and TTL: request key `k`, get its services; when `k` is idle long enough, its resources are finalized.

```ts
import { Effect, Layer, LayerMap } from "effect"

// One compensation-data layer per department, idle-collected after 5 minutes.
// CompData holds the department's comp bands and merit budget loaded from the HRIS.
class DeptCompData extends LayerMap.Service<DeptCompData>()("hr/DeptCompData", {
  lookup: (departmentId: string) =>
    CompBandLayer.pipe(Layer.provide(configForDepartment(departmentId))),
  idleTimeToLive: "5 minutes"
}) {}

// Process a merit-increase recommendation for an employee.
// LayerMap.Service.get(key) returns a Layer — use Effect.provide to run
// an effect with that department's comp-data context.
const processMeritRaise = Effect.fn("processMeritRaise")(
  function*(employeeId: string, departmentId: string) {
    const employee = yield* Effect.provide(
      lookupEmployee(employeeId),
      DeptCompData.get(departmentId)
    )
    return yield* Effect.provide(
      validateAgainstBand(employee),
      DeptCompData.get(departmentId)
    )
  }
)
```

Use when you need dynamic, per-key dependency graphs — multi-tenant apps, per-shard connections, or any resource set not known up front.

| Member | Behavior |
| --- | --- |
| `get(key)` | A Layer for that key's services; builds on first use and shares the entry while it is borrowed or within `idleTimeToLive`. |
| `contextEffect(key)` | The same entry as a scoped `Context` value, for manual wiring. |
| `contextEffectOption(key)` | Retains the entry **only if it is already cached** and returns `Option.none()` otherwise — no build is started, and an in-flight build is awaited. Use it for "flush this tenant's resources if they exist" paths. |
| `invalidate(key)` | Drops the entry; current borrowers keep their context until their scopes close. |
| `preloadKeys` / `preload: true` (`layers` form) | Builds those entries while the `LayerMap` layer itself is built, so a lookup failure also appears in the service layer's error type and fails startup; `get`, `contextEffect`, and `invalidate` keep the lookup error type as well. A key whose resolved `idleTimeToLive` is zero is skipped — including when no TTL was specified at all — so give preloaded keys an explicit, non-zero `idleTimeToLive` or they are built lazily on first use instead. |

All keys of one `LayerMap` build against a single memo map forked from the one that built the `LayerMap`, so a dependency layer value that several keys share — and anything the enclosing application build already constructed — is built once, not per key.

## LayerRef

`effect/LayerRef` — unstable

The unkeyed counterpart to `LayerMap`: a refreshable, reference-counted cache for one layer-built service context. `LayerRef.make(layer)` builds lazily on first scoped borrow, shares the context, optionally keeps it alive while idle, and lets you invalidate or refresh it. Existing borrowers keep their old context until their scopes close; the next borrow receives the rebuilt one.

```ts
import { Context, Effect, Layer, LayerRef } from "effect"

class CompBands extends Context.Service<CompBands, {
  readonly version: string
}>()("handbook/CompBands") {}

declare const loadVersion: () => string
const CompBandsLive = Layer.sync(CompBands, () => ({ version: loadVersion() }))

const program = Effect.scoped(Effect.gen(function*() {
  const bandsRef = yield* LayerRef.make(CompBandsLive, {
    idleTimeToLive: "5 minutes",
    preload: true
  })

  const readVersion = Effect.gen(function*() {
    return (yield* CompBands).version
  })

  const before = yield* Effect.provide(readVersion, bandsRef.get)
  yield* bandsRef.refresh
  const after = yield* Effect.provide(readVersion, bandsRef.get)
  return [before, after] as const
}))
```

For application wiring, `LayerRef.Service` creates a named service with static `.layer`, `.get`, `.contextEffect`, `.invalidate`, and `.refresh` helpers. Use `LayerRef` for one database pool, credential set, or catalog that must be shared yet rotated; use `LayerMap` when the same pattern is keyed by tenant or shard, and `Resource` when callers only need a value rather than a whole service context.

## References

`effect/References` — stable

The registry of built-in, fiber-scoped runtime settings: log annotations and levels, tracer flags/annotations/links, scheduler-yield controls, active loggers, and unhandled-error reporting. They are implemented as `Context.Reference`s — values with defaults that flow down the fiber tree and can be locally overridden.

**Mental model.** Dynamically-scoped configuration. Unlike a service (which must be provided), a reference always has a default; an override applies only to the wrapped effect and its child fibers.

```ts
import { Context, Effect, References } from "effect"

// Define an ambient review-cycle reference with a lazy default.
// v4 form: Context.Reference is a plain function — pass the key and options directly.
// Class-extension form keeps the ergonomics of yield* CurrentReviewCycle.
class CurrentReviewCycle extends Context.Reference("hr/CurrentReviewCycle", {
  defaultValue: () => ({ cycleId: "default", year: new Date().getFullYear(), phase: "planning" as const })
}) {}

const annotateMeritLog = Effect.gen(function*() {
  const cycle = yield* CurrentReviewCycle     // uses default unless overridden
  yield* Effect.log(`merit run for cycle=${cycle.cycleId} phase=${cycle.phase}`)
})

// Override for a specific review cycle when driving the annual merit run.
const runAnnualMeritCycle = annotateMeritLog.pipe(
  Effect.provideService(CurrentReviewCycle, { cycleId: "2025-Q4", year: 2025, phase: "approval" })
)

// Concurrency is explicit: pass a number or "unbounded" to the operation.
declare const employeeIds: ReadonlyArray<string>
declare const fetchEmployee: (id: string) => Effect.Effect<{ readonly id: string }>
const fetchPayrollBatch = Effect.forEach(employeeIds, fetchEmployee, { concurrency: 5 })

// A real built-in reference: suppress logs below Warning for this subtree.
const quietBatch = Effect.provideService(
  fetchPayrollBatch,
  References.MinimumLogLevel,
  "Warn"
)
```

Use when you want ambient, overridable context that is not a hard requirement — request correlation ids, feature toggles, log policy, tracing policy, or low-level scheduler tuning. Put operation-specific concurrency on `Effect.forEach`, `Effect.all`, stream combinators, and the other APIs that expose a `concurrency` option.

### Default services

Five everyday capabilities are `Context.Reference`s with live defaults. That is why reading the clock, printing, drawing random numbers, loading a `Config`, or opening a span leaves `R` as `never` — and why a missing test override is never a type error.

| Reference key | Default | Replace it with | More |
| --- | --- | --- | --- |
| `Clock.Clock` | System clock | `TestClock.layer()` from `effect/testing` | [Clock](fibers-scopes-runtimes#clock), [TestClock](../tooling/testing-dev-tooling#testclock) |
| `ConfigProvider.ConfigProvider` | `ConfigProvider.fromEnv()` | `ConfigProvider.layer(ConfigProvider.fromUnknown({...}))` | [ConfigProvider](configuration-secrets#configprovider) |
| `Console.Console` | The global `console` | `TestConsole.layer` from `effect/testing` | [Console](../operations/observability#console), [TestConsole](../tooling/testing-dev-tooling#testconsole) |
| `Random.Random` | `Math.random` | `Random.withSeed(seed)` for a reproducible sequence | [Random](../concurrency/scheduling-time#random) |
| `Tracer.Tracer` | In-memory native tracer that exports nothing | An exporter layer such as OTLP | [Tracer](../operations/observability#tracer) |

Override any reference for one effect with `Effect.provideService(Ref, value)`, transform the current value with `Effect.updateService(Ref, f)`, or hold an override until the surrounding scope closes with `Effect.updateServiceScoped(Ref, f)` (it requires `Scope` and restores the previous value on close). An override installed through a Layer follows the Layer rules above: it reaches the layers it is provided *beneath* and the effect the graph is provided to, not its `Layer.merge` siblings.

Official guide: [Default Services](https://effect.website/docs/v4/requirements-management/default-services).

## Resource

`effect/Resource` — stable

A scoped value that can **refresh itself**. `Resource.auto(acquire, schedule)` acquires a value and re-acquires it on a `Schedule`; `Resource.get` reads the latest successfully stored result. `Resource.manual` provides the same caching with explicit refreshes.

**Mental model.** A `Ref` whose contents are produced by an effect and rebuilt on a timer.

```ts
import { Effect, Schedule } from "effect"
import { Resource } from "effect"

// Fetch the full CompBand table from the HRIS and refresh it every hour.
// Give the acquisition its own retry/recovery if automatic refresh must survive failures.
const program = Effect.gen(function*() {
  const compBands = yield* Resource.auto(
    fetchCompBandsFromHris,           // Effect<ReadonlyMap<number, CompBand>, HrisUnavailable>
    Schedule.spaced("1 hour")
  )

  // Read the latest successfully stored comp bands.
  const bands = yield* Resource.get(compBands)

  // Validate an employee's proposed raise against the current band for their level.
  const employee = yield* hris.getEmployee("e42")
  const band = bands.get(employee.level)
  if (band && employee.baseSalary > band.max) {
    return yield* Effect.fail(new BandViolation({ employeeId: "e42", proposedSalary: employee.baseSalary }))
  }
})
```

Use when a value must be kept current in the background — OAuth tokens, rotating signing keys, periodically-reloaded data snapshots.

> **Failure semantics:** construction captures the initial acquisition as an `Exit`, so `Resource.manual` / `auto` can return a handle even when that acquisition fails; the first `Resource.get` then fails with the stored error. A later failed `Resource.refresh` fails that call but leaves the previously stored value intact. In `Resource.auto`, refresh is the effect repeated by the schedule, so an unhandled acquisition failure ends the automatic refresh fiber. Add retry/recovery to `acquire` when refreshing must continue through transient failures.
