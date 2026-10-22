import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, writeFile, symlink } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { effectDiagnosticProblems, ensureTsgoExecutable } from "./validation/check-examples.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const hash = (value) => createHash("sha256").update(value).digest("hex")
const json = async (file) => JSON.parse(await readFile(file, "utf8"))
const contracts = await json(path.join(root, "evals/task-contracts.json"))
const ignored = (dir) => {
  const resolved = path.resolve(dir)
  if (![".validation", ".reference"].some((base) => resolved.startsWith(path.join(root, base) + path.sep))) throw new Error("Run directories must be below .validation/ or .reference/")
  return resolved
}
async function command(binary, args, timeout) {
  return await new Promise((resolve) => {
    const child = spawn(binary, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    let output = "", timedOut = false
    const consume = (chunk) => { output = (output + chunk).slice(-200000) }
    child.stdout.on("data", consume); child.stderr.on("data", consume)
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeout)
    child.on("error", (error) => { output += String(error) })
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ status: code === 0 && !timedOut ? "passed" : "failed", code, signal, timedOut, output }) })
  })
}

export async function prepare(directory, snapshot = path.join(root, "dist")) {
  const dir = ignored(directory)
  await mkdir(dir, { recursive: true })
  // An exclusive manifest prevents accidental replacement of an existing experiment.
  const catalog = await readFile(path.join(snapshot, "effect-4-catalog.json"))
  const canonical = await readFile(path.join(snapshot, "effect-4-handbook.md"))
  const target = JSON.parse(catalog.toString()).handbook
  const packages = await json(path.join(root, "validation/package.json"))
  if (target.effectVersion !== packages.dependencies.effect) throw new Error("Snapshot does not match workspace Effect")
  const manifest = { schemaVersion: 1, target, packages, contractsHash: hash(JSON.stringify(contracts)), catalogHash: hash(catalog), canonicalHash: hash(canonical), createdAt: new Date().toISOString() }
  await writeFile(path.join(dir, "snapshot.json"), JSON.stringify(manifest, null, 2), { flag: "wx" })
  await cp(snapshot, path.join(dir, "handbook"), { recursive: true, filter: (source) => !source.includes(`${path.sep}assets`) })
  await writeFile(path.join(dir, "fetch.mjs"), `import {readFile,appendFile} from 'node:fs/promises';
import path from 'node:path'; import {fileURLToPath} from 'node:url'; import {createHash} from 'node:crypto';
const base=path.dirname(fileURLToPath(import.meta.url));
const requested=process.argv[2]; const name=requested?.split('#')[0];
if(!name || !(name==='llms.txt'||name.endsWith('.md')) || name.split('/').includes('..') || path.isAbsolute(name)) throw Error('Only snapshot-relative Markdown or llms.txt');
const data=await readFile(path.join(base,'handbook',name));
await appendFile(path.join(base,'fetch.jsonl'),JSON.stringify({at:new Date().toISOString(),requested,sha256:createHash('sha256').update(data).digest('hex')})+'\\n');
process.stdout.write(data);
`)
  for (const task of contracts.tasks) {
    await mkdir(path.join(dir, task.id))
    await writeFile(path.join(dir, task.id, "TASK.md"), `# ${task.id}\n\n${task.instructions}\n\nRead handbook Markdown with: node ../fetch.mjs llms.txt (from this task directory). Submit main.ts and report.json here. report.json must contain generator (your actual supplied identity, not a guessed model), citations (snapshot-relative Markdown paths with anchors), and notes. Use only exact workspace packages. No network, ambient services, additional local source files or package installation. Behavioral grading does not establish which internal primitives you used; Effect/Config usage is a separate human-review requirement.\n`)
  }
  return manifest
}

export async function score(directory, timeout = 15000) {
  const dir = ignored(directory)
  const snapshot = await json(path.join(dir, "snapshot.json"))
  if (snapshot.contractsHash !== hash(JSON.stringify(contracts))) throw new Error("Task contracts changed since prepare")
  for (const [file, expected] of [["effect-4-catalog.json", snapshot.catalogHash], ["effect-4-handbook.md", snapshot.canonicalHash]]) {
    if (hash(await readFile(path.join(dir, "handbook", file))) !== expected) throw new Error(`Snapshot changed: ${file}`)
  }
  const workspacePackages = await json(path.join(root, "validation/package.json"))
  if (JSON.stringify(workspacePackages) !== JSON.stringify(snapshot.packages)) throw new Error("Workspace package target changed since prepare")
  await ensureTsgoExecutable(workspacePackages.devDependencies["@effect/tsgo"])
  const graderHash = hash(Buffer.concat(await Promise.all(["scripts/evaluate-agent-tasks.ts", "evals/task-runtime.ts", "scripts/validation/check-examples.ts", "validation/tsconfig.base.json"].map((f) => readFile(path.join(root, f))))))
  const results = []
  for (const task of contracts.tasks) {
    const location = path.join(dir, task.id)
    const missing = []
    let source, report
    try { source = await readFile(path.join(location, "main.ts")) } catch { missing.push("main.ts") }
    try { report = await json(path.join(location, "report.json")) } catch { missing.push("report.json (missing or invalid)") }
    if (!report?.generator || !Array.isArray(report?.citations)) missing.push("report generator/citations")
    const result = { task: task.id, taskHash: hash(JSON.stringify(task)), solutionHash: source ? hash(source) : null, report, missing, compiler: { status: "skipped" }, effect: { status: "skipped" }, runtime: { status: "skipped" } }
    if (source) {
      await writeFile(path.join(location, "package.json"), '{"type":"module"}')
      try { await symlink(path.join(root, "validation/node_modules"), path.join(location, "node_modules"), "dir") } catch (e) { if (e.code !== "EEXIST") throw e }
      const config = path.join(location, "tsconfig.json")
      await writeFile(config, JSON.stringify({ extends: path.join(root, "validation/tsconfig.base.json"), files: ["main.ts"] }))
      result.compiler = await command(path.join(root, "validation/node_modules/.bin/tsc"), ["--noEmit", "--project", config], timeout)
      result.effect = await command(path.join(root, "validation/node_modules/.bin/effect-tsgo"), ["diagnostics", "--project", config, "--strict", "--format", "text"], timeout)
      if (effectDiagnosticProblems(result.effect.output).length) result.effect.status = "failed"
      if (result.compiler.status === "passed" && result.effect.status === "passed") result.runtime = await command(process.execPath, [path.join(root, "evals/task-runtime.ts"), task.id, path.join(location, "main.ts")], timeout)
    }
    results.push({ ...result, passed: !missing.length && [result.compiler, result.effect, result.runtime].every((r) => r.status === "passed") })
  }
  let fetchProvenance = []
  try { fetchProvenance = (await readFile(path.join(dir, "fetch.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse) } catch { /* explicitly absent below */ }
  const toolVersions = {
    typescript: await command(path.join(root, "validation/node_modules/.bin/tsc"), ["--version"], timeout),
    effectTsgo: await command(path.join(root, "validation/node_modules/.bin/effect-tsgo"), ["--version"], timeout)
  }
  const evidence = { snapshot, graderHash, toolVersions, node: process.version, scoredAt: new Date().toISOString(), timeout, fetchProvenance, missingFetchLog: fetchProvenance.length === 0, results }
  await writeFile(path.join(dir, "scores.json"), JSON.stringify(evidence, null, 2))
  return evidence
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, directory, extra] = process.argv.slice(2)
  if (!directory || !["prepare", "score"].includes(operation)) throw new Error("Usage: node scripts/evaluate-agent-tasks.ts prepare RUN [BUILT_SNAPSHOT] | score RUN [TIMEOUT_MS]")
  if (operation === "prepare") console.log(JSON.stringify(await prepare(directory, extra), null, 2))
  else {
    const timeout = extra === undefined ? 15000 : Number(extra)
    if (!Number.isFinite(timeout) || timeout < 1) throw new Error("Invalid timeout")
    const evidence = await score(directory, timeout)
    console.log(JSON.stringify(evidence, null, 2))
    if (!evidence.results.every((r) => r.passed)) process.exitCode = 1
  }
}
