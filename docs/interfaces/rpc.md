# RPC

Effect 4's RPC is schema-first and transport-agnostic. One contract — a group of procedures, each with payload/success/error Schema — derives a server, a typed client, and a test harness. Wire format and transport are pluggable layers. The contract never changes.

> **Note:** Twelve modules; three core nouns and adapters. **Rpc** + **RpcGroup** define the contract. **RpcServer** runs handlers; **RpcClient** derives the caller. **RpcSerialization** picks the wire encoding; the `layerProtocol*` functions pick the pipe. **RpcMiddleware**, **RpcSchema**, **RpcMessage**, **RpcClientError**, **RpcWorker**, **RpcTest**, and **Utils** are supporting modules.

## Rpc

`effect/unstable/rpc` — unstable

One procedure. `Rpc.make(tag, options)` records a tag plus four Schemas: `payload` (request), `success` (happy result), `error` (typed recoverable failures), and optional `defect` for unexpected deaths.

**Mental model.** An `Rpc` is a typed envelope spec both ends agree on. The client reads it to know what to send and what comes back; the server reads it to know what to decode and must return. The declaration is pure data — no shared implementation, only this definition.

`payload` accepts a Schema or bare struct fields (auto-wrapped in `Schema.Struct`). Pass `stream: true` to make success a stream of values. Subclass to get a nominal type for `yield*` and annotation.

```ts
import { Schema } from "effect"
import { Rpc } from "effect/unstable/rpc"

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

**Reach for it when** describing exactly one remote call with inputs, outputs, and failures captured as Schema.

## RpcGroup

`effect/unstable/rpc` — unstable

A collection of `Rpc` definitions keyed by tag, forming the service contract. `RpcGroup.make(...rpcs)` builds it; `.add`, `.merge`, `.omit`, `.prefix`, `.middleware`, and `.annotateRpcs` shape it. Hand this single value to both server and client.

**Mental model.** The group is the interface; `group.toLayer(handlers)` is the implementation. The handlers object is exhaustively type-checked: every tag needs a handler receiving the decoded payload and returning an Effect (or Stream) whose success/error matches that procedure's Schemas. Missing tag or wrong return type fails to compile.

```ts
import { BigDecimal, Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

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

**Reach for it when** you want a single typed surface the server implements and the client mirrors.

## RpcServer

`effect/unstable/rpc` — unstable

The runtime that takes a group, its handler layer, a serialization layer, and a transport, and serves requests. Decodes incoming payloads with the procedure's Schema, runs the matching handler (and any middleware), tracks in-flight requests, honours acks and interrupts, encodes the result back to the client.

**Mental model.** `RpcServer.layer(group)` is the engine; it needs a `Protocol` (transport boundary) plus handlers in context. For the common case, `RpcServer.layerHttp({ group, path, protocol })` bundles the engine and transport and registers a route on an `HttpRouter`. Pick wire format separately with a serialization layer — swapping JSON for msgpack is one line.

```ts
import { Layer } from "effect"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { HttpRouter } from "effect/unstable/http"
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

Additional protocol layers: `layerProtocolWebsocket`, `layerProtocolSocketServer` (raw TCP), `layerProtocolStdio` (CLIs and MCP-style servers), `layerProtocolWorkerRunner` (server half of a Worker). Compose `RpcServer.layer(group)` with any of them to use the engine without the HTTP router.

**Reach for it when** you are the callee and need to expose handlers over a real transport.

## RpcClient

`effect/unstable/rpc` — unstable

The mirror of the server, derived from the same group. `RpcClient.make(group)` returns an object with one method per procedure; calling `client.GetComp({ employeeId })` returns an `Effect` with exactly the success and error types the group declared. No codegen, no duplicated types.

**Mental model.** The client encodes the payload, ships it through the current `Protocol`, decodes the response, and reconstructs typed errors so `Effect.catchTag("EmployeeNotFound", ...)` works on the calling side. Failures below the contract (connection dropped, malformed frame) surface as `RpcClientError`.

```ts
import { BigDecimal, Effect, Layer } from "effect"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { FetchHttpClient } from "effect/unstable/http"

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

> **Tip:** Attach per-call headers with `RpcClient.withHeaders(effect, { authorization: token })` — they merge with `CurrentHeaders` and ride on outgoing requests, readable by the handler via `headers`. Pass `{ flatten: true }` to `RpcClient.make` to get a single `client(tag, payload)` function instead of a method-per-procedure object — useful for generic wrappers. Matching client transports: `layerProtocolHttp`, `layerProtocolSocket`, `layerProtocolWorker`.

**Reach for it when** you are the caller and want a typed client derived from the group.

## RpcClientError

`effect/unstable/rpc` — unstable

The error a derived client raises when a call fails before the remote handler returns a declared error. Its `reason` is a union of transport failures — HTTP client errors, socket errors, worker errors — plus `RpcClientDefect` for protocol violations and decode failures (e.g. empty or malformed response).

**Mental model.** Two error channels: contract typed errors (e.g. `EmployeeNotFound`) are application failures, catchable by tag. `RpcClientError` is infrastructure failure — the call never made it through the pipe. Match on `error.reason._tag` to distinguish a dropped socket from a garbled frame.

```ts
import { Effect } from "effect"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"

const robust = client.GetComp({ employeeId: "E-1" }).pipe(
  Effect.catchTag("EmployeeNotFound", () => Effect.succeed(null)), // contract error
  Effect.catch((e) =>
    e instanceof RpcClientError && e.reason._tag === "RpcClientDefect"
      ? Effect.logError(`protocol problem: ${e.reason.message}`)
      : Effect.fail(e)
  )
)
```

**Reach for it when** you need to react to transport-level failures distinctly from contract business errors.

## RpcMiddleware

`effect/unstable/rpc` — unstable

Cross-cutting concerns — auth, logging, rate limiting — modeled as a typed service attached to procedures. `RpcMiddleware.Service<Self, { provides, requires }>()(name, { error })` declares middleware that can fail with a typed `error` and `provides` a service to the handlers behind it.

**Mental model.** Middleware wraps the handler and rewires type-level requirements. If auth middleware `provides: CurrentManager`, any handler under it may `yield* CurrentManager` and the compiler knows that dependency is satisfied. Attach with `.middleware(M)` on an individual `Rpc` or on an `RpcGroup`.

```ts
import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/unstable/rpc"

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

**Reach for it when** a concern spans many procedures and should both gate the call and hand the handler a derived service.

## RpcSchema

`effect/unstable/rpc` — unstable

Schema helpers specific to RPC — chiefly `RpcSchema.Stream(success, error)`, the success type that turns a procedure into a streaming response. A handler for a streaming RPC returns a `Stream` (or `Queue.Dequeue`); the client receives a `Stream` of decoded values.

**Mental model.** Most procedures are request/response. `RpcSchema.Stream` is the escape hatch for many responses over time — server push, streaming results. Pass `stream: true` to `Rpc.make` and it wraps the schemas automatically.

```ts
import { Schema } from "effect"
import { Rpc, RpcSchema } from "effect/unstable/rpc"

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

**Reach for it when** a procedure produces a sequence of values rather than a single result.

## RpcSerialization

`effect/unstable/rpc` — unstable

The pluggable wire format. `RpcSerialization` is a service describing how messages are framed and parsed; provide one of its layers and both client and server use it. Swapping formats is a single layer change with zero impact on contract or handlers.

**Mental model.** The contract decides what travels; serialization decides how it's encoded. Framed formats (ndjson, msgpack) can stream multiple messages over a long-lived connection; unframed JSON suits one-shot HTTP request/response.

- **layerJson** — Plain JSON. Unframed — best for one-request-per-HTTP-call.

- **layerNdjson** — Newline-delimited JSON. Framed; ideal for streaming and sockets.

- **layerMsgPack** — Binary MessagePack. Framed and compact; great for workers and high-throughput links.

- **layerJsonRpc / layerNdJsonRpc** — JSON-RPC 2.0 framing for interop with non-Effect peers (e.g. LSP/MCP tooling).

```ts
import { RpcSerialization } from "effect/unstable/rpc"

// JSON for a simple HTTP comp endpoint:
const wireJson = RpcSerialization.layerJson
// Binary for a worker or a chatty socket (e.g. streaming a payroll batch):
const wireBinary = RpcSerialization.layerMsgPack
// JSON-RPC 2.0 for cross-language interop:
const wireJsonRpc = RpcSerialization.layerJsonRpc()
```

**Reach for it when** you need to choose or change the on-the-wire encoding — for size, streaming framing, or interop.

## RpcMessage

`effect/unstable/rpc` — unstable

The protocol envelope types — messages that flow between client and server once payloads are wrapped for transport. Client-to-server: `Request`, `Ack`, `Interrupt`, `Eof`, `Ping`. Server-to-client: response exits, stream chunks, defects, `Pong`. Also defines branded `RequestId`.

**Mental model.** This is the language transports speak. `RpcClient`/`RpcServer` produce and consume these — but backpressure (`Ack`), cancellation (`Interrupt`), and end-of-stream (`Eof`) live here. Consult when writing a custom transport or debugging framing.

Key APIs: Request, Ack, Interrupt, Eof, Ping, ResponseChunk, ResponseExit, RequestId

**Reach for it when** implementing a bespoke `Protocol` or reasoning about acks, interrupts, and stream framing at the wire level.

## RpcWorker

`effect/unstable/rpc` — unstable

Glue for running an RPC group over a Worker. Pair `RpcClient.layerProtocolWorker` on the main thread with `RpcServer.layerProtocolWorkerRunner` inside the worker to make a typed group drive a typed worker pool — same contract as HTTP, different pipe.

**Mental model.** Instead of HTTP, messages travel via `postMessage` (with transferables for zero-copy buffers). `RpcWorker` adds the `InitialMessage` service — one schema-encoded value the client hands the worker on startup (config, connection string) before normal requests flow.

```ts
import { Effect, Schema } from "effect"
import { RpcWorker } from "effect/unstable/rpc"

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

Combine with `RpcSerialization.layerMsgPack` — binary framing plus transferables is the sweet spot for worker traffic.

**Reach for it when** you want a typed RPC contract to drive a Worker pool, not a network service.

## RpcTest

`effect/unstable/rpc` — unstable

In-memory harness that wires a derived client straight to handlers — no transport, no serializer, no HTTP server. `RpcTest.makeClient(group)` connects client and server through the no-serialization path; requests, responses, stream chunks, acks, interrupts, headers, and middleware all flow through the real machinery without bytes on a wire.

**Mental model.** Fastest way to test a group end-to-end. Provide the same handler layer you'd ship in production; the harness gives a typed client that calls it directly. Failures, streams, and middleware behave exactly as over a socket — faster and deterministic.

```ts
import { BigDecimal, Effect } from "effect"
import { RpcTest } from "effect/unstable/rpc"

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

**Reach for it when** you want fast, deterministic tests of a whole group's behaviour without standing up a server.

## Utils

`effect/unstable/rpc` — unstable

Plumbing for transport authors. `withRun` and `withRunClient` build protocol services that expose a stable `send`/`write` handle before the receive loop starts, buffering early messages (with their `Context`) and replaying them once `run` installs the real receiver. The built-in HTTP/socket/worker protocols are built with these.

**Reach for it when** writing a custom `RpcClient.Protocol`/`RpcServer.Protocol` and needing correct buffering during connection setup — otherwise never call it directly.

> **Tip:** Define a `RpcGroup` of `Rpc.make` procedures → implement with `group.toLayer(handlers)` → serve with `RpcServer.layerHttp` + a `RpcSerialization` layer → on the caller, derive `RpcClient.make(group)` over `layerProtocolHttp` + the same serialization → call `client.ProposeRaise(payload)` and get a typed Effect. Swap serialization for msgpack, or protocol for websocket/worker, and the contract — and your code — doesn't change. Test the whole thing with `RpcTest.makeClient`.
