import { spawn } from "node:child_process"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const base = normalizeBase(option("--base") ?? process.env.VITEPRESS_BASE ?? "/")
const expectedDeepDiveCodeBlocks = countCodeBlocks(await readFile(
  path.join(root, "docs/deep-dives/reactivity-from-atoms-to-mastery.md"),
  "utf8"
))
const browserPath = await findBrowser()
const server = await startServer(path.join(root, "dist"), base)
const port = server.address().port
const origin = `http://127.0.0.1:${port}`
const profile = await mkdtemp(path.join(os.tmpdir(), "effect-handbook-chrome-"))

const browser = spawn(browserPath, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--no-first-run",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] })
let browserStderr = ""
browser.stderr.setEncoding("utf8")
browser.stderr.on("data", (chunk) => {
  browserStderr = `${browserStderr}${chunk}`.slice(-8_000)
})

try {
  const debuggingPort = await waitForDebuggingPort(profile)
  const targets = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`).then(expectOk).then((response) => response.json())
  const page = targets.find((target) => target.type === "page")
  assert(page, "Chrome did not expose a page target")

  const cdp = await connectCdp(page.webSocketDebuggerUrl)
  const browserErrors = []
  cdp.on("Runtime.exceptionThrown", (event) => browserErrors.push(event.exceptionDetails?.text ?? "Browser exception"))
  cdp.on("Log.entryAdded", (event) => {
    if (event.entry?.level === "error") browserErrors.push(event.entry.text)
  })
  await cdp.call("Page.enable")
  await cdp.call("Runtime.enable")
  await cdp.call("Log.enable")

  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  })
  await navigate(cdp, `${origin}${base}data/schema#schemaissue`)
  const desktop = await evaluate(cdp, `(() => {
    const target = document.getElementById("schemaissue")
    const agentLink = [...document.querySelectorAll("a")]
      .find((link) => link.textContent.trim() === "Concise handbook .md")
    const toolbar = document.querySelector(".markdown-toolbar")
    return {
      title: document.querySelector("main h1")?.textContent.trim(),
      targetTop: target && Math.round(target.getBoundingClientRect().top),
      sidebar: getComputedStyle(document.querySelector(".VPSidebar")).display,
      agentHref: agentLink?.getAttribute("href"),
      rawHref: toolbar?.querySelector("a")?.getAttribute("href"),
      copyText: toolbar?.querySelector("button")?.textContent.trim()
    }
  })()`)
  assert(desktop.title?.startsWith("Schema"), `Unexpected desktop page title: ${desktop.title}`)
  assert(desktop.targetTop >= 55 && desktop.targetTop <= 140, `SchemaIssue deep-link target is at ${desktop.targetTop}px`)
  assert(desktop.sidebar !== "none", "Desktop sidebar is hidden")
  assert(desktop.agentHref === `${base}effect-4-handbook.md`, `Agent download points to ${desktop.agentHref}`)
  assert(desktop.rawHref === `${base}data/schema.md`, `Schema raw link points to ${desktop.rawHref}`)
  assert(desktop.copyText === "Copy Markdown", `Schema copy button says ${desktop.copyText}`)

  const bundleStart = await evaluate(cdp, `fetch(${JSON.stringify(`${base}effect-4-handbook.md`)})
    .then((response) => response.text())
    .then((text) => text.slice(0, 80))`)
  assert(bundleStart.startsWith("<!-- Generated"), "Agent Markdown download did not return the generated bundle")

  const expectedSchema = await readFile(path.join(root, "docs/data/schema.md"), "utf8")
  const rawSchema = await evaluate(cdp, `fetch(${JSON.stringify(`${base}data/schema.md`)}).then((response) => response.text())`)
  assert(rawSchema === expectedSchema, "Published Schema Markdown differs from its canonical source")

  await evaluate(cdp, `(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => { window.__copiedMarkdown = text } }
    })
    document.querySelector(".markdown-toolbar button").click()
  })()`)
  await waitForExpression(cdp, `document.querySelector(".markdown-toolbar [role='status']")?.textContent.trim().length > 0`, "Markdown copy result")
  const copyStatus = await evaluate(cdp, `document.querySelector(".markdown-toolbar [role='status']")?.textContent.trim()`)
  assert(copyStatus === "Markdown copied to the clipboard.", `Markdown copy reported: ${copyStatus}`)
  assert(await evaluate(cdp, `window.__copiedMarkdown`) === expectedSchema, "Copy Markdown did not write the exact canonical source")

  await evaluate(cdp, `document.querySelector(".VPNavBarSearchButton").click()`)
  await waitForExpression(cdp, `!!document.querySelector(".VPLocalSearchBox input")`, "search dialog")
  await evaluate(cdp, `(() => {
    const input = document.querySelector(".VPLocalSearchBox input")
    input.value = "SchemaIssue"
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })()`)
  await waitForExpression(cdp, `document.querySelectorAll(".VPLocalSearchBox a").length > 0`, "search results")
  assert(await evaluate(cdp, `document.querySelector(".VPLocalSearchBox").textContent.includes("SchemaIssue")`), "Local search did not find SchemaIssue")
  await evaluate(cdp, `(() => {
    const input = document.querySelector(".VPLocalSearchBox input")
    input.value = "mutex"
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })()`)
  await waitForExpression(cdp, `document.querySelector(".VPLocalSearchBox")?.textContent.includes("Semaphore")`, "capability alias search")
  for (const [query, expected] of [
    ["promise cell", "Deferred"],
    ["data loader", "RequestResolver"],
    ["background refresh", "Resource"],
    ["dependency injection", "Context"],
    ["actor", "Entity"],
    ["cron job", "Cron"]
  ]) {
    await evaluate(cdp, `(() => {
      const input = document.querySelector(".VPLocalSearchBox input")
      input.value = ${JSON.stringify(query)}
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })()`)
    await waitForExpression(cdp, `document.querySelector(".VPLocalSearchBox")?.textContent.includes(${JSON.stringify(expected)})`, `capability search ${query}`)
  }
  await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`)

  await navigate(cdp, `${origin}${base}deep-dives/reactivity-from-atoms-to-mastery#atomregistry-the-runtime`)
  const deepDive = await evaluate(cdp, `({
    title: document.querySelector("main h1")?.textContent.trim(),
    codeBlocks: document.querySelectorAll("main .vp-doc div[class^='language-'], main .vp-doc div[class*=' language-']").length,
    target: !!document.getElementById("atomregistry-the-runtime")
  })`)
  assert(deepDive.title?.includes("From Atoms to Mastery"), `Unexpected deep-dive title: ${deepDive.title}`)
  assert(deepDive.codeBlocks === expectedDeepDiveCodeBlocks, `Reactivity deep dive rendered ${deepDive.codeBlocks} code blocks; expected ${expectedDeepDiveCodeBlocks}`)
  assert(deepDive.target, "Reactivity deep-dive fragment did not render")

  const wasDark = await evaluate(cdp, `document.documentElement.classList.contains("dark")`)
  await evaluate(cdp, `document.querySelector(".VPSwitchAppearance").click()`)
  await delay(75)
  assert(wasDark !== await evaluate(cdp, `document.documentElement.classList.contains("dark")`), "Appearance switch did not toggle")

  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  })
  await navigate(cdp, `${origin}${base}interfaces/http-api`)
  assert((await evaluate(cdp, `document.querySelector("main h1")?.textContent.trim()`))?.startsWith("HttpApi"), "Mobile HttpApi page did not render")
  await evaluate(cdp, `document.querySelector(".VPNavBarHamburger").click()`)
  await waitForExpression(cdp, `document.querySelector(".VPNavBarHamburger").getAttribute("aria-expanded") === "true"`, "mobile drawer open")
  await evaluate(cdp, `document.querySelector(".VPNavBarHamburger").click()`)
  await waitForExpression(cdp, `document.querySelector(".VPNavBarHamburger").getAttribute("aria-expanded") === "false"`, "mobile drawer close")
  await delay(100)

  assert(browserErrors.length === 0, `Browser console errors: ${browserErrors.join(" | ")}`)
  cdp.close()
  console.log(`Browser smoke verified at base ${base}: handbook and deep-dive links, exact raw Markdown/copy, search, theme, concise download, mobile drawer, zero console errors.`)
} finally {
  await stop(browser)
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

async function navigate(cdp, url) {
  await cdp.call("Page.navigate", { url })
  await waitForExpression(cdp, `document.readyState === "complete" && !!document.querySelector(".VPDoc")`, url)
  await delay(250)
}

async function waitForDebuggingPort(directory) {
  const file = path.join(directory, "DevToolsActivePort")
  for (let attempt = 0; attempt < 1_200; attempt++) {
    if (browser.exitCode !== null) throw chromeError(`Chrome exited with code ${browser.exitCode} before exposing a debugging port`)
    try {
      const [port] = (await readFile(file, "utf8")).split(/\r?\n/)
      if (port) return port
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    await delay(25)
  }
  throw chromeError("Timed out after 30 seconds waiting for Chrome's debugging port")
}

async function waitForExpression(cdp, expression, label) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await evaluate(cdp, expression)) return
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function chromeError(message) {
  const diagnostics = browserStderr.trim()
  return new Error(diagnostics === "" ? message : `${message}\nChrome stderr:\n${diagnostics}`)
}

async function evaluate(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

async function connectCdp(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  const listeners = new Map()
  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(message.data)
    if (payload.id) {
      const request = pending.get(payload.id)
      pending.delete(payload.id)
      if (payload.error) request.reject(new Error(payload.error.message))
      else request.resolve(payload.result)
      return
    }
    for (const listener of listeners.get(payload.method) ?? []) listener(payload.params ?? {})
  })
  return {
    call(method, params = {}) {
      const id = ++nextId
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    close: () => socket.close(),
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener])
    }
  }
}

async function findBrowser() {
  const candidates = [
    process.env.HANDBOOK_CHROMIUM,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {}
  }
  throw new Error(`No Chrome/Chromium executable found. Set HANDBOOK_CHROMIUM. Tried: ${candidates.join(", ")}`)
}

async function startServer(distRoot, siteBase) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost")
      if (!url.pathname.startsWith(siteBase)) return send(response, 404, "Not found")
      let relative = decodeURIComponent(url.pathname.slice(siteBase.length))
      if (relative === "") relative = "index.html"
      else if (relative.endsWith("/")) relative += "index.html"
      else if (!path.posix.extname(relative)) relative += ".html"

      const target = path.resolve(distRoot, relative)
      const inside = path.relative(distRoot, target)
      if (inside.startsWith("..") || path.isAbsolute(inside)) return send(response, 404, "Not found")
      const contents = await readFile(target)
      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": contentType(target),
        "content-length": contents.length
      })
      response.end(request.method === "HEAD" ? undefined : contents)
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof URIError) return send(response, 404, "Not found")
      response.destroy(error)
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "text/plain;charset=utf-8" })
  response.end(body)
}

function contentType(file) {
  return ({
    ".css": "text/css;charset=utf-8",
    ".html": "text/html;charset=utf-8",
    ".js": "text/javascript;charset=utf-8",
    ".json": "application/json;charset=utf-8",
    ".md": "text/markdown;charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2"
  })[path.extname(file)] ?? "application/octet-stream"
}

async function stop(child) {
  if (child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once("exit", resolve))
  child.kill("SIGTERM")
  const stopped = await Promise.race([exited.then(() => true), delay(2_000).then(() => false)])
  if (stopped) return
  if (child.exitCode === null) child.kill("SIGKILL")
  await exited
}

function normalizeBase(input) {
  const trimmed = input.trim()
  if (trimmed === "" || trimmed === "/") return "/"
  const segments = trimmed.split("/").filter(Boolean)
  assert(!segments.some((segment) => segment === "." || segment === ".."), `Invalid base path: ${input}`)
  return `/${segments.join("/")}/`
}

function option(name) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--")
  const index = args.indexOf(name)
  if (index === -1) return undefined
  assert(args[index + 1], `${name} requires a value`)
  return args[index + 1]
}

function expectOk(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${response.url}`)
  return response
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function countCodeBlocks(markdown) {
  let count = 0
  let fence
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!marker) continue
    if (!fence) {
      fence = { character: marker[1][0], length: marker[1].length }
      count++
    } else if (marker[1][0] === fence.character && marker[1].length >= fence.length && marker[2].trim() === "") {
      fence = undefined
    }
  }
  assert(!fence, "Reactivity deep dive has an unclosed code fence")
  return count
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
