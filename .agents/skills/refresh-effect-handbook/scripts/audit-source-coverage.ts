#!/usr/bin/env node

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"

const exec = promisify(execFile)

const docsRoot = path.resolve(required("--docs"))
const effectRoot = path.resolve(required("--effect"))
const jsonOutput = option("--json")
const manifestPath = option("--manifest")
const effectSource = path.join(effectRoot, "packages/effect/src")

const inventory = manifestPath
  ? await pagesFromManifest(path.resolve(manifestPath))
  : { handbookPages: await markdownFiles(docsRoot), sitePages: await markdownFiles(docsRoot) }
const conciseDocuments = await documentsFor(inventory.handbookPages)
const siteDocuments = await documentsFor(inventory.sitePages)
const conciseCorpus = strippedCorpus(conciseDocuments)
const siteCorpus = strippedCorpus(siteDocuments)
const conciseHeadings = headingCounts(conciseCorpus)
const siteHeadings = headingCounts(siteCorpus)
const conciseSections = h2Sections(conciseCorpus)
const siteSections = h2Sections(siteCorpus)

const stable = await namespaceExports(path.join(effectSource, "index.ts"), "effect")
const unstable = []
const effectPackage = JSON.parse(await readFile(path.join(effectRoot, "packages/effect/package.json"), "utf8"))
const unstableFamilies = Object.entries(effectPackage.exports ?? {})
  .filter(([specifier, target]) => /^\.\/unstable\/[^/*]+$/.test(specifier) && typeof target === "string")
  .map(([specifier, target]) => ({
    family: specifier.slice("./unstable/".length),
    index: path.join(effectRoot, "packages/effect", target)
  }))
  .sort((left, right) => left.family.localeCompare(right.family))
if (unstableFamilies.length === 0) fail("effect package exports no explicit unstable family front doors")
for (const { family, index } of unstableFamilies) {
  unstable.push(...await namespaceExports(index, `effect/unstable/${family}`))
}

const targets = [...stable, ...unstable]
const expectedByName = countBy(targets, (target) => target.name)
const missingConciseModules = []
const missingSiteModules = []
for (const [name, expected] of expectedByName) {
  const imports = targets.filter((target) => target.name === name).map((target) => target.import)
  const conciseActual = conciseHeadings.get(name) ?? 0
  const siteActual = siteHeadings.get(name) ?? 0
  if (conciseActual < expected) missingConciseModules.push({ name, expected, actual: conciseActual, imports })
  if (siteActual < expected) missingSiteModules.push({ name, expected, actual: siteActual, imports })
}
const conciseCollisionEvidenceGaps = collisionEvidenceGaps(targets, conciseSections)
const siteCollisionEvidenceGaps = collisionEvidenceGaps(targets, siteSections)

const packages = await publicPackages(path.join(effectRoot, "packages"))
const concisePackageCoverage = packages.map((name) => packageCoverage(conciseCorpus, name))
const sitePackageCoverage = packages.map((name) => packageCoverage(siteCorpus, name))
const missingConcisePackages = concisePackageCoverage.filter((item) => !item.frontDoorCovered).map((item) => item.name)
const missingSitePackages = sitePackageCoverage.filter((item) => !item.frontDoorCovered).map((item) => item.name)
const weakConcisePackages = concisePackageCoverage.filter((item) => item.proseCovered && !item.frontDoorCovered).map((item) => item.name)
const weakSitePackages = sitePackageCoverage.filter((item) => item.proseCovered && !item.frontDoorCovered).map((item) => item.name)
const sourceFiles = await implementationInventory(effectSource)
const git = await gitIdentity(effectRoot)

const result = {
  schemaVersion: 1,
  docsRoot,
  effectRoot,
  manifest: manifestPath ? path.resolve(manifestPath) : null,
  conciseSourceSha256: documentsHash(conciseDocuments),
  siteSourceSha256: documentsHash(siteDocuments),
  conciseCoverageCorpusSha256: sha256(conciseCorpus),
  siteCoverageCorpusSha256: sha256(siteCorpus),
  effectVersion: effectPackage.version ?? null,
  effectCommit: git.commit,
  effectDirty: git.dirty,
  moduleInventorySha256: sha256(JSON.stringify(targets.map((target) => ({
    import: target.import,
    source: target.source
  })))),
  packageInventorySha256: sha256(JSON.stringify(packages)),
  concisePages: inventory.handbookPages.length,
  sitePages: inventory.sitePages.length,
  conciseHeadings: [...conciseHeadings.values()].reduce((sum, count) => sum + count, 0),
  siteHeadings: [...siteHeadings.values()].reduce((sum, count) => sum + count, 0),
  stableModules: stable.length,
  unstableModules: unstable.length,
  unstableFamilies: new Set(unstable.map((target) => target.family)).size,
  publicPackages: packages.length,
  implementationFiles: sourceFiles.length,
  missingConciseModules,
  missingSiteModules,
  conciseCollisionEvidenceGaps,
  siteCollisionEvidenceGaps,
  missingConcisePackages,
  missingSitePackages,
  weakConcisePackages,
  weakSitePackages,
  concisePackageCoverage,
  sitePackageCoverage,
  modules: targets,
  packages
}

if (jsonOutput) {
  const output = path.resolve(jsonOutput)
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
}

console.log("Effect Handbook source coverage")
console.log(`Concise / site pages: ${result.concisePages} / ${result.sitePages}`)
console.log(`Stable modules: ${result.stableModules}`)
console.log(`Unstable modules: ${result.unstableModules} in ${result.unstableFamilies} families`)
console.log(`Public packages: ${result.publicPackages}`)
console.log(`Effect version / commit: ${result.effectVersion ?? "unknown"} / ${result.effectCommit ?? "unavailable"}${result.effectDirty ? " (dirty)" : ""}`)
console.log(`Implementation .ts files to inspect: ${result.implementationFiles}`)
printMissing("Missing concise module headings", missingConciseModules)
printMissing("Missing site module headings", missingSiteModules)
printCollisions("Ambiguous concise module-heading collisions", conciseCollisionEvidenceGaps)
printCollisions("Ambiguous site module-heading collisions", siteCollisionEvidenceGaps)
printNames("Missing concise package front doors", missingConcisePackages)
printNames("Missing site package front doors", missingSitePackages)
printNames("Concise packages with prose-only coverage", weakConcisePackages)
printNames("Site packages with prose-only coverage", weakSitePackages)

if (git.dirty === true || missingConciseModules.length > 0 || missingSiteModules.length > 0 || conciseCollisionEvidenceGaps.length > 0 || siteCollisionEvidenceGaps.length > 0 || missingConcisePackages.length > 0 || missingSitePackages.length > 0) {
  process.exitCode = 1
}

async function pagesFromManifest(file) {
  const module = await import(`${pathToFileURL(file).href}?coverage=${Date.now()}`)
  if (!Array.isArray(module.handbookPages) || !Array.isArray(module.sitePages)) {
    fail(`${file} must export handbookPages and sitePages arrays`)
  }
  const handbookPages = module.handbookPages.map(pageSource)
  const sitePages = module.sitePages.map(pageSource)
  if (new Set(handbookPages).size !== handbookPages.length) fail(`${file} contains duplicate handbook page sources`)
  if (new Set(sitePages).size !== sitePages.length) fail(`${file} contains duplicate site page sources`)
  return { handbookPages, sitePages }
}

function pageSource(page) {
  if (!page || typeof page.source !== "string") fail("Manifest page is missing a source")
  if (path.isAbsolute(page.source) || page.source.split(/[\\/]/).includes("..")) {
    fail(`Manifest page source escapes docs: ${page.source}`)
  }
  return page.source
}

async function documentsFor(pages) {
  return Promise.all(pages.map(async (file) => {
    const absolute = path.join(docsRoot, file)
    const relative = path.relative(docsRoot, absolute)
    if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`Page escapes docs: ${file}`)
    return { file, markdown: await readFile(absolute, "utf8") }
  }))
}

function strippedCorpus(documents) {
  return documents.map(({ file, markdown }) => stripFences(markdown, file)).join("\n")
}

function documentsHash(documents) {
  const hash = createHash("sha256")
  for (const { file, markdown } of documents) hash.update(file).update("\0").update(markdown).update("\0")
  return hash.digest("hex")
}

async function gitIdentity(directory) {
  try {
    const [{ stdout: commit }, { stdout: status }] = await Promise.all([
      exec("git", ["-C", directory, "rev-parse", "HEAD"]),
      exec("git", ["-C", directory, "status", "--porcelain"])
    ])
    return { commit: commit.trim(), dirty: status.trim().length > 0 }
  } catch {
    return { commit: null, dirty: null }
  }
}

function printMissing(label, items) {
  console.log(`${label}: ${items.length}`)
  for (const item of items) console.log(`  - ${item.name}: ${item.actual}/${item.expected} (${item.imports.join(", ")})`)
}

function printNames(label, names) {
  console.log(`${label}: ${names.length}`)
  for (const name of names) console.log(`  - ${name}`)
}

function printCollisions(label, collisions) {
  console.log(`${label}: ${collisions.length}`)
  for (const item of collisions) console.log(`  - ${item.name}: ${item.unmatchedImports.join(", ")}`)
}

async function namespaceExports(file, importRoot) {
  const source = await readFile(file, "utf8")
  const family = importRoot.startsWith("effect/unstable/") ? importRoot.slice("effect/unstable/".length) : "stable"
  const exports = [...source.matchAll(/export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g)].map((match) => ({
    name: match[1],
    import: `${importRoot}/${match[1]}`,
    source: path.posix.normalize(path.posix.join(path.posix.dirname(path.relative(effectRoot, file).split(path.sep).join("/")), match[2])),
    family
  }))
  if (exports.length === 0) fail(`${file} contains no namespace exports; upstream format may have changed`)
  return exports
}

async function publicPackages(directory) {
  const names = []
  for (const file of await filesNamed(directory, "package.json")) {
    const metadata = JSON.parse(await readFile(file, "utf8"))
    if (metadata.name && metadata.private !== true) names.push(metadata.name)
  }
  return [...new Set(names)].sort()
}

async function implementationInventory(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await implementationInventory(absolute))
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute)
  }
  return files
}

async function filesNamed(directory, name) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesNamed(absolute, name))
    else if (entry.isFile() && entry.name === name) files.push(absolute)
  }
  return files
}

async function markdownFiles(directory, prefix = "") {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) output.push(...await markdownFiles(path.join(directory, entry.name), relative))
    else if (entry.isFile() && entry.name.endsWith(".md")) output.push(relative)
  }
  return output.sort()
}

function stripFences(markdown, source = "Markdown") {
  const output = []
  let fence
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && marker[2].trim() === "") fence = undefined
      continue
    }
    if (!fence) output.push(line)
  }
  if (fence) fail(`${source} contains an unclosed code fence`)
  return output.join("\n")
}

function headingCounts(markdown) {
  const counts = new Map()
  for (const line of markdown.split("\n")) {
    const match = line.match(/^##(?!#)\s+(.+?)\s*#*$/)
    if (!match) continue
    const heading = match[1].replace(/\s+\{#[^}]+\}\s*$/, "").trim()
    counts.set(heading, (counts.get(heading) ?? 0) + 1)
  }
  return counts
}

function h2Sections(markdown) {
  const sections = []
  let current
  for (const line of markdown.split("\n")) {
    const match = line.match(/^##(?!#)\s+(.+?)\s*#*$/)
    if (match) {
      if (current) sections.push({ ...current, body: current.lines.join("\n") })
      current = {
        name: match[1].replace(/\s+\{#[^}]+\}\s*$/, "").trim(),
        lines: []
      }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) sections.push({ ...current, body: current.lines.join("\n") })
  return sections
}

function collisionEvidenceGaps(targets, sections) {
  const targetsByName = new Map()
  const sectionsByName = new Map()
  for (const target of targets) {
    const group = targetsByName.get(target.name) ?? []
    group.push(target)
    targetsByName.set(target.name, group)
  }
  for (const section of sections) {
    const group = sectionsByName.get(section.name) ?? []
    group.push(section)
    sectionsByName.set(section.name, group)
  }

  const gaps = []
  for (const [name, modules] of targetsByName) {
    if (modules.length < 2) continue
    const candidates = sectionsByName.get(name) ?? []
    const assignment = bestAssignment(modules, candidates)
    if (assignment.matched < modules.length) {
      gaps.push({
        name,
        expectedImports: modules.map((item) => item.import),
        unmatchedImports: modules.filter((_, index) => !assignment.moduleIndexes.has(index)).map((item) => item.import)
      })
    }
  }
  return gaps
}

function bestAssignment(modules, sections, moduleIndex = 0, used = new Set()) {
  if (moduleIndex === modules.length) return { matched: 0, score: 0, moduleIndexes: new Set() }
  let best = bestAssignment(modules, sections, moduleIndex + 1, used)
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    if (used.has(sectionIndex)) continue
    const score = sectionEvidenceScore(sections[sectionIndex].body, modules[moduleIndex])
    if (score === 0) continue
    used.add(sectionIndex)
    const rest = bestAssignment(modules, sections, moduleIndex + 1, used)
    used.delete(sectionIndex)
    const candidate = {
      matched: rest.matched + 1,
      score: rest.score + score,
      moduleIndexes: new Set([...rest.moduleIndexes, moduleIndex])
    }
    if (candidate.matched > best.matched || (candidate.matched === best.matched && candidate.score > best.score)) best = candidate
  }
  return best
}

function sectionEvidenceScore(body, target) {
  if (containsToken(body, target.import)) return 100
  if (target.family !== "stable" && containsToken(body, `effect/unstable/${target.family}`)) return 50
  return 0
}

function countBy(values, project) {
  const counts = new Map()
  for (const value of values) {
    const key = project(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function containsToken(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^A-Za-z0-9_.@/-])${escaped}(?=$|[^A-Za-z0-9_.@/-])`, "m").test(text)
}

function packageCoverage(markdown, name) {
  const lines = markdown.split("\n")
  const tokenLines = []
  const frontDoorLines = []
  for (let index = 0; index < lines.length; index++) {
    if (!containsToken(lines[index], name)) continue
    tokenLines.push(index + 1)
    if (isFrontDoorLabel(lines[index], name)) frontDoorLines.push(index + 1)
  }
  return {
    name,
    proseCovered: tokenLines.length > 0,
    frontDoorCovered: frontDoorLines.length > 0,
    tokenLines,
    frontDoorLines
  }
}

function isFrontDoorLabel(line, name) {
  const cells = line.split("|").map(stripSimpleMarkdown)
  if (cells.includes(name)) return true
  const stripped = stripSimpleMarkdown(line)
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^(?:pkg\\s+)?${escaped}(?:\\s*(?:—|–|-|:)|\\s*$)`).test(stripped)
}

function stripSimpleMarkdown(value) {
  return value
    .trim()
    .replace(/^>\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/(?:\*\*|__|`)/g, "")
    .trim()
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function option(name) {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) fail(`${name} requires a value`)
  return value
}

function required(name) {
  const value = option(name)
  if (!value || value.startsWith("--")) fail(`${name} is required`)
  return value
}

function fail(message) {
  console.error(`audit-source-coverage: ${message}`)
  process.exit(1)
}
