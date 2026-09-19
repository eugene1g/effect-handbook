# Recipe: ManagedRuntime at an Imperative Boundary

Build the service graph once, call it from Promise-based callbacks many times, and dispose it when the host application stops.

> **Official guides:** [Runtime](https://effect.website/docs/v4/runtime). These track Effect's `main` branch rather than the pinned `rc.115` release, so where they differ, this page and the tagged source win.

## Contract

- **Classification:** Runnable example; complete `managed-runtime.ts`.
- **Install:** `pnpm add effect@4.0.0-rc.115`
- **Run:** Node 26+: `node managed-runtime.ts`
- **Expected output:** `Hello, Ada`, `Hello, Grace`, then `runtime disposed`.
- **Before the bridge:** `greet(name)` is `Effect<string, never, GreetingService>`.
- **At the bridge:** `runtime.runPromise(greet(name))` is `Promise<string>`; the runtime’s construction error is `never` in this example.
- **Required Layers:** `GreetingLive` is captured by the ManagedRuntime.
- **Lifetime and interruption:** the Layer is built lazily on first use and cached across calls. `await using` invokes `Symbol.asyncDispose` at block exit, closing the runtime scope and all Layer resources. A fiber returned by `runFork` still needs an ownership/cancellation policy.
- **Cancellation:** every runner takes `{ signal }` as its second argument; aborting it interrupts that run's fiber. The minimal file below omits it because nothing here can be cancelled — a real request handler must not. [Recipe: Request Cancellation Through a Host](./request-cancellation-through-a-host) is the runnable proof.
- **Disposal is not a drain:** `dispose()` interrupts every fiber the runtime started *while* it releases the Layer, a second `dispose()` is a no-op, and any later run dies with `ManagedRuntime disposed` (all probed on `rc.115`). Stop admitting work and wait for it first.

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

## A production-shaped bridge

The complete file shows the lifetime. A real host adds four obligations around it, and each is one line: **warm** the runtime at boot, **admit** or refuse before doing work, **forward** the host's `AbortSignal`, and make shutdown **one memoized operation** that stops intake, drains with a bound, and only then disposes.

```ts
import { Cause, Context, Data, Effect, Exit, ManagedRuntime } from "effect"
import type { Layer } from "effect"

class RaiseRejected extends Data.TaggedError("RaiseRejected")<{
  readonly reason: string
}> {}

class Compensation extends Context.Service<Compensation, {
  readonly approveRaise: (input: unknown) => Effect.Effect<string, RaiseRejected>
}>()("app/Compensation") {}

declare const AppLive: Layer.Layer<Compensation>

interface HostResponse {
  readonly status: number
  readonly body: string
}

const runtime = ManagedRuntime.make(AppLive)
let accepting = true
const inFlight = new Set<Promise<unknown>>()

// Warm: pay Layer acquisition at boot, so a broken deployment fails its start-up probe.
export const onBoot = (): Promise<void> => runtime.runPromise(Effect.void)

export const onRequest = (input: unknown, signal: AbortSignal): Promise<HostResponse> => {
  // Admit: refuse before any work starts. An aborted signal would still run the synchronous prefix.
  if (!accepting) return Promise.resolve({ status: 503, body: "shutting down" })
  if (signal.aborted) return Promise.resolve({ status: 499, body: "client closed request" })

  const response = runtime
    // Forward: the host's abort becomes fiber interruption.
    .runPromiseExit(Compensation.use((service) => service.approveRaise(input)), { signal })
    .then((exit): HostResponse => {
      if (Exit.isSuccess(exit)) return { status: 200, body: exit.value }
      // An interrupt-only Exit says "cancelled", not by whom. The host knows: client or shutdown.
      if (Cause.hasInterruptsOnly(exit.cause)) {
        return signal.aborted
          ? { status: 499, body: "client closed request" }
          : { status: 503, body: "shutting down" }
      }
      const rejected = Cause.findErrorOption(exit.cause)
      return rejected._tag === "Some"
        ? { status: 422, body: rejected.value.reason }
        : { status: 500, body: "internal error" }
    })
  inFlight.add(response)
  return response.finally(() => inFlight.delete(response))
}

const settleWithin = (work: Promise<unknown>, millis: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, millis)
    void work.finally(() => {
      clearTimeout(timer)
      resolve()
    })
  })

// One shutdown: hot reload and double signal handlers all get the same Promise.
let stopping: Promise<void> | undefined
export const onShutdown = (): Promise<void> =>
  stopping ??= (async () => {
    accepting = false // 1. stop intake, synchronously
    await settleWithin(Promise.allSettled(inFlight), 10_000) // 2. drain, with a bound
    await runtime.dispose() // 3. interrupt survivors, release the Layer
  })()
```

- **Register before shutdown can miss it.** `inFlight.add` happens in the same synchronous turn as the admission check, so there is no window in which `onShutdown` sees an empty set while a request is starting.
- **Choose how failures cross the boundary once.** `runPromiseExit` keeps typed failure, defect, and interruption apart; `runPromise` rejects with a squashed error and loses that distinction. Use it only when the host's contract really is "reject on anything".
- **A failed build is permanent.** The build runs once and its failure is cached: every later run on that runtime fails the same way (probed). Treat a failed `onBoot` as a failed start-up, not as something the next request will retry.
- **Size the drain below the platform's grace period** (Kubernetes `terminationGracePeriodSeconds`, a serverless shutdown hook), leaving room for `dispose()` and finalizers.

The reasons behind each step, and the Effect-native equivalent built from Layer order alone, are in [Owning Lifetimes — Startup, Readiness, and Shutdown](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown).

## How to test this seam

Test the host lifecycle, not just one request. Give the Layer an acquisition counter and a release counter, then assert three things: many requests, including concurrent first requests, leave **acquired = 1**; after `onShutdown()` **released = 1**; after a second `onShutdown()` it is **still 1**. Those reject a runtime per request, a missing dispose, and a non-idempotent hook. For cancellation, abort on an "in flight" latch and await a cleanup gate rather than sleeping after the abort — the [cancellation recipe](./request-cancellation-through-a-host) is that test written as a program.

## Why this primitive?

ManagedRuntime is the deliberate seam from Effect to a host that controls invocation: UI callbacks, existing Promise frameworks, plugin hooks, or gradual migration. It provides the same built Layer context to every run and gives that context one explicit lifetime.

## Common wrong alternative

Do not sprinkle `Effect.runPromise(effect.pipe(Effect.provide(layer)))` throughout handlers. That can rebuild expensive Layers on every call and makes cleanup easy to forget.

Do not ignore the host's abort signal. `runtime.runPromise(effect)` without `{ signal }` keeps working for a client that has left, holding a pool slot and rate-limit budget; and a `tryPromise` adapter that does not pass Effect's own signal to the SDK leaves the socket open even after the fiber is interrupted. Both hops are needed.

Do not call `dispose()` as the first step of shutdown, and never start an interior `Effect.runFork` "so the work survives the request": the first interrupts in-flight requests while their dependencies are being released, the second creates a fiber no scope owns. Work that must outlive a request is handed to a Layer-owned supervisor (a bounded queue and a scoped worker) inside the same runtime.

Conversely, when the whole application is already Effect, do not add ManagedRuntime: compose the live Layers, use `Layer.launch` for long-lived infrastructure, and call the platform `runMain` once.
