# GraphQL

Typed operations for consuming a GraphQL API, not a GraphQL server framework. All seven `effect/graphql` modules are **experimental**: pin matching packages and re-audit on every upgrade. Prefer [HttpApi](./http-api) for an Effect-owned HTTP contract, and [RPC](./rpc) for an Effect-to-Effect procedure protocol.

## GraphQL

`effect/graphql/GraphQL` — experimental

`query`, `mutation`, and `subscription` describe a named document, variables, and a result Schema. Variables are encoded before sending; results are decoded before returning, so transformed scalars retain distinct decoded and wire types. The constructors do not validate a handwritten GraphQL document against a server schema: use the generator for that check. `Variables`, `Result`, `Error`, and `Services` project an operation's types. `enumLiterals` and `otherTypename` support generated enum and abstract-type schemas.

```ts
// This example deliberately uses the experimental GraphQL client family.
// @effect-diagnostics experimentalApiUsage:off
import { Effect, Layer, Schema } from "effect"
import { GraphQL, GraphQLClient, GraphQLGroup, GraphQLProtocol } from "effect/graphql"
import { FetchHttpClient } from "effect/http"

const Viewer = GraphQL.query("Viewer", {
  document: "query Viewer { viewer { login } }",
  result: Schema.Struct({ viewer: Schema.Struct({ login: Schema.String }) })
})

export const viewer = Effect.gen(function*() {
  const client = yield* GraphQLClient.make(GraphQLGroup.make(Viewer))
  return yield* client.Viewer()
}).pipe(
  Effect.provide(
    GraphQLProtocol.layerHttp({ url: "https://api.example.com/graphql" }).pipe(
      Layer.provide(FetchHttpClient.layer)
    )
  )
)
```

**Reach for it when** defining a typed operation by hand or inspecting generated operation types.

## GraphQLGroup

`effect/graphql/GraphQLGroup` — experimental

`make(...operations)` collects operations; `merge(...groups)` assembles a client surface. Method names come from operation names. Attach `.middleware(Service)` to an operation or a group. Group middleware run outside operation middleware, in attachment order within each level. Keep names unique when combining documents.

**Reach for it when** exposing only the operations an application capability needs.

## GraphQLClient

`effect/graphql/GraphQLClient` — experimental

`make(group)` acquires the protocol and middleware implementations and produces one typed method per operation. Queries and mutations return Effects; subscriptions return Streams. Per-call headers and context let callers supply request-local data without capturing it at client construction.

By default, a response carrying GraphQL `errors` fails even when it also carries `data`. `{ partial: true }` returns a `PartialResult` with decoded data when available and the errors alongside it; it does not make malformed data valid. GraphQL non-null propagation still applies: a failed non-null field can null its nearest nullable ancestor, or all of `data`.

`pages(method, { variables, connection })` lazily fetches forward cursor pages; `items` flattens their `nodes`. The method must declare a nullable string `after` variable, omitted from the supplied initial variables, and the selected connection must include `pageInfo`. `items` additionally needs `nodes`. A cap on pages limits requests, while a cap on items may fetch a whole last page. Retrying the entire Stream starts again from the beginning, not the last failed page.

Subscriptions reconnect after retryable failures using `defaultSubscriptionRetry` (or `subscriptionRetry`); the default respects `retryAfter`. Reconnection does not replay missed events. Ordinary queries and mutations do not acquire safe retry semantics just because their errors expose `isRetryable`: a mutation may already have committed.

`makeTest` and `layerTest` accept typed operation handlers for application tests without a transport. They bypass encoding, decoding, and middleware; they do not prove server validation, HTTP behavior, authentication, or subscription reconnection. Test those boundaries with a real protocol and controlled HTTP/socket responses instead.

**Reach for it when** executing operations, paging connections, or replacing a GraphQL dependency in a use-case test.

## GraphQLClientError

`effect/graphql/GraphQLClientError` — experimental

Catch the outer `GraphQLClientError`, then inspect `reason._tag`:

| Reason | Boundary that failed |
| --- | --- |
| `EncodeError` | Variables could not be encoded; nothing sent. |
| `DecodeError` | A result did not match its Schema. |
| `ResponseError` | GraphQL errors, retaining raw data and error paths. |
| `TransportError` | HTTP/socket/protocol failure, including responses that are not GraphQL envelopes. |
| `PaginationError` | Invalid or non-progressing cursor pagination. |

The wrapper exposes `isRetryable`, `retryAfter`, response `headers`, and `status` when available. `GraphQLError` preserves extra JSON fields, including provider-specific error types. A GraphQL error body on a 5xx is a `ResponseError`; a non-GraphQL body is a `TransportError`. Read provider rate-limit headers as well as `isRetryable`: a provider can report an exhausted budget in a GraphQL error with HTTP 200. Never retry mutations solely on this flag.

**Reach for it when** distinguishing schema defects, transport failures, provider errors, and rate limits.

## GraphQLMiddleware

`effect/graphql/GraphQLMiddleware` — experimental

Define a `Service` and provide its implementation as a Layer. Implementations have `execute` and `subscribe`; `mapRequest` transforms requests for both. Middleware can require request-local services and add its own typed errors to calls. It sees raw execution results from `next`, including GraphQL errors, before client result decoding; transport failures fail `next` instead. This is client middleware: adding a bearer token is not verifying it on the server.

**Reach for it when** attaching credentials, recording rate-limit headers, or applying replay-safe per-operation policy.

## GraphQLProtocol

`effect/graphql/GraphQLProtocol` — experimental

`layerHttp({ url })` uses an `HttpClient` for queries/mutations and HTTP SSE subscriptions; `layerWebSocket` supplies the WebSocket transport. Supply a Socket constructor/host layer appropriate to the runtime. The WebSocket protocol is `graphql-transport-ws`, not the older `subscriptions-transport-ws` protocol.

The HTTP `url` may also be a function evaluated per request with the call's services, or an `Effect<string>`. This supports per-tenant endpoints without constructing one global client per tenant. That overload uses HTTP/SSE only: combining HTTP with `subscriptions.webSocket` requires a static string URL. Resolver batching partitions by the resolved URL; it must not combine calls to different endpoints. A URL partition is not an authorization partition: still key batching by every request-local identity the middleware reads.

**Reach for it when** choosing HTTP/SSE versus WebSocket or routing calls to request-dependent endpoints.

## GraphQLResolver

`effect/graphql/GraphQLResolver` — experimental

`ordered` maps a list result to input keys by position; `findById` matches returned objects by a key. `request(resolver)` turns either into a lookup function participating in Effect request batching. `path` selects the result list and `typename` narrows abstract results. Missing/null/wrong-type entries fail their own lookup with `NoSuchElementError`; errors with an entry-specific GraphQL path can fail just that entry, while transport, decoding, or unscoped GraphQL errors fail the batch. Bound batch size to the server's actual list/page limit; a truncated result must not silently become “not found.”

`aliased` combines generated document templates into one request, renaming variables and root fields, then decodes each slice with its operation Schema. Equal encoded variables share a slice; the default cap is ten slices. Handwritten document strings lack the generator's rename metadata. Pathless errors fail all slices; non-null propagation can also destroy shared data. Middleware sees the batched `request.query`, so persisted-document allowlists or signatures must account for the rewritten document.

When middleware requires a per-call service, supply the required `batchKey` derived from that service so different users or tenants cannot share a call. Context References with defaults do not appear in the requirement channel: do not assume this type check discovers every hidden identity dependency.

**Reach for it when** replacing N+1 GraphQL calls with bounded, identity-aware request batches.

## GraphQL generator

`@effect/graphql-generator/Config` — experimental

**pkg @effect/graphql-generator** — provides the `graphqlgen` CLI and public tool modules through subpath exports; there is no package-root entry point. `bin`, `main`, and `internal/*` are not public imports. Pin it with `effect` and its `@effect/platform-node` peer to the same release.

```ts
// The generator configuration API is intentionally experimental too.
// @effect-diagnostics experimentalApiUsage:off
import { defineConfig } from "@effect/graphql-generator/Config"

export default defineConfig({
  schema: "./schema.graphql",
  documents: ["src/**/*.graphql"],
  scalars: { DateTime: "effect/Schema#DateTimeUtcFromString" },
  importExtension: ".ts"
})
```

Run `graphqlgen`, `graphqlgen --watch`, or `graphqlgen --check` (CI, no writes); `--config` selects a different config. One config targets one SDL or introspection schema. The CLI imports TypeScript configuration directly: Node 22.18+ needs erasable syntax, or use Bun/Deno. Document globs are relative to the config and reject absolute patterns.

For programmatic tooling, `@effect/graphql-generator/Generator.generate(config, { cwd })` returns generated files, stale-file deletions, and diagnostics **in memory**, requiring `FileSystem` and `Path`; it does not write files itself. Error diagnostics leave the returned file/deletion lists empty. This is the public generator entry point; do not import its parser/emitter internals.

The generator validates documents and writes sibling `.graphql.ts` / `.gql.ts` modules plus a shared schema module. Generated exports include operations, a group, fragment schemas, and named decoded interfaces. Object selections, ordinary input objects, and object fragments use a `Schema.Struct` const with a same-named interface, rather than the earlier Opaque class shape; abstract unions and one-of inputs retain their specialized forms. Use exported interfaces in explicit annotations when structural editor hovers become large.

Built-in `Int` is 32-bit, `Float` finite, and `ID` string. `DateTime` defaults to a UTC DateTime codec and `URI` to string; unmapped custom scalars fall back to `Schema.Json` with a warning. Scalar mappings name an exported Schema codec (`module#export`): generation does not prove that module exists, so compile the output too.

Commit generated files, exclude them from formatting, and gate drift with `--check`. Successful generation removes only orphan document outputs carrying the matching generated header, not arbitrary files or the shared module. Watch mode installs watchers before its initial generation, preserves last-good output on errors, and does not reload modules imported by the config: restart after changing those modules.

**Reach for it when** consuming an existing schema with many operations, fragments, custom scalars, subscriptions, or aliased batching.

Pinned implementation and examples: [GraphQL source](https://github.com/Effect-TS/effect/tree/effect%404.0.5/packages/effect/src/graphql), [client tests](https://github.com/Effect-TS/effect/tree/effect%404.0.5/packages/effect/test/graphql), and [generator](https://github.com/Effect-TS/effect/tree/effect%404.0.5/packages/tools/graphql-generator).
