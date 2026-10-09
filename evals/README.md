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
