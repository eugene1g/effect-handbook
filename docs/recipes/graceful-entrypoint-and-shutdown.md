# Recipe: A Graceful Node Entrypoint

Represent the long-lived application as a Layer, put every background fiber and acquired handle under its Scope, then hand the launched Layer to `NodeRuntime.runMain`.

## Contract

- **Classification:** Runnable example; complete `main.ts`.
- **Install:** `pnpm add effect@4.0.0-rc.108 @effect/platform-node@4.0.0-rc.108`
- **Run:** Node 26+: `node main.ts`
- **Expected output:** `worker started`; then `heartbeat` every second. Press Ctrl+C or send SIGTERM and it prints `worker stopped` before exit.
- **Program type:** `Layer.launch(WorkerLive)` is `Effect<never, never, never>` after the Layer has no unsatisfied dependencies.
- **Required Layers:** `WorkerLive` is the application Layer. Real production workers may additionally require Config, database, HTTP, and observability Layers.
- **Lifetime and interruption:** `NodeRuntime.runMain` installs SIGINT/SIGTERM handling and interrupts the main fiber. `Layer.launch` closes the Layer scope; the scoped child is interrupted and its finalizer runs.

## Complete file

**Runnable example.**

<!-- effect-example id=graceful-entrypoint-shutdown check=run runtime=graceful-entrypoint-shutdown -->
```ts
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"

const WorkerLive = Layer.effectDiscard(
  Effect.gen(function*() {
    yield* Effect.logInfo("worker started")
    yield* Effect.addFinalizer(() => Effect.logInfo("worker stopped"))

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.logInfo("heartbeat").pipe(
          Effect.andThen(Effect.sleep("1 second"))
        )
      )
    )
  })
)

const main: Effect.Effect<never> = Layer.launch(WorkerLive)

NodeRuntime.runMain(main)
```

## Why these primitives?

`Layer.effectDiscard` describes startup and scoped background work without exposing a service. `forkScoped` attaches the heartbeat to the Layer scope; `addFinalizer` declares cleanup beside acquisition. `Layer.launch` keeps that scope alive, and the platform runner translates process signals into Effect interruption before process teardown.

An HTTP server, Queue consumer, Cluster runner, or OTLP exporter follows the same shape: merge all live Layers, provide their dependencies once, launch the combined Layer, and run that one main Effect.

## Common wrong alternative

Do not call `process.exit()` from business code, maintain a separate array of ad-hoc cleanup callbacks, use `forkDetach` for ordinary workers, or start a server outside Effect and hope its callbacks shut down in the right order. Abrupt exit can skip finalizers and telemetry flushes. Keep ownership in Scope and let interruption unwind it.
