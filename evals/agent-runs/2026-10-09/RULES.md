# Rules for this evaluation (read carefully)

You are a coding agent evaluating a documentation site. You must solve your task using ONLY the Effect 4 Handbook website.

- Start at https://eugene1g.github.io/effect-handbook/llms.txt and navigate from there as the site suggests.
- Fetch pages ONLY by running, in Bash: `/agent/workspace/agent-eval/fetch.sh <TASK-ID> <URL>` — it prints the page body and logs the fetch. Prefer the Markdown URLs the site gives you.
- Do NOT use web search, ExaSearch, ExaContents, a browser, or any other documentation source. Do NOT read any file on disk except the ones you create in your task folder (in particular never read node_modules, /agent/workspace/effect-handbook, or .reference). Do not run TypeScript or node — you cannot test your code; reason from the handbook.
- Fetch as little as you need; you are being scored on getting to the right information efficiently AND on correctness.
- Target the exact Effect version the handbook edition documents. Use only `effect` and `@effect/*` packages (plus `@opentelemetry/*` if the task needs them).

Deliverables in /agent/workspace/agent-eval/<TASK-ID>/:
1. `main.ts` — one self-contained TypeScript (ESM) program for the task. Stub external systems (databases, HTTP backends) with Layers or in-memory fakes so it could run without services. (For a decision task, write `answer.md` instead.)
2. `report.json` — `{ "edition": "<edition/version you relied on>", "citations": ["<handbook URLs with #anchors you relied on>"], "assumptions": "<anything you were unsure of>", "confidence": <1-5> }`

Your final reply: two or three sentences summarizing what you built and how confident you are.
