# The Effect 4 Handbook — A Guided Tour of Effect v4

> Source-grounded guide for humans and coding agents. Audited **2026-09-18** against published `effect@4.0.0-rc.115`, tag [`effect@4.0.0-rc.115`](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.115), commit [`4a05d491`](https://github.com/Effect-TS/effect/commit/4a05d4914fa2327a42bd75fe77c22c188becf3b4) (released 2026-09-11). Each module is labelled with its public import path and a stable/unstable marker.

---

## Orientation

### Version and validation scope

This edition describes the published `effect@4.0.0-rc.115` API, not unreleased `main`. The source audit covered all 138 stable modules exported from `effect`, all 20 public `effect/unstable/*` families (202 modules), the platform/SQL/AI/Atom/OpenTelemetry/Vitest packages, their tests and examples, and every canonical Markdown page in this site. Examples were checked with pnpm, Node's native TypeScript execution, TypeScript 7.0.2 in strict mode, and the Effect `@effect/tsgo` diagnostics. Short fragments may declare application-specific boundaries, but every Effect API shown is present in the audited release.

New to Effect 4? Start with [Getting Started](foundations/getting-started) — it covers the `rc` dist-tag trap (an untagged `npm install effect` still installs Effect 3), TypeScript and ESM settings, and a first program.

### What changed from rc.108 to rc.115

The previous edition of this handbook targeted `4.0.0-rc.108`. All seven releases `rc.109`–`rc.115` were published; nearly every breaking change landed in `rc.113`. If you are upgrading, check these first — the first three change bytes on the wire or on disk, so they need a coordinated deploy rather than a rename.

| Change | Since | What to do | Where |
| --- | --- | --- | --- |
| MessagePack removed; `SchemaBinary` is the binary format for RPC, cluster runner transports, and EventLog journals/remote messages | `rc.113` | Replace `RpcSerialization.layerMsgPack` with `layerSchemaBinary()` on both peers at once. `rc.108` and `rc.115` cluster runners cannot share the default binary transport; pinning both sides to `serialization: "ndjson"` is the only candidate bridge, and this handbook has not verified it across that version gap — rehearse a mixed-version rollout in staging, or replace the runners together. Pre-`rc.113` EventLog journals hold MessagePack payloads that the new codec cannot read. | [SchemaBinary](concurrency/streaming-channels#schemabinary), [RpcSerialization](interfaces/rpc#rpcserialization), [Cluster](systems/cluster-sharding), [EventLog](systems/event-log-event-sourcing) |
| `@effect/sql-pg` runs on a native wire-protocol client | `rc.113` | Re-check row schemas (`int8` → `bigint`, timestamps → epoch milliseconds, `date` → string, `bytea` → `Uint8Array`), wrap JSON parameters in `sql.json`, send one statement per query, and set `prepare: false` behind poolers that cannot keep named statements. | [Upgrading @effect/sql-pg](interfaces/sql#upgrading-effect-sql-pg-to-the-native-client) |
| `PersistedQueue` retry policy moved from `take` to `make`; exhausted or undecodable items are dead-lettered | `rc.113` | Move `maxAttempts` to `PersistedQueue.make`, add `layerCleanup`, and monitor failed elements. | [PersistedQueue](tooling/persistence#persistedqueue) |
| `Schema.toJsonSchemaDocument` leaves objects open by default (`"additionalProperties": true`) and compacts single annotations out of `allOf`; `OpenApi.fromApi` output stays closed | `rc.113` | Pass `{ onExcessProperty: "error" }` where consumers of a hand-generated JSON Schema relied on closed objects; refresh snapshot tests. | [JsonSchema](data/schema#jsonschema) |
| `Config` constructors are PascalCase; `Config.mapOrFail` → `Config.mapEffect` | `rc.113` | `Config.string` → `Config.String`, `Config.redacted` → `Config.Redacted`, `Config.url` → `Config.URL`, and so on. | [Configuration & Secrets](foundations/configuration-secrets) |
| CLI constructors are PascalCase; an omitted boolean flag is now a `MissingOption` error (`rc.110`) | `rc.113` | `Flag.integer` → `Flag.Int`, `Flag.float` → `Flag.Finite`, `Flag.choice` → `Flag.Literals`, `Prompt.text` → `Prompt.String`; add `Flag.withDefault(false)` to boolean flags. | [CLI Framework](tooling/cli-framework) |
| fast-check bridge removed; native Schema-first `Arbitrary` engine | `rc.113` | `Schema.toArbitrary(s)(FastCheck)` → `Arbitrary.schema(s)`; `{ fastCheck: { numRuns } }` → `{ arbitrary: { runs } }`; prefer constructive checks such as `Schema.isBetween` over opaque filters; re-record saved failures. `@effect/vitest` now requires Vitest 5. | [Arbitrary](tooling/testing-dev-tooling#arbitrary) |
| `Socket` is pull-based: scoped `reader` and `writer` replace `run` / `runString` / `runRaw`; server addresses are `NetAddress` values | `rc.113` | Rewrite handlers as a scoped pull loop; reconnect with `Effect.retry`; read addresses with `NetAddress.formatIp`. | [Socket](interfaces/platform-runtime-hosts#socket), [NetAddress](interfaces/platform-runtime-hosts#netaddress) |
| `FileSystem.Size` / `KiB` / `MiB` … removed in favor of the stable `ByteSize` module | `rc.113` | Compare `File.Info.size` with `ByteSize.isGreaterThan`; pass plain numbers for `chunkSize`. | [ByteSize](data/functional-toolkit#bytesize) |
| `SchemaGetter` / `SchemaTransformation` `transformOrFail` → `transformEffect`; revivers moved to `SchemaRepresentation`; parse options `"preserve"` and `propertyOrder` removed | `rc.113` | Rename; move operation-wide parse options from annotations to the decoder call; model extra properties with `Schema.Record` / `Schema.StructWithRest`. | [Schema](data/schema) |
| `Effectable.Class` is driven by an abstract `asEffect()` method; `Effectable.Mixin` added | `rc.113` | Implement `asEffect()`. | [Effectable](foundations/core-runtime-execution#effectable) |
| `Channel.runDone` removed | `rc.113` | Use `Channel.runDrain`. | [Channel](concurrency/streaming-channels#channel) |
| HTTP data-type schemas (`UrlParams`, `Headers`, `Cookies`) moved into `effect/Schema`; Web handler Layers build eagerly | `rc.113` | `UrlParams.schemaJsonField` → `Schema.JsonFromUrlParamsField`; expect build failures at handler creation rather than on the first request. | [HTTP Server](interfaces/http-server) |
| AI services use branded interfaces | `rc.113` | Refer to `LanguageModel`, `EmbeddingModel`, `Chat`, and `Reactivity` by their same-name type instead of `.Service`; custom implementations include `[TypeId]: TypeId`. | [AI & Language Models](systems/ai-language-models) |

New in this range: the stable `ByteSize` and `StandardSchema` modules; the unstable `arbitrary` and `net` families; `SchemaBinary`, `HttpStatus`, `Mime`, and `K8sTypes`; `Effectable.Mixin`; `Stream.catchDefect` / `Channel.catchDefect`; `Queue.flush`; `Pool.use` and `Pool.reserve`; `Match.fn`; `Schema.TaggedUnion.matchOrElse`, `Schema.JsonObject`, and `Schema.Graph`; a large set of `Graph` algorithms; four MCP protocol adapters; and scoped Redis pub/sub. The `effect` package now has zero runtime dependencies.

### Official upstream companions

These official resources complement the handbook with longer explanations and executable examples. The GitHub links are pinned to the same audited release so their code and this handbook stay reproducible together; the website guides track Effect's `main` branch, so where they differ from this handbook, the pinned release and this handbook win.

| Official Effect resource | Best use |
| --- | --- |
| [Effect v4 guides](https://effect.website/docs/v4/getting-started) | The official website's narrative guides — error management, requirements, resources, concurrency, streams, scheduling, Schema, and platform. Not release-pinned. Every handbook topic links the matching guides at the top of its page. |
| [Onboarding track](https://effect.website/docs/v4/onboarding) and [Installation](https://effect.website/docs/v4/getting-started/installation) | The motivational on-ramp and setup steps; the handbook's short version is [Getting Started](foundations/getting-started). |
| [Arbitrary guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.115/packages/effect/ARBITRARY.md) | The long-form reference for the native property-testing engine, with a [migration guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.115/packages/effect/ARBITRARY-MIGRATION.md) from the fast-check bridge. |
| [Comprehensive Schema guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.115/packages/effect/SCHEMA.md) | The long-form reference for codecs, validation, transformations, serialization, tooling, errors, integrations, and migration. |
| [AI documentation source](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.115/ai-docs/src) | Executable, topic-organized examples covering core Effect, streams, services, testing, HTTP, CLI, AI, cluster, and more. |
| [`LLMS.md`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.115/LLMS.md) | The generated single-file aggregate of the AI docs. It opens with Effect's coding conventions and links the topic-organized executable examples. |

Effect 4 ships as **one library**. The core `effect` package holds the runtime, standard library, and unstable subsystems (http, rpc, sql, cluster, ai, …), with platform-, driver-, and provider-specific satellites around it. One import surface, one version number, runtime built for speed and tree-shaking.

### The through-line: one type

Everything orbits a single type:

```ts
import { Effect } from "effect"

// An Effect<Success, Error, Requirements> is a *description* of a program that,
// when run, will either succeed with A, fail with a typed E, or need services R.
declare const loadEmployee: (id: string) => Effect.Effect<Employee, EmployeeNotFound, Hris>
//                                                          ▲ value     ▲ typed err       ▲ deps
```

Three type parameters; almost every module is "a thing you can put in one of those slots." A `Stream` is the many-valued sibling of the success channel. `Cause` is the full truth of the error channel. `Layer` satisfies the requirements channel.

Official guides: [The Effect Type](https://effect.website/docs/v4/getting-started/the-effect-type), [Why Effect?](https://effect.website/docs/v4/getting-started/why-effect).

### The house style (every example in this handbook uses it)

Idiomatic Effect 4 uses `Effect.gen` for inline composition and `Effect.fn` for functions returning effects (adds a tracing span and tidy stack traces automatically).

```ts
import { Effect, Schema } from "effect"

// Errors are schema-defined, tagged classes — serializable and pattern-matchable.
class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()("BudgetExceeded", {
  remaining: Schema.Finite,
  requested: Schema.Finite
}) {}

// Effect.fn("name") = a traced, generator-based function returning an Effect.
export const drawFromMeritBudget = Effect.fn("drawFromMeritBudget")(
  function*(remaining: number, raise: number) {
    if (raise > remaining) {
      // `return yield*` makes termination explicit to TypeScript.
      return yield* new BudgetExceeded({ remaining, requested: raise })
    }
    yield* Effect.log(`Approving raise of ${raise}`)
    return remaining - raise
  }
)
```

Services are classes that extend `Context.Service`; the implementation rides along as a static `Layer`:

```ts
import { Context, Effect, Layer } from "effect"

class Hris extends Context.Service<Hris, {
  readonly getEmployee: (id: string) => Effect.Effect<Employee>
}>()("comp/Hris") {
  static layer = Layer.effect(Hris, Effect.gen(function*() {
    yield* Effect.log("connecting to HRIS…")
    return Hris.of({ getEmployee: (id) => Effect.succeed({ id, level: "L4" } as Employee) })
  }))
}
```

**Dual APIs.** Most Effect functions ship two overloads with identical behavior: *data-last* (`Effect.map(f)` returns a function that expects the value, built for `.pipe(...)` chains) and *data-first* (`Effect.map(self, f)`, convenient for a single step). Rule of thumb: one step, data-first; several steps, `.pipe` with data-last. [`Function.dual`](data/functional-toolkit#function) builds the same pair for your own functions.

Official guides: [Guidelines](https://effect.website/docs/v4/code-style/guidelines), [Do notation vs generators](https://effect.website/docs/v4/code-style/do), [Dual APIs](https://effect.website/docs/v4/code-style/dual).

> **Note:** Modules imported from `"effect"` follow strict semver. Modules under `"effect/unstable/*"` (http, rpc, sql, cluster, ai, cli, workflow, and friends) are production-usable but may take breaking changes in minor releases — they graduate to the top level as they settle. Throughout the handbook, look for the stable and unstable badges on each module.

### The lay of the land

- **effect** — The core: 138 stable modules (Effect, Stream, Schema, Layer, the data structures, STM…) plus 20 public `unstable/` families (http, httpapi, rpc, sql, cluster, ai, cli, workflow, eventlog, encoding, reactivity, persistence, arbitrary, net, and more).

- **@effect/platform-*** — `node`, `bun`, `deno`, `browser`, plus the shared Node implementation package — concrete implementations of FileSystem, HttpServer, sockets, workers, and runtimes for each host.

- **@effect/sql-*** — Drivers: `pg`, `mysql2`, `mssql`, `clickhouse`, `libsql`, `d1`, `pglite`, and a family of `sqlite-*` variants.

- **@effect/ai-*** — Provider bindings: `anthropic`, `openai`, `openai-compat`, `openrouter` — concrete backends for the provider-agnostic AI modules.

- **@effect/atom-*** — Framework bindings for the reactive Atom system: `react`, `solid`, `vue`.

- **@effect/opentelemetry** — Bridges Effect's tracing/metrics/logging to a real OpenTelemetry SDK (Node SDK, Web SDK, exporters).

- **@effect/vitest** — First-class testing: `it.effect`, `TestClock`-aware assertions, layer-sharing helpers.

- **tools** — The repo's own build/codegen tooling — AI code/doc generators, an OpenAPI generator, the bundler and jsdoc pipeline.

**Import style.** Each module is labelled with its subpath (`effect/Queue`), while examples import from the `"effect"` barrel: `import { Effect, Queue } from "effect"`. The two are equivalent at runtime. The package declares no side effects, so bundlers with deep scope analysis (Rolldown, Rollup, Webpack 5+) tree-shake the barrel; `import * as Queue from "effect/Queue"` is the conservative form elsewhere. Unstable families are always imported by subpath, for example `effect/unstable/http`. Official guide: [Importing Effect](https://effect.website/docs/v4/getting-started/importing-effect).

### How to use this handbook

- **⌘K / Ctrl+K — search** — Jump to any of 340 modules by name. Type "semaphore", "TxRef", "HttpApi", "Sink" — hit enter and you land right on it, with the module highlighted.

- **Sidebar — browse by theme** — Chapters are grouped from foundations → concurrency → data → web → distributed → tooling. Roughly the order you'd grow into them.

- **Prev / Next — read it like a book** — Each chapter ends with navigation.

Major module entries cover what the API is, its mental model, a real example, and a "reach for it when" line. Smaller supporting modules stay compact so this remains useful as an agent reference.

> **Tip:** Every Effect API in this handbook is grounded in the audited implementation, tests, or package examples. Pin compatible `effect` and `@effect/*` versions together, and re-audit unstable imports before upgrading.
