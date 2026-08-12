#!/usr/bin/env node

import { spawn } from "node:child_process"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

import { sitePages } from "../handbook.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const handbookPath = path.join(root, "dist/effect-4-handbook.html")
const handbookUrl = pathToFileURL(handbookPath).href
const expectedSources = sitePages.map((page) => page.source)
const expectedCodeBlocks = await countSourceCodeBlocks()
const browserPath = await findBrowser()

await access(handbookPath)

const profile = await mkdtemp(path.join(os.tmpdir(), "effect-handbook-standalone-chrome-"))
const browser = spawn(browserPath, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-default-apps",
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
  const targets = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
    .then(expectOk)
    .then((response) => response.json())
  const page = targets.find((target) => target.type === "page")
  assert(page, "Chrome did not expose a page target")

  const cdp = await connectCdp(page.webSocketDebuggerUrl)
  const browserErrors = []
  cdp.on("Runtime.exceptionThrown", (event) => {
    browserErrors.push(event.exceptionDetails?.text ?? "Browser exception")
  })
  cdp.on("Log.entryAdded", (event) => {
    if (event.entry?.level === "error") browserErrors.push(event.entry.text)
  })
  await cdp.call("Page.enable")
  await cdp.call("Runtime.enable")
  await cdp.call("Log.enable")

  await setViewport(cdp, 1440, 1000, false)
  await navigate(cdp, `${handbookUrl}#data-schema--schemaissue`)
  await waitForExpression(cdp, `(() => {
    const target = document.getElementById("data-schema--schemaissue")
    return document.readyState === "complete" &&
      target?.closest(".handbook-page")?.classList.contains("active") &&
      target.getBoundingClientRect().top >= 0 &&
      target.getBoundingClientRect().top <= 140
  })()`, "desktop deep link")

  const desktop = await evaluate(cdp, `(() => {
    const pages = [...document.querySelectorAll("section.handbook-page[data-page-source]")]
    const target = document.getElementById("data-schema--schemaissue")
    const sidebar = document.getElementById("sidebar")
    const mobileBar = document.querySelector(".mobile-bar")
    const dependencyElements = [...document.querySelectorAll(
      "script[src], link[rel~='stylesheet'][href], img[src]"
    )]
    const externalDependencies = dependencyElements
      .map((element) => element.getAttribute("src") || element.getAttribute("href"))
      .filter((reference) => reference && !reference.startsWith("data:"))
    return {
      protocol: location.protocol,
      sources: pages.map((page) => page.dataset.pageSource),
      activeSources: pages.filter((page) => page.classList.contains("active"))
        .map((page) => page.dataset.pageSource),
      hash: location.hash,
      targetTop: target && Math.round(target.getBoundingClientRect().top),
      sidebarDisplay: sidebar && getComputedStyle(sidebar).display,
      mobileBarDisplay: mobileBar && getComputedStyle(mobileBar).display,
      codeBlocks: document.querySelectorAll("#handbook-source pre > code").length,
      copyButtons: document.querySelectorAll(".copy-code").length,
      externalDependencies
    }
  })()`)
  assert(desktop.protocol === "file:", `Standalone handbook loaded over ${desktop.protocol}`)
  assert(
    JSON.stringify(desktop.sources) === JSON.stringify(expectedSources),
    inventoryDifference(desktop.sources, expectedSources)
  )
  assert(
    JSON.stringify(desktop.activeSources) === JSON.stringify(["data/schema.md"]),
    `Desktop active pages were ${desktop.activeSources.join(", ") || "none"}`
  )
  assert(desktop.hash === "#data-schema--schemaissue", `Desktop hash is ${desktop.hash}`)
  assert(
    desktop.targetTop >= 0 && desktop.targetTop <= 140,
    `Desktop deep-link target is at ${desktop.targetTop}px`
  )
  assert(desktop.sidebarDisplay !== "none", "Desktop sidebar is hidden")
  if (desktop.mobileBarDisplay !== null) {
    assert(desktop.mobileBarDisplay === "none", `Desktop mobile bar display is ${desktop.mobileBarDisplay}`)
  }
  assert(
    desktop.codeBlocks === expectedCodeBlocks,
    `Standalone handbook rendered ${desktop.codeBlocks} code blocks; expected ${expectedCodeBlocks}`
  )
  assert(
    desktop.copyButtons === expectedCodeBlocks,
    `Standalone handbook rendered ${desktop.copyButtons} copy buttons; expected ${expectedCodeBlocks}`
  )
  assert(
    desktop.externalDependencies.length === 0,
    `Standalone handbook references external assets: ${desktop.externalDependencies.join(", ")}`
  )

  const navigationSnap = await evaluate(cdp, `new Promise((resolve) => {
    const link = document.querySelector(".nav-chapter:not(.active) .nav-chapter-link")
    const activePage = document.querySelector(".handbook-page.active")
    const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight)
    window.scrollTo({ top: Math.min(2400, maximum), behavior: "instant" })
    const before = Math.round(window.scrollY)
    const finish = () => requestAnimationFrame(() => resolve({
      before,
      after: Math.round(window.scrollY),
      activeSource: document.querySelector(".handbook-page.active")?.dataset.pageSource,
      targetSource: document.querySelector(link?.getAttribute("href"))?.dataset.pageSource,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      animationName: activePage && getComputedStyle(activePage).animationName
    }))
    if (!link) return resolve({ missing: true })
    window.addEventListener("hashchange", finish, { once: true })
    link.click()
  })`)
  assert(!navigationSnap.missing, "Standalone page navigation link is missing")
  assert(navigationSnap.before > 500, `Standalone snap test only scrolled to ${navigationSnap.before}px`)
  assert(navigationSnap.after <= 2, `Standalone page navigation retained ${navigationSnap.after}px of scroll`)
  assert(
    navigationSnap.activeSource === navigationSnap.targetSource,
    `Standalone navigation activated ${navigationSnap.activeSource}; expected ${navigationSnap.targetSource}`
  )
  assert(navigationSnap.scrollBehavior === "auto", `Standalone root scroll behavior is ${navigationSnap.scrollBehavior}`)
  assert(navigationSnap.animationName === "none", `Standalone page animation is ${navigationSnap.animationName}`)

  const search = await evaluate(cdp, `(() => {
    const input = document.getElementById("handbook-search")
    if (!input) return { missing: true }
    input.value = "SchemaIssue"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    const results = [...document.querySelectorAll(".search-result")]
    return {
      missing: false,
      open: document.getElementById("search-results")?.classList.contains("open"),
      count: results.length,
      titles: results.slice(0, 8).map((result) => result.querySelector("strong")?.textContent.trim())
    }
  })()`)
  assert(!search.missing, "Standalone search input is missing")
  assert(search.open && search.count > 0, "Standalone search produced no open result list")
  assert(search.titles.includes("SchemaIssue"), `Search titles were ${search.titles.join(", ")}`)

  const aliasSearch = await evaluate(cdp, `(() => {
    const input = document.getElementById("handbook-search")
    input.value = "mutex"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    return [...document.querySelectorAll(".search-result strong")].map((title) => title.textContent.trim())
  })()`)
  assert(aliasSearch.includes("Semaphore"), `Capability alias search titles were ${aliasSearch.join(", ")}`)
  for (const [query, expected] of [
    ["promise cell", "Deferred"],
    ["data loader", "RequestResolver"],
    ["background refresh", "Resource"],
    ["dependency injection", "Context"],
    ["actor", "Entity"],
    ["cron job", "Cron"]
  ]) {
    const titles = await evaluate(cdp, `(() => {
      const input = document.getElementById("handbook-search")
      input.value = ${JSON.stringify(query)}
      input.dispatchEvent(new Event("input", { bubbles: true }))
      return [...document.querySelectorAll(".search-result strong")].map((title) => title.textContent.trim())
    })()`)
    assert(titles.includes(expected), `Standalone capability search ${query} returned ${titles.join(", ")}; expected ${expected}`)
  }

  const theme = await evaluate(cdp, `(() => {
    const button = document.querySelector(".theme-toggle")
    if (!button) return { missing: true }
    const before = document.documentElement.dataset.theme
    button.click()
    const afterFirst = document.documentElement.dataset.theme
    button.click()
    return { missing: false, before, afterFirst, afterSecond: document.documentElement.dataset.theme }
  })()`)
  assert(!theme.missing, "Standalone theme toggle is missing")
  assert(theme.afterFirst !== theme.before, `Theme did not change from ${theme.before}`)
  assert(theme.afterSecond === theme.before, `Theme did not return to ${theme.before}`)

  if (expectedCodeBlocks > 0) {
    await evaluate(cdp, `document.querySelector(".copy-code").click()`)
    await waitForExpression(
      cdp,
      `document.querySelector(".copy-code")?.textContent.trim() === "Copied"`,
      "code copy confirmation"
    )
  }

  await setViewport(cdp, 390, 844, true)
  await navigate(cdp, `${handbookUrl}#interfaces-http-api--httpapi`)
  await waitForExpression(cdp, `(() => {
    const target = document.getElementById("interfaces-http-api--httpapi")
    return document.readyState === "complete" &&
      target?.closest(".handbook-page")?.classList.contains("active")
  })()`, "mobile deep link")

  const mobileBefore = await evaluate(cdp, `(() => {
    const sidebar = document.getElementById("sidebar")
    const mobileBar = document.querySelector(".mobile-bar")
    return {
      activeSource: document.querySelector(".handbook-page.active")?.dataset.pageSource,
      targetTop: Math.round(document.getElementById("interfaces-http-api--httpapi").getBoundingClientRect().top),
      mobileBarDisplay: mobileBar && getComputedStyle(mobileBar).display,
      sidebarPosition: sidebar && getComputedStyle(sidebar).position,
      navigationOpen: document.body.classList.contains("navigation-open"),
      viewportWidth: innerWidth
    }
  })()`)
  assert(mobileBefore.activeSource === "interfaces/http-api.md", `Mobile activated ${mobileBefore.activeSource}`)
  assert(mobileBefore.viewportWidth === 390, `Mobile viewport width is ${mobileBefore.viewportWidth}`)
  if (mobileBefore.mobileBarDisplay !== null) {
    assert(mobileBefore.mobileBarDisplay !== "none", "Mobile bar is hidden")
  }
  assert(mobileBefore.sidebarPosition === "fixed", `Mobile sidebar position is ${mobileBefore.sidebarPosition}`)
  assert(!mobileBefore.navigationOpen, "Mobile navigation started open")

  await evaluate(cdp, `document.getElementById("open-navigation")?.click()`)
  await waitForExpression(
    cdp,
    `document.body.classList.contains("navigation-open") &&
      document.getElementById("sidebar").getBoundingClientRect().left >= -3`,
    "mobile drawer open"
  )
  const mobileOpen = await evaluate(cdp, `(() => ({
    sidebarLeft: Math.round(document.getElementById("sidebar").getBoundingClientRect().left),
    scrimDisplay: getComputedStyle(document.getElementById("scrim")).display
  }))()`)
  assert(mobileOpen.sidebarLeft >= -3, `Open sidebar left edge is ${mobileOpen.sidebarLeft}px`)
  assert(mobileOpen.scrimDisplay !== "none", "Mobile drawer scrim is hidden")

  await evaluate(cdp, `document.getElementById("scrim")?.click()`)
  await waitForExpression(
    cdp,
    `!document.body.classList.contains("navigation-open")`,
    "mobile drawer close"
  )

  assert(browserErrors.length === 0, `Browser console errors: ${browserErrors.join(" | ")}`)
  cdp.close()
  console.log(
    `Standalone browser smoke passed over file://: ${sitePages.length} pages, ` +
    `${expectedCodeBlocks} code blocks, deep links, search, theme, copy, and mobile drawer.`
  )
  console.log("Standalone HTML has no external script, stylesheet, or image dependencies and no browser errors.")
} finally {
  await stop(browser)
  await rm(profile, { recursive: true, force: true })
}

async function countSourceCodeBlocks() {
  let total = 0
  for (const page of sitePages) {
    const markdown = await readFile(path.join(root, "docs", page.source), "utf8")
    let fence
    for (const line of markdown.split("\n")) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (!marker) continue
      if (!fence) {
        fence = { character: marker[1][0], length: marker[1].length }
        total++
      } else if (
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        marker[2].trim() === ""
      ) {
        fence = undefined
      }
    }
    assert(!fence, `${page.source} has an unclosed code fence`)
  }
  return total
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

async function setViewport(cdp, width, height, mobile) {
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile
  })
}

async function navigate(cdp, url) {
  await cdp.call("Page.navigate", { url })
  await waitForExpression(cdp, `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`, url)
  await delay(100)
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
  const response = await cdp.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  }
  return response.result.value
}

async function stop(child) {
  if (child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once("exit", resolve))
  child.kill("SIGTERM")
  await Promise.race([exited, delay(2_000)])
  if (child.exitCode === null) child.kill("SIGKILL")
}

function inventoryDifference(actual, expected) {
  const missing = expected.filter((source) => !actual.includes(source))
  const extra = actual.filter((source) => !expected.includes(source))
  return `Unexpected standalone page inventory. Missing: ${missing.join(", ") || "none"}. ` +
    `Extra: ${extra.join(", ") || "none"}.`
}

function expectOk(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${response.url}`)
  return response
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
