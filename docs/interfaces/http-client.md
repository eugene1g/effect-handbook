# HTTP Client

Effect 4 ships three stacked layers: a fully typed **HTTP client** (request as value, Schema-decoded response, built-in retries), a **low-level server** (router as Layer, middleware as function), and **HttpApi** — a schema-first API description that derives a server, a typed client, and OpenAPI/Swagger/Scalar docs from one definition, with the contract checked end-to-end at compile time.

Four cooperating modules: `HttpClient` is the service you acquire and decorate with policy; `HttpClientRequest` is an immutable request built with pipes; `HttpClientResponse` decodes a raw response through a Schema; `HttpClientError` is the tagged error family for transport/status/body failures. Composing a schema decoder also adds `SchemaError`. Idiomatic use: wrap the union in a domain service so callers never touch headers.

> **Official example:** Effect's release-matched [`ai-docs` HttpClient example](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.115/ai-docs/src/50_http-client) builds a typed client service.

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
| `catch` / `catchTag` / `catchTags` | Recover *inside the client*, so the handler must produce another `HttpClientResponse` (since `rc.113` both overloads of `catch` enforce this). To recover to any other value, use `Effect.catch` on the result of `client.execute(request)`. |
| `transformResponse` | Wrap every response Effect — the hook for a client-wide `Effect.timeout`. |
| `withCookiesRef` | Maintain a cookie jar across requests via a `Ref<Cookies>`. |

`withRateLimiter` can learn limits and reset delays from response headers and automatically retry HTTP 429 responses. Those 429 retries are **unlimited by default**: set `times` to a finite production budget, or `times: 0` to return/fail on the first 429. `responseHeaders` remaps non-standard limit/remaining/reset/retry header names. `disableResponseInspection` disables adaptive updates and header delays, but deliberately does *not* disable the 429 retry loop.

`followRedirects` defaults to at most ten hops and follows Fetch-style method changes: POST becomes GET for 301/302, and non-GET/HEAD becomes GET for 303. On a cross-origin redirect it strips `authorization`, `proxy-authorization`, and `cookie` before issuing the next request, preventing credentials from leaking to the new origin. When the hop limit is reached it returns the last `3xx` response rather than failing, and since `rc.113` a failure in request preprocessing (a failing `mapRequestEffect`) no longer bypasses response-level recovery such as `HttpClient.catch` when redirects are enabled.

> **Warning:** **With `FetchHttpClient` the platform `fetch` follows redirects before Effect ever sees them** (probed on Node 26: a `302` arrives as the final `200`, and `response.url` reports the final URL). `HttpClient.followRedirects` — and any per-hop validation you hang on it — only takes over when the underlying fetch is told not to: provide `FetchHttpClient.RequestInit` with `{ redirect: "manual" }`. In a browser a manual redirect is an opaque response, so hop-by-hop control is a server-side technique.

### Retries, time budgets, and cancellation

- **Every call gets a finite budget.** No decorator adds a timeout for you. `HttpClient.transformResponse(Effect.timeout("10 seconds"))` bounds each attempt when placed *before* a retry decorator and the whole call when placed *after* it.
- **Interruption cancels the request, not just the wait.** The client hands the platform an `AbortSignal` and aborts it when the calling fiber is interrupted — by a timeout, a lost race, or a closed scope (probed: the remote server observes the disconnect). Wrapping a non-Effect SDK yourself? Forward the signal `Effect.tryPromise` gives you; see the [request-cancellation recipe](../recipes/request-cancellation-through-a-host).
- **`retryTransient` does not look at the method.** It replays a `POST` as readily as a `GET`. After a timeout or a dropped connection the first attempt may already have been applied, so retry only requests that are replay-safe: reads, or mutations protected by an idempotency key the *server* honors. Derive two clients from one base instead of retrying everything.
- **Retry budgets are finite** (`times`, or a bounded `Schedule`), and `withRateLimiter`'s 429 loop needs its own `times` as noted above.

```ts
import { Effect, flow, Schedule } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

export const makeHrisClients = Effect.gen(function*() {
  const base = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(flow(
      HttpClientRequest.prependUrl("https://hris.acme.internal"),
      HttpClientRequest.acceptJson
    )),
    HttpClient.transformResponse(Effect.timeout("5 seconds")), // per attempt
    HttpClient.filterStatusOk
  )

  // Reads are replay-safe: retry transient faults inside a total budget.
  const reads = base.pipe(
    HttpClient.retryTransient({ schedule: Schedule.exponential("100 millis"), times: 3 }),
    HttpClient.transformResponse(Effect.timeout("20 seconds")) // whole call
  )

  // Writes are sent once unless the caller supplies the key the HRIS deduplicates on.
  const writeOnce = base
  const idempotentWrite = (idempotencyKey: string) =>
    base.pipe(
      HttpClient.mapRequest(HttpClientRequest.setHeader("idempotency-key", idempotencyKey)),
      HttpClient.retryTransient({ schedule: Schedule.exponential("200 millis"), times: 2 })
    )

  return { reads, writeOnce, idempotentWrite } as const
})
```

### User-controlled destinations

A URL that comes from a user — a webhook target, an "import payroll file from URL" field, an avatar link — turns your server into a proxy for whoever typed it (server-side request forgery). Treat the destination as untrusted input:

- **Allow-list scheme and port** (`https:` only, `443` or a short list) after parsing with `Url.fromString`; reject userinfo (`user:pass@host`).
- **Resolve the host and reject non-public addresses**: loopback, private ranges, link-local (which includes the `169.254.169.254` cloud metadata endpoint), unique-local IPv6, IPv4-mapped IPv6, multicast, and the unspecified address. `effect/unstable/net` has the predicates.
- **Re-validate at every hop.** A public URL can redirect to an internal one, so disable platform redirects (`redirect: "manual"`, see the warning above) and run the same check on each `location` — or do not follow redirects at all. Re-check after DNS resolution too: connect to the address you vetted, or a second lookup can answer differently.
- **Bound everything else**: a short timeout, a response-size cap, no credentials or internal headers on the outgoing request, and a response the caller cannot read verbatim if they should not learn what an internal address answers.

```ts
import { Effect, Schema } from "effect"
import { NetAddress } from "effect/unstable/net"

export class ForbiddenDestination extends Schema.TaggedError<ForbiddenDestination>()(
  "ForbiddenDestination",
  { reason: Schema.String }
) {}

const isPublicAddress = (ip: NetAddress.IpAddress): boolean =>
  !NetAddress.isUnspecified(ip) &&
  !NetAddress.isLoopback(ip) &&
  !NetAddress.isLinkLocal(ip) && // 169.254.0.0/16 (cloud metadata) and fe80::/10
  !NetAddress.isMulticast(ip) &&
  (NetAddress.isIpv4Address(ip)
    ? !NetAddress.isPrivate(ip) // 10/8, 172.16/12, 192.168/16
    : !NetAddress.isUniqueLocal(ip) && !NetAddress.isIpv4Mapped(ip))

// `resolvedAddresses` comes from your resolver capability (for example `dns.lookup(host, { all: true })`).
export const assertPublicDestination = Effect.fn("assertPublicDestination")(function*(
  url: URL,
  resolvedAddresses: ReadonlyArray<string>
) {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return yield* new ForbiddenDestination({ reason: "scheme or credentials not allowed" })
  }
  if (resolvedAddresses.length === 0) {
    return yield* new ForbiddenDestination({ reason: "host did not resolve" })
  }
  for (const text of resolvedAddresses) {
    const ip = yield* Effect.fromResult(NetAddress.ipFromString(text)).pipe(
      Effect.mapError(() => new ForbiddenDestination({ reason: "unparseable address" }))
    )
    if (!isPublicAddress(ip)) {
      return yield* new ForbiddenDestination({ reason: "non-public address" })
    }
  }
  return url
})
```

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

Per-request `method`, `headers`, `body`, and the abort `signal` always come from the client and override the same fields in `RequestInit`; everything else (`credentials`, `cache`, `redirect`, `integrity`) is yours to set. A `bodyStream` request is sent as a Web `ReadableStream` with `duplex: "half"` — raw Web stream bodies too since `rc.113` — and any `content-length` header is dropped, because `fetch` computes framing itself. CORS, cookie, redirect, and streaming-upload behavior is the runtime's, not Effect's, so test uploads on the host you deploy to.

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

`response.url` (`rc.113`) is the resolved request URL including query parameters and excluding the hash; after redirects it is the *final* URL, and it is an empty string when the platform cannot tell. Log it, or compare its origin with the one you asked for, when redirects are allowed.

Every decoder takes parse options as a second argument — `schemaBodyJson(schema, options)`, and since `rc.113` `schemaJson` and `schemaNoBody` honor them too — so `{ onExcessProperty: "error" }` makes an unexpected upstream field a `SchemaError` instead of a silent drop, and `{ errors: "all" }` reports every issue. The JSON decoders also accept `reviver` (`rc.110`), passed to `JSON.parse`, for upstreams that need one (for example, reading large integers from the source text).

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

### Three failure classes

Keep them distinct all the way to the wrapper error; each one calls for a different response.

| Class | Appears as | What it means | Policy |
| --- | --- | --- | --- |
| Transport | `HttpClientError` with `reason._tag` `"TransportError"` (also `"InvalidUrlError"`, `"EncodeError"` before anything is sent) | no usable response: DNS, connect, reset, abort | retry if the request is replay-safe; otherwise surface "outcome unknown" |
| Status | `reason._tag === "StatusCodeError"` — only when a `filterStatus*` decorator is applied | the peer answered, and said no | branch on `reason.response.status`; most `4xx` are permanent, `408`/`429`/`5xx` may be transient |
| Decode | `reason._tag` `"DecodeError"` / `"EmptyBodyError"` (the body could not be read or parsed), or a separate `SchemaError` (it parsed but has the wrong shape) | contract drift or a wrong assumption | never retry; alert, and keep the issue path out of user-facing text |

**Check the status before decoding the success schema.** Without `filterStatusOk`, a `404` whose body is `{ "error": "not found" }` is fed to `schemaBodyJson(Employee)` and reported as a *schema* failure — the one class that looks like your bug instead of the peer's answer. Filter first (on the client, or with `HttpClientResponse.filterStatusOk` per response), or branch with `matchStatus` and give each status its own decoder. When you do read an error body, bound it and decode it with its own schema; never echo an upstream error payload to your caller.

**Reach for it when** you need to distinguish network failures, 404s, and Schema mismatches and handle each differently.
