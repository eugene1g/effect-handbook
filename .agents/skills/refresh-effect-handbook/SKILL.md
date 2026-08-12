---
name: refresh-effect-handbook
description: Audit and refresh the Effect 4 Handbook against the newest published Effect v4 package and corresponding Effect-TS/effect source. Use when asked to verify handbook correctness, upgrade its documented Effect version, inspect release changelogs and PRs, validate all concise docs and deep dives, discover newly exported stable or unstable modules and public packages, maintain the tracked TypeScript, Effect-diagnostic, doctest, and runtime example harness, or regenerate the VitePress site and agent Markdown. Do not use for a narrow prose-only edit that does not require source or version validation.
---

# Refresh the Effect Handbook

Treat the exact published package and its tagged source as the specification. Finish only when every canonical page, example, public module, package, generated artifact, and important behavioral claim has evidence for the selected version.

Read [references/audit-contract.md](references/audit-contract.md) completely before editing. Before changing the tracked example harness or creating any supplemental scratch project, also read [references/validation-project.md](references/validation-project.md). Use the scripts in this skill relative to this `SKILL.md`; do not copy one-off audit helpers into the repository root.

## 1. Establish scope and preserve local work

1. Read `README.md`, `handbook.ts`, `package.json`, `.gitignore`, `.github/workflows/pages.yml`, and any applicable `AGENTS.md`.
2. Run `git status --short`. Preserve all user changes and avoid overlapping edits.
3. Confirm the content model:
   - `docs/**` is canonical Markdown.
   - `handbookPages` feeds the concise agent bundle.
   - `sitePages` feeds VitePress and includes deep dives.
   - `handbook-capabilities.ts` owns intent aliases, exact symbol import groups, selection boundaries, requirements, lifetimes, alternatives, canonical anchors, and stable recipe snippet ids.
   - `agentBundles` produces focused domain Markdown; every capability-owning page must appear in at least one bundle.
   - `validation/**` is the tracked, release-pinned example harness. Its generated sources remain ignored.
   - `dist/**` is generated. Never hand-edit it.
   - repository tooling is native ESM TypeScript executed directly by Node 26.x. Keep imports on explicit `.ts` paths and do not introduce emitted tooling, `tsx`, `ts-node`, or custom loaders. Run `pnpm docs:tools:check` after tooling changes so Node's erasable-syntax boundary remains enforced.
4. Write audit notes under ignored `.reference/` and disposable projects under ignored `.validation/`.
   Treat prior artifacts as leads, not evidence: require target version, source commit, canonical-source hash, and command metadata before reusing one. Regenerate any artifact that cannot prove those inputs.
5. If subagents are available, assign independent lanes: release delta, existing-page implementation review, missing surfaces, examples/runtime probes, and final site verification. Keep one integrator responsible for shared Markdown edits.

## 2. Resolve and pin the target release

Run:

```bash
node <skill-dir>/scripts/resolve-latest-effect.ts --json
```

Use the highest published semantic version whose major is 4, including prereleases unless the user explicitly requests stable-only. Record the exact version, npm publication time, npm `gitHead`, matching dist-tags, Git tag, and tarball URL. Never infer "latest" from memory, a local lockfile, or the `next` dist-tag alone.

If npm marks the highest release deprecated, stop and investigate the deprecation rather than silently choosing an older version. Report whether the audit will target that release or a user-approved alternative.

Read the currently documented version and commit from `docs/index.md`. The old version is the audit baseline; the resolved version is the target. If they match, still perform the implementation and inventory audit because documentation can be incomplete without a version change.

## 3. Acquire exact source safely

Use the official `https://github.com/Effect-TS/effect.git` repository in an ignored versioned folder such as `.reference/effect-4.0.0-beta.123`. Do not delete or overwrite an existing clone.

1. Resolve the exact `effect@<version>` tag or npm `gitHead` before checkout. A reproducible sequence is:

   ```bash
   git clone --filter=blob:none --no-checkout https://github.com/Effect-TS/effect.git .reference/effect-<version>
   git -C .reference/effect-<version> fetch --depth=1 origin tag "effect@<version>"
   git -C .reference/effect-<version> checkout --detach "effect@<version>"
   git -C .reference/effect-<version> rev-parse HEAD
   git -C .reference/effect-<version> tag --points-at HEAD
   ```

2. Checkout detached at that commit and record `git rev-parse HEAD`.
3. Verify it matches npm `gitHead` when npm publishes that field. Effect releases may omit `gitHead`; in that case download the exact npm tarball, verify its registry integrity, compare its published files/package versions with the checked-out tag, and inspect npm provenance when available. Record that this establishes package/tag correspondence without pretending a lightweight Git tag is cryptographically signed.
4. Keep the previous documented tag available for a source-to-source diff.
5. Read upstream repository instructions before running its commands.

Document only published target behavior. Use `main` and current official guides for discovery or context, but label anything newer than the target as unreleased and do not teach it as available in the pinned package.

## 4. Build the release-delta ledger

Audit the complete baseline-to-target range, not only the final release note:

1. Generate inventories of every package changelog/changeset entry and every commit in the range; give each row a disposition.
2. Inspect every linked PR in the inventoried range that can alter API names, types, semantics, defaults, errors, wire formats, persistence, security, resource lifetime, platform behavior, or deployment. Record non-documentation commits as reviewed/irrelevant instead of silently omitting them.
3. Compare public exports, package manifests, and declaration/source signatures at both endpoints.
4. Record additions, removals, renames, changed overloads, changed error/context channels, and operational migrations.
5. Note unpublished or skipped version numbers so the handbook does not invent releases.

Use official GitHub pages when browsing PRs. Keep a release ledger in `.reference/` with source paths and PR URLs for every documentation-significant change.

## 5. Inventory all source surfaces

Run:

```bash
node <skill-dir>/scripts/audit-source-coverage.ts \
  --docs docs \
  --manifest handbook.ts \
  --effect .reference/effect-<version> \
  --json .reference/handbook-coverage-<version>.json
```

The report separates concise-agent coverage from complete-site coverage so a deep-dive mention cannot hide a concise-reference omission, and it ignores orphan Markdown not registered in `handbook.ts`. Then generate a complete folder/file/package-export inventory and give every entry a reviewed, grouped-under, private/internal, or documentation-required disposition. The helper covers namespace exports and public package front doors; it intentionally does not exhaust package export-map subpaths or decide that private, internal, experimental, nested, provider-specific, or tool code is irrelevant.

Review at least:

- every stable namespace exported by `effect`;
- every `effect/unstable/*` family and namespace export;
- nested public modules and package export maps;
- every public `effect` and `@effect/*` package;
- platform, SQL, AI, Atom, OpenTelemetry, testing, docgen/doctest, generators, and adapters;
- new experimental/internal folders for public concepts or migration risks worth explaining.

Every public surface needs either handbook coverage or an explicit, evidence-backed reason it is intentionally grouped under another entry. Add new concise sections at topic-sized granularity; do not create one tiny page per file.

## 6. Audit every canonical page against implementation

Build an audit matrix from `sitePages`. Give every page and every H2/H3 section a row, including no-finding sections and every deep dive, so complete review is positively auditable rather than inferred from the findings list.

For each section:

1. Trace the named API to the exact tagged implementation, public types, tests, and upstream examples.
2. Verify names, imports, generics, argument order, defaults, return values, error/context channels, resource lifetime, concurrency, equality, serialization, wire/security contracts, and platform restrictions.
3. Check prose claims as rigorously as code. Pay special attention to words such as "always", "once", "safe", "idempotent", "serializable", "cached", and "typed error".
4. Identify useful capabilities missing from the section, especially those added since the baseline.
5. Check that deep dives form a correct connected narrative rather than duplicating stale API catalogs.
6. Check internal links, official external links, heading hierarchy, code-fence languages, and VitePress-safe Markdown.
7. Audit the decision guide, troubleshooting symptoms, recipes, capability catalog, deep-dive summaries, generated related-topic metadata, and retrieval cases whenever the facts they route to change.

Do not accept a changelog summary as proof of current behavior. Do not accept a compiling example as proof of runtime semantics.

## 7. Validate every example with the tracked harness

Read [references/validation-project.md](references/validation-project.md) before changing validation metadata, fixtures, or probes. Markdown remains the only authored example source. The committed `validation/**` package and `scripts/validation/**` logic extract fresh `.ts` / `.tsx` files under ignored `.validation/generated/**` on every run.

Update `validation/target.json`, every exact `effect` / `@effect/*` dependency, TypeScript 7, `@effect/tsgo`, Vitest, and `@effect/doctest` when the target changes. Regenerate and commit the root workspace `pnpm-lock.yaml` once; use the single frozen workspace install for every evidence-bearing rerun. Do not create a nested validation lockfile.

Give every TypeScript fence one disposition:

- `compile`: isolated strict compilation; bare fences default here;
- `contextual`: exact fence plus one named tracked fixture/group;
- `run`: compile plus deterministic runtime or doctest assertions;
- `pseudocode`: visibly labelled and specifically justified;
- `invalid`: deliberately fails with one exact asserted diagnostic contract.

Require explicit stable ids for `contextual`, `run`, and `invalid`; never identify fixtures by a global ordinal or line number. The manifest must retain source page, heading, line, code hash, fixture/platform/packages, and TypeScript/Effect/runtime results. Reject stale hashes, orphan fixtures/probes, duplicate ids, missing coverage, and unclassified exceptions.

Run:

```bash
pnpm install --frozen-lockfile
pnpm docs:examples
```

The lane must:

1. verify target metadata against `handbook.ts`, docs/VitePress current-version assertions, dependency specs, lockfile, and the installed package graph;
2. extract every `ts`, `typescript`, and `tsx` fence from ordered `sitePages`;
3. compile every valid `compile`, `contextual`, and `run` disposition with strict TypeScript 7;
4. run strict Effect diagnostics with zero errors and zero warnings on those same programs;
5. prove every `invalid` fence fails only as declared;
6. execute each `run` assertion, including selected `import.meta.vitest` Markdown doctests;
7. emit a complete generated manifest/results record without committing generated sources.

Add focused tracked probes for ambiguous behavior, defaults, equality, cancellation, serialization, resource lifetime, scheduling, hydration, concurrency, or error routing. In the section matrix, mark semantic claims as source-proven, type-proven, or runtime-probe-required. Test only installed published packages, never imports into the source clone.

Do not copy an old ignored `.validation/<version>` project into the tracked harness. It may combine incompatible fixture universes, rely on ordinal filenames, or carry broad diagnostic allowlists. Use ignored scratch projects only for discovery, then promote minimal reusable fixtures/probes into `validation/**`.

## 8. Update only canonical sources

Apply source-grounded corrections to `docs/**`, `handbook.ts`, and validation/build code when necessary.

1. Update the version/commit scope and release-evolution ledger in `docs/index.md`.
2. Add or reorganize topic-sized concise sections for new subsystems.
3. Update every affected deep dive independently.
4. Keep deep dives in the human site and the concise reference in the agent bundle unless the content policy intentionally changes.
5. Keep official `main` links clearly distinguished from pinned-version claims.
6. Remove obsolete APIs rather than leaving copyable dead examples.
7. Never edit generated `dist/**` to fix source drift.
8. Search all tracked source/configuration files for current-target assertions and update them deliberately:

   ```bash
   rg -n '<old-version>|<old-commit>' docs handbook.ts handbook-capabilities.ts validation evals .vitepress README.md package.json scripts .github
   ```

   Preserve intentionally historical migration references. Current-version text in navigation, footers, install snippets, and source links must not drift from `docs/index.md`.
9. Update `handbookRelease`, capability `since.availableBy` metadata, recipe install commands, `validation/target.json`, the tracked validation package/lockfile, deep-dive summaries, and capability import groups together. Add retrieval cases for important new selection decisions and keep multi-primitive cases marked `match: "all"`.
10. Regenerate and verify the catalog, example inventory and validation plan, per-page Markdown, focused bundles, `llms.txt`, concise aggregate, and standalone HTML through the normal build; never hand-edit any of them. The public inventory declares required checks but does not embed transient pass/fail evidence; ignored `.validation/generated/**` is the evidence-bearing output.

## 9. Run deterministic completion gates

Run all of these after the final edit:

```bash
pnpm install --frozen-lockfile
node --test <skill-dir>/scripts/*.test.ts
pnpm docs:unit
pnpm docs:eval
pnpm docs:check
pnpm docs:examples
pnpm docs:build
pnpm docs:verify
pnpm docs:smoke
VITEPRESS_BASE=/review-base/ pnpm docs:build
VITEPRESS_BASE=/review-base/ pnpm docs:verify -- --base /review-base/
VITEPRESS_BASE=/review-base/ pnpm docs:smoke -- --base /review-base/
pnpm docs:build
pnpm docs:verify
pnpm docs:smoke
pnpm docs:links
node <skill-dir>/scripts/audit-source-coverage.ts --docs docs --manifest handbook.ts --effect .reference/effect-<version>
git diff --check
git status --short
```

`pnpm docs:examples` must run target/package coherence, fresh extraction, strict TypeScript, strict Effect diagnostics, expected-invalid checks, doctests, and runtime probes. Inspect its generated manifest/results instead of treating a zero exit alone as sufficient evidence. A generic site check is not a substitute. The final root-base build/verify/smoke sequence intentionally leaves `dist/` ready for local preview.

Keep the same guarantees in CI: run root/skill units and Markdown preflight first, then example validation and the VitePress/artifact build in parallel; deployment waits for both plus static and browser verification. External-link checking belongs in the weekly/manual workflow. The latest-v4 resolver and public-surface coverage belong in weekly/manual validation and every refresh; the full delta and semantic review is refresh-only.

Verify exact generated agent Markdown parity, no broken routes/fragments/metadata/sitemap entries, and a clean browser console on desktop, mobile, and standalone `file://`. Treat chunk-size warnings separately from correctness failures.

Immediately before final reporting, rerun the release resolver. If a newer published v4 appeared during the audit, restart against it or clearly report that the completed target is no longer latest and obtain direction before claiming completion.

## 10. Report evidence and boundaries

Report:

- baseline and target versions, tags, commits, and publication dates;
- changelog/PR range reviewed;
- canonical pages and deep dives reviewed;
- stable/unstable module and public-package coverage totals;
- fence totals by `compile` / `contextual` / `run` / `pseudocode` / `invalid`, named fixtures used, strict TypeScript and Effect results, doctests, expected-negative checks, and runtime probes;
- root and non-root VitePress/browser results;
- generated artifact path and hash;
- capability/example catalog counts, focused bundle coverage, and retrieval Recall@1/Recall@3/complete-case results;
- unresolved ambiguity, skipped checks, or environmental blockers.

Do not say "fully validated" when a lane was sampled, skipped, or inferred. A refresh is complete only when every completion criterion in the audit contract passes.
