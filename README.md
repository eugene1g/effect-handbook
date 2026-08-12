# The Effect 4 Handbook

This repository keeps one editable Markdown corpus and generates human, offline, and machine-retrieval views from it:

- **Human site:** concise handbook topics and long-form deep dives built with VitePress 2, with navigation, local search, deep links, and dark mode.
- **Agent handbook:** `dist/effect-4-handbook.md`, the complete concise reference, decisions, recipes, troubleshooting, and compact deep-dive architecture summaries. Long-form deep dives stay outside this aggregate.
- **Retrieval artifacts:** `dist/effect-4-catalog.json`, `dist/effect-4-examples.json`, plus focused `effect-4-{core,web,concurrency,distributed,ai}.md` bundles. The catalog maps natural-language intents and symbols to selection guidance, errors, requirements, lifetimes, alternatives, and canonical anchors; the example inventory distinguishes compile, contextual, run, pseudocode, and expected-invalid fences and declares their required checks without pretending transient CI evidence is embedded.
- **Offline handbook:** `dist/effect-4-handbook.html`, one self-contained file with every concise topic and deep dive, inline search/theme/navigation, and embedded source Markdown. Double-click it to open it directly in Chrome; no local server or network connection is required.

Every human page also has an exact Markdown twin at the same path with `.md` appended (`/data/schema` → `/data/schema.md`, and `/` → `/index.md`). The page toolbar can copy that canonical source or open it raw. `dist/llms.txt` is an intent-first routing index; HTML pages advertise both their Markdown twin with `rel="alternate"` and that index with `rel="describedby"`.

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
pnpm docs:build       # build the site, agent Markdown, and offline HTML into dist/
pnpm docs:standalone  # regenerate only the double-clickable offline HTML
pnpm docs:verify      # crawl and verify the production output
pnpm docs:smoke       # exercise both HTTP and file:// builds in headless Chrome
pnpm docs:links       # check external documentation links (also runs weekly in CI)
pnpm docs:eval        # measure catalog retrieval against checked-in realistic intent cases
pnpm docs:examples    # extract and validate every TypeScript/TSX fence
pnpm docs:test        # build and verify everything
```

After `pnpm docs:build`, open [`dist/effect-4-handbook.html`](dist/effect-4-handbook.html) directly in a browser. The file currently contains all 49 pages (39 concise pages and 10 deep-dive pages including the landing page) and offers **Copy page Markdown**, **Copy all Markdown**, and **Download .md** without fetching another asset.

The deterministic retrieval suite is stored in [`evals/retrieval-cases.json`](evals/retrieval-cases.json). It gates Recall@1/Recall@3 and doubles as the rubric for periodic model runs using only `llms.txt`; generated code from those runs must still pass the tracked TypeScript/Effect example validator and focused runtime assertions.

When adding or moving a concise topic, update `handbookGroups` in `handbook.ts`. For a long-form guide, add its Markdown to `docs/deep-dives/` and register it in `deepDiveGroups`. Keep prose portable Markdown rather than using Vue components or VitePress-only syntax.

## Periodic correctness refresh

The repository includes the Codex skill [`$refresh-effect-handbook`](.agents/skills/refresh-effect-handbook/SKILL.md). Invoke it when a new Effect v4 release is published, or whenever the handbook needs a full source-grounded audit:

```text
Use $refresh-effect-handbook to audit and update all handbook topics and deep dives against the latest published Effect v4 release.
```

The skill resolves the release from npm instead of trusting a moving dist-tag, checks out the matching tagged Effect source, reviews the complete release delta and public surface, validates every page and TypeScript example, adds important new subsystems, and regenerates and verifies `dist/`. Its helper scripts produce ignored evidence under `.reference/` and `.validation/`. Authored prose remains in `docs/**`; release, navigation, capability, evaluation, and example-validation inputs live in their tracked manifests and `validation/**`. Generated `dist/**` files are never edited directly.

## Publishing

The Pages workflow builds pull requests for validation and deploys pushes to `main`. It derives the correct base path and public URL for project Pages, user/organization Pages, and custom domains, then uploads root `dist/` as the GitHub Pages artifact. Production builds use that URL for canonical/Open Graph metadata, Markdown alternates, `llms.txt`, and the generated sitemap. The deployed artifact therefore exposes the HTML site and generated documentation formats at stable static URLs without keeping a second authored copy in the repository.

Enable **Settings → Pages → Source: GitHub Actions** once after creating the GitHub repository.
