import assert from "node:assert/strict"
import test from "node:test"

import { compareSemver, parseSemver, resolveRelease } from "./resolve-latest-effect.ts"

function packument(versions, { deprecated = [], distTags = {}, gitHeads = {} } = {}) {
  return {
    name: "effect",
    versions: Object.fromEntries(versions.map((version) => [version, {
      version,
      ...(deprecated.includes(version) ? { deprecated: "retired" } : {}),
      ...(gitHeads[version] ? { gitHead: gitHeads[version] } : {}),
      dist: { tarball: `https://registry.example/${version}.tgz`, integrity: `sha512-${version}` }
    }])),
    time: Object.fromEntries(versions.map((version, index) => [
      version,
      new Date(Date.UTC(2026, 0, index + 1)).toISOString()
    ])),
    "dist-tags": distTags
  }
}

test("implements SemVer prerelease precedence", () => {
  const ordered = [
    "4.0.0-alpha",
    "4.0.0-alpha.1",
    "4.0.0-alpha.beta",
    "4.0.0-beta",
    "4.0.0-beta.2",
    "4.0.0-beta.11",
    "4.0.0-rc.1",
    "4.0.0"
  ]
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(compareSemver(parseSemver(ordered[index - 1]), parseSemver(ordered[index])), -1)
  }
})

test("uses arbitrary-precision numeric identifiers", () => {
  assert.equal(compareSemver(
    parseSemver("4.0.0-beta.999999999999999999999999"),
    parseSemver("4.0.0-beta.1000000000000000000000000")
  ), -1)
})

test("breaks equal-precedence build metadata ties by publication time", () => {
  const result = resolveRelease(packument(["4.0.0+older", "4.0.0+newer"]))
  assert.equal(result.version, "4.0.0+newer")
})

test("selects the highest v4 SemVer independently of dist-tags", () => {
  const result = resolveRelease(packument(
    ["3.22.1", "4.0.0-beta.106", "4.0.0-beta.107", "5.0.0-alpha.1"],
    { distTags: { latest: "3.22.1", beta: "4.0.0-beta.106" } }
  ))
  assert.equal(result.version, "4.0.0-beta.107")
  assert.deepEqual(result.matchingDistTags, [])
})

test("prefers a stable release over a prerelease with the same core", () => {
  const result = resolveRelease(packument(["4.0.0-beta.107", "4.0.0-rc.1", "4.0.0"]))
  assert.equal(result.version, "4.0.0")
  assert.equal(result.latestStable, "4.0.0")
  assert.equal(result.latestPrerelease, "4.0.0-rc.1")
})

test("allows a higher-core prerelease to outrank a lower stable", () => {
  assert.equal(resolveRelease(packument(["4.0.9", "4.1.0-beta.1"])).version, "4.1.0-beta.1")
})

test("stable-only selects the latest stable lane", () => {
  assert.equal(resolveRelease(packument(["4.0.9", "4.1.0-beta.1"]), { stableOnly: true }).version, "4.0.9")
})

test("selects but flags a highest release that npm deprecates", () => {
  const result = resolveRelease(packument(
    ["4.0.0-beta.106", "4.0.0-beta.107"],
    { deprecated: ["4.0.0-beta.107"] }
  ))
  assert.equal(result.version, "4.0.0-beta.107")
  assert.equal(result.deprecated, "retired")
  assert.equal(result.gitHead, null)
})

test("reports exact release metadata", () => {
  const result = resolveRelease(packument(
    ["4.0.0-beta.107"],
    {
      distTags: { beta: "4.0.0-beta.107" },
      gitHeads: { "4.0.0-beta.107": "deadbeef" }
    }
  ))
  assert.equal(result.npmPublishedAt, "2026-01-01T00:00:00.000Z")
  assert.equal(result.gitTag, "effect@4.0.0-beta.107")
  assert.equal(result.gitHead, "deadbeef")
  assert.deepEqual(result.matchingDistTags, ["beta"])
  assert.match(result.tarball, /beta\.107\.tgz$/)
})

test("rejects a missing publication timestamp", () => {
  const fixture = packument(["4.0.0-beta.107"])
  delete fixture.time["4.0.0-beta.107"]
  assert.throws(() => resolveRelease(fixture), /no valid publication time/)
})

test("rejects a packument with no requested major", () => {
  assert.throws(() => resolveRelease(packument(["3.22.1"])), /No published effect major 4/)
})
