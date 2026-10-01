# HTTP Server

**Mental shift:** a router is a Layer, a handler is an Effect, and middleware is a function from one app-effect to another. Build routes as Layers, merge them, serve with a platform-specific server Layer. Most production apps use the separate [HttpApi topic](http-api); this layer is right for webhooks, health checks, file exports, and anything without a schema contract.

## FindMyWay

`effect/http/FindMyWay` — unstable

The mutable radix-tree engine under `HttpRouter`. `make<A>()` creates a router; `on(methods, path, handler)` and `all(path, handler)` register values; `find(method, url)` returns the handler plus decoded path and search parameters, while `has` only tests a route. Options control trailing/duplicate slash handling, case sensitivity, and maximum parameter length.

```ts
import { FindMyWay } from "effect/http"

const router = FindMyWay.make<string>({ ignoreTrailingSlash: true })
router.on("GET", "/employees/:id", "getEmployee")

const match = router.find("GET", "/employees/e-42?include=manager")
// { handler: "getEmployee", params: { id: "e-42" },
//   searchParams: { include: "manager" } }
```

Use it when implementing a router adapter or a specialized dispatch table. Application routes should normally use `HttpRouter` or `HttpApi` so handlers, services, and schemas remain integrated.

## HttpEffect

`effect/http/HttpEffect` — unstable

The adapter boundary between an Effect HTTP application and a host. `toWebHandler(app)` produces a Web `(Request) => Promise<Response>` handler; `toWebHandlerLayer(layer)` builds the dependency Layer **immediately** when the handler is created and returns `{ handler, dispose }`. A request that arrives mid-build waits for it; if the build fails, every request rejects with the build error instead of surfacing an unhandled rejection. Eager construction moves cold-start cost to module load and makes a misconfigured deployment fail its first health check rather than its first user. `fromWebHandler` adapts an existing Web handler back into the current Effect request. The lower-level `toHandled` owns request scopes, applies middleware and pre-response hooks, and converts failures into responses — on a handler failure, the request `Scope` still closes with the original cause, so a scope finalizer or middleware can tell a failed request from a successful one even after it's been turned into a response.

```ts
import { Effect } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"

const app = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  return HttpServerResponse.text(`${request.method} ${request.url}`)
})

export const handler = HttpEffect.toWebHandler(app)
```

For a layer-backed handler, retain the returned `dispose` function and await it during test/process teardown. Advanced streaming adapters use `scopeTransferToStream` so a request scope remains alive until the response body finishes; misuse can leak resources, so high-level server code should let the supplied host adapter manage it.

## HttpIncomingMessage

`effect/http/HttpIncomingMessage` — unstable

The shared body/headers model implemented by server requests and client responses: `headers`, optional `remoteAddress`, and effectful `json`, `text`, `urlParamsBody`, `arrayBuffer`, and byte `stream` accessors. `schemaBodyJson`, `schemaBodyUrlParams`, and `schemaHeaders` decode either side through `Schema`; the underlying body error is unioned with `SchemaError`.

`HttpIncomingMessage.MaxBodySize` is the fiber-scoped limit for collected bodies. `inspect` renders an incoming message without exposing sensitive headers. Prefer the more specific `HttpServerRequest` and `HttpClientResponse` helpers in ordinary handlers; use this interface for code that intentionally accepts either.

## HttpPlatform

`effect/http/HttpPlatform` — unstable

The host service behind local-file/Web-File responses and compression. Node, Bun, Deno, and Web layers implement `platform`, `fileResponse`, `fileWebResponse`, and a compressor supporting `gzip`, `deflate`, `br`, and optionally `zstd`. Most application code calls `HttpServerResponse.file` or `HttpMiddleware.compression` rather than this service directly.

A file response's `Content-Type` is, in order: the `contentType` option or an explicit `content-type` header, then a non-empty `File.type` (Web files), then a type inferred from the file extension — a `.csv` file with no explicit content type answers `text/csv` on the core and Node layers. `HttpServerResponse.file` has no `contentLength` option; the length always comes from the file and the requested range.

```ts
import { HttpMiddleware } from "effect/http"

const compressLargeResponses = HttpMiddleware.compression({
  algorithms: ["br", "gzip"],
  minSize: 2_048
})
```

Compression negotiates `Accept-Encoding`, adds `Vary`, and skips statuses/bodies that must not be transformed, already encoded responses, `Cache-Control: no-transform`, and small or non-compressible payloads. It preserves the response `Content-Type` for file, raw, stream, and byte-array bodies — including a header you set after constructing the body. Do not enable both Effect and Deno automatic compression. Opt secret-plus-attacker-controlled responses out because compressed length can leak information (BREACH-style attacks).

## HttpStaticServer

`effect/http/HttpStaticServer` — unstable

A safe static-file application built over `FileSystem`, `Path`, and `HttpPlatform`. `make({ root, index?, spa?, cacheControl?, mimeTypes? })` returns an HTTP app; `layer({ ..., prefix? })` mounts GET routes in `HttpRouter`. It confines paths below the configured root, resolves directory indexes, derives MIME types, supports byte ranges and 206/416 responses, and handles ETag/last-modified conditionals with 304 responses.

```ts
import { HttpStaticServer } from "effect/http"

const Assets = HttpStaticServer.layer({
  root: "./public",
  prefix: "/assets",
  cacheControl: "public, max-age=3600"
})
```

A `Range` header is honored only on `GET` and only for a single `bytes=` range (open-ended `bytes=500-` and suffix `bytes=-500` forms included). A malformed or multi-range header falls back to the full `200` response; a start at or beyond the file size gets `416` with `Content-Range: bytes */<size>`; and offsets are parsed as exact integers, so ranges stay correct past `Number.MAX_SAFE_INTEGER`.

Set `spa: true` for eligible navigation requests to fall back to the index; it does not indiscriminately rewrite every missing asset. Provide the host aggregate/HTTP platform layers at the application edge.

## HttpTraceContext

`effect/http/HttpTraceContext` — unstable

HTTP trace propagation interop. `toHeaders(span)` emits W3C `traceparent` and compact B3. `fromHeaders(headers)` safely tries W3C, compact B3, then multi-header B3 and returns `Option<Tracer.ExternalSpan>`; `w3c`, `b3`, and `xb3` are individual decoders.

Effect's normal HTTP client/server tracing already uses these helpers. Reach for them only when injecting context into, or extracting it from, a non-Effect HTTP library.

## MultipartParser

`effect/http/MultipartParser` — unstable

The callback-driven incremental `multipart/form-data` parser used by platform adapters. `make(config)` returns `{ write(chunk), end() }`; callbacks receive field values, file chunks (ending with `null`), completion, or structured errors. Limits cover parts, total bytes, per-part bytes, and field bytes. Helpers include `defaultIsFile` and charset-aware `decodeField`.

Errors distinguish invalid boundaries/dispositions, malformed headers, a reached limit, and an unexpected end. Exceeding the part-count, part-size, or field-size limit stops parsing and terminates every active file callback with failure; an unexpected end-of-body also terminates active files instead of leaving consumers hung. High-level applications should use `Multipart` and `HttpServerRequest`; `MultipartParser`, plus its public `HeadersParser` and `Search` submodules, is for host adapters and custom streaming sinks.

## HttpRouter

`effect/http/HttpRouter` — unstable

Request router expressed as Layers. `HttpRouter.add(method, path, handler)` produces a Layer for one route; `HttpRouter.addAll([...])` contributes many. Merge them like any other Layers and pass to `HttpRouter.serve` (real server) or `HttpRouter.toWebHandler` (Fetch-style handler for serverless). Path params, prefixes, CORS, and middleware all compose at this level.

**Mental model.** Each route is a Layer that registers itself on an `HttpRouter`. Route dependencies flow through Layer composition — no global app object; the router *is* the wiring.

The method is `"*"` or one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, and `QUERY` — the safe, idempotent HTTP method that carries its query in the request body (read it with `request.json` or a schema body decoder, as for `POST`). `HttpRouter.route` accepts any `HttpMethod`.

`HttpRouter.addAll(routes, { prefix: "/internal" })` mounts a batch under a prefix. Inside a prefixed route `request.url` has the prefix removed (`request.originalUrl` keeps it), and `router.prefixed("/v1").prefixed("/comp")` nests outer-first, serving `/v1/comp/...`.

For typed route middleware, `HttpRouter.middleware` tracks services it provides, errors it handles, errors it may add, and requirements that remain. Its `.layer` supplies both provided request services and handlers for the declared `handles` errors. Global middleware errors remain visible in the error channel returned by `HttpRouter.toHttpEffect`; they are not silently erased.

> **Warning:** **Every entrypoint builds its own router in a fresh, forked layer memo map.** `HttpRouter.serve(appLayer)` merges `appLayer` with a *new* `HttpRouter` rather than reusing one the app provides itself — a route registered via `Layer.provide(HttpRouter.layer)` *inside* `appLayer` builds against that private router and is never mounted on the router `serve` actually serves. Pass routes as Layers merged directly into the argument of `serve` (as in the example below), not nested behind their own `HttpRouter.layer` provision. The same rule governs every entrypoint — `serve`, `toWebHandler`, `toHttpEffect` — so **layers first built inside one entrypoint are private to it**: a stateful service built there is not shared with a sibling entrypoint or the surrounding application, and building the same service inside two entrypoints can construct it twice depending on build order. Provide services that must be shared outside an entrypoint higher up, outside `serve`'s argument, so every entrypoint's forked memo map reuses the already-built instance instead of rebuilding it. This also governs composing RPC over HTTP: put the RPC protocol and its handler layer in the app passed to `serve`, for example `HttpRouter.serve(RpcLayer.pipe(Layer.provideMerge(RpcServer.layerProtocolHttp({ path: "/rpc" }))))`, not behind a separately-provided router.

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"

// A handler is just an Effect that yields an HttpServerResponse.
const HealthRoute = HttpRouter.add(
  "GET",
  "/health",
  Effect.succeed(HttpServerResponse.text("comp-service ok"))
)

// Handlers can be functions of the request, and can require services.
const PayrollWebhookRoute = HttpRouter.add(
  "POST",
  "/webhooks/payroll",
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* request.text
    return HttpServerResponse.text(body)
  })
)

// Path params come from HttpRouter.params.
const EmployeeRoute = HttpRouter.add(
  "GET",
  "/employees/:id",
  Effect.gen(function*() {
    const { id } = yield* HttpRouter.params
    return yield* HttpServerResponse.json({ id })
  })
)

// Merge routes, add CORS, and serve. serve() returns a Layer you launch.
const AllRoutes = Layer.mergeAll(
  HealthRoute,
  PayrollWebhookRoute,
  EmployeeRoute,
  HttpRouter.cors()
)

const ServerLayer = HttpRouter.serve(AllRoutes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
```

> **Note:** **Serverless, same routes.** Swap to `HttpRouter.toWebHandler(AllRoutes.pipe(Layer.provide(HttpServer.layerServices)))` for `{ handler, dispose }` — a `(Request) => Promise<Response>` for Cloudflare Workers, Vercel, Deno, or tests. Route definitions unchanged.

**Reach for it when** you want hand-rolled routes — webhooks, health endpoints, file exports — without a full schema-described API.

## HttpServer

`effect/http/HttpServer` — unstable

Abstract server service plus the functions that run an HTTP app. `HttpServer.serve(handler)` binds an app-effect to the bound socket; `HttpServer.logAddress`/`withLogAddress` log the listen address; `HttpServer.layerServices` supplies platform-neutral services to a handler. Provide a concrete server Layer — `NodeHttpServer.layer(createServer, { port })` or the Bun equivalent.

The service's `address` field is a [`NetAddress.SocketAddress`](platform-runtime-hosts#netaddress) — an `InetAddress` (IP plus port) or a `UnixPathAddress`, replacing the old `TcpAddress | UnixAddress` pair. Narrow it with `NetAddress.isInetAddress` before reading `port`, or render it with `HttpServer.formatAddress(address)`. `NodeHttpServer.layerTest` binds port `0` and supplies an `HttpClient` already prefixed with the assigned address. On Bun and Deno, a listen address that cannot be converted fails the Layer with `ServeError`.

### Request work stays in the request fiber

Every request runs in a fiber the server owns, inside a request `Scope`. When the client goes away before the response has finished, the host adapter interrupts that fiber (Node marks the interrupt as a client abort; for a request that had not started responding, the logger records `499`), so finalizers run and downstream calls are cancelled. That guarantee holds only while the work is *in* the fiber:

| Escape | What is lost |
| --- | --- |
| `Effect.runPromise(...)` or a second runtime inside a handler | the inner run has no parent; a disconnect cannot reach it |
| `Effect.forkDetach`, or a fork into a longer-lived scope | the work outlives the request on purpose — fine for a durable hand-off, a leak otherwise |
| `await`-ing a promise that ignores the `AbortSignal` passed by `Effect.tryPromise` | the fiber is interrupted but the I/O keeps running |

A streaming response keeps the request `Scope` open until the body ends, which is also what makes disconnect cancellation *provable*: a completed response, or an Effect you interrupt by hand, says nothing about sockets. The proof needs the response to be open when the client leaves.

```ts
import { NodeHttpServer } from "@effect/platform-node"
import { Deferred, Effect, Exit, Layer, Schedule, Stream } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http"
import { NetAddress } from "effect/net"
import * as Http from "node:http"

export const disconnectInterruptsTheHandler = Effect.gen(function*() {
  const acquired = yield* Deferred.make<void>()
  const released = yield* Deferred.make<"completed" | "interrupted" | "failed">()

  const PayrollExport = HttpRouter.add(
    "GET",
    "/payroll/export",
    Effect.gen(function*() {
      // Request-scoped finalizer: records HOW the request ended.
      yield* Effect.addFinalizer((exit) =>
        Deferred.succeed(
          released,
          Exit.isSuccess(exit) ? "completed" : Exit.hasInterrupts(exit) ? "interrupted" : "failed"
        )
      )
      yield* Deferred.succeed(acquired, undefined)
      const rows = Stream.fromSchedule(Schedule.spaced("20 millis")).pipe(
        Stream.map((n) => new TextEncoder().encode(`row ${n}\n`))
      )
      return HttpServerResponse.stream(rows) // never ends on its own
    })
  )

  const ServerLive = HttpRouter.serve(PayrollExport, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(Http.createServer, { port: 0, host: "127.0.0.1" }))
  )

  return yield* Effect.gen(function*() {
    const { address } = yield* HttpServer.HttpServer
    if (!NetAddress.isInetAddress(address)) return yield* Effect.die("expected a TCP listener")

    // A raw client: read the first chunk, then drop the connection.
    const request = Http.get({ host: "127.0.0.1", port: address.port, path: "/payroll/export" }, (response) => {
      response.once("data", () => request.destroy())
    })
    request.on("error", () => {})

    yield* Deferred.await(acquired)
    return yield* Deferred.await(released) // "interrupted"
  }).pipe(Effect.provide(ServerLive))
})
```

Run the normal-completion case as a separate test (a finite stream, a client that reads to the end) and assert the inverse: `"completed"`, one acquisition, one release. For the same guarantee across a non-Effect host, see the [request-cancellation recipe](../recipes/request-cancellation-through-a-host).

### Own the listener: acquire late, bind port 0, prove release

- **Allocate during Layer acquisition, never at module evaluation.** A module-level `createServer()`, `Ref`, or counter is shared by every build of the Layer, so two tests (or two tenants) silently share state. Pass the *constructor* (`NodeHttpServer.layer(createServer, options)`), and create mutable state inside `Layer.effect`.
- **Let the OS pick the port in tests** (listen on `0`, then take the real port from `HttpServer.address`), because a hard-coded port breaks as soon as test files run in parallel.
- **Prove release at the OS level.** Build the server Layer into a `Scope` you hold, show that binding a plain `node:net` server to the same host and port fails with `EADDRINUSE`, close the `Scope`, and show that the same bind now succeeds. A finalizer flag, or a bind to a *different* ephemeral port, is not evidence that the listener is gone.
- **A constructor that returns a live server and requires `Scope` must not close that `Scope` itself** — the caller owns the lifetime.
- **Shutdown is graceful by default on Node.** Closing the serve scope stops accepting connections and gives in-flight requests up to `gracefulShutdownTimeout` (20 seconds unless set) to finish; a request still running after that is interrupted and answered with `503` (probed). `disablePreemptiveShutdown: true` removes that grace period. Size your orchestrator's termination grace period above the timeout, and see [owning lifetimes, startup, readiness, and shutdown](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown) and the [graceful entrypoint recipe](../recipes/graceful-entrypoint-and-shutdown).

**Reach for it when** wiring the actual listener, choosing a port, or swapping Node vs Bun by replacing one Layer.

## HttpServerRequest

`effect/http/HttpServerRequest` — unstable

Incoming request available as a service inside any handler (`yield* HttpServerRequest.HttpServerRequest`). Exposes URL, method, headers, cookies, and body — plus `schema*` helpers that decode parts through a Schema, failing into the error channel on bad input.

**Mental model.** `schemaBodyJson`, `schemaHeaders`, `schemaCookies`, `schemaSearchParams`, `schemaBodyForm`, and `schemaBodyUrlParams` each take a Schema and return typed data — the same philosophy as client response decoders, pointed inward.

```ts
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

const RaiseRequest = Schema.Struct({
  employeeId: Schema.Int.check(Schema.isGreaterThan(0)),
  newBaseSalary: Schema.Finite
})

const RaiseRoute = HttpRouter.add(
  "POST",
  "/raises",
  Effect.gen(function*() {
    // Decode + validate the JSON body. Bad input -> typed SchemaError.
    // schemaBodyJson reads the request from context; it is not curried over it.
    const raise = yield* HttpServerRequest.schemaBodyJson(RaiseRequest)
    return yield* HttpServerResponse.json({ recorded: raise.employeeId }, { status: 201 })
  })
)
```

**Reach for it when** a handler needs the body, headers, query string, or cookies validated rather than stringly-typed.

## HttpServerResponse

`effect/http/HttpServerResponse` — unstable

Response builder. Constructors: `text`, `json`, `html`/`htmlStream`, `uint8Array`, `stream`, `file`/`fileWeb`, `redirect`, `empty`, `raw`. Pipeable modifiers: `setStatus`, `setHeader(s)`, cookie family. `schemaJson(schema)` encodes a domain value through a Schema into a JSON response — the symmetric partner of the request decoders.

**Mental model.** An immutable value assembled with pipes, just like a client request.

`HttpServerResponse.toWeb` — and the Bun and Deno adapters — send no body for statuses `204`, `205`, and `304`, or when asked for a bodyless (`HEAD`) response, even if one was constructed; a raw `ReadableStream` body is cancelled instead of leaking. `HttpServerResponse.omitsBody(response)` exposes the same predicate to custom adapters. Dropping the body of a raw Web `Response` keeps that `Response`'s headers and `Set-Cookie` values; a `204`, `205`, or `304` keeps the outer status and status text, while `HEAD` keeps the raw `Response`'s. Cookies set on the outer response are appended to the native `Set-Cookie` headers instead of replacing them.

`setBody` keeps `content-type` and `content-length` aligned with the replacement body and removes stale values when it has no corresponding metadata. Because pipes apply in order, put an explicit `setHeader` after the body constructor when that header must override body-derived metadata.

```ts
import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"

// A JSON response with a custom status, header, and a Set-Cookie.
const response = HttpServerResponse.json({ ok: true }, { status: 201 }).pipe(
  Effect.map((res) =>
    res.pipe(
      HttpServerResponse.setHeader("x-request-id", "abc-123"),
      HttpServerResponse.setCookieUnsafe("session", "tok", { httpOnly: true, path: "/" })
    )
  )
)

// schemaJson encodes a value THROUGH a schema (the encode direction).
import { Schema } from "effect"
const Employee = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String
})
const employeeResponse = HttpServerResponse.schemaJson(Employee)({ id: 1, name: "Ada Lovelace" })
```

**Reach for it when** producing any response, especially with a schema-encoded body or cookie/header control.

## HttpMiddleware

`effect/http/HttpMiddleware` — unstable

Middleware as a plain function: takes the "rest of the app" (an `Effect` producing a response) and returns a new one. Built-ins: `logger` (applied automatically by `HttpRouter.serve` unless disabled), `tracer`, `cors`, `xForwardedHeaders`, `searchParamsParser`. Define custom middleware with `HttpMiddleware.make`. To modify the response, register via `HttpRouter.middleware` (the `serve`-level option runs around the whole chain but can't change the final response).

```ts
import { Clock, Effect } from "effect"
import { HttpMiddleware, HttpServerResponse } from "effect/http"

// A timing middleware that adds a header to every comp-service response.
// `app` is the rest of the chain; we run it and decorate the result.
const withTiming = HttpMiddleware.make((app) =>
  Effect.gen(function*() {
    const start = yield* Clock.currentTimeMillis // never new Date() / Date.now()
    const response = yield* app
    const elapsed = (yield* Clock.currentTimeMillis) - start
    return HttpServerResponse.setHeader(response, "x-response-time", `${elapsed}ms`)
  })
)
```

> **Warning:** The built-in `logger` middleware is on by default via `HttpRouter.serve`. Pass `{ disableLogger: true }` to `serve`, or layer `HttpRouter.disableLogger`, to opt out. It logs the method, the path *without* its query string, and the status; a failed request also logs its `Cause`, so keep secrets `Redacted` rather than relying on the logger to hide them.

> **Warning:** **`HttpRouter.cors()` with no options answers `Access-Control-Allow-Origin: *`.** Pass an allow-list for anything that is not a public, credential-free API. With a predicate or two or more `allowedOrigins`, the request's `Origin` is echoed only when it is allowed, and `Vary: Origin` is always sent — merged with any `Vary` the response or compression already set — so a shared cache cannot serve one origin's answer to another. A single allowed origin is sent as a constant, also with `Vary: Origin`. With `allowedHeaders` left empty, a preflight reflects whatever `Access-Control-Request-Headers` the browser asked for. `allowedMethods` defaults to `GET`, `HEAD`, `PUT`, `PATCH`, `POST`, and `DELETE`; a browser only sends a cross-origin `QUERY` request after you add `"QUERY"` to that list.

```ts
import { HttpRouter } from "effect/http"

export const Cors = HttpRouter.cors({
  allowedOrigins: ["https://hr.acme.example", "https://admin.acme.example"],
  allowedMethods: ["GET", "POST"],
  allowedHeaders: ["authorization", "content-type"],
  credentials: true,
  maxAge: 600
})
```

### Edge policy checklist

Several server limits are **unbounded until you set them**. Decide each one explicitly; "whatever the default is" is not a policy.

| Concern | Default | Set it with |
| --- | --- | --- |
| Collected request body (`text`, `json`, `arrayBuffer`, buffered multipart total) | **no limit** | `HttpIncomingMessage.MaxBodySize` (a `ByteSize`), provided as a Layer or per route; on Node an over-limit request has its connection dropped rather than receiving a `413` (probed) |
| Multipart part count / file size | **no limit** | `Multipart.MaxParts`, `Multipart.MaxFileSize`, or per endpoint with `HttpApiSchema.asMultipart({ maxParts, maxFileSize, maxTotalSize })` |
| Multipart text field size | 10 MiB | `Multipart.MaxFieldSize` |
| Path parameter length, trailing-slash and case rules | router defaults | `HttpRouter.serve(app, { routerConfig })` |
| CORS origins | `*` | `HttpRouter.cors({ allowedOrigins, credentials })` |
| Headers hidden from logs and spans | `authorization`, `cookie`, `set-cookie`, `x-api-key` | `Headers.CurrentRedactedNames` |
| Graceful shutdown window (Node) | 20 seconds | `gracefulShutdownTimeout` on the server Layer |

Beyond what the library models, write down: header-size, connection-count, and keep-alive limits on the host (`node:http` server options, or the proxy in front); connect, header, idle, total, and drain timeouts (`Effect.timeout` per route for the total; the rest belong to the host or proxy); response size and streaming limits for exports; TLS termination; and **proxy trust** — apply `HttpMiddleware.xForwardedHeaders` only when every request really arrives through a proxy you control, because it replaces the request's host and remote address with client-supplied header values.

For cookie-authenticated browsers: set `httpOnly`, `secure`, an explicit `sameSite`, and a narrow `path`; and because CORS does not stop a cross-site form post, protect every state-changing route with a CSRF defense (a same-site cookie policy plus an `Origin` check or a per-session token). WebSocket upgrades are not covered by CORS at all — check `Origin` in the upgrade handler.

For uploads: treat the client's filename and MIME type as untrusted labels (derive the type with [Mime](#mime), generate your own storage name), bound concurrent uploads, and let the request `Scope` own temporary files — `schemaBodyForm` persists files into a scoped temp directory that is removed when the request ends, so copy what you keep before responding. Fixture rules for tests that use real listeners, ports, and temp directories are in [Testing an Effect application](../deep-dives/testing-an-effect-application).

**Reach for it when** you need cross-cutting behavior — auth, timing, request IDs, CORS — without repeating it per handler.

## HttpBody

`effect/http/HttpBody` — unstable

Unified body representation shared by client requests and server responses. The higher-level constructors (e.g. `HttpServerResponse.json`, `HttpClientRequest.bodyText`) usually build these for you, but the module provides explicit control: `HttpBody.text`, `json`/`jsonUnsafe`, `jsonSchema` (encode through a Schema), `uint8Array`, `urlParams`, `formData`/`formDataRecord`, `stream`, `file`. Construction failures surface as `HttpBodyError`, which `HttpBody.isHttpBodyError` guards an unknown error down to.

**Reach for it when** building a body by hand — streaming batches, multipart uploads, or schema-encoded JSON — rather than via a verb helper.

## Headers

`effect/http/Headers` — unstable

Immutable, case-insensitive header map with redaction support. `Headers.fromInput` builds one; pure operations: `get`/`set`/`merge`/`remove`. `redact` (and the `CurrentRedactedNames` reference) strips sensitive headers like `authorization` from logs and traces automatically.

```ts
import { Headers } from "effect/http"

const headers = Headers.set(
  Headers.fromInput({ "content-type": "application/json" }),
  "authorization",
  "Bearer hris-service-token"
)
// Redact sensitive names before logging.
const safeForLogs = Headers.redact(headers, ["authorization"])
```

`Headers.CurrentRedactedNames` defaults to `authorization`, `cookie`, `set-cookie`, and `x-api-key`. String patterns match header names case-insensitively and regular expressions (including global or sticky ones) are tested against the name, and the same list governs the `http.request.header.*` / `http.response.header.*` attributes on **server** spans as well as client spans. Add your own secrets-bearing names (`x-hris-signature`, a session header) once, at the server edge:

```ts
import { Layer } from "effect"
import { Headers } from "effect/http"

export const RedactedHeaders = Layer.succeed(Headers.CurrentRedactedNames)([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-hris-signature",
  /^x-internal-/
])
```

`Content-Length` values are parsed strictly across the HTTP modules: a malformed or unsafe value is ignored rather than coerced into a number.

**Reach for it when** you manipulate headers directly, or need redaction to keep credentials out of logs.

## Cookies

`effect/http/Cookies` — unstable

Immutable cookie jar plus a `Cookie` type with all attributes (`httpOnly`, `secure`, `sameSite`, `maxAge`, `path`, `domain`). Parse a request's `Cookie` header with `parseHeader`; `fromSetCookie` parses one or more response `Set-Cookie` header values into a jar. Build with `set`/`setUnsafe` and expire with `expireCookie`. The safe constructors validate the cookie name, value, domain, and path and return `CookiesError`; reserve `*Unsafe` forms for already-trusted values. The error's tag is `"CookiesError"`, so recover with `Effect.catchTag("CookiesError", ...)` and branch on `error.reason._tag` (`InvalidCookieName`, `InvalidCookieValue`, `InvalidCookieDomain`, `InvalidCookiePath`, …); `Cookies.isCookiesError` guards an unknown error down to this type. `fromSetCookie` skips any `Set-Cookie` header whose name is not a valid RFC 6265 token instead of storing it. On the server use `HttpServerResponse.setCookie`; on the client, a `Ref<Cookies>` wired via `HttpClient.withCookiesRef` gives a persistent session.

**Reach for it when** setting auth/session cookies on responses or maintaining a cookie jar across client calls.

## HttpMethod

`effect/http/HttpMethod` — unstable

Type-level vocabulary for HTTP verbs: the `HttpMethod` union, the `all` set, `isHttpMethod` guard, and `hasBody` (true for methods this module treats as body-capable: POST, PUT, DELETE, PATCH, and QUERY; false for GET, HEAD, OPTIONS, and TRACE). `QUERY` is also in `all`, and `HttpClient`, `HttpRouter`, and `HttpApiEndpoint` each have a `query` constructor or accept the method.

**Reach for it when** branching on request method or validating a method string.

## Url

`effect/http/Url` — unstable

Safe, immutable helpers over the native `URL`. `Url.fromString` parses (returns a `Result` — bad URL is a value, not a throw); `Url.make(url, params, hash)` constructs a URL while appending `UrlParams` and returns a typed `UrlError`; `mutate` applies a mutation to a copy; pipeable setters (`setHostname`, `setPathname`, `setProtocol`, `setUrlParams`, …) edit without mutation. URL construction lives here — the old `UrlParams.makeUrl` entry point is gone.

```ts
import { Url } from "effect/http"

const url = new URL("https://hris.acme.internal/employees")
// mutate copies first, so the original is untouched.
const updated = Url.mutate(url, (u) => {
  u.pathname = "/v2/employees"
  u.searchParams.set("page", "1")
})
```

**Reach for it when** parsing or transforming URLs with immutability and parse errors as values.

## UrlParams

`effect/http/UrlParams` — unstable

Immutable, order-preserving query-string model with correct repeated-key handling. Build with `make`/`fromInput`, read with `getAll`/`getFirst`/`getLast`, edit with `set`/`append`/`remove`. Accepts coercible inputs — numbers, booleans, bigints. The schemas for these HTTP data types live in `effect/Schema`: `Schema.UrlParams`, `Schema.RecordFromUrlParams`, and `Schema.JsonFromUrlParamsField(field, { reviver? })`, which round-trips a JSON-encoded query param through a Schema (the former `UrlParams.schemaJsonField`, `schemaRecord`, and `UrlParamsSchema`). `Schema.Headers`, `Schema.Cookie`, `Schema.Cookies`, and `Schema.RecordFromCookies` moved the same way.

```ts
import { UrlParams } from "effect/http"

// Filter the employee roster by several departments at once.
const params = UrlParams.fromInput({ dept: ["ENG", "SALES"], page: 2 }).pipe(
  UrlParams.append("dept", "OPS")
)
UrlParams.getAll(params, "dept") // ["ENG", "SALES", "OPS"]
UrlParams.toString(params) // "dept=ENG&dept=SALES&page=2&dept=OPS"
```

**Reach for it when** building or parsing query strings, especially with repeated keys or typed values.

## Multipart

`effect/http/Multipart` — unstable

Streaming `multipart/form-data` parsing. Distinguishes `Field` (text) from `File` parts; can persist uploads to disk (`PersistedFile`). Exposes Schemas (`FilesSchema`, `SingleFileSchema`, `PersistedFileSchema`) for typed decoding. Safety limits — `MaxParts`, `MaxFileSize`, `MaxFieldSize`, `FieldMimeTypes` — are `Context.Reference`s tunable per route; only `MaxFieldSize` has a finite default (see the [edge policy checklist](#edge-policy-checklist)). Failures: `MultipartError`, which `Multipart.isMultipartError` guards an unknown error down to. `Multipart.isPart` accepts every branded part including `PersistedFile`; `Multipart.isStreamPart` is true only for a text `Field` or a streamed `File`, which is the guard a streaming consumer wants. A request body that fails while a file part is streaming fails that file's stream instead of leaving its consumer waiting, and persisting a file passes a `MultipartError` from the body through unchanged instead of re-wrapping it as an `InternalError` reason. Parts are emitted to the consumer as soon as they're parsed rather than held back until more input arrives, so a slow part behind a fast one doesn't stall the ones already decoded.

**Mental model.** An upload is a stream of parts, not a blob. Typically used via `HttpServerRequest.schemaBodyForm(schema)` or `schemaBodyMultipart(schema)` — Multipart + Schema handle parsing and validation together.

```ts
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse, Multipart } from "effect/http"

// Decode a merit-cycle upload: a label field plus a CSV of recommendations.
const MeritUploadForm = Schema.Struct({
  cycle: Schema.String,
  file: Multipart.SingleFileSchema // a persisted file on disk
})

const UploadRoute = HttpRouter.add(
  "POST",
  "/merit-cycles/upload",
  Effect.gen(function*() {
    // schemaBodyForm reads the request from context; it is not curried over it.
    const form = yield* HttpServerRequest.schemaBodyForm(MeritUploadForm)
    return yield* HttpServerResponse.json({ cycle: form.cycle, path: form.file.path })
  })
)
```

**Reach for it when** accepting file uploads or mixed form posts — stream, size-limit, and decode into typed values.

## HttpServerError

`effect/http/HttpServerError` — unstable

Server tagged error family: `RequestParseError` (schema decode failed), `RouteNotFound`, `InternalError`, `ResponseError`, `ServeError` (listener couldn't bind). The framework maps these to sensible status codes (parse error → 400, missing route → 404); `causeResponse` turns a failure cause into a response.

**Reach for it when** you want to override how parse or not-found failures are rendered, or react to a bind failure on startup.

## HttpServerRespondable

`effect/http/HttpServerRespondable` — unstable

Interface that lets any value describe how it becomes a response. Implement the `HttpServerRespondable` symbol on a class (e.g. a tagged error) and the router converts it to an `HttpServerResponse` automatically — a handler can fail with a domain error and have it rendered without a manual mapping step. `toResponse`/`toResponseOrElse` perform the conversion.

**Reach for it when** you want domain errors or DTOs to render themselves as responses instead of per-error response code.

## Etag

`effect/http/Etag` — unstable

ETag generation for caching and conditional requests. `Etag.Generator` service produces strong or weak tags from file info; provide `Etag.layer` (strong) or `Etag.layerWeak` (weak) and the static-file machinery uses it to support `If-None-Match` and 304 responses.

**Reach for it when** serving files or cacheable resources and wanting conditional-request support without hand-rolling hashes.

## Template

`effect/http/Template` — unstable

Effectful tagged-template literal for building HTML (or any string) where interpolations can themselves be Effects, `Option`s, or Streams. `Template.make` resolves embedded effects (concurrently) and produces `Effect<string>`; `Template.stream` produces `Stream<string>` for progressive rendering. Pair with `HttpServerResponse.html`/`htmlStream` for streaming server-side rendering.

```ts
import { Effect } from "effect"
import { HttpServerResponse, Template } from "effect/http"

// Render a comp summary page, resolving the employee name async inside the markup.
const renderCompPage = (employeeName: Effect.Effect<string>) =>
  Effect.gen(function*() {
    const html = yield* Template.make`<h1>Comp plan for ${employeeName}</h1>`
    return HttpServerResponse.html(html)
  })
```

**Reach for it when** rendering HTML server-side with async data and streaming composing naturally inside the markup.

## HttpStatus

`effect/http/HttpStatus` — unstable

The single source of truth that maps readable status **names** to numeric codes. `HttpStatus.fromLiteral("Conflict")` returns the literal type `409`, and `HttpStatus.Literal` is the union of known names (`"OK"`, `"Created"`, `"NoContent"`, `"UnprocessableEntity"`, …). `HttpApiSchema.status` consumes it, so an endpoint annotation can say `HttpApiSchema.status("Conflict")` instead of a bare `409`.

```ts
import { HttpStatus } from "effect/http"

const conflict = HttpStatus.fromLiteral("Conflict")               // 409
const unprocessable = HttpStatus.fromLiteral("UnprocessableEntity") // 422

// Accept a status by name in your own helpers without a second lookup table.
const describe = (status: HttpStatus.Literal) => `${status} → ${HttpStatus.fromLiteral(status)}`
```

**Reach for it when** a status code is part of a contract or a log line and a name reads better than a number.

## Mime

`effect/http/Mime` — unstable

MIME lookup backed by a vendored standard registry (the `mime` runtime dependency was removed). Three pure functions, each returning an `Option`: `Mime.getType(pathOrExtension)`, `Mime.getExtension(type)`, and `Mime.getAllExtensions(type)`. Lookups are case-insensitive on the extension, and type parameters and whitespace are normalized, so `"application/json; charset=utf-8"` resolves to `json`. The lookup tables are built lazily on first call rather than at module evaluation, so importing this module without calling a lookup lets bundlers drop the tables and the MIME data they index.

```ts
import { Option } from "effect"
import { Mime } from "effect/http"

Mime.getType("reports/q4.CSV")                          // Option.some("text/csv")
Mime.getType("LICENSE")                                 // Option.none() — no extension to go on
Mime.getExtension("application/json; charset=utf-8")    // Option.some("json")
Mime.getAllExtensions("image/jpeg")                     // Option.some(Set { "jpg", "jpeg", "jpe" })

// Never trust a client-supplied content type for a download: derive it from the stored name.
const contentTypeFor = (fileName: string) =>
  Option.getOrElse(Mime.getType(fileName), () => "application/octet-stream")
```

**Reach for it when** choosing a `Content-Type` for a file response or validating an upload's extension against its declared type.
