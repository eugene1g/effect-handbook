# Recipe: Request Cancellation Through a Host

When a framework that is not Effect owns the request — Express, Hono, a queue SDK, a plugin API — a client disconnect has to travel **two hops** before any work actually stops: from the host's `AbortSignal` into the Effect fiber, and from that fiber into the Promise-based SDK call at the bottom. This recipe wires both hops through one `ManagedRuntime` and proves each one in its output.

## Contract

- **Classification:** Runnable example; complete `request-cancellation.ts`. No network, no timers longer than 25 ms.
- **Install:** `pnpm add effect@4.0.0-rc.115`
- **Run:** Node 26+: `node request-cancellation.ts`
- **Before the bridge:** `compBand(employeeId)` is `Effect<string, HrisUnavailable, HrisDirectory>`.
- **At the bridge:** `runtime.runPromiseExit(effect, { signal })` is `Promise<Exit<string, HrisUnavailable>>`. It never rejects, so the host maps success, interruption, and typed failure to three different responses.
- **Hop one (host → fiber):** the `signal` run option interrupts the fiber when the host aborts. Every runner on `ManagedRuntime` and on `Effect` accepts it.
- **Hop two (fiber → SDK):** `Effect.tryPromise` hands its callback an `AbortSignal` that Effect aborts when the fiber is interrupted. It is a *different* signal from the host's; pass it to the SDK.
- **Required Layers:** `HrisDirectory.layer`, captured once by the `ManagedRuntime`.
- **Lifetime and interruption:** the Layer is acquired on the first request and released by `runtime.dispose()`. The request-scoped permit is released on every exit path, and its finalizer sees the interrupt-only `Exit`. An aborted request leaves the runtime fully usable.

**Expected output (exact):**

```text
layer: HRIS directory acquired
  effect: rate-limit permit taken
  sdk: lookup emp-1042 in flight
host: client disconnected, aborting request 1
  sdk: lookup emp-1042 aborted, socket freed
  effect: rate-limit permit returned (interrupted)
host: request 1 -> 499 client closed request
  effect: rate-limit permit taken
  sdk: lookup emp-2077 in flight
  effect: rate-limit permit returned (success)
host: request 2 -> 200 emp-2077 is in band L5
layer: HRIS directory released
host: runtime disposed
```

## Complete file

**Runnable example.**

<!-- effect-example id=request-cancellation-host check=run runtime=request-cancellation-host -->
```ts
import { Cause, Context, Data, Effect, Exit, Layer, ManagedRuntime } from "effect"

// --- A Promise SDK the application does not own (stands in for fetch or a driver).
// It honors an AbortSignal. `nextLookupInFlight` is a demo latch: it lets the simulated
// client disconnect at a known point instead of after a sleep.
let markInFlight: () => void = () => {}
const nextLookupInFlight = (): Promise<void> =>
  new Promise((resolve) => {
    markInFlight = resolve
  })

const hrisSdk = {
  lookupBand: (employeeId: string, signal: AbortSignal): Promise<string> =>
    new Promise((resolve, reject) => {
      console.log(`  sdk: lookup ${employeeId} in flight`)
      const timer = setTimeout(() => resolve(`${employeeId} is in band L5`), 25)
      signal.addEventListener("abort", () => {
        clearTimeout(timer)
        console.log(`  sdk: lookup ${employeeId} aborted, socket freed`)
        reject(new Error("aborted"))
      }, { once: true })
      markInFlight()
    })
}

// --- The Effect application.
class HrisUnavailable extends Data.TaggedError("HrisUnavailable")<{
  readonly cause: unknown
}> {}

class HrisDirectory extends Context.Service<HrisDirectory, {
  readonly band: (employeeId: string) => Effect.Effect<string, HrisUnavailable>
}>()("app/HrisDirectory") {
  static layer = Layer.effect(
    HrisDirectory,
    Effect.gen(function*() {
      yield* Effect.acquireRelease(
        Effect.sync(() => console.log("layer: HRIS directory acquired")),
        () => Effect.sync(() => console.log("layer: HRIS directory released"))
      )
      return {
        band: (employeeId) =>
          Effect.tryPromise({
            // Hop two: Effect aborts THIS signal when the calling fiber is interrupted.
            try: (signal) => hrisSdk.lookupBand(employeeId, signal),
            catch: (cause) => new HrisUnavailable({ cause })
          })
      }
    })
  )
}

const outcome = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isSuccess(exit) ? "success" : Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failure"

const compBand = Effect.fn("compBand")(function*(employeeId: string) {
  const hris = yield* HrisDirectory
  // A request-scoped resource: it must be returned however the request ends.
  yield* Effect.acquireRelease(
    Effect.sync(() => console.log("  effect: rate-limit permit taken")),
    (_, exit) => Effect.sync(() => console.log(`  effect: rate-limit permit returned (${outcome(exit)})`))
  )
  return yield* hris.band(employeeId)
}, Effect.scoped)

// --- The host: plain Promise code, standing in for an HTTP framework.
const runtime = ManagedRuntime.make(HrisDirectory.layer)

interface HostResponse {
  readonly status: number
  readonly body: string
}

const handle = async (employeeId: string, requestSignal: AbortSignal): Promise<HostResponse> => {
  // Hop one: the host's signal interrupts the fiber that runs this request.
  const exit = await runtime.runPromiseExit(compBand(employeeId), { signal: requestSignal })
  if (Exit.isSuccess(exit)) return { status: 200, body: exit.value }
  if (Cause.hasInterruptsOnly(exit.cause)) return { status: 499, body: "client closed request" }
  return { status: 503, body: "HRIS unavailable" }
}

// Request 1: the client disconnects while the HRIS call is in flight.
const first = new AbortController()
const lookupInFlight = nextLookupInFlight()
const firstResponse = handle("emp-1042", first.signal)
await lookupInFlight
console.log("host: client disconnected, aborting request 1")
first.abort()
const one = await firstResponse
console.log(`host: request 1 -> ${one.status} ${one.body}`)

// Request 2: same runtime, nobody aborts.
const two = await handle("emp-2077", new AbortController().signal)
console.log(`host: request 2 -> ${two.status} ${two.body}`)

await runtime.dispose()
console.log("host: runtime disposed")
```

## Why it is shaped this way

**Cancellation is only as good as its weakest hop.** The host knows the client left; the SDK holds the socket. Effect sits between them and owns the fiber, so it needs an input (the run option) and an output (the adapter's signal). Interruption then does the rest: it aborts the adapter's controller, runs the request scope's finalizers with the interrupt-only `Exit`, and completes the fiber — in that order, which is why the output shows the SDK abort *before* the permit is returned.

**`runPromiseExit` keeps the three outcomes apart.** `runPromise` would reject an aborted request with a plain `Error: All fibers interrupted without error`, which a framework's error middleware turns into a 500 and a log line for something that is not a fault. Matching on `Exit` lets interruption become a quiet 499, a typed failure become a 503, and success a 200. `Cause.hasInterruptsOnly` is the right test: a Cause that also carries a failure or defect is not a clean cancellation.

**One runtime, many requests.** The Layer line prints once and the second request succeeds after the first was interrupted. Interrupting a request fiber closes that request's scope only; the runtime's scope, and everything the Layer acquired, is untouched until `dispose()`.

### The two broken versions

Both were run against `rc.115` by editing one line of the file above:

| Dropped hop | Edit | What request 1 prints instead | What it costs |
| --- | --- | --- | --- |
| Hop one | `runtime.runPromiseExit(compBand(employeeId))` | No `sdk: … aborted` line; `permit returned (success)`; `request 1 -> 200` | The full HRIS call, the permit, and a response body are spent on a client that is gone. |
| Hop two | `try: () => hrisSdk.lookupBand(employeeId, someOtherSignal)` | `permit returned (interrupted)` and `499`, but no `sdk: … aborted` line — the lookup keeps running and settles later with nobody listening | Effect looks cancelled while the socket, pool slot, or upstream rate-limit budget stays occupied. This is the version that survives code review. |

`Effect.tryPromise` (and `Effect.promise`) only create the `AbortController` when the callback **declares** a parameter, so `() => fetch(url)` is not merely ignoring a signal — none exists. On interruption the fiber moves on immediately and the orphaned Promise finishes in the background.

```ts
import { Effect } from "effect"

declare const lookupBand: (employeeId: string, signal?: AbortSignal) => Promise<string>

// Interruptible all the way down: the SDK sees the abort.
const forwarded = Effect.tryPromise((signal) => lookupBand("emp-1042", signal))

// Interruptible only on the Effect side: the lookup is orphaned, not cancelled.
const orphaned = Effect.tryPromise(() => lookupBand("emp-1042"))
```

The constructor-level mechanics (`Effect.callback`, `Effect.promise`, the run options) are defined in [Core Runtime & Execution](../foundations/core-runtime-execution#effect); this recipe is only the seam.

## Variations

- **The host has no `AbortSignal`.** Node's `http.ServerResponse` (and therefore Express) emits `close` instead. Create one `AbortController` per request, abort it from that listener when `response.writableEnded` is still `false`, and pass `controller.signal` as the run option — the same test Effect's own Node server uses. A host deadline is one more abort source: combine them with `AbortSignal.any([...])`, or keep the deadline inside the Effect with `Effect.timeout` so `TestClock` can drive it.
- **An already-aborted request.** Check `signal.aborted` in the host before calling the runtime. With an aborted signal Effect still starts the fiber and interrupts it at its first asynchronous boundary, so the synchronous prefix runs — and an Effect with no asynchronous step completes normally (probed on `rc.115`).
- **The SDK's cancel is itself asynchronous.** Use `Effect.callback` and return the cancel as the cleanup Effect. Interruption awaits that cleanup, so the host's Promise stays pending until the driver confirms — which is what rules out "completed after it was cancelled". `Effect.tryPromise` does not wait: it aborts and moves on.
- **The host wants a rejection, not an `Exit`.** Keep `runPromise`, but catch at the adapter and test the abort yourself (`signal.aborted`), because the rejection value is an ordinary `Error`, not a `Cause`.
- **An Effect-native server needs only hop two.** `NodeHttpServer` interrupts the request fiber when the client closes the connection, and `HttpEffect.toWebHandler` listens to `request.signal`. This recipe is for hosts that Effect does not own; see [HTTP Server](../interfaces/http-server#httpeffect).
- **Testing the seam.** Three assertions reject the three common mistakes: count Layer acquisitions across many requests (must be 1 — not a runtime per request); count releases after calling `dispose()` twice (must be 1 — disposal happened, and is idempotent); and for cancellation, abort on an "in flight" latch and await a cleanup gate, as the file above does, instead of sleeping after the abort.
- **Shutting the host down.** `runtime.dispose()` interrupts whatever is still in flight and releases the Layer at the same time. Stop admitting requests and drain first: [Recipe: ManagedRuntime at an Imperative Boundary](./managed-runtime-integration) has the protocol and [Owning Lifetimes](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown) explains why.
