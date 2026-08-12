# HTTP Server

**Mental shift:** a router is a Layer, a handler is an Effect, and middleware is a function from one app-effect to another. Build routes as Layers, merge them, serve with a platform-specific server Layer. Most production apps use the separate [HttpApi topic](http-api); this layer is right for webhooks, health checks, file exports, and anything without a schema contract.

## FindMyWay

`effect/unstable/http/FindMyWay` — unstable

The mutable radix-tree engine under `HttpRouter`. `make<A>()` creates a router; `on(methods, path, handler)` and `all(path, handler)` register values; `find(method, url)` returns the handler plus decoded path and search parameters, while `has` only tests a route. Options control trailing/duplicate slash handling, case sensitivity, and maximum parameter length.

```ts
import { FindMyWay } from "effect/unstable/http"

const router = FindMyWay.make<string>({ ignoreTrailingSlash: true })
router.on("GET", "/employees/:id", "getEmployee")

const match = router.find("GET", "/employees/e-42?include=manager")
// { handler: "getEmployee", params: { id: "e-42" },
//   searchParams: { include: "manager" } }
```

Use it when implementing a router adapter or a specialized dispatch table. Application routes should normally use `HttpRouter` or `HttpApi` so handlers, services, and schemas remain integrated.

## HttpEffect

`effect/unstable/http/HttpEffect` — unstable

The adapter boundary between an Effect HTTP application and a host. `toWebHandler(app)` produces a Web `(Request) => Promise<Response>` handler; `toWebHandlerLayer(layer)` lazily builds dependencies and returns `{ handler, dispose }`. `fromWebHandler` adapts an existing Web handler back into the current Effect request. The lower-level `toHandled` owns request scopes, applies middleware and pre-response hooks, and converts failures into responses.

```ts
import { Effect } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const app = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  return HttpServerResponse.text(`${request.method} ${request.url}`)
})

export const handler = HttpEffect.toWebHandler(app)
```

For a layer-backed handler, retain the returned `dispose` function and await it during test/process teardown. Advanced streaming adapters use `scopeTransferToStream` so a request scope remains alive until the response body finishes; misuse can leak resources, so high-level server code should let the supplied host adapter manage it.

## HttpIncomingMessage

`effect/unstable/http/HttpIncomingMessage` — unstable

The shared body/headers model implemented by server requests and client responses: `headers`, optional `remoteAddress`, and effectful `json`, `text`, `urlParamsBody`, `arrayBuffer`, and byte `stream` accessors. `schemaBodyJson`, `schemaBodyUrlParams`, and `schemaHeaders` decode either side through `Schema`; the underlying body error is unioned with `SchemaError`.

`HttpIncomingMessage.MaxBodySize` is the fiber-scoped limit for collected bodies. `inspect` renders an incoming message without exposing sensitive headers. Prefer the more specific `HttpServerRequest` and `HttpClientResponse` helpers in ordinary handlers; use this interface for code that intentionally accepts either.

## HttpPlatform

`effect/unstable/http/HttpPlatform` — unstable

The host service behind local-file/Web-File responses and compression. Node, Bun, Deno, and Web layers implement `platform`, `fileResponse`, `fileWebResponse`, and a compressor supporting `gzip`, `deflate`, `br`, and optionally `zstd`. Most application code calls `HttpServerResponse.file` or `HttpMiddleware.compression` rather than this service directly.

```ts
import { HttpMiddleware } from "effect/unstable/http"

const compressLargeResponses = HttpMiddleware.compression({
  algorithms: ["br", "gzip"],
  minSize: 2_048
})
```

Compression negotiates `Accept-Encoding`, adds `Vary`, and skips statuses/bodies that must not be transformed, already encoded responses, `Cache-Control: no-transform`, and small or non-compressible payloads. Do not enable both Effect and Deno automatic compression. Opt secret-plus-attacker-controlled responses out because compressed length can leak information (BREACH-style attacks).

## HttpStaticServer

`effect/unstable/http/HttpStaticServer` — unstable

A safe static-file application built over `FileSystem`, `Path`, and `HttpPlatform`. `make({ root, index?, spa?, cacheControl?, mimeTypes? })` returns an HTTP app; `layer({ ..., prefix? })` mounts GET routes in `HttpRouter`. It confines paths below the configured root, resolves directory indexes, derives MIME types, supports byte ranges and 206/416 responses, and handles ETag/last-modified conditionals with 304 responses.

```ts
import { HttpStaticServer } from "effect/unstable/http"

const Assets = HttpStaticServer.layer({
  root: "./public",
  prefix: "/assets",
  cacheControl: "public, max-age=3600"
})
```

Set `spa: true` for eligible navigation requests to fall back to the index; it does not indiscriminately rewrite every missing asset. Provide the host aggregate/HTTP platform layers at the application edge.

## HttpTraceContext

`effect/unstable/http/HttpTraceContext` — unstable

HTTP trace propagation interop. `toHeaders(span)` emits W3C `traceparent` and compact B3. `fromHeaders(headers)` safely tries W3C, compact B3, then multi-header B3 and returns `Option<Tracer.ExternalSpan>`; `w3c`, `b3`, and `xb3` are individual decoders.

Effect's normal HTTP client/server tracing already uses these helpers. Reach for them only when injecting context into, or extracting it from, a non-Effect HTTP library.

## MultipartParser

`effect/unstable/http/MultipartParser` — unstable

The callback-driven incremental `multipart/form-data` parser used by platform adapters. `make(config)` returns `{ write(chunk), end() }`; callbacks receive field values, file chunks (ending with `null`), completion, or structured errors. Limits cover parts, total bytes, per-part bytes, and field bytes. Helpers include `defaultIsFile` and charset-aware `decodeField`.

Errors distinguish invalid boundaries/dispositions, malformed headers, a reached limit, and an unexpected end. Exceeding the part-count, part-size, or field-size limit stops parsing and terminates every active file callback with failure; an unexpected end-of-body also terminates active files instead of leaving consumers hung. High-level applications should use `Multipart` and `HttpServerRequest`; `MultipartParser`, plus its public `HeadersParser` and `Search` submodules, is for host adapters and custom streaming sinks.

## HttpRouter

`effect/unstable/http/HttpRouter` — unstable

Request router expressed as Layers. `HttpRouter.add(method, path, handler)` produces a Layer for one route; `HttpRouter.addAll([...])` contributes many. Merge them like any other Layers and pass to `HttpRouter.serve` (real server) or `HttpRouter.toWebHandler` (Fetch-style handler for serverless). Path params, prefixes, CORS, and middleware all compose at this level.

**Mental model.** Each route is a Layer that registers itself on an `HttpRouter`. Route dependencies flow through Layer composition — no global app object; the router *is* the wiring.

For typed route middleware, `HttpRouter.middleware` tracks services it provides, errors it handles, errors it may add, and requirements that remain. Its `.layer` supplies both provided request services and handlers for the declared `handles` errors. Global middleware errors remain visible in the error channel returned by `HttpRouter.toHttpEffect`; they are not silently erased.

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
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

`effect/unstable/http/HttpServer` — unstable

Abstract server service plus the functions that run an HTTP app. `HttpServer.serve(handler)` binds an app-effect to the bound socket; `HttpServer.logAddress`/`withLogAddress` log the listen address; `HttpServer.layerServices` supplies platform-neutral services to a handler. Provide a concrete server Layer — `NodeHttpServer.layer(createServer, { port })` or the Bun equivalent.

**Reach for it when** wiring the actual listener, choosing a port, or swapping Node vs Bun by replacing one Layer.

## HttpServerRequest

`effect/unstable/http/HttpServerRequest` — unstable

Incoming request available as a service inside any handler (`yield* HttpServerRequest.HttpServerRequest`). Exposes URL, method, headers, cookies, and body — plus `schema*` helpers that decode parts through a Schema, failing into the error channel on bad input.

**Mental model.** `schemaBodyJson`, `schemaHeaders`, `schemaCookies`, `schemaSearchParams`, `schemaBodyForm`, and `schemaBodyUrlParams` each take a Schema and return typed data — the same philosophy as client response decoders, pointed inward.

```ts
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

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

`effect/unstable/http/HttpServerResponse` — unstable

Response builder. Constructors: `text`, `json`, `html`/`htmlStream`, `uint8Array`, `stream`, `file`/`fileWeb`, `redirect`, `empty`, `raw`. Pipeable modifiers: `setStatus`, `setHeader(s)`, cookie family. `schemaJson(schema)` encodes a domain value through a Schema into a JSON response — the symmetric partner of the request decoders.

**Mental model.** An immutable value assembled with pipes, just like a client request.

`setBody` keeps `content-type` and `content-length` aligned with the replacement body and removes stale values when it has no corresponding metadata. Because pipes apply in order, put an explicit `setHeader` after the body constructor when that header must override body-derived metadata.

```ts
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"

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

`effect/unstable/http/HttpMiddleware` — unstable

Middleware as a plain function: takes the "rest of the app" (an `Effect` producing a response) and returns a new one. Built-ins: `logger` (applied automatically by `HttpRouter.serve` unless disabled), `tracer`, `cors`, `xForwardedHeaders`, `searchParamsParser`. Define custom middleware with `HttpMiddleware.make`. To modify the response, register via `HttpRouter.middleware` (the `serve`-level option runs around the whole chain but can't change the final response).

```ts
import { Clock, Effect } from "effect"
import { HttpMiddleware, HttpServerResponse } from "effect/unstable/http"

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

> **Warning:** The built-in `logger` middleware is on by default via `HttpRouter.serve`. Pass `{ disableLogger: true }` to `serve`, or layer `HttpRouter.disableLogger`, to opt out.

**Reach for it when** you need cross-cutting behavior — auth, timing, request IDs, CORS — without repeating it per handler.

## HttpBody

`effect/unstable/http/HttpBody` — unstable

Unified body representation shared by client requests and server responses. The higher-level constructors (e.g. `HttpServerResponse.json`, `HttpClientRequest.bodyText`) usually build these for you, but the module provides explicit control: `HttpBody.text`, `json`/`jsonUnsafe`, `jsonSchema` (encode through a Schema), `uint8Array`, `urlParams`, `formData`/`formDataRecord`, `stream`, `file`. Construction failures surface as `HttpBodyError`.

**Reach for it when** building a body by hand — streaming batches, multipart uploads, or schema-encoded JSON — rather than via a verb helper.

## Headers

`effect/unstable/http/Headers` — unstable

Immutable, case-insensitive header map with redaction support. `Headers.fromInput` builds one; pure operations: `get`/`set`/`merge`/`remove`. `redact` (and the `CurrentRedactedNames` reference) strips sensitive headers like `authorization` from logs and traces automatically.

```ts
import { Headers } from "effect/unstable/http"

const headers = Headers.set(
  Headers.fromInput({ "content-type": "application/json" }),
  "authorization",
  "Bearer hris-service-token"
)
// Redact sensitive names before logging.
const safeForLogs = Headers.redact(headers, ["authorization"])
```

**Reach for it when** you manipulate headers directly, or need redaction to keep credentials out of logs.

## Cookies

`effect/unstable/http/Cookies` — unstable

Immutable cookie jar plus a `Cookie` type with all attributes (`httpOnly`, `secure`, `sameSite`, `maxAge`, `path`, `domain`). Parse a request's `Cookie` header with `parseHeader`; `fromSetCookie` parses one or more response `Set-Cookie` header values into a jar. Build with `set`/`setUnsafe` and expire with `expireCookie`. The safe constructors validate the cookie name, value, domain, and path and return `CookiesError`; reserve `*Unsafe` forms for already-trusted values. On the server use `HttpServerResponse.setCookie`; on the client, a `Ref<Cookies>` wired via `HttpClient.withCookiesRef` gives a persistent session.

**Reach for it when** setting auth/session cookies on responses or maintaining a cookie jar across client calls.

## HttpMethod

`effect/unstable/http/HttpMethod` — unstable

Type-level vocabulary for HTTP verbs: the `HttpMethod` union, the `all` set, `isHttpMethod` guard, and `hasBody` (true for methods this module treats as body-capable: POST, PUT, DELETE, and PATCH; false for GET, HEAD, OPTIONS, and TRACE).

**Reach for it when** branching on request method or validating a method string.

## Url

`effect/unstable/http/Url` — unstable

Safe, immutable helpers over the native `URL`. `Url.fromString` parses (returns a `Result` — bad URL is a value, not a throw); `Url.make(url, params, hash)` constructs a URL while appending `UrlParams` and returns a typed `UrlError`; `mutate` applies a mutation to a copy; pipeable setters (`setHostname`, `setPathname`, `setProtocol`, `setUrlParams`, …) edit without mutation. URL construction lives here — the old `UrlParams.makeUrl` entry point is gone.

```ts
import { Url } from "effect/unstable/http"

const url = new URL("https://hris.acme.internal/employees")
// mutate copies first, so the original is untouched.
const updated = Url.mutate(url, (u) => {
  u.pathname = "/v2/employees"
  u.searchParams.set("page", "1")
})
```

**Reach for it when** parsing or transforming URLs with immutability and parse errors as values.

## UrlParams

`effect/unstable/http/UrlParams` — unstable

Immutable, order-preserving query-string model with correct repeated-key handling. Build with `make`/`fromInput`, read with `getAll`/`getFirst`/`getLast`, edit with `set`/`append`/`remove`. Accepts coercible inputs — numbers, booleans, bigints. `schemaJsonField` round-trips a JSON-encoded query param through a Schema.

```ts
import { UrlParams } from "effect/unstable/http"

// Filter the employee roster by several departments at once.
const params = UrlParams.fromInput({ dept: ["ENG", "SALES"], page: 2 }).pipe(
  UrlParams.append("dept", "OPS")
)
UrlParams.getAll(params, "dept") // ["ENG", "SALES", "OPS"]
UrlParams.toString(params) // "dept=ENG&dept=SALES&page=2&dept=OPS"
```

**Reach for it when** building or parsing query strings, especially with repeated keys or typed values.

## Multipart

`effect/unstable/http/Multipart` — unstable

Streaming `multipart/form-data` parsing. Distinguishes `Field` (text) from `File` parts; can persist uploads to disk (`PersistedFile`). Exposes Schemas (`FilesSchema`, `SingleFileSchema`, `PersistedFileSchema`) for typed decoding. Safety limits — `MaxParts`, `MaxFileSize`, `MaxFieldSize`, `FieldMimeTypes` — are `Context.Reference`s tunable per route. Failures: `MultipartError`.

**Mental model.** An upload is a stream of parts, not a blob. Typically used via `HttpServerRequest.schemaBodyForm(schema)` or `schemaBodyMultipart(schema)` — Multipart + Schema handle parsing and validation together.

```ts
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse, Multipart } from "effect/unstable/http"

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

`effect/unstable/http/HttpServerError` — unstable

Server tagged error family: `RequestParseError` (schema decode failed), `RouteNotFound`, `InternalError`, `ResponseError`, `ServeError` (listener couldn't bind). The framework maps these to sensible status codes (parse error → 400, missing route → 404); `causeResponse` turns a failure cause into a response.

**Reach for it when** you want to override how parse or not-found failures are rendered, or react to a bind failure on startup.

## HttpServerRespondable

`effect/unstable/http/HttpServerRespondable` — unstable

Interface that lets any value describe how it becomes a response. Implement the `HttpServerRespondable` symbol on a class (e.g. a tagged error) and the router converts it to an `HttpServerResponse` automatically — a handler can fail with a domain error and have it rendered without a manual mapping step. `toResponse`/`toResponseOrElse` perform the conversion.

**Reach for it when** you want domain errors or DTOs to render themselves as responses instead of per-error response code.

## Etag

`effect/unstable/http/Etag` — unstable

ETag generation for caching and conditional requests. `Etag.Generator` service produces strong or weak tags from file info; provide `Etag.layer` (strong) or `Etag.layerWeak` (weak) and the static-file machinery uses it to support `If-None-Match` and 304 responses.

**Reach for it when** serving files or cacheable resources and wanting conditional-request support without hand-rolling hashes.

## Template

`effect/unstable/http/Template` — unstable

Effectful tagged-template literal for building HTML (or any string) where interpolations can themselves be Effects, `Option`s, or Streams. `Template.make` resolves embedded effects (concurrently) and produces `Effect<string>`; `Template.stream` produces `Stream<string>` for progressive rendering. Pair with `HttpServerResponse.html`/`htmlStream` for streaming server-side rendering.

```ts
import { Effect } from "effect"
import { HttpServerResponse, Template } from "effect/unstable/http"

// Render a comp summary page, resolving the employee name async inside the markup.
const renderCompPage = (employeeName: Effect.Effect<string>) =>
  Effect.gen(function*() {
    const html = yield* Template.make`<h1>Comp plan for ${employeeName}</h1>`
    return HttpServerResponse.html(html)
  })
```

**Reach for it when** rendering HTML server-side with async data and streaming composing naturally inside the markup.
