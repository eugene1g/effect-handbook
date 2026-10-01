# Owning Lifetimes — Startup, Readiness, and Shutdown

Audited against `effect@4.0.0` and the matching Effect repository source on 2026-09-19. Every behavioral claim marked *probed* was run against the published packages.

Every service is three programs: the one that starts it, the one that serves, and the one that stops it. Only the middle one is usually written on purpose. This guide follows one HR-platform service — a raise-approval worker with a payroll database pool, a telemetry exporter, and an intake loop — and makes the other two explicit: who owns each thing, in what order it comes up, what "ready" means, and what a single shutdown looks like on every host.

Use [Core Runtime & Execution](../foundations/core-runtime-execution) for the definitive treatment of runners, fork ownership, `Scope`, and `AbortSignal` mechanics; [Services, Context & Layers](../foundations/services-context-layers) for Layer composition; [Platform & Runtime Hosts](../interfaces/platform-runtime-hosts) for what each host guarantees; and [Testing & Dev Tooling](../tooling/testing-dev-tooling) for `TestClock`. This page is the policy that sits on top of them.

## Three questions for anything that runs

Effect's boundary rule is "keep it explicit inside, collapse it at an edge that owns the decision". Lifetimes are the second recurring shape, and one reading habit covers `Scope` in `R`, the fork variants, Layer sharing, and queue termination alike. For every resource, fiber, and runtime, ask:

1. **Who closes it?** Exactly one named scope. "The process, eventually" is not an owner.
2. **What bounds it?** A capacity when it fans out, a deadline when it waits.
3. **What runs when it loses?** Interruption, a failed sibling, a closed scope — the cleanup path, not the happy path.

A missing answer is a design defect, not a detail to fill in later.

## Write the ownership ledger first

Before any lifecycle code, list every long-lived thing. This is the ledger for the running service:

| Thing | Acquired by | Lifetime | Owner scope | Release, and its bound | Proof after release |
| --- | --- | --- | --- | --- | --- |
| Telemetry exporter | `Telemetry.layer` | application | root Layer scope | flush final batch, 3 s | last batch visible downstream |
| Payroll DB pool | `PayrollDb.layer` | application | root Layer scope | `pool.end()`, 5 s, then logged and ignored | a new query is rejected |
| Intake loop fiber | `ApprovalConsumer` via `forkScoped` | application | that Layer's scope | interrupted at once | no job taken after close |
| Admitted approval jobs | intake loop via `FiberSet.run` | request | the consumer's `FiberSet` | drained 10 s, survivors interrupted | `FiberSet.size` is 0 |
| Export temp file | `makeTempFileScoped` | operation | `Effect.scoped` around the export | deleted on scope close | path does not exist |
| `payroll-cli` child process | `spawner.spawn` | operation | scope around the spawn | `SIGTERM`, `forceKillAfter` 2 s | process group gone |
| Readiness flag | `Readiness` Layer | application | root scope, acquired last | flipped to `"draining"` first | probe answers "not ready" |

Four lifetimes cover almost everything: **operation** (a temp file, a transaction, a subprocess), **request or session** (a subscription, an upload, an admitted job), **application instance** (a pool, a listener, an exporter), and **foreign host instance** (a plugin's `ManagedRuntime`). Choose the narrowest one that is still valid:

- **Do not request-scope something expensive and shareable.** A pool per request is a connection storm. It belongs to the application instance.
- **Do not application-scope request identity.** A principal, a tenant, or a trace context stored in a Layer leaks into the next request.
- **A Layer describes construction; it does not prove the right scope exists.** A Layer provided inside a request handler, and not already built by the enclosing graph, is acquired and released once per request. Where it is provided decides its lifetime.
- **Work that must outlive its request is transferred, never detached.** Hand it to a named, Layer-owned supervisor with a capacity and a shutdown path (shown [below](#bridge-into-a-host-that-is-not-effect)). `forkDetach` "so it survives interruption" produces a fiber that nothing closes, bounds, or observes.

### `Scope` left in `R` means nobody owns it yet

`Effect.acquireRelease` does not pick an owner — it adds `Scope` to the requirements, and the type stays honest until someone discharges it. Each discharge *is* a lifetime decision:

> **Example status — Contextual:** `openPool` and `runPayroll` stand for application code.

```ts
import { Context, Effect, Exit, Layer, Scope } from "effect"

interface Pool {
  readonly close: Effect.Effect<void>
}
declare const openPool: Effect.Effect<Pool>
declare const runPayroll: (pool: Pool) => Effect.Effect<number>

// Unowned: the requirement says an owner is still missing.
const pool: Effect.Effect<Pool, never, Scope.Scope> = Effect.acquireRelease(openPool, (p) => p.close)

// Owner = this operation. The pool closes when the payroll run ends, however it ends.
const oneRun: Effect.Effect<number> = Effect.scoped(Effect.flatMap(pool, runPayroll))

// Owner = the application instance. Layer.effect takes the Scope; the pool lives as long as the graph.
class PayrollPool extends Context.Service<PayrollPool, Pool>()("app/PayrollPool") {
  static layer: Layer.Layer<PayrollPool> = Layer.effect(PayrollPool, pool)
}

// Owner = something you manage by hand (a session, a tenant). You now owe exactly one close.
const session = Effect.gen(function*() {
  const scope = yield* Scope.make()
  const sessionPool = yield* Scope.provide(pool, scope)
  return { sessionPool, end: Scope.close(scope, Exit.void) }
})
```

If `Scope` reaches your entrypoint's `R`, do not make the error go away with whatever compiles. Decide which of the three owners above is right.

## Startup is a transaction

A service that is half up is worse than one that is down: it holds connections, passes liveness, and serves errors. Treat startup as all-or-nothing, in this order: stay closed to traffic → acquire in dependency order → probe through the assembled graph → install intake → publish ready last.

Layers already implement the transactional part. **Dependencies build first; a Layer's release is registered only after its acquisition succeeds; if a later Layer fails, everything already acquired is released in reverse and the build fails with the original error** (probed — see the second test [below](#test-the-lifetime-not-just-the-behavior)). The same holds when a signal arrives mid-startup: the build is interrupted, acquired resources are released, and "ready" is never published because the readiness Layer was never reached (probed).

> **Example status — Contextual:** `createPool` stands for a driver.

```ts
import { Context, Data, Effect, Layer } from "effect"

class PayrollDbUnreachable extends Data.TaggedError("PayrollDbUnreachable")<{
  readonly cause: unknown
}> {}

interface DriverPool {
  readonly query: (sql: string) => Promise<unknown>
  readonly end: () => Promise<void>
}
declare const createPool: (url: string) => DriverPool

class PayrollDb extends Context.Service<PayrollDb, DriverPool>()("app/PayrollDb") {
  static layer = (url: string) =>
    Layer.effect(
      PayrollDb,
      Effect.gen(function*() {
        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => createPool(url)),
          // A finalizer cannot fail, so choose the policy here: bounded, then logged and ignored.
          (pool) =>
            Effect.tryPromise(() => pool.end()).pipe(
              Effect.timeoutOption("5 seconds"),
              Effect.ignore({ log: true })
            )
        )
        // Probe THROUGH what was just built. Failing here closes the pool and fails the whole graph,
        // before any listener or consumer exists.
        yield* Effect.tryPromise({
          try: () => pool.query("select 1"),
          catch: (cause) => new PayrollDbUnreachable({ cause })
        })
        return pool
      })
    )
}
```

**One `acquireRelease` per allocation.** The release is attached when `acquire` *succeeds*. An acquire effect that opens a pool and then a lock, and fails on the lock, leaves a pool with no finalizer. Split it in two (the earlier one unwinds when the later one fails) or make the acquire roll back its own partial work. The same rule applies inside a `Layer.effect` body.

## Liveness, readiness, and draining are different questions

| Probe | The question | Answer comes from | May it check dependencies? | Cost of a wrong answer |
| --- | --- | --- | --- | --- |
| Liveness | Should this process be **restarted**? | The event loop answers at all | No — a database blip would restart the whole fleet at once | Restart loops, or a wedged process kept alive |
| Readiness | Should traffic be **routed** here? | `phase === "ready"` | Only indirectly: startup already probed them | Requests sent to a process that cannot serve |
| Draining | Is it finishing, and should it be left alone? | `phase === "draining"` — not ready, still live | No | New work admitted during shutdown, or a drain cut short by a restart |

Model the phase as one value with **exactly two writers**, and make those writers a Layer that is acquired last and released first:

- It becomes `"ready"` only after every dependency, probe, and intake Layer below it has succeeded.
- It becomes `"draining"` before anything else starts to close, so a load balancer stops routing while the listener still answers.
- There is no `"stopped"` value to store: once the root scope has closed, the only reader left is the host, and what it reads is the `Exit`.

If your platform needs time to notice "not ready" (a load balancer's deregistration interval), sleep for that interval inside the readiness release. It is the one unconditional wait in the sequence; every other wait ends as soon as the work does.

## One shutdown operation

**Closing the root scope is the shutdown.** Not a `stop()` method beside it, not an array of callbacks: one operation, idempotent because a scope closes once. Its sequence is the acquisition sequence reversed, so you design shutdown by designing dependencies — *stop intake → drain in-flight work with a bound → interrupt survivors → release resources in reverse order*:

- `Layer.provide` and `Layer.provideMerge` build the provided Layer first, so the consumer depends on the pool and therefore stops **before** the pool closes.
- Inside one Layer, finalizers run in reverse registration order: register the survivor-interrupting owner first, the bounded drain second, the intake fiber last.
- Peers inside `Layer.mergeAll` have no promised order between them. If order matters, express it as a dependency.

> **Example status — Runnable:** the complete service, driven through a scope the program owns so the same graph runs unchanged under `NodeRuntime.runMain(Layer.launch(AppLive))`.

```ts
import { Context, Effect, Exit, FiberSet, Layer, Queue, Ref, Scope } from "effect"

const say = (line: string) => Effect.sync(() => console.log(line))

// Application-instance resources: one Layer each, so each has its own finalizer.
class Telemetry extends Context.Service<Telemetry, {
  readonly record: (event: string) => Effect.Effect<void>
}>()("app/Telemetry") {
  static layer = Layer.effect(
    Telemetry,
    Effect.acquireRelease(
      say("telemetry: exporter started").pipe(Effect.as({ record: (_event: string) => Effect.void })),
      () => say("telemetry: final batch flushed")
    )
  )
}

class PayrollDb extends Context.Service<PayrollDb, {
  readonly applyRaise: (approvalId: string) => Effect.Effect<void>
}>()("app/PayrollDb") {
  static layer = Layer.effect(
    PayrollDb,
    Effect.gen(function*() {
      yield* Telemetry
      yield* Effect.acquireRelease(say("db: pool opened"), () => say("db: pool closed"))
      return {
        // "stuck" stands in for a statement that never returns.
        applyRaise: (approvalId) => approvalId === "stuck" ? Effect.never : Effect.sleep("20 millis")
      }
    })
  ).pipe(Layer.provide(Telemetry.layer))
}

// Lifecycle state: written by exactly two places, read by probes and intake.
type Phase = "starting" | "ready" | "draining"

class Lifecycle extends Context.Service<Lifecycle, Ref.Ref<Phase>>()("app/Lifecycle") {
  static layer = Layer.effect(Lifecycle, Ref.make<Phase>("starting"))
}

class ApprovalInbox extends Context.Service<ApprovalInbox, Queue.Queue<string>>()("app/ApprovalInbox") {
  static layer = Layer.effect(ApprovalInbox, Queue.bounded<string>(16))
}

// Intake: the owner of every admitted job.
const ApprovalConsumer = Layer.effectDiscard(
  Effect.gen(function*() {
    const db = yield* PayrollDb
    const inbox = yield* ApprovalInbox

    const handle = (approvalId: string) =>
      db.applyRaise(approvalId).pipe(
        Effect.andThen(say(`job ${approvalId}: applied`)),
        Effect.onInterrupt(() => say(`job ${approvalId}: interrupted, row lock released`))
      )

    // Runs 3rd at shutdown: whatever is still in flight is interrupted, and awaited.
    const inFlight = yield* FiberSet.make()
    // Runs 2nd: admitted work gets a bounded chance to finish.
    yield* Effect.addFinalizer(() =>
      FiberSet.awaitEmpty(inFlight).pipe(
        Effect.timeoutOption("100 millis"),
        Effect.andThen(FiberSet.size(inFlight)),
        Effect.flatMap((left) => say(`consumer: drain finished with ${left} job(s) still in flight`))
      )
    )
    // Runs 1st: intake stops, so the set can only shrink.
    yield* Effect.addFinalizer(() => say("consumer: intake stopped"))
    yield* Effect.forkScoped(
      Effect.forever(Effect.flatMap(Queue.take(inbox), (approvalId) => FiberSet.run(inFlight, handle(approvalId))))
    )
    yield* say("consumer: intake started")
  })
)

// Readiness: acquired last, released first.
const Readiness = Layer.effectDiscard(
  Effect.gen(function*() {
    const phase = yield* Lifecycle
    yield* Effect.acquireRelease(
      Ref.set(phase, "ready").pipe(Effect.andThen(say("lifecycle: ready"))),
      () => Ref.set(phase, "draining").pipe(Effect.andThen(say("lifecycle: draining")))
    )
  })
)

const AppLive = Readiness.pipe(
  Layer.provideMerge(ApprovalConsumer),
  Layer.provideMerge(Layer.mergeAll(PayrollDb.layer, ApprovalInbox.layer, Lifecycle.layer))
)

// A host-neutral harness: build the graph in a Scope we own, use it, close it.
const program = Effect.gen(function*() {
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(AppLive, scope)
  const inbox = Context.get(context, ApprovalInbox)

  yield* Queue.offerAll(inbox, ["apr-1", "apr-2", "stuck"])
  yield* Effect.sleep("50 millis")

  yield* say("host: shutdown requested")
  yield* Scope.close(scope, Exit.void)
  yield* say(`host: stopped, phase = ${yield* Ref.get(Context.get(context, Lifecycle))}`)
})

Effect.runPromise(program)
```

```text
telemetry: exporter started
db: pool opened
consumer: intake started
lifecycle: ready
job apr-1: applied
job apr-2: applied
host: shutdown requested
lifecycle: draining
consumer: intake stopped
consumer: drain finished with 1 job(s) still in flight
job stuck: interrupted, row lock released
db: pool closed
telemetry: final batch flushed
host: stopped, phase = draining
```

Read the second half against the ledger: every row's release happened, in the order the dependencies demand, and the stuck job lost its row lock *before* the pool that holds the connection went away. An in-memory inbox still loses whatever it holds at the end; when that matters, the intake must be durable — see [The Durability and Distribution Ladder](./durability-and-distribution-ladder).

### Signals, exit codes, and the time budget

Let the platform runner deliver the signal; application code never calls `process.exit()`. `NodeRuntime.runMain` (and the Bun and Deno equivalents) turns SIGINT and SIGTERM into interruption of the main fiber, which closes the root scope. The process exits only after teardown: `0` for success, `130` when the Cause holds only interruptions, otherwise the error's `[Runtime.errorExitCode]` or `1`.

- **A repeated signal does not force an exit** (probed: SIGTERM, SIGINT, SIGTERM during a slow finalizer still ran it to completion and exited `130`). Forced termination is the orchestrator's SIGKILL, which no finalizer survives — so every finalizer needs its own bound.
- **Add the bounds up.** Deregistration wait + drain + child `forceKillAfter` + pool close + exporter flush must fit inside the platform's grace period (Kubernetes: `terminationGracePeriodSeconds`, 30 by default) with room to spare.
- **Two built-in bounds to know.** `NodeHttpServer` stops accepting on scope close, lets in-flight requests finish, and after `gracefulShutdownTimeout` (20 seconds unless you pass one) interrupts the handlers that remain; the client of an interrupted handler received a 503 (probed). It waits for *connections*, not only responses, so a keep-alive client can hold the close open past the last response — about three seconds against a `fetch` client in the probe — and the budget should assume the full timeout. A scoped child process is awaited without any bound unless the command sets `forceKillAfter` — see [ChildProcessSpawner](../interfaces/platform-runtime-hosts#childprocessspawner).
- **In a container, make sure the signal arrives.** A shell-form entrypoint makes the shell PID 1 and Node never sees SIGTERM. Use the exec form or an init that forwards signals.

The copy-ready entrypoint is [Recipe: A Graceful Node Entrypoint](../recipes/graceful-entrypoint-and-shutdown).

## Bridge into a host that is not Effect

When Express, Hono, a UI framework, or a plugin API owns invocation, the root scope is a `ManagedRuntime`, and the same sequence has to be written by hand on the host side, because the host — not a Layer — owns intake. Three probed facts shape the protocol:

- **`dispose()` is not a drain.** It interrupts every fiber the runtime started *while* the Layer scope closes — in the probe a request's finalizer was still running when the pool was released. Stop admission and wait for in-flight work first; then dispose. A second `dispose()` is a no-op, and a run after disposal dies with `ManagedRuntime disposed`.
- **The first run pays for the Layer, and a failed build is permanent.** The build runs once; its failure is replayed to every later call. Warm the runtime at boot (`runtime.runPromise(Effect.void)`) so a broken deployment fails its start-up probe, and treat that failure as fatal rather than something the next request retries.
- **Cancellation crosses two hops.** `runtime.runPromise(effect, { signal })` turns the host's abort into interruption; inside, `Effect.tryPromise((signal) => …)` must hand *Effect's* signal to the SDK. An already-aborted signal still runs the Effect's synchronous prefix, so check `signal.aborted` before calling the runtime.

The per-callback protocol — warm, admit, forward, one memoized shutdown — is written out in [Recipe: ManagedRuntime at an Imperative Boundary](../recipes/managed-runtime-integration), and the two hops are proven end to end in [Recipe: Request Cancellation Through a Host](../recipes/request-cancellation-through-a-host).

**Never start an interior detached runner.** An `Effect.runFork(...)` or `forkDetach` inside a service method, written so that "the audit write survives the request", creates a fiber that shutdown cannot interrupt and that keeps using a pool after the Layer released it. Transfer the work to an owner that outlives the request instead:

> **Example status — Contextual:** `deliverAuditEvent` stands for the real delivery.

```ts
import { Context, Effect, Layer, Queue } from "effect"

declare const deliverAuditEvent: (event: string) => Effect.Effect<void>

class AuditOutbox extends Context.Service<AuditOutbox, {
  readonly enqueue: (event: string) => Effect.Effect<void>
}>()("app/AuditOutbox") {
  static layer = Layer.effect(
    AuditOutbox,
    Effect.gen(function*() {
      // What bounds it: a full outbox pushes back on requests instead of growing without limit.
      const pending = yield* Queue.bounded<string>(1_000)
      // Who closes it: this Layer's scope — the application instance, or the ManagedRuntime.
      yield* Effect.forkScoped(
        Effect.forever(Effect.flatMap(Queue.take(pending), deliverAuditEvent))
      )
      return { enqueue: (event) => Effect.asVoid(Queue.offer(pending, event)) }
    })
  )
}
```

The request returns as soon as `enqueue` does; the delivery fiber belongs to the Layer, appears in the ledger, and stops in order. Give it the same bounded drain as the consumer above if losing queued events at shutdown is not acceptable.

## The host matrix

The business code is the same in every row. What changes is who owns the runtime, when it is disposed, and where cancellation of one unit of work comes from.

| Host | Who owns the runtime | When it is disposed | What cancels one unit of work |
| --- | --- | --- | --- |
| Node, Bun, or Deno server process | The platform `runMain`; the root scope is `Layer.launch(AppLive)` | SIGINT, SIGTERM, or the main Effect ending → scope close → exit code | The server adapter interrupts the request fiber when the client disconnects; scope close interrupts the rest |
| Serverless or Web-standard handler | Module scope: `{ handler, dispose }` from `HttpRouter.toWebHandler` | When the platform calls your shutdown hook — possibly never. Design so that losing the isolate loses nothing | `request.signal`, forwarded by the adapter |
| Foreign framework callback | One `ManagedRuntime`, created at boot | The host's shutdown hook: stop admission → drain → `dispose()`, memoized | The `AbortSignal` you forward as `{ signal }` |
| Browser page | `BrowserRuntime.runMain` for the app | A non-persisted `pagehide` interrupts the main fiber; completion of asynchronous cleanup is not guaranteed | Whatever signal or fiber handle the UI callback holds |
| CLI | The platform `runMain` around `Command.run` | The command finishing, or Ctrl+C | Ctrl+C: interruption, or a typed `QuitError` inside a prompt |
| Worker thread | The parent's scope around `Worker.run` | Parent scope close → close message → five-second grace → `terminate()` (Node and Bun adapters) | The parent interrupting `run`; a dead worker fails it with `WorkerError` |
| Test | The scope of `it.effect` or `it.layer` | End of the test or suite | The test's own interruption, and timeouts driven by `TestClock` |

Before choosing a serverless or edge row, get five answers from the platform: are isolates reused, can invocations overlap, what abort or deadline does a request carry, may work continue after the response, and is a shutdown hook awaited? On such a host the module-level graph amortizes acquisition across invocations of a reused isolate, which is the right trade for a pool — but it must not capture request data, must not assume `dispose` runs, and must not keep serving after a failed build. A request-owned scope gives deterministic cleanup and is wrong for anything expensive to create. What each host can and cannot promise is tabulated in [Platform & Runtime Hosts](../interfaces/platform-runtime-hosts#choosing-a-host).

## Test the lifetime, not just the behavior

A lifetime claim is testable, and the oracle is always the same: **live state before close, terminal state after.** Build the graph in a scope the test owns, assert what is up, close the scope, then assert the order and that every acquisition has its release. Use a handshake (`Deferred`) wherever the test must know work is in flight, and `TestClock` wherever it must know a bound — a sleep proves neither.

> **Example status — Runnable in Vitest:** all three pass on `effect@4.0.0` with `@effect/vitest`.

```ts
import { assert, it } from "@effect/vitest"
import { Data, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"

// A recording resource: the test double for a pool, an exporter, or a listener.
const recorded = (events: Ref.Ref<ReadonlyArray<string>>, name: string) =>
  Layer.effectDiscard(
    Effect.acquireRelease(
      Ref.update(events, (all) => [...all, `+${name}`]),
      () => Ref.update(events, (all) => [...all, `-${name}`])
    )
  )

class ProbeFailed extends Data.TaggedError("ProbeFailed")<{}> {}

it.effect("releases in reverse order and leaks nothing", () =>
  Effect.gen(function*() {
    const events = yield* Ref.make<ReadonlyArray<string>>([])
    const App = recorded(events, "listener").pipe(
      Layer.provide(recorded(events, "pool")),
      Layer.provide(recorded(events, "exporter"))
    )

    const scope = yield* Scope.make()
    yield* Layer.buildWithScope(App, scope)
    // Live state BEFORE close: everything is up, nothing has been released.
    assert.deepStrictEqual(yield* Ref.get(events), ["+exporter", "+pool", "+listener"])

    yield* Scope.close(scope, Exit.void)
    // Terminal state AFTER close: dependents first, and every + has its -.
    assert.deepStrictEqual(
      yield* Ref.get(events),
      ["+exporter", "+pool", "+listener", "-listener", "-pool", "-exporter"]
    )
  }))

it.effect("a failed startup releases what it acquired and keeps the first failure", () =>
  Effect.gen(function*() {
    const events = yield* Ref.make<ReadonlyArray<string>>([])
    const Probe = Layer.effectDiscard(Effect.fail(new ProbeFailed()))
    const App = Probe.pipe(Layer.provide(recorded(events, "pool")))

    const exit = yield* Effect.exit(Layer.launch(App))

    assert.deepStrictEqual(exit, Exit.fail(new ProbeFailed()))
    assert.deepStrictEqual(yield* Ref.get(events), ["+pool", "-pool"])
  }))

it.effect("drains for at most the bound, then interrupts survivors before the pool closes", () =>
  Effect.gen(function*() {
    const events = yield* Ref.make<ReadonlyArray<string>>([])
    const started = yield* Deferred.make<void>()

    const stuckJob = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Ref.update(events, (all) => [...all, "job interrupted"]))
    )
    const Worker = Layer.effectDiscard(
      Effect.gen(function*() {
        const inFlight = yield* FiberSet.make()
        yield* Effect.addFinalizer(() =>
          FiberSet.awaitEmpty(inFlight).pipe(Effect.timeoutOption("5 seconds"))
        )
        yield* FiberSet.run(inFlight, stuckJob)
      })
    ).pipe(Layer.provide(recorded(events, "pool")))

    const scope = yield* Scope.make()
    yield* Layer.buildWithScope(Worker, scope)
    yield* Deferred.await(started) // a handshake, not a sleep

    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
    yield* TestClock.adjust("4999 millis")
    assert.deepStrictEqual(yield* Ref.get(events), ["+pool"]) // still draining

    yield* TestClock.adjust("1 millis")
    yield* Fiber.join(closing)
    assert.deepStrictEqual(yield* Ref.get(events), ["+pool", "job interrupted", "-pool"])
  }))
```

Give each of these its own test: a request that succeeds, fails with a typed error, dies, or is interrupted; a resource that fails to acquire as the first one and as a later one, after earlier resources are already open; a stop signal that arrives mid-startup; shutdown requested twice, or from two fibers at once; a drain that empties in time and one that runs out its deadline; a failing finalizer followed by finalizers that must still run; and a second instance started once the first has fully shut down.

Recording resources are the cheapest of three fidelities, and each proves less than it seems:

| Fidelity | Proves | Does not prove |
| --- | --- | --- |
| Recording resources (above) | Order, balance, bounds, and that survivors are interrupted | That a real driver, socket, or OS honors the release |
| Real adapters, test-owned scope | The port can be re-bound, the lock re-acquired, the pool rejects use after close | Signal handling, exit codes, packaging |
| Built artifact in a subprocess | Readiness flips, SIGTERM drains, the exit code is `130`, bundled workers still load | Other operating systems — a POSIX signal test says nothing about Windows |

Tests at every level own and close what they open and exit without force flags; a suite that needs `--forceExit` has found a leak.

## Operational checklist

- Every resource, long-lived fiber, and runtime is a row in a ledger with an owner, a bound, a release, and a proof. No row says "the process".
- `Scope` never reaches the entrypoint's `R` by accident; each discharge (`Effect.scoped`, `Layer.effect`, a hand-made scope) is a chosen lifetime.
- One `acquireRelease` per allocation; every finalizer has a bound and a stated policy for its own failure.
- Startup probes through the assembled graph and fails before any intake exists. Readiness is acquired last and released first.
- Liveness never checks dependencies. Readiness is `false` while starting *and* while draining.
- Shutdown is closing one scope: intake stops, in-flight work drains within a deadline, survivors are interrupted and awaited, resources release in reverse.
- Order that matters is a dependency, not a convention between `mergeAll` peers.
- The sum of all shutdown bounds fits inside the platform's grace period; child processes set `forceKillAfter`.
- Signals reach the process (exec-form entrypoint), the platform `runMain` handles them, and application code never calls `process.exit()`.
- A foreign host gets one warmed `ManagedRuntime`, a synchronous admission flag, a forwarded `AbortSignal`, and one memoized stop → drain → dispose.
- No interior `runFork` or `forkDetach`; work that outlives a request is handed to a Layer-owned, bounded supervisor.
- Lifetime tests assert live state before close and terminal state after, use handshakes and `TestClock`, and exit without force flags.
