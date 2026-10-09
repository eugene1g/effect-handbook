# MCP Servers

`effect/ai` ships a Model Context Protocol implementation: the wire schemas, the protocol adapters for every supported MCP revision, and `McpServer`, which exposes your Effect services as tools, resources, and prompts over stdio or streamable HTTP. Tools reuse the same `Tool` and `Toolkit` definitions as [AI & Language Models](ai-language-models). For an end-to-end walkthrough, read the [MCP deep dive](../deep-dives/exposing-an-effect-application-over-mcp).

## McpSchema

`effect/ai/McpSchema` — unstable

The complete Model Context Protocol (MCP) wire format as Effect `Schema`s and `Rpc` definitions: requests/results, resources and resource templates, prompts, completions, capabilities, and JSON-RPC error codes. The typed contract `McpServer` is built on.

Commonly used helpers: `McpSchema.param(name, schema)` declares typed parameters inside resource URI templates; `Role`, `Annotations`, and error types are also referenced directly. The heavier protocol machinery (Initialize, ListResources, CallTool, notifications) is consumed by the server runtime.

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

`McpServer.toolkit(toolkit)` exposes a `Toolkit` as MCP tools; `McpServer.resource\`uri/${param}\`({...})` exposes resources/templates (with auto-completion); `McpServer.prompt({...})` exposes parameterized prompts, with an optional human-readable `title` beside the `name` (also accepted by `registerPrompt`). Transports: `layerStdio` (desktop clients), `layerHttp` (mount on an `HttpRouter`; pass `allowSessionTermination: true` to enable DELETE on the session path, which ends the session and interrupts its active requests — later requests on that session id return `404`). Every server constructor (`layer`, `layerStdio`, `layerHttp`, `run`) accepts an optional `instructions` string, returned in the initialization and discovery responses to tell a client how to use the server. Launch with `Layer.launch` + `NodeRuntime.runMain`.

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

// Merge capabilities, provide the stdio server, and launch.
const ServerLayer = Layer.mergeAll(EmployeeCard, RaisePrompt).pipe(
  Layer.provide(McpServer.layerStdio({
    name: "Comp Server",
    version: "1.0.0",
    instructions: "Read employee cards before drafting; never propose an out-of-band raise.",
    protocols: [McpProtocol.v2025_06_18]
  })),
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
- **Tool annotation titles survive `tools/list`.** On the `2025-06-18` and `2025-11-25` protocol revisions, a tool's annotation `title` is reported in `tools/list` responses alongside its top-level `title` and behavioral hints.
- **Server `extensions` are advertised, not implemented.** `layer`, `layerStdio`, `layerHttp`, and `run` accept `extensions`, a record keyed `vendor/name` with JSON settings, reported in the server capabilities of `initialize` and `server/discover`. `2026-07-28` discovery lists only object-valued settings. Behavior behind an extension is your code; 4.0.2 ships no extension helpers and no MCP client.

### Request context, client gating, and human input

- **`McpSchema.McpRequestContext`** is provided to every tool handler, resource `content`, and prompt `content`: `clientId`, `protocolVersion`, `clientCapabilities`, optional `clientInfo` and `requestMetadata`, and, on a continued `2026-07-28` call, `inputResponses` and `requestState`. Read it with `yield* McpSchema.McpRequestContext` or `McpSchema.McpRequestContext.useSync(f)`; `McpServer.clientCapabilities` reads just the capabilities. A toolkit tool declares it with `dependencies: [McpSchema.McpRequestContext]`, and `McpServer.toolkit` leaves it out of the Layer's requirements because each call supplies it. Everything in it is self-reported by the client.
- **`McpSchema.McpServerClient`** exists only for initialized session-era clients. It is what server-to-client requests need; `2026-07-28` requests never have it.
- **`McpSchema.EnabledWhen`** is an annotation holding a predicate over `{ protocolVersion, capabilities, clientInfo }`: `.annotate(McpSchema.EnabledWhen, predicate)` on a `Tool`, or `annotations: Context.make(McpSchema.EnabledWhen, predicate)` on `addTool`, `prompt`, and `registerResource`. A false predicate removes the entry from that client's list, and a direct call fails as not found. It trims the catalog per client; it does not authorize.
- **`McpServer.elicit({ message, schema })`** returns `Effect<S["Type"], McpSchema.ElicitationDeclined, McpServerClient | S["DecodingServices"]>`. It sends a form-mode `elicitation/create` built from `schema` to the current session client, then decodes the accepted content with `schema`. A decline fails with `ElicitationDeclined`, and so does a client or revision without form elicitation (the reason is in `cause`); a cancel interrupts the handler. Session eras only, so hide the tool from `2026-07-28` clients:

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

- **Authenticate by wrapping the HTTP layer.** `layerHttp` does not authenticate. Provide typed route middleware to it — `McpServer.layerHttp({ ... }).pipe(Layer.provide(BearerAuth.layer))`, where `BearerAuth = HttpRouter.middleware<{ provides: Principal }>()(...)` — and its routes are wrapped, because `router.add` applies the route middleware found where a route is registered; routes merged beside it (a public metadata route) are not. A service the middleware provides reaches tool, resource, and prompt handlers, which run with the HTTP request's services. Read it with `Effect.serviceOption` rather than as a tool `dependency` (that would make it a requirement of the toolkit Layer), and never provide it in the Layer graph: the server merges the toolkit's build-time context over each call's context.

For the full architecture — protocol eras, catalog design, OAuth resource-server middleware, sealed `requestState`, a dual-era confirmation gate, idempotency, and in-process tests — read [Exposing an Effect Application over MCP](../deep-dives/exposing-an-effect-application-over-mcp).

**Reach for it when** you want capabilities usable from Claude Desktop, an IDE, or any MCP client — without writing JSON-RPC by hand.
