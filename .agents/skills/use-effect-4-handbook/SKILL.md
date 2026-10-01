---
name: use-effect-4-handbook
description: Consult the Effect 4 Handbook efficiently when writing, reviewing, or debugging TypeScript that uses effect 4.x or @effect/* packages. Use when a task needs to pick an Effect primitive, look up a module's import path or stability, find a validated example, diagnose an Effect diagnostic or runtime symptom, or cite the handbook. Fetches only Markdown artifacts, never HTML. Do not use for editing or refreshing the handbook itself (see refresh-effect-handbook).
---

# Use the Effect 4 Handbook

The handbook is a source-audited guide to one Effect release, published as Markdown twins of every page plus a routing index, a module index, domain bundles, and JSON catalogs. Set `HANDBOOK` to the site root (for example `https://example.github.io/effect-handbook/`); when working inside this repository after `pnpm docs:build`, `dist/` holds the same files.

## Rules

1. **Markdown only.** Append `.md` to any page path (`/` → `index.md`, `deep-dives/` → `deep-dives/index.md`). Never fetch an HTML route or `effect-4-handbook.html`.
2. **Pick the edition for the installed version.** Read `node_modules/effect/package.json`, take `major.minor`, and use `$HANDBOOK/<major.minor>/` as the base for everything below (`$HANDBOOK/4.0/llms.txt` for effect 4.0.x). `$HANDBOOK/versions.json` lists every published edition with its exact Effect version and audit date; if your minor is absent, use the highest listed edition below it in the same major, never another major. The bare site root is the newest edition.
3. **Start at the edition's `llms.txt`.** It lists every artifact and page with word counts and maps intents to exact sections. Fetch it once per task.
4. **Smallest unit first.** One section beats one page, one page beats one domain bundle, one bundle beats `effect-4-handbook.md`. Budget about 1.3 tokens per word.
5. **Installed package wins.** When `node_modules/effect` (its `AGENTS.md`, `ai-docs/src`, or `.d.ts` files) disagrees with the handbook, trust the installed version and note the drift.
6. **Cite edition + twin + anchor**, for example `4.0/foundations/core-runtime-execution.md#effect`, and name the audited release from the twin's first line.

## Procedure by task

**Choose a primitive.** Read the "Intent and primitive map" in `llms.txt`; match the user's words against the task aliases, then fetch the linked section. For a close call between two tools, fetch `reference/choosing-effect-primitives.md`.

**Look up a module.** Fetch `$HANDBOOK/effect-4-modules.md` and search for the module name. Each row gives the import subpath, the stability badge (`stable` follows semver, `unstable` may change in a minor, `experimental` in a patch), and the twin anchor. `effect-4-modules.json` carries the same rows for tooling.

**Work in one subsystem.** Fetch the bundle: `effect-4-core.md` (runtime, services, errors, config, data, schema, caching, testing), `effect-4-web.md` (HTTP client/server/API, RPC, hosts, reactivity), `effect-4-concurrency.md` (fibers, STM, refs, streams, scheduling), `effect-4-distributed.md` (persistence, SQL, workflows, cluster, event log), `effect-4-ai.md` (language models, tools, MCP, observability).

**Need a complete program.** Fetch a `recipes/*.md` twin; every recipe is a single runnable file executed by the handbook's harness. Check `effect-4-examples.json` when you need to know whether a fence is `compile`, `contextual` (needs a named fixture's declarations), `run`, `pseudocode` (sketch only), or `invalid` (deliberate counter-example).

**Diagnose an error.** Fetch `troubleshooting/troubleshooting-and-anti-patterns.md` and search for the diagnostic text or symptom; rows give cause and fix with links to the canonical section.

**Review Effect code.** Fetch `reference/review-checklists.md` and apply the checklist for the boundary under review (services, errors, lifetimes, concurrency, HTTP/RPC, persistence, observability, tests, MCP servers).

## Shape of the artifacts

| File | Use |
| --- | --- |
| `versions.json` | Published editions (one per Effect major.minor) with exact versions, audit dates, and per-edition entry URLs. |
| `llms.txt` | Routing index with sizes; always first within an edition. |
| `effect-4-modules.md` / `.json` | Module name → import path, stability, twin anchor. |
| `effect-4-catalog.json` | Capability ids, task aliases, choose/avoid boundaries, alternatives, error/requirement/lifetime facts, canonical anchors. |
| `effect-4-examples.json` | Every fence with `source`, `heading`, `sha256`, `disposition`, `fixture`, `requiredChecks`. |
| `effect-4-{core,web,concurrency,distributed,ai}.md` | Domain bundles; links already point at twins. |
| `effect-4-handbook.md` = `llms-full.txt` | All concise pages plus deep-dive summaries; cross-cutting work only. |
| `<page>.md` | Twin of one page: provenance header, optional contents line, twin links. |

The full protocol, including a drop-in `AGENTS.md` block, is the page `reference/agent-guide.md`.
