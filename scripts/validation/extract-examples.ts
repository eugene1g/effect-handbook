#!/usr/bin/env node

import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { handbookRelease } from "../../handbook.ts"
import {
  classifyDocExamples,
  dispositionCounts,
  generatedFilename,
  generatedRoot,
  repositoryRoot,
  sha256,
  validationRoot
} from "./example-model.ts"

const temporaryRoot = `${generatedRoot}.tmp-${process.pid}`

const collectHarnessFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "node_modules" || entry.name === "generated") continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectHarnessFiles(absolute))
    else if (entry.isFile()) files.push(absolute)
  }
  return files
}

export async function extractExamples() {
  const { examples, pageSources, canonicalSourceHash } = await classifyDocExamples()
  const targetDefinition = JSON.parse(await readFile(path.join(validationRoot, "target.json"), "utf8"))
  await rm(temporaryRoot, { recursive: true, force: true })
  await mkdir(path.join(temporaryRoot, "examples"), { recursive: true })

  const entries = []
  for (const example of examples) {
    const relative = path.posix.join("examples", example.disposition, generatedFilename(example))
    const output = path.join(temporaryRoot, relative)
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, example.body)
    const extracted = await readFile(output, "utf8")
    if (extracted !== example.body || sha256(extracted) !== example.sha256) {
      throw new Error(`${example.id}: generated file differs from canonical Markdown body`)
    }
    entries.push({
      id: example.id,
      source: example.source,
      heading: example.heading,
      language: example.language,
      info: example.info,
      startLine: example.startLine,
      endLine: example.endLine,
      sha256: example.sha256,
      disposition: example.disposition,
      fixture: example.fixture ?? null,
      runtime: example.runtime ?? null,
      diagnostic: example.diagnostic ?? null,
      platform: example.platform,
      packages: example.packages,
      classificationSource: example.classificationSource,
      output: relative,
      evidence: {
        typescript: ["pseudocode"].includes(example.disposition) ? "not-applicable" : "pending",
        effect: ["pseudocode", "invalid"].includes(example.disposition) ? "not-applicable" : "pending",
        runtime: example.disposition === "run" ? "pending" : "not-applicable"
      }
    })
  }

  const extractorFiles = ["example-model.ts", "extract-examples.ts"]
  const extractorHash = sha256((await Promise.all(extractorFiles.map((name) => readFile(path.join(repositoryRoot, "scripts", "validation", name), "utf8")))).join("\0"))
  const harnessFiles = [
    ...await collectHarnessFiles(path.join(repositoryRoot, "scripts", "validation")),
    ...await collectHarnessFiles(validationRoot),
    path.join(repositoryRoot, "package.json"),
    path.join(repositoryRoot, "pnpm-lock.yaml"),
    path.join(repositoryRoot, "pnpm-workspace.yaml")
  ]
  const harnessInventory = []
  for (const file of harnessFiles.sort()) {
    const contents = await readFile(file)
    harnessInventory.push({ path: path.relative(repositoryRoot, file).split(path.sep).join("/"), sha256: sha256(contents) })
  }
  const harnessHash = sha256(harnessInventory.map((entry) => `${entry.path}\0${entry.sha256}`).join("\0"))
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    target: {
      effectVersion: handbookRelease.version,
      effectTag: handbookRelease.tag,
      effectCommit: handbookRelease.commit,
      publishedAt: handbookRelease.publishedAt,
      auditedAt: handbookRelease.auditedAt
    },
    tools: targetDefinition.tools,
    commands: {
      extract: "pnpm --filter effect-4-handbook-example-validation extract",
      validate: "pnpm docs:examples"
    },
    canonicalSourceHash,
    extractorHash,
    harnessHash,
    harnessInventory,
    pages: pageSources.length,
    fences: entries.length,
    counts: dispositionCounts(examples),
    entries
  }
  await writeFile(path.join(temporaryRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  await rm(generatedRoot, { recursive: true, force: true })
  await mkdir(path.dirname(generatedRoot), { recursive: true })
  await rename(temporaryRoot, generatedRoot)

  const dependencyLink = path.join(path.dirname(generatedRoot), "node_modules")
  await rm(dependencyLink, { recursive: true, force: true })
  await symlink(path.join(validationRoot, "node_modules"), dependencyLink, "dir")
  return { manifest, examples }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const { manifest } = await extractExamples()
  console.log(`Extracted ${manifest.fences} TypeScript fences from ${manifest.pages} canonical pages (${Object.entries(manifest.counts).map(([key, value]) => `${value} ${key}`).join(", ")}).`)
}
