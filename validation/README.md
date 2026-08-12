# Documentation example validation

This tracked package validates every canonical `ts`, `typescript`, and `tsx`
fence in the ordered `sitePages` manifest. Markdown under `docs/**` is the only
authored example source. Freshly extracted files and evidence are written to
ignored `.validation/generated/**`; none of those copies is committed.

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm docs:examples
```

`validate` is the complete CI lane. It checks target/package/lock/install
coherence, extracts every fence, rejects stale or orphan registry entries,
runs strict TypeScript 7 and strict Effect diagnostics, validates contextual
fixtures, executes recipes and selected `@effect/doctest` Markdown, and runs
tracked semantic probes.

## Dispositions

A bare TypeScript fence defaults to `compile`. Exceptions use a compact comment
immediately before the fence:

```md
<!-- effect-example id=service.live-layer check=run runtime=service.live-layer -->
```

The five dispositions are:

- `compile`: an isolated strict module;
- `contextual`: the exact body compiled with one named tracked fixture;
- `run`: strict compilation plus a deterministic runtime or doctest assertion;
- `pseudocode`: visibly labelled and paired with a specific tracked reason;
- `invalid`: one precise expected TypeScript diagnostic.

`contextual`, `run`, and `invalid` require semantic stable IDs that do not
contain content hashes. `validation/examples.json` binds those identities to
the canonical source path and full SHA-256, so body changes require an explicit
review. It also rejects duplicate IDs, stale hashes, unused runtime definitions,
unknown fixtures, and incomplete coverage.

## Pinned evidence

The root `pnpm-workspace.yaml` and `pnpm-lock.yaml` own one frozen dependency graph for both the site tooling and this private validation package. `target.json` records Effect `4.0.0-rc.108`, its tag and source commit, the audit
date, Node 26+ CI contract, matching Node 26 type declarations, pnpm, TypeScript, `@effect/tsgo`, Vitest, and
`@effect/doctest`. `validation/package.json` pins the validation dependencies and the root lockfile records their exact graph. The generated manifest records a hash inventory of every
tracked harness input, fixture, probe, configuration, registry, and lockfile.
The adjacent JSON Schemas document the editor-facing contracts; the committed
loaders enforce their required keys, unknown-key rejection, identity patterns,
and disposition-specific invariants without adding a runtime schema dependency.
