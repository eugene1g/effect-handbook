#!/usr/bin/env node

// Compile the `compile`-disposition TypeScript fences of selected canonical pages in an isolated scratch project,
// with the same strict TypeScript and strict Effect diagnostics as `pnpm docs:examples`.
//
//   node <skill-dir>/scripts/check-page-examples.ts <lane-name> docs/<page>.md [docs/<page>.md ...]
//
// `pnpm docs:examples` writes to the shared `.validation/generated/` tree, so parallel writers cannot run it.
// Each lane here owns `.validation/scratch/<lane-name>/`, which makes concurrent runs safe. Registered
// `contextual` / `run` / `pseudocode` / `invalid` fences are listed as skipped: only the full harness can prove
// them. A not-yet-registered `check=run` recipe is a complete file, so it is type-checked here.

import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")

export function pageDisposition(example, registryExamples) {
  const registered = registryExamples.find((entry) =>
    entry.id === example.metadata?.id || (entry.source === example.source && entry.sha256 === example.sha256))
  const declared = example.metadata?.check
  const disposition = registered?.disposition ?? (declared === "run" ? "compile" : declared) ?? "compile"
  return { disposition, registeredId: registered?.id }
}

export function relabelDiagnostics(output, index) {
  return output.replace(/(?:\.\.\/)*\.validation\/scratch\/[^/\s]+\/examples\/([^\s(:]+)/g, (_, name) => `${index[name] ?? name} [${name}]`)
}

async function main() {
  const [lane, ...pages] = process.argv.slice(2)
  if (!lane || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(lane) || pages.length === 0) {
    console.error("usage: check-page-examples.ts <lane-name> docs/<page>.md [docs/<page>.md ...]")
    process.exit(2)
  }
  const model = await import(path.join(repositoryRoot, "scripts/validation/example-model.ts"))
  const { effectDiagnosticProblems } = await import(path.join(repositoryRoot, "scripts/validation/check-examples.ts"))
  const registry = JSON.parse(readFileSync(path.join(repositoryRoot, "validation/examples.json"), "utf8")).examples
  const { examples } = await model.readCanonicalExamples()
  const unknownPages = pages.filter((page) => !examples.some((example) => example.source === page) && !readablePage(page))
  if (unknownPages.length > 0) {
    console.error(`Not canonical pages (use repository-relative docs paths registered in handbook.ts): ${unknownPages.join(", ")}`)
    process.exit(2)
  }

  const directory = path.join(repositoryRoot, ".validation", "scratch", lane)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(path.join(directory, "examples"), { recursive: true })
  const index = {}
  const skipped = []
  let compiled = 0
  for (const example of examples) {
    if (!pages.includes(example.source)) continue
    const { disposition, registeredId } = pageDisposition(example, registry)
    if (disposition !== "compile") {
      skipped.push(`${example.source}:${example.openingLine} (${disposition}${registeredId ? ` ${registeredId}` : ""})`)
      continue
    }
    const name = `${path.basename(example.source, ".md")}.L${example.openingLine}.${example.language === "tsx" ? "tsx" : "ts"}`
    writeFileSync(path.join(directory, "examples", name), example.body.endsWith("\n") ? example.body : `${example.body}\n`)
    index[name] = `${example.source}:${example.openingLine}`
    compiled++
  }
  console.log(`lane=${lane} pages=${pages.join(",")} compiled=${compiled} skipped=${skipped.length}`)
  if (skipped.length > 0) console.log(`skipped (validated only by the full harness):\n  ${skipped.join("\n  ")}`)
  if (compiled === 0) {
    console.log("OK: no compile-disposition fences on these pages")
    return
  }

  const validationRoot = path.join(repositoryRoot, "validation")
  const project = path.join(directory, "tsconfig.json")
  writeFileSync(project, `${JSON.stringify({
    extends: path.relative(directory, path.join(validationRoot, "tsconfig.base.json")),
    include: ["examples/*"]
  }, null, 2)}\n`)
  // Resolve `effect` and `@effect/*` exactly as the tracked validation package does.
  symlinkSync(path.join(validationRoot, "node_modules"), path.join(directory, "node_modules"), "dir")
  const binary = (name) => path.join(validationRoot, "node_modules", ".bin", name)
  const typescript = spawnSync(binary("tsc"), ["--noEmit", "--pretty", "false", "--project", project], { cwd: validationRoot, encoding: "utf8" })
  const effect = spawnSync(binary("effect-tsgo"), ["diagnostics", "--project", project, "--strict", "--format", "text"], { cwd: validationRoot, encoding: "utf8" })
  const problems = effectDiagnosticProblems(`${effect.stdout ?? ""}${effect.stderr ?? ""}`)
  if (typescript.status !== 0) console.log(`TYPESCRIPT FAILED:\n${relabelDiagnostics(`${typescript.stdout ?? ""}${typescript.stderr ?? ""}`.trim(), index)}`)
  if (problems.length > 0) console.log(`EFFECT DIAGNOSTICS FAILED:\n${relabelDiagnostics(problems.join("\n"), index)}`)
  if (typescript.status !== 0 || problems.length > 0) process.exit(1)
  console.log("OK: strict TypeScript and strict Effect diagnostics passed")
}

function readablePage(page) {
  try {
    readFileSync(path.join(repositoryRoot, page), "utf8")
    return true
  } catch {
    return false
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main()
