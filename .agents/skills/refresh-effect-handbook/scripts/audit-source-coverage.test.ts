import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const exec = promisify(execFile)
const script = fileURLToPath(new URL("./audit-source-coverage.ts", import.meta.url))

test("gates manifest-scoped modules, collisions, package front doors, and new exports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "effect-handbook-coverage-"))
  const docs = path.join(root, "docs")
  const effect = path.join(root, "effect")
  const effectSource = path.join(effect, "packages/effect/src")
  await mkdir(path.join(effectSource, "unstable/alpha"), { recursive: true })
  await mkdir(path.join(effect, "packages/satellite/src"), { recursive: true })
  await mkdir(docs, { recursive: true })

  await write(path.join(effect, "packages/effect/package.json"), JSON.stringify({
    name: "effect",
    version: "4.1.0-beta.1",
    exports: {
      ".": "./src/index.ts",
      "./unstable/alpha": "./src/unstable/alpha/index.ts"
    }
  }))
  await write(path.join(effectSource, "index.ts"), [
    'export * as Shared from "./Shared.ts"',
    'export * as StableOnly from "./StableOnly.ts"'
  ].join("\n"))
  await write(path.join(effectSource, "Shared.ts"), "export const stable = true\n")
  await write(path.join(effectSource, "StableOnly.ts"), "export const stable = true\n")
  await write(path.join(effectSource, "unstable/alpha/index.ts"), [
    'export * as Shared from "./Shared.ts"',
    'export * as UnstableOnly from "./UnstableOnly.ts"'
  ].join("\n"))
  await write(path.join(effectSource, "unstable/alpha/Shared.ts"), "export const unstable = true\n")
  await write(path.join(effectSource, "unstable/alpha/UnstableOnly.ts"), "export const unstable = true\n")
  await write(path.join(effect, "packages/satellite/package.json"), JSON.stringify({
    name: "@effect/satellite",
    version: "4.1.0-beta.1"
  }))

  await write(path.join(docs, "index.md"), [
    "# Fixture",
    "",
    "## Shared",
    "",
    "`effect/Shared` — stable",
    "",
    "## StableOnly",
    "",
    "`effect/StableOnly` — stable",
    "",
    "## Shared",
    "",
    "`effect/unstable/alpha` — unstable",
    "",
    "## UnstableOnly",
    "",
    "`effect/unstable/alpha/UnstableOnly` — unstable",
    "",
    "## Packages",
    "",
    "- `effect` — core",
    "- `@effect/satellite` — adapter"
  ].join("\n"))
  await write(path.join(root, "handbook.ts"), [
    'const page = { source: "index.md" }',
    "export const handbookPages = [page]",
    "export const sitePages = [page]"
  ].join("\n"))

  const output = path.join(root, "evidence/nested/coverage.json")
  const pass = await run(root, docs, effect, output)
  assert.equal(pass.exitCode, 0, pass.stderr)
  const report = JSON.parse(await readFile(output, "utf8"))
  assert.equal(report.stableModules, 2)
  assert.equal(report.unstableModules, 2)
  assert.equal(report.publicPackages, 2)
  assert.deepEqual(report.conciseCollisionEvidenceGaps, [])
  assert.deepEqual(report.missingConcisePackages, [])

  const sourceHash = report.conciseSourceSha256
  await write(path.join(docs, "index.md"), `${await readFile(path.join(docs, "index.md"), "utf8")}\n\`\`\`ts\nconst codeOnlyChange = true\n\`\`\``)
  const codeOnly = await run(root, docs, effect, output)
  assert.equal(codeOnly.exitCode, 0, codeOnly.stderr)
  const codeOnlyReport = JSON.parse(await readFile(output, "utf8"))
  assert.notEqual(codeOnlyReport.conciseSourceSha256, sourceHash)
  assert.deepEqual(codeOnlyReport.missingConciseModules, [])

  await write(path.join(effectSource, "index.ts"), [
    await readFile(path.join(effectSource, "index.ts"), "utf8"),
    'export * as NewlyPublished from "./NewlyPublished.ts"'
  ].join("\n"))
  await write(path.join(effectSource, "NewlyPublished.ts"), "export const value = true\n")
  const failure = await run(root, docs, effect, output)
  assert.equal(failure.exitCode, 1)
  assert.match(failure.stdout, /NewlyPublished/)
})

async function write(file, contents) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${contents}\n`)
}

async function run(root, docs, effect, output) {
  try {
    const result = await exec(process.execPath, [
      script,
      "--docs", docs,
      "--manifest", path.join(root, "handbook.ts"),
      "--effect", effect,
      "--json", output
    ])
    return { exitCode: 0, ...result }
  } catch (error) {
    return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}
