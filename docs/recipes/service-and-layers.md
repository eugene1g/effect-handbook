# Recipe: A Service with Live and Test Layers

Define the capability once, keep implementations in Layers, and let the program’s `R` show whether wiring is complete.

## Contract

- **Classification:** Runnable example; complete `service-and-layers.ts`.
- **Install:** `pnpm add effect@4.0.0-rc.108`
- **Run:** Node 26+: `node service-and-layers.ts`
- **Expected output:** two lines: `Hello, Ada!` and `[test] Ada`.
- **Before provision:** `greet("Ada")` is `Effect<string, never, GreetingService>`.
- **After provision:** each runnable program is `Effect<string, never, never>`.
- **Required Layers:** exactly one implementation of `GreetingService`; no platform Layer is needed.
- **Lifetime and interruption:** these Layers contain plain values and own no resources. If construction later uses `Effect.acquireRelease`, its finalizer is owned by the Layer scope and runs on failure or interruption.

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

## Common wrong alternative

Do not call `Effect.runPromise` inside `greet`, hide a client in a module-global variable, or pass dependencies manually through every function. Return Effects that retain `GreetingService` in `R`, compose all Layers once, and run only at the outer application boundary.

For a component Layer that itself needs another service, use `Layer.provide(dependency)` beneath that component. Use `Layer.provideMerge` only when the dependency must also remain visible to sibling/top-level consumers.
