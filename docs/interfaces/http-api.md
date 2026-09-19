# HttpApi

Describe the API once as data: groups of endpoints, each with Schema-typed path params, query, payload, success, and errors. Derive a server (implement handlers, get validation free), a fully typed client (method names and argument/return types mirror the definition), and OpenAPI + Swagger + Scalar docs. Rename an endpoint or change a field and every consumer fails to compile.

> **Tip:** Keep the API *definition* (`HttpApi`, groups, endpoints, error schemas, middleware interfaces) in a module with **no server code**. The server implements handlers against it; clients derive from it. This lets a frontend import the exact same contract the backend serves, with zero server code crossing the boundary.

> **Official example:** Effect's release-matched [`ai-docs` HttpApi server example](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.116/ai-docs/src/51_http-server) connects a schema-first contract, handlers, middleware, serving, and a generated client.

## HttpApiEndpoint

`effect/unstable/httpapi/HttpApiEndpoint` — unstable

One endpoint described as data. `HttpApiEndpoint.get(identifier, path, spec)` (and `post`, `put`, `patch`, `delete`, …) declares a route whose `params`, `query`, `payload`, `success`, and `error` are all Schemas. The `identifier` becomes the handler key and client method name and is exposed as `.identifier`; do not use `.name`, which is the native function name because endpoints are callable function objects. The path string carries `:params`.

**Mental model.** A typed contract: "given these validated inputs, return this success or one of these errors." The verb decides where `payload` lives — GET uses query string, POST/PUT/PATCH and QUERY use the request body (JSON by default). Path params are strings on the wire; their Schemas must decode *from* string (use `Schema.FiniteFromString`, or bridge with `Schema.decodeTo` to a branded type). Array-valued query fields accept either one value or repeated values, so `?tag=equity` decodes like the singleton array form of `?tag=equity&tag=salary`.

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

`HttpApiEndpoint.query` (`rc.116`) declares an HTTP `QUERY` endpoint: a safe, idempotent read whose `payload` travels in the request body like a `POST`, for searches too large or too structured for a query string. The server, the derived client, and `HttpApiTest` handle it like any other verb (probed); OpenAPI output and CORS need attention, see [OpenApi](#openapi) and [HttpMiddleware](http-server#httpmiddleware).

```ts
import { Schema } from "effect"
import { HttpApiEndpoint } from "effect/unstable/httpapi"

// Search comp bands with a structured filter in the body: QUERY /comp-bands/search
const searchBands = HttpApiEndpoint.query("searchBands", "/comp-bands/search", {
  payload: Schema.Struct({
    levels: Schema.Array(Schema.String),
    location: Schema.String
  }),
  success: Schema.Array(Schema.Struct({ level: Schema.String, midpoint: Schema.Finite }))
})
```

A literal suffix after a path parameter stays literal: `/merit-cycles/:id:close` binds `id` and keeps `:close` as literal path text. Since `rc.116` the server router, the derived client and `urlBuilder`, and the OpenAPI path (`/merit-cycles/{id}:close`) all agree on that shape (probed).

> **Warning:** **Put the rule on the contract, not in the handler.** A permissive endpoint schema (`id: Schema.String`) with the real pattern, range, or brand check repeated inside the handler hides the rule from the derived client, the OpenAPI document, and contract tests, and it lets invalid input reach downstream work before anything rejects it. Put checks and brands on `params`, `query`, `headers`, and `payload`; the handler then only ever sees decoded values. HttpApi answers a request that fails decoding with an empty `400` and an unmatched request `Content-Type` with `415`, both before the handler runs — [HttpApiTest](#httpapitest) shows how to prove it. Schema mechanics (checks, brands, transformations) live in [Schema](../data/schema#schema).

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

`HttpApi.ParseOptions` (`rc.116`) sets the Schema parse options that the server **and** the derived client use for every codec of an endpoint: path, query, headers, payload, success, errors, and SSE events. Annotate the API, a group, or an endpoint with `.annotate(HttpApi.ParseOptions, options)`. The most specific level wins and replaces the whole object (options are not merged), and without an annotation Schema's defaults apply. Annotate the API before passing it to `HttpApiBuilder.group` or `HttpApiBuilder.endpoint`.

```ts
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

const RaiseInput = Schema.Struct({ amount: Schema.Finite, effectiveDate: Schema.String })

// Reject unknown request fields (a mistyped `efectiveDate` is a 400, not a silent drop)
// and report every issue instead of the first one.
export class RaisesApi extends HttpApi.make("raises").add(
  HttpApiGroup.make("raises").add(
    HttpApiEndpoint.post("propose", "/raises", { payload: RaiseInput })
  )
).annotate(HttpApi.ParseOptions, { onExcessProperty: "error", errors: "all" }) {}
```

Probed on `rc.116`: with that annotation a `POST` carrying an extra property gets `400`; without it the property is dropped and the handler runs. Header codecs receive **all** request headers, so on an endpoint that declares `headers`, `onExcessProperty: "error"` also rejects undeclared ones such as `content-type`; set a looser object on that endpoint.

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

`HttpApiSchema.status` takes a numeric code or, since `rc.109`, a status literal name from [HttpStatus](http-server#httpstatus): `RaiseInput.pipe(HttpApiSchema.status("Created"))` and `HttpApiSchema.status(201)` annotate the same thing, and the name survives code review better than a bare number.

`WithHeaders(bodySchema, headersSchema)` makes the success/client value a branded `{ body, headers }` pair and works for streaming success bodies too. For a domain error that should remain the handler's error type while encoding selected fields into HTTP headers, pipe it through `encodeToWithHeaders({ body, headers }, { decode, encode })`. Nesting `WithHeaders` is rejected. Explicit `content-type` or `content-length` values in the returned headers override values inferred from the body; endpoint construction also rejects ambiguous response variants sharing the same status/content type.

In `StreamSse({ data })` mode each event is `{ id?, event, data }`: since `rc.116` the `id` is optional in the TypeScript type and in the OpenAPI schema, and a decoded event without an `id` omits the key rather than carrying `id: undefined`. A custom `events` schema should declare the id as `Schema.optional(Schema.String)`, not `Schema.UndefinedOr(Schema.String)`.

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

### Status mapping is part of the contract

An HTTP status is a claim about what happened. Map every member of the public error union to the status that tells the truth, and let nothing else through.

| Situation | Status | Produced by |
| --- | --- | --- |
| A path, query, header, or payload value fails its Schema, or a JSON body does not parse | `400`, empty body | HttpApi, before the handler runs |
| The request `Content-Type` matches no declared payload encoding | `415`, plain-text body | HttpApi, before the handler runs |
| No route matches | `404`, empty body | `HttpRouter` |
| Credential absent, malformed, expired, or revoked | `401` | your authentication middleware |
| Authenticated, but this actor may not perform this action on this tenant's resource | `403` | your use case or handler |
| The addressed resource does not exist | `404` | a declared error |
| State or idempotency conflict: duplicate key, stale version, raise already approved | `409` | a declared error |
| Well-formed input that current state rejects: salary outside the level's band | `422` | a declared error |
| A defect — anything the endpoint did not declare | `500`, empty body | HttpApi |
| The request fiber was interrupted: by a client disconnect / by the server itself | `499` / `503` | `HttpServerError.causeResponse` |

- **Only a query that succeeded and returned nothing is "not found".** A timeout, an exhausted pool, a permission error, or a malformed row is an infrastructure fault; rendering it as `404` or `409` makes clients act on a lie. Translate storage failures at the repository ([SqlError](sql#sqlerror)) and let the rest become `500`.
- **Do not `Effect.die` an expected failure to shrink a union.** Convert to a defect only what no caller could act on at this edge — as the [handler example](#httpapibuilder) does for a `BandViolation` that a read cannot produce. A `BandViolation` the UI must display belongs in the endpoint's `error` list.
- **Defects are sanitized for you.** A defect is answered with a content-free `500`; the `Cause` goes to the server log and any configured [`ErrorReporter`](../foundations/errors-option-result#errorreporter), never to the client. Do not add a catch-all that serializes `error.message` into the body.
- **Interruption is not a failure response.** A disconnect interrupts the request fiber (`499` is for your access log only — nobody receives it); do not catch it, retry it, or count it as an error rate.
- **The implicit `400` is not in the contract until you declare it.** `OpenApi.fromApi` lists only declared statuses, and a derived client sees an undeclared `400` as an `HttpClientError`. Add `HttpApiError.BadRequestNoContent` to `error` wherever inputs are validated; the client then fails with a typed `BadRequest` and the document lists `400`. To answer decode failures with your own body instead, implement a middleware with `HttpApiMiddleware.layerSchemaErrorTransform(service, (schemaError, { endpoint, group }) => ...)`.
- **A public error value is an output surface.** Every field of a declared error is serialized to clients and copied into telemetry. Give public errors a stable tag plus safe identifiers; keep `cause`, driver messages, SQL text, stack traces, and anything `Redacted` on internal errors only.

When a use case fails with a union wider than the endpoint declares, translate it with an exhaustive matcher so that a new member is a compile error rather than a silent `500`:

```ts
import { Data, Effect, Match, Schema } from "effect"

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()(
  "EmployeeNotFound",
  { employeeId: Schema.String },
  { httpApiStatus: 404 }
) {}

class RaiseAlreadyApproved extends Schema.TaggedError<RaiseAlreadyApproved>()(
  "RaiseAlreadyApproved",
  { raiseId: Schema.String },
  { httpApiStatus: 409 }
) {}

// Internal: carries a driver cause, so it is never declared on an endpoint.
class RepositoryError extends Data.TaggedError("RepositoryError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

type ApproveFailure = EmployeeNotFound | RaiseAlreadyApproved | RepositoryError

// No wildcard branch: adding a member to ApproveFailure stops this from compiling.
const toPublicError = Match.type<ApproveFailure>().pipe(
  Match.tagsExhaustive({
    EmployeeNotFound: (error) => Effect.fail(error),
    RaiseAlreadyApproved: (error) => Effect.fail(error),
    // The HTTP edge is the last owner of an infrastructure fault: a sanitized 500,
    // with the full Cause in the server log.
    RepositoryError: (error) => Effect.die(error)
  })
)

declare const approveRaise: (raiseId: string) => Effect.Effect<void, ApproveFailure>

// Effect<void, EmployeeNotFound | RaiseAlreadyApproved>
export const approveRaiseHandler = (raiseId: string) =>
  approveRaise(raiseId).pipe(Effect.catch(toPublicError))
```

**Reach for it when** an endpoint needs a standard HTTP error without hand-rolling the status mapping.

## HttpApiSecurity

`effect/unstable/httpapi/HttpApiSecurity` — unstable

Declarative security schemes: `HttpApiSecurity.bearer` (Authorization: Bearer), `apiKey({ key, in })` (header/query/cookie), `basic` (HTTP Basic). Attach to a middleware definition; HttpApi extracts and decodes the credential from each request (handing it to middleware as a `Redacted` value) and emits the matching `securityScheme` into the OpenAPI doc so the "Authorize" button works in Swagger/Scalar.

> **Warning:** **A security scheme extracts and documents; it verifies nothing.** When the header, cookie, or query key is absent or malformed, the middleware still runs and receives an *empty* credential (`Redacted.make("")`, or an empty `username`/`password` for `basic`). Rejecting it — and checking signature, expiry, issuer, audience, and revocation — is the middleware's job.

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

### Authentication is not authorization

The `AuthorizationLayer` above compares the token with a literal to keep the wiring visible. A real one answers two questions, with two owners and two statuses. **Authentication** ("who is calling?") belongs to the middleware and fails with `401`. **Authorization** ("may this actor do this, to this resource, in this tenant?") belongs to the use case and fails with `403`. Holding a valid token, reaching a route, or appearing in the OpenAPI document authorizes nothing.

| Step | Owner | Rule |
| --- | --- | --- |
| Extract the credential | `HttpApiSecurity` scheme | Keep it `Redacted`; call `Redacted.value` only inside the verifier. |
| Verify it | middleware, through a verifier service | Signature or opaque-token lookup, expiry, issuer/audience, revocation. An empty or invalid credential is one non-revealing `401`. |
| Provide a principal | middleware (`provides`) | A **narrow, decoded** value — actor id, tenant, permissions — never the raw token or unverified claims. |
| Authorize the operation | use case or handler | Check the concrete actor · action · tenant · resource on every call; fail with a declared `403`. |

```ts
import { Context, Effect, Layer, type Redacted, Schema } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"

// What handlers may know about the caller: verified facts only.
export class CurrentPrincipal extends Context.Service<CurrentPrincipal, {
  readonly actorId: string
  readonly tenantId: string
  readonly permissions: ReadonlySet<string>
}>()("comp/CurrentPrincipal") {}

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  {},
  { httpApiStatus: 401 }
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {},
  { httpApiStatus: 403 }
) {}

export class Authentication extends HttpApiMiddleware.Service<Authentication, {
  provides: CurrentPrincipal
}>()("comp/Authentication", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthenticated
}) {}

// The verifier is a capability: a JWKS check, a session lookup, or a test fake.
export class TokenVerifier extends Context.Service<TokenVerifier, {
  readonly verify: (
    token: Redacted.Redacted<string>
  ) => Effect.Effect<CurrentPrincipal["Service"], Unauthenticated>
}>()("comp/TokenVerifier") {}

export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function*() {
    const verifier = yield* TokenVerifier
    return Authentication.of({
      // A missing header arrives here as an empty credential; the verifier must reject it.
      bearer: Effect.fn(function*(httpEffect, { credential }) {
        const principal = yield* verifier.verify(credential)
        return yield* Effect.provideService(httpEffect, CurrentPrincipal, principal)
      })
    })
  })
)

// Authorization runs per operation, against the resource the request names.
export const authorize = Effect.fn("authorize")(function*(action: string, tenantId: string) {
  const principal = yield* CurrentPrincipal
  if (principal.tenantId !== tenantId || !principal.permissions.has(action)) {
    return yield* new Forbidden()
  }
  return principal
})
```

A handler for `POST /tenants/:tenantId/raises/:id/approve` starts with `yield* authorize("raise:approve", params.tenantId)` and declares `Forbidden` in the endpoint's `error`. Probed on `rc.116`: a request with no `Authorization` header and an invalid `:id` gets `401`, not `400`, because **middleware wraps request decoding** — an unauthenticated caller learns nothing about your validation rules; a valid token with the wrong tenant or a missing permission gets `403`, and the handler body never runs.

- **Declare a middleware's error once, on the middleware.** It reaches the derived client's error channel and the OpenAPI responses of every endpoint it covers (duplicated entries were fixed in `rc.113`); repeating it on each endpoint is noise.
- **Never infer authorization** from route possession, a documented security scheme, an unverified claim, a phantom type, or a cast. Audit system actors and "internal" bypass paths the same way as user calls.
- **Test every denial independently**: no credential, bad credential, wrong tenant, missing permission, and the success path each get their own assertion, plus one that a secret canary appears in neither the response body nor the captured log output.
- If the `401` needs a `WWW-Authenticate` challenge, fold the header into the error with `HttpApiSchema.encodeToWithHeaders` (see [HttpApiSchema](#httpapischema)).

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

`HttpApiBuilder.handler(api, groupId, endpointId, f)` (ported in `rc.113`) defines one endpoint callback outside the `group` builder. It returns `f` unchanged, but infers the request shape, the allowed success and error types, and the callback's service requirements from the endpoint — so large groups can keep one handler per module and still register them with `handlers.handle`.

```ts
import { Effect, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

class CompRecord extends Schema.Class<CompRecord>("CompRecord")({
  employeeId: Schema.String,
  baseSalary: Schema.Finite
}) {}

class Api extends HttpApi.make("comp-api").add(
  HttpApiGroup.make("comp").add(
    HttpApiEndpoint.get("getComp", "/employees/:id/comp", {
      params: { id: Schema.String },
      success: CompRecord
    })
  )
) {}

declare const loadComp: (employeeId: string) => Effect.Effect<CompRecord>

// `params.id` is a string and the result must be a CompRecord — no annotations needed.
export const getComp = HttpApiBuilder.handler(Api, "comp", "getComp", ({ params }) => loadComp(params.id))

export const CompHandlers = HttpApiBuilder.group(Api, "comp", (handlers) => handlers.handle("getComp", getComp))
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

### Handlers are lazy adapters

A handler translates one decoded request into one use-case call and returns the Effect. Keep everything else out.

- **Return an Effect; never run one.** No `Effect.runPromise`, no `ManagedRuntime`, no nested runtime inside a handler — the request fiber must own the work so that a disconnect or shutdown interrupts it ([HTTP Server](http-server#request-work-stays-in-the-request-fiber) shows the proof).
- **Depend on use-case services, not infrastructure.** A handler that yields `SqlClient` or builds an `HttpClient` has absorbed persistence and tenancy policy that no other entry point (RPC, CLI, workflow) will share.
- **Keep public DTOs separate from persistence models.** The endpoint's `success` schema is a published contract; a table row is not. Map between them in the use case or repository.
- **Translate errors at this edge, exhaustively** ([status mapping](#status-mapping-is-part-of-the-contract)), and authorize before acting ([authentication is not authorization](#authentication-is-not-authorization)).

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

Options and per-call controls worth knowing:

| Need | Use |
| --- | --- |
| Point the client at a host or base path | `HttpApiClient.make(Api, { baseUrl: "https://hr.acme.internal/api/v2" })` — shorter than a `prependUrl` transform |
| The status or headers as well as the decoded value | pass `responseMode: "decoded-and-response"` (a `[value, response]` tuple) or `"response-only"` in the call's request object; the default is `"decoded-only"` |
| A link or redirect target without executing a request | `HttpApiClient.urlBuilder(Api, { baseUrl })` mirrors the client's shape and returns strings: `urls.comp.getComp({ params, query })`. Params and query are encoded through the endpoint schemas, and a base URL's pathname is kept (it was dropped before `rc.113`) |
| Stricter or exhaustive decoding of responses | the same [`HttpApi.ParseOptions`](#httpapi) annotation the server reads also configures the client's request encoders and response decoders (`rc.116`) |
| A larger SSE event budget for one `StreamSse` endpoint | `sseOptions: { maxEventSize }` in that call's request object (`rc.113`); the default cap is 10 MiB per pending event |

The client decodes JSON, text, bytes, and — since `rc.113` — form-urlencoded responses according to the endpoint's declared encoding. Request values are encoded through the endpoint schemas *before* anything is sent, so a value that violates a check fails locally with `SchemaError`: **a typed client cannot produce malformed wire input**, which is why boundary tests need a raw request ([HttpApiTest](#httpapitest)).

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

Facts that decide how you use the document:

- **Each model owns its own artifact.** A value Schema knows a shape, so [`Schema.toJsonSchemaDocument`](../data/schema#jsonschema) yields a *JSON Schema* for config validation, structured-output prompts, or cross-language payload codegen. Methods, paths, parameter locations, statuses, per-endpoint errors, security, and media types live only on the assembled `HttpApi`, so the *OpenAPI* document must come from `OpenApi.fromApi`. Feeding either generator the other model produces a document missing exactly the facts the other owns — and a JSON Schema is not "the OpenAPI".
- **Objects are closed here, open there.** `fromApi` generates object schemas with `onExcessProperty: "error"`, so struct bodies carry `additionalProperties: false`. A bare `Schema.toJsonSchemaDocument` call leaves objects open (`additionalProperties: true`) unless you pass the same option. Decoding is a separate matter: by default the server decodes with Schema's default parse options, so an unknown request property is dropped before the handler sees the payload, not rejected. To make the server enforce what the document advertises, annotate the API with [`HttpApi.ParseOptions`](#httpapi) `{ onExcessProperty: "error" }`.
- **`QUERY` operations sit under an extension.** OpenAPI 3.1 has no `query` field, so `fromApi` emits an [`HttpApiEndpoint.query`](#httpapiendpoint) operation under `paths[path]["x-oai-additionalOperations"].QUERY` (probed). Swagger UI, Scalar, and generators that do not read that extension will not show it; `@effect/openapi-generator` reads both the extension and OpenAPI 3.2's native `query` field.
- **Only identified schemas become components.** A schema with an `identifier` annotation is emitted once under `components.schemas` and referenced by `$ref`; anonymous structs are inlined at each use. A `Schema.Class` named `CompRecord` appears as `CompRecordEncoded`, because the document describes the encoded side. Name the DTOs you want codegen tools to reuse.
- **Generation is deferred.** Since `rc.112` the `openapiPath`, Swagger, and Scalar routes build the document on the first request and memoize it, so startup stays cheap — and a generation defect (duplicate `operationId`, conflicting security scheme, invalid component key) surfaces on that first request, not at boot. Call `OpenApi.fromApi(Api)` in a test to move the failure into CI.
- **Overrides apply last.** Endpoint-level `OpenApi.Override` and `OpenApi.Transform` annotations run after schema generation (`rc.113`), so a transform sees — and may rewrite — the finished operation, including its generated request and response schemas.
- **Assert semantics, not snapshots.** Check the facts a consumer depends on — path, method, parameter locations, security requirement, media types, each declared status — instead of snapshotting the whole document, whose key order and component layout are not a contract.

Official guide: [Schema to JSON Schema](https://effect.website/docs/v4/schema/json-schema) — how `identifier` annotations become shared definitions (its "Generation Options" section describes an `additionalProperties` option; `rc.116` has `onExcessProperty` instead).

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

`HttpServer.layerServices` is the ready-made equivalent of the `TestServices` Layer above (`Path`, a weak `Etag` generator, `HttpPlatform`, and a no-op `FileSystem`). Since `rc.113` the harness also runs registered pre-response handlers, so headers and cookies added with `HttpEffect.appendPreResponseHandler` or `HttpApiBuilder.securitySetCookie` are visible on the test response.

### What each test ring proves

| Ring | Drive it with | Proves | Does not prove |
| --- | --- | --- | --- |
| 1. Compile | `tsc` over the API, the complete handler Layers, the derived client, and the root Layer | the contract, handlers, and wiring agree | any runtime behavior |
| 2. Document | targeted assertions on `OpenApi.fromApi(Api)` | published paths, parameters, security, media types, and statuses | that the server behaves that way |
| 3. In process | `HttpApiTest.groups` | codecs, routing, middleware, status mapping, typed errors | malformed input (the typed client cannot send it), sockets, disconnects |
| 4. Raw wire | `HttpRouter.toWebHandler` with a hand-built `Request`, or a real listener on port `0` | malformed JSON, wrong `Content-Type`, bad headers, invalid params, streaming, disconnect, listener release | that the deployed artifact starts |
| 5. Artifact | the built bundle or container, launched as in production | packaging, config, and startup | — |

A direct call to a service method is evidence about that service, not about HTTP. To show *where* validation lives, send an invalid value over the raw wire and assert both the `400` and that the dependency behind the handler was never touched:

```ts
import { assert, it } from "@effect/vitest"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

const EmployeeId = Schema.String.check(Schema.isPattern(/^E-\d{4}$/)).pipe(Schema.brand("EmployeeId"))
const CompRecord = Schema.Struct({ employeeId: EmployeeId, baseSalary: Schema.Finite })

class Api extends HttpApi.make("comp-api").add(
  HttpApiGroup.make("comp").add(
    HttpApiEndpoint.get("getComp", "/employees/:id/comp", {
      params: { id: EmployeeId }, // the rule lives on the contract
      success: CompRecord
    })
  )
) {}

class CompRepository extends Context.Service<CompRepository, {
  readonly find: (id: typeof EmployeeId.Type) => Effect.Effect<typeof CompRecord.Type>
}>()("comp/CompRepository") {}

const CompHandlers = HttpApiBuilder.group(
  Api,
  "comp",
  Effect.fn(function*(handlers) {
    const repository = yield* CompRepository
    return handlers.handle("getComp", ({ params }) => repository.find(params.id))
  })
)

it.effect("an invalid id never reaches the repository", () =>
  Effect.gen(function*() {
    const calls = yield* Ref.make(0)
    const CountingRepository = Layer.succeed(CompRepository)({
      find: (employeeId) =>
        Ref.update(calls, (n) => n + 1).pipe(Effect.as({ employeeId, baseSalary: 180_000 }))
    })
    const Routes = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(CompHandlers),
      Layer.provide(CountingRepository),
      Layer.provide(HttpServer.layerServices)
    )
    // The typed client would reject "nope" while encoding, so speak raw HTTP instead.
    const { dispose, handler } = HttpRouter.toWebHandler(Routes, { disableLogger: true })
    yield* Effect.addFinalizer(() => Effect.promise(dispose))

    const invalid = yield* Effect.promise(() => handler(new Request("http://localhost/employees/nope/comp")))
    assert.strictEqual(invalid.status, 400)
    assert.strictEqual(yield* Ref.get(calls), 0) // validation happened before the handler

    const valid = yield* Effect.promise(() => handler(new Request("http://localhost/employees/E-0042/comp")))
    assert.strictEqual(valid.status, 200)
    assert.strictEqual(yield* Ref.get(calls), 1)
  }))
```

For a secured mutation, cover every declared status, and the tenant and permission denials *independently*; assert over the raw wire that a defect yields a content-free `500` (inside `HttpApiTest` a handler defect surfaces as a defect of the client call, so the rendered response is not visible there); and plant a canary secret to confirm it reaches neither the response body nor the captured log output.

**Reach for it when** testing handlers, schema round-trips, error mapping, or middleware — fast, faithful, without standing up a server.

> **Tip:** Full arc: define endpoints with `HttpApiEndpoint`, bundle with `HttpApiGroup`, assemble with `HttpApi`; annotate HTTP facets with `HttpApiSchema` and errors with `HttpApiError`/`HttpApiSecurity`/`HttpApiMiddleware`; implement on the server with `HttpApiBuilder` and serve via `HttpRouter`; consume with the derived `HttpApiClient`; publish docs with `OpenApi` + `HttpApiSwagger`/`HttpApiScalar`; test in memory with `HttpApiTest`. One definition — every consumer in lockstep.
