#!/usr/bin/env node

import { randomUUID } from "node:crypto"
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
  sitePages
} from "../handbook.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const docsRoot = path.join(root, "docs")

export const pageMarkdownOutputDirectory = path.join(root, "dist")
export const llmsIndexFilename = "llms.txt"

/**
 * Build the exact per-page Markdown mirrors and the compact LLM index in
 * memory. Keeping construction separate from writing lets the dev server put
 * the same artifacts in `public/` without maintaining another implementation.
 */
export async function buildPageMarkdownArtifacts({
  base = process.env.VITEPRESS_BASE ?? "/",
  siteUrl = process.env.HANDBOOK_SITE_URL
} = {}) {
  const normalizedBase = normalizeBase(base)
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl)
  const pages = await Promise.all(sitePages.map(async (page) => {
    const relativePath = validateRelativePath(page.source)
    const sourcePath = resolveInside(docsRoot, relativePath)
    return {
      kind: "page",
      page,
      relativePath,
      contents: await readFile(sourcePath)
    }
  }))

  assertUnique(pages.map(({ relativePath }) => relativePath), "page Markdown output")

  const llms = buildLlmsIndex({
    base: normalizedBase,
    siteUrl: normalizedSiteUrl
  })
  const artifacts = [
    ...pages,
    {
      kind: "index",
      relativePath: llmsIndexFilename,
      contents: Buffer.from(llms)
    }
  ]

  return {
    artifacts,
    base: normalizedBase,
    siteUrl: normalizedSiteUrl,
    pageCount: pages.length,
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
 * Compare generated artifacts byte-for-byte. This deliberately reads page
 * sources as Buffers: line endings, trailing whitespace, and final newlines
 * are part of the canonical Markdown contract.
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

export function buildLlmsIndex({
  base = process.env.VITEPRESS_BASE ?? "/",
  siteUrl = process.env.HANDBOOK_SITE_URL
} = {}) {
  const normalizedBase = normalizeBase(base)
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl)
  const lines = [
    "# The Effect 4 Handbook",
    "",
    `> A source-grounded guide audited ${handbookRelease.auditedAt} against Effect ${handbookRelease.version} (${handbookRelease.commit.slice(0, 12)}).`,
    "",
    "Use the intent map or capability catalog first, then fetch only the linked Markdown page or domain bundle. Use the complete concise aggregate for broad cross-cutting review, not as the default retrieval unit.",
    "",
    `- [Capability catalog](${artifactUrl("effect-4-catalog.json", normalizedBase, normalizedSiteUrl)}): Structured symbols, task aliases, selection boundaries, error/context/lifetime facts, and canonical anchors.`,
    `- [Example inventory and validation plan](${artifactUrl("effect-4-examples.json", normalizedBase, normalizedSiteUrl)}): Classifies compile, contextual, run, pseudocode, and expected-invalid examples without embedding transient validation results.`,
    `- [Complete concise handbook](${artifactUrl("effect-4-handbook.md", normalizedBase, normalizedSiteUrl)}): All concise reference, recipe, and troubleshooting pages; long-form deep dives are intentionally excluded.`
  ]

  lines.push("", "## Domain bundles", "")
  for (const bundle of agentBundles) {
    lines.push(`- [${escapeMarkdownText(bundle.title)}](${artifactUrl(bundle.filename, normalizedBase, normalizedSiteUrl)}): Focused aggregate for ${escapeMarkdownText(bundle.id)} tasks.`)
  }

  lines.push("", "## Intent and primitive map")
  for (const [domain, description] of Object.entries(capabilityDomains)) {
    const entries = capabilities.filter((entry) => entry.domain === domain)
    if (entries.length === 0) continue
    lines.push("", `### ${escapeMarkdownText(description)}`, "")
    for (const entry of entries) {
      const pageUrl = `${artifactUrl(entry.page, normalizedBase, normalizedSiteUrl)}#${encodeURIComponent(entry.anchor)}`
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
      lines.push(`- [${escapeMarkdownText(title)}](${artifactUrl(page.source, normalizedBase, normalizedSiteUrl)}): ${escapeMarkdownText(description)}`)
    }
  }

  return `${lines.join("\n")}\n`
}

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
    console.log(`Page Markdown and llms.txt are current (${result.pageCount} exact source mirrors).`)
    return
  }

  const result = await writePageMarkdownArtifacts({ outputDirectory })
  console.log(`Generated ${result.pageCount} exact page Markdown mirrors and ${llmsIndexFilename} in ${path.relative(root, result.outputDirectory) || "."}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
