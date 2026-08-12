#!/usr/bin/env node

import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const packageName = "effect"
const registryUrl = "https://registry.npmjs.org"
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parseSemver(version) {
  const match = semverPattern.exec(version)
  if (!match) return undefined
  return {
    raw: version,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4]?.split(".").map((raw) => ({ raw, numeric: /^\d+$/.test(raw) })) ?? []
  }
}

export function compareSemver(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] < right[key]) return -1
    if (left[key] > right[key]) return 1
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1
  if (right.prerelease.length === 0) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index++) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (!leftPart) return -1
    if (!rightPart) return 1
    if (leftPart.numeric && rightPart.numeric) {
      const leftNumber = BigInt(leftPart.raw)
      const rightNumber = BigInt(rightPart.raw)
      if (leftNumber < rightNumber) return -1
      if (leftNumber > rightNumber) return 1
    } else if (leftPart.numeric !== rightPart.numeric) {
      return leftPart.numeric ? -1 : 1
    } else if (leftPart.raw !== rightPart.raw) {
      return leftPart.raw < rightPart.raw ? -1 : 1
    }
  }
  return 0
}

export function resolveRelease(packument, { major = 4, stableOnly = false } = {}) {
  if (!Number.isSafeInteger(major) || major < 0) throw new Error(`Invalid major: ${major}`)
  if (!isRecord(packument) || !isRecord(packument.versions)) {
    throw new Error("npm packument does not contain a versions object")
  }

  const publicationTimes = isRecord(packument.time) ? packument.time : {}
  const eligible = []

  for (const [version, metadata] of Object.entries(packument.versions)) {
    const parsed = parseSemver(version)
    if (parsed?.major !== BigInt(major) || !isRecord(metadata)) continue
    eligible.push({ version, metadata, parsed })
  }

  const candidates = stableOnly
    ? eligible.filter((entry) => entry.parsed.prerelease.length === 0)
    : eligible
  if (candidates.length === 0) {
    throw new Error(`No published effect major ${major}${stableOnly ? " stable" : ""} versions found`)
  }

  const selected = newest(candidates, publicationTimes)
  const stable = newest(eligible.filter((entry) => entry.parsed.prerelease.length === 0), publicationTimes)
  const prerelease = newest(eligible.filter((entry) => entry.parsed.prerelease.length > 0), publicationTimes)
  const npmPublishedAt = publicationTimes[selected.version]
  if (typeof npmPublishedAt !== "string" || !Number.isFinite(Date.parse(npmPublishedAt))) {
    throw new Error(`npm packument has no valid publication time for ${selected.version}`)
  }

  const allDistTags = Object.fromEntries(
    Object.entries(isRecord(packument["dist-tags"]) ? packument["dist-tags"] : {})
      .filter((entry) => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right))
  )
  const matchingDistTags = Object.entries(allDistTags)
    .filter(([, version]) => version === selected.version)
    .map(([tag]) => tag)

  return {
    package: typeof packument.name === "string" ? packument.name : packageName,
    requestedMajor: major,
    channel: stableOnly ? "stable-only" : "all-published",
    selection: `highest published SemVer for major ${major}; dist-tags are informational`,
    version: selected.version,
    npmPublishedAt,
    gitTag: `effect@${selected.version}`,
    gitHead: typeof selected.metadata.gitHead === "string" ? selected.metadata.gitHead : null,
    deprecated: selected.metadata.deprecated ?? null,
    matchingDistTags,
    tarball: selected.metadata.dist?.tarball ?? null,
    integrity: selected.metadata.dist?.integrity ?? null,
    latestStable: stable?.version ?? null,
    latestPrerelease: prerelease?.version ?? null,
    allDistTags
  }
}

export async function fetchPackument({ timeoutMs = 30_000 } = {}) {
  const response = await fetch(`${registryUrl}/${encodeURIComponent(packageName)}`, {
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
      "user-agent": "effect-handbook-release-resolver/1.0"
    },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) throw new Error(`npm registry returned ${response.status} ${response.statusText}`)
  return response.json()
}

function newest(candidates, publicationTimes) {
  return candidates.reduce((winner, candidate) => {
    if (!winner) return candidate
    const precedence = compareSemver(candidate.parsed, winner.parsed)
    if (precedence !== 0) return precedence > 0 ? candidate : winner

    // Build metadata does not affect SemVer precedence. Resolve that rare tie
    // by publication time, then raw version, so selection stays deterministic.
    const candidateTime = Date.parse(publicationTimes[candidate.version] ?? "")
    const winnerTime = Date.parse(publicationTimes[winner.version] ?? "")
    const candidateHasTime = Number.isFinite(candidateTime)
    const winnerHasTime = Number.isFinite(winnerTime)
    if (candidateHasTime !== winnerHasTime) return candidateHasTime ? candidate : winner
    if (candidateHasTime && candidateTime !== winnerTime) {
      return candidateTime > winnerTime ? candidate : winner
    }
    return candidate.version > winner.version ? candidate : winner
  }, undefined)
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseArgs(argv) {
  const options = { major: 4, stableOnly: false, json: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === "--major") {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error("--major requires a value")
      options.major = Number(value)
    } else if (argument === "--stable-only") {
      options.stableOnly = true
    } else if (argument === "--json") {
      options.json = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const result = resolveRelease(await fetchPackument(), options)
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`effect ${result.version}`)
  console.log(`published: ${result.npmPublishedAt}`)
  console.log(`git tag: ${result.gitTag}`)
  console.log(`gitHead: ${result.gitHead ?? "not published"}`)
  console.log(`deprecated: ${result.deprecated ?? "no"}`)
  console.log(`dist-tags: ${result.matchingDistTags.join(", ") || "none"}`)
  console.log(`latest stable: ${result.latestStable ?? "none"}`)
  console.log(`latest prerelease: ${result.latestPrerelease ?? "none"}`)
}

const invokedPath = process.argv[1]
if (invokedPath && fileURLToPath(import.meta.url) === path.resolve(invokedPath)) {
  main().catch((error) => {
    console.error(`resolve-latest-effect: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
