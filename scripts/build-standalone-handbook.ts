#!/usr/bin/env node

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createMarkdownRenderer, disposeMdItInstance } from "vitepress"

import { capabilities, siteGroups, sitePages, slugifyHeading } from "../handbook.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const docsRoot = path.join(root, "docs")
const outputPath = path.join(root, "dist/effect-4-handbook.html")
const templateDirectory = path.join(root, "scripts/standalone")

export async function buildStandaloneHandbook() {
  const [styles, clientScript, ...markdownSources] = await Promise.all([
    readFile(path.join(templateDirectory, "handbook.css"), "utf8"),
    readFile(path.join(templateDirectory, "handbook.js"), "utf8"),
    ...sitePages.map((page) => readFile(path.join(docsRoot, page.source), "utf8"))
  ])
  const sourceHash = digest(sitePages.map((page, index) =>
    `${page.source}\0${markdownSources[index]}\0`
  ).join(""))
  const records = sitePages.map((page, index) => ({
    ...page,
    group: siteGroups.find((group) => group.items.includes(page))?.text ?? "Handbook",
    index,
    key: pageKey(page),
    markdown: markdownSources[index]
  }))
  const recordsBySource = new Map(records.map((record) => [record.source, record]))
  for (const record of records) record.related = relatedRecords(record, recordsBySource)
  let current

  const renderer = await createMarkdownRenderer(docsRoot, {
    anchor: {
      slugify(value) {
        assert(current, "Markdown renderer has no active page")
        return `${current.key}--${slugifyHeading(value)}`
      }
    },
    image: { lazyLoad: true },
    languages: ["ts", "tsx", "bash", "json"],
    config(md) {
      const externalLinkOpen = md.renderer.rules.link_open ?? ((tokens, index, options, _env, self) =>
        self.renderToken(tokens, index, options))
      md.renderer.rules.link_open = (tokens, index, options, env, self) => {
        const token = tokens[index]
        const href = token.attrGet("href") ?? ""
        const classes = (token.attrGet("class") ?? "").split(/\s+/)
        if (classes.includes("header-anchor") || href.startsWith(`#${current.key}--`)) {
          return self.renderToken(tokens, index, options)
        }
        if (isExternalReference(href)) {
          return externalLinkOpen(tokens, index, options, env, self)
        }
        token.attrSet("href", standaloneReference(href, current, recordsBySource))
        return self.renderToken(tokens, index, options)
      }
    }
  }, "/", console, path.join(root, "public"))

  try {
    for (const record of records) {
      current = record
      const rendered = await renderer.renderAsync(record.markdown, {
        path: record.source,
        relativePath: record.source
      })
      record.html = rendered.replace(
        /<button title="Copy code" data-copied="Copied" class="copy"><\/button>/g,
        '<button type="button" title="Copy code" data-copied="Copied" class="copy-code">Copy</button>'
      )
      record.headings = renderedHeadings(record.html)
      const first = record.headings.find((heading) => heading.level === 1)
      assert(first?.title === record.title, `${record.source} rendered H1 ${JSON.stringify(first?.title)}`)
      record.modules = record.headings.filter((heading) => heading.level === 2)
    }
  } finally {
    current = undefined
    disposeMdItInstance()
  }

  const expected = await sourceStats(records)
  const renderedHeadingsCount = records.reduce((total, record) => total + record.headings.length, 0)
  const renderedCodeBlocks = records.reduce((total, record) =>
    total + (record.html.match(/<div class="language-[^"]+">/g)?.length ?? 0), 0)
  assert(renderedHeadingsCount === expected.headings,
    `Standalone renderer produced ${renderedHeadingsCount} headings for ${expected.headings} source headings`)
  assert(renderedCodeBlocks === expected.codeBlocks,
    `Standalone renderer produced ${renderedCodeBlocks} code blocks for ${expected.codeBlocks} source fences`)

  const navigation = renderNavigation(records)
  const pages = records.map((record) => renderPage(record, records)).join("\n")
  const markdownPayload = escapeInlineJson(JSON.stringify({
    sourceHash,
    pages: records.map(({ source, title, markdown, key }) => ({
      source,
      title,
      markdown,
      aliases: capabilities
        .filter((entry) => entry.page === source)
        .map((entry) => ({
          id: `${key}--${entry.anchor}`,
          text: [...entry.symbols, ...entry.imports.map((imported) => imported.path), ...entry.tasks, entry.summary, entry.chooseWhen, entry.avoidWhen].join(" · ")
        }))
    }))
  }))
  const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="The complete Effect 4 Handbook and deep dives in one offline file.">
  <meta name="handbook-source-sha256" content="${sourceHash}">
  <meta name="color-scheme" content="light dark">
  <title>The Effect 4 Handbook</title>
  <style>${styles.trimEnd()}</style>
</head>
<body>
  <a class="skip-link" href="#index">Skip to handbook</a>
  <div class="reading-progress ui-only" id="reading-progress"></div>
  <header class="mobile-bar ui-only">
    <button class="icon-button" id="open-navigation" type="button" aria-label="Open navigation"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    <div><strong>Effect 4 Handbook</strong><span>Complete offline edition</span></div>
    <button class="icon-button theme-toggle" type="button" aria-label="Toggle color theme"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16Z"/></svg></button>
  </header>
  <div class="scrim ui-only" id="scrim"></div>
  <div class="app-shell">
    <aside class="sidebar ui-only" id="sidebar" aria-label="Handbook navigation">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">E</div>
        <div><strong>Effect 4 Handbook</strong><span>Complete offline edition</span></div>
        <button class="icon-button theme-toggle" type="button" aria-label="Toggle color theme"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16Z"/></svg></button>
      </div>
      <div class="search-box">
        <span aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg></span>
        <input id="handbook-search" type="search" placeholder="Search every page" autocomplete="off" spellcheck="false" aria-label="Search handbook">
        <kbd>⌘K</kbd>
        <div class="search-results" id="search-results" role="listbox" aria-label="Search results"></div>
      </div>
      <div class="offline-actions">
        <button type="button" id="copy-all-markdown">Copy all Markdown</button>
        <button type="button" id="download-all-markdown">Download .md</button>
      </div>
      <nav class="navigation" id="navigation">${navigation}</nav>
    </aside>
    <main class="reader" id="reader">
      <article id="handbook-source">${pages}</article>
    </main>
  </div>
  <script type="application/json" id="handbook-markdown">${markdownPayload}</script>
  <script>${clientScript.trimEnd()}</script>
</body>
</html>
`

  verifyGeneratedHtml(html, records, expected, sourceHash)
  return { html, sourceHash, pages: records.length, ...expected }
}

function renderPage(record, records) {
  const previous = records[record.index - 1]
  const next = records[record.index + 1]
  return `<section id="${record.key}" class="handbook-page${record.index === 0 ? " active" : ""}" data-page-id="${record.key}" data-page-source="${escapeAttribute(record.source)}" data-page-title="${escapeAttribute(record.title)}" aria-hidden="${record.index === 0 ? "false" : "true"}">
  <div class="page-kicker ui-only"><span>${escapeHtml(record.group)}</span><span>Page ${record.index + 1} of ${records.length}</span><button type="button" class="copy-markdown" data-page-source="${escapeAttribute(record.source)}">Copy page Markdown</button></div>
  <div class="page-content">${record.html}</div>
  ${record.related.length ? `<aside class="standalone-related ui-only"><strong>Related topics</strong><ul>${record.related.map((item) => `<li><a href="#${item.key}">${escapeHtml(item.title)}</a></li>`).join("")}</ul></aside>` : ""}
  <nav class="page-footer ui-only" aria-label="Page navigation">
    ${previous ? `<a class="page-step previous" href="#${previous.key}"><span>Previous</span><strong>${escapeHtml(previous.title)}</strong></a>` : "<span></span>"}
    ${next ? `<a class="page-step next" href="#${next.key}"><span>Next</span><strong>${escapeHtml(next.title)}</strong></a>` : "<span></span>"}
  </nav>
</section>`
}

function relatedRecords(record, recordsBySource) {
  const scores = new Map()
  const add = (source, score) => {
    if (!source || source === record.source || !recordsBySource.has(source)) return
    scores.set(source, Math.max(score, scores.get(source) ?? 0))
  }
  const byId = new Map(capabilities.map((entry) => [entry.id, entry]))
  for (const target of record.related ?? []) add(target, 20)
  const owned = capabilities.filter((entry) => entry.page === record.source)
  for (const entry of owned) {
    for (const alternative of entry.alternatives) add(byId.get(alternative)?.page, 10)
    for (const peer of capabilities) if (peer.domain === entry.domain) add(peer.page, 4)
  }
  const group = siteGroups.find((candidate) => candidate.items.some((item) => item.source === record.source))
  const index = group?.items.findIndex((item) => item.source === record.source) ?? -1
  if (group && index >= 0) {
    add(group.items[index - 1]?.source, 2)
    add(group.items[index + 1]?.source, 2)
  }
  const globalIndex = sitePages.findIndex((item) => item.source === record.source)
  if (globalIndex >= 0) {
    add(sitePages[globalIndex - 1]?.source, 1)
    add(sitePages[globalIndex + 1]?.source, 1)
  }
  return [...scores]
    .sort(([leftSource, left], [rightSource, right]) => right - left || leftSource.localeCompare(rightSource))
    .slice(0, 5)
    .map(([source]) => recordsBySource.get(source))
}

function renderNavigation(records) {
  let number = 0
  return siteGroups.map((group) => `<div class="nav-group">
  <div class="nav-group-label">${escapeHtml(group.text)}</div>
  ${group.items.map((page) => {
    const record = records.find((candidate) => candidate.source === page.source)
    const pageNumber = String(number++).padStart(2, "0")
    return `<div class="nav-chapter${record.index === 0 ? " active expanded" : ""}" data-nav-page="${record.key}">
      <div class="nav-chapter-row">
        <a class="nav-chapter-link" href="#${record.key}"><span>${pageNumber}</span><strong>${escapeHtml(record.title)}</strong></a>
        ${record.modules.length ? `<button class="nav-toggle" type="button" aria-expanded="${record.index === 0 ? "true" : "false"}" aria-label="Toggle sections in ${escapeAttribute(record.title)}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5"/></svg></button>` : ""}
      </div>
      ${record.modules.length ? `<div class="nav-modules">${record.modules.map((heading) =>
        `<a class="nav-module-link" href="#${heading.id}" data-module-link="${heading.id}">${escapeHtml(heading.title)}</a>`
      ).join("")}</div>` : ""}
    </div>`
  }).join("\n")}
</div>`).join("\n")
}

function standaloneReference(href, current, recordsBySource) {
  const [withoutFragment, rawFragment = ""] = href.split("#", 2)
  const [rawPathname, query = ""] = withoutFragment.split("?", 2)
  assert(!query, `${current.source} has an unsupported local query link: ${href}`)
  let target = current
  if (rawPathname) {
    let normalized = rawPathname.startsWith("/")
      ? rawPathname.slice(1)
      : path.posix.normalize(path.posix.join(path.posix.dirname(current.source), rawPathname))
    if (normalized === "" || normalized === "." || normalized === "./") normalized = "index.md"
    const clean = normalized.replace(/\.html$/, "").replace(/\/$/, "")
    const candidates = [normalized, clean, `${clean}.md`, `${clean}/index.md`]
    target = candidates.map((candidate) => recordsBySource.get(candidate)).find(Boolean)
    assert(target, `${current.source} links to an unknown local page: ${href}`)
  }
  if (!rawFragment) return `#${target.key}`
  const fragment = slugifyHeading(safeDecodeURIComponent(rawFragment))
  return `#${target.key}--${fragment}`
}

function isExternalReference(href) {
  return href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)
}

function pageKey(page) {
  const source = page.source.replace(/\.md$/, "").replace(/\/index$/, "-index")
  return slugifyHeading(source)
}

function renderedHeadings(html) {
  return [...html.matchAll(/<h([1-6]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)].map((match) => ({
    level: Number(match[1]),
    id: decodeHtml(match[2]),
    title: decodeHtml(match[3].replace(/<a\b[\s\S]*?<\/a>/g, "").replace(/<[^>]+>/g, ""))
      .replace(/\u200b/g, "")
      .replace(/\s+/g, " ")
      .trim()
  }))
}

async function sourceStats(records) {
  let headings = 0
  let codeBlocks = 0
  for (const record of records) {
    let fence
    for (const line of record.markdown.split("\n")) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (marker) {
        if (!fence) {
          fence = { character: marker[1][0], length: marker[1].length }
          codeBlocks++
        } else if (marker[1][0] === fence.character && marker[1].length >= fence.length && marker[2].trim() === "") {
          fence = undefined
        }
        continue
      }
      if (!fence && /^#{1,6}\s+/.test(line)) headings++
    }
    assert(!fence, `${record.source} has an unclosed code fence`)
  }
  return { headings, codeBlocks }
}

function verifyGeneratedHtml(html, records, expected, sourceHash) {
  assert((html.match(/<section id="[^"]+" class="handbook-page/g)?.length ?? 0) === records.length,
    "Standalone HTML page inventory differs from the manifest")
  assert((html.match(/class="copy-code"/g)?.length ?? 0) === expected.codeBlocks,
    "Standalone HTML copy-button count differs from source fences")
  assert(html.includes(`<meta name="handbook-source-sha256" content="${sourceHash}">`),
    "Standalone HTML source hash metadata is missing")
  assert(!/<script\b[^>]+src=|<link\b[^>]+rel=["']stylesheet|<img\b[^>]+src=/i.test(html),
    "Standalone HTML contains an external runtime asset")
  const contentBeforeScripts = html.slice(0, html.indexOf('<script type="application/json"'))
  const ids = [...contentBeforeScripts.matchAll(/(?:^|\s)id="([^"]+)"/g)].map((match) => decodeHtml(match[1]))
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
  assert(duplicateIds.length === 0, `Standalone HTML contains duplicate IDs: ${duplicateIds.slice(0, 8).join(", ")}`)
  const idSet = new Set(ids)
  const internalLinks = [...contentBeforeScripts.matchAll(/<a\b[^>]*\bhref="#([^"]+)"/g)]
    .map((match) => safeDecodeURIComponent(decodeHtml(match[1])))
  const broken = [...new Set(internalLinks.filter((id) => !idSet.has(id)))]
  assert(broken.length === 0, `Standalone HTML contains broken internal links: ${broken.slice(0, 8).join(", ")}`)
}

function escapeInlineJson(value) {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
}

function decodeHtml(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: "\u00a0", quot: '"' }
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, body) => {
    if (body[0] !== "#") return named[body.toLowerCase()] ?? entity
    const hexadecimal = body[1].toLowerCase() === "x"
    const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
    return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : entity
  })
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, "&#39;")
}

export function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const result = await buildStandaloneHandbook()
  if (process.argv.slice(2).includes("--check")) {
    let actual
    try {
      actual = await readFile(outputPath, "utf8")
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    if (actual !== result.html) {
      console.error("The standalone handbook is missing or stale. Run `pnpm docs:build`.")
      process.exitCode = 1
      return
    }
    console.log(`Standalone HTML is current (${result.pages} pages, ${result.headings} headings, ${result.codeBlocks} code blocks, sha256 ${digest(actual)}).`)
    return
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  const temporaryPath = `${outputPath}.tmp-${process.pid}`
  try {
    await writeFile(temporaryPath, result.html)
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
  console.log(`Generated ${path.relative(root, outputPath)} from ${result.pages} pages (${result.headings} headings, ${result.codeBlocks} code blocks, sha256 ${digest(result.html)}).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
