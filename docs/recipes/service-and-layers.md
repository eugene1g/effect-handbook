# Recipe: A Service with Live and Test Layers

Define the capability once, keep implementations in Layers, and let the program’s `R` show whether wiring is complete.

## Contract

- **Classification:** Runnable example; complete `service-and-layers.ts`.
- **Install:** `pnpm add effect@4.0.0-rc.116`
- **Run:** Node 26+: `node service-and-layers.ts`
- **Expected output:** two lines: `Hello, Ada!` and `[test] Ada`.
- **Before provision:** `greet("Ada")` is `Effect<string, never, GreetingService>`.
- **After provision:** each runnable program is `Effect<string, never, never>`.
- **Required Layers:** exactly one implementation of `GreetingService`; no platform Layer is needed.
- **Lifetime and interruption:** these Layers contain plain values and own no resources. If construction later uses `Effect.acquireRelease`, its finalizer is owned by the Layer scope and runs on failure or interruption.
- **Build frequency:** each `Effect.provide` below is its own Layer build. With `Layer.succeed` that costs nothing; once a Layer acquires a resource, two sibling provides mean two acquisitions, so a real application provides its composed graph once at the edge. See [What is shared, and what is rebuilt](../foundations/services-context-layers#what-is-shared-and-what-is-rebuilt).
- **Service contract:** `greet` returns an `Effect` with `R = never` and no typed failure. Any implementation — live or test — must keep that shape: construction needs go into the Layer, expected failures go into `E`, and nothing throws.

## Complete file

**Runnable example.**

<!-- effect-example id=service-live-test-layers check=run runtime=service-live-test-layers -->
```ts
import { Context, Effect, Layer } from "effect"

class GreetingService extends Context.Service<GreetingService, {
  readonly greet: (name: string) => Effect.Effect<string>
}>()("app/GreetingService") {}

const GreetingLive = Layer.succeed(GreetingService)({
  greet: (name) => Effect.succeed(`Hello, ${name}!`)
})

const GreetingTest = Layer.succeed(GreetingService)({
  greet: (name) => Effect.succeed(`[test] ${name}`)
})

const greet = (name: string): Effect.Effect<string, never, GreetingService> =>
  Effect.gen(function*() {
    const service = yield* GreetingService
    return yield* service.greet(name)
  })

const liveProgram: Effect.Effect<string> = greet("Ada").pipe(
  Effect.provide(GreetingLive)
)

const testProgram: Effect.Effect<string> = greet("Ada").pipe(
  Effect.provide(GreetingTest)
)

console.log(await Effect.runPromise(liveProgram))
console.log(await Effect.runPromise(testProgram))
```

## Why this primitive?

`Context.Service` gives the capability one stable type-level key; `Layer` describes how an implementation is constructed and, when necessary, released. Business code depends on the capability, not a global singleton or a concrete client. Tests replace the Layer without changing the program.

`Layer.succeed` is enough here because both implementations are finished values. Reach for `Layer.effect` as soon as an implementation needs configuration, another service, state, or a resource with a finalizer; for a one-off value in a single test, `Effect.provideService(GreetingService, fake)` skips the Layer entirely. [Providing one value or building a graph](../foundations/services-context-layers#providing-one-value-or-building-a-graph) has the decision table, and [Designing a service contract](../foundations/services-context-layers#designing-a-service-contract) covers what belongs in the shape.

Official guide: [Managing Layers](https://effect.website/docs/v4/requirements-management/layers) extends this pattern to services with dependencies and to test injection (it names the dependency-free Layer `layerWithoutDependencies`; this handbook uses `layerNoDeps`).

## Variations

**Prove that the test Layer is actually wired.** A test Layer that is declared but never provided still type-checks if something else satisfies the requirement, and the test passes against the wrong implementation. Make the assertion depend on state only the fake can produce. The fake below keeps its state in a `Ref` built by the Layer — so every `Effect.provide` starts clean — and exposes it through a small probe service:

```ts
import { Context, Effect, Layer, Ref } from "effect"

class GreetingService extends Context.Service<GreetingService, {
  readonly greet: (name: string) => Effect.Effect<string>
}>()("app/GreetingService") {}

const greet = (name: string) => GreetingService.use((service) => service.greet(name))

// A ready value needs no Layer.
const unitProgram = greet("Ada").pipe(
  Effect.provideService(
    GreetingService,
    GreetingService.of({ greet: (name) => Effect.succeed(`[unit] ${name}`) })
  )
)

// A recording fake: per-build state, observable through a probe service.
class GreetingCalls extends Context.Service<GreetingCalls, Ref.Ref<ReadonlyArray<string>>>()(
  "test/GreetingCalls"
) {}

const GreetingRecording = Layer.effect(GreetingService, Effect.gen(function*() {
  const calls = yield* GreetingCalls
  return GreetingService.of({
    greet: (name) => Ref.update(calls, (seen) => [...seen, name]).pipe(Effect.as(`[test] ${name}`))
  })
})).pipe(
  Layer.provideMerge(Layer.effect(GreetingCalls, Ref.make<ReadonlyArray<string>>([])))
)

// Yields ["Ada"] on every run; it cannot pass unless GreetingRecording handled the call.
const provesWiring = Effect.gen(function*() {
  yield* greet("Ada")
  const calls = yield* GreetingCalls
  return yield* Ref.get(calls)
}).pipe(Effect.provide(GreetingRecording))
```

`Layer.provideMerge` is deliberate: the probe must stay visible to the test, whereas a production dependency would be hidden with `Layer.provide`. Stubs, failure Layers, contract suites shared by the fake and the live adapter, and `Layer.mock` are covered in [Testing & Dev Tooling](../tooling/testing-dev-tooling) and [Testing an Effect Application](../deep-dives/testing-an-effect-application).

## Common wrong alternative

Do not call `Effect.runPromise` inside `greet`, hide a client in a module-global variable, or pass dependencies manually through every function. Return Effects that retain `GreetingService` in `R`, compose all Layers once, and run only at the outer application boundary.

Two quieter versions of the same mistake:

- **Providing the live Layer inside business logic** — `greet(name).pipe(Effect.provide(GreetingLive))` inside a reusable function makes `R` look clean while hard-wiring the production implementation. Tests can no longer substitute it, and every call is a separate Layer build. Provide live implementations at the application edge and fakes at the test edge, nowhere else.
- **A fake that throws** — `greet: () => { throw new Error("down") }` produces a defect, which no `Effect.catchTag` in the program under test can see. If the contract has an expected failure, declare it in `E` and have the fake return `Effect.fail(...)`, so tests exercise the same channel as production.

For a component Layer that itself needs another service, use `Layer.provide(dependency)` beneath that component. Use `Layer.provideMerge` only when the dependency must also remain visible to sibling/top-level consumers.
