#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  agentBundles,
  capabilities,
  capabilityDomains,
  handbookRelease,
  siteGroups,
  sitePages,
  slugifyHeading
} from "../handbook.ts"
import { mapOutsideFences, resolveMarkdownTarget } from "./build-agent-handbook.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const docsRoot = path.join(root, "docs")

export const pageMarkdownOutputDirectory = path.join(root, "dist")
export const llmsIndexFilename = "llms.txt"
export const llmsFullFilename = "llms-full.txt"
export const robotsFilename = "robots.txt"
export const moduleIndexFilename = "effect-4-modules.md"
export const moduleIndexJsonFilename = "effect-4-modules.json"
export const agentGuideSource = "reference/agent-guide.md"

/** Pages with at least this many H2 sections get a generated contents line in their twin. */
export const contentsLineThreshold = 8

/**
 * Build the per-page Markdown twins, the compact LLM index, the module index,
 * and robots.txt in memory. Keeping construction separate from writing lets
 * the dev server put the same artifacts in `public/` without maintaining
 * another implementation.
 *
 * A twin is the canonical page source plus three generated additions that
 * keep an agent inside Markdown: a one-line header naming the page, release,
 * and the agent entry points; a contents line for long pages; and internal
 * links rewritten to the neighbouring `.md` twins.
 */
export async function buildPageMarkdownArtifacts({
  base = process.env.VITEPRESS_BASE ?? "/",
  siteUrl = process.env.HANDBOOK_SITE_URL
} = {}) {
  const normalizedBase = normalizeBase(base)
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl)
  const urls = { base: normalizedBase, siteUrl: normalizedSiteUrl }
  const pages = await Promise.all(sitePages.map(async (page) => {
    const relativePath = validateRelativePath(page.source)
    const sourcePath = resolveInside(docsRoot, relativePath)
    const source = await readFile(sourcePath, "utf8")
    return {
      kind: "page",
      page,
      relativePath,
      source,
      contents: Buffer.from(renderMarkdownTwin(page, source, urls))
    }
  }))

  assertUnique(pages.map(({ relativePath }) => relativePath), "page Markdown output")

  const sources = new Map(pages.map(({ relativePath, source }) => [relativePath, source]))
  const modules = buildModuleIndex(sources)
  const llms = buildLlmsIndex({ base: normalizedBase, siteUrl: normalizedSiteUrl, sources })
  const artifacts = [
    ...pages,
    { kind: "index", relativePath: llmsIndexFilename, contents: Buffer.from(llms) },
    { kind: "index", relativePath: moduleIndexFilename, contents: Buffer.from(renderModuleIndexMarkdown(modules)) },
    { kind: "index", relativePath: moduleIndexJsonFilename, contents: Buffer.from(renderModuleIndexJson(modules, urls)) },
    { kind: "index", relativePath: robotsFilename, contents: Buffer.from(buildRobotsTxt(urls)) }
  ]

  return {
    artifacts,
    base: normalizedBase,
    siteUrl: normalizedSiteUrl,
    pageCount: pages.length,
    moduleCount: modules.length,
    llms
  }
}

/** Write each artifact through a same-directory temporary file and rename. */
export async function writePageMarkdownArtifacts({
  outputDirectory = pageMarkdownOutputDirectory,
  ...buildOptions
} = {}) {
  const result = await buildPageMarkdownArtifacts(buildOptions)
  const resolvedOutput = path.resolve(outputDirectory)

  await Promise.all(result.artifacts.map(async (artifact) => {
    const destination = resolveInside(resolvedOutput, artifact.relativePath)
    await writeAtomically(destination, artifact.contents)
  }))

  return { ...result, outputDirectory: resolvedOutput }
}

/**
 * Compare generated artifacts byte-for-byte. This deliberately compares
 * Buffers: line endings, trailing whitespace, and final newlines are part of
 * the generated contract.
 */
export async function checkPageMarkdownArtifacts({
  outputDirectory = pageMarkdownOutputDirectory,
  ...buildOptions
} = {}) {
  const result = await buildPageMarkdownArtifacts(buildOptions)
  const resolvedOutput = path.resolve(outputDirectory)
  const mismatches = []

  await Promise.all(result.artifacts.map(async (artifact) => {
    const destination = resolveInside(resolvedOutput, artifact.relativePath)
    let actual
    try {
      actual = await readFile(destination)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    if (!actual?.equals(artifact.contents)) mismatches.push(artifact.relativePath)
  }))

  mismatches.sort()
  return {
    ...result,
    outputDirectory: resolvedOutput,
    mismatches,
    ok: mismatches.length === 0
  }
}

// --- Markdown twins ----------------------------------------------------------

/**
 * Render a page's Markdown twin: header comment, the source with a contents
 * line inserted after the H1 when the page is long, and internal links
 * rewritten to the neighbouring `.md` twins (relative, so the twin tree is
 * portable across bases and hosts).
 */
export function renderMarkdownTwin(page, source, urls = {}) {
  const normalizedBase = normalizeBase(urls.base ?? "/")
  const normalizedSiteUrl = normalizeSiteUrl(urls.siteUrl)
  const route = pageRoute(page.source)
  const header = `<!-- Markdown twin of ${routeUrl(route, normalizedBase, normalizedSiteUrl)} · The Effect 4 Handbook (effect@${handbookRelease.version}, audited ${handbookRelease.auditedAt}) · Index: ${artifactUrl(llmsIndexFilename, normalizedBase, normalizedSiteUrl)} · Modules: ${artifactUrl(moduleIndexFilename, normalizedBase, normalizedSiteUrl)} · Agent guide: ${artifactUrl(agentGuideSource, normalizedBase, normalizedSiteUrl)} -->`
  const relinked = rewriteLinksToRelativeTwins(source, page.source)
  const withContents = insertContentsLine(relinked, page.source)
  return `${header}\n\n${withContents}`
}

/** Rewrite page-relative route links to the relative `.md` twin paths. */
export function rewriteLinksToRelativeTwins(markdown, source) {
  const directory = path.posix.dirname(source)
  return mapOutsideFences(markdown, (line) =>
    line.replace(/(\]\()([^\s)>]+)([^)]*\))/g, (match, opening, href, closing) => {
      const resolved = resolveMarkdownTarget(href, source)
      if (!resolved) return match
      const relative = path.posix.relative(directory === "." ? "" : directory, resolved.target) || "index.md"
      return `${opening}${relative}${resolved.suffix}${closing}`
    }))
}

/**
 * Headings H1–H3 outside fences with their anchors, deduplicated the way the
 * site renderer does (`-1`, `-2`, … suffixes in document order).
 */
export function headingAnchors(markdown) {
  const headings = []
  const duplicates = new Map()
  mapOutsideFences(markdown, (line) => {
    const heading = line.match(/^(#{1,3})\s+(.+?)\s*#*$/)
    if (heading) {
      const text = heading[2].replace(/\s+\{#[^}]+\}\s*$/, "").trim()
      const base = slugifyHeading(text)
      const count = duplicates.get(base) ?? 0
      duplicates.set(base, count + 1)
      headings.push({ level: heading[1].length, text, anchor: count === 0 ? base : `${base}-${count}` })
    }
    return line
  })
  return headings
}

function insertContentsLine(markdown, source) {
  const sections = headingAnchors(markdown).filter((heading) => heading.level === 2)
  if (sections.length < contentsLineThreshold) return markdown
  const lines = markdown.split("\n")
  const h1 = lines.findIndex((line) => /^#\s+/.test(line))
  if (h1 === -1) throw new Error(`${source} has no H1 to attach a contents line to`)
  const contents = `**Contents:** ${sections.map((section) => `[${escapeMarkdownText(stripInlineCode(section.text))}](#${section.anchor})`).join(" · ")}`
  lines.splice(h1 + 1, 0, "", contents)
  return lines.join("\n")
}

function stripInlineCode(value) {
  return value.replace(/`([^`]*)`/g, "$1")
}

// --- Module index --------------------------------------------------------------

/**
 * Every module section in the canonical pages: an H2 whose first content line
 * is a label such as `` `effect/http/HttpClient` — unstable ``.
 */
export function buildModuleIndex(sources) {
  const modules = []
  const known = new Set(sitePages.map((page) => page.source))
  const ordered = [
    ...sitePages.filter((page) => sources.has(page.source)),
    ...[...sources.keys()].filter((source) => !known.has(source)).map((source) => ({ source }))
  ]
  for (const page of ordered) {
    const markdown = sources.get(page.source)
    const anchors = headingAnchors(markdown)
    const lines = markdown.split("\n")
    let fence
    let pending
    let anchorIndex = 0
    for (const line of lines) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (marker) {
        if (!fence) fence = { character: marker[1][0], length: marker[1].length }
        else if (marker[1][0] === fence.character && marker[1].length >= fence.length && marker[2].trim() === "") fence = undefined
        pending = undefined
        continue
      }
      if (fence) continue
      const heading = line.match(/^(#{1,3})\s+(.+?)\s*#*$/)
      if (heading) {
        const anchor = anchors[anchorIndex]
        anchorIndex += 1
        pending = heading[1].length === 2 ? anchor : undefined
        continue
      }
      if (!pending || line.trim() === "") continue
      const label = line.match(/^`((?:effect|@effect\/)[^`]*)` — (stable|unstable|experimental)\b/)
      if (label) {
        modules.push({
          module: pending.text,
          importPath: label[1],
          stability: label[2],
          page: page.source,
          anchor: pending.anchor,
          area: importArea(label[1])
        })
      }
      pending = undefined
    }
  }
  modules.sort((left, right) => left.module.localeCompare(right.module, "en") || left.importPath.localeCompare(right.importPath, "en"))
  return modules
}

/**
 * Root modules are capitalised (`effect/Semaphore`); an area front door or a
 * module inside an area starts with a lower-case segment (`effect/workflow`,
 * `effect/http/HttpClient`).
 */
function importArea(importPath) {
  if (importPath.startsWith("@effect/")) return importPath.split("/").slice(0, 2).join("/")
  const segments = importPath.split("/")
  if (segments.length >= 2 && /^[a-z]/.test(segments[1])) return `effect/${segments[1]}`
  return "effect"
}

// The module index lives at the site root and links relatively, like the
// twins, so the same file works at any base and from a local checkout.
export function renderModuleIndexMarkdown(modules) {
  const link = (entry) => `${entry.page}#${encodeURIComponent(entry.anchor)}`
  const row = (entry) => `- [${escapeMarkdownText(entry.module)}](${link(entry)}) — \`${entry.importPath}\` · ${entry.stability}`
  const lines = [
    "# Effect 4 module index",
    "",
    `> Generated from the handbook's module sections for effect@${handbookRelease.version} (audited ${handbookRelease.auditedAt}). ${modules.length} modules. Each entry links to the Markdown twin of the page and the exact section anchor; the badge is the module's \`@stability\` contract (no tag = semver-stable).`,
    "",
    `Start at the [LLM index](${llmsIndexFilename}) for task-based routing; use this file when you already know the module name. The same data is available as JSON at [${moduleIndexJsonFilename}](${moduleIndexJsonFilename}).`,
    "",
    "## Alphabetical",
    "",
    ...modules.map(row),
    "",
    "## By import area",
    ""
  ]
  const areas = [...new Set(modules.map((entry) => entry.area))].sort((left, right) => {
    if (left === "effect") return -1
    if (right === "effect") return 1
    return left.localeCompare(right, "en")
  })
  for (const area of areas) {
    lines.push(`### ${area === "effect" ? "effect (root barrel)" : area}`, "")
    lines.push(...modules.filter((entry) => entry.area === area).map(row), "")
  }
  return `${lines.join("\n").trimEnd()}\n`
}

export function renderModuleIndexJson(modules, urls = {}) {
  const normalizedBase = normalizeBase(urls.base ?? "/")
  const normalizedSiteUrl = normalizeSiteUrl(urls.siteUrl)
  return `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "module-index",
    handbook: {
      title: "The Effect 4 Handbook",
      effectVersion: handbookRelease.version,
      effectTag: handbookRelease.tag,
      effectCommit: handbookRelease.commit,
      auditedAt: handbookRelease.auditedAt
    },
    fieldSemantics: {
      module: "The module name as the handbook's H2 heading spells it.",
      importPath: "The public subpath of the module; root modules are also exported from the \"effect\" barrel.",
      stability: "The module's @stability contract: stable follows semver, unstable may change in a minor release, experimental may change in a patch release.",
      area: "The import area: effect for the root barrel, effect/<area> for a subsystem family, or the @effect/* package.",
      page: "Repository path of the canonical page; append it to the site base to fetch the Markdown twin.",
      anchor: "The section anchor on that page.",
      markdownUrl: "The Markdown twin URL with the section anchor."
    },
    totals: {
      modules: modules.length,
      stable: modules.filter((entry) => entry.stability === "stable").length,
      unstable: modules.filter((entry) => entry.stability === "unstable").length,
      experimental: modules.filter((entry) => entry.stability === "experimental").length
    },
    modules: modules.map((entry) => ({
      ...entry,
      markdownUrl: `${artifactUrl(entry.page, normalizedBase, normalizedSiteUrl)}#${encodeURIComponent(entry.anchor)}`
    }))
  }, null, 2)}\n`
}

// --- llms.txt ----------------------------------------------------------------------

export function buildLlmsIndex({
  base = process.env.VITEPRESS_BASE ?? "/",
  siteUrl = process.env.HANDBOOK_SITE_URL,
  sources
} = {}) {
  const normalizedBase = normalizeBase(base)
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl)
  const url = (relativePath) => artifactUrl(relativePath, normalizedBase, normalizedSiteUrl)
  const pageSources = sources ?? new Map(sitePages.map((page) => [page.source, readFileSync(path.join(docsRoot, page.source), "utf8")]))
  const pageWords = new Map([...pageSources].map(([source, markdown]) => [source, wordCount(markdown)]))
  const sumWords = (pageList) => pageList.reduce((total, source) => total + (pageWords.get(source) ?? 0), 0)
  const concisePages = siteGroups.filter((group) => group.text !== "Deep Dives").flatMap((group) => group.items.map((page) => page.source))
  const moduleCount = buildModuleIndex(pageSources).length

  const lines = [
    "# The Effect 4 Handbook",
    "",
    `> A source-grounded guide audited ${handbookRelease.auditedAt} against Effect ${handbookRelease.version} (${handbookRelease.commit.slice(0, 12)}).`,
    "",
    "Use the intent map or capability catalog first, then fetch only the linked Markdown page or domain bundle. Use the complete concise aggregate for broad cross-cutting review, not as the default retrieval unit. Every HTML page has a Markdown twin at the same path with `.md` appended (`/` is `/index.md`); fetch the twin, never the HTML. Sizes are given in words; budget roughly 1.3 tokens per word, more for code-heavy pages.",
    "",
    `- [Using this handbook from an agent](${url(agentGuideSource)}): The reading protocol — which artifact to fetch for which task, the Markdown URL rule, how to read the catalog, how to cite, and a drop-in instructions block (${formatWords(pageWords.get(agentGuideSource) ?? 0)}).`,
    `- [Module index](${url(moduleIndexFilename)}): Every module section by name — import path, stability badge, and the Markdown twin anchor (${moduleCount} modules; JSON at [${moduleIndexJsonFilename}](${url(moduleIndexJsonFilename)})).`,
    `- [Capability catalog](${url("effect-4-catalog.json")}): Structured symbols, task aliases, selection boundaries, error/context/lifetime facts, and canonical anchors.`,
    `- [Example inventory and validation plan](${url("effect-4-examples.json")}): Classifies compile, contextual, run, pseudocode, and expected-invalid examples without embedding transient validation results.`,
    `- [Complete concise handbook](${url("effect-4-handbook.md")}): All concise reference, recipe, and troubleshooting pages; long-form deep dives are intentionally excluded (${formatWords(sumWords(concisePages))}; the same text is served as [${llmsFullFilename}](${url(llmsFullFilename)})).`
  ]

  lines.push("", "## Domain bundles", "")
  for (const bundle of agentBundles) {
    lines.push(`- [${escapeMarkdownText(bundle.title)}](${url(bundle.filename)}): Focused aggregate for ${escapeMarkdownText(bundle.id)} tasks (${formatWords(sumWords(bundle.sources))}).`)
  }

  lines.push("", "## Intent and primitive map")
  for (const [domain, description] of Object.entries(capabilityDomains)) {
    const entries = capabilities.filter((entry) => entry.domain === domain)
    if (entries.length === 0) continue
    lines.push("", `### ${escapeMarkdownText(description)}`, "")
    for (const entry of entries) {
      const pageUrl = `${url(entry.page)}#${encodeURIComponent(entry.anchor)}`
      const tasks = entry.tasks.slice(0, 4).join(", ")
      lines.push(`- [${escapeMarkdownText(entry.symbols.join(" / "))}](${pageUrl}) — ${escapeMarkdownText(tasks)}. ${escapeMarkdownText(entry.summary)}`)
    }
  }

  for (const group of siteGroups) {
    const heading = group.text === "Deep Dives" ? "## Optional" : `## ${escapeMarkdownText(group.text)}`
    lines.push("", heading, "")
    if (group.text === "Deep Dives") {
      lines.push("Long-form human-oriented explanations. They are published as individual Markdown pages but excluded from the concise aggregate and domain bundles.", "")
    }
    for (const page of group.items) {
      const title = page.title ?? page.text
      const description = cleanDescription(page.description) || title
      lines.push(`- [${escapeMarkdownText(title)}](${url(page.source)}): ${escapeMarkdownText(description)} (${formatWords(pageWords.get(page.source) ?? 0)})`)
    }
  }

  return `${lines.join("\n")}\n`
}

// --- robots.txt --------------------------------------------------------------------

export function buildRobotsTxt(urls = {}) {
  const normalizedBase = normalizeBase(urls.base ?? "/")
  const normalizedSiteUrl = normalizeSiteUrl(urls.siteUrl)
  const lines = [
    "User-agent: *",
    "Allow: /",
    "",
    "# Machine-readable entry points for coding agents and LLM tools.",
    `# Index of every page and artifact: ${artifactUrl(llmsIndexFilename, normalizedBase, normalizedSiteUrl)}`,
    `# Full concise handbook as one Markdown file: ${artifactUrl(llmsFullFilename, normalizedBase, normalizedSiteUrl)}`,
    `# Module index: ${artifactUrl(moduleIndexFilename, normalizedBase, normalizedSiteUrl)}`,
    "# Every HTML page has a Markdown twin at the same path with .md appended; fetch the twin."
  ]
  if (normalizedSiteUrl) lines.push("", `Sitemap: ${new URL("sitemap.xml", normalizedSiteUrl).href}`)
  return `${lines.join("\n")}\n`
}

// --- shared helpers ------------------------------------------------------------------

export function artifactUrl(relativePath, base = "/", siteUrl) {
  const normalizedBase = normalizeBase(base)
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl)
  const safePath = validateRelativePath(relativePath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  const pathname = `${normalizedBase}${safePath}`
  return normalizedSiteUrl ? new URL(safePath, normalizedSiteUrl).href : pathname
}

function pageRoute(source) {
  if (source === "index.md") return ""
  if (source.endsWith("/index.md")) return source.slice(0, -"index.md".length)
  return source.replace(/\.md$/, "")
}

function routeUrl(route, base, siteUrl) {
  const safe = route.split("/").filter(Boolean).map((segment) => encodeURIComponent(segment)).join("/") + (route.endsWith("/") ? "/" : "")
  return siteUrl ? new URL(safe, siteUrl).href : `${base}${safe}`
}

export function wordCount(markdown) {
  return markdown.split(/\s+/).filter(Boolean).length
}

export function formatWords(count) {
  if (count >= 10_000) return `~${(count / 1000).toFixed(0)}K words`
  if (count >= 1000) return `~${(count / 1000).toFixed(1)}K words`
  return `~${count} words`
}

function cleanDescription(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

function escapeMarkdownText(value) {
  return String(value).replace(/([\\[\]])/g, "\\$1").replace(/\r?\n/g, " ")
}

function normalizeBase(input) {
  const trimmed = String(input).trim()
  if (trimmed === "" || trimmed === "/") return "/"
  const segments = trimmed.split("/").filter(Boolean)
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid VITEPRESS_BASE: ${JSON.stringify(input)}`)
  }
  return `/${segments.join("/")}/`
}

function normalizeSiteUrl(input) {
  if (input === undefined || input === null || String(input).trim() === "") return undefined
  let url
  try {
    url = new URL(String(input).trim())
  } catch {
    throw new Error(`Invalid HANDBOOK_SITE_URL: ${JSON.stringify(input)}`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`HANDBOOK_SITE_URL must use http or https: ${JSON.stringify(input)}`)
  }
  url.hash = ""
  url.search = ""
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url.href
}

function validateRelativePath(input) {
  const value = String(input)
  if (
    value === "" ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe generated artifact path: ${JSON.stringify(input)}`)
  }
  return value
}

function resolveInside(directory, relativePath) {
  const rootPath = path.resolve(directory)
  const destination = path.resolve(rootPath, ...validateRelativePath(relativePath).split("/"))
  if (!destination.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Generated artifact escapes output directory: ${JSON.stringify(relativePath)}`)
  }
  return destination
}

function assertUnique(values, label) {
  const seen = new Set()
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

async function writeAtomically(destination, contents) {
  await mkdir(path.dirname(destination), { recursive: true })
  const temporaryPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.tmp-${process.pid}-${randomUUID()}`
  )
  try {
    await writeFile(temporaryPath, contents, { flag: "wx" })
    await rename(temporaryPath, destination)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function parseArguments(argv) {
  let check = false
  let outputDirectory = pageMarkdownOutputDirectory
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--check") {
      check = true
    } else if (argument === "--output") {
      const value = argv[index + 1]
      if (!value) throw new Error("--output requires a directory")
      outputDirectory = path.resolve(value)
      index += 1
    } else if (argument.startsWith("--output=")) {
      outputDirectory = path.resolve(argument.slice("--output=".length))
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return { check, outputDirectory }
}

async function main() {
  const { check, outputDirectory } = parseArguments(process.argv.slice(2))
  if (check) {
    const result = await checkPageMarkdownArtifacts({ outputDirectory })
    if (!result.ok) {
      console.error(`Page Markdown artifacts are missing or stale: ${result.mismatches.join(", ")}`)
      process.exitCode = 1
      return
    }
    console.log(`Page Markdown twins, ${llmsIndexFilename}, the module index (${result.moduleCount} modules), and ${robotsFilename} are current (${result.pageCount} pages).`)
    return
  }

  const result = await writePageMarkdownArtifacts({ outputDirectory })
  console.log(`Generated ${result.pageCount} page Markdown twins, ${llmsIndexFilename}, the module index (${result.moduleCount} modules), and ${robotsFilename} in ${path.relative(root, result.outputDirectory) || "."}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
