# The Effect 4 Handbook — A Guided Tour of Effect v4

> Source-grounded guide for humans and coding agents. Audited **2026-08-12** against published `effect@4.0.0-rc.108`, tag [`effect@4.0.0-rc.108`](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108), commit [`bef7bf38`](https://github.com/Effect-TS/effect/commit/bef7bf38ae4b73d5511043f707aed083de5da7cc) (released 2026-08-12). Each module is labelled with its public import path and a stable/unstable marker.

---

## Orientation

### Version and validation scope

This edition describes the published `effect@4.0.0-rc.108` API, not unreleased `main`. The source audit covered all 136 stable modules exported from `effect`, all 18 public `effect/unstable/*` families, the platform/SQL/AI/Atom/OpenTelemetry/Vitest packages, their tests and examples, and every canonical Markdown page in this site. Examples were checked with pnpm, Node's native TypeScript execution, TypeScript 7.0.2 in strict mode, and the Effect `@effect/tsgo` diagnostics. Short fragments may declare application-specific boundaries, but every Effect API shown is present in the audited release.

### Official upstream companions

These official resources complement the handbook with longer explanations and executable examples. The links are pinned to the same audited release so their code and this handbook stay reproducible together.

| Official Effect resource | Best use |
| --- | --- |
| [Cookbooks](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/cookbooks) | Focused, task-oriented recipes. The collection is intentionally small and grows independently of this handbook. |
| [Comprehensive Schema guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/SCHEMA.md) | The long-form reference for codecs, validation, transformations, serialization, tooling, errors, integrations, and migration. |
| [AI documentation source](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src) | Executable, topic-organized examples covering core Effect, streams, services, testing, HTTP, CLI, AI, cluster, and more. |
| [`LLMS.md`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/LLMS.md) | The generated single-file aggregate of the AI docs. It opens with Effect's coding conventions and links the topic-organized executable examples. |

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

> **Note:** Modules imported from `"effect"` follow strict semver. Modules under `"effect/unstable/*"` (http, rpc, sql, cluster, ai, cli, workflow, and friends) are production-usable but may take breaking changes in minor releases — they graduate to the top level as they settle. Throughout the handbook, look for the stable and unstable badges on each module.

### The lay of the land

- **effect** — The core: 136 stable modules (Effect, Stream, Schema, Layer, the data structures, STM…) plus 18 public `unstable/` families (http, httpapi, rpc, sql, cluster, ai, cli, workflow, eventlog, encoding, reactivity, persistence, and more).

- **@effect/platform-*** — `node`, `bun`, `deno`, `browser`, plus the shared Node implementation package — concrete implementations of FileSystem, HttpServer, sockets, workers, and runtimes for each host.

- **@effect/sql-*** — Drivers: `pg`, `mysql2`, `mssql`, `clickhouse`, `libsql`, `d1`, `pglite`, and a family of `sqlite-*` variants.

- **@effect/ai-*** — Provider bindings: `anthropic`, `openai`, `openai-compat`, `openrouter` — concrete backends for the provider-agnostic AI modules.

- **@effect/atom-*** — Framework bindings for the reactive Atom system: `react`, `solid`, `vue`.

- **@effect/opentelemetry** — Bridges Effect's tracing/metrics/logging to a real OpenTelemetry SDK (Node SDK, Web SDK, exporters).

- **@effect/vitest** — First-class testing: `it.effect`, `TestClock`-aware assertions, layer-sharing helpers.

- **tools** — The repo's own build/codegen tooling — AI code/doc generators, an OpenAPI generator, the bundler and jsdoc pipeline.

### How to use this handbook

- **⌘K / Ctrl+K — search** — Jump to any of 200+ modules by name. Type "semaphore", "TxRef", "HttpApi", "Sink" — hit enter and you land right on it, with the module highlighted.

- **Sidebar — browse by theme** — Chapters are grouped from foundations → concurrency → data → web → distributed → tooling. Roughly the order you'd grow into them.

- **Prev / Next — read it like a book** — Each chapter ends with navigation.

Major module entries cover what the API is, its mental model, a real example, and a "reach for it when" line. Smaller supporting modules stay compact so this remains useful as an agent reference.

> **Tip:** Every Effect API in this handbook is grounded in the audited implementation, tests, or package examples. Pin compatible `effect` and `@effect/*` versions together, and re-audit unstable imports before upgrading.
