# The Effect 4 Handbook — A Guided Tour of Effect v4

> Source-grounded guide for humans and coding agents. Audited **2026-10-01** against published `effect@4.0.0`, tag [`effect@4.0.0`](https://github.com/Effect-TS/effect/tree/effect%404.0.0), commit [`67ba4e46`](https://github.com/Effect-TS/effect/commit/67ba4e46a11ccda0b6761578bfd22c04ae00167d) (released 2026-10-01). Each module is labelled with its public import path and a stable/unstable marker.

---

## Orientation

### Version and validation scope

This edition describes the published `effect@4.0.0` API — the first stable release of Effect 4 — not unreleased `main`. The source audit covered all 138 modules exported from the `effect` root barrel, all 20 public `effect/<area>` families (213 modules), the platform/SQL/AI/Atom/OpenTelemetry/Vitest packages, their tests and examples, and every canonical Markdown page in this site. Examples were checked with pnpm, Node's native TypeScript execution, TypeScript 7.0.2 in strict mode, and the Effect `@effect/tsgo` diagnostics. Short fragments may declare application-specific boundaries, but every Effect API shown is present in the audited release.

New to Effect 4? Start with [Getting Started](foundations/getting-started) — it covers installation (`npm install effect` now installs Effect 4), TypeScript and ESM settings, and a first program.

### Stability and support

Effect 4.0 is a stable release with a published long-term-support policy: **bug fixes until September 2029 or one year after 5.0 ships, and security fixes until September 2029 or two years after 5.0 ships, whichever is later.** Every `effect` and `@effect/*` package shares one version number and is released together, so an upgrade is one coordinated bump.

Stability is declared per API with a JSDoc tag, not by import path:

| Tag | Promise | Where you meet it |
| --- | --- | --- |
| *(no tag)* | Semantic versioning: breaking changes only in a major release. | Everything imported from `"effect"` — `Effect`, `Layer`, `Schema`, `Stream`, `Config`, the data structures, the `Tx*` transactional modules — plus `effect/testing` and the text codecs under `effect/encoding`. |
| `@stability unstable` | May change in a **minor** release. Production-ready; pin exact versions and read release notes before upgrading. | The subsystem families under `effect/<area>` — `http`, `http-api`, `rpc`, `sql`, `cluster`, `workflow`, `ai`, `cli`, `reactivity`, `persistence`, `eventlog`, `observability`, `net`, `socket`, `process`, `workers`, `devtools`, `schema` — the `Arbitrary` module, a set of advanced `Schema` APIs, and every API that exposes a third-party dependency (driver options and clients in `@effect/sql-*`, provider clients and generated schemas in `@effect/ai-*`, `@effect/opentelemetry`, the `vitest` re-export in `@effect/vitest`, Redis and undici accessors in the platform packages). |
| `@stability experimental` | May change in a **patch** release. | A small number of APIs that the maintainers are still shaping; the handbook names them where they appear. |

"Unstable" describes the compatibility contract, not the quality: HTTP, SQL, and RPC are what production Effect applications are built on. Every handbook section carries a stable or unstable badge for its module. This handbook describes the pinned release only and does not track release-by-release changes; the per-package `CHANGELOG.md` files in the Effect repository are the authoritative record of what changed between versions.

**Coming from a 4.0 release candidate?** The release candidates kept the subsystem families under `effect/unstable/*`; the stable release moved them to `effect/<area>` with no compatibility exports. Drop the `unstable/` segment (`effect/unstable/http` → `effect/http`), rename `httpapi` to `http-api`, import `Arbitrary` from `"effect"`, and replace the removed `effect/Encoding` module with the format modules under `effect/encoding` (`Base64`, `Base64Url`, `Hex`, `EncodingError`). Service keys and type ids that embedded `httpapi` or `Encoding` changed with them, so re-check persisted or serialized references.

### Official upstream companions

These official resources complement the handbook with longer explanations and executable examples. The GitHub links are pinned to the same audited release so their code and this handbook stay reproducible together; the website guides track Effect's `main` branch, so where they differ from this handbook, the pinned release and this handbook win.

| Official Effect resource | Best use |
| --- | --- |
| [Effect v4 guides](https://effect.website/docs/v4/getting-started) | The official website's narrative guides — error management, requirements, resources, concurrency, streams, scheduling, Schema, and platform. Not release-pinned. Every handbook topic links the matching guides at the top of its page. |
| [API reference](https://effect.website/docs/v4/api) | Generated per-module reference for every `effect` and `@effect/*` package, versioned per release. |
| [Onboarding track](https://effect.website/docs/v4/onboarding) and [Installation](https://effect.website/docs/v4/getting-started/installation) | The motivational on-ramp and setup steps; the handbook's short version is [Getting Started](foundations/getting-started). |
| [`AGENTS.md` and `ai-docs/`](https://github.com/Effect-TS/effect/blob/effect%404.0.0/LLMS.md) shipped inside the `effect` package | The maintainers' own coding conventions for agents (also published as `LLMS.md`), with topic-organized executable examples under `node_modules/effect/ai-docs/src`. See [Coding conventions for agents](#coding-conventions-for-agents) below for how this handbook relates to it. |
| [Migration guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0/MIGRATION.md) | The official v3 → v4 guide: import and API rename maps, services, causes, error handling, forking, layers, scopes, and the Schema v4 migration. |
| [Arbitrary guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/ARBITRARY.md) | The long-form reference for the native property-testing engine. |
| [Comprehensive Schema guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/SCHEMA.md) | The long-form reference for codecs, validation, transformations, serialization, tooling, errors, integrations, and migration. |

Effect 4 ships as **one library**. The core `effect` package holds the runtime, standard library, and the subsystem families (http, rpc, sql, cluster, ai, …), with platform-, driver-, and provider-specific satellites around it. One import surface, one version number, zero runtime dependencies, a runtime built for speed and tree-shaking.

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

### Coding conventions for agents

The `effect` package ships its maintainers' conventions as `AGENTS.md` (the same text as the repository's `LLMS.md`), and this handbook follows them. The rules that matter most when generating code:

- **Generators over combinator chains.** Write inline logic with `Effect.gen`; write reusable functions with `Effect.fn("name")` when a tracing span is useful and `Effect.fnUntraced` when it is not (library internals, hot paths). Do not write a function whose only body is `return Effect.gen(...)`. Attach extra behaviour as trailing arguments to `Effect.fn` rather than `.pipe` on its result.
- **Return when you fail.** Inside a generator, write `return yield* new SomeError(...)` so TypeScript knows the function does not continue.
- **Errors are `Schema.TaggedError` classes**, recovered with `Effect.catchTag` / `Effect.catchTags` for specific tags and `Effect.catch` for everything. Model variants inside one error with a tagged `reason` field and `Effect.catchReason`.
- **Behaviour lives in services.** Define a service with `Context.Service<Self, Interface>()("package/path/Name")`, attach its implementation as a static `layer`, and build it with `Service.of({...})`. Use `Context.Reference` for values with a default (configuration, feature flags).
- **Validate with `Schema`, never by hand.** Untrusted input is decoded with a schema; domain models are `Schema.Class`es. For runtime type guards on `unknown`, use the `Predicate` module instead of writing `isString`-style helpers.
- **Time goes through `DateTime` and `Clock`**, not `Date.now()`, so it is testable.
- **Run at the edge.** `NodeRuntime.runMain` or `Layer.launch` for a process; `ManagedRuntime` when a host framework calls in.
- **Observability is built in.** Prefer the lightweight `Otlp` modules from `effect/observability` in new projects; use `@effect/opentelemetry` when joining an existing OpenTelemetry setup.

Two tooling habits make agents measurably more effective with Effect: install the Effect language service (`@effect/tsgo`, see [Effect diagnostics](foundations/getting-started#effect-diagnostics-in-the-editor-and-in-ci)) so a wrong channel or an un-yielded Effect is a compiler error rather than a runtime surprise, and keep the installed `effect` source in reach — the official guidance is to prefer the installed package and its `ai-docs` over other copies of the documentation, which may describe a different version.

### The lay of the land

- **effect** — The core: 138 root modules (Effect, Stream, Schema, Layer, the data structures, STM…) plus 20 public `effect/<area>` families (http, http-api, rpc, sql, cluster, ai, cli, workflow, eventlog, encoding, reactivity, persistence, net, testing, and more).

- **@effect/platform-*** — `node`, `bun`, `deno`, `browser`, plus the shared Node implementation package — concrete implementations of FileSystem, HttpServer, sockets, workers, and runtimes for each host.

- **@effect/sql-*** — Drivers: `pg`, `mysql2`, `mssql`, `clickhouse`, `libsql`, `d1`, `pglite`, and a family of `sqlite-*` variants.

- **@effect/ai-*** — Provider bindings: `anthropic`, `openai`, `openai-compat`, `openrouter`, `typesafe` — concrete backends for the provider-agnostic AI modules.

- **@effect/atom-*** — Framework bindings for the reactive Atom system: `react`, `solid`, `vue`.

- **@effect/opentelemetry** — Bridges Effect's tracing/metrics/logging to a real OpenTelemetry SDK (Node SDK, Web SDK, exporters).

- **@effect/vitest** — First-class testing: `it.effect`, `TestClock`-aware assertions, layer-sharing helpers, property tests over the native `Arbitrary` module.

- **tools** — The repo's own build/codegen tooling — AI code/doc generators, an OpenAPI generator, `@effect/doctest`, the bundler and jsdoc pipeline.

**Import style.** Each module is labelled with its subpath (`effect/Queue`), while examples import from the `"effect"` barrel: `import { Effect, Queue } from "effect"`. The two are equivalent at runtime. The package declares no side effects, so bundlers with deep scope analysis (Rolldown, Rollup, Webpack 5+) tree-shake the barrel; `import * as Queue from "effect/Queue"` is the conservative form elsewhere. Area families are always imported by their own barrel, for example `import { HttpClient } from "effect/http"`. Official guide: [Importing Effect](https://effect.website/docs/v4/getting-started/importing-effect).

### How to use this handbook

- **⌘K / Ctrl+K — search** — Jump to any of 350 modules by name. Type "semaphore", "TxRef", "HttpApi", "Sink" — hit enter and you land right on it, with the module highlighted.

- **Sidebar — browse by theme** — Chapters are grouped from foundations → concurrency → data → web → distributed → tooling. Roughly the order you'd grow into them.

- **Prev / Next — read it like a book** — Each chapter ends with navigation.

Major module entries cover what the API is, its mental model, a real example, and a "reach for it when" line. Smaller supporting modules stay compact so this remains useful as an agent reference.

> **Tip:** Every Effect API in this handbook is grounded in the audited implementation, tests, or package examples. Pin compatible `effect` and `@effect/*` versions together, and re-audit unstable imports before upgrading.
