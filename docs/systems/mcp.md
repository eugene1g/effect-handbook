# MCP Servers

`effect/ai` ships a Model Context Protocol implementation: the wire schemas, the protocol adapters for every supported MCP revision, `McpServer`, which exposes your Effect services as tools, resources, and prompts over stdio or streamable HTTP, an experimental `McpClient` for calling other MCP servers, and `McpTest` for testing a server in memory. Tools reuse the same `Tool` and `Toolkit` definitions as [AI & Language Models](ai-language-models). For an end-to-end walkthrough, read the [MCP deep dive](../deep-dives/exposing-an-effect-application-over-mcp).

## McpSchema

`effect/ai/McpSchema` — unstable

The complete Model Context Protocol (MCP) wire format as Effect `Schema`s and `Rpc` definitions: requests/results, resources and resource templates, prompts, completions, capabilities, and JSON-RPC error codes. The typed contract `McpServer` is built on.

Commonly used helpers: `McpSchema.param(name, schema)` declares typed parameters inside resource URI templates; `Role`, `Annotations`, and error types are also referenced directly. The heavier protocol machinery (Initialize, ListResources, CallTool, notifications) is consumed by the server runtime and by `McpClient`.

JSON-valued fields — `_meta`, `structuredContent`, capability records, and similar — are checked only one level deep when decoding and are typed as `unknown` or `Readonly<Record<string, unknown>>`, so narrow them before use. `McpServer` still rejects a tool result that is not JSON when it serializes a `2026-07-28` response. JSON-RPC errors on the wire carry only `code`, `message`, and optional `data`.

```ts
import { Schema } from "effect"
import { McpSchema } from "effect/ai"

// A typed URI-template parameter — e.g. the employee id in an HRIS resource.
const employeeIdParam = McpSchema.param("employeeId", Schema.String)

// Error codes and typed errors are provided too, e.g. for custom handlers.
McpSchema.INVALID_PARAMS_ERROR_CODE // -32602
```

**Reach for it when** building or extending an MCP server and needing the protocol's typed building blocks — especially `param` for resource/prompt templates.

## McpProtocol

`effect/ai/McpProtocol` — unstable

The versioned protocol adapter registry used by `McpServer`. It ships five adapters — `McpProtocol.v2024_11_05`, `v2025_03_26`, `v2025_06_18`, `v2025_11_25`, and `v2026_07_28` — each binding the matching client/server RPC groups and transport rules. The `2025-11-25` adapter adds sampling with tools, form- and URL-based elicitation (including identified object schemas), and `McpSchema.Icon` metadata (source URI, MIME type, sizes, light/dark theme) for server info, resources, resource templates, prompts, and tools. Server transports require a non-empty `protocols` list so negotiation is explicit rather than silently assuming whichever MCP revision a client sends.

**`2026-07-28` is stateless.** It drops `initialize` and protocol-level sessions: each request carries its own protocol version and client metadata, a client can call `server/discover` to read the server's identity, capabilities, and instructions, and change notifications are delivered through `subscriptions/listen` when the transport can push. It works over both stdio and Streamable HTTP, and it can share a `protocols` list with the session-based revisions, so one server can serve old and new clients; a server accepts at most one stateless revision. Adapters now describe their transport rules through a `runtime` descriptor (`McpProtocol.StatefulRuntimeDescriptor` / `StatelessRuntimeDescriptor`) instead of the former `transport` field, which matters only if you wrote your own adapter.

```ts
import { McpProtocol, McpServer } from "effect/ai"

// Session-based clients negotiate 2025-11-25; stateless clients use 2026-07-28.
const StdioMcp = McpServer.layerStdio({
  name: "Comp Server",
  version: "1.0.0",
  protocols: [McpProtocol.v2025_11_25, McpProtocol.v2026_07_28]
})
```

The 2025-06-18 adapter rejects JSON-RPC batches on its transport. The `MCP-Protocol-Version` header is validated only on requests **after** initialization: an `initialize` request negotiates from the version offered in its body and reports the selected version in the response, so a fresh client whose default header is not registered is no longer rejected with `400` before negotiation can happen. List every adapter you intentionally support; initialization selects the requested version and the server uses the first adapter as its fallback/default. A stdio server answers a `ping` sent before `initialize` with an empty result rather than rejecting it, even when a stateless protocol such as `2026-07-28` is listed first among several `protocols`.

Streamable HTTP is strict at the boundary. If a request carries `Origin`, `layerHttp` returns 403 unless that exact origin appears in `allowedOrigins`. POST requires `Content-Type: application/json` (otherwise 415) and an `Accept` header that includes both `application/json` and `text/event-stream` with positive quality (otherwise 406).

**Reach for it when** constructing an MCP transport or deciding which protocol revisions a server is willing to negotiate.

## McpServer

`effect/ai/McpServer` — unstable

A batteries-included framework for building MCP servers — the protocol that lets editors and AI clients (Claude Desktop, IDEs) discover tools, resources, and prompts. Handles JSON-RPC plumbing; capabilities are registered as Layers and a transport is chosen.

`McpServer.toolkit(toolkit)` exposes a `Toolkit` as MCP tools; `McpServer.resource\`uri/${param}\`({...})` exposes resources/templates (with auto-completion); `McpServer.prompt({...})` exposes parameterized prompts, with an optional human-readable `title` beside the `name` (also accepted by `registerPrompt`). Each of these is a registration Layer that requires the `McpServer` service. Merge them and pass them to the transport as its `registrations` option, so they are registered before the server reads its first request. Transports: `layerStdio` (desktop clients), `layerHttp` (mount on an `HttpRouter`; pass `allowSessionTermination: true` to enable DELETE on the session path, which ends the session and interrupts its active requests — later requests on that session id return `404`), and `layer` over a caller-provided `RpcServer.Protocol`. Every server constructor (`layer`, `layerStdio`, `layerHttp`, `run`) accepts an optional `instructions` string, returned in the initialization and discovery responses to tell a client how to use the server. Launch with `Layer.launch` + `NodeRuntime.runMain`.

> **Migration:** In 4.0 the transport was provided to the registrations (`Registrations.pipe(Layer.provide(McpServer.layerStdio({ ... })))`). Pass them as `registrations` instead. Services that tool, resource, and prompt handlers read are now request-level, and only `layerHttp` / `layerHttpRequestScoped` called with `registrations` turn them into `HttpRouter` requirements; see [Request-level dependencies](#request-level-dependencies-middleware-and-visibility).

```ts
import { Effect, Layer, Logger, Schema } from "effect"
import { NodeRuntime, NodeStdio } from "@effect/platform-node"
import { McpProtocol, McpSchema, McpServer } from "effect/ai"

const employeeIdParam = McpSchema.param("employeeId", Schema.String)

// A resource template: hris://employee/<employeeId>, with id completion.
const EmployeeCard = McpServer.resource`hris://employee/${employeeIdParam}`({
  name: "Employee Card",
  completion: { employeeId: (_) => Effect.succeed(["emp-4821", "emp-5099"]) },
  content: Effect.fn(function*(_uri, employeeId) {
    return `Employee ${employeeId}: level 4, base 185000, rating "exceeds"`
  })
})

// A parameterized prompt the client can invoke.
const RaisePrompt = McpServer.prompt({
  name: "RaiseRationale",
  title: "Raise rationale",
  description: "Draft a within-band raise rationale for an employee",
  parameters: { employeeId: Schema.String },
  completion: { employeeId: () => Effect.succeed(["emp-4821", "emp-5099"]) },
  content: ({ employeeId }) =>
    Effect.succeed(`Write a merit-increase rationale for ${employeeId}, staying within band.`)
})

// Pass the merged registrations to the stdio server, and launch.
const ServerLayer = McpServer.layerStdio({
  name: "Comp Server",
  version: "1.0.0",
  instructions: "Read employee cards before drafting; never propose an out-of-band raise.",
  protocols: [McpProtocol.v2025_06_18],
  registrations: Layer.mergeAll(EmployeeCard, RaisePrompt)
}).pipe(
  Layer.provide(NodeStdio.layer),
  Layer.provide(Layer.succeed(Logger.LogToStderr)(true))
)

Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
```

> **Tip:** Define a `Toolkit` once — say your `CompToolkit` with `LookupCompBand` — and you can both call it from a `LanguageModel` *and* expose it to external clients via `McpServer.toolkit(CompToolkit)`. Same handlers, two surfaces.

**What an MCP client sees from a toolkit tool.**

| Handler outcome | Wire result | Logged and reported to `ErrorReporter` |
| --- | --- | --- |
| Success | `isError: false`; the encoded result as JSON text, plus `structuredContent` **only when it is a JSON object** (never `null` or an array, which MCP forbids there) | no |
| Arguments fail the parameter schema (a `Tool.Strict` tool also rejects undeclared properties) | Protocols `2024-11-05`, `2025-03-26`, `2025-06-18`: a JSON-RPC `InvalidParams` error listing every missing or invalid field, and every unknown key for a strict tool, in one response. Protocols `2025-11-25` and `2026-07-28`: an `isError: true` result carrying that same combined validation message, so the calling model can correct itself | no |
| Declared `failure`, `failureMode: "error"`, value is an `Error` instance | `isError: true` with that error's `message` — an empty message falls back to the failure's encoded value, so a bare tagged error is still legible | no |
| Declared `failure`, `failureMode: "error"`, any other value | `isError: true` with the failure encoded through its schema as JSON text | no |
| Declared `failure`, `failureMode: "return"` | `isError: true` with the encoded failure payload as JSON text | no |
| An undeclared failure or `AiError`, a defect, or a result that fails its `success` schema or cannot be serialized | Protocols `2025-11-25` and `2026-07-28`: `isError: true` with a fixed internal-error message. Earlier protocols: a JSON-RPC `-32603 Internal error` (not `-32602 Invalid params`). Either way, details never reach the client | yes |

A failed call never carries `structuredContent`. Declared failures are part of the tool's contract, so the server sends them to the client and does not log or report them; everything else is logged at error level and handed to the configured `ErrorReporter`s, so provide one when you need alerting on tool faults (see [Observability](../operations/observability)). Both failure modes produce `isError: true`: choose `"error"` when the client should read a short message, and `"return"` when it should receive the structured failure payload. Either way the declared failure is visible to the client, so keep secrets and internal detail out of it.

Tool input schemas follow `Tool.Strict`: a strict tool advertises `additionalProperties: false` and the server rejects extra arguments, while a non-strict tool advertises `additionalProperties: true` and ignores them. A top-level `$ref` in a parameter schema is inlined, and an identified `success` output schema is likewise normalized to an object root, because MCP requires an object at the root. Calling `McpServer.toolkit` with a tool whose parameter schema is not an object schema fails fast with a clear, named error instead of a dispatch-time failure. In a protocol that omits string `structuredContent`, a result whose single text block is already the exact JSON encoding of that string is returned as plain text rather than duplicated.

- **Server identity can carry icons.** `layer`, `layerStdio`, `layerHttp`, and `run` accept `icons: ReadonlyArray<McpSchema.Icon>` (`src`, optional `mimeType`, `sizes`, `theme`). The `McpSchema.Resource`, `ResourceTemplate`, `Prompt`, and `Tool` schemas have the same optional field for entries registered through the lower-level `McpServer` registry service.
- **Prompt and resource callbacks receive decoded values.** `McpServer.prompt` / `registerPrompt` pass `content` the *decoded* type of each `parameters` schema, and resource templates resolve over both stdio and Streamable HTTP.
- **A non-recursive tool schema root is sent once.** `tools/list` inlines it without also publishing it under `$defs`, so a custom `toJsonSchema` `$ref` into the root's own definition (such as `#/$defs/Note/properties/title` when `Note` is the tool schema) no longer resolves; point such references at the inline schema instead.
- **Effect RPC control messages are off.** MCP servers use the JSON-RPC serialization with `controlMessages: false`, so `@effect/rpc/*` notifications from an MCP client neither stop a stdio server nor make it write `@effect/rpc/Pong` to stdout.
- **Tool annotation titles survive `tools/list`.** On the `2025-06-18` and `2025-11-25` protocol revisions, a tool's annotation `title` is reported in `tools/list` responses alongside its top-level `title` and behavioral hints.
- **Server `extensions` are advertised, not implemented.** `layer`, `layerStdio`, `layerHttp`, and `run` accept `extensions`, a record keyed `vendor/name` with JSON settings, reported in the server capabilities of `initialize` and `server/discover`. `2026-07-28` discovery lists only object-valued settings. Behavior behind an extension is your code; Effect ships no extension helpers.
- **Stateful clients only hear about changes after they initialize.** List-change notifications for registrations made before a session client's `initialize` was handled are not sent to it, over stdio, HTTP sessions, and custom transports.
- **Cache hints for stateless clients.** `layer`, `layerStdio`, `layerHttp`, and `layerHttpRequestScoped` accept `cacheHints`, which set how long `2026-07-28` clients may treat discovery and list results as fresh: `cacheHints: { tools: { ttl: "1 minute", cacheScope: "private" } }`. The keys are `discover`, `tools`, `resources`, `resourceTemplates`, and `prompts`; omitted keys and every `resources/read` result keep `{ ttlMs: 0, cacheScope: "private" }`, and earlier revisions ignore the option. `ttl` is any `Duration.Input`, sent as whole milliseconds rounded down; a non-finite or negative `ttl`, or a scope other than `"private"`, fails the Layer with `IllegalArgumentError`. These are hints only — the server caches nothing and still applies visibility and per-call checks — but a positive `ttl` lets a client keep showing a list after registrations or per-request visibility change, and a client shared between users can reuse one user's list for another.

### Request-scoped HTTP and typed requirements

Use `McpServer.layerHttpRequestScoped` on serverless hosts where execution must belong to an HTTP request. Each POST owns its server fibers, timers, and queue consumers until its response body completes. It accepts only stateless adapters such as `McpProtocol.v2026_07_28`; an untyped session-era adapter fails Layer construction with `IllegalArgumentError`. Tools, resources, prompts, completions, `InputRequired` round trips, and the request's own progress/log notifications work. Sessions, legacy reverse requests (`elicit`), broadcast list changes, subscriptions, and DELETE session termination do not: discovery reports `listChanged: false`, `subscriptions/listen` is method-not-found, and DELETE returns `405`. The same origin and media-type admission rules as `layerHttp` apply. This is an execution-lifetime boundary, not an authorization or request-size limit.

Keep `layerHttp` for long-lived hosts with session-era clients or subscriptions. It shares one scoped server across POSTs; `allowSubscriptions: false` disables stateless subscriptions without disabling request-local progress/logs or legacy protocols. Request-scoped configuration intentionally has neither `allowSubscriptions` nor `allowSessionTermination`.

```ts
import { McpProtocol, McpServer } from "effect/ai"

export const RequestScopedMcp = McpServer.layerHttpRequestScoped({
  name: "Comp Server",
  version: "1.0.0",
  path: "/mcp",
  protocols: [McpProtocol.v2026_07_28]
})
```

Resource templates require their parameter schemas' **decoding services**, plus the encoding services of parameters that have a completion handler, when they are registered; prompts likewise require parameter decoding services and the encoding services of completed parameters. Provide those schema services when composing the registration Layer. A schema that transforms using a service does not become service-free merely because it is embedded in a URI template or prompt. Services that the `content` and completion handlers themselves read are request-level instead (next section).

### Request-level dependencies, middleware, and visibility

Some services exist only per request — above all, the caller. Every service a handler reads is a **request-level dependency**: a tool declares it with `dependencies` (or `Tool.addDependency`), and resource, prompt, and completion handlers declare it simply by reading it. The registration Layer carries it as an `McpServer.McpRequest<"Requires", S>` requirement, and only MCP middleware or the transport can discharge that marker. `Layer.provide(Layer.succeed(S, value))` does not, so a construction-time value can never stand in for the per-request one by accident; an undischarged marker is a compile error. Parameter-decoding and result-encoding services stay ordinary registration-time requirements.

- **The transport discharges what it supplies** (`McpServer.ProvidedServices`): every transport supplies `Scope`, the HTTP transports supply `HttpServerRequest`, and `McpServerClient` is supplied only when every adapter in a literal `protocols` tuple is session-based. Mixing in `v2026_07_28`, or widening the tuple to `ProtocolAdapter[]`, leaves `McpServerClient` for middleware to provide.
- **`layerHttp` and `layerHttpRequestScoped` turn every other marker into an `HttpRouter.Request` requirement**, so an `HttpRouter.middleware<{ provides: Principal }>` provided to the transport Layer satisfies a tool that declares `dependencies: [Principal]` — and its own `401` responses keep working. On stdio and custom transports, use MCP middleware.
- **`McpServer.middleware<{ provides: S }>()(fn)`** creates MCP middleware: `fn(effect, { method, target, payload, requestContext, headers, sessionId })` wraps each `tools/call`, `resources/read`, `prompts/get`, and `completion/complete`, and provides `S` with `Effect.provideService`. `headers` are empty on stdio, custom transports, and in-process calls. Provide `mw.layer` to the registrations it should wrap, or use `mw.layerGlobal` (or `{ global: true }`) for every request on the server; global middleware runs outside local middleware, and middleware provided both ways runs once. A middleware that itself needs `S` per request gets it from one combined outside it: `a.combine(b)` runs `b` outside `a`. A low-level `McpServer.McpServer.addTool` registration only sees local middleware when it passes `services`, so wrap such tools with global middleware.
- **Middleware failures are protocol errors.** Fail with an `McpSchema.McpErrorBase` value — a `Schema.Error` spreading `McpErrorBase.fields`, typically with a code from `-32000` to `-32019` — and the client receives a JSON-RPC error with that `code`, `message`, and `data`, never a tool result. Any numeric code is sent as is, so pick custom codes from the implementation-defined range. Defects are logged, reported to the `ErrorReporter`, and sent as `InternalError`. Middleware never runs for `initialize`.
- **Request services win.** A service a registration captured with `Layer.provide` is only a default that the request's own context overrides, on every transport. To read construction-time services in a resource or prompt, read them in `Layer.unwrap` and close over them.
- **`McpServer.visibility(check)`** is middleware whose check returns a boolean per request: a hidden registration is left out of list results, and calling, reading, getting, or completing it fails exactly as if it were not registered. On list requests the middleware outside the innermost visibility runs once per registration, with an `undefined` `payload`, and a failing check fails the whole list rather than hiding anything. No `list_changed` notification is sent when visibility changes. Unlike `EnabledWhen`, visibility runs your middleware and so can depend on the authenticated caller.

```ts
import { Context, Effect, Layer, Schema } from "effect"
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"

class CurrentUser extends Context.Service<CurrentUser, {
  readonly id: string
  readonly isAdmin: boolean
}>()("acme/CurrentUser") {}

class Unauthorized extends Schema.Error<Unauthorized>("Unauthorized")({
  ...McpSchema.McpErrorBase.fields,
  _tag: Schema.tag("Unauthorized"),
  code: Schema.tag(-32001)
}) {}

declare const verify: (token: string) => Effect.Effect<CurrentUser["Service"], Unauthorized>

// Runs around every call, read, get, and completion of the registrations it is provided to.
const Auth = McpServer.middleware<{ provides: CurrentUser }>()((effect, { headers }) => {
  const token = headers["authorization"]
  return token === undefined
    ? Effect.fail(new Unauthorized({ message: "Missing credentials" }))
    : Effect.flatMap(verify(token), (user) => Effect.provideService(effect, CurrentUser, user))
})
const AdminOnly = McpServer.visibility(() => Effect.map(CurrentUser, (user) => user.isAdmin))

const ReadTools = Toolkit.make(
  Tool.make("comp_whoami", { success: Schema.String, dependencies: [CurrentUser] })
)
const AdminTools = Toolkit.make(
  Tool.make("comp_reset_cycle", { success: Schema.String, dependencies: [CurrentUser] })
)

export const Registrations = Layer.mergeAll(
  McpServer.toolkit(ReadTools).pipe(
    Layer.provide(Auth.layer),
    Layer.provide(ReadTools.toLayer({ comp_whoami: () => Effect.map(CurrentUser, (user) => user.id) }))
  ),
  McpServer.toolkit(AdminTools).pipe(
    // `Auth` runs outside the check, so the check can read CurrentUser.
    Layer.provide(AdminOnly.combine(Auth).layer),
    Layer.provide(AdminTools.toLayer({ comp_reset_cycle: () => Effect.succeed("reset") }))
  )
)
```

### Request context, client gating, and human input

- **`McpSchema.McpRequestContext`** is provided to every tool handler, resource `content`, and prompt `content`: `clientId`, `protocolVersion`, `clientCapabilities`, optional `clientInfo` and `requestMetadata`, and, on a continued `2026-07-28` call, `inputResponses` and `requestState`. Read it with `yield* McpSchema.McpRequestContext` or `McpSchema.McpRequestContext.useSync(f)`; `McpServer.clientCapabilities` reads just the capabilities. A toolkit tool declares it with `dependencies: [McpSchema.McpRequestContext]`, and `McpServer.toolkit` leaves it out of the Layer's requirements because each call supplies it. Everything in it is self-reported by the client.
- **`McpSchema.McpServerClient`** exists only for initialized session-era clients. It is what server-to-client requests need; `2026-07-28` requests never have it.
- **`McpSchema.EnabledWhen`** is an annotation holding a predicate over `{ protocolVersion, capabilities, clientInfo }`: `.annotate(McpSchema.EnabledWhen, predicate)` on a `Tool`, or `annotations: Context.make(McpSchema.EnabledWhen, predicate)` on `addTool`, `prompt`, and `registerResource`. A false predicate removes the entry from that client's list, and a direct call fails as not found. It trims the catalog per client; it does not authorize.
- **`McpServer.elicit({ message, schema })`** returns `Effect<S["Type"], McpSchema.ElicitationDeclined, McpServerClient | S["DecodingServices"]>`. It sends a form-mode `elicitation/create` built from `schema` to the current session client, then decodes the accepted content with `schema`. A decline fails with `ElicitationDeclined`, and so does a client or revision without form elicitation (the reason is in `cause`); a cancel interrupts the handler. Session eras only, so hide the tool from `2026-07-28` clients. A tool that declares `McpServerClient` compiles into a server only when the transport's literal `protocols` are all session-based, because only then does the transport supply it; with a stateless adapter in the list, read the client with `Effect.serviceOption(McpSchema.McpServerClient)` instead, as the [deep dive's dual-era gate](../deep-dives/exposing-an-effect-application-over-mcp#one-gate-for-both-eras) does:

```ts
import { Effect, Schema } from "effect"
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"

declare const applyBandTable: (tableId: string) => Effect.Effect<void>
const Confirm = Schema.Struct({ confirm: Schema.Boolean })

const ApplyBandTable = Tool.make("comp_apply_band_table", {
  parameters: Schema.Struct({ tableId: Schema.String }),
  success: Schema.Struct({ applied: Schema.Boolean }),
  dependencies: [McpSchema.McpServerClient] // supplied per call to session clients
}).annotate(McpSchema.EnabledWhen, (client) => client.protocolVersion !== "2026-07-28")

const BandToolkit = Toolkit.make(ApplyBandTable)
export const BandHandlers = BandToolkit.toLayer({
  comp_apply_band_table: Effect.fn("comp_apply_band_table")(function*({ tableId }) {
    const message = `Apply band table ${tableId} to every open cycle?`
    const { confirm } = yield* McpServer.elicit({ message, schema: Confirm }).pipe(
      Effect.catchTag("ElicitationDeclined", () => Effect.succeed({ confirm: false }))
    )
    if (confirm) yield* applyBandTable(tableId)
    return { applied: confirm }
  })
})
```

- **`McpServer.McpServer.addTool` and `McpSchema.InputRequired`** are the stateless way to ask for input. A toolkit handler must return the tool's success type, so a tool that pauses for input is registered on the `McpServer.McpServer` service with a hand-written `McpSchema.Tool` descriptor (`inputSchema` must have an object root). Its `handle(payload)` receives the raw arguments and returns `CallToolResult | InputRequired`, failing only with `McpSchema.InternalError | McpSchema.InvalidParams` and requiring only `McpRequestContext`. `new McpSchema.InputRequired({ inputRequests, requestState })` needs at least one of the two; each keyed request is `elicitation/create`, `sampling/createMessage`, or `roots/list`. The client calls again with the same arguments, the answers in `inputResponses` under your keys, and `requestState` echoed unchanged. A missing client capability fails the call with protocol error `-32021` and `data.requiredCapabilities`; a session-era client that receives `InputRequired` gets a protocol error; `InvalidParams` on a continued call becomes JSON-RPC `-32602`. `requestState` returns from the client, so seal it (HMAC, expiry, caller binding) before trusting it.

```ts
import { Context, Effect, Layer, Schema } from "effect"
import { McpSchema, McpServer } from "effect/ai"

declare const lockCycle: Effect.Effect<void>
const requestedSchema = { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] }
const isConfirmed = Schema.is(Schema.Struct({
  action: Schema.Literal("accept"),
  content: Schema.Struct({ confirm: Schema.Literal(true) })
}))
const text = (text: string) => new McpSchema.CallToolResult({ content: [{ type: "text", text }] })

export const LockCycle = Layer.effectDiscard(McpServer.McpServer.use((server) =>
  server.addTool({
    tool: new McpSchema.Tool({ name: "comp_lock_cycle", inputSchema: { type: "object" } }),
    annotations: Context.make(McpSchema.EnabledWhen, (client) => client.protocolVersion === "2026-07-28"),
    handle: () =>
      Effect.gen(function*() {
        const answer = (yield* McpSchema.McpRequestContext).inputResponses?.["confirm"]
        if (answer === undefined) {
          const message = "Lock FY27-merit? Managers can no longer edit proposals."
          return new McpSchema.InputRequired({
            inputRequests: { confirm: { method: "elicitation/create", params: { mode: "form", message, requestedSchema } } }
          })
        }
        if (!isConfirmed(answer)) return text("Not locked.")
        yield* lockCycle
        return text("Locked.")
      })
  })
))
```

- **Authenticate by wrapping the HTTP layer.** `layerHttp` does not authenticate. Provide typed route middleware to it — `McpServer.layerHttp({ ..., registrations }).pipe(Layer.provide(BearerAuth.layer))`, where `BearerAuth = HttpRouter.middleware<{ provides: Principal }>()(...)` — and its routes are wrapped, because `router.add` applies the route middleware found where a route is registered; routes merged beside it (a public metadata route) are not. Declare `Principal` as a tool `dependency` (or read it in a resource or prompt handler): `layerHttp` turns that request-level requirement into the `HttpRouter` requirement `BearerAuth.layer` satisfies, so a composition that forgets the middleware does not compile. A low-level `addTool` handler may require only `McpRequestContext`, so it reads the principal with `Effect.serviceOption` and fails closed.

For the full architecture — protocol eras, catalog design, OAuth resource-server middleware, sealed `requestState`, a dual-era confirmation gate, idempotency, and in-process tests — read [Exposing an Effect Application over MCP](../deep-dives/exposing-an-effect-application-over-mcp).

**Reach for it when** you want capabilities usable from Claude Desktop, an IDE, or any MCP client — without writing JSON-RPC by hand.

## McpClient

`effect/ai/McpClient` — experimental

A scoped client for **calling another MCP server** over stdio or Streamable HTTP, on the `2025-11-25` or `2026-07-28` protocol revision. The transport fixes the revision: pass one `protocol` adapter; the client does not negotiate. It covers discovery (`listTools`, `listPrompts`, `listResources`), `callTool`, `getPrompt`, `readResource`, and adapting the remote tools to a `Toolkit`. Resource templates, completion, logging, subscriptions, roots, sampling, elicitation, OAuth, and retries are not implemented: server requests other than `ping` get method-not-found, and a `2026-07-28` `input_required` result fails with reason `UnsupportedError`.

- **Layers own the connection.** `McpClient.layerHttp({ name, version, protocol, url, headers? })` needs an `HttpClient`; a session-era HTTP session is closed with `DELETE` when the scope ends. `McpClient.layerStdio({ name, version, protocol, command })` spawns the server through `ChildProcessSpawner` (for example `NodeServices.layer`); on close it shuts stdin, waits five seconds, then sends `SIGTERM` and, five seconds later, `SIGKILL`. Without a Layer, provide a `McpClient.Transport` from `McpClient.http` / `McpClient.stdio` to `McpClient.make` inside `Effect.scoped`, and keep every use inside that scope.
- **`callTool` takes a discovered descriptor**, not a name, because on `2026-07-28` HTTP its `x-mcp-header` annotations decide which arguments are mirrored into headers. Without `schema` it returns the whole `McpSchema.CallToolResult`, including `isError: true` results — the caller decides. With `schema` it decodes `structuredContent` (the schema's decoding services become requirements) and a tool-reported error fails with reason `ToolError`, which keeps the result. Remote input schemas are metadata only; arguments are not validated against them.
- **Deadlines and limits.** Initialization and each complete discovery scan share one deadline (`timeout`, default 60 seconds). `callTool`, `getPrompt`, and `readResource` are unbounded unless given `{ timeout }`. Discovery follows cursors and fails with `LimitError` after 100 pages, 10,000 items, or a repeated cursor; a missing server capability makes a list empty and a retrieval fail with `UnsupportedError`. Messages over `maxMessageBytes` (16 MiB by default) are rejected both ways. The client never retries, so a `TimeoutError` says nothing about whether the server completed the call, and it creates no spans.
- **`McpClient.toolkit(client, prefix?)`** snapshots the remote tools as a `Toolkit.WithHandler` that `LanguageModel` accepts, non-strict, with `McpClientError` as each tool's `failureMode: "error"` failure. Results become text; binary content and tool-reported errors fail the handler. Build a new toolkit to see server changes. Treat these tools like any [externally sourced tool](ai-language-models): they run code you do not control.

```ts
// @effect-diagnostics experimentalApiUsage:off
import { Effect, Layer, Schema } from "effect"
import { McpClient, McpProtocol } from "effect/ai"
import { FetchHttpClient } from "effect/http"

const ReportsMcp = McpClient.layerHttp({
  name: "comp-assistant",
  version: "1.0.0",
  protocol: McpProtocol.v2026_07_28,
  url: "https://reports.acme.example/mcp",
  headers: { authorization: "Bearer <service token>" }
}).pipe(Layer.provide(FetchHttpClient.layer))

const Headcount = Schema.Struct({ count: Schema.Number })

export const headcount = (orgUnit: string) =>
  Effect.gen(function*() {
    const client = yield* McpClient.McpClient
    const tools = yield* client.listTools()
    const tool = tools.find((t) => t.name === "headcount")
    if (tool === undefined) return yield* Effect.die("reports server has no headcount tool")
    // Decodes structuredContent; a tool-reported error fails with reason ToolError.
    return yield* client.callTool({ tool, arguments: { orgUnit }, schema: Headcount }, { timeout: "5 seconds" })
  }).pipe(Effect.provide(ReportsMcp))
```

Static credentials fit in `headers`; for rotating tokens, wrap the `HttpClient` with `HttpClient.mapRequestEffect`.

**Reach for it when** your Effect program must consume tools, prompts, or resources that another process publishes over MCP.

## McpClientError

`effect/ai/McpClientError` — experimental

Every `McpClient` failure is one `McpClientError` (`_tag: "McpClientError"`) whose `reason` says what happened: `TransportError`, `ProtocolError` (JSON-RPC `code`, `data`), `HttpError` (`status`, `wwwAuthenticate`, `retryAfter`, and any JSON-RPC error in the body), `ClosedError` (`sessionExpired`), `TimeoutError` (`operation`), `LimitError`, `UnsupportedError`, `ValidationError`, `ConfigurationError`, and `ToolError` (the tool's `result`). The error's `message` and `cause` come from its reason. `isMcpClientError` and `isMcpClientErrorReason` are the guards.

```ts
// @effect-diagnostics experimentalApiUsage:off
import { Effect, Schema } from "effect"
import type { McpClient, McpSchema } from "effect/ai"

const Report = Schema.Struct({ count: Schema.Number })

export const readOrDefer = (client: McpClient.McpClient, tool: McpSchema.Tool) =>
  client.callTool({ tool, arguments: { reportId: "q3" }, schema: Report }, { timeout: "2 seconds" }).pipe(
    Effect.map((report) => ({ status: "ready" as const, report })),
    Effect.catchReason("McpClientError", "TimeoutError", () => Effect.succeed({ status: "deferred" as const }))
  )
```

**Reach for it when** recovering from specific remote-MCP failures: `Effect.catchReason` / `catchReasons` select reasons, `Effect.catchTag("McpClientError", ...)` handles them all.

## McpTest

`effect/ai/McpTest` — unstable

`McpTest.makeClient(registrations, { protocols, protocolVersion?, clientInfo?, clientCapabilities? })` builds `McpServer.layer` over an in-memory `RpcServer.Protocol`, performs the handshake for the selected revision (the first adapter's by default), and returns a typed client in the surrounding `Scope`. Requests travel through the same JSON-RPC encoding, routing, middleware, visibility, and response encoding as stdio and HTTP, so results and errors match what a wire client sees: `ping`, `listTools`, `callTool`, `listResources`, `listResourceTemplates`, `readResource`, `subscribe`/`unsubscribe`, `listPrompts`, `getPrompt`, `complete`, and `setLevel` fail with `McpSchema.McpError`. Server notifications are queued on `client.notifications` in wire form; server-to-client requests (elicitation, sampling, roots) are rejected with method-not-found, so test `elicit` over a real session transport.

The transport discharges `McpRequestContext` (and `McpServerClient` when every adapter is session-based); every other request-level dependency must be met by test middleware, exactly as in production — providing the service directly does not compile.

```ts
import { assert, it } from "@effect/vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { McpProtocol, McpServer, McpTest, Tool, Toolkit } from "effect/ai"

class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()("acme/CurrentUser") {}

const WhoAmI = Tool.make("comp_whoami", { success: Schema.String, dependencies: [CurrentUser] })
const Tools = Toolkit.make(WhoAmI)
const AsTestUser = McpServer.middleware<{ provides: CurrentUser }>()((effect) =>
  Effect.provideService(effect, CurrentUser, { id: "test-user" })
)

const Registrations = McpServer.toolkit(Tools).pipe(
  Layer.provide(AsTestUser.layer),
  Layer.provide(Tools.toLayer({ comp_whoami: () => Effect.map(CurrentUser, (user) => user.id) }))
)

it.effect("calls a tool over the JSON-RPC wire encoding", () =>
  Effect.gen(function*() {
    const client = yield* McpTest.makeClient(Registrations, { protocols: [McpProtocol.v2025_11_25] })
    const listed = yield* client.listTools()
    assert.deepStrictEqual(listed.tools.map((tool) => tool.name), ["comp_whoami"])
    const result = yield* client.callTool({ name: "comp_whoami", arguments: {} })
    assert.deepStrictEqual(result.content, [{ type: "text", text: "test-user" }])
  }).pipe(Effect.scoped))
```

**Reach for it when** testing registrations, middleware, visibility, and the wire shape of results without opening a socket; reach for `HttpRouter.toWebHandler` when the HTTP admission rules themselves are under test.
