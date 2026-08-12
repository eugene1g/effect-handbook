#!/usr/bin/env node

import { execFile } from "node:child_process"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { fetchPackument, resolveRelease } from "../.agents/skills/refresh-effect-handbook/scripts/resolve-latest-effect.ts"
import { handbookRelease } from "../handbook.ts"

const exec = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const referenceRoot = path.join(root, ".reference")
const upstream = "https://github.com/Effect-TS/effect.git"

export function checkoutDirectoryName(version) {
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) {
    throw new Error(`Refusing unsafe Effect version in checkout path: ${version}`)
  }
  return `effect-ci-${version.replaceAll("+", "-")}`
}

export function releaseProblems(resolved, documented, sourceCommit) {
  const problems = []
  if (resolved.deprecated !== null && resolved.deprecated !== undefined) {
    problems.push(`highest published Effect v4 ${resolved.version} is deprecated: ${resolved.deprecated}`)
  }
  if (resolved.version !== documented.version) {
    problems.push(`handbook targets ${documented.version}, but the highest published Effect v4 is ${resolved.version}`)
  }
  if (resolved.gitTag !== undefined && resolved.gitTag !== documented.tag) {
    problems.push(`handbook records tag ${documented.tag}, but npm metadata resolves ${resolved.gitTag}`)
  }
  if (resolved.npmPublishedAt !== undefined && resolved.npmPublishedAt !== documented.publishedAt) {
    problems.push(`handbook records publication time ${documented.publishedAt}, but npm reports ${resolved.npmPublishedAt}`)
  }
  if (sourceCommit !== undefined && sourceCommit !== documented.commit) {
    problems.push(`handbook records source commit ${documented.commit}, but tag ${resolved.gitTag} resolves to ${sourceCommit}`)
  }
  if (resolved.gitHead !== null && resolved.gitHead !== undefined && sourceCommit !== undefined && resolved.gitHead !== sourceCommit) {
    problems.push(`npm gitHead ${resolved.gitHead} does not match tagged source commit ${sourceCommit}`)
  }
  return problems
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

async function run(command, args, options = {}) {
  const result = await exec(command, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    maxBuffer: 16 * 1024 * 1024
  })
  if (options.echo !== false) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  return result
}

async function acquireTag(resolved) {
  await mkdir(referenceRoot, { recursive: true })
  const checkout = path.join(referenceRoot, checkoutDirectoryName(resolved.version))
  if (!await exists(checkout)) {
    await run("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "--depth=1",
      "--single-branch",
      "--branch", resolved.gitTag,
      upstream,
      checkout
    ])
    await run("git", ["-C", checkout, "checkout", "--detach", resolved.gitTag])
  }

  if (!await exists(path.join(checkout, ".git"))) {
    throw new Error(`${checkout} already exists but is not an Effect Git checkout; it was left untouched`)
  }
  const [{ stdout: commit }, { stdout: tags }, { stdout: status }, packageSource] = await Promise.all([
    run("git", ["-C", checkout, "rev-parse", "HEAD"], { echo: false }),
    run("git", ["-C", checkout, "tag", "--points-at", "HEAD"], { echo: false }),
    run("git", ["-C", checkout, "status", "--porcelain"], { echo: false }),
    readFile(path.join(checkout, "packages/effect/package.json"), "utf8")
  ])
  const packageJson = JSON.parse(packageSource)
  if (!tags.trim().split("\n").includes(resolved.gitTag)) {
    throw new Error(`${checkout} is at ${commit.trim()}, not tag ${resolved.gitTag}; it was left untouched`)
  }
  if (status.trim() !== "") {
    throw new Error(`${checkout} has local changes; the public-surface audit requires a clean tagged checkout`)
  }
  if (packageJson.version !== resolved.version) {
    throw new Error(`${checkout} contains effect@${packageJson.version}, expected ${resolved.version}`)
  }
  return { checkout, commit: commit.trim() }
}

async function main() {
  const resolved = resolveRelease(await fetchPackument())
  await mkdir(referenceRoot, { recursive: true })
  await writeFile(
    path.join(referenceRoot, "latest-effect-v4-resolution.json"),
    `${JSON.stringify(resolved, null, 2)}\n`
  )
  console.log(`Resolved highest published Effect v4: ${resolved.version} (${resolved.gitTag})`)

  const source = await acquireTag(resolved)
  console.log(`Auditing tagged source ${source.commit} at ${path.relative(root, source.checkout)}`)

  let coverageFailure
  try {
    await run(process.execPath, [
      path.join(root, ".agents/skills/refresh-effect-handbook/scripts/audit-source-coverage.ts"),
      "--docs", path.join(root, "docs"),
      "--manifest", path.join(root, "handbook.ts"),
      "--effect", source.checkout,
      "--json", path.join(referenceRoot, `handbook-coverage-${resolved.version}.json`)
    ])
  } catch (error) {
    coverageFailure = error
    if (error?.stdout) process.stdout.write(error.stdout)
    if (error?.stderr) process.stderr.write(error.stderr)
  }

  const problems = releaseProblems(resolved, handbookRelease, source.commit)
  if (coverageFailure) problems.push("the public module/package coverage audit failed")
  if (problems.length > 0) {
    throw new Error([
      ...problems,
      "Run the refresh-effect-handbook procedure for the full changelog, PR, implementation, and release-delta audit."
    ].join("\n"), { cause: coverageFailure })
  }
  console.log(`Handbook release and public-surface coverage are current at effect@${resolved.version}.`)
}

const invokedPath = process.argv[1]
if (invokedPath && fileURLToPath(import.meta.url) === path.resolve(invokedPath)) {
  main().catch((error) => {
    console.error(`audit-latest-effect: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
