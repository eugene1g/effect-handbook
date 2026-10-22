# Handbook retrieval and generation evaluations

`retrieval-cases.json` is the checked-in intent and primitive-selection contract. `pnpm docs:eval` measures deterministic catalog retrieval with required-primitive Recall@1, Recall@3, mean reciprocal rank, and complete-case coverage. Multi-primitive comparisons use `"match": "all"`, so retrieving one plausible choice cannot hide missing alternatives. Every case also identifies acceptable alternatives, a forbidden wrong turn, and expected capabilities whose catalog records carry canonical page/anchor plus error, requirement, and lifetime facts.

The deterministic lane does not pretend to evaluate an LLM. For a periodic model evaluation, give the model only the generated `llms.txt`, ask each case's `query`, and score its answer against:

1. `expected` and `acceptable` primitive IDs;
2. the `forbidden` anti-patterns;
3. the expected capability's error channel, required services, and lifetime behavior;
4. strict TypeScript and Effect diagnostics for any generated code;
5. a focused runtime assertion when cleanup, interruption, concurrency, retry, or durability is part of the claim.

Record model/version, handbook catalog hash, prompt, selected capability IDs, generated-code diagnostics, and runtime results. This separates a deterministic PR gate from a networked, potentially nondeterministic periodic model benchmark.

## Agent runs

`agent-runs/<date>/` records end-to-end evaluations with real coding agents: each agent gets only the live `llms.txt` and one task, fetches the site through a logging wrapper, and its program is then compiled with the validation settings, executed, and tested. Each run keeps its rules, tasks, scoring script, raw scores, the agents' outputs, and a `REPORT.md` with findings and the changes they led to. The scripts record the sandbox paths they ran with; adjust them to rerun. See [2026-10-09](agent-runs/2026-10-09/REPORT.md).

## Portable solution tasks

The separate `task-contracts.json` suite evaluates **generated programs**, not catalog ranking or forbidden-string matches. Historical results are unchanged. Three tasks cover request cancellation and failure classification, field-local configuration defaults and malformed supplied ports, and tenant-isolated deduplicated batching. Inputs and external functions are supplied by `task-runtime.ts`; there are no live dependencies.

From the repository root, with the exact workspace dependencies already installed and a built handbook snapshot available:

```sh
node scripts/evaluate-agent-tasks.ts prepare .validation/agent-run dist
# Manually give each fresh agent its task's TASK.md and access to fetch.mjs.
# From .validation/agent-run/host, for example:
node ../fetch.mjs llms.txt
node ../fetch.mjs foundations/core-runtime-execution.md
# Agents submit host/main.ts + host/report.json, and likewise config/ and tenants/.
node scripts/evaluate-agent-tasks.ts score .validation/agent-run 15000
node --test scripts/evaluate-agent-tasks.test.ts
```

Use paths actually listed in the snapshot index. The fetch wrapper accepts snapshot-relative `.md` files and `llms.txt` only, logs requested paths/anchors, time and content SHA-256 to `fetch.jsonl`, and never fetches the network. All tasks currently share this run-level log; use separate prepared runs when independent per-agent provenance is needed. Network/model generation is explicit and manual, never a CI dependency. `prepare` refuses an existing manifest and copies the built snapshot; it does not build documentation. Run directories must live beneath ignored `.validation/` or `.reference/`.

Each `report.json` supplies the real generator identity and citations, for example:

```json
{"generator":{"agent":"supplied agent name","model":"only if known"},"citations":["foundations/core-runtime-execution.md#effect"],"notes":"How this solution was generated"}
```

No identity is inferred. `score` writes `scores.json` and exits nonzero unless every task passes. It records snapshot target and exact declared workspace packages, canonical/catalog hashes (rechecked before scoring), task/solution/grader hashes, supplied reports, fetch provenance or its absence, tool version output, Node version, missing artifacts, separate TypeScript/strict Effect/runtime outcomes, output and timeouts. TypeScript extends `validation/tsconfig.base.json`; strict Effect diagnostics reject warnings as well as errors. Runtime is skipped if either static lane fails. Each subprocess has a default 15-second timeout, overrideable by the final argument in milliseconds. Scoring writes its own package/config files and workspace dependency symlink into each task directory; only `main.ts` is an intended submission source.

Behavioral tests use asymmetric values, missing records, duplicate IDs, separate tenants, pre-aborted and never-settling work, ordinary rejection, and malformed/range-boundary configuration values. The public prepare/score tests accept hand-authored behavioral controls and reject ignored downstream aborts, group-default-like host loss, cross-tenant grouping, compile errors, missing artifacts, and hanging programs. These controls are **not model runs**, and deliberately do not claim primitive conformance. Passing observable behavior and Effect diagnostics does not prove Effect or Config was used: inspect that instruction separately, along with citation relevance. Empty citations and missing fetch logs are recorded rather than fabricated or treated as runtime failures.

**Security boundary:** submissions are trusted evaluation programs. A killed process timeout is not a sandbox, does not restrict filesystem/network access, and does not guarantee descendant cleanup. Run untrusted code only in a separate restricted execution environment. Fetch logs and agent reports are provenance claims, not tamper-proof attestations. Do not expose secrets to evaluation programs.

`pnpm docs:tasks prepare ...` and `pnpm docs:tasks score ...` are aliases for the direct commands above. `pnpm docs:unit` runs the grader controls in CI without an LLM/API or documentation build; they create and remove a test-only snapshot in ignored storage. Task contracts and workspace packages must still match the prepared run when scoring.
