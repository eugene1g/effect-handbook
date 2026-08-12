# HTTP Client

Effect 4 ships three stacked layers: a fully typed **HTTP client** (request as value, Schema-decoded response, built-in retries), a **low-level server** (router as Layer, middleware as function), and **HttpApi** — a schema-first API description that derives a server, a typed client, and OpenAPI/Swagger/Scalar docs from one definition, with the contract checked end-to-end at compile time.

Four cooperating modules: `HttpClient` is the service you acquire and decorate with policy; `HttpClientRequest` is an immutable request built with pipes; `HttpClientResponse` decodes a raw response through a Schema; `HttpClientError` is the tagged error family for transport/status/body failures. Composing a schema decoder also adds `SchemaError`. Idiomatic use: wrap the union in a domain service so callers never touch headers.

> **Official example:** Effect's release-matched [`ai-docs` HttpClient example](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/50_http-client) builds a typed client service.

## HttpClient

`effect/unstable/http/HttpClient` — unstable

A service (`HttpClient.HttpClient`) representing the ability to execute an HTTP request. Acquire from context, decorate with policy, execute requests. Decorators (`mapRequest`, `filterStatusOk`, `retryTransient`, `followRedirects`, `withRateLimiter`) return a *new* client with that behavior baked in — configure once, every call inherits it.

**Mental model.** Middleware-wrapped `fetch` in the Effect world. The base implementation comes from a Layer (`FetchHttpClient.layer`, `NodeHttpClient`, or `BunHttpClient`) — never constructed directly. Convenience methods `client.get`/`.post`/`.execute` return `Effect<HttpClientResponse, HttpClientError>`.

```ts
import { Context, Effect, flow, Layer, Schedule, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/unstable/http"

// The decoded shape we want callers to receive — an employee record from the HRIS.
class Employee extends Schema.Class<Employee>("Employee")({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String,
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  baseSalary: Schema.Finite
}) {}

// One wrapper error so callers see a single failure type, not the raw zoo.
class HrisError extends Schema.TaggedError<HrisError>()(
  "HrisError",
  { cause: Schema.Defect() }
) {}

class Hris extends Context.Service<Hris, {
  readonly allEmployees: Effect.Effect<ReadonlyArray<Employee>, HrisError>
  getEmployee(id: number): Effect.Effect<Employee, HrisError>
  recordRaise(raise: Omit<Employee, "id">): Effect.Effect<Employee, HrisError>
}>()("comp/Hris") {
  static readonly layer = Layer.effect(
    Hris,
    Effect.gen(function*() {
      // Acquire the base client and decorate it with policy, ONCE.
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(flow(
          HttpClientRequest.prependUrl("https://hris.acme.internal"),
          HttpClientRequest.acceptJson
        )),
        HttpClient.filterStatusOk, // fail unless the status is 2xx
        HttpClient.retryTransient({ // network/timeouts + 408/429/500/502/503/504
          schedule: Schedule.exponential(100),
          times: 3
        })
      )

      const allEmployees = client.get("/employees").pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(Employee))),
        Effect.mapError((cause) => new HrisError({ cause })),
        Effect.withSpan("Hris.allEmployees")
      )

      const getEmployee = Effect.fn("Hris.getEmployee")(function*(id: number) {
        yield* Effect.annotateCurrentSpan({ id })
        return yield* client.get(`/employees/${id}`, { urlParams: { format: "json" } }).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Employee)),
          Effect.mapError((cause) => new HrisError({ cause }))
        )
      })

      const recordRaise = Effect.fn("Hris.recordRaise")(function*(
        raise: Omit<Employee, "id">
      ) {
        return yield* HttpClientRequest.post("/raises").pipe(
          HttpClientRequest.bodyJsonUnsafe(raise),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Employee)),
          Effect.mapError((cause) => new HrisError({ cause }))
        )
      })

      return Hris.of({ allEmployees, getEmployee, recordRaise })
    })
  ).pipe(
    // Choose the implementation here. Swap to NodeHttpClient/BunHttpClient freely.
    Layer.provide(FetchHttpClient.layer)
  )
}
```

`HttpClient.get` (runs immediately) and `HttpClientRequest.get` (builds a value) are two paths to the same result — the request-value path gives more control. Every decorator is a pure transform, so you can derive multiple specialized clients from one base. Requests carry a span, so retries and timings appear in tracing automatically.

| Decorator | What it does |
| --- | --- |
| `mapRequest` / `mapRequestEffect` | Transform every outgoing request (prepend base URL, add auth, set headers). |
| `filterStatusOk` / `filterStatus` | Turn non-2xx (or a custom predicate) into a `StatusCodeError`. |
| `retry` / `retryTransient` | Retry on a `Schedule`; `retryTransient` covers transport/timeouts and 408, 429, 500, 502, 503, 504. |
| `followRedirects` | Chase 3xx responses up to a hop limit. |
| `withRateLimiter` | Throttle outgoing requests through a `RateLimiter` — handy to stay under API quotas. |
| `tap` / `tapRequest` / `tapError` | Observe requests/responses/errors without changing them. |
| `withCookiesRef` | Maintain a cookie jar across requests via a `Ref<Cookies>`. |

`withRateLimiter` can learn limits and reset delays from response headers and automatically retry HTTP 429 responses. Those 429 retries are **unlimited by default**: set `times` to a finite production budget, or `times: 0` to return/fail on the first 429. `responseHeaders` remaps non-standard limit/remaining/reset/retry header names. `disableResponseInspection` disables adaptive updates and header delays, but deliberately does *not* disable the 429 retry loop.

`followRedirects` defaults to at most ten hops and follows Fetch-style method changes: POST becomes GET for 301/302, and non-GET/HEAD becomes GET for 303. On a cross-origin redirect it strips `authorization`, `proxy-authorization`, and `cookie` before issuing the next request, preventing credentials from leaking to the new origin.

**Reach for it when** you call any HTTP service and want retries, decoding, tracing, and a clean domain API instead of raw `fetch`.

## FetchHttpClient

`effect/unstable/http/FetchHttpClient` — unstable

The `fetch`-backed `HttpClient` implementation. Provide `FetchHttpClient.layer` anywhere a client is needed. Works in browsers, serverless, Node 18+, and Bun. Swap the underlying `fetch` via `FetchHttpClient.Fetch` (tests or custom agent); set default `RequestInit` options via `FetchHttpClient.RequestInit`.

```ts
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

// Force credentials: "include" on every fetch by layering RequestInit —
// so the HRIS session cookie rides along on each call.
const ClientLayer = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }))
)
```

**Reach for it when** you want the portable, zero-dependency client — which is most of the time. Use `NodeHttpClient`/`BunHttpClient` only when you need native streaming or connection-pool control.

## HttpClientRequest

`effect/unstable/http/HttpClientRequest` — unstable

An immutable request description built with combinators. Start from a verb (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`) and pipe on URL pieces, query params, headers, auth, and a body. Nothing executes until a client runs it.

**Mental model.** A value, not an action — stash, clone, and pass around. Factor out reusable request fragments and apply them per-call or, via `HttpClient.mapRequest`, to a whole client.

```ts
import { Effect, Redacted } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

const program = Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient

  // Search the HRIS for employees in a given comp band.
  const request = HttpClientRequest.post("/employees/search").pipe(
    HttpClientRequest.prependUrl("https://hris.acme.internal"),
    HttpClientRequest.setUrlParams({ page: 1, limit: 20 }), // numbers are coerced
    HttpClientRequest.bearerToken(Redacted.make("hris-service-token")),
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyJsonUnsafe({ level: 5, departmentId: "ENG" })
  )

  return yield* client.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk)
  )
})
```

> **Tip:** **Body builders.** `bodyJsonUnsafe` (sync, throws on circular data) and `bodyJson` (effectful, safe) for JSON; `bodyText`, `bodyUint8Array`, `bodyUrlParams`, `bodyFormData`/`bodyFormDataRecord` for the rest; `bodyStream` for streaming uploads; `bodyFile` to send a file from disk. For type-checked request bodies, `schemaBodyJson(MySchema)` encodes through a Schema before sending.

Use `updateHeaders(f)` for a whole-map immutable transform and `removeHeader(name)` for one field. Replacing a request body also synchronizes its `content-type` and `content-length`: metadata supplied by the new body replaces stale values, and an empty or `FormData` body removes both so the platform can derive the right headers.

**Reach for it when** a request needs more than a URL, or when you want a reusable request transform.

## HttpClientResponse

`effect/unstable/http/HttpClientResponse` — unstable

Typed wrapper around a raw response, plus decoders. `schemaBodyJson(schema)` reads the body, parses JSON, and validates against a Schema in one effectful step. Transport/body-read/JSON failures are `HttpClientError`; a value that parses as JSON but violates the schema is `SchemaError`. `schemaJson` (decode status + headers + body together) has the same union. Also: `filterStatusOk`/`filterStatus`, `matchStatus` (branch on status code), and `stream` for incremental consumption.

**Mental model.** A response is `status`, `headers`, and an unread body. Decoders bridge to your domain type — decode failures become typed errors, so a malformed payload can't slip through as `any`.

```ts
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"

const Employee = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String
})

const getEmployee = (id: number) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(`/employees/${id}`)

    // Branch on the status code, decoding each case differently.
    return yield* HttpClientResponse.matchStatus(response, {
      200: HttpClientResponse.schemaBodyJson(Employee),
      404: () => Effect.succeed(null), // not on the HRIS roster
      orElse: (res) => Effect.fail(new HttpClientError.StatusCodeError({
        request: res.request,
        response: res,
        description: "Unexpected HRIS response"
      }))
    })
  })
```

**Reach for it when** you need decoded, validated data or status-aware branching from a response.

## HttpClientError

`effect/unstable/http/HttpClientError` — unstable

Tagged error family on the client's error channel. Each carries the request (and often the response) for context:

Key APIs: TransportError, EncodeError, InvalidUrlError, StatusCodeError, DecodeError, EmptyBodyError

```ts
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"

const safe = Effect.gen(function*() {
  // filterStatusOk transforms the CLIENT (adding HttpClientError to its channel),
  // so apply it to the client, then make the request.
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
  return yield* client.get("https://hris.acme.internal/employees/42")
}).pipe(
  // v4 wraps failures in a single HttpClientError; discriminate on reason._tag.
  Effect.catchTag("HttpClientError", (e) =>
    e.reason._tag === "StatusCodeError"
      ? Effect.logWarning(`HRIS HTTP ${e.reason.response.status}`)
      : Effect.logError("HRIS unreachable", e))
)
```

`HttpClient.retryTransient` covers transport/timeouts plus statuses 408, 429, 500, 502, 503, and 504 — these are rarely caught by hand solely to implement retry.

**Reach for it when** you need to distinguish network failures, 404s, and Schema mismatches and handle each differently.
