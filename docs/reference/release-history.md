# Release History

This page records how the handbook has evolved: one entry per audited Effect release, newest first. Each entry names the release the handbook was audited against, the changes in Effect that a reader of the previous entry needs to know about, and what changed in the handbook itself.

It is a curated reader's changelog, not a copy of Effect's. Entries keep only what changes how you write or operate Effect code: behavior, types, stability, renamed options, span and metric names, and new public surfaces. Fixes that only made the implementation match what the handbook already described are left out. The per-package `CHANGELOG.md` files in the [Effect repository](https://github.com/Effect-TS/effect) stay the authoritative record of every change.

**Reading it when you upgrade.** Find the entry for the version you are pinned to, then read every entry above it. Each entry's items link to the handbook section that now owns the topic. Read that section rather than the summary line. Editions are published per `major.minor` (see [Match the edition to the installed Effect version](agent-guide#match-the-edition-to-the-installed-effect-version)); a patch release updates its edition in place and gets its own entry here.

## `effect@4.0.2` — audited 2026-10-09

Edition **4.0** (updated in place). Tag [`effect@4.0.2`](https://github.com/Effect-TS/effect/tree/effect%404.0.2), commit `269a7c86`, published 2026-10-07. Baseline: `effect@4.0.0`. Range reviewed: every 4.0.1 and 4.0.2 changelog entry across all packages.

### Changes in Effect that matter to readers

**Stability**

- Every module and directly importable export now carries an explicit `@stability` tag ([#8770](https://github.com/Effect-TS/effect/pull/8770)). Nineteen modules the handbook had badged `stable` are tagged `unstable`: `FileSystem`, `Path`, `Terminal`, `Stdio`, `Crypto`, `PlatformError`, `ExecutionPlan`, `ErrorReporter`, `LayerMap`, `LayerRef`, `Graph`, `HashRing`, `ByteSize`, `Newtype`, `PartitionedSemaphore`, `TxChunk`, `ChannelSchema`, `TestConsole`, and `TestSchema` (that last badge was already wrong in the 4.0.0 edition). No API is tagged `experimental`. See [Stability and support](../#stability-and-support).

**Runtime, errors, and caching**

- `Effect.retry` no longer retries a cause that contains a defect or an interruption, even alongside a typed failure the policy would accept ([#8799](https://github.com/Effect-TS/effect/pull/8799)). See [Failure, Retry, Fallback, and Interruption](../deep-dives/failure-retry-fallback-and-interruption).
- When an uninterruptible region fails while an interruption is pending, recovery handlers are skipped and the typed failure is dropped; the fiber exits interrupted, keeping any defects ([#8652](https://github.com/Effect-TS/effect/pull/8652)). See [Fiber](../foundations/core-runtime-execution#fiber).
- `Config.orElse` recovers only a pure `ConfigError`; a cause that mixes it with a defect or interruption propagates ([#8808](https://github.com/Effect-TS/effect/pull/8808)). See [Configuration & Secrets](../foundations/configuration-secrets).
- `Effect.cached`, `cachedWithTTL`, `cachedInvalidateWithTTL`, and `Cache` treat interruption as abandonment: an interrupted computation is never cached, and it is interrupted only once every waiting caller has gone ([#8719](https://github.com/Effect-TS/effect/pull/8719)). `cachedInvalidateWithTTL` accepts a TTL computed from the `Exit` ([#8734](https://github.com/Effect-TS/effect/pull/8734)). See [Caching & Batching](../operations/caching-batching).

**Streams and STM**

- `Stream.scan` emits its seed for an empty stream ([#8704](https://github.com/Effect-TS/effect/pull/8704)). `groupedWithin`, `aggregateWithin`, and `aggregate` pause their schedule while idle ([#8718](https://github.com/Effect-TS/effect/pull/8718)). `groupBy` and `partition` substreams shut down their queue when the consumer stops early ([#8857](https://github.com/Effect-TS/effect/pull/8857)). See [Streaming & Channels](../concurrency/streaming-channels).
- Waiting on `TxSemaphore` and `TxReentrantLock` is interruptible ([#8805](https://github.com/Effect-TS/effect/pull/8805)); PubSub rejects `NaN` and fractional capacities ([#8790](https://github.com/Effect-TS/effect/pull/8790)).

**Telemetry names (update dashboards and alerts)**

- Interrupt-only spans end with status `Unset` and `effect.fiber.interrupted: true` instead of `Ok` ([#8864](https://github.com/Effect-TS/effect/pull/8864)).
- `OtlpMetrics` exports a summary as one OTLP `Summary` metric named by its id instead of `<id>_quantiles` / `_count` / `_sum` ([#8869](https://github.com/Effect-TS/effect/pull/8869)).
- With `@effect/opentelemetry`, a span without an Effect parent inherits the active OpenTelemetry span ([#8586](https://github.com/Effect-TS/effect/pull/8586)). See [Observability](../operations/observability).
- SQL statement spans are named by `db.namespace`, `server.address[:server.port]`, or `db.system.name` (falling back to `sql.execute`), record `effect.sql.method`, and transactions emit `effect.sql.transaction.*` events ([#8866](https://github.com/Effect-TS/effect/pull/8866)). See [SQL](../interfaces/sql).
- RPC spans are named by the method tag with no default prefix and record `rpc.system.name` and `rpc.method`; pass `spanPrefix` to keep the old names ([#8867](https://github.com/Effect-TS/effect/pull/8867)). See [RPC](../interfaces/rpc).
- HTTP server spans capture no request or response headers unless `HttpMiddleware.TracerHeaderFilter` opts them in ([#8873](https://github.com/Effect-TS/effect/pull/8873)). See [HTTP Server](../interfaces/http-server).
- GenAI telemetry follows the current OpenTelemetry conventions: `addGenAIAnnotations` takes `provider: { name }` (the `system` option is removed), and Anthropic usage includes cached tokens ([#8870](https://github.com/Effect-TS/effect/pull/8870)). See [AI & Language Models](../systems/ai-language-models).

**Interfaces and AI**

- HttpApi answers a response-encoding failure with `500` and reports it to `ErrorReporter`; request-decoding failures stay `400` and unreported ([#8834](https://github.com/Effect-TS/effect/pull/8834)). See [HttpApi](../interfaces/http-api).
- RPC socket clients accept `pingInterval` and `pingTimeout` ([#8825](https://github.com/Effect-TS/effect/pull/8825)).
- `McpServer.layerHttp` gains opt-in `allowSessionTermination` ([#8773](https://github.com/Effect-TS/effect/pull/8773)). See [Exposing an Effect Application over MCP](../deep-dives/exposing-an-effect-application-over-mcp).
- `DecisionModel.decide` accepts images for providers that opt in ([#8832](https://github.com/Effect-TS/effect/pull/8832)); Anthropic preserves multiple system instructions ([#8603](https://github.com/Effect-TS/effect/pull/8603)).
- PostgreSQL `SqlEventJournal` stores entry and remote ids as `BYTEA`; existing tables need a migration ([#8756](https://github.com/Effect-TS/effect/pull/8756)). See [Event Log & Event Sourcing](../systems/event-log-event-sourcing).
- `Schema.toTaggedUnion` and `Schema.TaggedUnion` expose the discriminator key as `.tag` ([#8748](https://github.com/Effect-TS/effect/pull/8748)). See [Schema](../data/schema).

**New public surfaces**

- `effect/Version` (unstable): the `effect` version reported in telemetry. See [Version](../foundations/core-runtime-execution#version).
- `@effect/ai-cloudflare`: a Cloudflare Workers AI `DecisionModel` provider. See [AI & Language Models](../systems/ai-language-models).

### Changes in the handbook

- Corrected every claim the delta made false (above), flipped the nineteen stability badges, and rewrote the stability tables in Orientation and Getting Started.
- Replaced the dead **Official Effect → Cookbooks** navigation link: the tagged source has no `cookbooks/` folder, and the only upstream cookbook is published as the official [v4 Schedule cookbook](https://effect.website/docs/v4/scheduling/cookbook).
- `pnpm docs:links` now also checks the navigation menu, the VitePress config and theme, the README, and the agent skills, and names where each failing URL is linked from.
- Added this Release History page; `pnpm docs:check` requires an entry for every audited release.
- Validation: 714 fences, all passing strict TypeScript 7 and strict Effect diagnostics; new runtime probes for `Stream.scan` on empty streams, `Effect.retry` with defect causes, and pending interruption over a failed uninterruptible region.

## `effect@4.0.0` — audited 2026-10-01

Edition **4.0** (first edition). Tag [`effect@4.0.0`](https://github.com/Effect-TS/effect/tree/effect%404.0.0), commit `67ba4e46`, published 2026-10-01: the first stable release of Effect 4. Baseline: `effect@4.0.0-rc.116`. Range reviewed: `rc.117`, `rc.118`, and `4.0.0`.

### Changes in Effect that matter to readers

- The subsystem families moved from `effect/unstable/<area>` to `effect/<area>` with no compatibility exports; `httpapi` became `http-api` (including service keys and type ids), `Arbitrary` became a root module, and `effect/Encoding` was replaced by `effect/encoding/{Base64, Base64Url, Hex, EncodingError}`. See [Stability and support](../#stability-and-support).
- Stability became a per-API `@stability` tag rather than a path segment, with a published long-term-support policy.
- API and behavior changes folded into the pages included Schema check renames, single-identifier type-only `Schema.brand`, `[successes, failures]` ordering for `partition` and `separate` helpers, `Scope.close` requiring `Scope.Closeable`, `Queue.takeN` and shutdown semantics, `Effect.race*` interrupting losers, and fixes across HttpRouter, HttpApi, MCP, `@effect/sql-pg`, Atom, and workflows.

### Changes in the handbook

- Swept every page of release-candidate prose and re-verified each claim against the tagged source; rewrote Getting Started for a stable release; added Stability and support, Official upstream companions, and Coding conventions for agents to the Orientation page.
- Added the long-form [MCP deep dive](../deep-dives/exposing-an-effect-application-over-mcp), Markdown twins for every page, `llms.txt`, and the agent reading protocol ([PR #2](https://github.com/eugene1g/effect-handbook/pull/2)).
- Routed web-framework intents (Express, Hono, Fastify) to `ManagedRuntime` in the capability catalog ([PR #3](https://github.com/eugene1g/effect-handbook/pull/3)).
- Introduced editions: one handbook per Effect `major.minor`, served at `/<major.minor>/`, with an edition switcher and `versions.json` ([PR #4](https://github.com/eugene1g/effect-handbook/pull/4)).

## `effect@4.0.0-rc.116` — audited 2026-09-19

Pre-release, before editions existed. Tag [`effect@4.0.0-rc.116`](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.116), commit `d62dd0d6`. Baseline: `effect@4.0.0-rc.108`. Summarized from [PR #1](https://github.com/eugene1g/effect-handbook/pull/1).

### Changes in Effect that matter to readers

- `Stream.partition` returns `[passes, fails]` and takes `capacity`; `Stream.mapBoth` takes `{ onElement, onError }`; the `Stream.scan` seed became a thunk; `Effect.orElseSucceed` receives the error.
- `SchemaGetter` and `SchemaTransformation` became plain data with standalone combinators; `ByteSize.Input` string literals must be whole numbers with a unit.
- Added `Decision` / `DecisionModel`, the Schema compilers, PostgreSQL session settings, HTTP `QUERY`, and the MCP `2026-07-28` adapter. Earlier release candidates (through rc.113) brought PascalCase `Config` and CLI constructors, `SchemaBinary`, the native `Arbitrary` engine, and `ByteSize`.

### Changes in the handbook

- Made the handbook Effect 4 only (removed the Effect 3 migration page), linked the official effect.website v4 guides from every topic, and added seven pages and three capabilities with retrieval cases.
