# Exposing an Effect Application over MCP

Written against `effect@4.0.0`. `McpServer`, `McpProtocol`, `McpSchema`, `Tool`, and `Toolkit` are all tagged `@stability unstable`: pin Effect, and re-check this guide when you upgrade.

The Model Context Protocol (MCP) lets an agent host discover what your application can do and call it: tools to act, resources to read, prompts to start a task. `effect/ai/McpServer` turns a `Toolkit` and a few Layers into a server. It handles JSON-RPC framing, protocol negotiation, JSON Schema generation, argument decoding, and result encoding. Everything that makes the server safe to expose is still yours: who the caller is, which tenant they act for, what they are allowed to change, and what happens when a call arrives twice.

This guide builds that server for a compensation platform. It assumes you already know Effect services and Layers, `HttpRouter`, and `Tool`/`Toolkit`. For API inventories it links to the concise [AI & Language Models](../systems/ai-language-models#mcpserver) reference instead of repeating them.

**What you will build.** An `acme-comp` MCP server that:

- exposes salary bands, eligible employees, and draft merit proposals as curated tools, a band resource template, and a review prompt;
- runs over stdio for desktop clients and over Streamable HTTP for remote agents, serving the stateless `2026-07-28` revision and the session-based `2025-11-25` revision from one endpoint;
- acts as an OAuth resource server: a public metadata route, a bearer-token middleware that provides a `Principal`, and scope checks inside handlers;
- asks the user to confirm a submission, by elicitation on session clients and by a sealed `InputRequired` round trip on stateless clients;
- collapses retried writes with idempotency keys, reports internal faults, and is tested in-process without opening a socket.

## MCP is a boundary, not your agent loop

An MCP server is an external interface, like an HTTP API. It is not how your own application talks to a model. Inside the process, a model call takes a `Toolkit` directly: `LanguageModel.generateText({ toolkit, ... })` decodes the model's tool calls and runs your handlers (see [Building a Production AI Capability](building-a-production-ai-capability)). Add MCP when another process — a desktop assistant, an IDE, a third-party agent — needs to discover and invoke those capabilities.

The same `Toolkit` value serves both surfaces. Define each tool once with `Tool.make`, implement handlers once with `toolkit.toLayer`, then pass the toolkit to `LanguageModel` in-process and register it with `McpServer.toolkit` for external clients. The handlers do not know which surface called them, which is the point: authorization and tenancy live in the handlers, so both surfaces enforce the same rules.

**What the server owns.** Protocol negotiation per client, `tools/list` / `resources/list` / `prompts/list`, JSON Schema for each tool's parameters and output, decoding arguments through your `Schema`, encoding results, mapping handler outcomes to wire results, list-changed notifications, and completions for resource and prompt parameters.

**What you own.** Authentication, tenant binding, per-tool authorization, confirmation of consequential actions, idempotency, rate limits, request-size limits, and audit records. Protocol negotiation is not authorization.

**What Effect 4.0.0 does not ship.** Say this plainly in design reviews so nobody waits for it:

- **No MCP client.** There is no module for connecting to a remote MCP server and calling its tools. If your agent consumes remote tools, fetch and snapshot their schemas yourself and wrap them with `Tool.dynamic`, following the rules for [dynamic and MCP-sourced tools](building-a-production-ai-capability#adjacent-capabilities-same-discipline).
- **No OAuth helpers.** Nothing verifies tokens, serves protected-resource metadata, or issues challenges. You write a middleware and a route; this guide shows both.
- **No Tasks extension helpers.** Long-running work has no built-in task handle. Return a job id from a tool and expose its status as a tool or resource. The server's `extensions` option advertises extension capabilities, but implementing an extension is your code.
- **No full legacy HTTP transport.** `layerHttp` implements the single-endpoint Streamable HTTP topology only: no standalone GET event stream, no event resumption, no session expiry, and no client-initiated session termination.

## Choose transports and protocol eras

### Streamable HTTP or stdio

Pick the transport by who launches the process.

- **stdio** (`McpServer.layerStdio`) — the client starts your server as a subprocess and speaks newline-delimited JSON-RPC over stdin/stdout. Use it for desktop assistants and IDEs on the user's machine. The process runs as the user, so authentication is the operating system's job. Stdout carries protocol frames only: route logs to stderr, or the first log line corrupts the stream.
- **Streamable HTTP** (`McpServer.layerHttp`) — your server listens and remote clients POST JSON-RPC to one path. Use it for shared, multi-tenant deployments. You must authenticate every request.

`layerHttp` returns `Layer<McpServer | McpServerClient, Cause.IllegalArgumentError, HttpRouter.HttpRouter>`: it registers a POST route at `path` on whatever router is in context, and answers GET, PUT, PATCH, DELETE, and OPTIONS on that path with `405`. Its boundary checks are strict:

- a request that carries an `Origin` header gets `403` unless that exact origin is in `allowedOrigins`; requests without `Origin` (command-line agents, server-to-server calls) pass;
- POST requires `Content-Type: application/json` (`415` otherwise) and an `Accept` header listing both `application/json` and `text/event-stream` (`406` otherwise);
- a POST that carries only notifications is answered with `202`.

Because OPTIONS returns `405`, the endpoint does not answer browser CORS preflights. Most MCP clients are not browsers; if one is, make that decision deliberately in front of the route.

### One server, two eras

`protocols` is a non-empty list of adapters. Effect 4.0.0 ships five: `McpProtocol.v2024_11_05`, `v2025_03_26`, `v2025_06_18`, and `v2025_11_25`, which are session-based (the client sends `initialize`, the server issues a session), and `v2026_07_28`, which is stateless. One endpoint can serve several eras at once, so old and new clients share a deployment. Two rules apply:

- **At most one stateless adapter.** Listing two fails the server layer with `IllegalArgumentError` when it builds.
- **The list is the contract.** A session client that offers an unlisted version on `initialize` is answered with the first session adapter in your list, and the client decides whether to continue. Do not list revisions you have not tested.

### What the stateless era changes

`2026-07-28` removes `initialize` and protocol sessions. Every request carries its protocol version, client capabilities, and client identity in `params._meta`, and HTTP requests repeat the method (and, for calls, the tool name) in `Mcp-Method` / `Mcp-Name` headers. A client can call `server/discover` to read the server's identity, capabilities, and `instructions`, and receives list-changed notifications through `subscriptions/listen` when the transport can push. Design for these consequences:

- **Context is per request.** `McpSchema.McpRequestContext` is rebuilt for every call. There is no session to stash state in, and no `McpSchema.McpServerClient`, so the server cannot send requests back to the client mid-call. Anything that must survive between two calls travels in the `requestState` string you hand to the client — see [Human in the loop](#human-in-the-loop).
- **Any replica can answer.** Session-era sessions live in an in-memory map in the process that issued them, so session clients need sticky routing; stateless requests do not.
- **Delivery is at most once per attempt.** A client that loses a response retries with a new JSON-RPC id. The server cannot tell a retry from a new intent, so writes need idempotency keys derived from the intent, never from the request id.
- **Cancellation is a closed stream.** On stateless HTTP, `notifications/cancelled` is accepted and ignored; the client cancels by closing the response stream, which interrupts your handler's fiber. Interruption can land anywhere before your commit, so make writes atomic and idempotent.
- **Logging and progress follow the request.** A per-request log level in `_meta` sets `References.CurrentLogLevel` for the handler, and progress notifications reach the client only for the `progressToken` its request carried.

**Runnable.** One set of capabilities, two transports. `CompCapabilities` is the Layer the next section builds; both transports share the same identity and protocol list.

```ts
import { NodeHttpServer, NodeRuntime, NodeStdio } from "@effect/platform-node"
import { Layer, Logger } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { HttpRouter } from "effect/http"
import { createServer } from "node:http"

// Toolkit, resources, and prompts — built in "Shape the catalog". Low-level
// registrations need the McpServer service, which the transport Layer provides.
declare const CompCapabilities: Layer.Layer<never, never, McpServer.McpServer>

const identity = {
  name: "acme-comp",
  version: "1.6.0",
  // Returned by `initialize` and `server/discover`: tell the client how to use the server.
  instructions: "Compensation planning for the caller's tenant. Read bands and employees freely. " +
    "Draft proposals with comp_draft_proposal; nothing is submitted until the user confirms " +
    "comp_submit_proposals.",
  // One stateless revision, one session revision. A session client offering an unlisted
  // version on `initialize` is answered with the first session adapter in this list.
  protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25]
} as const

// Streamable HTTP: one POST endpoint on the router that `HttpRouter.serve` builds.
export const HttpMcp = CompCapabilities.pipe(
  Layer.provide(McpServer.layerHttp({
    ...identity,
    path: "/mcp",
    // Browser-originated requests must come from these exact origins, or get 403.
    allowedOrigins: ["https://comp.acme.example"]
  }))
)

// stdio: the client launches this process; stdout carries protocol frames only.
export const StdioMcp = CompCapabilities.pipe(
  Layer.provide(McpServer.layerStdio(identity)),
  Layer.provide(NodeStdio.layer),
  Layer.provide(Layer.succeed(Logger.LogToStderr)(true))
)

const HttpServerLive = HttpRouter.serve(HttpMcp).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 8080 }))
)

if (process.argv.includes("--stdio")) {
  Layer.launch(StdioMcp).pipe(NodeRuntime.runMain)
} else {
  Layer.launch(HttpServerLive).pipe(NodeRuntime.runMain)
}
```

`HttpMcp` goes straight into `HttpRouter.serve`. Every entrypoint builds its own router in a forked memo map, so a route provided with its own `HttpRouter.layer` inside the argument is never mounted, and a stateful service first built inside the argument is private to that entrypoint (see the [HttpRouter warning](../interfaces/http-server#httprouter)). Provide shared services — database clients, repositories, the token verifier — outside `serve`, as the authorization section does.

## Shape the catalog

### Tool, resource, or prompt

Choose the primitive by who decides to use it.

| Primitive | Chosen by | Use it for | Compensation example |
| --- | --- | --- | --- |
| Tool | The model, during a task | Reads that need arguments, and every write | `comp_get_salary_band`, `comp_draft_proposal` |
| Resource | The host or the user, as context | Addressable, read-only documents | `comp://bands/{jobFamily}/{level}` |
| Prompt | The user, from a menu | A reusable task template that steers the model through your tools | `review-merit-proposals` |

When in doubt, make it a tool: every client supports tools, and support for resources and prompts varies by host. Never make a write a resource or a prompt.

### Names, descriptions, and annotations

The model reads names, descriptions, and parameter descriptions to decide what to call. Write them for that reader:

- **One verb per tool, a stable prefix.** `comp_search_employees`, not `employees` or `manage_comp`. The prefix keeps names unique when a host loads several servers.
- **Say what it returns, what it does not do, and what to call next.** "Does not return salary amounts", "nothing is submitted by this call".
- **Describe parameters, bound them, and give an example value.** `Schema.Int.check(Schema.isBetween(...))` both validates and appears in the JSON Schema.
- **Never accept the tenant, the actor, or a role as an argument.** Those come from the verified token. If the parameter schema has no `tenantId`, the model cannot pass one.

Annotations become MCP tool hints: `Tool.Title` → `title`, `Tool.Readonly` → `readOnlyHint`, `Tool.Destructive` → `destructiveHint`, `Tool.Idempotent` → `idempotentHint`, `Tool.OpenWorld` → `openWorldHint`. The protocol defaults are pessimistic — a tool is assumed destructive and open-world unless you say otherwise — so annotate safe tools explicitly. Hints are advisory: a host may use them to decide when to ask the user, but clients are told not to trust them from untrusted servers, and your handler must enforce what the hint claims.

`Tool.Strict` changes validation, not just advertising. A strict tool advertises `additionalProperties: false` and the server rejects undeclared argument keys; a non-strict tool advertises `additionalProperties: true` and drops them. Use strict mode on writes, where a misspelled argument should fail rather than be ignored. Parameters must encode to an object-root JSON Schema (a `Schema.Struct`); use `Tool.EmptyParams` for a tool without parameters.

**Contextual.** `CompData` is the tenant-scoped application port and `currentPrincipal` comes from the authorization section; both are declared so the block compiles alone.

```ts
import { Context, Effect, Layer, Schema } from "effect"
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"

// The verified caller of the current request (see "Authorize as an OAuth resource server").
interface Principal {
  readonly tenantId: string
  readonly subject: string
  readonly scopes: ReadonlySet<string>
}
declare const currentPrincipal: Effect.Effect<Principal>

class BandNotFound extends Schema.TaggedError<BandNotFound>()("BandNotFound", {
  message: Schema.String
}) {}

const SalaryBand = Schema.Struct({
  jobFamily: Schema.String,
  level: Schema.String,
  currency: Schema.String,
  min: Schema.Finite,
  mid: Schema.Finite,
  max: Schema.Finite
})

const EmployeeSummary = Schema.Struct({
  employeeId: Schema.String,
  displayName: Schema.String,
  level: Schema.String,
  compaRatio: Schema.Finite.annotate({ description: "Current base pay divided by band midpoint" })
})

const DraftedProposal = Schema.Struct({
  proposalId: Schema.String,
  withinBand: Schema.Boolean,
  warnings: Schema.Array(Schema.String)
})

// Every method takes the tenant first; no query runs without it.
class CompData extends Context.Service<CompData, {
  readonly band: (
    tenantId: string,
    jobFamily: string,
    level: string
  ) => Effect.Effect<typeof SalaryBand.Type, BandNotFound>
  readonly searchEmployees: (
    tenantId: string,
    query: { readonly cycleId: string; readonly managerId?: string | undefined; readonly limit: number }
  ) => Effect.Effect<ReadonlyArray<typeof EmployeeSummary.Type>>
  readonly draftProposal: (
    tenantId: string,
    author: string,
    input: { readonly cycleId: string; readonly employeeId: string; readonly increasePct: number }
  ) => Effect.Effect<typeof DraftedProposal.Type>
}>()("acme/CompData") {}

const GetSalaryBand = Tool.make("comp_get_salary_band", {
  description: "Return min, mid and max base pay for one job family and level in the caller's " +
    "current band table. Call before drafting a proposal to check the target salary.",
  parameters: Schema.Struct({
    jobFamily: Schema.String.annotate({ description: 'Job family code, e.g. "ENG"' }),
    level: Schema.String.annotate({ description: 'Level code, e.g. "L5"' })
  }),
  success: SalaryBand,
  failure: BandNotFound // declared: the client sees its message as an isError result
})
  .annotate(Tool.Title, "Get salary band")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)

const SearchEmployees = Tool.make("comp_search_employees", {
  description: "List employees eligible in a compensation cycle, optionally for one manager. " +
    "Returns at most `limit` rows (default 25). Does not return salary amounts.",
  parameters: Schema.Struct({
    cycleId: Schema.String.annotate({ description: 'Cycle id, e.g. "FY27-merit"' }),
    managerId: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })))
  }),
  success: Schema.Struct({ employees: Schema.Array(EmployeeSummary) })
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)

const DraftProposal = Tool.make("comp_draft_proposal", {
  description: "Create or replace the caller's draft merit proposal for one employee in an open " +
    "cycle, validated against the band. Nothing is submitted or paid by this call; submission " +
    "happens in comp_submit_proposals after the user confirms.",
  parameters: Schema.Struct({
    cycleId: Schema.String,
    employeeId: Schema.String,
    increasePct: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 25 }))
  }),
  success: DraftedProposal
})
  .annotate(Tool.Destructive, false) // replaces only the caller's own draft
  .annotate(Tool.Idempotent, true) // same arguments, same draft
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Strict, true) // reject undeclared argument keys
  // Drafting leads to a confirmation step; clients that cannot show a form never see it.
  .annotate(McpSchema.EnabledWhen, ({ capabilities }) => capabilities.elicitation !== undefined)

// Declaration order is registration order, and `tools/list` preserves it.
export const CompToolkit = Toolkit.make(GetSalaryBand, SearchEmployees, DraftProposal)

export const CompToolkitHandlers = CompToolkit.toLayer(Effect.gen(function*() {
  const data = yield* CompData
  return CompToolkit.of({
    comp_get_salary_band: Effect.fn("comp_get_salary_band")(function*({ jobFamily, level }) {
      const principal = yield* currentPrincipal
      return yield* data.band(principal.tenantId, jobFamily, level)
    }),
    comp_search_employees: Effect.fn("comp_search_employees")(function*({ cycleId, managerId, limit }) {
      const principal = yield* currentPrincipal
      const employees = yield* data.searchEmployees(principal.tenantId, {
        cycleId,
        managerId,
        limit: limit ?? 25
      })
      return { employees }
    }),
    comp_draft_proposal: Effect.fn("comp_draft_proposal")(function*(input) {
      const principal = yield* currentPrincipal
      return yield* data.draftProposal(principal.tenantId, principal.subject, input)
    })
  })
}))

// The same CompToolkit can be passed to LanguageModel.generateText in-process.
export const CompTools = McpServer.toolkit(CompToolkit).pipe(Layer.provide(CompToolkitHandlers))
```

What a client receives for each handler outcome — success, invalid arguments, declared failure, internal fault — differs by protocol era and is listed in the [tool outcome table](../systems/ai-language-models#mcpserver). The short version: declared failures are part of the contract and reach the client as written; everything else becomes a fixed internal-error message.

### Hide tools per client with EnabledWhen

`McpSchema.EnabledWhen` is an annotation holding a predicate over `{ protocolVersion, capabilities, clientInfo }`. The server evaluates it for each client: a tool whose predicate is false is left out of that client's `tools/list`, and a direct `tools/call` for it fails as "tool not found". Resources, resource templates, and prompts registered with annotations obey it too (`McpServer.prompt` takes an `annotations` option; for resources use `McpServer.registerResource`, since the `resource` Layer constructor has no `annotations` option).

Use it to keep the catalog honest per client: hide write tools from clients that cannot confirm, hide a tool that returns InputRequired from session-era clients, hide tools whose output only renders on a newer revision. Do not use it for authorization. `protocolVersion`, `capabilities`, and `clientInfo` are what the client says about itself; any caller can claim any client name. Scopes are checked in handlers.

### Resources and prompts

A resource template turns typed URI parameters into a read; completions help the host fill them in. A prompt is a parameterized message the user picks from a menu. Both run with the same per-request context as tools, so they read the principal the same way.

**Contextual.** The store functions are declared; the API reference for `resource` and `prompt` options is in the [McpServer section](../systems/ai-language-models#mcpserver).

```ts
import { Effect, Layer, Schema } from "effect"
import { McpSchema, McpServer } from "effect/ai"

interface Principal {
  readonly tenantId: string
}
declare const currentPrincipal: Effect.Effect<Principal>
declare const bandRowJson: (tenantId: string, jobFamily: string, level: string) => Effect.Effect<string>

const jobFamily = McpSchema.param("jobFamily", Schema.String)
const level = McpSchema.param("level", Schema.String)

// Advertised as the template comp://bands/{jobFamily}/{level}; parameters arrive decoded.
export const BandResource = McpServer.resource`comp://bands/${jobFamily}/${level}`({
  name: "Salary band",
  description: "The caller's current band table row for one job family and level, as JSON.",
  mimeType: "application/json",
  completion: {
    level: (prefix) => Effect.succeed(["L3", "L4", "L5", "L6", "L7"].filter((l) => l.startsWith(prefix)))
  },
  content: Effect.fn("BandResource")(function*(_uri, jobFamily, level) {
    const principal = yield* currentPrincipal
    return yield* bandRowJson(principal.tenantId, jobFamily, level)
  })
})

export const ReviewPrompt = McpServer.prompt({
  name: "review-merit-proposals",
  title: "Review a manager's merit proposals",
  description: "Walk through the draft proposals in one org unit and flag band and budget exceptions.",
  parameters: {
    cycleId: Schema.String,
    orgUnit: Schema.String.annotate({ description: 'Org unit code, e.g. "ENG-PLATFORM"' })
  },
  // A string becomes one user message; return PromptMessage values for multi-turn templates.
  content: ({ cycleId, orgUnit }) =>
    Effect.succeed(
      `Review every draft merit proposal for ${orgUnit} in cycle ${cycleId}. Use ` +
        `comp_search_employees and comp_get_salary_band, list proposals above band in a table ` +
        `with a recommendation, and do not submit anything.`
    )
})

export const CompContent = Layer.mergeAll(BandResource, ReviewPrompt)
```

Resource and prompt content is data the model will read, so it is untrusted on the way back in: a manager's free-text justification inside a resource can carry instructions aimed at the model. Label such fields as user-authored text in descriptions and keep them out of anything your server interprets.

Merge all capabilities into one Layer — `Layer.mergeAll(CompTools, CompContent, WriteTools, SubmitProposals)`, built in the sections below — and that is the `CompCapabilities` the bootstrap provides with a transport. Registration across separate capability Layers follows Layer build order, so if the order of `tools/list` matters to you, put the tools of one surface in one toolkit (`Toolkit.merge` combines toolkits).

## Exposure strategy: curated tools, query tools, code mode

There are three common ways to put an application API in front of an agent. They are not exclusive.

- **Curated tools.** One schema-first tool per domain operation, as above. Behavior is predictable, each tool carries its own authorization and confirmation rules, and descriptions can teach the model the workflow. The cost is catalog size: every operation is a tool the host has to load.
- **Query tools.** A small set of meta-tools — search the schema, validate a query, run a read-only query — over a typed query surface such as a GraphQL schema or a set of SQL views. Reads become flexible with three tools instead of thirty. The guards must live below the model: parse the query, allow exactly one read-only operation, cap depth, cost, and rows, enforce tenant filters and field-level scopes in the resolvers rather than in the query text, and treat user-authored fields in results as untrusted data.
- **Code mode.** The host has the model write a short program against a typed client generated from your tool schemas and runs it in the host's own sandbox, chaining calls without a model turn between each. Nothing changes on your server, except that precise parameter and output schemas pay off more.

**Recommendation.** Curate every write, each with its own scope check, confirmation, and idempotency. Add one read-only query tool only when curated reads stop scaling, and guard it at the parser. Keep the catalog small — tens of tools, not hundreds — in a deterministic order, trim it per client with `EnabledWhen`, and let hosts that support progressive discovery or tool search handle a large catalog on their side. Treat tool names as part of the security model: hosts key allow-lists and remembered approvals on them, so a rename is a breaking, security-relevant change, and a generic name can collide with another server's tool.

## Authorize as an OAuth resource server

A remote MCP server is an OAuth 2.1 protected resource. The authorization server — your identity provider — issues access tokens; your server only verifies them and enforces what they grant. `layerHttp` leaves authentication to the surrounding HTTP server, so you add three pieces:

1. **Protected-resource metadata** (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`, public, naming the resource, its authorization servers, and supported scopes. Clients read it to find where to get a token.
2. **A bearer-token middleware** on the MCP route. No token or a bad token gets `401` with a `WWW-Authenticate: Bearer` challenge that points at the metadata URL; a token without the baseline scope gets `403` with `error="insufficient_scope"` and the needed scope. A valid token becomes a `Principal` service for the rest of the request.
3. **Per-tool scope checks** in handlers, because the HTTP layer sees one endpoint, not which tool the JSON-RPC body calls.

Token verification itself — signature against the issuer's keys, issuer, audience equal to your canonical resource URI, expiry, not-before — is not part of Effect 4. Use a JOSE library behind a service, so tests can substitute it.

**Runnable shape.** `TokenVerifierLive` and `CompCapabilities` are declared; everything else is the code you deploy.

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"

const RESOURCE = "https://mcp.acme.example/mcp" // canonical resource URI = required token audience
const METADATA_URL = "https://mcp.acme.example/.well-known/oauth-protected-resource/mcp"

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {
  reason: Schema.String
}) {}

// Tenant, subject, client, and scopes come from verified token claims only.
export class Principal extends Context.Service<Principal, {
  readonly tenantId: string
  readonly subject: string
  readonly clientId: string
  readonly scopes: ReadonlySet<string>
}>()("acme/Principal") {}

export class TokenVerifier extends Context.Service<TokenVerifier, {
  readonly verify: (token: string) => Effect.Effect<Principal["Service"], Unauthenticated>
}>()("acme/TokenVerifier") {}

declare const TokenVerifierLive: Layer.Layer<TokenVerifier> // JOSE library + the issuer's JWKS
declare const CompCapabilities: Layer.Layer<never, never, McpServer.McpServer>

const challenge = (status: 401 | 403, error: "invalid_token" | "insufficient_scope", scope?: string) =>
  HttpServerResponse.empty({
    status,
    headers: {
      "www-authenticate": `Bearer realm="mcp", error="${error}"` +
        (scope === undefined ? "" : `, scope="${scope}"`) +
        `, resource_metadata="${METADATA_URL}"`
    }
  })

export const ProtectedResourceMetadata = HttpRouter.add(
  "GET",
  "/.well-known/oauth-protected-resource/mcp",
  HttpServerResponse.jsonUnsafe({
    resource: RESOURCE,
    authorization_servers: ["https://auth.acme.example"],
    scopes_supported: ["comp:read", "comp:write"],
    bearer_methods_supported: ["header"]
  })
)

export const BearerAuth = HttpRouter.middleware<{ provides: Principal }>()(
  Effect.gen(function*() {
    const verifier = yield* TokenVerifier
    return (httpEffect) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const header = request.headers["authorization"]
        if (header === undefined || !/^bearer /i.test(header)) return challenge(401, "invalid_token")
        const principal = yield* Effect.option(verifier.verify(header.slice(7)))
        if (Option.isNone(principal)) return challenge(401, "invalid_token")
        // Baseline scope at the edge; per-tool scopes are checked in handlers.
        if (!principal.value.scopes.has("comp:read")) return challenge(403, "insufficient_scope", "comp:read")
        return yield* Effect.provideService(httpEffect, Principal, principal.value)
      })
  })
)

const McpRoutes = CompCapabilities.pipe(
  Layer.provide(McpServer.layerHttp({
    name: "acme-comp",
    version: "1.6.0",
    path: "/mcp",
    protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25],
    allowedOrigins: ["https://comp.acme.example"]
  })),
  // Route middleware wraps the routes registered while this Layer builds: the MCP
  // endpoint. The metadata route is merged beside it and stays public.
  Layer.provide(BearerAuth.layer)
)

HttpRouter.serve(Layer.mergeAll(ProtectedResourceMetadata, McpRoutes)).pipe(
  // Shared services are provided outside the entrypoint, so they are built once.
  Layer.provide(TokenVerifierLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 8080 })),
  Layer.launch,
  NodeRuntime.runMain
)
```

The middleware applies to the MCP endpoint because `router.add` reads route middleware from the context in which the route is registered, and `layerHttp` registers its routes while it builds inside `McpRoutes`.

### Read the principal inside handlers

The `Principal` provided by the middleware reaches tool, resource, and prompt handlers. The RPC server runs each handler with the HTTP request fiber's services merged in, which is also how `HttpServerRequest` is available to them. Two details decide how to read it:

- **Do not declare it as a tool dependency.** `Tool.make(..., { dependencies: [Principal] })` makes `Principal` a requirement of the `McpServer.toolkit` Layer, which is built once at startup. `McpRequestContext` is the only request service that Layer excludes.
- **Never provide a `Principal` in the Layer graph.** When the server registers a toolkit it captures the build-time context and merges it over each call's context, dropping only its own request services (`McpRequestContext`, `McpServerClient`, `HttpServerRequest`, the log level). A build-time `Principal` would shadow the per-request one for every call.

So read it with `Effect.serviceOption` and fail closed. A missing principal means the server was mounted without the middleware — over stdio, or on an unprotected route — which is a deployment fault, so it dies: the call returns the fixed internal-error result, and the cause is logged and reported.

**Contextual.** `Proposals` is the tenant-scoped port; the toolkit is merged into `CompCapabilities` like the read tools.

```ts
import { Context, Effect, Layer, Option, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"

export class Principal extends Context.Service<Principal, {
  readonly tenantId: string
  readonly subject: string
  readonly clientId: string
  readonly scopes: ReadonlySet<string>
}>()("acme/Principal") {}

export const currentPrincipal = Effect.serviceOption(Principal).pipe(
  Effect.flatMap(Option.match({
    onNone: () => Effect.die("MCP handler ran without an authenticated Principal"),
    onSome: (principal) => Effect.succeed(principal)
  }))
)

export class InsufficientScope extends Schema.TaggedError<InsufficientScope>()("InsufficientScope", {
  scope: Schema.String,
  message: Schema.String
}) {}

export const requireScope = (scope: string) =>
  Effect.flatMap(currentPrincipal, (principal) =>
    principal.scopes.has(scope)
      ? Effect.succeed(principal)
      : Effect.fail(
        new InsufficientScope({ scope, message: `This tool needs the ${scope} scope; ask the user to re-authorize.` })
      ))

class Proposals extends Context.Service<Proposals, {
  readonly withdraw: (tenantId: string, author: string, proposalId: string) => Effect.Effect<boolean>
}>()("acme/Proposals") {}

const WithdrawProposal = Tool.make("comp_withdraw_proposal", {
  description: "Withdraw one of the caller's draft proposals. Requires the comp:write scope.",
  parameters: Schema.Struct({ proposalId: Schema.String }),
  success: Schema.Struct({ withdrawn: Schema.Boolean }),
  failure: InsufficientScope // declared, so the model reads the re-authorize hint
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)

const WriteToolkit = Toolkit.make(WithdrawProposal)

export const WriteTools = McpServer.toolkit(WriteToolkit).pipe(
  Layer.provide(WriteToolkit.toLayer(Effect.gen(function*() {
    const proposals = yield* Proposals
    return WriteToolkit.of({
      comp_withdraw_proposal: Effect.fn("comp_withdraw_proposal")(function*({ proposalId }) {
        const principal = yield* requireScope("comp:write")
        // Tenant and author come from the token, never from arguments.
        const withdrawn = yield* proposals.withdraw(principal.tenantId, principal.subject, proposalId)
        return { withdrawn }
      })
    })
  })))
)
```

### Tenants and downstream calls

- **Tenant isolation is a data-layer rule.** Repositories take the tenant as their first argument and filter every query by it; handlers pass `principal.tenantId` and nothing else. A test should show that a principal from tenant A asking for tenant B's employee gets nothing, whatever the arguments say.
- **Do not pass the client's token downstream.** The access token's audience is your MCP server. Calling another API with it (token passthrough) is forbidden: that API cannot tell who it is really serving, and your server becomes a confused deputy. Exchange the token for one scoped to the downstream API, or call it with your own service credentials and pass the principal as data.
- **Audit with the token's identities.** Record `subject`, `clientId`, tenant, tool name, and the idempotency key for every write. `McpRequestContext.clientInfo` is self-reported; use it for diagnostics only.

## Human in the loop

Some writes need a person to confirm what will happen: submitting a cycle's proposals notifies HR and locks them. The model must not be able to confirm on the user's behalf, so the confirmation has to come back through the client, from the user. The two protocol eras do this differently.

### Session eras: elicit

On session-based revisions (form elicitation needs `2025-06-18` or later), the server can send requests to the client in the middle of a call. `McpServer.elicit({ message, schema })` sends `elicitation/create` with a JSON Schema derived from `schema`, waits, and decodes the accepted content with the same schema. It needs `McpSchema.McpServerClient`, which exists only for initialized session clients.

- **Accept** returns the decoded value.
- **Decline** fails with `McpSchema.ElicitationDeclined`. A client that did not advertise the elicitation capability, or a revision without elicitation, also ends in `ElicitationDeclined`, with the reason in its `cause`.
- **Cancel** interrupts the handler: the user abandoned the whole operation.

On Streamable HTTP the elicitation request travels on the tool call's event stream and the client answers with a separate POST, so the call stays open while the user decides.

### Stateless era: the InputRequired round trip

`2026-07-28` has no server-to-client requests. Instead, a handler returns `new McpSchema.InputRequired({ inputRequests, requestState })`. The client shows the requests to the user (`elicitation/create`, `sampling/createMessage`, or `roots/list`), then calls the same tool again with the same arguments, the answers in `inputResponses` keyed as you named them, and your `requestState` string echoed back unchanged. The second call is a new request: it may land on another replica, minutes later. The handler reads `inputResponses` and `requestState` from `McpSchema.McpRequestContext`.

Rules the server enforces for you:

- At least one of `inputRequests` or `requestState` is required.
- If an input request needs a capability the client did not advertise, the call fails with protocol error `-32021` and `data.requiredCapabilities`, and your handler's result is not sent. An empty `elicitation: {}` capability counts as form support.
- A session-era client that receives `InputRequired` gets a protocol error, so hide such tools from session clients or branch on `protocolVersion`, as the gate below does.
- If the handler fails with `McpSchema.InvalidParams` while continuation fields are present, the client receives JSON-RPC `-32602`; on a first-round call the same failure is reported as an `isError` result.

### Seal requestState

`requestState` is the only memory between rounds, and it comes back from the client. Treat it as attacker-controlled: a client can replay it, alter it, or hand it to someone else. Seal it.

- **Integrity.** HMAC-SHA256 over the encoded payload with a server secret, compared in constant time. Effect's `Crypto` service offers random bytes and digests but no HMAC, so use `node:crypto`.
- **Expiry and freshness.** An expiry timestamp and a random nonce inside the sealed payload.
- **Binding.** The tenant, the subject, and a digest of the exact arguments, checked against the current principal and arguments in round 2.
- **Only what round 1 proved.** Store the proposal ids and the total the user is shown, not a flag that says "approved".

**Runnable.** A self-contained service; provide `RequestState.layer` beside the other shared services, with the secret in `Config` and rotated like any other key.

```ts
import { Clock, Config, Context, Effect, Layer, Redacted, Schema } from "effect"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export class InvalidRequestState extends Schema.TaggedError<InvalidRequestState>()("InvalidRequestState", {
  reason: Schema.Literals(["malformed", "signature", "payload", "expired"])
}) {}

// What round 2 is allowed to believe, bound to the caller and the exact arguments.
export const PendingSubmission = Schema.Struct({
  tenantId: Schema.String,
  subject: Schema.String,
  argumentsDigest: Schema.String,
  proposalIds: Schema.Array(Schema.String),
  totalIncrease: Schema.Finite
})
export type PendingSubmission = typeof PendingSubmission.Type

const Envelope = Schema.fromJsonString(Schema.Struct({
  v: Schema.Literal(1),
  expiresAt: Schema.Int, // epoch milliseconds
  nonce: Schema.String,
  pending: PendingSubmission
}))

export class RequestState extends Context.Service<RequestState, {
  readonly seal: (pending: PendingSubmission) => Effect.Effect<string>
  readonly open: (token: string) => Effect.Effect<PendingSubmission, InvalidRequestState>
}>()("acme/RequestState") {
  static readonly layer = Layer.effect(RequestState)(Effect.gen(function*() {
    const secret = yield* Config.Redacted("MCP_REQUEST_STATE_SECRET")
    const ttlMillis = 10 * 60 * 1000
    const sign = (body: string) => createHmac("sha256", Redacted.value(secret)).update(body).digest("base64url")

    return RequestState.of({
      seal: Effect.fn("RequestState.seal")(function*(pending: PendingSubmission) {
        const now = yield* Clock.currentTimeMillis
        const json = yield* Schema.encodeEffect(Envelope)({
          v: 1,
          expiresAt: now + ttlMillis,
          nonce: randomBytes(16).toString("base64url"),
          pending
        }).pipe(Effect.orDie)
        const body = Buffer.from(json, "utf8").toString("base64url")
        return `${body}.${sign(body)}`
      }),
      open: Effect.fn("RequestState.open")(function*(token: string) {
        const [body, signature, ...rest] = token.split(".")
        if (body === undefined || signature === undefined || rest.length > 0) {
          return yield* new InvalidRequestState({ reason: "malformed" })
        }
        const expected = Buffer.from(sign(body))
        const actual = Buffer.from(signature)
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
          return yield* new InvalidRequestState({ reason: "signature" })
        }
        const envelope = yield* Schema.decodeUnknownEffect(Envelope)(
          Buffer.from(body, "base64url").toString("utf8")
        ).pipe(Effect.mapError(() => new InvalidRequestState({ reason: "payload" })))
        if ((yield* Clock.currentTimeMillis) > envelope.expiresAt) {
          return yield* new InvalidRequestState({ reason: "expired" })
        }
        return envelope.pending
      })
    })
  }))
}
```

The nonce makes every sealed state unique; it does not by itself stop a replay within the expiry window. Make round 2 idempotent — the next block keys the submission on the proposal ids — so a replayed state reproduces the same outcome instead of a second submission. Record consumed nonces as well if a replay must be rejected outright.

### One gate for both eras

A toolkit handler must return the tool's success type, so it cannot return `InputRequired`. A tool that needs the stateless round trip is registered at the lower level, through the `McpServer.McpServer` service's `addTool`, with a hand-written `McpSchema.Tool` descriptor and a handler that returns `CallToolResult | InputRequired`, may fail only with `InternalError | InvalidParams`, and may require only `McpRequestContext`. In exchange you own everything the toolkit path does for you: decode the arguments, build the result, and map failures.

**Contextual.** The ports from the previous blocks are repeated as declarations so this block compiles alone. Merge `SubmitProposals` into `CompCapabilities`; it needs `McpServer.McpServer`, which the transport Layer provides.

```ts
import { Context, Effect, Layer, Option, Schema } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { createHash } from "node:crypto"

interface Principal {
  readonly tenantId: string
  readonly subject: string
  readonly scopes: ReadonlySet<string>
}
declare const currentPrincipal: Effect.Effect<Principal>

interface PendingSubmission {
  readonly tenantId: string
  readonly subject: string
  readonly argumentsDigest: string
  readonly proposalIds: ReadonlyArray<string>
  readonly totalIncrease: number
}
class InvalidRequestState extends Schema.TaggedError<InvalidRequestState>()("InvalidRequestState", {
  reason: Schema.String
}) {}
class RequestState extends Context.Service<RequestState, {
  readonly seal: (pending: PendingSubmission) => Effect.Effect<string>
  readonly open: (token: string) => Effect.Effect<PendingSubmission, InvalidRequestState>
}>()("acme/RequestState") {}

class TotalChanged extends Schema.TaggedError<TotalChanged>()("TotalChanged", {}) {}
class Proposals extends Context.Service<Proposals, {
  readonly drafts: (
    tenantId: string,
    author: string,
    cycleId: string
  ) => Effect.Effect<ReadonlyArray<{ readonly proposalId: string; readonly increase: number }>>
  // Atomic: re-checks the total and records the key in the same transaction.
  readonly submit: (
    tenantId: string,
    proposalIds: ReadonlyArray<string>,
    options: { readonly submittedBy: string; readonly expectedTotal: number; readonly idempotencyKey: string }
  ) => Effect.Effect<{ readonly batchId: string }, TotalChanged>
}>()("acme/Proposals") {}

const SubmitArgs = Schema.Struct({ cycleId: Schema.String })
const Confirmation = Schema.Struct({ confirm: Schema.Boolean })
const isConfirmation = Schema.is(Confirmation)
const confirmationJsonSchema = {
  type: "object",
  properties: { confirm: { type: "boolean", title: "Submit these proposals" } },
  required: ["confirm"]
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const textResult = (text: string, isError = false) =>
  new McpSchema.CallToolResult({ content: [{ type: "text", text }], isError })

const SubmitProposalsTool = new McpSchema.Tool({
  name: "comp_submit_proposals",
  title: "Submit merit proposals",
  description: "Submit all of the caller's draft proposals in a cycle for HR approval. Shows the " +
    "user the count and total first and submits only after they confirm. Requires comp:write.",
  inputSchema: {
    type: "object",
    properties: { cycleId: { type: "string" } },
    required: ["cycleId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
})

export const SubmitProposals = Layer.effectDiscard(Effect.gen(function*() {
  const server = yield* McpServer.McpServer
  const proposals = yield* Proposals
  const requestState = yield* RequestState

  const commit = (principal: Principal, pending: PendingSubmission) =>
    proposals.submit(principal.tenantId, pending.proposalIds, {
      submittedBy: principal.subject,
      expectedTotal: pending.totalIncrease,
      // Same intent, same key: a retried round 2 or a duplicate call submits once.
      idempotencyKey: digest(["comp_submit_proposals", principal.tenantId, pending.proposalIds])
    }).pipe(
      Effect.map(({ batchId }) =>
        new McpSchema.CallToolResult({
          content: [{ type: "text", text: `Submitted ${pending.proposalIds.length} proposals as ${batchId}.` }],
          structuredContent: { batchId, submitted: pending.proposalIds.length }
        })
      ),
      Effect.catchTag("TotalChanged", () =>
        Effect.succeed(textResult("Not submitted: the proposals changed after confirmation. Call again.", true)))
    )

  yield* server.addTool({
    tool: SubmitProposalsTool,
    // Clients without form elicitation cannot complete this tool, so they never see it.
    annotations: Context.make(McpSchema.EnabledWhen, ({ capabilities }) => capabilities.elicitation !== undefined),
    handle: Effect.fn("comp_submit_proposals")(function*(payload: unknown) {
      const args = yield* Schema.decodeUnknownEffect(SubmitArgs)(payload).pipe(
        Effect.mapError(() => new McpSchema.InvalidParams({ message: "Expected { cycleId: string }" }))
      )
      const principal = yield* currentPrincipal
      if (!principal.scopes.has("comp:write")) {
        return textResult("This tool needs the comp:write scope; ask the user to re-authorize.", true)
      }
      const context = yield* McpSchema.McpRequestContext
      const argumentsDigest = digest(args)

      // Round 2 (stateless era): our sealed state and the user's answer came back.
      if (context.requestState !== undefined) {
        const pending = yield* requestState.open(context.requestState).pipe(
          Effect.mapError(() => new McpSchema.InvalidParams({ message: "requestState is invalid or expired" }))
        )
        if (
          pending.tenantId !== principal.tenantId || pending.subject !== principal.subject ||
          pending.argumentsDigest !== argumentsDigest
        ) {
          return yield* new McpSchema.InvalidParams({ message: "requestState does not match this call" })
        }
        const answer = context.inputResponses?.["confirm"]
        const content = answer?.content
        return answer?.action === "accept" && isConfirmation(content) && content.confirm
          ? yield* commit(principal, pending)
          : textResult("Not submitted: the user did not confirm.")
      }

      // Round 1 (both eras): compute exactly what the user is asked to confirm.
      const drafts = yield* proposals.drafts(principal.tenantId, principal.subject, args.cycleId)
      if (drafts.length === 0) return textResult(`No draft proposals in ${args.cycleId}.`)
      const pending: PendingSubmission = {
        tenantId: principal.tenantId,
        subject: principal.subject,
        argumentsDigest,
        proposalIds: drafts.map((draft) => draft.proposalId),
        totalIncrease: drafts.reduce((sum, draft) => sum + draft.increase, 0)
      }
      const message = `Submit ${drafts.length} merit proposals in ${args.cycleId} ` +
        `(total increase ${pending.totalIncrease}) for HR approval? This locks them.`

      if (context.protocolVersion === "2026-07-28") {
        return new McpSchema.InputRequired({
          inputRequests: {
            confirm: {
              method: "elicitation/create",
              params: { mode: "form", message, requestedSchema: confirmationJsonSchema }
            }
          },
          requestState: yield* requestState.seal(pending)
        })
      }

      // Session era: ask over the open session and wait for the answer.
      const client = yield* Effect.serviceOption(McpSchema.McpServerClient)
      if (Option.isNone(client)) return textResult("This client cannot confirm submissions.", true)
      const confirmed = yield* McpServer.elicit({ message, schema: Confirmation }).pipe(
        Effect.provideService(McpSchema.McpServerClient, client.value),
        Effect.map(({ confirm }) => confirm),
        Effect.catchTag("ElicitationDeclined", () => Effect.succeed(false))
      )
      return confirmed ? yield* commit(principal, pending) : textResult("Not submitted: the user declined.")
    })
  })
}))
```

Read the gate as four guarantees. The user confirms the exact proposal ids and total computed in round 1. Round 2 accepts only a state this server sealed, for this principal and these arguments. The store re-checks the total inside the submit transaction, so a draft edited between rounds aborts instead of submitting an unconfirmed amount. The idempotency key turns a retried round 2 into the same batch.

## Failures, retries, idempotency

**Outcomes.** The [tool outcome table](../systems/ai-language-models#mcpserver) lists what a client receives for each toolkit handler outcome on each protocol era. Design to its two categories:

- **Declared failures** (`failure` on `Tool.make`) are part of the contract. The client receives them as an `isError: true` result — the error's `message` under `failureMode: "error"` when it is an `Error` with a message, otherwise the schema-encoded payload — and the server neither logs nor reports them. Use them for outcomes the model can act on: band not found, insufficient scope, a conflicting request id. They are visible to the client, so keep internal detail out.
- **Everything else** — undeclared failures, defects, results that fail their own `success` schema — reaches the client only as a fixed internal-error message, and is logged at error level and handed to every configured `ErrorReporter`. Turn infrastructure failures into defects with `Effect.orDie` rather than widening the tool's contract with them.

In the low-level `addTool` path, the mapping is yours: a handler's `InternalError` message is sent to the client as an `isError` result on `2025-11-25` and later, so put only a fixed message in it, and log or report the cause yourself.

**Retries and idempotency.** Clients retry: a stateless client after a dropped stream, any client after a timeout, a model that did not see the first result. Every write tool needs a key that identifies the intent:

- **Natural keys** when the operation has one. Drafting a proposal is "the caller's draft for this employee in this cycle"; doing it twice replaces the same draft, so the tool is idempotent by construction and annotated `Tool.Idempotent`.
- **Client request ids** when two identical calls can be two real intents, such as two equal one-off bonuses. Ask for a `requestId` parameter, scope it by tenant and subject, and store a digest of the arguments with it, so reusing an id with different arguments is a declared conflict rather than a silent replay.
- **Never the JSON-RPC id.** It changes on every retry.

Claim the key and perform the write in one transaction, store the first outcome, and return it for duplicates. If a call is interrupted after the write was dispatched, the outcome is unknown; the client's retry with the same key resolves it instead of writing twice.

**Runnable shape.** `AdjustmentLedger`, `currentPrincipal`, and the paging function are declared; the reporter Layer is provided with the capabilities.

```ts
import { Context, Effect, ErrorReporter, Layer, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"
import { createHash } from "node:crypto"

interface Principal {
  readonly tenantId: string
  readonly subject: string
}
declare const currentPrincipal: Effect.Effect<Principal>
declare const pageOnCall: (error: Error, details: Readonly<Record<string, unknown>>) => void

class LedgerUnavailable extends Schema.TaggedError<LedgerUnavailable>()("LedgerUnavailable", {}) {}
class RequestIdReused extends Schema.TaggedError<RequestIdReused>()("RequestIdReused", {
  message: Schema.String
}) {}

// Insert-if-absent keyed by intent; a duplicate returns the first outcome.
class AdjustmentLedger extends Context.Service<AdjustmentLedger, {
  readonly recordOnce: (
    key: string,
    argumentsDigest: string,
    adjustment: { readonly tenantId: string; readonly employeeId: string; readonly amount: number }
  ) => Effect.Effect<
    { readonly adjustmentId: string; readonly replayed: boolean },
    RequestIdReused | LedgerUnavailable
  >
}>()("acme/AdjustmentLedger") {}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

const RecordSpotBonus = Tool.make("comp_record_spot_bonus", {
  description: "Record a one-off spot bonus for one employee. Generate a new requestId for each " +
    "intended bonus and reuse it when retrying; a retried requestId never records twice.",
  parameters: Schema.Struct({
    requestId: Schema.String.check(Schema.isMinLength(8)),
    employeeId: Schema.String,
    amount: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))
  }),
  success: Schema.Struct({ adjustmentId: Schema.String, replayed: Schema.Boolean }),
  failure: RequestIdReused
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Strict, true)

const BonusToolkit = Toolkit.make(RecordSpotBonus)

export const BonusTools = McpServer.toolkit(BonusToolkit).pipe(
  Layer.provide(BonusToolkit.toLayer(Effect.gen(function*() {
    const ledger = yield* AdjustmentLedger
    return BonusToolkit.of({
      comp_record_spot_bonus: Effect.fn("comp_record_spot_bonus")(function*({ requestId, employeeId, amount }) {
        const principal = yield* currentPrincipal
        const key = digest(["comp_record_spot_bonus", principal.tenantId, principal.subject, requestId])
        return yield* ledger.recordOnce(key, digest({ employeeId, amount }), {
          tenantId: principal.tenantId,
          employeeId,
          amount
        }).pipe(
          // Infrastructure is not part of the tool contract: a defect is logged and
          // reported, and the client sees only the fixed internal-error message.
          Effect.catchTag("LedgerUnavailable", (error) => Effect.die(error))
        )
      })
    })
  })))
)

// Undeclared failures and defects in toolkit handlers reach every configured reporter.
export const Reporting = ErrorReporter.layer([
  ErrorReporter.make(({ error, attributes, severity }) => pageOnCall(error, { ...attributes, severity }))
])

export const ReportedBonusTools = BonusTools.pipe(Layer.provide(Reporting))
```

Reporters are read from the context in which the toolkit is registered, so provide the reporter Layer to the capability Layers (or above them), not inside a handler.

## Test it in-process

`HttpRouter.toWebHandler` builds the server Layer and returns `{ handler, dispose }`, where `handler` turns a Web `Request` into a `Response`. A test can drive the real transport — origin, media-type, and header checks included — without a socket. The stateless era makes this especially simple: every request is self-describing, so there is no session to set up.

**Runnable.** A complete `@effect/vitest` test file.

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter } from "effect/http"

const GetSalaryBand = Tool.make("comp_get_salary_band", {
  parameters: Schema.Struct({ jobFamily: Schema.String, level: Schema.String }),
  success: Schema.Struct({ min: Schema.Finite, mid: Schema.Finite, max: Schema.Finite })
}).annotate(Tool.Readonly, true)
const CompToolkit = Toolkit.make(GetSalaryBand)

const ServerUnderTest = McpServer.toolkit(CompToolkit).pipe(
  Layer.provide(CompToolkit.toLayer({
    comp_get_salary_band: () => Effect.succeed({ min: 150_000, mid: 185_000, max: 220_000 })
  })),
  Layer.provide(McpServer.layerHttp({
    name: "acme-comp",
    version: "test",
    path: "/mcp",
    protocols: [McpProtocol.v2026_07_28]
  }))
)

const ListToolsReply = Schema.Struct({
  result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) })
})
const CallToolReply = Schema.Struct({
  result: Schema.Struct({ isError: Schema.optional(Schema.Boolean), structuredContent: Schema.optional(Schema.Unknown) })
})

// A stateless request carries its version, capabilities, and client identity in `_meta`,
// and repeats the method (and tool name) in routing headers.
const post = (
  handler: (request: Request) => Promise<Response>,
  body: { readonly id: number; readonly method: string; readonly params: Record<string, unknown> },
  headers: Record<string, string> = {}
) =>
  Effect.promise(async () => {
    const response = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": body.method,
          ...headers
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          method: body.method,
          params: {
            ...body.params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "comp-tests", version: "1.0.0" }
            }
          }
        })
      })
    )
    // A single reply is JSON; a reply that also carries notifications is an event stream.
    const text = await response.text()
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split("\n").filter((line) => line.startsWith("data: ")).at(-1)?.slice(6)
      : text
    return { status: response.status, body: json === undefined || json === "" ? null : JSON.parse(json) as unknown }
  })

it.effect("serves the catalog and calls over stateless HTTP", () =>
  Effect.gen(function*() {
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(ServerUnderTest, { disableLogger: true })),
      ({ dispose }) => Effect.promise(dispose)
    )

    const listed = yield* post(handler, { id: 1, method: "tools/list", params: {} })
    const tools = yield* Schema.decodeUnknownEffect(ListToolsReply)(listed.body)
    assert.deepStrictEqual(tools.result.tools.map((tool) => tool.name), ["comp_get_salary_band"])

    const call = (id: number, args: Record<string, unknown>) =>
      post(handler, { id, method: "tools/call", params: { name: "comp_get_salary_band", arguments: args } }, {
        "mcp-name": "comp_get_salary_band"
      }).pipe(Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(CallToolReply)(body)))

    const ok = yield* call(2, { jobFamily: "ENG", level: "L5" })
    assert.deepStrictEqual(ok.result.structuredContent, { min: 150_000, mid: 185_000, max: 220_000 })

    // On 2026-07-28, arguments that fail the schema come back as an isError result.
    const invalid = yield* call(3, { jobFamily: "ENG" })
    assert.strictEqual(invalid.result.isError, true)

    // A browser origin that is not allow-listed is refused before any JSON-RPC runs.
    const foreign = yield* post(handler, { id: 4, method: "tools/list", params: {} }, {
      origin: "https://elsewhere.example"
    })
    assert.strictEqual(foreign.status, 403)
  }))
```

Build the rest of the suite on the same harness:

- **Authorization.** Compose the real `BearerAuth` with a fake `TokenVerifier` Layer and assert `401` with a `WWW-Authenticate` header that names the metadata URL, `403 insufficient_scope` for a token without `comp:read`, an `isError` result with the re-authorize hint for a missing per-tool scope, and that the metadata route answers without a token.
- **Tenancy.** Two principals from different tenants; each call returns only its own tenant's rows, whatever the arguments say.
- **The round trip.** Call `comp_submit_proposals` without answers and decode `resultType: "input_required"`; call again with the returned `requestState` and an accepted answer and assert exactly one submission; repeat the second call and assert the same batch; alter one character of the state, or send it under another principal, and assert JSON-RPC `-32602`; omit the elicitation capability and assert `-32021`.
- **Session era.** For elicitation tests, initialize a `2025-11-25` session, keep the `Mcp-Session-Id` response header on later requests, read the `elicitation/create` request from the call's event stream, and answer it with a separate POST.
- **Catalog drift.** Snapshot the `tools/list` result — names, descriptions, input and output schemas, hints — and review every diff. A changed tool is a changed contract for every host that remembered it.

Handler logic itself — scope checks, idempotency, tenant filters — is ordinary Effect code; test most of it below the transport with fake services, as in [Testing an Effect Application](testing-an-effect-application).

## Production checklist

- **Protocols.** List only the adapters you test; at most one stateless adapter; session clients need sticky routing, stateless requests do not.
- **Transport boundary.** `allowedOrigins` set to exact origins; logs on stderr for stdio; request-size limits and rate limits at the edge; no reliance on GET streams, resumption, or session expiry, which `layerHttp` does not implement.
- **Entrypoint.** Capability and MCP Layers merged directly into `HttpRouter.serve`; shared services (database, repositories, token verifier, request-state secret) provided outside it.
- **Authentication.** Public protected-resource metadata; `401` challenges that point at it; tokens verified for signature, issuer, audience equal to your resource URI, and expiry; the principal built from claims only.
- **Authorization.** Baseline scope at the edge, per-tool scopes in handlers, declared `InsufficientScope` failures that tell the model to ask for re-authorization; no `Principal` in the Layer graph; a missing principal dies.
- **Tenancy.** No tenant, actor, or role parameters; repositories take the tenant first; no token passthrough to downstream APIs.
- **Catalog.** One verb per tool with a stable prefix; descriptions that state returns, limits, and next steps; bounded parameters; hints set explicitly; `Tool.Strict` on writes; `EnabledWhen` to trim per client, never to authorize; a snapshot test of `tools/list`.
- **Confirmation.** Consequential writes confirmed through the client — `elicit` on session eras, `InputRequired` on the stateless era — with `requestState` sealed, expiring, bound to principal and arguments, and holding only what round 1 proved; the store re-validates at commit.
- **Idempotency.** Every write keyed by intent (natural key or a scoped client request id), claimed atomically with the write, first outcome replayed; never keyed on the JSON-RPC id.
- **Failures.** Domain outcomes declared; infrastructure failures turned into defects; an `ErrorReporter` provided to the capability Layers; fixed messages in low-level `InternalError`s.
- **Audit.** Subject, client id, tenant, tool, arguments digest, and idempotency key recorded for every write; `clientInfo` treated as self-reported.
- **Upgrades.** All MCP modules are unstable: pin Effect, rerun the in-process suite and the catalog snapshot on every upgrade.
