# HttpApi

Describe the API once as data: groups of endpoints, each with Schema-typed path params, query, payload, success, and errors. Derive a server (implement handlers, get validation free), a fully typed client (method names and argument/return types mirror the definition), and OpenAPI + Swagger + Scalar docs. Rename an endpoint or change a field and every consumer fails to compile.

> **Tip:** Keep the API *definition* (`HttpApi`, groups, endpoints, error schemas, middleware interfaces) in a module with **no server code**. The server implements handlers against it; clients derive from it. This lets a frontend import the exact same contract the backend serves, with zero server code crossing the boundary.

> **Official example:** Effect's release-matched [`ai-docs` HttpApi server example](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/51_http-server) connects a schema-first contract, handlers, middleware, serving, and a generated client.

## HttpApiEndpoint

`effect/unstable/httpapi/HttpApiEndpoint` — unstable

One endpoint described as data. `HttpApiEndpoint.get(identifier, path, spec)` (and `post`, `put`, `patch`, `delete`, …) declares a route whose `params`, `query`, `payload`, `success`, and `error` are all Schemas. The `identifier` becomes the handler key and client method name and is exposed as `.identifier`; do not use `.name`, which is the native function name because endpoints are callable function objects. The path string carries `:params`.

**Mental model.** A typed contract: "given these validated inputs, return this success or one of these errors." The verb decides where `payload` lives — GET uses query string, POST/PUT uses request body (JSON by default). Path params are strings on the wire; their Schemas must decode *from* string (use `Schema.FiniteFromString`, or bridge with `Schema.decodeTo` to a branded type). Array-valued query fields accept either one value or repeated values, so `?tag=equity` decodes like the singleton array form of `?tag=equity&tag=salary`.

```ts
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiSchema } from "effect/unstable/httpapi"
import { CompRecord, EmployeeId, RaiseInput } from "./domain/Comp.ts"
import { EmployeeNotFound } from "./domain/CompErrors.ts"

// GET an employee's comp by id: the path param must DECODE FROM a string.
const getComp = HttpApiEndpoint.get("getComp", "/employees/:id/comp", {
  params: {
    id: Schema.FiniteFromString.pipe(Schema.decodeTo(EmployeeId))
  },
  success: CompRecord,
  // Render this error as a bare 404 with no body.
  error: EmployeeNotFound.pipe(
    HttpApiSchema.asNoContent({ decode: () => new EmployeeNotFound() })
  )
})

// POST a raise: payload is the JSON request body.
const postRaise = HttpApiEndpoint.post("postRaise", "/employees/:id/raise", {
  params: {
    id: Schema.FiniteFromString.pipe(Schema.decodeTo(EmployeeId))
  },
  payload: RaiseInput,
  success: CompRecord
})
```

**Reach for it when** describing a single route's typed inputs and outputs — the atom every HttpApi is built from.

## HttpApiGroup

`effect/unstable/httpapi/HttpApiGroup` — unstable

Named bundle of related endpoints sharing a path prefix, middleware, and OpenAPI metadata. `HttpApiGroup.make("comp").add(...endpoints)` collects endpoints; `.prefix("/comp")` mounts them; `.middleware(Authorization)` applies middleware to the group; `.annotateMerge(OpenApi.annotations(...))` adds docs. Pass `{ topLevel: true }` to flatten a group's endpoints onto the root of the derived client.

**Mental model.** The unit of organization and shared policy. In the derived client, a group becomes a namespace (`client.comp.getComp()`) unless `topLevel`, in which case methods sit at the root (`client.health()`).

```ts
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "./Authorization.ts"

const getComp = HttpApiEndpoint.get("getComp", "/employees/:id")
const postRaise = HttpApiEndpoint.post("postRaise", "/employees/:id/raise")
const postGrant = HttpApiEndpoint.post("postGrant", "/employees/:id/grants")

// Our CompGroup: read comp, post a raise, record an equity grant.
export class CompGroup extends HttpApiGroup.make("comp")
  .add(getComp, postRaise, postGrant)
  .middleware(Authorization)            // auth for every endpoint in the group
  .prefix("/comp")                      // mount all under /comp
  .annotateMerge(OpenApi.annotations({  // group-level docs
    title: "Compensation",
    description: "Read comp, record raises, and grant equity"
  })) {}

// A top-level group flattens onto the client root: client.health()
export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent })
) {}
```

**Reach for it when** grouping endpoints that share a prefix or auth, or wanting a clean namespace in the generated client.

## HttpApi

`effect/unstable/httpapi/HttpApi` — unstable

Root value tying groups into one API. `HttpApi.make("my-api").add(GroupA).add(GroupB)` builds it; `.annotateMerge(OpenApi.annotations(...))` adds top-level docs (title, version, license). This single object is what you serve, generate clients from, and produce OpenAPI specs from.

**Mental model.** Table of contents and source of truth. Everything downstream — server routes, typed client, docs — is *derived* from it; the contract can't drift.

```ts
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { CompGroup } from "./Comp.ts"
import { SystemApi } from "./System.ts"

export class Api extends HttpApi.make("comp-api")
  .add(CompGroup)
  .add(SystemApi)
  .annotateMerge(OpenApi.annotations({ title: "Acme Compensation API" })) {}
```

**Reach for it when** assembling groups into the one definition that drives server, client, and docs.

## HttpApiSchema

`effect/unstable/httpapi/HttpApiSchema` — unstable

Toolkit for describing HTTP-specific facets of a schema: status codes, content types, empty responses, and streaming. `HttpApiSchema.status(code)` pins a status; `NoContent`/`Created`/`Accepted` are ready-made empty responses; `asText({ contentType })` serves a string as text/CSV/etc.; `asNoContent({ decode })` turns an error into a bodyless response; `asMultipart` marks a payload as multipart upload; `StreamUint8Array`/`StreamSse` describe streaming bodies (raw bytes or Server-Sent Events).

**Mental model.** Domain Schemas describe *shape*; `HttpApiSchema` annotations describe *how that shape rides on HTTP*. Pipeable wrappers — `MySchema.pipe(HttpApiSchema.status(201))` — bolt HTTP semantics onto a plain Schema without changing its decoded type.

```ts
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiSchema } from "effect/unstable/httpapi"
import { CompRecord } from "./domain/Comp.ts"

// Content negotiation: the same roster either as JSON OR as a CSV export.
const exportComp = HttpApiEndpoint.get("exportComp", "/export", {
  payload: { departmentId: Schema.String },
  success: [
    Schema.Array(CompRecord),
    Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" }))
  ]
})

// A streamed bytes response with a pinned status and custom content type
// (e.g. a generated comp-band report).
const download = HttpApiEndpoint.get("download", "/report", {
  success: HttpApiSchema.status(206)(
    HttpApiSchema.StreamUint8Array({ contentType: "application/octet-stream" })
  )
})

// Response headers are part of the contract, visible to handlers and clients.
const PaginatedComp = HttpApiSchema.WithHeaders(
  Schema.Array(CompRecord),
  {
    "x-total-count": Schema.FiniteFromString,
    "x-next-page": Schema.optionalKey(Schema.String)
  }
)

const page = HttpApiSchema.withHeaders({
  body: [] as ReadonlyArray<typeof CompRecord.Type>,
  headers: { "x-total-count": 0 }
})
```

`WithHeaders(bodySchema, headersSchema)` makes the success/client value a branded `{ body, headers }` pair and works for streaming success bodies too. For a domain error that should remain the handler's error type while encoding selected fields into HTTP headers, pipe it through `encodeToWithHeaders({ body, headers }, { decode, encode })`. Nesting `WithHeaders` is rejected. Explicit `content-type` or `content-length` values in the returned headers override values inferred from the body; endpoint construction also rejects ambiguous response variants sharing the same status/content type.

**Reach for it when** an endpoint needs a specific status, non-JSON content type, empty body, file upload, or streaming response.

## HttpApiError

`effect/unstable/httpapi/HttpApiError` — unstable

Ready-made schema-typed errors for common HTTP failures: `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `UnprocessableEntity` (422), `RequestTimeout`, `InternalServerError`, and more — each with the correct status code, plus `*NoContent` variants such as `UnprocessableEntityNoContent` for empty-body responses. Add to an endpoint's `error` list and fail with them like any yieldable error.

**Mental model.** Regular `Schema.Error` errors — they decode/encode across the wire, and a derived client gets them in its typed error channel automatically. For domain-specific failures, define your own `Schema.TaggedError` with an `httpApiStatus`.

```ts
import { Effect } from "effect"
import { HttpApiError } from "effect/unstable/httpapi"

// Inside a handler: fail with a built-in error like any other.
const handler = Effect.gen(function*() {
  const budgetApproved = false
  if (!budgetApproved) {
    return yield* new HttpApiError.Conflict() // 409
  }
  return "ok"
})
```

> **Note:** **Status codes on your own errors.** Define the status on the class: `class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {}, { httpApiStatus: 404 }) {}`. The third options argument is where HttpApi reads the code from.

**Reach for it when** an endpoint needs a standard HTTP error without hand-rolling the status mapping.

## HttpApiSecurity

`effect/unstable/httpapi/HttpApiSecurity` — unstable

Declarative security schemes: `HttpApiSecurity.bearer` (Authorization: Bearer), `apiKey({ key, in })` (header/query/cookie), `basic` (HTTP Basic). Attach to a middleware definition; HttpApi extracts and decodes the credential from each request (handing it to middleware as a `Redacted` value) and emits the matching `securityScheme` into the OpenAPI doc so the "Authorize" button works in Swagger/Scalar.

**Reach for it when** protecting endpoints and wanting both runtime credential extraction and accurate security docs from one declaration.

## HttpApiMiddleware

`effect/unstable/httpapi/HttpApiMiddleware` — unstable

Middleware for the declarative world, defined as a typed service. `HttpApiMiddleware.Service` declares what the middleware `provides` to downstream handlers (e.g. a `CurrentUser` service), what it `requires`, the `error` it can raise, and an optional `security` scheme. The definition lives next to the API (no implementation); the server supplies a `Layer` that implements it; clients supply a `layerClient` to inject credentials.

**Mental model.** Auth-as-a-service. Because middleware can *provide* a service, an auth middleware can decode a bearer token and inject the authenticated user into context — downstream handlers just `yield* CurrentUser`. The provides/requires types are tracked: forgetting to wire a middleware is a compile error, not a runtime failure.

```ts
import { Context, Schema } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import type { Employee } from "../domain/Comp.ts"

// The service the middleware injects for downstream endpoints — the
// authenticated HRBP/manager driving the comp change.
export class CurrentUser extends Context.Service<CurrentUser, Employee>()(
  "comp/Authorization/CurrentUser"
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 }
) {}

// Definition only — no implementation here.
export class Authorization extends HttpApiMiddleware.Service<Authorization, {
  provides: CurrentUser  // downstream handlers can read CurrentUser
  requires: never
}>()("comp/Authorization", {
  requiredForClient: true,                  // clients must inject credentials too
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}
```

The server implements it as a Layer — validates the credential and `provideService`s the context:

```ts
import { Effect, Layer, Redacted } from "effect"
import { Authorization, CurrentUser, Unauthorized } from "./Authorization.ts"
import { Employee, EmployeeId } from "../domain/Comp.ts"

export const AuthorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function*() {
    return Authorization.of({
      bearer: Effect.fn(function*(httpEffect, { credential }) {
        if (Redacted.value(credential) !== "hrbp-token") {
          return yield* new Unauthorized({ message: "Invalid bearer token" })
        }
        // Inject the user for every endpoint that runs after this middleware.
        return yield* Effect.provideService(
          httpEffect,
          CurrentUser,
          new Employee({ id: EmployeeId.make(1), name: "Dana HRBP", level: 6, baseSalary: 0 })
        )
      })
    })
  })
)
```

**Reach for it when** you need auth (or any cross-cutting concern) that both decodes credentials and provides typed context to handlers, with wiring checked at compile time.

## HttpApiBuilder

`effect/unstable/httpapi/HttpApiBuilder` — unstable

The server side — where handlers are implemented. `HttpApiBuilder.group(api, "comp", build)` gives a typed `handlers` object whose `.handle("name", impl)` only accepts endpoints in that group, with inputs (`params`, `query`, `payload`) already decoded and return type constrained to the endpoint's `success`/`error`. `HttpApiBuilder.layer(api, { openapiPath })` turns the implemented API into router routes (and optionally publishes the OpenAPI JSON).

**Mental model.** The contract enforcer. You can't implement a nonexistent endpoint, return the wrong type, or omit one — the types prevent it. Inputs arrive validated; focus purely on business logic.

For a larger group, `handlers.handleAll({ endpointId: handler, ... })` registers an exhaustively typed identifier-keyed object in one call. It avoids a long fluent chain while preserving the same duplicate/missing-handler checks.

```ts
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../../api/Api.ts"
import { CurrentUser } from "../../api/Authorization.ts"
import { CompService } from "../CompService.ts"

export const CompApiHandlers = HttpApiBuilder.group(
  Api,
  "comp",
  Effect.fn(function*(handlers) {
    const comp = yield* CompService // your comp/HRIS service

    return handlers
      // Inputs are already decoded: `params`, `payload` are typed.
      .handle("getComp", ({ params }) =>
        // EmployeeNotFound is declared on the endpoint, so let it through;
        // anything unexpected becomes a 500.
        comp.getComp(params.id).pipe(
          Effect.catchTag("BandViolation", Effect.die)
        ))
      .handle("postRaise", Effect.fn(function*({ params, payload }) {
        // BandViolation (salary outside the level's band) is a declared error.
        return yield* comp.recordRaise(params.id, payload)
      }))
      .handle("postGrant", ({ payload }) => comp.recordGrant(payload).pipe(Effect.orDie))
      // The Authorization middleware provided CurrentUser — just read it.
      .handle("me", () => CurrentUser)
  })
).pipe(
  Layer.provide([CompService.layer, AuthorizationLayer])
)
```

Assemble the server: provide each group's handler Layer to `HttpApiBuilder.layer`, mount docs, and serve.

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import { createServer } from "node:http"

const ApiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([CompApiHandlers, SystemApiHandlers])
)
const DocsRoute = HttpApiScalar.layer(Api, { path: "/docs" })

const ServerLayer = HttpRouter.serve(Layer.mergeAll(ApiRoutes, DocsRoute)).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
```

**Reach for it when** implementing the server for an `HttpApi` — this is the only place handlers live.

## HttpApiClient

`effect/unstable/httpapi/HttpApiClient` — unstable

Fully typed client derived from your API definition — no codegen. `HttpApiClient.make(Api, { transformClient })` produces an object mirroring your groups and endpoints: `client.comp.getComp({ params: { id } })` returns `Effect<CompRecord, EmployeeNotFound | ...>` with request encoding, middleware, and response decoding handled. Path params, query, and payload go under named keys: `{ params: { id }, payload: { ... } }`. `transformClient` sets the base URL and adds retries by composing the underlying `HttpClient`.

**Mental model.** A live, type-level reflection of the server contract. Both sides share the one `HttpApi` value — renaming an endpoint or tweaking a field breaks client types immediately. If a middleware is `requiredForClient`, its `layerClient` must be provided to inject credentials.

```ts
import { Context, Effect, flow, Layer, Schedule } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient, HttpApiMiddleware } from "effect/unstable/httpapi"
import { Api } from "./api/Api.ts"
import { Authorization } from "./api/Authorization.ts"

// Client-side implementation of the required Authorization middleware: inject a token.
const AuthorizationClient = HttpApiMiddleware.layerClient(
  Authorization,
  Effect.fn(function*({ next, request }) {
    return yield* next(HttpClientRequest.bearerToken(request, "hrbp-token"))
  })
)

export class ApiClient extends Context.Service<ApiClient, HttpApiClient.ForApi<typeof Api>>()(
  "comp/ApiClient"
) {
  static readonly layer = Layer.effect(
    ApiClient,
    HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(
          HttpClient.mapRequest(flow(HttpClientRequest.prependUrl("http://localhost:3000"))),
          HttpClient.retryTransient({ schedule: Schedule.exponential(100), times: 3 })
        )
    })
  ).pipe(
    Layer.provide(AuthorizationClient),   // required because requiredForClient: true
    Layer.provide(FetchHttpClient.layer)  // the underlying HttpClient implementation
  )
}

// Calling it is just Effect. Types mirror the API end-to-end.
export const callApi = Effect.gen(function*() {
  const client = yield* ApiClient
  // Path params live under `params`; the result is typed CompRecord.
  const comp = yield* client.comp.getComp({ params: { id: 42 } })
  yield* client.health() // SystemApi was topLevel -> method sits at the root
  return comp
}).pipe(Effect.provide(ApiClient.layer))
```

**Reach for it when** consuming an `HttpApi` from another service or frontend and wanting a typed client that can never silently drift from the server.

## OpenApi

`effect/unstable/httpapi/OpenApi` — unstable

OpenAPI 3.1 generator and annotation toolkit. `OpenApi.fromApi(api)` returns a complete spec object derived from endpoints, schemas, errors, and security. `OpenApi.annotations({ title, version, description, license, ... })` attaches metadata; services (`OpenApi.Title`, `Version`, `Servers`, `Summary`, `Deprecated`, `Exclude`, `Transform`) override anything down to a single parameter.

**Mental model.** Docs are a *projection* of the same definition — not a parallel artifact kept in sync by hand. Because the spec comes from live Schemas, request/response shapes in the docs are always correct. Results are fresh clones even when the compiler cache is hit, so mutating one returned spec does not contaminate a later `fromApi` call.

```ts
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "./api/Api.ts"

// The raw spec object — serve it, write it to a file, feed it to codegen tools.
const spec = OpenApi.fromApi(Api)
```

Typically you don't call `fromApi` yourself — passing `openapiPath` to `HttpApiBuilder.layer` publishes it, and Swagger/Scalar layers consume it. Annotate at any level: `HttpApi.make(...).annotateMerge(OpenApi.annotations({ title, version }))` for the whole API, or equivalently on a group or endpoint.

**Reach for it when** you need an OpenAPI document for external consumers, codegen, or API gateways — guaranteed to match what you actually serve.

## HttpApiSwagger

`effect/unstable/httpapi/HttpApiSwagger` — unstable

Mounts Swagger UI for your API. `HttpApiSwagger.layer(Api, { path: "/docs" })` serves the interactive Swagger explorer (with a working "Authorize" button if security is declared) at the chosen path, backed by the generated OpenAPI spec. Merge the Layer alongside your API routes.

```ts
import { HttpApiSwagger } from "effect/unstable/httpapi"
import { Api } from "./api/Api.ts"

const SwaggerRoute = HttpApiSwagger.layer(Api, { path: "/docs" })
```

**Reach for it when** you want the familiar Swagger UI with zero extra wiring.

## HttpApiScalar

`effect/unstable/httpapi/HttpApiScalar` — unstable

Same idea as Swagger, rendered with [Scalar's](https://github.com/scalar/scalar) modern API reference UI. `HttpApiScalar.layer(Api, { path: "/docs" })` bundles the Scalar script inline; `HttpApiScalar.layerCdn(Api, { path, version })` loads it from a CDN. Both serve the generated OpenAPI spec.

```ts
import { HttpApiScalar } from "effect/unstable/httpapi"
import { Api } from "./api/Api.ts"

const DocsRoute = HttpApiScalar.layer(Api, { path: "/docs" })
```

**Reach for it when** you want a modern docs page instead of Swagger UI — same effort, nicer result.

## HttpApiTest

`effect/unstable/httpapi/HttpApiTest` — unstable

In-memory testing — no socket, no port. `HttpApiTest.groups(Api, ["comp"])` wires selected groups' handlers to a generated client through the *real* request encoding, routing, response encoding, and client decoding pipeline, then returns the typed client. Call endpoints exactly as in production and assert on results. Unselected groups get placeholder handlers that fail if called, keeping tests scoped.

**Mental model.** Full HttpApi round-trip with the network removed — exercises schema validation, status mapping, and middleware for real, while staying fast and deterministic.

```ts
import { assert, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { Etag, HttpPlatform } from "effect/unstable/http"
import { HttpApiTest } from "effect/unstable/httpapi"
import { Api } from "./api/Api.ts"
import { CompApiHandlers } from "./server/Comp/http.ts"

// HttpApiBuilder needs these platform services; FileSystem can be a noop in tests.
const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({}))
)

it.layer(TestServices)("Comp API", (it) => {
  it.effect("reads an employee's comp", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(Api, ["comp"]).pipe(
        Effect.provide(CompApiHandlers)
      )
      const comp = yield* client.comp.getComp({ params: { id: 1 } })
      assert.strictEqual(comp.employeeId, 1)
    }))
})
```

**Reach for it when** testing handlers, schema round-trips, error mapping, or middleware — fast, faithful, without standing up a server.

> **Tip:** Full arc: define endpoints with `HttpApiEndpoint`, bundle with `HttpApiGroup`, assemble with `HttpApi`; annotate HTTP facets with `HttpApiSchema` and errors with `HttpApiError`/`HttpApiSecurity`/`HttpApiMiddleware`; implement on the server with `HttpApiBuilder` and serve via `HttpRouter`; consume with the derived `HttpApiClient`; publish docs with `OpenApi` + `HttpApiSwagger`/`HttpApiScalar`; test in memory with `HttpApiTest`. One definition — every consumer in lockstep.
