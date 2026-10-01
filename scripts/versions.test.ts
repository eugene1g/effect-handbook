import assert from "node:assert/strict"
import test from "node:test"

import { handbookRelease } from "../handbook.ts"
import {
  assertVersionsMatchRelease,
  compareEditionIds,
  editionIdOf,
  loadVersions,
  renderPublishedVersions,
  resolveEditionContext,
  validateVersions
} from "./versions.ts"

const manifest = {
  schemaVersion: 1,
  latest: "4.1",
  versions: [
    { id: "4.0", effectVersion: "4.0.3", auditedAt: "2026-10-01", ref: "effect-4.0.3/2026-10-01" },
    { id: "5.0", effectVersion: "5.0.0", auditedAt: "2027-02-01", ref: "effect-5.0.0/2027-02-01" },
    { id: "4.1", effectVersion: "4.1.0", auditedAt: "2026-12-01", ref: null }
  ]
}

test("the checked-in manifest matches the audited release", () => {
  const loaded = assertVersionsMatchRelease(loadVersions())
  const latest = loaded.versions.find((entry) => entry.id === loaded.latest)
  assert.equal(latest.effectVersion, handbookRelease.version)
  assert.equal(latest.auditedAt, handbookRelease.auditedAt)
  assert.equal(latest.ref ?? null, null)
})

test("validates edition ids, refs, and the latest marker", () => {
  const valid = validateVersions(manifest)
  assert.deepEqual(valid.versions.map((entry) => entry.id), ["5.0", "4.1", "4.0"], "editions sort newest first")
  assert.throws(() => validateVersions({ ...manifest, latest: "9.9" }), /not a listed edition/)
  assert.throws(() => validateVersions({ ...manifest, versions: [{ ...manifest.versions[2], ref: "tag" }, ...manifest.versions.slice(0, 2)] }), /must not name a ref/)
  assert.throws(() => validateVersions({ ...manifest, versions: [{ ...manifest.versions[0], ref: null }, ...manifest.versions.slice(1)] }), /must name the git tag/)
  assert.throws(() => validateVersions({ ...manifest, versions: [{ ...manifest.versions[0], id: "4" }, ...manifest.versions.slice(1)] }), /major\.minor/)
  assert.throws(() => validateVersions({ ...manifest, versions: [{ ...manifest.versions[0], effectVersion: "4.2.0" }, ...manifest.versions.slice(1)] }), /inside that minor/)
  assert.equal(editionIdOf("4.0.0"), "4.0")
  assert.equal(editionIdOf("10.12.3-rc.1"), "10.12")
  assert.ok(compareEditionIds("4.10", "4.9") > 0)
  assert.ok(compareEditionIds("5.0", "4.99") > 0)
})

test("resolves edition paths against the root base and site URL", () => {
  const valid = validateVersions(manifest)
  const root = resolveEditionContext({ base: "/eh/", manifest: valid })
  assert.equal(root.current, "4.1")
  assert.equal(root.rootBase, "/eh/")
  assert.deepEqual(root.editions.map((entry) => entry.path), ["/eh/5.0/", "/eh/4.1/", "/eh/4.0/"])

  const frozen = resolveEditionContext({ base: "/eh/4.0/", rootBase: "/eh/", siteUrl: "https://example.com/eh/4.0/", rootSiteUrl: "https://example.com/eh/", current: "4.0", manifest: valid })
  assert.equal(frozen.current, "4.0")
  assert.equal(frozen.editions.find((entry) => entry.isCurrent).id, "4.0")
  assert.equal(frozen.editions.find((entry) => entry.isLatest).url, "https://example.com/eh/4.1/")
  assert.throws(() => resolveEditionContext({ base: "/", current: "3.0", manifest: valid }), /not an edition/)

  const published = JSON.parse(renderPublishedVersions(frozen))
  assert.equal(published.latest, "4.1")
  assert.equal(published.rootUrl, "https://example.com/eh/")
  assert.deepEqual(published.editions.map((entry) => [entry.id, entry.status, entry.llmsTxt]), [
    ["5.0", "frozen", "https://example.com/eh/5.0/llms.txt"],
    ["4.1", "latest", "https://example.com/eh/4.1/llms.txt"],
    ["4.0", "frozen", "https://example.com/eh/4.0/llms.txt"]
  ])
  assert.equal(published.editions[2].gitRef, "effect-4.0.3/2026-10-01")
  assert.equal(published.editions[1].gitRef, undefined)
})
