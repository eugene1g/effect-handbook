import { readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { handbookRelease } from "../handbook.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const versionsSourcePath = path.join(root, "versions.json")
export const versionsFilename = "versions.json"

/**
 * The published editions of the handbook, one per Effect `major.minor`.
 *
 * `versions.json` at the repository root is the single source of truth: the
 * Pages workflow builds each edition into `/<id>/`, the site renders the
 * switcher and the "newer edition" banner from it, and the agent artifacts
 * route by it. The `latest` edition is built from the current checkout and
 * also served at the site root; every other edition is frozen and built from
 * the git tag named in `ref`.
 */
export function loadVersions(file = versionsSourcePath) {
  const parsed = JSON.parse(readFileSync(file, "utf8"))
  return validateVersions(parsed)
}

export function validateVersions(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("versions.json must be an object")
  if (manifest.schemaVersion !== 1) throw new Error("versions.json schemaVersion must be 1")
  if (!Array.isArray(manifest.versions) || manifest.versions.length === 0) throw new Error("versions.json must list at least one edition")
  const ids = new Set()
  for (const entry of manifest.versions) {
    if (typeof entry.id !== "string" || !/^\d+\.\d+$/.test(entry.id)) throw new Error(`Edition id must be major.minor, got ${JSON.stringify(entry.id)}`)
    if (ids.has(entry.id)) throw new Error(`Duplicate edition id ${entry.id}`)
    ids.add(entry.id)
    if (typeof entry.effectVersion !== "string" || !entry.effectVersion.startsWith(`${entry.id}.`)) {
      throw new Error(`Edition ${entry.id} must name an effectVersion inside that minor, got ${JSON.stringify(entry.effectVersion)}`)
    }
    if (typeof entry.auditedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.auditedAt)) throw new Error(`Edition ${entry.id} needs an auditedAt date`)
    if (entry.ref !== null && entry.ref !== undefined && (typeof entry.ref !== "string" || entry.ref.trim() === "")) {
      throw new Error(`Edition ${entry.id} has an invalid ref`)
    }
  }
  if (!ids.has(manifest.latest)) throw new Error(`versions.json latest ${JSON.stringify(manifest.latest)} is not a listed edition`)
  for (const entry of manifest.versions) {
    const isLatest = entry.id === manifest.latest
    if (isLatest && entry.ref) throw new Error(`The latest edition ${entry.id} is built from the checkout and must not name a ref`)
    if (!isLatest && !entry.ref) throw new Error(`Frozen edition ${entry.id} must name the git tag to build from`)
  }
  const sorted = [...manifest.versions].sort((left, right) => compareEditionIds(right.id, left.id))
  return { schemaVersion: 1, latest: manifest.latest, versions: sorted }
}

/** The latest edition must describe exactly the release the handbook is audited against. */
export function assertVersionsMatchRelease(manifest = loadVersions(), release = handbookRelease) {
  const latest = manifest.versions.find((entry) => entry.id === manifest.latest)
  if (latest.effectVersion !== release.version) {
    throw new Error(`versions.json latest edition ${latest.id} names effect ${latest.effectVersion}; handbook.ts is audited against ${release.version}`)
  }
  if (latest.auditedAt !== release.auditedAt) {
    throw new Error(`versions.json latest edition ${latest.id} is dated ${latest.auditedAt}; handbook.ts says ${release.auditedAt}`)
  }
  if (editionIdOf(release.version) !== latest.id) {
    throw new Error(`Edition id ${latest.id} does not match effect ${release.version}`)
  }
  return manifest
}

export function editionIdOf(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\./)
  if (!match) throw new Error(`Cannot derive an edition id from ${JSON.stringify(version)}`)
  return `${match[1]}.${match[2]}`
}

export function compareEditionIds(left, right) {
  const [leftMajor, leftMinor] = left.split(".").map(Number)
  const [rightMajor, rightMinor] = right.split(".").map(Number)
  return leftMajor - rightMajor || leftMinor - rightMinor
}

/**
 * Where this build sits in the published tree.
 *
 * - `rootBase` / `rootSiteUrl`: the base path and public URL of the site root
 *   (the latest edition). Defaults to the build's own base, which is right for
 *   a root build; the versions builder overrides them for `/<id>/` builds.
 * - `current`: the edition this build renders — by default the manifest's
 *   `latest`, which is also correct inside a frozen tag because that tag's own
 *   `versions.json` named itself latest when it was published.
 */
export function resolveEditionContext({
  base = process.env.VITEPRESS_BASE ?? "/",
  siteUrl = process.env.HANDBOOK_SITE_URL,
  rootBase = process.env.HANDBOOK_ROOT_BASE,
  rootSiteUrl = process.env.HANDBOOK_ROOT_SITE_URL,
  current = process.env.HANDBOOK_VERSION,
  manifest = loadVersions()
} = {}) {
  const normalizedBase = normalizeBasePath(base)
  const normalizedRootBase = normalizeBasePath(rootBase ?? normalizedBase)
  const normalizedSiteUrl = normalizeUrl(siteUrl)
  const normalizedRootSiteUrl = normalizeUrl(rootSiteUrl) ?? normalizedSiteUrl
  const currentId = current ?? manifest.latest
  if (!manifest.versions.some((entry) => entry.id === currentId)) {
    throw new Error(`HANDBOOK_VERSION ${JSON.stringify(currentId)} is not an edition in versions.json`)
  }
  return {
    manifest,
    current: currentId,
    latest: manifest.latest,
    base: normalizedBase,
    siteUrl: normalizedSiteUrl,
    rootBase: normalizedRootBase,
    rootSiteUrl: normalizedRootSiteUrl,
    editions: manifest.versions.map((entry) => ({
      ...entry,
      isLatest: entry.id === manifest.latest,
      isCurrent: entry.id === currentId,
      path: `${normalizedRootBase}${entry.id}/`,
      url: normalizedRootSiteUrl ? `${normalizedRootSiteUrl}${entry.id}/` : `${normalizedRootBase}${entry.id}/`
    }))
  }
}

/**
 * The `versions.json` published at the root of every build: the manifest plus
 * resolved URLs, so an agent can pick an edition without knowing the layout.
 */
export function renderPublishedVersions(context = resolveEditionContext()) {
  const rootUrl = context.rootSiteUrl ?? context.rootBase
  return `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "handbook-editions",
    title: "The Effect 4 Handbook",
    latest: context.latest,
    rootUrl,
    howToChoose: "Read the installed effect version (node_modules/effect/package.json) and open the edition whose id is that version's major.minor. The site root always serves the latest edition. If your minor is not listed, use the highest listed edition below it within the same major; editions of different majors are not interchangeable.",
    editions: context.editions.map((entry) => ({
      id: entry.id,
      effectVersion: entry.effectVersion,
      auditedAt: entry.auditedAt,
      status: entry.isLatest ? "latest" : "frozen",
      url: entry.url,
      llmsTxt: `${entry.url}llms.txt`,
      modulesIndex: `${entry.url}effect-4-modules.md`,
      catalog: `${entry.url}effect-4-catalog.json`,
      ...(entry.ref ? { gitRef: entry.ref } : {})
    }))
  }, null, 2)}\n`
}

export function normalizeBasePath(input) {
  const trimmed = String(input ?? "").trim()
  if (trimmed === "" || trimmed === "/") return "/"
  const segments = trimmed.split("/").filter(Boolean)
  if (segments.some((segment) => segment === "." || segment === "..")) throw new Error(`Invalid base path: ${JSON.stringify(input)}`)
  return `/${segments.join("/")}/`
}

export function normalizeUrl(input) {
  if (input === undefined || input === null || String(input).trim() === "") return undefined
  const url = new URL(String(input).trim())
  url.hash = ""
  url.search = ""
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url.href
}
