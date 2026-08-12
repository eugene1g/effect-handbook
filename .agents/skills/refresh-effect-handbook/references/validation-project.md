# Tracked Documentation Validation Harness

Use this contract when refreshing or extending the handbook example validator. The repository harness is the durable implementation; ignored per-release projects are supplemental scratch space only.

## Contents

- [Ownership and layout](#ownership-and-layout)
- [Pinned target](#pinned-target)
- [Fence metadata and dispositions](#fence-metadata-and-dispositions)
- [Extraction manifest](#extraction-manifest)
- [Compilation and Effect diagnostics](#compilation-and-effect-diagnostics)
- [Runtime checks and doctests](#runtime-checks-and-doctests)
- [Integrity failures](#integrity-failures)
- [Refresh procedure](#refresh-procedure)

## Ownership and layout

Markdown under `docs/**` is the only authored example source. Commit reusable validation logic and evidence inputs:

```text
validation/
  target.json
  package.json
  tsconfig.base.json
  examples.json
  fixtures/
  probes/
scripts/validation/
  extract-examples.ts
  check-examples.ts
  check-package-coherence.ts
.validation/generated/
  examples/
  manifest.json
  results.json
```

Names may differ slightly in the checked-in implementation, but the ownership boundary may not. The repository root owns `pnpm-workspace.yaml` and the sole `pnpm-lock.yaml`; `validation/` is a private workspace package, not a nested pnpm project. Commit `validation/**` and `scripts/validation/**`. Ignore `.validation/generated/**`, `node_modules`, Effect clones, logs, matrices, reports, and build `dist/`. Never commit extracted copies of Markdown fences.

All harness and skill programs are ESM `.ts` files run directly by Node 26.x. Use only syntax accepted by Node's built-in type stripping, keep explicit `.ts` import extensions, and do not add a transpiled JavaScript mirror, `tsx`, `ts-node`, or a custom loader. The generated `.tsx` files in `.validation/generated/**` are extracted documentation examples, not repository tooling.

## Pinned target

`validation/target.json` records:

- exact Effect version, Git tag, source commit, and audit date;
- exact TypeScript, `@effect/tsgo`, Node, matching `@types/node`, pnpm, Vitest, and `@effect/doctest` versions used by the harness.

Pin `effect` and every imported `@effect/*` package exactly in `validation/package.json`; commit the root workspace lockfile. A coherence validator must compare the target with:

- `handbookRelease` in `handbook.ts`;
- current-version assertions in `docs/index.md` and VitePress metadata/footer;
- validation dependency specs and resolved lockfile/importer versions;
- every Effect package actually imported by canonical examples has an exact direct validation pin;
- the installed `effect` and `@effect/*` graph from `pnpm list --depth Infinity --json`.

Document explicit tooling exceptions. Never accept mixed Effect release lines merely because TypeScript resolves them.

## Fence metadata and dispositions

Extract `ts`, `typescript`, and `tsx` fences from the ordered `sitePages` manifest. A bare fence defaults to `compile`. Exceptions require a stable explicit id, either in portable metadata beside the fence or in the tracked `validation/examples.json` registry keyed by canonical source plus the full code hash. Do not use global ordinals or source line numbers as identities.

Supported dispositions:

| Disposition | Contract |
| --- | --- |
| `compile` | Compile as an isolated strict module. A content-derived fallback id is acceptable. |
| `contextual` | Compile the exact fence with one named tracked fixture/group. Requires a durable id. |
| `run` | Compile and execute an assertion or doctest. Requires a durable id and runtime association. |
| `pseudocode` | Visibly label the fence in Markdown and record a specific reason. Do not imply it is copyable. |
| `invalid` | Assert the one intended TypeScript compiler diagnostic by exact code and a reviewed message fragment. |

Prefer compact metadata such as:

````md
<!-- effect-example id=schema.decode-employee check=run runtime=schema.decode -->
```ts import.meta.vitest
// extracted source
```
````

`contextual`, `run`, and `invalid` entries require explicit stable names. `pseudocode` requires visible prose plus a tracked justification. Changing a fence body must invalidate any hash-pinned disposition until reviewed.

## Extraction manifest

Generate sources atomically beneath `.validation/generated/`. The manifest records, for every fence:

- stable id, source page, nearest heading, and current line range;
- exact code SHA-256 and language;
- disposition, fixture/group, runtime/doctest association, platform, and required packages;
- generated output path;
- strict TypeScript, strict Effect, and runtime result after validation.

Also record target/tool versions, ordered canonical-source hash, extractor hash/version, total pages/fences, and per-disposition counts. Generated code must be byte-identical to the canonical fence apart from a documented trailing newline or wrapper. Unit-test this invariant.

## Compilation and Effect diagnostics

Use a strict TypeScript 7 baseline:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "rewriteRelativeImportExtensions": true,
    "erasableSyntaxOnly": true,
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "noErrorTruncation": true,
    "jsx": "react-jsx"
  }
}
```

Compile every `compile`, `contextual`, and `run` fence. A contextual fixture may add imports, declarations, or adjacent application modules, but the canonical fence body must be consumed byte-for-byte and remain identifiable. Do not maintain a rewritten copy of the example.

Run `effect-tsgo diagnostics --strict` on the same valid programs. Require zero errors and zero warnings; advisory messages may be recorded separately. Never use a broad diagnostic-code allowlist. `invalid` examples use a separate negative lane and must fail only for the exact declared diagnostic.

## Runtime checks and doctests

Use `@effect/doctest` selectively for small deterministic fences marked `import.meta.vitest`. Run generated doctest modules through Vitest with explicit expected values. Keep the general extractor because application fragments, servers, resources, and multi-file examples do not fit doctest isolation.

Use committed probes or runtime associations for cancellation, scopes, retries, `TestClock`, caching, hydration, serialization, concurrency, signals, and cleanup. Every `run` example must have an assertion and timeout. Execute freshly extracted code, not a second maintained implementation. Ensure resources, servers, and child processes shut down even when a test fails.

## Integrity failures

Fail validation for:

- a missing or duplicate explicit id;
- an unclassified fence or unknown metadata key;
- a stale body hash, source entry, fixture, runtime probe, or expected diagnostic;
- an orphan fixture/probe or a fixture mapped to more than its declared group;
- a generated file that differs from its Markdown body;
- any valid fence without TypeScript and Effect evidence;
- any `run` fence without a passing runtime/doctest assertion;
- any `pseudocode` fence without visible labelling and justification;
- any `invalid` fence that succeeds, produces extra diagnostics, or misses its expected diagnostic;
- target/package/tool version incoherence;
- incomplete manifest counts or generated coverage.

## Refresh procedure

1. Resolve the latest published v4 and update `validation/target.json`.
2. Update all exact Effect dependencies and tools; regenerate the root workspace lockfile once.
3. Use frozen installs for every evidence-bearing rerun.
4. Extract from current `sitePages`; repair stale classifications explicitly.
5. Add fixtures for new contextual examples and probes for observable semantic claims.
6. Run coherence, strict TypeScript, strict Effect diagnostics, doctests, and runtime probes.
7. Inspect the final manifest/results and report each disposition count and any boundary.

Do not resurrect or commit an old `.validation/<version>` umbrella project. It can contain incompatible fixtures, ordinal mappings, and stale diagnostic exceptions even when selected lanes once passed.
