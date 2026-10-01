# Using the Handbook from an Agent

This page is the reading protocol for coding agents and the tools that drive them. It says which generated artifact to fetch for which task, how to stay in Markdown instead of HTML, what the structured catalogs mean, how to cite a section, and what to do when the handbook does not answer. Humans are welcome too, but every rule below is written so an agent can follow it without judgment calls.

## The one rule: fetch Markdown, never HTML

Every page of this site exists twice at the same path: the rendered HTML route and a Markdown twin with `.md` appended. `/data/schema` is a web page; `/data/schema.md` is the same content as plain Markdown. The landing page `/` is `/index.md`, and a section landing such as `/deep-dives/` is `/deep-dives/index.md`.

Always request the twin:

- It is one third the size of the rendered HTML and contains nothing but the page.
- Its headings carry the same anchors as the HTML, so `/data/schema.md#schemaissue` and `/data/schema#schemaissue` name the same section.
- Every internal link inside a twin already points at another twin, so following links never lands you on HTML.
- The first line is an HTML comment naming the page, the audited Effect release, and the three agent entry points (`llms.txt`, the module index, and this guide). Treat it as provenance; nothing else is injected.

The HTML pages advertise the same thing for crawlers: each one carries `<link rel="alternate" type="text/markdown">` to its twin and `<link rel="describedby">` to `llms.txt`, and `robots.txt` repeats the entry points. If you are reading HTML, you have taken a wrong turn — append `.md` and fetch again.

Long twins (eight or more top-level sections) open with a generated **Contents** line listing every section with its anchor, so you can decide what to read before reading it.

## Match the edition to the installed Effect version

The handbook is published as **editions**, one per Effect `major.minor`, each audited against one exact release. The site root always serves the newest edition; every edition, including the newest, is also served under its own path — `/4.0/`, `/4.1/`, `/5.0/` — with the same relative layout, so `/4.0/data/schema.md` and `/5.0/data/schema.md` are the same page for different Effect versions.

Before reading anything else:

1. Read the installed version from `node_modules/effect/package.json`.
2. Take its `major.minor` and fetch that edition's `llms.txt`, for example `/4.0/llms.txt` for `effect@4.0.3`.
3. If that path is missing, fetch `/versions.json` at the site root. It lists every published edition with its `effectVersion`, audit date, status (`latest` or `frozen`), and the URLs of its `llms.txt`, module index, and catalog. Use the highest listed edition below yours **within the same major**; editions of different majors describe different libraries and are never interchangeable.
4. State the edition and audited release you used when you answer.

Every edition's `llms.txt` opens with its own edition and release and has an **Editions** section linking to the others, so you can correct course from any entry point. A frozen edition is rebuilt from its git tag, never edited, so what you read there will not change under you; the HTML pages of a frozen edition show a banner pointing at the newest handbook, but the Markdown twins do not.

## Which artifact to fetch for which task

Start at `llms.txt`. It is a few thousand words, lists every page and bundle with its current word count, and maps common intents to the exact section that answers them. From there, pick by task:

| Task | Fetch | Why |
| --- | --- | --- |
| "Which primitive do I use for X?" | `llms.txt` → the **Intent and primitive map**, then the linked section | One hop to the canonical paragraph, with alternatives listed next to it. |
| Decide between two or three similar tools | [Choosing Effect Primitives](./choosing-effect-primitives) | Contrastive tables by error channel, lifetime, backpressure, durability, and distribution. |
| Look up one module by name | `effect-4-modules.md` (or `.json`) | Alphabetical and per-area list of every module section with import path, stability badge, and twin anchor. |
| Work inside one subsystem for a while | The matching domain bundle `effect-4-{core,web,concurrency,distributed,ai}.md` | All pages that subsystem needs, pre-concatenated, with cross-links already rewritten to twins. |
| Review or generate code across the whole library | `effect-4-handbook.md` (identical to `llms-full.txt`) | Every concise page in reading order plus compact deep-dive summaries. Large; use it when the task is genuinely cross-cutting. |
| Program against the handbook (tooling, RAG, evaluation) | `effect-4-catalog.json`, `effect-4-examples.json`, `effect-4-modules.json` | Stable ids, task aliases, selection boundaries, and every example's disposition and hash. |
| Diagnose a compiler error or runtime symptom | [Troubleshooting & Anti-Patterns](../troubleshooting/troubleshooting-and-anti-patterns) | Symptom → cause → fix tables, searchable by the exact diagnostic text. |
| Produce a complete program | A page under `recipes/` | Each recipe is a single runnable file that the harness executes with asserted output. |
| Understand how pieces compose into an application | A page under `deep-dives/` | Long-form; excluded from the aggregate and bundles on purpose. Fetch one only when the task needs the connected tutorial. |

Budget roughly 1.3 tokens per word for prose pages and more for code-heavy pages; `llms.txt` gives the word counts so you can choose before fetching. Prefer one page over one bundle, and one bundle over the aggregate.

## Reading the capability catalog

`effect-4-catalog.json` is the structured form of the handbook's selection guidance. Each entry in `capabilities` describes one thing an agent might reach for:

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier such as `effect.program` or `ai.mcp-approval`. Cite it in tooling; it does not change when prose moves. |
| `kind` | `decision` (choose between alternatives), `module` (one module's main job), or `recipe` (a complete program). |
| `domain` | The bundle family the entry belongs to; `domains` at the top of the file spells each one out. |
| `symbols`, `imports` | The exact exported names and the subpath to import them from. Root modules are also re-exported from the `"effect"` barrel. |
| `stability` | `stable`, `unstable`, or `experimental` — the module's `@stability` contract at the audited release. |
| `tasks` | Natural-language aliases for the intent. Match the user's words against these before matching symbol names. |
| `summary`, `chooseWhen`, `avoidWhen`, `alternatives` | The selection boundary, with `alternatives` naming other capability ids to compare against. |
| `errorChannel`, `requirements`, `lifetime`, `platform` | What lands in `E`, what `R` demands, how the value is scoped or cancelled, and whether it is portable or host-specific. |
| `since` | `availableBy` records the audited release in which the capability is known to exist. It does not claim the historical introduction release. |
| `page`, `anchor` | The canonical section. Fetch `page` with `.md` and jump to `#anchor`. |
| `snippetIds` | Ids into the top-level `snippets` array of runnable examples; empty means the entry points only at its reference section. |

The `handbook` object at the top of every JSON artifact records the Effect version, tag, commit, and audit date the data was generated against. Check it before trusting cached copies.

## Reading the example inventory

`effect-4-examples.json` lists every fenced TypeScript example in the handbook with its `source`, `heading`, line range, `sha256`, and `disposition`:

- `compile` — must pass isolated strict TypeScript and strict Effect diagnostics. Safe to lift into a project as written.
- `contextual` — the exact fence passes the same checks inside one named tracked fixture (`fixture`), which supplies surrounding declarations the fence refers to. Expect to add those declarations yourself.
- `run` — compiled and executed by the harness with an asserted result (`runtimeCheckId`). Recipes are `run` examples.
- `pseudocode` — visibly labelled architectural sketches; never paste them as code.
- `invalid` — intentionally wrong code that must produce one precise TypeScript diagnostic, shown to teach what the compiler rejects.

The inventory declares the checks each example must pass; it does not embed pass/fail results. Validation evidence is regenerated by the repository's `pnpm docs:examples` gate on every change.

## Citing and quoting

Cite a section as its Markdown twin URL plus anchor, for example `/foundations/core-runtime-execution.md#effect`. Anchors are derived from the heading text — lower-case, with runs of non-alphanumeric characters replaced by a single hyphen — and a heading that repeats on one page gets a `-1`, `-2` suffix in document order. The module index and the catalog already contain the correct anchors, so copy from them rather than slugifying by hand.

When quoting a code fence, quote the whole fence. The examples are validated as units; a trimmed fragment may drop the import or the type annotation that made it compile.

State the audited release when a claim could change between versions: "the Effect 4 Handbook, audited against `effect@4.0.0`". The release and audit date appear in the header line of every twin and in `handbookRelease` inside the JSON artifacts.

## When the handbook is not enough

The handbook covers the public surface of `effect` and the `@effect/*` packages at one audited release, with one representative example per module rather than a complete API reference. When it does not answer:

1. **The installed package is the ground truth.** `node_modules/effect/AGENTS.md` carries the maintainers' coding conventions and `node_modules/effect/ai-docs/src` their topic-organized examples; both match the version actually installed. Prefer them over any copy of the documentation that may describe a different version, this one included.
2. **Read the declaration files.** Every public module is a single `.d.ts` under `node_modules/effect/dist/` (or the package's `dist/`), with JSDoc that includes the `@stability` tag and usually an example. For `@effect/*` packages the same applies under their own `dist/`.
3. **Check stability before relying on it.** `unstable` APIs may change in a minor release and `experimental` ones in a patch release. The badges on this site were derived from the audited source, not from the import path, since Effect 4 has no `unstable/` path segment.
4. **Report drift.** If the installed source contradicts the handbook, the handbook is wrong or stale. The twin header tells you the release it was audited against.

## Drop-in instructions for your agent

Paste this block into the project's `AGENTS.md`, `CLAUDE.md`, or equivalent and replace the host with the site you are reading. Everything it says is enforceable with a plain HTTP client.

```md
## Effect 4 reference

Use the Effect 4 Handbook at https://HOST/ for Effect questions. Rules:

1. Fetch Markdown, never HTML: append `.md` to any page path (`/` is `/index.md`).
2. Use the edition for the installed version: read `node_modules/effect/package.json`, take `major.minor`, and prefix every path with it (`https://HOST/4.0/llms.txt` for effect 4.0.x). https://HOST/versions.json lists the published editions; never use an edition from a different major.
3. Start at that edition's `llms.txt`. Use its "Intent and primitive map" to find the exact section; use its `effect-4-modules.md` when you already know the module name.
4. Fetch one page or one domain bundle (`effect-4-core.md`, `-web`, `-concurrency`, `-distributed`, `-ai`) rather than the full `effect-4-handbook.md`, unless the task spans the whole library.
5. Prefer `compile` and `run` examples from the edition's `effect-4-examples.json`; treat `pseudocode` fences as sketches and `invalid` fences as counter-examples.
6. The installed `effect` package (`node_modules/effect/AGENTS.md`, `ai-docs/src`, and the `.d.ts` files) wins over the handbook when they disagree.
7. Cite sections as `<edition>/<twin path>#<anchor>` and name the audited release from the twin's first line.
```

The repository also ships the same protocol as an installable skill at `.agents/skills/use-effect-4-handbook/SKILL.md`, for agent frameworks that load skills from a directory.

## What the generated artifacts are

All of these are produced from the Markdown under `docs/` by the repository build and published at the site root. None is edited by hand.

| Artifact | Contents |
| --- | --- |
| `llms.txt` | The routing index: entry points, domain bundles with word counts, the intent and primitive map, and every page with its description and size. |
| `llms-full.txt` | Byte-identical to `effect-4-handbook.md`, published under the name the `llms.txt` convention expects. |
| `effect-4-handbook.md` | Every concise page in reading order plus compact deep-dive architecture summaries. |
| `effect-4-{core,web,concurrency,distributed,ai}.md` | Focused bundles; every capability-owning page appears in at least one. |
| `effect-4-modules.md` / `.json` | Every module section with import path, stability, page, and anchor. |
| `effect-4-catalog.json` | The capability catalog described above. |
| `effect-4-examples.json` | The example inventory described above. |
| `<page>.md` | The Markdown twin of each page, with header, optional contents line, and links rewritten to twins. |
| `effect-4-handbook.html` | A self-contained offline copy of the whole site for humans; agents should not fetch it. |
| `versions.json` | Every published edition — id, exact Effect version, audit date, `latest` or `frozen`, and the URLs of its `llms.txt`, module index, and catalog. Served at the site root and inside every edition. |
| `robots.txt`, `sitemap.xml` | Crawl policy pointing at the entry points above; the sitemap is emitted for production builds with a public URL. |
