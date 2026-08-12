#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { sitePages } from "../handbook.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const exec = promisify(execFile)
const urls = new Set()

for (const page of sitePages) {
  const markdown = await readFile(path.join(root, "docs", page.source), "utf8")
  let fence
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && marker[2].trim() === "") fence = undefined
      continue
    }
    if (fence) continue
    for (const match of line.matchAll(/\]\((https?:\/\/[^\s)>]+)(?:\s+[^)]*)?\)/g)) urls.add(match[1])
  }
  if (fence) throw new Error(`${page.source} has an unclosed code fence`)
}

const queue = [...urls].sort()
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
  for (const failure of failures) console.error(`FAIL ${failure.status ?? "network"} ${failure.url}: ${failure.message}`)
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
