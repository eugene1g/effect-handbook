#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises"
import { execFile } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { officialEffectLinks, sitePages } from "../handbook.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const exec = promisify(execFile)
// url -> set of places it appears, so a failure names what to fix.
const urls = new Map<string, Set<string>>()
// Placeholder and local hosts used in prose examples, never published links.
const ignoredHosts = new Set(["localhost", "127.0.0.1", "example.com", "example.github.io", "registry.example", "handbook.invalid"])

function addUrl(url: string, source: string) {
  let hostname
  try {
    hostname = new URL(url).hostname
  } catch {
    throw new Error(`${source} contains an unparsable URL: ${url}`)
  }
  if (ignoredHosts.has(hostname) || hostname.endsWith(".example") || hostname.endsWith(".invalid")) return
  const sources = urls.get(url) ?? new Set<string>()
  sources.add(source)
  urls.set(url, sources)
}

// 1. Markdown links outside code fences: every canonical page, plus the
//    repository's own Markdown that ships to readers and agents.
const markdownSources = [
  ...sitePages.map((page) => path.join("docs", page.source)),
  "README.md",
  "validation/README.md",
  "evals/README.md",
  ...(await markdownFilesUnder(".agents"))
]
for (const source of markdownSources) {
  const markdown = await readFile(path.join(root, source), "utf8")
  let fence
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && marker[2].trim() === "") fence = undefined
      continue
    }
    if (fence) continue
    for (const match of line.matchAll(/\]\((https?:\/\/[^\s)>]+)(?:\s+[^)]*)?\)/g)) addUrl(match[1], source)
  }
  if (fence) throw new Error(`${source} has an unclosed code fence`)
}

// 2. Links the site chrome computes rather than authors in Markdown. The
//    release-pinned "Official Effect" menu is defined in handbook.ts so it can
//    be checked here without the site's dependencies; any other absolute URL
//    written literally in the VitePress config is picked up by step 3.
for (const item of officialEffectLinks) addUrl(item.link, "handbook.ts (officialEffectLinks)")

// 3. Literal URLs in the VitePress config and custom theme components.
for (const source of [".vitepress/config.ts", ...(await filesUnder(".vitepress/theme", /\.(vue|ts|css)$/))]) {
  const text = await readFile(path.join(root, source), "utf8")
  for (const match of text.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) {
    if (!match[0].includes("${")) addUrl(match[0], source)
  }
}

async function markdownFilesUnder(directory: string) {
  return filesUnder(directory, /\.md$/)
}

async function filesUnder(directory: string, pattern: RegExp): Promise<Array<string>> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort()
}

const queue = [...urls.keys()].sort()
const failures = []
let next = 0
const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
  while (next < queue.length) {
    const url = queue[next++]
    const result = await check(url)
    if (!result.ok) failures.push(result)
    else console.log(`PASS ${result.status} ${url}`)
  }
})
await Promise.all(workers)

if (failures.length) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.status ?? "network"} ${failure.url}: ${failure.message}`)
    console.error(`     linked from: ${[...(urls.get(failure.url) ?? [])].join(", ")}`)
  }
  console.error(`External-link check failed: ${failures.length} of ${queue.length} URLs were unavailable.`)
  process.exitCode = 1
} else {
  console.log(`External-link check passed: ${queue.length} unique URLs.`)
}

async function check(url) {
  let last
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          "accept": "text/html,text/plain;q=0.9,*/*;q=0.1",
          "range": "bytes=0-0",
          "user-agent": "Effect-4-Handbook-Link-Check/1.0"
        },
        signal: AbortSignal.timeout(20_000)
      })
      await response.body?.cancel()
      if (response.ok) return { ok: true, status: response.status, url }
      last = { ok: false, status: response.status, url, message: response.statusText || "HTTP error" }
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) return last
    } catch (error) {
      last = { ok: false, url, message: error instanceof Error ? error.message : String(error) }
    }
    if (attempt < 2) await delay(500 * (2 ** attempt))
  }
  // Node's fetch may negotiate HTTP/2 through a local network proxy that
  // refuses the stream even though the URL is healthy. GitHub HTML routes can
  // exhibit the same behavior with curl, so first verify the exact repository
  // object through GitHub's API. This still rejects a missing tag, file,
  // directory, commit, or repository rather than weakening the link contract.
  if (last?.status === undefined) {
    const apiUrl = githubApiUrl(url)
    if (apiUrl) {
      const apiResult = await curlStatus(apiUrl, [
        "--header", "Accept: application/vnd.github+json",
        "--header", "X-GitHub-Api-Version: 2022-11-28"
      ])
      if (apiResult.ok) return { ok: true, status: apiResult.status, url }
      if (apiResult.status !== undefined) return { ...apiResult, url }
    }

    const curlResult = await curlStatus(url, ["--head"])
    if (curlResult.ok) return { ok: true, status: curlResult.status, url }
    return { ...curlResult, url, message: `fetch and curl failed: ${curlResult.message}` }
  }
  return last
}

async function curlStatus(url, extraArguments = []) {
  try {
    const { stdout } = await exec("curl", [
      "--silent",
      "--show-error",
      "--location",
      "--http1.1",
      "--max-time", "20",
      "--user-agent", "Effect-4-Handbook-Link-Check/1.0",
      ...extraArguments,
      "--output", "/dev/null",
      "--write-out", "%{http_code}",
      url
    ])
    const status = Number(stdout.trim())
    if (status >= 200 && status < 400) return { ok: true, status }
    return { ok: false, status, message: `HTTP ${status}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function githubApiUrl(value) {
  const url = new URL(value)
  if (url.hostname !== "github.com") return undefined

  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
  if (parts.length < 2) return undefined
  const [owner, repository, kind, ref, ...resourceParts] = parts
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`

  if (kind === undefined) return base
  if (kind === "commit" && ref) return `${base}/commits/${encodeURIComponent(ref)}`
  if ((kind === "blob" || kind === "tree") && ref) {
    const resource = resourceParts.map(encodeURIComponent).join("/")
    return `${base}/contents/${resource}?ref=${encodeURIComponent(ref)}`
  }
  return undefined
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
