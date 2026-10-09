# The Effect 4 Handbook

This repository keeps one editable Markdown corpus and generates human, offline, and machine-retrieval views from it:

- **Human site:** concise handbook topics and long-form deep dives built with VitePress 2, with navigation, local search, deep links, and dark mode.
- **Agent handbook:** `dist/effect-4-handbook.md` (also served as `dist/llms-full.txt`), the complete concise reference, decisions, recipes, troubleshooting, and compact deep-dive architecture summaries. Long-form deep dives stay outside this aggregate.
- **Retrieval artifacts:** `dist/effect-4-catalog.json`, `dist/effect-4-examples.json`, `dist/effect-4-modules.{md,json}`, plus focused `effect-4-{core,web,concurrency,distributed,ai}.md` bundles. The catalog maps natural-language intents and symbols to selection guidance, errors, requirements, lifetimes, alternatives, and canonical anchors; the example inventory distinguishes compile, contextual, run, pseudocode, and expected-invalid fences and declares their required checks without pretending transient CI evidence is embedded; the module index lists every module section with its import path, stability badge, and Markdown anchor.
- **Offline handbook:** `dist/effect-4-handbook.html`, one self-contained file with every concise topic and deep dive, inline search/theme/navigation, and embedded source Markdown. Double-click it to open it directly in Chrome; no local server or network connection is required.

Every human page also has a Markdown twin at the same path with `.md` appended (`/data/schema` → `/data/schema.md`, and `/` → `/index.md`). A twin is the canonical page plus three generated additions that keep an agent inside Markdown: a one-line provenance header, a contents line on long pages, and internal links rewritten to the neighbouring twins. The page toolbar names the twin, can copy it, and opens it raw. `dist/llms.txt` is an intent-first routing index with per-page word counts; HTML pages advertise their twin with `rel="alternate"` and the index with `rel="describedby"`, and `dist/robots.txt` repeats the entry points. [`docs/reference/agent-guide.md`](docs/reference/agent-guide.md) is the reading protocol for agents, and [`.agents/skills/use-effect-4-handbook/`](.agents/skills/use-effect-4-handbook/SKILL.md) packages it as an installable skill.

All editable prose lives under [`docs/`](docs/), and that tree contains Markdown only:

- concise handbook topics are grouped by subject (`foundations/`, `data/`, `systems/`, and so on);
- [`docs/recipes/`](docs/recipes/) contains complete runnable files that remain in the concise agent handbook;
- [`docs/deep-dives/`](docs/deep-dives/) contains longer, application-oriented guides excluded from the concise aggregate;
- [`docs/reference/choosing-effect-primitives.md`](docs/reference/choosing-effect-primitives.md) and [`docs/troubleshooting/troubleshooting-and-anti-patterns.md`](docs/troubleshooting/troubleshooting-and-anti-patterns.md) are the decision and failure-diagnosis front doors;
- [`docs/deep-dives/index.md`](docs/deep-dives/index.md) is the guide landing page.

Page order, routes, sidebar groups, domain bundles, release metadata, and combined-file order live in [`handbook.ts`](handbook.ts). Curated intent metadata lives in [`handbook-capabilities.ts`](handbook-capabilities.ts). Both concise topics and deep dives render in the site; only `handbookPages` plus compact deep-dive summaries feed the combined Markdown.

The root `dist/` directory is wholly generated. A production build puts the compiled site, combined agent Markdown, and self-contained offline HTML there; nothing in `dist/` should be edited by hand or committed to `main`.

## Local development

Node 26.x and pnpm 11.18.0 are required. The root and private `validation` package form one pnpm workspace with one frozen lockfile and one install. All repository tooling is native ESM TypeScript executed directly by Node 26's built-in type stripping: there is no `tsx`, `ts-node`, custom loader, or emitted JavaScript tooling tree. The project pins VitePress exactly to `2.0.0-alpha.19` because VitePress 2 is still an alpha release.

```bash
pnpm install --frozen-lockfile
pnpm docs:dev        # also serves the generated raw Markdown download
```

Useful commands:

```bash
pnpm docs:check       # verify the canonical source inventory and structure
pnpm docs:build       # build the site, agent Markdown, indexes, offline HTML, and every edition into dist/
pnpm docs:standalone  # regenerate only the double-clickable offline HTML
pnpm docs:verify      # crawl and verify the production output
pnpm docs:versions    # re-assemble only the editions in versions.json under dist/<version>/
pnpm docs:smoke       # exercise both HTTP and file:// builds in headless Chrome
pnpm docs:links       # check external links in docs, README, skills, theme, and the site navigation (also runs weekly in CI)
pnpm docs:eval        # measure catalog retrieval against checked-in realistic intent cases
pnpm docs:examples    # extract and validate every TypeScript/TSX fence
pnpm docs:test        # build and verify everything
```

After `pnpm docs:build`, open [`dist/effect-4-handbook.html`](dist/effect-4-handbook.html) directly in a browser. The file currently contains all 64 pages (51 concise pages and 13 deep-dive pages including the landing page) and offers **Copy page Markdown**, **Copy all Markdown**, and **Download .md** without fetching another asset.

The deterministic retrieval suite is stored in [`evals/retrieval-cases.json`](evals/retrieval-cases.json). It gates Recall@1/Recall@3 and doubles as the rubric for periodic model runs using only `llms.txt`; generated code from those runs must still pass the tracked TypeScript/Effect example validator and focused runtime assertions.

When adding or moving a concise topic, update `handbookGroups` in `handbook.ts`. For a long-form guide, add its Markdown to `docs/deep-dives/` and register it in `deepDiveGroups`. Keep prose portable Markdown rather than using Vue components or VitePress-only syntax.

## Multiple Effect versions

The handbook is published as **editions**, one per Effect `major.minor`, so that someone pinned to `effect@4.0.x` keeps an accurate handbook after 4.1, 4.7, or 5.0 ship. [`versions.json`](versions.json) is the single source of truth:

- The `latest` edition is the current checkout. It is built at the site root **and** at `/<id>/` (for example `/4.0/`), so its edition URL stays valid after a newer edition takes over the root.
- Every other edition is **frozen**: it names the git tag (`ref`) it is built from, and the Pages workflow rebuilds it from that tag — with that tag's own dependencies, scripts, and verification — into `/<id>/`. Frozen editions are never edited in place; a correction is a new tag and a new `ref`.
- `pnpm docs:check` refuses to pass unless the `latest` entry names exactly the release and audit date in `handbook.ts`, and unless [`docs/reference/release-history.md`](docs/reference/release-history.md) opens with an entry for that same release. Every refresh, patch releases included, adds one entry: what changed in Effect that a reader must know, and what changed in the handbook.
- Every build publishes `versions.json` (manifest plus resolved URLs) at its root; the site renders an edition switcher in the navigation bar from it, and a frozen edition's pages fetch the root `versions.json` at runtime to show a "newer handbook available" banner without being rebuilt. `llms.txt`, `robots.txt`, and the agent guide route agents to the edition that matches their installed `effect` version.

**Publishing a new edition** (new Effect minor or major, say 4.1.0):

1. Tag the last commit of the current edition: `git tag effect-4.0.2/2026-10-09 <commit>` (Effect version + audit date, the two facts `handbookRelease` records) and push the tag.
2. In `versions.json`, give the 4.0 entry `"ref": "effect-4.0.2/2026-10-09"`, add `{ "id": "4.1", "effectVersion": "4.1.0", "auditedAt": "<date>", "ref": null }`, and set `"latest": "4.1"`.
3. Run the `refresh-effect-handbook` skill against 4.1.0 on `main`; `handbookRelease` and the new entry must agree before `docs:check` passes, and the refresh adds a ``## `effect@4.1.0` — audited <date>`` entry at the top of [`docs/reference/release-history.md`](docs/reference/release-history.md).
4. Merge. The deploy builds `/` and `/4.1/` from `main` and `/4.0/` from the tag. Re-auditing a frozen edition (for example after a 4.0.3 patch touches an `experimental` API) means a new tag and an updated `ref`; the path `/4.0/` does not change.

`pnpm docs:build` always produces the complete tree: the root edition first, then every edition under `dist/<id>/` (the latest from the checkout, frozen ones from their tags in temporary worktrees with their own dependencies and verification). `pnpm docs:verify` checks the root edition and confirms each edition is present; each edition's own `docs:verify` ran during assembly.

## Periodic correctness refresh

The repository includes two Codex-style skills under [`.agents/skills/`](.agents/skills/): [`$use-effect-4-handbook`](.agents/skills/use-effect-4-handbook/SKILL.md) teaches an agent to consume the published Markdown artifacts, and [`$refresh-effect-handbook`](.agents/skills/refresh-effect-handbook/SKILL.md) maintains the handbook. Invoke the latter when a new Effect v4 release is published, or whenever the handbook needs a full source-grounded audit:

```text
Use $refresh-effect-handbook to audit and update all handbook topics and deep dives against the latest published Effect v4 release.
```

The skill resolves the release from npm instead of trusting a moving dist-tag, checks out the matching tagged Effect source, reviews the complete release delta and public surface, validates every page and TypeScript example, adds important new subsystems, and regenerates and verifies `dist/`. Its helper scripts produce ignored evidence under `.reference/` and `.validation/`. Authored prose remains in `docs/**`; release, navigation, capability, evaluation, and example-validation inputs live in their tracked manifests and `validation/**`. Generated `dist/**` files are never edited directly.

## Publishing

The Pages workflow builds pull requests for validation and deploys pushes to `main`. It derives the correct base path and public URL for project Pages, user/organization Pages, and custom domains, then uploads root `dist/` as the GitHub Pages artifact. Production builds use that URL for canonical/Open Graph metadata, Markdown alternates, `llms.txt`, and the generated sitemap. The deployed artifact therefore exposes the HTML site and generated documentation formats at stable static URLs without keeping a second authored copy in the repository.

Enable **Settings → Pages → Source: GitHub Actions** once after creating the GitHub repository.
