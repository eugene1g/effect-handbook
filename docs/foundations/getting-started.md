# Getting Started

Everything else in this handbook assumes a project where `effect@4.0.2` is installed, TypeScript is strict, and one entrypoint runs an Effect. This page gets you there and names the traps on the way: mismatched package versions, compiler settings that silently weaken the types, and packages that do not exist for Effect 4.

> **Official guides:** [Installation](https://effect.website/docs/v4/getting-started/installation) (asks for Node.js 22.18+; the `4.0.2` README states Node.js 18+ as the general minimum), [Importing Effect](https://effect.website/docs/v4/getting-started/importing-effect), [The Effect Type](https://effect.website/docs/v4/getting-started/the-effect-type), [Creating Effects](https://effect.website/docs/v4/getting-started/creating-effects), [Running Effects](https://effect.website/docs/v4/getting-started/running-effects) (it names the `runFork` result `RuntimeFiber`; in `4.0.2` the type is `Fiber`), [Using Generators](https://effect.website/docs/v4/getting-started/using-generators), [Building Pipelines](https://effect.website/docs/v4/getting-started/building-pipelines) (it calls `Option` and `Result` yieldable inside `Effect.gen`; in `4.0.2` they are not — use `Effect.fromOption` and `Effect.fromResult`), [Devtools](https://effect.website/docs/v4/getting-started/devtools). These track Effect's `main` branch rather than the pinned `4.0.2` release, so where they differ, this page and the tagged source win.

## Install Effect 4

Effect 4 is the `latest` release on npm: a plain `pnpm add effect` installs it. Pin the exact version anyway, so that an upgrade is a deliberate, audited change rather than a side effect of a fresh install.

```sh
pnpm add effect@4.0.2 @effect/platform-node@4.0.2
pnpm add -D typescript@7 @types/node
```

**Every `effect` and `@effect/*` package in one project shares one version.** Effect 4 packages are released together under a single version number, and each `@effect/*` package declares `effect` as a peer dependency (`^4.0.2`). Mixing numbers is unsupported: an `@effect/*` package is built and tested against the `effect` release with the same number, and the subsystem families under `effect/<area>` may change between minor releases. Check for a single copy with `pnpm why effect` (or `npm ls effect`) after every install; the Effect language service reports a second copy as `duplicatePackage`.

| Install when you need | Package |
| --- | --- |
| The core, plus every `effect/<area>` family (HTTP, RPC, SQL client, CLI, AI, cluster, workflow, …) | `effect` — no runtime dependencies |
| A process entrypoint, file system, HTTP server or client for a host | `@effect/platform-node`, `@effect/platform-bun`, `@effect/platform-deno`, `@effect/platform-browser` |
| A SQL driver | `@effect/sql-pg`, `@effect/sql-pglite`, `@effect/sql-sqlite-node`, and the other `@effect/sql-*` packages |
| A language-model provider | `@effect/ai-openai`, `@effect/ai-anthropic`, `@effect/ai-openrouter`, `@effect/ai-openai-compat` |
| OpenTelemetry SDK export, UI bindings, test helpers | `@effect/opentelemetry`, `@effect/atom-react` (also `-solid`, `-vue`), `@effect/vitest` |

Do not install `@effect/platform`, `@effect/cli`, `@effect/rpc`, `@effect/sql`, `@effect/cluster`, `@effect/workflow`, `@effect/ai`, or `@effect/experimental`: they have no Effect 4 release, and their modules ship inside `effect` under `effect/<area>` paths such as `effect/http`, `effect/rpc`, and `effect/sql`.

## Runtime and compiler requirements

The library's floor and this handbook's validation target are different things. The first column is what `4.0.2` asks of you; the second is what every example here is compiled and run with.

| | Required by `effect@4.0.2` (repository README and package metadata) | Used to validate this handbook |
| --- | --- | --- |
| TypeScript | 5.9 or newer; TypeScript 7 recommended | 7.0.2 |
| Node.js | 18 or newer in general (`@effect/platform-node` declares `engines.node >=18.0.0`); some packages need more, for example `@effect/sql-sqlite-node` needs 22.16+ and `@effect/platform-deno` needs Deno 2.8.3+ | 26, which runs `.ts` entrypoints directly |
| Test runner | `@effect/vitest` and `@effect/doctest` require Vitest 5; `@effect/atom-react` requires React 19 | Vitest 5.0.3 |
| Type checking | `strict: true` | `strict` plus the flags below |
| Module format | ESM only: the packages are `"type": "module"` with no CommonJS build | `module: NodeNext` |

Set `"type": "module"` in your own `package.json`, then start from this `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2025",
    "lib": ["ES2025"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "moduleDetection": "force",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "rewriteRelativeImportExtensions": true,
    "skipLibCheck": true,
    "types": ["node"],
    "plugins": [{ "name": "@effect/language-service" }]
  }
}
```

| Setting | Status | Why it matters for Effect code |
| --- | --- | --- |
| `strict` | **required** | Without it, `E` and `R` inference degrades and `null` flows through unchecked. |
| `target` / `lib`: `ES2025` | handbook choice; set both to your oldest runtime | ES2025 is the newest target TypeScript 7 accepts. It assumes a current runtime — Node.js 24+ or a current evergreen browser — for library APIs such as `Promise.try` and Iterator helpers. Effect itself needs nothing newer than ES2022, so lower both settings together when you support older hosts; add `"DOM"` to `lib` for browser code. |
| `exactOptionalPropertyTypes` | recommended; on in the Effect repository and in this handbook | Keeps "key absent" and "key present with `undefined`" distinct, which is the difference between `Schema.optionalKey` and `Schema.optional`. |
| `module` / `moduleResolution`: `NodeNext` (or `Bundler` behind a bundler) | required in practice | Both honor the package `exports` map; subpaths such as `effect/http` and `effect/testing` do not resolve under legacy `node10` resolution. |
| `verbatimModuleSyntax`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions` | recommended; on in the Effect repository | Source stays runnable by a type-stripping runtime: type-only imports are written `import type`, and enums, namespaces, and constructor parameter properties are rejected. |
| `noUncheckedIndexedAccess` | handbook choice | Array and record lookups produce `T \| undefined`, which pairs naturally with `Option.fromNullishOr`. |
| `plugins: @effect/language-service` | recommended | Enables Effect diagnostics; see [Effect diagnostics in the editor and in CI](#effect-diagnostics-in-the-editor-and-in-ci). |

## A first complete program

One file, one runtime call. `NodeRuntime.runMain` is the process edge: it forks the program as the root fiber, interrupts it on `SIGINT` or `SIGTERM` so finalizers run, reports an unhandled failure through the logger, and sets the exit code (`0` on success, `130` when the program was only interrupted, non-zero on failure). The runtime itself keeps the process alive while fibers are pending, so `runMain` is about signals, exit codes, and error reporting rather than liveness.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Schema } from "effect"

class RaiseOutOfBand extends Schema.TaggedError<RaiseOutOfBand>()("RaiseOutOfBand", {
  percent: Schema.Finite,
  maximum: Schema.Finite
}) {}

// An Effect-returning function: traced, and typed as
// (salary, percent) => Effect<number, RaiseOutOfBand>
const proposeRaise = Effect.fn("proposeRaise")(function*(salary: number, percent: number) {
  if (percent > 0.15) {
    return yield* new RaiseOutOfBand({ percent, maximum: 0.15 })
  }
  yield* Effect.logInfo(`raise of ${percent * 100}% accepted`)
  return Math.round(salary * (1 + percent))
})

// Inline composition. Nothing has run yet: `program` is a description.
const program = Effect.gen(function*() {
  const next = yield* proposeRaise(120_000, 0.04)
  yield* Effect.logInfo(`new salary: ${next}`)
})

NodeRuntime.runMain(program)
```

```text
$ node src/main.ts
[20:40:57.787] INFO (#2): raise of 4% accepted
[20:40:57.788] INFO (#2): new salary: 124800
```

Change `0.04` to `0.4` and the process logs `ERROR (#2): RaiseOutOfBand` with a stack that points at `proposeRaise`, then exits with code `1`.

Four reading rules carry into every other page:

- **`Effect<A, E, R>` is a description**: it succeeds with `A`, fails with a typed `E`, and needs services `R`. Building one performs no work, so `Effect.succeed(Date.now())` reads the clock while the program is being *built*; write `Effect.sync(() => Date.now())`.
- **`yield*` sequences; `return yield*` fails.** Inside `Effect.gen` and `Effect.fn`, `yield*` runs an Effect and gives you its value. Yielding a tagged error fails the Effect, and the `return` tells TypeScript the code after it is unreachable.
- **`E = never` means "no modeled failure is left", not "cannot go wrong".** Defects and interruption exist regardless of the error type.
- **Run at an edge you own.** Reusable code returns Effects; only an entrypoint, a host adapter, or a test calls a runner.

| Edge | Runner | On failure |
| --- | --- | --- |
| Process entrypoint | `NodeRuntime.runMain` (`BunRuntime`, `DenoRuntime` in their packages) | logs, sets the exit code |
| JavaScript caller that wants a Promise | `Effect.runPromise` | rejects with the failure value or defect; only an `Exit` runner tells failure, defect, and interruption apart |
| Caller that must branch on the outcome | `Effect.runPromiseExit`, `Effect.runSyncExit` | resolves with an `Exit` |
| Provably synchronous effect | `Effect.runSync` | throws, including when the effect turns out to be asynchronous |
| Caller that keeps and owns the fiber | `Effect.runFork` | returns a `Fiber`; someone must join, observe, or interrupt it |
| A host that calls in repeatedly (web framework, UI) | one `ManagedRuntime` | per runner, as above; dispose it on shutdown |

Details: [Effect](core-runtime-execution#effect), [Runtime](core-runtime-execution#runtime), and [ManagedRuntime](core-runtime-execution#managedruntime). `BrowserRuntime.runMain` is the browser equivalent; see [Platform & Runtime Hosts](../interfaces/platform-runtime-hosts).

## Import forms

```ts
// Barrel: every root module as a namespace. The handbook uses this form.
import { Effect, Layer, Schema } from "effect"

// Subpath: one module per import. Same module instance as the barrel export.
import * as Option from "effect/Option"

// Area families have their own barrels and per-module subpaths.
import { HttpClient } from "effect/http"
import * as HttpClientRequest from "effect/http/HttpClientRequest"

// Test services live under their own entry point.
import { TestClock } from "effect/testing"
```

- **The module label on every handbook section — `` `effect/Queue` — stable `` — is the subpath.** The example beneath it imports the same module from the barrel; the two are interchangeable.
- **Tree-shaking is a bundler property, enabled by the package.** `effect` declares its side-effect-free modules and exposes its API as module functions rather than methods, so a bundler can drop what a program never references. When a bundler or test runner handles the barrel poorly, switch that project to subpath imports; no call site changes.
- **`effect/internal/*` and `*/index` subpaths are blocked by the `exports` map.** If an import needs them, the API is not public.
- **Functions are dual.** `Effect.map(effect, f)` and `effect.pipe(Effect.map(f))` are the same operation; use the first for one step and `.pipe` for several.

## Stable and unstable modules

Stability is a per-API contract declared with a JSDoc tag, not an import path; since `4.0.2` every module and directly importable export is tagged explicitly. The handbook summarizes it as a badge on every module section.

| Badge | Promise | What carries it in `4.0.2` |
| --- | --- | --- |
| stable (`@stability stable`) | semantic versioning: breaking changes only in a major release | most of the root barrel — `Effect`, `Layer`, `Schema`, `Stream`, `Config`, the data structures, most `Tx*` transactional modules — plus `TestClock` from `effect/testing` and the text codecs under `effect/encoding` (`Base64`, `Base64Url`, `Hex`, `EncodingError`) |
| unstable (`@stability unstable`) | **may break in a minor release** | the subsystem families `effect/ai`, `cli`, `cluster`, `devtools`, `eventlog`, `http`, `http-api`, `net`, `observability`, `persistence`, `process`, `reactivity`, `rpc`, `schema`, `socket`, `sql`, `workers`, `workflow`; root-barrel modules such as `Arbitrary`, `FileSystem`, `Path`, `ExecutionPlan`, `LayerMap`, `Graph`, and `ByteSize` (each module section shows its badge); `TestConsole` and `TestSchema`; the remaining `effect/encoding` codecs; some advanced `Schema` APIs; and every API that exposes a third-party dependency (driver options in `@effect/sql-*`, provider clients in `@effect/ai-*`, `@effect/opentelemetry`) |
| experimental (`@stability experimental`) | may break in a **patch** release | nothing in `4.0.2`; the handbook will name any such API where it appears |

"Unstable" describes the API contract, not the quality: HTTP, SQL, and RPC are what production Effect applications are built on. It does change how you depend on them. **Pin exact versions, read the release notes before every upgrade, and keep leaf area imports behind a small service you own** so a rename touches one file. The maintainers' stated plan is to promote these families to stable as production feedback settles them.

## Effect diagnostics in the editor and in CI

The Effect language service ships as `@effect/tsgo`, built on the native TypeScript compiler, and needs `typescript` 7 installed beside it. It adds Effect-aware diagnostics and quick fixes: an Effect that was never yielded or assigned, a bare `yield` without `*`, implementation services leaking through a service method, a second copy of an Effect package, and APIs that do not exist in the installed version. `npx @effect/tsgo setup` adds the dependency and the `@effect/language-service` entry under `compilerOptions.plugins`; `effect-tsgo patch` (run it from a `prepare` script, as the Effect repository does) patches the local TypeScript install so `tsc` emits the same diagnostics; and `npx @effect/tsgo diagnostics --project tsconfig.json --strict` is a standalone CI check in which warnings fail the build. This handbook compiles every example under exactly that pair: strict `tsc` and strict Effect diagnostics, with one rule turned off: `unstableApiUsage` warns on every API tagged `@stability unstable`, which in `4.0.2` means every call into `effect/http`, `effect/sql`, `effect/rpc`, `effect/ai`, and the other area families. A project that uses those modules sets `"diagnosticSeverity": { "unstableApiUsage": "off" }` in the plugin options (or downgrades it to a suggestion) rather than suppressing it line by line; a project that wants to be told when it strays outside the semver-covered surface leaves it on.

The official guidance for working with coding agents makes the same point from the other side: the tighter the feedback loop, the better the generated code, so install the language service first, and keep the installed `effect` source (and its bundled `AGENTS.md` and `ai-docs/`) within the agent's reach rather than relying on remembered API shapes. [Testing & Dev Tooling](../tooling/testing-dev-tooling) covers the tooling in depth.

## Where next

| You want to | Go to |
| --- | --- |
| Understand `Effect`, fibers, scopes, and runners | [Core Runtime & Execution](core-runtime-execution) |
| Model failures, absence, and recoverable results | [Errors, Option & Result](errors-option-result) |
| Inject dependencies and own resource lifetimes | [Services, Context & Layers](services-context-layers), then [Recipe: A Service with Live and Test Layers](../recipes/service-and-layers) |
| Read environment variables and secrets | [Configuration & Secrets](configuration-secrets) |
| Validate and transform data at a boundary | [Schema](../data/schema) |
| Pick between similar primitives | [Choosing Effect Primitives](../reference/choosing-effect-primitives) |
| See the whole application shape | [Anatomy of a Real Effect Application](../deep-dives/anatomy-of-a-real-effect-application) |
| Bring Effect into a Promise-based codebase | [Adopting Effect in an Existing TypeScript Codebase](../deep-dives/adopting-effect-in-an-existing-codebase) |
| Write a production entrypoint | [Recipe: A Graceful Node Entrypoint](../recipes/graceful-entrypoint-and-shutdown) |
| Test with virtual time and replaceable services | [Testing & Dev Tooling](../tooling/testing-dev-tooling) and [Testing an Effect Application](../deep-dives/testing-an-effect-application) |
| Diagnose a confusing type error or a hang | [Troubleshooting & Anti-Patterns](../troubleshooting/troubleshooting-and-anti-patterns) |
| Review a change before it ships | [Review Checklists](../reference/review-checklists) |
