# RPC

Effect 4's RPC is schema-first and transport-agnostic. One contract — a group of procedures, each with payload/success/error Schema — derives a server, a typed client, and a test harness. Wire format and transport are pluggable layers. The contract never changes.

> **Note:** Twelve modules; three core nouns and adapters. **Rpc** + **RpcGroup** define the contract. **RpcServer** runs handlers; **RpcClient** derives the caller. **RpcSerialization** picks the wire encoding; the `layerProtocol*` functions pick the pipe. **RpcMiddleware**, **RpcSchema**, **RpcMessage**, **RpcClientError**, **RpcWorker**, **RpcTest**, and **Utils** are supporting modules.

## Rpc

`effect/rpc` — unstable

One procedure. `Rpc.make(tag, options)` records a tag plus four Schemas: `payload` (request), `success` (happy result), `error` (typed recoverable failures), and optional `defect` for unexpected deaths.

**Mental model.** An `Rpc` is a typed envelope spec both ends agree on. The client reads it to know what to send and what comes back; the server reads it to know what to decode and must return. The declaration is pure data — no shared implementation, only this definition.

`payload` accepts a Schema or bare struct fields (auto-wrapped in `Schema.Struct`). Pass `stream: true` to make success a stream of values. Subclass to get a nominal type for `yield*` and annotation.

```ts
import { Schema } from "effect"
import { Rpc } from "effect/rpc"

// Your typed, recoverable error — a normal Schema tagged error.
class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {
  employeeId: Schema.String
}) {}

class Compensation extends Schema.Class<Compensation>("Compensation")({
  employeeId: Schema.String,
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  baseSalary: Schema.BigDecimal
}) {}

// A single procedure: payload in, Compensation out, EmployeeNotFound as the typed failure.
const GetComp = Rpc.make("GetComp", {
  payload: { employeeId: Schema.String }, // struct fields are auto-wrapped in Schema.Struct
  success: Compensation,
  error: EmployeeNotFound
})

// Subclass form — gives you a nameable type and a place to hang annotations.
class ProposeRaise extends Rpc.make("ProposeRaise", {
  payload: { employeeId: Schema.String, amount: Schema.BigDecimal },
  success: Compensation
}) {}
```

> **Tip:** `Rpc.fork(effect)` forces a response to run concurrently regardless of the server's concurrency setting; `Rpc.uninterruptible(effect)` runs it in an uninterruptible region. Both work on Effects and Streams. `primaryKey: (payload) => string` turns the payload into a keyed request (required by the cluster layer, useful for dedup/caching).

> **Warning:** **Defects cross the wire.** Unlike [HttpApi](http-api#status-mapping-is-part-of-the-contract), which answers a defect with an empty `500`, an RPC server serializes it: an `Error`'s `name`, `message`, and `cause` travel to the peer (stacks are omitted unless a schema opts in). For example, `Effect.die(new Error("connect postgres://comp:hunter2@db"))` in a handler arrives at the client verbatim. By default the server treats a handler defect as *fatal to the connection* and encodes it with the generic `Schema.Defect()`; the per-procedure `defect` schema passed to `Rpc.make` is used only when the server runs with `disableFatalDefects: true` (see [operational defaults](#operational-defaults)). Keep secrets out of error messages, translate infrastructure failures before they can become defects, and for untrusted peers either catch defects in a group-wide middleware (`Effect.catchDefect`, log the original, die with a fixed value) or combine `disableFatalDefects: true` with a `defect` schema that encodes to a content-free value.

**Reach for it when** describing exactly one remote call with inputs, outputs, and failures captured as Schema.

## RpcGroup

`effect/rpc` — unstable

A collection of `Rpc` definitions keyed by tag, forming the service contract. `RpcGroup.make(...rpcs)` builds it; `.add`, `.merge`, `.omit`, `.prefix`, `.middleware`, and `.annotateRpcs` shape it. Hand this single value to both server and client.

**Mental model.** The group is the interface; `group.toLayer(handlers)` is the implementation. The handlers object is exhaustively type-checked: every tag needs a handler receiving the decoded payload and returning an Effect (or Stream) whose success/error matches that procedure's Schemas. Missing tag or wrong return type fails to compile.

```ts
import { BigDecimal, Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {
  employeeId: Schema.String
}) {}

class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()("BudgetExceeded", {
  employeeId: Schema.String,
  requested: Schema.BigDecimal
}) {}

class Compensation extends Schema.Class<Compensation>("Compensation")({
  employeeId: Schema.String,
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  baseSalary: Schema.BigDecimal
}) {}

// 1. The contract — three procedures in one group.
export class CompRpc extends RpcGroup.make(
  Rpc.make("GetComp", {
    payload: { employeeId: Schema.String },
    success: Compensation,
    error: EmployeeNotFound
  }),
  Rpc.make("ProposeRaise", {
    payload: { employeeId: Schema.String, amount: Schema.BigDecimal },
    success: Compensation,
    error: Schema.Union([EmployeeNotFound, BudgetExceeded])
  }),
  Rpc.make("ApproveGrant", {
    payload: { employeeId: Schema.String, shares: Schema.Natural },
    success: Schema.Void
  })
) {}

// A service the handlers depend on, like any other Effect service.
class CompService extends Context.Service<CompService>()("app/CompService", {
  make: Effect.succeed({
    find: (employeeId: string) =>
      employeeId === "E-1"
        ? Effect.succeed(new Compensation({ employeeId, level: 4, baseSalary: BigDecimal.fromBigInt(180000n) }))
        : Effect.fail(new EmployeeNotFound({ employeeId })),
    raise: (employeeId: string, amount: BigDecimal.BigDecimal) =>
      Effect.succeed(new Compensation({ employeeId, level: 4, baseSalary: BigDecimal.sum(BigDecimal.fromBigInt(180000n), amount) })),
    grant: (_employeeId: string, _shares: number) => Effect.void
  })
}) {}

// 2. The implementation — exhaustively typed against the group.
export const CompLive = CompRpc.toLayer(
  Effect.gen(function*() {
    const comp = yield* CompService
    return {
      GetComp: ({ employeeId }) => comp.find(employeeId),            // Effect<Compensation, EmployeeNotFound>
      ProposeRaise: ({ employeeId, amount }) => comp.raise(employeeId, amount),
      ApproveGrant: ({ employeeId, shares }) => comp.grant(employeeId, shares) // Effect<void>
    }
  })
)
```

Every handler's second argument carries `{ client, requestId, headers, rpc }` — connected client metadata, request id, inbound headers, and the RPC definition itself.

> **Note:** `group.merge(other)` combines contracts; `group.prefix("admin.")` namespaces every tag; `group.middleware(MyMiddleware)` attaches a cross-cutting service to every procedure added so far. For one-off handler wiring: `group.toLayerHandler("GetComp", fn)`.

### Evolving a contract

The group *is* the wire protocol. Everything a peer can observe — the final tag (after `prefix`), the payload/success/error schemas, middleware errors, the defect policy, the serializer, and the framing — is versioned by deployment, not by the compiler, because client and server are rarely redeployed in the same instant.

| Change | Compatible? | Do this |
| --- | --- | --- |
| Add a procedure | yes, if old servers never receive it | deploy servers first; an unknown tag is answered with a **defect** (`Unknown request tag: ...`), not a typed error (probed) |
| Add an optional payload field with explicit decode semantics (`Schema.optionalKey`, a decoding default) | yes | deploy tolerant servers before clients that send it |
| Add a required payload field, tighten a check, rename or remove a field | no | a payload that fails to decode is answered with a defect carrying the formatted schema issue, and the handler never runs (probed) — add a new procedure instead |
| Add a member to `error` or to a success union | no for old clients | an old client cannot decode the new member; ship clients that know it first, then let servers produce it |
| Change a tag, a `prefix`, or what a stable tag *means* | no | introduce `ApproveRaiseV2`, keep the old tag through the rollback window, then remove it |
| Swap `RpcSerialization`, framing, or `fingerprintPayloads` | no | both peers must change together; bridge with a second endpoint |

- **Give every final tag one stable identity.** `RpcGroup.add` and `merge` keep a map keyed by tag, so a duplicate tag silently replaces the earlier definition (probed: merging two groups that both define `GetComp` leaves one, the later). Do not let merge order decide which procedure wins — prefix groups (`group.prefix("comp.")`) or assert uniqueness in a test.
- **Test the skew, not just the head.** Keep a frozen copy of the previous release's group and exercise both mixed pairings (the previous client against the new server, and the new client against the previous server) through a real serializer; [`RpcTest`](#rpctest) cannot see these failures.
- Schema-level techniques for tolerant evolution (optional keys, decoding defaults, unions of versions) are in [Schema](../data/schema#schema).

**Reach for it when** you want a single typed surface the server implements and the client mirrors.

## RpcServer

`effect/rpc` — unstable

The runtime that takes a group, its handler layer, a serialization layer, and a transport, and serves requests. Decodes incoming payloads with the procedure's Schema, runs the matching handler (and any middleware), tracks in-flight requests, honours acks and interrupts, encodes the result back to the client.

**Mental model.** `RpcServer.layer(group)` is the engine; it needs a `Protocol` (transport boundary) plus handlers in context. For the common case, `RpcServer.layerHttp({ group, path, protocol })` bundles the engine and transport and registers a route on an `HttpRouter`. Pick wire format separately with a serialization layer — swapping JSON for SchemaBinary is one line.

```ts
import { Layer } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { HttpRouter } from "effect/http"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { createServer } from "node:http"

// Mount the CompRpc group at POST /rpc, over HTTP, framed as ndjson.
const RpcRoute = RpcServer.layerHttp({
  group: CompRpc,
  path: "/rpc",
  protocol: "http" // or "websocket" (the default)
}).pipe(
  Layer.provide(CompLive),                    // your handlers
  Layer.provide(RpcSerialization.layerNdjson) // the wire format
)

// Serve it like any other HTTP app.
const HttpLive = HttpRouter.serve(RpcRoute).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

NodeRuntime.runMain(Layer.launch(HttpLive))
```

Additional protocol layers: `layerProtocolWebsocket`, `layerProtocolSocketServer` (raw TCP), `layerProtocolStdio` (CLIs; for a Model Context Protocol server use `McpServer.layerStdio` from `effect/ai`, which builds on this RPC machinery — see [Exposing an Effect Application over MCP](../deep-dives/exposing-an-effect-application-over-mcp)), `layerProtocolWorkerRunner` (server half of a Worker). Compose `RpcServer.layer(group)` with any of them to use the engine without the HTTP router.

> **Warning:** `layerHttp` and `layerProtocolHttp` register their route on whichever `HttpRouter` is in context when their Layer is built — they don't bring their own router. [`HttpRouter.serve`](http-server#httprouter) builds a *fresh* router in a forked layer memo map for each entrypoint, so that route is only reachable when `RpcRoute` (or the layer wrapping it) is passed directly into `serve`'s own argument, as above. Pulling `RpcRoute` out from under `serve` and providing it to a router built elsewhere — for example via a separate `Layer.provide(HttpRouter.layer)` — builds against a private router that `serve` never mounts, so the route silently goes unserved.

Choosing a transport is choosing what you must prove before shipping it:

| Transport | You own | Prove with a real peer |
| --- | --- | --- |
| HTTP (`protocol: "http"`) | body and frame limits, proxy buffering of streamed responses, cookies/CORS/CSRF | an aborted request interrupts the handler; an oversized body is refused; a streamed reply is not buffered whole by the proxy |
| WebSocket / socket | authentication and `Origin` check at upgrade, heartbeat (the client pings and treats a missed pong as a connection failure), idle and maximum connection lifetime, reconnect and re-subscribe, ack-based flow control | disconnect cleans up every in-flight handler; a reconnect does not double-apply a mutation |
| Worker | the initial-message handshake, ownership of transferred buffers, pool bounds, worker death | a crashed worker fails its calls instead of hanging them |
| stdio | strict framing, **stdout reserved for the protocol** (log to stderr), draining stderr, child-process ownership | a stray `console.log` in the server does not corrupt the stream |

### Operational defaults

`RpcServer.layer`, `layerHttp`, and `make` share these options. Several defaults favor throughput over protection; choose each deliberately.

| Option | Default | What it means |
| --- | --- | --- |
| `concurrency` | `"unbounded"` | Every request starts its handler immediately. A number creates one server-wide `Semaphore`, so at most that many handlers run and the rest wait for a permit. |
| `Rpc.fork(effect)` in a handler | — | **Skips that semaphore entirely** (probed: with `concurrency: 1`, four plain calls ran one at a time and four forked calls ran all at once). Audit every use; reserve it for cheap control-plane calls (health, cancel) that must not queue behind slow work. |
| `streamBufferSize` (`layerHttp`, `layerProtocolHttp`) | `16` | A framed HTTP response stream buffers at most 16 encoded messages ahead of the socket and then backpressures the handler. `"unbounded"` disables the limit. Unframed `layerJson` responses are collected whole. |
| `disableFatalDefects` | `false` | A handler defect is sent as a connection-level `Defect`: **every in-flight call multiplexed on that client fails with it** (probed with `RpcTest`). `true` confines it to the failing request and encodes it with the procedure's `defect` schema. Over the HTTP protocol each POST is its own client, so the blast radius is that request batch; over a WebSocket, socket, or worker it is the connection. |
| `disableTracing`, `spanPrefix`, `spanAttributes` | tracing on, no prefix | One span per call named by the RPC method tag (e.g. `GetComp`); pass `spanPrefix: "RpcServer"` to restore the old `RpcServer.GetComp` form. Spans record `rpc.system.name: "effect_rpc"` and `rpc.method`. The socket, WebSocket, stdio, and worker protocols carry the caller's trace context in the RPC envelope. |

Five mechanisms are easy to conflate and do not substitute for each other: **handler concurrency** (`concurrency`), **stream acks** (the client acknowledges each chunk, pacing a streaming handler — on the socket, WebSocket, stdio, and worker protocols, not HTTP), **transport backpressure** (`streamBufferSize`, the socket), **JSON-RPC batching** (several messages in one frame), and **`RequestResolver` batching** inside a handler ([Caching and batching](../operations/caching-batching)). A capacity plan names a finite value for each of: body and frame bytes (`maxFrameSize`, `maxBufferSize`, and [`MaxBodySize`](http-server#edge-policy-checklist) for HTTP), connections and their maximum lifetime, in-flight calls, per-principal rate, stream queue depth, a server-side deadline for every call and stream (`Effect.timeout` in the handler or a middleware — a browser tab that closes cannot be relied on to send `Interrupt`), and the shutdown drain. It also states the overload behavior in one word: reject, queue, shed, or close.

Request lifetime is request-owned: when the client interrupts a call, or an HTTP client disconnects, the server interrupts the matching handler fiber and its finalizers run. `Rpc.uninterruptible(effect)` opts a handler out — use it only for a short critical section, because cancellation is not rollback: a mutation interrupted halfway needs a transaction ([SQL transactions](sql#transactions)), not a hopeful client.

**Reach for it when** you are the callee and need to expose handlers over a real transport.

## RpcClient

`effect/rpc` — unstable

The mirror of the server, derived from the same group. `RpcClient.make(group)` returns an object with one method per procedure; calling `client.GetComp({ employeeId })` returns an `Effect` with exactly the success and error types the group declared. No codegen, no duplicated types.

**Mental model.** The client encodes the payload, ships it through the current `Protocol`, decodes the response, and reconstructs typed errors so `Effect.catchTag("EmployeeNotFound", ...)` works on the calling side. Failures below the contract (connection dropped, malformed frame) surface as `RpcClientError`.

```ts
import { BigDecimal, Effect, Layer } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { FetchHttpClient } from "effect/http"

// Transport: HTTP to the server's /rpc endpoint, ndjson on the wire.
const ProtocolLive = RpcClient.layerProtocolHttp({
  url: "http://localhost:3000/rpc"
}).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(FetchHttpClient.layer)
)

const program = Effect.gen(function*() {
  // Derived from CompRpc — fully typed, same contract as the server.
  const client = yield* RpcClient.make(CompRpc)

  const comp = yield* client.GetComp({ employeeId: "E-1" })          // Compensation

  // Propose a raise; the typed errors from the contract are catchable here:
  const raised = yield* client.ProposeRaise({
    employeeId: "E-1",
    amount: BigDecimal.fromBigInt(12000n)
  }).pipe(
    Effect.catchTag("BudgetExceeded", () => Effect.succeed(comp)),     // keep current comp if over budget
    Effect.catchTag("EmployeeNotFound", ({ employeeId }) =>
      Effect.die(`unknown employee ${employeeId}`)
    )
  )

  yield* Effect.log(`base now ${BigDecimal.format(raised.baseSalary)}`)
}).pipe(Effect.scoped, Effect.provide(ProtocolLive))
```

> **Tip:** Attach per-call headers with `RpcClient.withHeaders(effect, { authorization: token })` — they merge with `CurrentHeaders` and ride on outgoing requests, readable by the handler via `headers`. Pass `{ flatten: true }` to `RpcClient.make` to get a single `client(tag, payload)` function instead of a method-per-procedure object — useful for generic wrappers. Matching client transports: `layerProtocolHttp`, `layerProtocolSocket`, `layerProtocolWorker`. Socket clients accept `pingInterval` and `pingTimeout` options (both default to 5 seconds); any decoded server frame counts as liveness, so only a genuinely quiet connection triggers a ping.

### Retried mutations need a ledger

A call that fails with `RpcClientError` has an **unknown outcome**: the request may never have left, or the handler may have committed just before the connection dropped. Anything that sends it again — `Effect.retry` around the call, `HttpClient.retryTransient` inside `layerProtocolHttp({ transformClient })`, a user clicking twice, a socket client reconnecting with `retryTransientErrors` and the caller retrying — can apply the mutation twice. A missed heartbeat pong always fails every in-flight call on that connection, even with `retryTransientErrors` enabled and a reconnect under way — `onTransientError` is not invoked for it, only for a retried connection-open failure — so a pong timeout is exactly the kind of unknown-outcome failure this section is about. Reads are replay-safe; mutations need a protocol:

- **The caller mints one idempotency key per intent** and reuses it on every retry. A payload id the *server* generates, or a fresh key per attempt, deduplicates nothing.
- **The server records the key and the outcome in the same transaction as the mutation**, and on a repeat returns the recorded outcome instead of running again. An in-memory `Set` loses the ledger on restart and is wrong across replicas.
- **Decide what a key conflict means**: the same key with a *different* payload is a caller bug — fail with a declared conflict error rather than returning the old result.
- **Or state the trade-off**: "at most once, no retry" is a legitimate contract for a mutation, as long as the caller surfaces "outcome unknown" instead of guessing.

```ts
import { Context, Effect, Option, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

class RaiseApproval extends Schema.Class<RaiseApproval>("RaiseApproval")({
  raiseId: Schema.String,
  approvedBy: Schema.String
}) {}

class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()("IdempotencyConflict", {
  requestKey: Schema.String
}) {}

export class ApprovalsRpc extends RpcGroup.make(
  Rpc.make("ApproveRaise", {
    // Minted once by the caller for this intent; identical on every retry.
    payload: { requestKey: Schema.String, raiseId: Schema.String },
    success: RaiseApproval,
    error: IdempotencyConflict
  })
) {}

// A durable ledger: both methods run inside the use case's transaction.
class MutationLedger extends Context.Service<MutationLedger, {
  readonly find: (
    requestKey: string
  ) => Effect.Effect<Option.Option<{ readonly raiseId: string; readonly outcome: RaiseApproval }>>
  readonly record: (requestKey: string, raiseId: string, outcome: RaiseApproval) => Effect.Effect<void>
}>()("app/MutationLedger") {}

declare const approveRaise: (raiseId: string) => Effect.Effect<RaiseApproval>
declare const inTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

export const ApprovalsLive = ApprovalsRpc.toLayer(
  Effect.gen(function*() {
    const ledger = yield* MutationLedger
    return {
      ApproveRaise: ({ raiseId, requestKey }) =>
        inTransaction(Effect.gen(function*() {
          const previous = yield* ledger.find(requestKey)
          if (Option.isSome(previous)) {
            return previous.value.raiseId === raiseId
              ? previous.value.outcome // a retry: replay the recorded answer
              : yield* new IdempotencyConflict({ requestKey })
          }
          const outcome = yield* approveRaise(raiseId)
          yield* ledger.record(requestKey, raiseId, outcome) // commits with the mutation, or not at all
          return outcome
        }))
    }
  })
)
```

The transaction boundary and the post-commit side of this pattern are covered by [SQL transactions](sql#transactions) and the [transactional write with outbox recipe](../recipes/transactional-write-with-outbox).

**Reach for it when** you are the caller and want a typed client derived from the group.

## RpcClientError

`effect/rpc` — unstable

The error a derived client raises for a transport or protocol failure rather than a declared remote error. Its `reason` is a union of transport failures — HTTP client errors, socket errors, worker errors — plus `RpcClientDefect` for protocol violations and decode failures (e.g. empty or malformed response).

**Mental model.** Two error channels: contract typed errors (e.g. `EmployeeNotFound`) are application failures, catchable by tag. `RpcClientError` is infrastructure failure — it does **not** prove that the request was never sent or executed. A handler may commit before the connection drops or its response fails to decode, leaving the caller with an **unknown outcome**. Match on `error.reason._tag` to distinguish a dropped socket from a garbled frame, and use the [mutation retry ledger](#retried-mutations-need-a-ledger) before replaying a write.

```ts
import { Effect } from "effect"
import { RpcClientError } from "effect/rpc/RpcClientError"

const robust = client.GetComp({ employeeId: "E-1" }).pipe(
  Effect.catchTag("EmployeeNotFound", () => Effect.succeed(null)), // contract error
  // catchIf recovers only the matching failures; everything else stays in the error channel.
  Effect.catchIf(
    (e) => e instanceof RpcClientError && e.reason._tag === "RpcClientDefect",
    (e) => Effect.logError(`protocol problem: ${e.reason.message}`)
  )
)
```

### Keep six failure categories distinguishable

| Category | Where it shows up on the client | Treat it as |
| --- | --- | --- |
| Declared operation or middleware failure | typed error, `Effect.catchTag` | a business outcome |
| Stream element or terminal failure | the `Stream`'s error channel | a business outcome, mid-stream |
| Request or response schema incompatibility | a **defect** carrying the formatted schema issue (server could not decode the payload or encode the reply), or a decode failure on the client | version skew — a deployment problem, never a domain failure |
| Envelope, framing, or serializer failure | `RpcClientError` with `reason._tag === "RpcClientDefect"` | a protocol bug or a mismatched serializer |
| Transport failure | `RpcClientError` whose `reason` is an HTTP client, socket, or worker error | outcome unknown — see [retried mutations](#retried-mutations-need-a-ledger) |
| Handler defect or interruption | a defect, or interruption of the calling fiber | an invariant breach or a cancellation; not retryable, not a user-facing message |

Collapsing these — mapping every failure to one "RPC failed" error, or retrying all of them — throws away the only information that says whether a retry is safe and whose bug it is.

**Reach for it when** you need to react to transport-level failures distinctly from contract business errors.

## RpcMiddleware

`effect/rpc` — unstable

Cross-cutting concerns — auth, logging, rate limiting — modeled as a typed service attached to procedures. `RpcMiddleware.Service<Self, { provides, requires }>()(name, { error })` declares middleware that can fail with a typed `error` and `provides` a service to the handlers behind it.

**Mental model.** Middleware wraps the handler and rewires type-level requirements. If auth middleware `provides: CurrentManager`, any handler under it may `yield* CurrentManager` and the compiler knows that dependency is satisfied. Attach with `.middleware(M)` on an individual `Rpc` or on an `RpcGroup`.

```ts
import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"

class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

// The approving manager for this call. No default impl — the middleware supplies it.
class CurrentManager extends Context.Service<CurrentManager, {
  readonly id: string
}>()("app/CurrentManager") {}

// Middleware that authenticates and PROVIDES CurrentManager to downstream handlers.
class Authenticated extends RpcMiddleware.Service<Authenticated, {
  provides: CurrentManager
}>()("app/Authenticated", {
  error: Unauthorized
}) {}

// A protected procedure; CurrentManager is satisfied by the middleware, not the handler.
class WhoApproves extends Rpc.make("WhoApproves", {
  success: Schema.String
}).middleware(Authenticated) {}

const AuthedRpc = RpcGroup.make(WhoApproves)

const AuthedLive = AuthedRpc.toLayer({
  WhoApproves: () => Effect.map(CurrentManager, (m) => m.id) // CurrentManager is in scope
})
```

Provide the server-side behaviour with a `Layer.succeed(Authenticated)(...)` whose value is a middleware function: receives the handler `effect` plus `options` (including request `headers`), reads the caller from headers, uses `Effect.provideService` to inject the provided service into the handler. `RpcMiddleware.layerClient` handles middleware that also needs to run on the client (e.g. signing a request) — declare with `requiredForClient: true`.

```ts
import { Effect, Layer } from "effect"

// Server-side implementation: a function that wraps the handler and provides the service.
const AuthedServer = Layer.succeed(Authenticated)(
  Authenticated.of((effect, options) =>
    Effect.provideService(effect, CurrentManager, {
      id: options.headers["x-manager-id"] ?? "unknown"
    })
  )
)
```

> **Warning:** The layer above shows only the wiring. It trusts a caller-supplied `x-manager-id` header and falls back to `"unknown"`, which is acceptable behind a test harness and nowhere else: any client can type any manager id.

### Client middleware attaches; only the server edge enforces

A client middleware (`RpcMiddleware.layerClient`) can attach a credential. It cannot enforce anything, because the peer may not be your client at all. Enforcement happens where the procedure is reachable:

1. **Extract** the credential from an allowed location — and still treat it as untrusted. Headers, connection ids, remote addresses, and forwarded fields are claims, not facts. Trust proxy-supplied identity only when the backend is unreachable except through that proxy.
2. **Verify** it cryptographically or resolve it against a session store; keep it `Redacted` until the verifier needs the bytes. Absent, malformed, expired, or revoked all fail with the *same* declared, non-revealing error.
3. **Provide** a decoded principal through `provides` — never the raw token.
4. **Authorize per procedure** against the concrete actor · action · tenant · resource, with a second declared error. A middleware annotation or a "this group is internal" comment is not an authorization check.

```ts
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { Headers } from "effect/http"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"

class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}

class CurrentManager extends Context.Service<CurrentManager, {
  readonly id: string
  readonly canApprove: boolean
}>()("app/CurrentManager") {}

class SessionVerifier extends Context.Service<SessionVerifier, {
  readonly verify: (
    token: Redacted.Redacted<string>
  ) => Effect.Effect<CurrentManager["Service"], Unauthorized>
}>()("app/SessionVerifier") {}

class Authenticated extends RpcMiddleware.Service<Authenticated, {
  provides: CurrentManager
}>()("app/Authenticated", {
  error: Unauthorized,
  requiredForClient: true // the derived client will not build without a client layer
}) {}

// Server edge: verify, then provide. No credential, no handler.
export const AuthenticatedLive = Layer.effect(
  Authenticated,
  Effect.gen(function*() {
    const verifier = yield* SessionVerifier
    return Authenticated.of((effect, { headers }) =>
      Effect.gen(function*() {
        const header = headers["authorization"]
        if (header === undefined || !header.startsWith("Bearer ")) {
          return yield* new Unauthorized()
        }
        const manager = yield* verifier.verify(Redacted.make(header.slice("Bearer ".length)))
        return yield* Effect.provideService(effect, CurrentManager, manager)
      })
    )
  })
)

// Client side: attach only. The token comes from a service, not a mutable global.
class SessionToken extends Context.Service<SessionToken, Redacted.Redacted<string>>()(
  "app/SessionToken"
) {}

export const AuthenticatedClient = RpcMiddleware.layerClient(Authenticated, ({ next, request }) =>
  Effect.flatMap(SessionToken, (token) =>
    next({
      ...request,
      headers: Headers.set(request.headers, "authorization", `Bearer ${Redacted.value(token)}`)
    })))

export const Approvals = RpcGroup.make(
  Rpc.make("ApproveRaise", {
    payload: { raiseId: Schema.String },
    success: Schema.String,
    error: Forbidden
  })
).middleware(Authenticated)

export const ApprovalsLive = Approvals.toLayer({
  ApproveRaise: Effect.fn(function*({ raiseId }) {
    const manager = yield* CurrentManager
    if (!manager.canApprove) return yield* new Forbidden() // authorization, per procedure
    return `${manager.id} approved ${raiseId}`
  })
})
```

Probed through `RpcTest`: a valid manager token succeeds, a valid token without the permission fails with `Forbidden`, and an unknown token fails with `Unauthorized` before the handler runs. For per-call credentials on a shared client, prefer `RpcClient.withHeaders(effect, headers)` — it is fiber-scoped, so concurrent calls for different users cannot see each other's headers.

For browsers, the HTTP edge in front of the RPC route still needs a CORS allow-list and, with cookie authentication, a CSRF defense ([edge policy checklist](http-server#edge-policy-checklist)). CORS does not apply to WebSocket upgrades: validate `Origin` and authenticate during the upgrade, before any RPC message is accepted.

**Reach for it when** a concern spans many procedures and should both gate the call and hand the handler a derived service.

## RpcSchema

`effect/rpc` — unstable

Schema helpers specific to RPC — chiefly `RpcSchema.Stream(success, error)`, the success type that turns a procedure into a streaming response. A handler for a streaming RPC returns a `Stream` (or `Queue.Dequeue`); the client receives a `Stream` of decoded values.

**Mental model.** Most procedures are request/response. `RpcSchema.Stream` is the escape hatch for many responses over time — server push, streaming results. Pass `stream: true` to `Rpc.make` and it wraps the schemas automatically.

```ts
import { Schema } from "effect"
import { Rpc, RpcSchema } from "effect/rpc"

class Compensation extends Schema.Class<Compensation>("Compensation")({
  employeeId: Schema.String,
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  baseSalary: Schema.BigDecimal
}) {}

// Explicit stream schema: stream every employee's comp in a department...
const StreamComp = Rpc.make("StreamComp", {
  payload: { departmentId: Schema.String },
  success: RpcSchema.Stream(Compensation, Schema.Never)
})

// ...or the shorthand, which produces the same thing.
const StreamComp2 = Rpc.make("StreamComp", {
  payload: { departmentId: Schema.String },
  success: Compensation,
  stream: true
})
```

Also exposes `RpcSchema.ClientAbort`, a marker the server can use to detect a streaming client disconnect, and `getStreamSchemas` for introspecting whether a success schema is a stream.

A stream is **request-owned and ephemeral**. Decide, per streaming procedure: what an element failure and a terminal failure mean, the ordering guarantee, how it completes, the finite buffers on both sides, what happens to a slow consumer, and which finalizers release the subscription or cursor. When the client stops consuming or disconnects, the server interrupts the handler and the stream's finalizers run — but a browser tab that closes may never send the interrupt, so put a server-side deadline or idle timeout on every long stream. On the client side, if the fiber writing a streaming request to the transport is interrupted, the local stream (or the queue returned with `{ asQueue: true }`) ends with that interruption instead of waiting forever for chunks that will never arrive. A stream is not a durable job, a replay log, or an exactly-once channel: work that must outlive the call belongs in a [workflow](../systems/workflows-durable-execution), and "reconnect and resume" is a feature you build with cursors, retention, re-authorization, and duplicate handling.

**Reach for it when** a procedure produces a sequence of values rather than a single result.

## RpcSerialization

`effect/rpc` — unstable

The pluggable wire format. `RpcSerialization` is a service describing how messages are framed and parsed; provide one of its layers and both client and server use it. Swapping formats is a single layer change with zero impact on contract or handlers.

**Mental model.** The contract decides what travels; serialization decides how it's encoded. Framed formats (NDJSON, SchemaBinary) can stream multiple messages over a long-lived connection; unframed JSON suits one-shot HTTP request/response.

Serialization is **schema-aware**: each `RpcSerialization` carries a `codecFor(schema)` that builds the codec for the payload, chunk, exit, and defect holes inside the protocol envelope. JSON formats return `Schema.toCodecJson`; `layerSchemaBinary` encodes those holes as bytes compiled from the RPC's own schemas. A custom serialization must therefore supply `codecFor` as well as framing.

- **layerJson** — Plain JSON. Unframed — best for one-request-per-HTTP-call.

- **layerNdjson** — Newline-delimited JSON. Framed; ideal for streaming and sockets.

- **layerNdjsonWith({ maxBufferSize })** — NDJSON with an explicit bound on a retained incomplete frame. The default is 16 MiB; `"unbounded"` disables it. Exceeding it fails with `MaxBufferSizeExceeded`.

- **layerSchemaBinary({ maxFrameSize?, fingerprintPayloads? })** — Compact binary frames derived from the RPC schemas (see [SchemaBinary](../concurrency/streaming-channels#schemabinary)). Framed; great for workers, TCP, and high-throughput links. Envelopes are fingerprinted; payload fingerprints are **off** by default so peers can evolve payload schemas compatibly. Frames default to a 16 MiB maximum. It is also what the platform cluster layers (`NodeClusterSocket`, `NodeClusterHttp`, and their Bun/Deno equivalents) select by default — `serialization: "binary"` — with `serialization: "ndjson"` as the explicit alternative.

- **layerJsonRpc / layerNdJsonRpc** — JSON-RPC 2.0 framing for interop with non-Effect peers (e.g. LSP/MCP tooling). Request ids are echoed exactly as sent, including `0` and `""`.

```ts
import { RpcSerialization } from "effect/rpc"

// JSON for a simple HTTP comp endpoint:
const wireJson = RpcSerialization.layerJson
// Binary for a worker or a chatty socket (e.g. streaming a payroll batch):
const wireBinary = RpcSerialization.layerSchemaBinary()
// Tighter frames when both peers always deploy the same schema definition:
const wireBinaryStrict = RpcSerialization.layerSchemaBinary({
  fingerprintPayloads: true,
  maxFrameSize: 4 * 1024 * 1024
})
// JSON-RPC 2.0 for cross-language interop:
const wireJsonRpc = RpcSerialization.layerJsonRpc()
```

> **Warning:** `layerSchemaBinary()` is the binary wire format; it compiles the codec for every payload, chunk, exit, and defect hole directly from the RPC group's own schemas, so it needs no runtime schema registry or format-specific dependency. Nothing negotiates the format, though: changing it is a two-sided deploy, and two binary formats (or a binary and a text format) are not wire-compatible with each other. A rolling upgrade across that boundary needs a format both versions speak — NDJSON, or a second endpoint — as the bridge. Rehearse it in staging: this handbook has not verified mixed-version NDJSON interoperability.

Serialization is chosen independently of the transport, and **both peers must provide the same one** — nothing negotiates it. Every framed format needs a finite bound on an unterminated frame (`maxBufferSize`, `maxFrameSize`); leave `"unbounded"` to trusted, in-process peers.

**Reach for it when** you need to choose or change the on-the-wire encoding — for size, streaming framing, or interop.

## RpcMessage

`effect/rpc` — unstable

The protocol envelope types — messages that flow between client and server once payloads are wrapped for transport. Client-to-server: `Request`, `Ack`, `Interrupt`, `Eof`, `Ping`. Server-to-client: response exits, stream chunks, defects, `Pong`. Also defines branded `RequestId`.

**Mental model.** This is the language transports speak. `RpcClient`/`RpcServer` produce and consume these — but backpressure (`Ack`), cancellation (`Interrupt`), and end-of-stream (`Eof`) live here. Consult when writing a custom transport or debugging framing.

The `Request` envelope flows in both directions: a server protocol can originate requests to a connected client, and a request marked `isNotification` expects no reply — server-originated notifications are a first-class capability, not a transport hack. A protocol advertises the capability as `supportsNotifications`; the buffered (unframed `layerJson`/`layerJsonRpc`) HTTP protocol cannot deliver them and drops server notifications, because a single buffered response has nowhere to put them — use a framed serialization or a socket when the server must push.

A response `Exit`'s encoded `Interrupt` cause carries `fiberId: number | null | undefined` — a serializer or custom protocol that round-trips an interrupted exit must accept a `null` fiber id, not just a number.

Key APIs: Request, Ack, Interrupt, Eof, Ping, ResponseChunk, ResponseExit, RequestId

**Reach for it when** implementing a bespoke `Protocol` or reasoning about acks, interrupts, and stream framing at the wire level.

## RpcWorker

`effect/rpc` — unstable

Glue for running an RPC group over a Worker. Pair `RpcClient.layerProtocolWorker` on the main thread with `RpcServer.layerProtocolWorkerRunner` inside the worker to make a typed group drive a typed worker pool — same contract as HTTP, different pipe.

**Mental model.** Instead of HTTP, messages travel via `postMessage` (with transferables for zero-copy buffers). `RpcWorker` adds the `InitialMessage` service — one schema-encoded value the client hands the worker on startup (config, connection string) before normal requests flow.

```ts
import { Effect, Schema } from "effect"
import { RpcWorker } from "effect/rpc"

// Client side: provide a one-shot initial message to every spawned worker.
const initLayer = RpcWorker.layerInitialMessage(
  Schema.Struct({ hrisUrl: Schema.String }),
  Effect.succeed({ hrisUrl: "postgres://localhost/hris" })
)

// Worker side: read and decode that initial message before serving requests.
const readInit = RpcWorker.initialMessage(
  Schema.Struct({ hrisUrl: Schema.String })
)
```

Combine with `RpcSerialization.layerSchemaBinary()` — binary framing plus transferables is the sweet spot for worker traffic.

**Reach for it when** you want a typed RPC contract to drive a Worker pool, not a network service.

## RpcTest

`effect/rpc` — unstable

In-memory harness that wires a derived client straight to handlers — no transport, no serializer, no HTTP server. `RpcTest.makeClient(group)` connects client and server through the no-serialization path; requests, responses, stream chunks, acks, interrupts, headers, and middleware all flow through the real machinery without bytes on a wire.

**Mental model.** Fastest way to test a group end-to-end. Provide the same handler layer you'd ship in production; the harness gives a typed client that calls it directly. Failures, streams, and middleware behave exactly as over a socket — faster and deterministic.

```ts
import { BigDecimal, Effect } from "effect"
import { RpcTest } from "effect/rpc"

const test = Effect.gen(function*() {
  // Client talks straight to CompLive handlers — no network involved.
  const client = yield* RpcTest.makeClient(CompRpc)

  const raised = yield* client.ProposeRaise({
    employeeId: "E-1",
    amount: BigDecimal.fromBigInt(12000n)
  })
  // assert BigDecimal.equals(raised.baseSalary, BigDecimal.fromBigInt(192000n))

  const missing = yield* client.GetComp({ employeeId: "E-999" }).pipe(Effect.flip)
  // missing is a typed EmployeeNotFound, exactly as a real client would see
}).pipe(Effect.scoped, Effect.provide(CompLive))
```

**What it proves, and what it does not.** `RpcTest.makeClient` runs the real request machinery — handlers, middleware, typed exits, stream chunks, acks, interruption — and the client still validates each payload against the procedure's schema when it builds the request. It skips serialization and transport entirely, so it proves nothing about the encoded form, framing, a serializer mismatch, version skew, frame limits, or what a disconnect does. Cover those in a second ring with a real serializer and listener (an `RpcServer.layerHttp` route on port `0`, see [HTTP Server](http-server#own-the-listener-acquire-late-bind-port-0-prove-release)), and add hostile protocol cases that a typed client can never produce: a frame split across chunks, several frames in one chunk, an unknown tag, an oversized or never-terminated frame, deeply nested JSON, and prototype-pollution-shaped keys (`__proto__`, `constructor`).

**Reach for it when** you want fast, deterministic tests of a whole group's behaviour without standing up a server.

## Utils

`effect/rpc` — unstable

Plumbing for transport authors. `withRun` and `withRunClient` build protocol services that expose a stable `send`/`write` handle before the receive loop starts, buffering early messages (with their `Context`) and replaying them once `run` installs the real receiver. The built-in HTTP/socket/worker protocols are built with these.

**Reach for it when** writing a custom `RpcClient.Protocol`/`RpcServer.Protocol` and needing correct buffering during connection setup — otherwise never call it directly.

> **Tip:** Define a `RpcGroup` of `Rpc.make` procedures → implement with `group.toLayer(handlers)` → serve with `RpcServer.layerHttp` + a `RpcSerialization` layer → on the caller, derive `RpcClient.make(group)` over `layerProtocolHttp` + the same serialization → call `client.ProposeRaise(payload)` and get a typed Effect. Swap serialization for SchemaBinary, or protocol for websocket/worker, and the contract — and your code — doesn't change. Test the whole thing with `RpcTest.makeClient`.
