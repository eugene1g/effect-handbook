# Agent evaluation — 2026-10-09 (edition 4.0, effect@4.0.2)

Ten independent coding agents (Claude Sonnet) were each given only the live site's `llms.txt` URL and one realistic task ([`tasks.md`](tasks.md)), under the rules in [`RULES.md`](RULES.md). They could fetch the handbook only through [`fetch.sh`](fetch.sh), which logged every request; they could not search the web, read installed packages, or run code. [`score.mjs`](score.mjs) then compiled each program with the handbook's own validation settings (TypeScript 7 strict plus strict `@effect/tsgo` diagnostics), executed it with outbound network blocked, and ran any tests. Raw results are in [`scores.json`](scores.json); each agent's program, report, and fetch log are in [`outputs/`](outputs/) (`.ts` files saved as `.ts.txt`).

## Results

| Task | Fetches | Words read | Reached a relevant page | TypeScript | Effect diagnostics | Run |
| --- | --- | --- | --- | --- | --- | --- |
| t1 retry an HTTP call | 11 | 83K | yes | pass | pass | exit 0 |
| t2 bounded worker pool | 8 | 87K | yes | pass | pass | exit 0 |
| t3 Schema boundary | 15 | 101K | yes | pass | pass | exit 0 |
| t4 service + Layers + tests | 8 | 96K | yes | pass | 1 problem (style rule) | exit 0; 5/5 Vitest tests pass |
| t5 HttpApi with typed 404 | 6 | 35K | yes | pass | pass | server listening on :3000 |
| t6 cache without caching failures | 5 | 37K | yes | pass | pass | exit 0 |
| t7 NDJSON streaming | 9 | 93K | yes | 10 errors | 5 problems | failed (`@effect/platform`) |
| t8 Express + cancellation | 5 | 21K | yes | 3 errors (1 Effect: `Layer.scoped`) | pass | not run (needs Express) |
| t9 OTLP telemetry | 5 | 19K | yes | 9 errors | pass | failed |
| t10 durability decision | 3 | 13K | yes | — | — | sound answer (at-least-once with an idempotency key; provider deduplicates) |

- **Correct, runnable code:** 5 of 9 code tasks pass strict TypeScript and strict Effect diagnostics and run; a sixth (t4) differs only by one style diagnostic (`return yield*`) and its tests pass.
- **Routing:** every agent reached a page that answers its task; all ten stated the edition and audited release; none fetched the 233K-word aggregate. Three agents used the new Essentials digest, one read the agent guide.
- **Cost:** median 7 fetches and 60K words per task, but heavily inflated by re-fetches (30 repeats in total) — agents re-read long pages after their own tools truncated the output, and the 11K-word catalog JSON was fetched 10 times.

## What the failures traced back to

The three failing programs used Effect 3 names that do not exist in Effect 4: `@effect/platform` and `Effect.catchAll` (t7), `Layer.scoped` (t8), and `NodeRuntime` imported from `"effect"` (t9). The handbook says each of these in one place (`Layer.scoped` on Services, Context & Layers; `@effect/platform` on Getting Started), but on pages those agents never fetched, and the anti-pattern index — the page meant for checking generated code — did not list them. Three agents also guessed page URLs that do not exist (`services/layers.md`, `reference/http-client.md`, `concurrency/queue-deque-pubsub.md`) and got an HTML 404.

## Changes made in response

- A tracked list of Effect 3 names that do not exist in Effect 4 (`effect3Names` in `handbook.ts`) is rendered at the top of `llms.txt` and the Essentials digest — the two artifacts every agent reads first — and as a table on Generated-Code Anti-Patterns; `docs:check` keeps the three in sync.
- The agent guide's drop-in instructions and the `use-effect-4-handbook` skill now say to take URLs from `llms.txt` instead of guessing, to use Essentials for breadth, and to check the Effect 3 names list before writing code.
- The site's 404 page tells agents to fetch `llms.txt` for page URLs.

## Rerun of the failed tasks after the fix

After the Effect 3 names list went live, the three failed tasks were rerun with fresh agents (`t7b`, `t8b`, `t9b`; raw results in [`scores-rerun.json`](scores-rerun.json)):

| Task | Before | After |
| --- | --- | --- |
| t9 OTLP telemetry | 9 TypeScript errors, failed to run | passes strict TypeScript and Effect diagnostics; runs and exports from a launched Layer |
| t8 Express + cancellation | `Layer.scoped` error | no Effect errors; it used `Layer.effect` with `acquireRelease`. The two remaining errors are untyped Express handler parameters caused by the scorer's minimal `express` stub (also present in the first run) |
| t7 NDJSON streaming | `@effect/platform`, `Effect.catchAll` | both avoided, but it reached for `Schema.decodeUnknown`, another Effect 3 name, and still failed. This rerun is not clean evidence: the agent read the first attempt's file despite the rules |

`Schema.decodeUnknown` / `Schema.encodeUnknown` and `Schema.decode` used as a decoder were added to the list (in Effect 4 the decoders are `Schema.decodeUnknownEffect` and friends, and `Schema.decode` builds a transformation).

## Limitations

One run per task with one model; no repetition, so per-task results are noisy. Agents could not compile or run their code, unlike a real coding agent with a project open — a real agent would catch the three failures with the compiler, so this measures what the handbook alone teaches. The Express program was type-checked against a minimal `express` type stub. Re-fetch counts partly reflect the agents' tool output limits rather than the site.
