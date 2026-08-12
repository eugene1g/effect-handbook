#!/usr/bin/env node

import { spawn } from "node:child_process"
import { chmod, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { checkPackageCoherence } from "./check-package-coherence.ts"
import { extractExamples } from "./extract-examples.ts"
import { materializeContextualProjects } from "./fixture-projects.ts"
import { generatedRoot, repositoryRoot, validationRoot } from "./example-model.ts"

const binary = (name) => path.join(validationRoot, "node_modules", ".bin", name)
const VALIDATION_COMMAND = "pnpm docs:examples"

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const timer = options.timeout === undefined ? undefined : setTimeout(() => child.kill("SIGKILL"), options.timeout)
  child.on("error", reject)
  child.on("close", (code, signal) => {
    if (timer !== undefined) clearTimeout(timer)
    const result = { code, signal, stdout, stderr, output: `${stdout}${stderr}` }
    if (code === 0 || options.allowSignal && signal !== null) resolve(result)
    else reject(Object.assign(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})\n${result.output}`), result))
  })
})

const ensureTsgoExecutable = async (version) => {
  const packageRoots = [
    path.join(repositoryRoot, "node_modules", ".pnpm"),
    path.join(validationRoot, "node_modules", ".pnpm")
  ]
  const candidates = [
    `@effect+tsgo-linux-arm64@${version}/node_modules/@effect/tsgo-linux-arm64/lib/tsc`,
    `@effect+tsgo-linux-x64@${version}/node_modules/@effect/tsgo-linux-x64/lib/tsc`,
    `@effect+tsgo-darwin-arm64@${version}/node_modules/@effect/tsgo-darwin-arm64/lib/tsc`,
    `@effect+tsgo-darwin-x64@${version}/node_modules/@effect/tsgo-darwin-x64/lib/tsc`
  ]
  for (const packageRoot of packageRoots) {
    for (const candidate of candidates) {
      try { await chmod(path.join(packageRoot, candidate), 0o755) } catch (error) { if (error?.code !== "ENOENT") throw error }
    }
  }
}

const writeProject = async (name, files) => {
  const root = path.join(generatedRoot, "projects", name)
  await mkdir(root, { recursive: true })
  const config = {
    extends: path.relative(root, path.join(validationRoot, "tsconfig.base.json")),
    include: files.map((file) => path.relative(root, file))
  }
  const configPath = path.join(root, "tsconfig.json")
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return configPath
}

const diagnostics = async (project) => {
  await run(binary("tsc"), ["--noEmit", "--project", project], { cwd: validationRoot, timeout: 120_000 })
  const result = await run(binary("effect-tsgo"), ["diagnostics", "--project", project, "--strict", "--format", "text"], { cwd: validationRoot, timeout: 120_000 })
  const problems = result.output.split(/\r?\n/).filter((line) => /\b(?:error|warning)\b/i.test(line))
  if (problems.length > 0) throw new Error(`Strict Effect diagnostics emitted errors or warnings for ${project}:\n${problems.join("\n")}`)
  return { typescript: "passed", effect: "passed", output: result.output.trim() }
}

export function assertExpectedDiagnostic(output, expected) {
  const matches = [...output.matchAll(/\berror\s+(TS\d+):\s*([^\r\n]+)/g)].map((match) => ({ code: match[1], message: match[2] }))
  if (matches.length !== 1) throw new Error(`Expected exactly one TypeScript diagnostic, received ${matches.length}:\n${output}`)
  if (matches[0].code !== expected.code) throw new Error(`Expected ${expected.code}, received ${matches[0].code}: ${matches[0].message}`)
  if (!matches[0].message.includes(expected.message)) throw new Error(`Expected diagnostic message containing ${JSON.stringify(expected.message)}, received ${JSON.stringify(matches[0].message)}`)
  return matches[0]
}

const assertDoctestDefinition = (example, definition) => {
  if (!definition) throw new Error(`${example.id}: missing runtime definition ${example.runtime}`)
  if (definition.mode !== "doctest") {
    throw new Error(`${example.id}: doctest runtime ${example.runtime} must use mode=doctest, received ${definition.mode}`)
  }
  if (!Array.isArray(definition.expect) || definition.expect.length === 0 || definition.expect.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`${example.id}: doctest runtime ${example.runtime} must declare non-empty expected evidence`)
  }
  return definition
}

export function assertDoctestEvidence(report, examples, runtimes) {
  if (!report || typeof report !== "object" || !Array.isArray(report.testResults)) {
    throw new Error("Canonical Markdown doctest did not produce a valid Vitest JSON report")
  }
  const actual = report.testResults.flatMap((testFile) => (testFile.assertionResults ?? []).map((assertion) => ({
    source: path.resolve(testFile.name),
    status: assertion.status,
    title: assertion.title,
    fullName: assertion.fullName
  })))
  const actualKeys = actual.map((test) => `${test.source}\0${test.title}`)
  if (new Set(actualKeys).size !== actualKeys.length) throw new Error("Canonical Markdown doctest report contains duplicate source/test identities")
  const expectedKeys = examples.map((example) => `${path.resolve(repositoryRoot, example.source)}\0${example.name ?? `line ${example.openingLine}`}`)
  if (new Set(expectedKeys).size !== expectedKeys.length) throw new Error("Canonical Markdown doctest examples contain duplicate source/test identities")
  if (actual.length !== examples.length || report.numTotalTests !== examples.length) {
    throw new Error(`Canonical Markdown doctest coverage mismatch: expected ${examples.length} tests, Vitest reported ${report.numTotalTests ?? actual.length}`)
  }

  const unmatched = [...actual]
  const evidence = []
  for (const example of examples) {
    const definition = assertDoctestDefinition(example, runtimes[example.runtime])
    const expectedSource = path.resolve(repositoryRoot, example.source)
    const expectedTitle = example.name ?? `line ${example.openingLine}`
    const index = unmatched.findIndex((test) => test.source === expectedSource && test.title === expectedTitle)
    if (index === -1) {
      throw new Error(`${example.id}: canonical Markdown doctest did not execute ${example.source} > ${expectedTitle}`)
    }
    const [test] = unmatched.splice(index, 1)
    if (test.status !== "passed") throw new Error(`${example.id}: canonical Markdown doctest status was ${test.status}`)
    const observed = `${test.source}\n${test.title}\n${test.fullName}`
    const missing = definition.expect.filter((expected) => !observed.includes(expected))
    if (missing.length > 0) {
      throw new Error(`${example.id}: canonical Markdown doctest missed expected evidence ${JSON.stringify(missing)}\n${observed}`)
    }
    evidence.push({
      id: example.id,
      source: example.source,
      line: example.openingLine,
      name: expectedTitle,
      runtime: example.runtime,
      status: "passed",
      expected: definition.expect
    })
  }
  if (unmatched.length > 0) throw new Error(`Canonical Markdown doctest executed ${unmatched.length} unclassified tests`)
  return evidence
}

const validateInvalid = async (examples) => {
  const results = []
  for (const example of examples.filter((item) => item.disposition === "invalid")) {
    const file = path.join(generatedRoot, "examples", "invalid", `${example.id}.${example.language}`)
    const project = await writeProject(`invalid/${example.id}`, [file])
    const result = await run(binary("tsc"), ["--noEmit", "--pretty", "false", "--project", project], { cwd: validationRoot, timeout: 30_000 }).catch((error) => error)
    if (result.code === 0) throw new Error(`${example.id}: expected TypeScript failure but compilation succeeded`)
    results.push({ id: example.id, ...assertExpectedDiagnostic(result.output, example.diagnostic), status: "passed" })
  }
  return results
}

const signalRun = (file, assertion) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file], { cwd: repositoryRoot, env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "" }, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  let sent = false
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Runtime example timed out: ${file}\n${output}`)) }, 15_000)
  const consume = (chunk) => {
    output += chunk
    if (!sent && output.includes(assertion.expect[0])) {
      sent = true
      setTimeout(() => child.kill("SIGTERM"), 100)
    }
  }
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
  child.stdout.on("data", consume); child.stderr.on("data", consume)
  child.on("error", reject)
  child.on("close", (code, signal) => {
    clearTimeout(timer)
    const missing = assertion.expect.filter((expected) => !output.includes(expected))
    if (!sent || missing.length > 0) reject(new Error(`Signal runtime assertion failed for ${file}; missing ${missing.join(", ")}\n${output}`))
    else if (assertion.exitCode !== undefined && code !== assertion.exitCode) reject(new Error(`Signal runtime assertion failed for ${file}; expected exit code ${assertion.exitCode}, received ${signal ?? code}\n${output}`))
    else resolve({ output, code, signal })
  })
})

async function main() {
  const lockPath = path.join(repositoryRoot, ".validation", "example-validation.lock")
  await mkdir(path.dirname(lockPath), { recursive: true })
  let lock
  try {
    lock = await open(lockPath, "wx")
    await lock.writeFile(`${process.pid}\n`)
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Another documentation example validation is already running (${path.relative(repositoryRoot, lockPath)})`)
    throw error
  }
  try {
  const coherence = await checkPackageCoherence()
  console.log(`Package coherence passed for Effect ${coherence.target.effect.version} on Node ${coherence.node}.`)
  await ensureTsgoExecutable(coherence.target.tools.effectTsgo)
  const testDirectory = path.join(repositoryRoot, "scripts", "validation")
  const testFiles = (await readdir(testDirectory)).filter((name) => name.endsWith(".test.ts")).map((name) => path.join(testDirectory, name))
  await run(process.execPath, ["--test", ...testFiles], { cwd: repositoryRoot, timeout: 120_000 })
  const { manifest, examples } = await extractExamples()
  console.log(`Extracted ${manifest.fences} fences: ${Object.entries(manifest.counts).map(([key, value]) => `${value} ${key}`).join(", ")}.`)

  const compileFiles = examples.filter((example) => example.disposition === "compile").map((example) => path.join(generatedRoot, "examples", "compile", `${example.id}.${example.language}`))
  const runFiles = examples.filter((example) => example.disposition === "run").map((example) => path.join(generatedRoot, "examples", "run", `${example.id}.${example.language}`))
  const probeDirectory = path.join(validationRoot, "probes")
  const probeFiles = (await readdir(probeDirectory))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => path.join(probeDirectory, name))
  if (probeFiles.length === 0) throw new Error("No tracked semantic probes found in validation/probes")
  const compileProject = await writeProject("compile", compileFiles)
  const runProject = await writeProject("run", runFiles)
  const probeProject = await writeProject("probes", probeFiles)
  await diagnostics(compileProject)
  console.log(`Strict TypeScript and Effect diagnostics passed for ${compileFiles.length} isolated compile examples.`)
  await diagnostics(runProject)
  console.log(`Strict TypeScript and Effect diagnostics passed for ${runFiles.length} runtime examples.`)

  const contextualProjects = await materializeContextualProjects(examples)
  for (const project of contextualProjects) await diagnostics(project.config)
  console.log(`Strict TypeScript and Effect diagnostics passed for ${examples.filter((example) => example.disposition === "contextual").length} contextual examples in ${contextualProjects.length} named fixture projects.`)

  const invalidResults = await validateInvalid(examples)

  const registry = JSON.parse(await readFile(path.join(validationRoot, "examples.json"), "utf8"))
  const runtimeResults = []
  for (const example of examples.filter((item) => item.disposition === "run" && !item.doctest)) {
    const assertion = registry.runtimes[example.runtime]
    if (!assertion) throw new Error(`${example.id}: missing runtime definition ${example.runtime}`)
    if (assertion.mode === "doctest") throw new Error(`${example.id}: non-doctest run fence cannot use doctest runtime ${example.runtime}`)
    const file = path.join(generatedRoot, "examples", "run", `${example.id}.${example.language}`)
    const result = assertion.mode === "signal"
      ? await signalRun(file, assertion)
      : await run(process.execPath, [file], { timeout: example.id === "schema-httpapi-sql" ? 30_000 : 15_000, env: { OTEL_EXPORTER_OTLP_ENDPOINT: "" } })
    const missing = assertion.expect.filter((expected) => !result.output.includes(expected))
    if (missing.length > 0) throw new Error(`${example.id}: missing runtime output ${JSON.stringify(missing)}\n${result.output}`)
    runtimeResults.push({ id: example.id, mode: assertion.mode, status: "passed", ...(result.code === undefined ? {} : { exitCode: result.code }), ...(result.signal === undefined ? {} : { signal: result.signal }) })
  }
  console.log(`Runtime assertions passed for ${runtimeResults.length} freshly extracted recipe programs.`)

  const doctestExamples = examples.filter((item) => item.disposition === "run" && item.doctest)
  const doctestRuntimeNames = new Set(doctestExamples.map((example) => example.runtime))
  for (const example of doctestExamples) assertDoctestDefinition(example, registry.runtimes[example.runtime])
  for (const [name, definition] of Object.entries(registry.runtimes)) {
    if (definition.mode === "doctest" && !doctestRuntimeNames.has(name)) {
      throw new Error(`Doctest runtime definition ${name} is not associated with an import.meta.vitest run fence`)
    }
  }
  const doctestReportPath = path.join(generatedRoot, "doctest-results.json")
  let doctestResults = []
  if (doctestExamples.length > 0) {
    await run(binary("vitest"), [
      "run",
      "--config", path.join(validationRoot, "doctest", "vitest.config.ts"),
      "--reporter=json",
      `--outputFile=${doctestReportPath}`
    ], { cwd: validationRoot, timeout: 30_000 })
    const doctestReport = JSON.parse(await readFile(doctestReportPath, "utf8"))
    doctestResults = assertDoctestEvidence(doctestReport, doctestExamples, registry.runtimes)
  }
  console.log(`@effect/doctest executed ${doctestResults.length} canonical Markdown ${doctestResults.length === 1 ? "test" : "tests"}.`)

  await diagnostics(probeProject)
  const probes = []
  for (const file of probeFiles) {
    const result = await run(process.execPath, [file], { cwd: validationRoot, timeout: 30_000 })
    probes.push({ name: path.basename(file, ".ts"), status: "passed", output: result.output.trim() })
  }
  console.log(`Executed ${probeFiles.length} tracked semantic probe programs.`)

  const runtimeEvidenceIds = new Set([...runtimeResults, ...doctestResults].map((result) => result.id))
  for (const entry of manifest.entries) {
    if (["compile", "contextual", "run"].includes(entry.disposition)) {
      entry.evidence.typescript = "passed"
      entry.evidence.effect = "passed"
    }
    if (entry.disposition === "run" && runtimeEvidenceIds.has(entry.id)) entry.evidence.runtime = "passed"
    if (entry.disposition === "invalid") entry.evidence.typescript = "expected-failure-passed"
  }
  const pending = manifest.entries.flatMap((entry) => Object.entries(entry.evidence).filter(([, status]) => status === "pending").map(([lane]) => `${entry.id}:${lane}`))
  if (pending.length > 0) throw new Error(`Incomplete example evidence: ${pending.join(", ")}`)
  const results = {
    schemaVersion: 2,
    target: manifest.target,
    tools: {
      declared: manifest.tools,
      actual: {
        node: coherence.node,
        pnpm: coherence.pnpm,
        ...coherence.installedTools
      }
    },
    command: VALIDATION_COMMAND,
    canonicalSourceHash: manifest.canonicalSourceHash,
    extractorHash: manifest.extractorHash,
    harnessHash: manifest.harnessHash,
    totals: manifest.counts,
    validated: {
      typescript: manifest.counts.compile + manifest.counts.contextual + manifest.counts.run,
      effect: manifest.counts.compile + manifest.counts.contextual + manifest.counts.run,
      runtime: runtimeEvidenceIds.size,
      doctest: doctestResults.length,
      semanticProbePrograms: probes.length,
      pseudocode: manifest.counts.pseudocode,
      expectedInvalid: manifest.counts.invalid
    },
    contextualFixtures: contextualProjects.map((project) => project.name),
    runtime: runtimeResults,
    doctest: {
      status: "passed",
      tests: doctestResults.length,
      sources: [...new Set(doctestResults.map((result) => result.source))],
      examples: doctestResults
    },
    probes,
    invalid: invalidResults
  }
  await writeFile(path.join(generatedRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(path.join(generatedRoot, "results.json"), `${JSON.stringify(results, null, 2)}\n`)
  console.log(`Validation passed; evidence written to ${path.relative(repositoryRoot, path.join(generatedRoot, "results.json"))}.`)
  } finally {
    await lock.close()
    await rm(lockPath, { force: true })
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
