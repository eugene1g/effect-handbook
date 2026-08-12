import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { sitePages } from "../../handbook.ts"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = path.resolve(scriptDirectory, "../..")
export const docsRoot = path.join(repositoryRoot, "docs")
export const validationRoot = path.join(repositoryRoot, "validation")
export const generatedRoot = path.join(repositoryRoot, ".validation", "generated")
export const examplesRegistryPath = path.join(validationRoot, "examples.json")

const TYPESCRIPT_FENCE = /^ {0,3}(?<marker>`{3,}|~{3,})\s*(?<language>typescript|tsx|ts)(?<info>(?:\s.*)?)$/
const EXAMPLE_METADATA = /^<!--\s*effect-example:?\s*(?<content>.*?)\s*-->$/
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const DISPOSITIONS = new Set(["compile", "contextual", "run", "pseudocode", "invalid"])
const METADATA_KEYS = new Set(["id", "check", "fixture", "runtime", "reason"])

export function assertExactObjectKeys(value, { required = [], optional = [] }, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown property ${key}`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing required property ${key}`)
  }
}

export const sha256 = (value) => createHash("sha256").update(value).digest("hex")

const sourceKey = (source, digest) => `${source}\0${digest}`

const slug = (value) => value
  .toLowerCase()
  .replace(/^docs\//, "")
  .replace(/\.md$/, "")
  .replace(/[^a-z0-9]+/g, ".")
  .replace(/^\.|\.$/g, "")

const fallbackId = ({ source, sha256: digest }) => `${slug(source)}.${digest.slice(0, 16)}`

export function parseExampleMetadata(line, location = "Markdown") {
  const match = line.match(EXAMPLE_METADATA)
  if (!match) return undefined
  const result = {}
  const pattern = /([a-z]+)=("[^"]+"|'[^']+'|[^\s]+)/g
  for (const field of match.groups.content.matchAll(pattern)) {
    const key = field[1]
    if (!METADATA_KEYS.has(key)) throw new Error(`${location}: unknown effect-example field ${key}`)
    if (Object.hasOwn(result, key)) throw new Error(`${location}: duplicate effect-example field ${key}`)
    let value = field[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  const residue = match.groups.content.replace(pattern, "").trim()
  if (residue !== "") throw new Error(`${location}: could not parse effect-example metadata: ${residue}`)
  if (result.id !== undefined && !ID_PATTERN.test(result.id)) throw new Error(`${location}: invalid example id ${result.id}`)
  if (result.check !== undefined && !DISPOSITIONS.has(result.check)) throw new Error(`${location}: invalid check ${result.check}`)
  return result
}

function metadataDisposition(metadata) {
  return metadata?.check
}

function parseInfo(info) {
  const result = { doctest: /(?:^|\s)import\.meta\.vitest(?:\s|$)/.test(info) }
  const name = info.match(/(?:^|\s)name=("[^"]+"|'[^']+')/)
  if (name) result.name = name[1].slice(1, -1)
  return result
}

const packageName = (specifier) => specifier.startsWith("@")
  ? specifier.split("/").slice(0, 2).join("/")
  : specifier.split("/")[0]

const importTokens = (source) => {
  const tokens = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (/\s/.test(character)) { index++; continue }
    if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2)
      if (index === -1) break
      continue
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (character === "`" || character === "\"" || character === "'") {
      const quote = character
      let value = ""
      index++
      while (index < source.length) {
        if (source[index] === "\\") {
          if (quote !== "`") value += source[index + 1] ?? ""
          index += 2
          continue
        }
        if (source[index] === quote) { index++; break }
        if (quote !== "`") value += source[index]
        index++
      }
      tokens.push(quote === "`" ? { kind: "template" } : { kind: "string", value })
      continue
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0]
    if (identifier) {
      tokens.push({ kind: "identifier", value: identifier })
      index += identifier.length
      continue
    }
    tokens.push({ kind: "punctuation", value: character })
    index++
  }
  return tokens
}

export function importedPackages(body) {
  const packages = new Set()
  const add = (specifier) => {
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return
    packages.add(packageName(specifier))
  }
  const tokens = importTokens(body)
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.kind !== "identifier" || !["import", "export"].includes(token.value)) continue
    if (token.value === "import" && tokens[index + 1]?.value === ".") continue
    if (token.value === "import" && tokens[index + 1]?.value === "(" && tokens[index + 2]?.kind === "string") {
      add(tokens[index + 2].value)
      continue
    }
    if (token.value === "import" && tokens[index + 1]?.kind === "string") {
      add(tokens[index + 1].value)
      continue
    }
    for (let cursor = index + 1; cursor < tokens.length && tokens[cursor]?.value !== ";"; cursor++) {
      if (tokens[cursor]?.kind === "identifier" && tokens[cursor].value === "from" && tokens[cursor + 1]?.kind === "string") {
        add(tokens[cursor + 1].value)
        break
      }
    }
  }
  return [...packages].sort()
}

export async function readCanonicalExamples() {
  const pageSources = sitePages.map((page) => `docs/${page.source}`)
  const duplicates = pageSources.filter((source, index) => pageSources.indexOf(source) !== index)
  if (duplicates.length > 0) throw new Error(`Duplicate canonical page in sitePages: ${duplicates[0]}`)
  const examples = []
  const sourceChunks = []

  for (const source of pageSources) {
    const markdown = await readFile(path.join(repositoryRoot, source), "utf8")
    sourceChunks.push(`${source}\0${markdown}`)
    const lines = markdown.split(/\r?\n/)
    let heading = ""
    let inOtherFence
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      const anyFence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (inOtherFence) {
        if (anyFence && anyFence[1][0] === inOtherFence.character && anyFence[1].length >= inOtherFence.length && anyFence[2].trim() === "") {
          inOtherFence = undefined
        }
        continue
      }
      const opening = line.match(TYPESCRIPT_FENCE)
      if (!opening) {
        if (anyFence) {
          inOtherFence = { character: anyFence[1][0], length: anyFence[1].length }
          continue
        }
        const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*#*$/)
        if (headingMatch) heading = headingMatch[1]
        continue
      }

      const marker = opening.groups.marker
      const closePattern = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`)
      const openingLine = index + 1
      const bodyLines = []
      index++
      while (index < lines.length && !closePattern.test(lines[index])) {
        bodyLines.push(lines[index])
        index++
      }
      if (index >= lines.length) throw new Error(`${source}:${openingLine}: unclosed TypeScript fence`)
      const metadataLine = openingLine >= 2 ? lines[openingLine - 2] : ""
      const metadata = parseExampleMetadata(metadataLine, `${source}:${openingLine - 1}`)
      const body = bodyLines.join("\n")
      examples.push({
        source,
        heading,
        language: opening.groups.language === "typescript" ? "ts" : opening.groups.language,
        info: opening.groups.info.trim(),
        ...parseInfo(opening.groups.info),
        openingLine,
        startLine: openingLine + 1,
        endLine: openingLine + bodyLines.length,
        body,
        sha256: sha256(body),
        packages: importedPackages(body),
        metadata,
        visibleContext: lines.slice(Math.max(0, openingLine - 7), openingLine - 1).join("\n")
      })
    }
    if (inOtherFence) throw new Error(`${source}: unclosed non-TypeScript fence`)
  }
  return { examples, pageSources, canonicalSourceHash: sha256(sourceChunks.join("\0\0")) }
}

export async function loadExampleRegistry() {
  const registry = JSON.parse(await readFile(examplesRegistryPath, "utf8"))
  assertExactObjectKeys(registry, {
    required: ["schemaVersion", "examples", "runtimes"],
    optional: ["$schema"]
  }, "validation/examples.json")
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.examples)) {
    throw new Error("validation/examples.json must use schemaVersion 1 with an examples array")
  }
  const byId = new Map()
  const bySourceHash = new Map()
  for (const entry of registry.examples) {
    assertExactObjectKeys(entry, {
      required: ["id", "source", "sha256", "disposition"],
      optional: ["fixture", "runtime", "reason", "diagnostic", "platform", "packages"]
    }, `validation/examples.json entry ${entry?.id ?? "<unknown>"}`)
    if (!entry || typeof entry !== "object") throw new Error("Invalid validation/examples.json entry")
    if (!ID_PATTERN.test(entry.id ?? "")) throw new Error(`Invalid registry id ${entry.id}`)
    if (byId.has(entry.id)) throw new Error(`Duplicate registry id ${entry.id}`)
    if (typeof entry.source !== "string" || !entry.source.startsWith("docs/") || !entry.source.endsWith(".md")) {
      throw new Error(`${entry.id}: invalid source`)
    }
    if (!HASH_PATTERN.test(entry.sha256 ?? "")) throw new Error(`${entry.id}: invalid sha256`)
    if (!DISPOSITIONS.has(entry.disposition) || entry.disposition === "compile") {
      throw new Error(`${entry.id}: registry entries are exceptions and cannot use disposition ${entry.disposition}`)
    }
    if (["contextual", "run", "invalid"].includes(entry.disposition) && !entry.id) {
      throw new Error(`${entry.source}: ${entry.disposition} requires an explicit id`)
    }
    if (entry.disposition === "contextual" && (typeof entry.fixture !== "string" || entry.fixture === "")) {
      throw new Error(`${entry.id}: contextual example requires one named fixture`)
    }
    if (entry.fixture !== undefined && !ID_PATTERN.test(entry.fixture)) throw new Error(`${entry.id}: invalid fixture name ${entry.fixture}`)
    if (["contextual", "run", "invalid"].includes(entry.disposition) && /\.[a-f0-9]{16}$/.test(entry.id)) {
      throw new Error(`${entry.id}: exception ids must be semantic and cannot contain a body-hash suffix`)
    }
    if (entry.disposition === "run" && (typeof entry.runtime !== "string" || entry.runtime === "")) {
      throw new Error(`${entry.id}: run example requires a runtime association`)
    }
    if (entry.runtime !== undefined && !ID_PATTERN.test(entry.runtime)) throw new Error(`${entry.id}: invalid runtime name ${entry.runtime}`)
    if (entry.disposition === "pseudocode" && (typeof entry.reason !== "string" || entry.reason.trim() === "")) {
      throw new Error(`${entry.id}: pseudocode requires a specific reason`)
    }
    if (entry.disposition === "invalid") {
      const diagnostic = entry.diagnostic
      assertExactObjectKeys(diagnostic, { required: ["code", "message"] }, `${entry.id}.diagnostic`)
      if (!diagnostic || !/^TS[0-9]+$/.test(diagnostic.code ?? "") || typeof diagnostic.message !== "string" || diagnostic.message === "") {
        throw new Error(`${entry.id}: invalid example requires one precise diagnostic`)
      }
    }
    if (entry.platform !== undefined && (typeof entry.platform !== "string" || entry.platform.trim() === "")) {
      throw new Error(`${entry.id}: platform must be a non-empty string`)
    }
    if (entry.packages !== undefined) {
      if (!Array.isArray(entry.packages) || entry.packages.some((name) => typeof name !== "string" || name === "")) {
        throw new Error(`${entry.id}: packages must be non-empty package names`)
      }
      if (new Set(entry.packages).size !== entry.packages.length) throw new Error(`${entry.id}: packages must be unique`)
    }
    const key = sourceKey(entry.source, entry.sha256)
    if (bySourceHash.has(key)) throw new Error(`Duplicate registry source/hash for ${entry.source}`)
    byId.set(entry.id, entry)
    bySourceHash.set(key, entry)
  }
  for (const [name, runtime] of Object.entries(registry.runtimes)) {
    assertExactObjectKeys(runtime, {
      required: ["mode", "expect"],
      optional: ["exitCode"]
    }, `validation/examples.json runtime ${name}`)
    if (!["complete", "signal", "doctest"].includes(runtime.mode)) throw new Error(`${name}: unsupported runtime mode ${runtime.mode}`)
    if (!Array.isArray(runtime.expect) || runtime.expect.length === 0 || runtime.expect.some((value) => typeof value !== "string" || value === "")) {
      throw new Error(`${name}: runtime expect must contain one or more strings`)
    }
    if (runtime.exitCode !== undefined && (!Number.isInteger(runtime.exitCode) || runtime.exitCode < 0 || runtime.exitCode > 255)) {
      throw new Error(`${name}: runtime exitCode must be an integer from 0 to 255`)
    }
  }
  return { registry, byId, bySourceHash }
}

export function assertRuntimeDefinitionsUsed(registry, usedRuntimes) {
  for (const runtime of Object.keys(registry.runtimes ?? {})) {
    if (!usedRuntimes.has(runtime)) throw new Error(`Orphan runtime definition ${runtime}`)
  }
  for (const runtime of usedRuntimes) {
    if (!Object.hasOwn(registry.runtimes ?? {}, runtime)) throw new Error(`Missing runtime definition ${runtime}`)
  }
}

export async function classifyDocExamples() {
  const [{ examples, pageSources, canonicalSourceHash }, loaded] = await Promise.all([
    readCanonicalExamples(),
    loadExampleRegistry()
  ])
  const usedRegistryIds = new Set()
  const usedIds = new Map()
  const usedRuntimes = new Set()

  for (const example of examples) {
    const inlineId = example.metadata?.id
    const byInlineId = inlineId === undefined ? undefined : loaded.byId.get(inlineId)
    const byHash = loaded.bySourceHash.get(sourceKey(example.source, example.sha256))
    if (byInlineId !== undefined && byHash !== undefined && byInlineId !== byHash) {
      throw new Error(`${example.source}:${example.openingLine}: inline id and body hash select different registry entries`)
    }
    const registered = byInlineId ?? byHash
    if (inlineId !== undefined && registered === undefined && metadataDisposition(example.metadata) !== undefined && metadataDisposition(example.metadata) !== "compile") {
      throw new Error(`${example.source}:${example.openingLine}: untracked exception id ${inlineId}`)
    }
    if (registered !== undefined) {
      usedRegistryIds.add(registered.id)
      if (registered.source !== example.source) throw new Error(`${registered.id}: stale source (expected ${registered.source}, found ${example.source})`)
      if (registered.sha256 !== example.sha256) throw new Error(`${registered.id}: stale body hash`)
    }
    const declared = metadataDisposition(example.metadata)
    const disposition = registered?.disposition ?? declared ?? "compile"
    if (declared !== undefined && declared !== disposition) {
      throw new Error(`${example.source}:${example.openingLine}: Markdown declares ${declared}, registry declares ${disposition}`)
    }
    if (["contextual", "run", "invalid"].includes(disposition) && inlineId === undefined && registered === undefined) {
      throw new Error(`${example.source}:${example.openingLine}: ${disposition} requires a stable explicit id`)
    }
    const id = inlineId ?? registered?.id ?? fallbackId(example)
    if (!ID_PATTERN.test(id)) throw new Error(`${example.source}:${example.openingLine}: invalid id ${id}`)
    if (usedIds.has(id)) throw new Error(`Duplicate example id ${id}: ${usedIds.get(id)} and ${example.source}:${example.openingLine}`)
    usedIds.set(id, `${example.source}:${example.openingLine}`)
    if (disposition === "pseudocode") {
      const visiblyLabelled = /\b(?:Illustrative|Pseudocode)\b/i.test(example.visibleContext)
      if (!visiblyLabelled) throw new Error(`${id}: pseudocode must be visibly labelled immediately before its fence`)
      if (typeof registered?.reason !== "string" || registered.reason.trim() === "") throw new Error(`${id}: pseudocode needs a tracked justification`)
    }
    if (disposition === "contextual" && typeof registered?.fixture !== "string") throw new Error(`${id}: contextual example has no tracked fixture`)
    if (disposition === "run" && typeof registered?.runtime !== "string") throw new Error(`${id}: run example has no tracked runtime assertion`)
    if (example.doctest && disposition !== "run" && example.source.startsWith("docs/")) {
      throw new Error(`${id}: import.meta.vitest fence must use disposition run`)
    }
    Object.assign(example, {
      id,
      disposition,
      fixture: registered?.fixture,
      runtime: registered?.runtime,
      reason: registered?.reason,
      diagnostic: registered?.diagnostic,
      platform: registered?.platform ?? "portable",
      packages: registered?.packages ?? example.packages,
      classificationSource: registered ? "registry" : declared ? "metadata" : "default"
    })
    if (registered?.runtime !== undefined) usedRuntimes.add(registered.runtime)
  }
  for (const entry of loaded.registry.examples) {
    if (!usedRegistryIds.has(entry.id)) throw new Error(`Orphan or stale registry entry ${entry.id}`)
  }
  assertRuntimeDefinitionsUsed(loaded.registry, usedRuntimes)
  return { examples, pageSources, canonicalSourceHash, registry: loaded.registry }
}

export const generatedFilename = (example) => {
  const extension = example.language === "tsx" ? "tsx" : "ts"
  return `${example.id.replace(/[^a-zA-Z0-9._-]+/g, "-")}.${extension}`
}

export const dispositionCounts = (examples) => Object.fromEntries(
  [...DISPOSITIONS].map((disposition) => [disposition, examples.filter((example) => example.disposition === disposition).length])
)
