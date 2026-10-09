/**
 * Executes every `compile` example, so examples are proven to run, not only to
 * type-check. Each fence is classified before it runs:
 *
 * - `vitest`: imports `@effect/vitest` or `vitest`; all such fences run in one
 *   Vitest batch and every test must pass.
 * - `browser`: needs a browser host (`@effect/platform-browser`, `window`,
 *   `document`); recorded and skipped.
 * - otherwise it runs under Node with outbound network blocked (loopback is
 *   allowed). It must exit 0, or be a long-running program (a server, a launched
 *   Layer) still alive at the timeout.
 *
 * Two failure shapes are accepted and recorded instead of failing the build,
 * because they are part of how a fence is written rather than a bug in it: a
 * ReferenceError for an identifier the fence itself `declare`s as a placeholder,
 * and an attempt to reach the network. Every other failure fails validation.
 *
 * Expected-output comments are asserted: a line `console.log(...) // <value>`
 * whose value is a JSON literal (number, string, boolean, null, array) must
 * appear in the program's output, formatted the way `console.log` prints it.
 */
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inspect } from "node:util"

import { generatedRoot, repositoryRoot, validationRoot } from "./example-model.ts"

const RUN_TIMEOUT_MS = 8_000
const LONG_RUNNING = /\b(?:runMain|Layer\.launch|HttpServer\.serve|HttpRouter\.serve|layerHttp|NodeHttpServer|BunHttpServer|Effect\.never|forever)\b/

export interface ExecutionResult {
  readonly id: string
  readonly status: "executed" | "long-running" | "vitest" | "placeholder" | "needs-network" | "browser" | "other-host"
  readonly assertedOutputs?: number
  readonly detail?: string
}

interface Example {
  readonly id: string
  readonly language: string
  readonly disposition: string
  readonly source: string
}

const guardSource = `import net from "node:net"
import tls from "node:tls"
const loopback = (host) => !host || ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input))
  if (!loopback(url.hostname)) throw new TypeError("example-run: network disabled (" + url.hostname + ")")
  return realFetch(input, init)
}
for (const mod of [net, tls]) {
  const original = mod.connect
  mod.connect = mod.createConnection = function (...args) {
    const options = typeof args[0] === "object" ? args[0] : { host: typeof args[1] === "string" ? args[1] : undefined }
    if (!loopback(options.host)) throw new Error("example-run: network disabled (" + options.host + ")")
    return original.apply(this, args)
  }
}
`

function classify(body: string): "vitest" | "browser" | "host" | "node" {
  if (/from "(?:@effect\/vitest|vitest)"/.test(body)) return "vitest"
  if (/@effect\/platform-browser|\bwindow\.|\bdocument\.|globalThis\.addEventListener/.test(body)) return "browser"
  if (/@effect\/platform-(?:deno|bun)|\bDeno\.|\bBun\./.test(body)) return "host"
  return "node"
}

/** Output comments can only be checked when the fence actually runs a program. */
const RUNS_A_PROGRAM = /\bEffect\.run\w*\(|\bruntime\.run\w*\(|\brunMain\b|\.runPromise\(|\.runSync\(/

export function declaredNames(body: string): Set<string> {
  return new Set([...body.matchAll(/^\s*(?:export\s+)?declare\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]))
}

export function isPlaceholderFailure(output: string, declared: Set<string>): boolean {
  const reference = output.match(/(?:ReferenceError: )?([A-Za-z_$][\w$]*) is not defined/)
  return reference !== null && declared.has(reference[1])
}

/** `console.log(...) // <json literal>` lines, rendered the way console.log prints the value. */
export function expectedOutputs(body: string): Array<string> {
  const expected: Array<string> = []
  for (const match of body.matchAll(/console\.log\((.*)\)\s*\/\/\s*(?:=>\s*)?(.+?)\s*$/gm)) {
    let value: unknown
    try {
      value = JSON.parse(match[2])
    } catch {
      continue
    }
    if (match[1].includes(",")) continue // several arguments: formatting is ambiguous
    expected.push(typeof value === "string" ? value : inspect(value, { depth: Infinity, breakLength: Infinity }))
  }
  return expected
}

function runNode(file: string, guard: string): Promise<{ status: "exit" | "timeout"; code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", guard, file], {
      cwd: repositoryRoot,
      env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { output += chunk })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ status: "timeout", code: null, output })
    }, RUN_TIMEOUT_MS)
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ status: "exit", code, output })
    })
  })
}

function runCommand(command: string, args: Array<string>, cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { output += chunk })
    child.on("exit", (code) => resolve({ code, output }))
  })
}

async function runVitestBatch(entries: Array<{ example: Example; file: string; body: string }>, failures: Array<string>, results: Array<ExecutionResult>) {
  if (entries.length === 0) return
  const directory = path.join(generatedRoot, "projects", "vitest")
  await mkdir(directory, { recursive: true })
  const root = path.join(generatedRoot, "examples", "compile")
  const report = path.join(directory, "report.json")
  await writeFile(path.join(directory, "vitest.config.ts"), `import { defineConfig } from "vitest/config"\nexport default defineConfig({ test: { root: ${JSON.stringify(root)}, include: ${JSON.stringify(entries.map((entry) => path.basename(entry.file)))}, testTimeout: 20000, reporters: ["json"], outputFile: ${JSON.stringify(report)} } })\n`)
  const vitest = path.join(validationRoot, "node_modules", ".bin", "vitest")
  const run = await runCommand(vitest, ["run", "--config", path.join(directory, "vitest.config.ts")], validationRoot)
  let parsed
  try {
    parsed = JSON.parse(await readFile(report, "utf8"))
  } catch {
    failures.push(`vitest batch produced no report (exit ${run.code})\n${run.output.slice(-2000)}`)
    return
  }
  const byFile = new Map(parsed.testResults.map((result: { name: string }) => [path.basename(result.name), result]))
  for (const entry of entries) {
    const result = byFile.get(path.basename(entry.file)) as { status: string; message?: string; assertionResults: Array<{ status: string; title: string; failureMessages?: Array<string> }> } | undefined
    if (!result) {
      failures.push(`${entry.example.id} (${entry.example.source}): vitest did not run the file`)
      continue
    }
    const failed = result.assertionResults.filter((assertion) => assertion.status !== "passed" && assertion.status !== "skipped" && assertion.status !== "todo")
    const messages = [result.message ?? "", ...failed.flatMap((assertion) => assertion.failureMessages ?? [])].join("\n")
    if (result.status === "passed" && failed.length === 0) {
      results.push({ id: entry.example.id, status: "vitest", detail: `${result.assertionResults.length} tests passed` })
    } else if (isPlaceholderFailure(messages, declaredNames(entry.body))) {
      results.push({ id: entry.example.id, status: "placeholder", detail: messages.match(/ReferenceError: [^\n]+/)?.[0] })
    } else {
      failures.push(`${entry.example.id} (${entry.example.source}): vitest failed\n${messages.slice(0, 1500)}`)
    }
  }
}

export async function executeCompileExamples(examples: ReadonlyArray<Example>): Promise<Array<ExecutionResult>> {
  const projectDirectory = path.join(generatedRoot, "projects", "execute")
  await mkdir(projectDirectory, { recursive: true })
  const guard = path.join(projectDirectory, "network-guard.mjs")
  await writeFile(guard, guardSource)
  const entries = await Promise.all(examples
    .filter((example) => example.disposition === "compile")
    .map(async (example) => {
      const file = path.join(generatedRoot, "examples", "compile", `${example.id}.${example.language}`)
      return { example, file, body: await readFile(file, "utf8") }
    }))
  const results: Array<ExecutionResult> = []
  const failures: Array<string> = []

  const vitestEntries = entries.filter((entry) => entry.example.language === "ts" && classify(entry.body) === "vitest")
  const nodeEntries: typeof entries = []
  for (const entry of entries) {
    if (vitestEntries.includes(entry)) continue
    if (entry.example.language !== "ts" || classify(entry.body) === "browser") {
      results.push({ id: entry.example.id, status: "browser", detail: entry.example.language === "tsx" ? "TSX renders in a browser" : "needs a browser host" })
      continue
    }
    if (classify(entry.body) === "host") {
      results.push({ id: entry.example.id, status: "other-host", detail: "needs the Deno or Bun runtime" })
      continue
    }
    nodeEntries.push(entry)
  }

  let next = 0
  const workers = Array.from({ length: Math.max(2, Math.min(8, os.availableParallelism())) }, async () => {
    while (next < nodeEntries.length) {
      const entry = nodeEntries[next++]
      const run = await runNode(entry.file, guard)
      if (run.status === "timeout") {
        if (LONG_RUNNING.test(entry.body)) results.push({ id: entry.example.id, status: "long-running", detail: `still running after ${RUN_TIMEOUT_MS / 1000}s` })
        else failures.push(`${entry.example.id} (${entry.example.source}): did not finish within ${RUN_TIMEOUT_MS / 1000}s and is not a long-running program\n${run.output.slice(-1500)}`)
        continue
      }
      // runMain ends a server with 130 when its input (stdin) closes, as it does here.
      if (run.code === 130 && LONG_RUNNING.test(entry.body)) {
        results.push({ id: entry.example.id, status: "long-running", detail: "ran until its input closed" })
        continue
      }
      if (run.code !== 0) {
        if (isPlaceholderFailure(run.output, declaredNames(entry.body))) results.push({ id: entry.example.id, status: "placeholder", detail: run.output.match(/ReferenceError: [^\n]+/)?.[0] })
        else if (run.output.includes("example-run: network disabled")) results.push({ id: entry.example.id, status: "needs-network", detail: run.output.match(/example-run: network disabled \([^)]*\)/)?.[0] })
        else failures.push(`${entry.example.id} (${entry.example.source}): exited with ${run.code}\n${run.output.slice(-1500)}`)
        continue
      }
      // console.log wraps long values across lines, so compare without whitespace.
      const squash = (value: string) => value.replace(/\s+/g, "")
      const printed = squash(run.output)
      const expected = RUNS_A_PROGRAM.test(entry.body) ? expectedOutputs(entry.body) : []
      const missing = expected.filter((value) => !printed.includes(squash(value)))
      if (missing.length > 0) {
        failures.push(`${entry.example.id} (${entry.example.source}): expected output not printed: ${missing.map((value) => JSON.stringify(value)).join(", ")}\n--- output ---\n${run.output.slice(-1500)}`)
        continue
      }
      results.push({ id: entry.example.id, status: "executed", ...(expected.length ? { assertedOutputs: expected.length } : {}) })
    }
  })
  await Promise.all([runVitestBatch(vitestEntries, failures, results), ...workers])

  if (failures.length > 0) {
    throw new Error(`${failures.length} example(s) failed when executed:\n\n${failures.join("\n\n")}`)
  }
  return results.sort((left, right) => left.id.localeCompare(right.id))
}

export function summarizeExecution(results: ReadonlyArray<ExecutionResult>): Record<string, number> {
  const summary: Record<string, number> = { executed: 0, "long-running": 0, vitest: 0, placeholder: 0, "needs-network": 0, browser: 0, "other-host": 0, assertedOutputs: 0 }
  for (const result of results) {
    summary[result.status] += 1
    summary.assertedOutputs += result.assertedOutputs ?? 0
  }
  return summary
}
