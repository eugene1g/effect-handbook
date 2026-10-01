#!/usr/bin/env node

/**
 * Assemble the multi-edition site.
 *
 * Runs as the last step of `pnpm docs:build`, once the root build of the
 * latest edition is in `dist/`. Inside an edition build (`HANDBOOK_VERSION`
 * set) it is a no-op, so the recursion stops after one level.
 *
 * For every edition in `versions.json` this script produces a complete,
 * independently verified build at `/<id>/`:
 *
 * - the latest edition is rebuilt from this checkout at `<root base><id>/`,
 *   so `/4.0/` keeps working after 4.1 becomes the root;
 * - every frozen edition is built from its git tag in a temporary worktree,
 *   with that tag's own dependencies, scripts, and verification.
 *
 * The results are moved into `dist/<id>/` next to the root build. Work
 * happens under the ignored `.versions/` directory and `dist/` is only
 * replaced at the end, so a failure leaves the root build untouched.
 */

import { spawnSync } from "node:child_process"
import { access, mkdir, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

import { assertVersionsMatchRelease, loadVersions, normalizeBasePath, normalizeUrl, versionsFilename } from "./versions.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const distRoot = path.join(root, "dist")
const workRoot = path.join(root, ".versions")

export async function buildVersions({
  base = process.env.VITEPRESS_BASE ?? "/",
  siteUrl = process.env.HANDBOOK_SITE_URL,
  only,
  manifestPath
} = {}) {
  const rootBase = normalizeBasePath(base)
  const rootSiteUrl = normalizeUrl(siteUrl)
  // An explicit manifest is a rehearsal aid (for example, treating the current
  // commit as a frozen edition to exercise the tag path); it is validated but
  // not required to agree with handbook.ts. The checked-in manifest must.
  const manifest = manifestPath ? loadVersions(path.resolve(manifestPath)) : assertVersionsMatchRelease(loadVersions())
  await assertFile(path.join(distRoot, "index.html"), "dist/index.html is missing; run `pnpm docs:build` for the root edition first")
  await assertFile(path.join(distRoot, versionsFilename), `dist/${versionsFilename} is missing; the root build predates edition support`)

  await rm(workRoot, { recursive: true, force: true })
  await mkdir(workRoot, { recursive: true })
  const assembled = path.join(workRoot, "site")
  await rename(distRoot, assembled)

  const built = []
  try {
    for (const entry of manifest.versions) {
      if (only && !only.includes(entry.id)) continue
      const editionBase = `${rootBase}${entry.id}/`
      const editionSiteUrl = rootSiteUrl ? `${rootSiteUrl}${entry.id}/` : ""
      const env = {
        ...process.env,
        VITEPRESS_BASE: editionBase,
        HANDBOOK_SITE_URL: editionSiteUrl,
        HANDBOOK_ROOT_BASE: rootBase,
        HANDBOOK_ROOT_SITE_URL: rootSiteUrl ?? "",
        HANDBOOK_VERSION: entry.id
      }
      const isLatest = entry.id === manifest.latest
      const tree = isLatest ? root : path.join(workRoot, "src", entry.id)

      console.log(`\n== Edition ${entry.id} (effect@${entry.effectVersion}, ${isLatest ? "latest, from this checkout" : `frozen, from ${entry.ref}`}) at ${editionBase}`)
      if (!isLatest) {
        await mkdir(path.dirname(tree), { recursive: true })
        run("git", ["worktree", "add", "--detach", tree, entry.ref], { cwd: root })
        run("pnpm", ["install", "--frozen-lockfile"], { cwd: tree })
      }
      try {
        run("pnpm", ["docs:build"], { cwd: tree, env })
        run("pnpm", ["docs:verify", "--", "--base", editionBase], { cwd: tree, env })
        const destination = path.join(assembled, entry.id)
        await rm(destination, { recursive: true, force: true })
        await rename(path.join(tree, "dist"), destination)
        built.push({ ...entry, base: editionBase, isLatest })
      } finally {
        if (!isLatest) run("git", ["worktree", "remove", "--force", tree], { cwd: root })
      }
    }
  } finally {
    // A failed latest-edition build leaves its own dist/ behind; the root
    // build in .versions/site is the one that must survive.
    await rm(distRoot, { recursive: true, force: true })
    await rename(assembled, distRoot)
  }

  const published = JSON.parse(await readFile(path.join(distRoot, versionsFilename), "utf8"))
  for (const entry of built) {
    // Older tags predate some artifacts; every edition must at least be a
    // browsable site with an agent index.
    for (const file of ["index.html", "llms.txt", "effect-4-handbook.md"]) {
      await assertFile(path.join(distRoot, entry.id, file), `Edition ${entry.id} is missing ${file}`)
    }
    if (!manifestPath && !published.editions.some((candidate) => candidate.id === entry.id)) throw new Error(`Root ${versionsFilename} does not list edition ${entry.id}`)
  }
  await rm(workRoot, { recursive: true, force: true })
  return { rootBase, rootSiteUrl, built }
}

function run(command, args, { cwd, env = process.env }) {
  console.log(`$ ${command} ${args.join(" ")}  (in ${path.relative(root, cwd) || "."})`)
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`)
}

async function assertFile(file, message) {
  try {
    await access(file)
  } catch {
    throw new Error(message)
  }
}

function option(name) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--")
  const index = args.indexOf(name)
  if (index === -1) return undefined
  if (!args[index + 1]) throw new Error(`${name} requires a value`)
  return args[index + 1]
}

async function main() {
  if (process.env.HANDBOOK_VERSION) {
    // `pnpm docs:build` ends with this script, and this script runs
    // `pnpm docs:build` for each edition: the nested run builds one edition
    // and must not recurse into assembling editions of its own.
    console.log(`Edition ${process.env.HANDBOOK_VERSION} build: skipping edition assembly inside an edition build.`)
    return
  }
  const only = option("--only")?.split(",").map((value) => value.trim()).filter(Boolean)
  const result = await buildVersions({
    base: option("--base") ?? process.env.VITEPRESS_BASE ?? "/",
    siteUrl: option("--site-url") ?? process.env.HANDBOOK_SITE_URL,
    only,
    manifestPath: option("--manifest")
  })
  console.log(`\nAssembled ${result.built.length} edition(s) under ${path.relative(root, distRoot)}/ at base ${result.rootBase}: ${result.built.map((entry) => `${entry.id}${entry.isLatest ? " (latest)" : ""} → ${entry.base}`).join(", ")}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
