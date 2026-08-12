import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { deepDivePages, handbookGroups, handbookPages, siteGroups, sitePages } from "../handbook.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const docsRoot = path.join(root, "docs")
const expectedSources = sitePages.map((page) => page.source).sort()
const actualFiles = (await listFiles(docsRoot))
  .filter((file) => path.posix.basename(file) !== ".DS_Store")
  .sort()
const actualSources = actualFiles.filter((file) => file.endsWith(".md"))

assert(handbookPages.length > 0, "The concise handbook manifest is empty")
assert(deepDivePages.length > 0, "The deep-dive manifest is empty")
assert(actualFiles.every((file) => file.endsWith(".md")), `docs/ must contain only canonical Markdown; found: ${actualFiles.filter((file) => !file.endsWith(".md")).join(", ")}`)
assert(new Set(expectedSources).size === expectedSources.length, "The manifest contains duplicate source files")
assert(new Set(sitePages.map((page) => page.link)).size === sitePages.length, "The manifest contains duplicate routes")
assert(sitePages.every((page) => typeof page.description === "string" && page.description.trim() === page.description && page.description.length > 0 && !page.description.includes("\n")), "Every manifest page must have a non-empty single-line description")
assert(sitePages.every((page) => Array.isArray(page.related) && page.related.every((source) => expectedSources.includes(source) && source !== page.source)), "Every manifest related-topic source must name another canonical page")
assert(JSON.stringify(actualSources) === JSON.stringify(expectedSources), inventoryError(expectedSources, actualSources))

let headingCount = 0
let codeBlockCount = 0
for (const page of sitePages) {
  const sourcePath = path.join(docsRoot, page.source)
  const markdown = await readFile(sourcePath, "utf8")
  assert(!markdown.startsWith("\ufeff"), `${page.source} starts with a byte-order mark`)
  assert(!markdown.includes("\r"), `${page.source} contains CRLF line endings`)
  assert(!/[ \t]+$/m.test(markdown), `${page.source} contains trailing whitespace`)
  assert(!markdown.startsWith("---\n"), `${page.source} must not have frontmatter`)

  const structure = scanMarkdown(markdown, page.source)
  const h1 = structure.headings.filter((heading) => heading.level === 1)
  assert(h1.length === 1, `${page.source} must contain exactly one H1; found ${h1.length}`)
  assert(h1[0].text === page.title, `${page.source} H1 is ${JSON.stringify(h1[0].text)}; expected ${JSON.stringify(page.title)}`)
  assert(!structure.headings.some((heading) => heading.level > 3), `${page.source} skips the H1-H3 document hierarchy`)
  for (let index = 1; index < structure.headings.length; index++) {
    const previous = structure.headings[index - 1]
    const heading = structure.headings[index]
    assert(heading.level <= previous.level + 1, `${page.source}:${heading.line} skips from H${previous.level} to H${heading.level}`)
  }
  assert(!structure.prose.some(({ text }) => /\{\{[^}]/.test(text)), `${page.source} contains Vue template interpolation outside code`)
  assert(!structure.prose.some(({ text }) => /<\/?[A-Z][A-Za-z0-9_.-]*(?:\s|\/?>)/.test(withoutInlineCode(text))), `${page.source} contains an unescaped Vue-like tag outside code`)

  headingCount += structure.headings.length
  codeBlockCount += structure.codeBlocks
}

assert(handbookGroups.flatMap((group) => group.items).length === handbookPages.length, "Sidebar groups and page manifest disagree")
assert(siteGroups.flatMap((group) => group.items).length === sitePages.length, "Site groups and page manifest disagree")
assert(handbookPages.every((page) => sitePages.includes(page)), "Every concise handbook page must also be a site page")
console.log(`Canonical Markdown verified: ${handbookPages.length} concise pages + ${deepDivePages.length} deep-dive pages, ${headingCount} headings, ${codeBlockCount} code blocks.`)

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true })
  const output = []
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) output.push(...await listFiles(path.join(directory, entry.name), relative))
    else if (entry.isFile()) output.push(relative)
  }
  return output
}

function scanMarkdown(markdown, source) {
  const headings = []
  const prose = []
  let codeBlocks = 0
  let fence
  const lines = markdown.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (marker) {
      if (!fence) {
        fence = { character: marker[1][0], length: marker[1].length, line: index + 1 }
        codeBlocks++
      } else if (marker[1][0] === fence.character && marker[1].length >= fence.length && marker[2].trim() === "") {
        fence = undefined
      }
      continue
    }
    if (fence) continue
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/)
    if (heading) headings.push({ level: heading[1].length, text: heading[2], line: index + 1 })
    prose.push({ text: line, line: index + 1 })
  }
  assert(!fence, `${source} has an unclosed code fence starting at line ${fence?.line}`)
  return { headings, prose, codeBlocks }
}

function withoutInlineCode(line) {
  return line.replace(/(`+)(.*?)\1/g, "")
}

function inventoryError(expected, actual) {
  const missing = expected.filter((file) => !actual.includes(file))
  const extra = actual.filter((file) => !expected.includes(file))
  return `Canonical page inventory differs from handbook.ts. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`
}

function assert(condition, message) {
  if (!condition) {
    console.error(`Handbook verification failed: ${message}`)
    process.exit(1)
  }
}
