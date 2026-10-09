// Scores the agent evaluation: fetch behaviour from fetches.tsv, then strict
// TypeScript + Effect diagnostics and (where possible) execution of main.ts.
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const evalRoot = "/agent/workspace/agent-eval"
const repo = "/agent/workspace/effect-handbook"
const scratch = path.join(repo, ".validation", "agent-eval")
const bin = (name) => path.join(repo, "validation", "node_modules", ".bin", name)
const base = "https://eugene1g.github.io/effect-handbook/"

// The pages a well-routed agent should reach for each task (any one counts as a hit).
const expected = {
  "t1-retry-http": ["concurrency/scheduling-time.md", "interfaces/http-client.md", "recipes/retry-with-test-clock.md", "deep-dives/failure-retry-fallback-and-interruption.md"],
  "t2-bounded-worker": ["recipes/resource-safe-bounded-worker.md", "concurrency/concurrency-coordination.md", "deep-dives/structured-concurrency-through-a-bounded-worker.md"],
  "t3-schema-decode": ["data/schema.md", "data/schema-in-depth.md", "deep-dives/schema-from-external-input-to-domain-and-back.md"],
  "t4-service-layers": ["recipes/service-and-layers.md", "foundations/services-context-layers.md", "tooling/testing-dev-tooling.md"],
  "t5-httpapi": ["interfaces/http-api.md", "recipes/schema-httpapi-sql-boundary.md"],
  "t6-cache": ["operations/caching-batching.md"],
  "t7-ndjson-stream": ["concurrency/streaming-channels.md", "deep-dives/streaming-ingestion-without-accidental-buffering.md", "interfaces/platform-runtime-hosts.md"],
  "t8-express-cancel": ["recipes/request-cancellation-through-a-host.md", "recipes/managed-runtime-integration.md"],
  "t9-otlp": ["operations/telemetry-export.md", "recipes/production-observability.md", "operations/observability.md"],
  "t10-durability": ["deep-dives/durability-and-distribution-ladder.md", "reference/choosing-effect-primitives.md", "systems/workflows-durable-execution.md"]
}

const expressStub = `declare module "express" {
  const express: any
  export default express
  export type Request = any
  export type Response = any
  export type NextFunction = any
}
`

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeout ?? 180_000, cwd: options.cwd ?? repo, env: { ...process.env, NO_COLOR: "1", ...options.env } })
  return { code: result.status, signal: result.signal, output: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

const rows = []
for (const task of Object.keys(expected)) {
  const dir = path.join(evalRoot, task)
  const row = { task }
  const fetches = existsSync(path.join(dir, "fetches.tsv"))
    ? readFileSync(path.join(dir, "fetches.tsv"), "utf8").trim().split("\n").filter(Boolean).map((line) => { const [ts, words, url] = line.split("\t"); return { ts: Number(ts), words: Number(words), url } })
    : []
  row.fetches = fetches.length
  row.words = fetches.reduce((sum, fetch) => sum + fetch.words, 0)
  row.path = fetches.map((fetch) => fetch.url.replace(base, "").replace(/#.*/, "") || "(root)")
  const contentFetches = row.path.filter((page) => !["llms.txt", "reference/agent-guide.md", "effect-4-essentials.md", "versions.json"].includes(page))
  row.usedEssentials = row.path.includes("effect-4-essentials.md")
  row.usedAgentGuide = row.path.includes("reference/agent-guide.md")
  row.firstContentPage = contentFetches[0] ?? null
  row.firstContentHit = expected[task].includes(row.firstContentPage ?? "")
  row.anyHit = contentFetches.some((page) => expected[task].includes(page))
  row.fetchedAggregate = row.path.some((page) => page === "effect-4-handbook.md" || page === "llms-full.txt")
  const report = existsSync(path.join(dir, "report.json")) ? JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8")) : null
  row.edition = report?.edition ?? null
  row.citations = report?.citations?.length ?? 0
  row.confidence = report?.confidence ?? null

  const sources = ["main.ts", "main.test.ts"].filter((file) => existsSync(path.join(dir, file)))
  if (sources.length === 0) {
    row.typescript = existsSync(path.join(dir, "answer.md")) ? "n/a (decision task)" : "missing"
    rows.push(row)
    continue
  }
  const project = path.join(scratch, task)
  rmSync(project, { recursive: true, force: true })
  mkdirSync(project, { recursive: true })
  for (const file of sources) cpSync(path.join(dir, file), path.join(project, file))
  const include = [...sources]
  if (sources.some((file) => readFileSync(path.join(dir, file), "utf8").includes('from "express"'))) {
    writeFileSync(path.join(project, "express-stub.d.ts"), expressStub)
    include.push("express-stub.d.ts")
  }
  writeFileSync(path.join(project, "tsconfig.json"), JSON.stringify({ extends: path.relative(project, path.join(repo, "validation", "tsconfig.base.json")), include }, null, 2))
  const tsc = run(bin("tsc"), ["--noEmit", "--project", path.join(project, "tsconfig.json")], { cwd: path.join(repo, "validation") })
  const tsErrors = [...tsc.output.matchAll(/error TS\d+: [^\n]+/g)].map((match) => match[0])
  row.typescript = tsErrors.length === 0 ? "pass" : `${tsErrors.length} error(s)`
  row.tsErrors = tsErrors.slice(0, 8)
  const effect = run(bin("effect-tsgo"), ["diagnostics", "--project", path.join(project, "tsconfig.json"), "--strict", "--format", "text"], { cwd: path.join(repo, "validation") })
  const effectProblems = effect.output.split("\n").filter((line) => /\(\d+,\d+\):\s*(error|warning)\b/i.test(line))
  row.effectDiagnostics = effectProblems.length === 0 ? "pass" : `${effectProblems.length} problem(s)`
  row.effectProblems = effectProblems.slice(0, 8)
  if (sources.includes("main.ts") && !readFileSync(path.join(dir, "main.ts"), "utf8").includes('from "express"')) {
    const exec = run(process.execPath, ["--import", path.join(repo, ".validation", "generated", "projects", "execute", "network-guard.mjs"), path.join(project, "main.ts")], { cwd: project, timeout: 15_000 })
    row.run = exec.signal === "SIGTERM" ? "still running at 15s" : exec.code === 0 ? "exit 0" : `exit ${exec.code}`
    row.runTail = exec.output.trim().split("\n").slice(-6).join("\n").slice(0, 800)
  } else {
    row.run = "not run (needs express)"
  }
  if (sources.includes("main.test.ts")) {
    writeFileSync(path.join(project, "vitest.config.ts"), `import { defineConfig } from "vitest/config"\nexport default defineConfig({ test: { root: ${JSON.stringify(project)}, include: ["main.test.ts"] } })\n`)
    const vitest = run(bin("vitest"), ["run", "--config", path.join(project, "vitest.config.ts")], { cwd: path.join(repo, "validation") })
    const summary = vitest.output.match(/Tests\s+([^\n]+)/)
    row.tests = summary ? summary[1].trim() : `vitest exit ${vitest.code}`
  }
  rows.push(row)
}
writeFileSync(path.join(evalRoot, "scores.json"), JSON.stringify(rows, null, 2))
for (const row of rows) {
  console.log(`${row.task.padEnd(20)} fetches=${row.fetches} words=${row.words} essentials=${row.usedEssentials} firstHit=${row.firstContentHit} anyHit=${row.anyHit} ts=${row.typescript} effect=${row.effectDiagnostics ?? "-"} run=${row.run ?? "-"} tests=${row.tests ?? "-"}`)
}
