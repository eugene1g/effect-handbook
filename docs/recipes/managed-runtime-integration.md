# Recipe: ManagedRuntime at an Imperative Boundary

Build the service graph once, call it from Promise-based callbacks many times, and dispose it when the host application stops.

## Contract

- **Classification:** Runnable example; complete `managed-runtime.ts`.
- **Install:** `pnpm add effect@4.0.0-rc.108`
- **Run:** Node 26+: `node managed-runtime.ts`
- **Expected output:** `Hello, Ada`, `Hello, Grace`, then `runtime disposed`.
- **Before the bridge:** `greet(name)` is `Effect<string, never, GreetingService>`.
- **At the bridge:** `runtime.runPromise(greet(name))` is `Promise<string>`; the runtime’s construction error is `never` in this example.
- **Required Layers:** `GreetingLive` is captured by the ManagedRuntime.
- **Lifetime and interruption:** the Layer is built lazily on first use and cached across calls. `await using` invokes `Symbol.asyncDispose` at block exit, closing the runtime scope and all Layer resources. A fiber returned by `runFork` still needs an ownership/cancellation policy.

## Complete file

**Runnable example.**

<!-- effect-example id=managed-runtime-integration check=run runtime=managed-runtime-integration -->
```ts
import { Context, Effect, Layer, ManagedRuntime } from "effect"

class GreetingService extends Context.Service<GreetingService, {
  readonly greet: (name: string) => Effect.Effect<string>
}>()("app/GreetingService") {}

const GreetingLive = Layer.succeed(GreetingService)({
  greet: (name) => Effect.succeed(`Hello, ${name}`)
})

const greet = (name: string): Effect.Effect<string, never, GreetingService> =>
  Effect.flatMap(GreetingService, (service) => service.greet(name))

async function hostApplication() {
  await using runtime = ManagedRuntime.make(GreetingLive)

  // These could be framework event handlers, job-runner callbacks, or methods
  // on a library whose public contract must return native Promises.
  const onRequest = (name: string): Promise<string> =>
    runtime.runPromise(greet(name))

  console.log(await onRequest("Ada"))
  console.log(await onRequest("Grace"))
}

await hostApplication()
console.log("runtime disposed")
```

If the host cannot use explicit resource management, create one runtime at application startup and call `await runtime.dispose()` from the host’s shutdown hook. Do not create a runtime for every request.

## Why this primitive?

ManagedRuntime is the deliberate seam from Effect to a host that controls invocation: UI callbacks, existing Promise frameworks, plugin hooks, or gradual migration. It provides the same built Layer context to every run and gives that context one explicit lifetime.

## Common wrong alternative

Do not sprinkle `Effect.runPromise(effect.pipe(Effect.provide(layer)))` throughout handlers. That can rebuild expensive Layers on every call and makes cleanup easy to forget. Conversely, when the whole application is already Effect, do not add ManagedRuntime: compose the live Layers, use `Layer.launch` for long-lived infrastructure, and call the platform `runMain` once.
