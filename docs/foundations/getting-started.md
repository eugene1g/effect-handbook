# Getting Started

Everything else in this handbook assumes a project where `effect@4.0.0-rc.116` is installed, TypeScript is strict, and one entrypoint runs an Effect. This page gets you there and names the traps on the way: the npm dist-tag, mismatched package versions, and compiler settings that silently weaken the types.

> **Official guides:** [Installation](https://effect.website/docs/v4/getting-started/installation) (asks for Node.js 22.18+; the `rc.116` README states Node.js 18+ as the general minimum), [Importing Effect](https://effect.website/docs/v4/getting-started/importing-effect), [The Effect Type](https://effect.website/docs/v4/getting-started/the-effect-type), [Creating Effects](https://effect.website/docs/v4/getting-started/creating-effects), [Running Effects](https://effect.website/docs/v4/getting-started/running-effects) (it names the `runFork` result `RuntimeFiber`; in `rc.116` the type is `Fiber`), [Using Generators](https://effect.website/docs/v4/getting-started/using-generators), [Building Pipelines](https://effect.website/docs/v4/getting-started/building-pipelines) (it calls `Option` and `Result` yieldable; in `rc.116` they are not), [Devtools](https://effect.website/docs/v4/getting-started/devtools). These track Effect's `main` branch rather than the pinned `rc.116` release, so where they differ, this page and the tagged source win.

## Install the release candidate, not `latest`

**An untagged `pnpm add effect` installs Effect 3.** Effect 4 is published under the `rc` dist-tag; `latest` still points at the v3 line. With v3 installed, no example in this handbook type-checks, and the compiler errors — `Context.Service`, `Effect.catch`, or `Effect.forkChild` "does not exist" — never mention the version.

| npm dist-tag (checked 2026-09-19 with `npm view effect dist-tags`) | `effect` | `@effect/platform-node` |
| --- | --- | --- |
| `latest` | `3.22.2` | `0.108.2` |
| `rc` | `4.0.0-rc.116` | `4.0.0-rc.116` |
| `beta` | `4.0.0-beta.107` | `4.0.0-beta.107` |

**Pin the exact version.** The `rc` tag moves with every release candidate, and release candidates still rename public APIs (rc.113 moved the `Config` and CLI constructors to PascalCase). An exact pin makes an upgrade a deliberate, audited change.

```sh
pnpm add effect@4.0.0-rc.116 @effect/platform-node@4.0.0-rc.116
pnpm add -D typescript@7 @types/node

# Moving alternative, for throwaway experiments only:
pnpm add effect@rc @effect/platform-node@rc
```

**Every `effect` and `@effect/*` package in one project shares one version.** Effect 4 packages are released together under a single version number, and each `@effect/*` package declares `effect` as a peer dependency (`^4.0.0-rc.116` for this release). Mixing numbers is unsupported: an `@effect/*` package is built and tested against the `effect` release with the same number, and `effect/unstable/*` modules change between release candidates. Check for a single copy with `pnpm why effect` (or `npm ls effect`) after every install; the Effect language service reports a second copy as `duplicatePackage`.

| Install when you need | Package |
| --- | --- |
| The core, plus every `effect/unstable/*` family (HTTP, RPC, SQL client, CLI, AI, cluster, workflow) | `effect` — no runtime dependencies |
| A process entrypoint, file system, HTTP server or client for a host | `@effect/platform-node`, `@effect/platform-bun`, `@effect/platform-deno`, `@effect/platform-browser` |
| A SQL driver | `@effect/sql-pg`, `@effect/sql-pglite`, `@effect/sql-sqlite-node`, and the other `@effect/sql-*` packages |
| A language-model provider | `@effect/ai-openai`, `@effect/ai-anthropic`, `@effect/ai-openrouter`, `@effect/ai-openai-compat` |
| OpenTelemetry SDK export, UI bindings, test helpers | `@effect/opentelemetry`, `@effect/atom-react` (also `-solid`, `-vue`), `@effect/vitest` |

Do not install `@effect/platform`, `@effect/cli`, `@effect/rpc`, `@effect/sql`, `@effect/cluster`, `@effect/workflow`, `@effect/ai`, or `@effect/experimental`: they have no Effect 4 release, and their modules ship inside `effect` (mostly under `effect/unstable/*`).

## Runtime and compiler requirements

The library's floor and this handbook's validation target are different things. The first column is what `rc.116` asks of you; the second is what every example here is compiled and run with.

| | Required by `effect@4.0.0-rc.116` (repository README and package metadata) | Used to validate this handbook |
| --- | --- | --- |
| TypeScript | 5.9 or newer; TypeScript 7 recommended | 7.0.2 |
| Node.js | 18 or newer in general (`@effect/platform-node` declares `engines.node >=18.0.0`); some packages need more, for example `@effect/sql-sqlite-node` needs 22.16+ | 26, which runs `.ts` entrypoints directly |
| Type checking | `strict: true` | `strict` plus the flags below |
| Module format | ESM only: the packages are `"type": "module"` with no CommonJS build | `module: NodeNext` |

Set `"type": "module"` in your own `package.json`, then start from this `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
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
| `exactOptionalPropertyTypes` | recommended; on in the Effect repository and in this handbook | Keeps "key absent" and "key present with `undefined`" distinct, which is the difference between `Schema.optionalKey` and `Schema.optional`. |
| `module` / `moduleResolution`: `NodeNext` (or `Bundler` behind a bundler) | required in practice | Both honor the package `exports` map; subpaths such as `effect/unstable/http` and `effect/testing` do not resolve under legacy `node10` resolution. |
| `verbatimModuleSyntax`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions` | recommended; on in the Effect repository | Source stays runnable by a type-stripping runtime: type-only imports are written `import type`, and enums, namespaces, and constructor parameter properties are rejected. |
| `noUncheckedIndexedAccess` | handbook choice | Array and record lookups produce `T \| undefined`, which pairs naturally with `Option.fromNullishOr`. |
| `plugins: @effect/language-service` | recommended | Enables Effect diagnostics; see [Effect diagnostics in the editor and in CI](#effect-diagnostics-in-the-editor-and-in-ci). |

## A first complete program

One file, one runtime call. `NodeRuntime.runMain` is the process edge: it forks the program as the root fiber, interrupts it on `SIGINT` or `SIGTERM` so finalizers run, reports an unhandled failure through the logger, and sets the exit code (`0` on success, `130` when the program was only interrupted, non-zero on failure).

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
// Barrel: every stable module as a namespace. The handbook uses this form.
import { Effect, Layer, Schema } from "effect"

// Subpath: one module per import. Same module instance as the barrel export.
import * as Option from "effect/Option"

// Unstable families have their own barrels and per-module subpaths.
import { HttpClient } from "effect/unstable/http"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

// Test services live under their own entry point.
import { TestClock } from "effect/testing"
```

- **The module label on every handbook section — `` `effect/Queue` — stable `` — is the subpath.** The example beneath it imports the same module from the barrel; the two are interchangeable.
- **Tree-shaking is a bundler property, enabled by the package.** `effect` declares `"sideEffects": []` and exposes its API as module functions rather than methods, so a bundler can drop what a program never references. When a bundler or test runner handles the barrel poorly, switch that project to subpath imports; no call site changes.
- **`effect/internal/*` and `*/index` subpaths are blocked by the `exports` map.** If an import needs them, the API is not public.
- **Functions are dual.** `Effect.map(effect, f)` and `effect.pipe(Effect.map(f))` are the same operation; use the first for one step and `.pipe` for several.

## Stable and unstable modules

| Import path | Compatibility promise | Families in `rc.116` |
| --- | --- | --- |
| `effect`, `effect/<Module>`, `effect/testing` | semantic versioning | Effect, Layer, Schema, Stream, Config, the data structures, the `Tx*` transactional modules, and the rest of the core |
| `effect/unstable/<family>` | **may break in a minor release**; modules graduate to the top level as they settle | `ai`, `arbitrary`, `cli`, `cluster`, `devtools`, `encoding`, `eventlog`, `http`, `httpapi`, `net`, `observability`, `persistence`, `process`, `reactivity`, `rpc`, `schema`, `socket`, `sql`, `workers`, `workflow` |

"Unstable" describes the API contract, not the quality: HTTP, SQL, and RPC are what production Effect applications are built on. It does change how you depend on them. **Pin exact versions, read the release notes before every upgrade, and keep leaf unstable imports behind a small service you own** so a rename touches one file. Every handbook section marks its module as stable or unstable.

## Effect diagnostics in the editor and in CI

The Effect language service ships as `@effect/tsgo`, built on the native TypeScript compiler, and needs `typescript` 7 installed beside it. It adds Effect-aware diagnostics and quick fixes: an Effect that was never yielded or assigned, a bare `yield` without `*`, implementation services leaking through a service method, a second copy of an Effect package, and APIs that do not exist in the installed version. `npx @effect/tsgo setup` adds the dependency and the `@effect/language-service` entry under `compilerOptions.plugins`; `effect-tsgo patch` (run it from a `prepare` script, as the Effect repository does) patches the local TypeScript install so `tsc` emits the same diagnostics; and `effect-tsgo diagnostics --project tsconfig.json --strict` is a standalone CI check in which warnings fail the build. This handbook compiles every example under exactly that pair: strict `tsc` and strict Effect diagnostics. [Testing & Dev Tooling](../tooling/testing-dev-tooling) covers the tooling in depth.

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
