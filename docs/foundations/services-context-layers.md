# Services, Context & Layers

The `R` in `Effect<A, E, R>` is a typed set of required services. **Context** holds those services, **Layer** is the recipe for constructing them (with dependencies and lifecycles), and the runtime blocks execution until every requirement is satisfied.

> **Official examples:** Effect's release-matched [`ai-docs` service examples](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/01_effect/03_services) cover `Context.Service`, `Context.Reference`, Layer composition, and dynamically constructed Layers.

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
    const useSandbox = yield* Config.boolean("HRIS_SANDBOX").pipe(Config.withDefault(false))
    return useSandbox ? Hris.layerSandbox : Hris.layer
  })
)

// Run the compensation-planning server as the application entry point.
const main = Layer.launch(CompPlanningServer.pipe(Layer.provide(AppLayer)))
```

Use when assembling a dependency graph or tying acquisition/release to a service's lifetime.

## LayerMap

`effect/LayerMap` — stable

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

## LayerRef

`effect/LayerRef` — stable

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
