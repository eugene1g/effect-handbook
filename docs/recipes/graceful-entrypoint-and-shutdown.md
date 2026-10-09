# Recipe: A Graceful Node Entrypoint

Represent the long-lived application as a Layer, put every background fiber and acquired handle under its Scope, then hand the launched Layer to `NodeRuntime.runMain`.

> **Official guides:** [Guidelines](https://effect.website/docs/v4/code-style/guidelines) (why `runMain` rather than `runPromise`). Where that guide and the tagged `effect@4.0.2` source disagree, this page and the source win.

## Contract

- **Classification:** Runnable example; complete `main.ts`.
- **Install:** `pnpm add effect@4.0.2 @effect/platform-node@4.0.2`
- **Run:** Node 26+: `node main.ts`
- **Expected output:** `worker started`; then `heartbeat` every second. Press Ctrl+C or send SIGTERM and it prints `worker stopped` before exit.
- **Program type:** `Layer.launch(WorkerLive)` is `Effect<never, never, never>` after the Layer has no unsatisfied dependencies.
- **Required Layers:** `WorkerLive` is the application Layer. Real production workers may additionally require Config, database, HTTP, and observability Layers.
- **Lifetime and interruption:** `NodeRuntime.runMain` installs SIGINT/SIGTERM handling and interrupts the main fiber. `Layer.launch` closes the Layer scope; the scoped child is interrupted and its finalizer runs.
- **Exit code:** `0` on success, `130` when the Cause holds only interruptions (the Ctrl+C / SIGTERM path here), otherwise the failing error's `[Runtime.errorExitCode]` or `1`. The runner calls `process.exit` only *after* teardown, and only when a signal arrived or the code is non-zero.

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

`Effect.addFinalizer` receives the `Exit` that closed the scope, so cleanup can tell a clean stop from a crash: `Exit.isSuccess(exit)`, `Exit.hasInterrupts(exit)` for a signal, anything else for a failure. A finalizer's error type is `never` — decide up front whether a failed cleanup is logged and ignored, bounded with `Effect.timeout`, or promoted to a defect.

The core runtime keeps the process alive on its own now — a reference-counted keep-alive is built into every fiber, so `runFork` and `runPromise` no longer exit early while a fiber is suspended on something like `Deferred.await`. `runMain` is still the right call for process entrypoints, but for signal handling, exit codes, and error reporting rather than for keeping the process up. What it adds on top of `runFork`, all of it replaceable through its options:

| Behavior | Default | Override |
| --- | --- | --- |
| Signals | SIGINT and SIGTERM interrupt the main fiber. A repeated signal does not force an exit: the process ends when the finalizers do, so every finalizer needs its own bound. | none — give slow finalizers a timeout |
| Error reporting | A failure that is not interruption-only is logged once with `Effect.logError` | `disableErrorReporting: true`, or set `[Runtime.errorReported] = false` on an error class that was already reported |
| Exit code | `Runtime.defaultTeardown`: `0` / `130` / `[Runtime.errorExitCode]` or `1` | `teardown: (exit, onExit) => …` |

Official guide: [Runtime (platform)](https://effect.website/docs/v4/platform/runtime). The tagged source additionally uses `130` for an interruption-only exit and listens for SIGTERM as well as SIGINT; this page follows the source. The runner itself is described in [Core Runtime & Execution](../foundations/fibers-scopes-runtimes#runtime).

## Adding readiness and a bounded drain

The file above stops instantly because a heartbeat has nothing to finish. A worker that holds admitted jobs needs three more things, and none of them is a second shutdown code path — **shutdown order is just Layer order, reversed**, and finalizer order within one Layer, reversed:

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Context, Effect, FiberSet, Layer, Ref } from "effect"

type Phase = "starting" | "ready" | "draining"

class Lifecycle extends Context.Service<Lifecycle, Ref.Ref<Phase>>()("app/Lifecycle") {
  static layer = Layer.effect(Lifecycle, Ref.make<Phase>("starting"))
}

declare const nextApproval: Effect.Effect<string> // suspends until intake has work
declare const applyRaise: (approvalId: string) => Effect.Effect<void>

const WorkerLive = Layer.effectDiscard(
  Effect.gen(function*() {
    // Released 3rd: survivors of the drain are interrupted, and awaited.
    const inFlight = yield* FiberSet.make()
    // Released 2nd: admitted jobs get a bounded chance to finish.
    yield* Effect.addFinalizer(() =>
      FiberSet.awaitEmpty(inFlight).pipe(Effect.timeoutOption("10 seconds"))
    )
    // Released 1st: intake stops, so the set can only shrink.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(nextApproval, (approvalId) => FiberSet.run(inFlight, applyRaise(approvalId)))
      )
    )
  })
)

// Acquired last, released first: "ready" is true only while everything below it is up.
const ReadyLive = Layer.effectDiscard(
  Effect.gen(function*() {
    const phase = yield* Lifecycle
    yield* Effect.acquireRelease(Ref.set(phase, "ready"), () => Ref.set(phase, "draining"))
  })
)

const MainLive = ReadyLive.pipe(
  Layer.provideMerge(WorkerLive),
  Layer.provideMerge(Lifecycle.layer)
)

NodeRuntime.runMain(Layer.launch(MainLive))
```

`Layer.provide` and `Layer.provideMerge` build the provided Layer first, so `MainLive` starts `Lifecycle`, then the worker, then flips to `"ready"`; a signal flips to `"draining"`, stops intake, drains for at most ten seconds, interrupts what is left, and only then releases whatever the worker depended on. A readiness endpoint reads the `Ref`; liveness never does.

**Size the drain below the platform's grace period.** Kubernetes sends SIGTERM, waits `terminationGracePeriodSeconds` (30 by default), then SIGKILL — which no finalizer survives. In a container, make sure the process that receives the signal is Node (exec form, or an init that forwards signals), or none of this runs. The full treatment, including how to test the drain bound with `TestClock`, is [Owning Lifetimes — Startup, Readiness, and Shutdown](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown).

## Common wrong alternative

Do not call `process.exit()` from business code, maintain a separate array of ad-hoc cleanup callbacks, use `forkDetach` for ordinary workers, or start a server outside Effect and hope its callbacks shut down in the right order. Abrupt exit can skip finalizers and telemetry flushes. Keep ownership in Scope and let interruption unwind it.

Do not end the entrypoint with `Effect.runPromise(main)`. Nothing listens for signals, so Ctrl+C takes Node's default action and the process dies with every finalizer unrun. Do not publish readiness before the last dependency is acquired, or leave it `true` while draining: both route traffic to a process that cannot serve it.
