import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { agentBundles, capabilities, sitePages } from "../handbook.ts"
import {
  buildRetrievalArtifacts,
  catalogFilename,
  examplesFilename,
  checkRetrievalArtifacts,
  requiredChecksFor,
  writeRetrievalArtifacts
} from "./build-retrieval-artifacts.ts"

test("builds a validated catalog and every focused domain bundle", async () => {
  const result = await buildRetrievalArtifacts()
  assert.ok(capabilities.length >= 50)
  assert.equal(result.catalog.capabilities.length, capabilities.length)
  assert.equal(result.catalog.snippets.length, 8)
  assert.ok(result.catalog.snippets.every((snippet) => snippet.disposition === "run" && typeof snippet.runtimeCheckId === "string"))
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.relativePath),
    [catalogFilename, examplesFilename, ...agentBundles.map((bundle) => bundle.filename)]
  )

  const examplesArtifact = result.artifacts.find((artifact) => artifact.relativePath === examplesFilename)
  assert.ok(examplesArtifact)
  const inventory = JSON.parse(examplesArtifact.contents.toString("utf8"))
  assert.equal(inventory.schemaVersion, 2)
  assert.equal(inventory.artifactKind, "example-inventory")
  assert.match(inventory.canonicalSourceHash, /^[a-f0-9]{64}$/)
  assert.equal(inventory.validationEvidence, "not-included")
  assert.equal(Object.values(inventory.totals.disposition).reduce((sum, count) => sum + count, 0), inventory.examples.length)
  for (const example of inventory.examples) {
    assert.deepEqual(example.requiredChecks, requiredChecksFor(example), example.id)
    for (const misleading of ["typeChecked", "effectChecked", "runtimeChecked", "status"]) {
      assert.equal(Object.hasOwn(example, misleading), false, `${example.id}.${misleading}`)
    }
  }

  const knownSources = new Set(sitePages.map((page) => page.source))
  for (const capability of result.catalog.capabilities) {
    assert.ok(knownSources.has(capability.page), capability.id)
    assert.ok(capability.tasks.length > 0, capability.id)
    assert.ok(capability.errorChannel && capability.requirements && capability.lifetime, capability.id)
    assert.ok(capability.snippetIds.every((id) => result.catalog.snippets.some((snippet) => snippet.id === id)), capability.id)
  }
})

test("writes retrieval artifacts byte-for-byte and detects drift", async (context) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "effect-handbook-retrieval-"))
  context.after(() => rm(outputDirectory, { recursive: true, force: true }))

  const written = await writeRetrievalArtifacts({ outputDirectory })
  assert.equal(written.artifacts.length, agentBundles.length + 2)
  assert.equal((await checkRetrievalArtifacts({ outputDirectory })).ok, true)

  await writeFile(path.join(outputDirectory, catalogFilename), "stale\n")
  const stale = await checkRetrievalArtifacts({ outputDirectory })
  assert.equal(stale.ok, false)
  assert.deepEqual(stale.mismatches, [catalogFilename])

  const bundle = await readFile(path.join(outputDirectory, agentBundles[0].filename), "utf8")
  assert.match(bundle, /^<!-- Generated from canonical concise handbook pages/)
})
