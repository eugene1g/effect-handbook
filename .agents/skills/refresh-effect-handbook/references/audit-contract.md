# Effect Handbook Audit Contract

Use this contract to decide what evidence is sufficient and when the refresh is complete. Counts and versions are deliberately dynamic.

## Contents

- [Authority order](#authority-order)
- [Required audit lanes](#required-audit-lanes)
- [Validator cadence](#validator-cadence)
- [Finding severity](#finding-severity)
- [Evidence record](#evidence-record)
- [Completion criteria](#completion-criteria)

## Authority order

Use evidence in this order:

1. Exact published package plus the matching tagged implementation and exported types.
2. Tests and examples at the same tag.
3. Changelogs, changesets, commits, and linked PRs in the baseline-to-target range.
4. Runtime probes using the exact published package.
5. Official guides on `main`, only as clearly labeled companion material.

When sources disagree, reproduce the behavior and describe the discrepancy. Do not silently prefer prose over implementation.

## Required audit lanes

### Release identity

- Resolve all published v4 versions from npm metadata.
- Select the highest semantic version unless the user restricts the channel.
- If that release is deprecated, flag and investigate it; never silently fall back to an older version.
- Record version, tag, publication time, npm `gitHead`, source commit, and matching dist-tags.
- Confirm every installed `effect` and `@effect/*` package is version-coherent.

### Release delta

- Diff from the version currently named in `docs/index.md`.
- Read all package changelogs and changesets in the range.
- Inspect linked PRs and implementation diffs for documentation-significant changes.
- Classify each item as API, type inference, behavior, error/context, lifetime/concurrency, wire/persistence, security/deployment, documentation-only, or irrelevant.
- Give wire, persistence, security, and deployment changes the highest migration priority.

### Surface inventory

- Enumerate stable namespaces from `packages/effect/src/index.ts`.
- Enumerate every unstable family and its namespace exports.
- Inspect package export maps for public paths not represented by namespace barrels.
- Enumerate all non-private package manifests below `packages/`.
- Walk private/internal/experimental folders and tools; record public concepts, adapters, and migration implications even when they do not receive standalone headings.
- Keep a machine-produced tree/export inventory with one disposition per entry so "reviewed everything" is reproducible.
- Require zero unexplained public-module or public-package coverage deficits.

### Page and section correctness

- Derive the canonical inventory from `sitePages`, not from `dist/`.
- Report concise `handbookPages` coverage separately from complete `sitePages` coverage.
- Keep a positive audit-matrix row for every page and H2/H3, even when no finding is recorded.
- Review every H1/H2/H3 outside fences.
- Check every import path and API token against the target.
- Check overloads, generic ordering, inference, encoded/decoded types, error and requirement channels, defaults, and platform constraints.
- Verify lifecycle claims: scope, disposal, memoization, caching, retries, interruption, batching, and concurrency.
- Verify data-contract claims: Schema acceptance, finite/integer domains, JSON/wire formats, encryption, persistence, hydration, and version compatibility.
- Review tables, callouts, captions, comments, and pseudocode; bugs often hide outside executable lines.
- Check that concise topics remain agent-efficient and deep dives remain connected, pedagogical, and current.

### Example validation

- Extract all `ts`, `typescript`, and `tsx` fences from concise pages and deep dives.
- Treat Markdown as the only authored example source; generate ordinary `.ts` / `.tsx` files under ignored `.validation/generated/` on every run.
- Give every fence exactly one disposition: `compile`, `contextual`, `run`, `pseudocode`, or `invalid`.
- Compile `compile` examples in isolation with TypeScript 7 strict mode.
- Compile every `contextual` example with one named, tracked fixture; preserving a hash is inventory evidence, not type evidence.
- Execute deterministic `run` examples or doctests and assert observable results and cleanup.
- Keep `pseudocode` visibly labelled in Markdown with a specific justification. Keep `invalid` examples paired with an exact expected diagnostic assertion.
- Run strict Effect diagnostics with zero errors and zero warnings across every valid compiled disposition.
- Use exact installed target packages.
- Runtime-probe every disputed or non-obvious semantic claim.
- Classify every semantic claim in the page matrix as source-proven, type-proven, or runtime-probe-required.
- Distinguish expected missing application fixtures from genuine API/type failures; never approve by diagnostic code alone.
- Reject missing or duplicate stable ids, unclassified fences, stale hashes, orphan fixtures/probes, unused expected diagnostics, and generated-manifest coverage gaps.
- Record source page, heading, line, code hash, disposition, fixture, platform/packages, TypeScript result, Effect result, and runtime association in the generated manifest.

### Site and artifact validation

- Keep `docs/**` as the single editable source.
- Ensure `handbook.ts` has a unique route for every page and the intended concise/deep-dive split.
- Run source structure checks, VitePress builds, static link/fragment crawl, and browser smoke tests.
- Test both `/` and a non-root Pages base, then rebuild `/` for preview.
- Verify the agent Markdown is generated only from intended concise pages and its local links resolve from the published root.
- Check `git diff --check`; do not require a clean worktree when the user's intended edits are present.

## Validator cadence

Keep reusable validators, fixtures, probes, exact dependency pins, and lockfiles tracked. Keep generated snippets, Effect source clones, audit matrices, reports, logs, dependencies, and `dist/` ignored.

Run on every pull request:

1. refresh-skill and root validator unit tests;
2. canonical Markdown inventory, hierarchy, fence, and manifest checks;
3. fresh extraction, package coherence, strict TypeScript, strict Effect diagnostics, doctests, and semantic probes;
4. agent/page/standalone artifact parity;
5. static routes, links, fragments, metadata, and sitemap crawl;
6. browser smoke on hosted routes and standalone `file://`.

Run external HTTP-link validation weekly and manually. Run latest-v4 resolution and public-surface coverage weekly, manually, and for every release refresh. Perform the full release-delta and source-semantic review only for a version refresh. Parallelize example validation and site build after their shared unit/Markdown preflight; deployment must wait for both.

## Finding severity

- **P0:** Copyable code fails against the target; removed/nonexistent API; wrong error or requirement channel; security, persistence, or wire claim is unsafe; documented behavior is the opposite of runtime behavior.
- **P1:** Important missing public subsystem; misleading default/lifetime/concurrency claim; major version-delta omission; example needs non-obvious repair.
- **P2:** Discoverability, navigation, hierarchy, terminology, or useful-but-noncritical API omission.
- **P3:** Style and polish with no material effect on correctness or use.

Resolve P0 and P1 before declaring completion. Record consciously deferred P2/P3 items.

## Evidence record

Maintain an ignored audit report with one row per finding:

| Page and section | Claim/API | Target source/test | Delta/PR | Type/runtime evidence | Action | Status |
| --- | --- | --- | --- | --- | --- | --- |

Also keep:

- release ledger;
- public-surface inventory JSON;
- fence manifest and diagnostics;
- runtime probe sources and outputs;
- final command log and artifact hashes.

Every evidence artifact must record the target version and source commit plus a hash of the canonical Markdown or extracted-fence manifest it represents. Reject stale artifacts that merely use names such as `current` or `latest`.

## Completion criteria

Declare the refresh complete only when:

1. Release identity is exact and reproducible.
2. Every documentation-significant delta has a disposition.
3. Public module and package deficits are zero or explicitly justified.
4. Every canonical page and deep dive has been reviewed against tagged source.
5. Every example has its declared disposition proven: isolated compilation, typed contextual fixture, runtime/doctest assertion, visible pseudocode justification, or exact expected-invalid diagnostic. Every valid compiled example also has strict Effect diagnostic evidence.
6. P0/P1 findings are resolved.
7. Root and non-root site builds, crawls, and browser checks pass.
8. The root `dist/` preview is regenerated from canonical Markdown.
9. The final report states limitations without overstating coverage.
