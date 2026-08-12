import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { assertExactObjectKeys, assertRuntimeDefinitionsUsed, classifyDocExamples, importedPackages, parseExampleMetadata, repositoryRoot, sha256 } from "./example-model.ts"
import { extractExamples } from "./extract-examples.ts"
import { assertKnownContextualFixtures } from "./fixture-projects.ts"

test("metadata rejects unknown fields and parses the current contract", () => {
  assert.deepEqual(parseExampleMetadata("<!-- effect-example id=demo check=run runtime=probe -->"), {
    id: "demo",
    check: "run",
    runtime: "probe"
  })
  assert.throws(() => parseExampleMetadata("<!-- effect-example: id=demo kind=runnable run=true -->"), /unknown effect-example field kind/)
  assert.throws(() => parseExampleMetadata("<!-- effect-example id=demo nope=true -->"), /unknown effect-example field nope/)
})

test("tracked JSON contracts reject missing and unexpected properties", () => {
  assert.doesNotThrow(() => assertExactObjectKeys({ id: "demo", optional: true }, {
    required: ["id"],
    optional: ["optional"]
  }, "fixture"))
  assert.throws(() => assertExactObjectKeys({ optional: true }, { required: ["id"], optional: ["optional"] }, "fixture"), /missing required property id/)
  assert.throws(() => assertExactObjectKeys({ id: "demo", surprise: true }, { required: ["id"] }, "fixture"), /unknown property surprise/)
})

test("package imports are discovered lexically without treating SQL text as imports", () => {
  const source = `
    import "effect"
    import type { FileSystem } from "@effect/platform-node/FileSystem"
    export { SqlClient } from "@effect/sql-pg"
    const lazy = import("@effect/ai-openai")
    const query = sql\`select * from \${sql("comp_bands")}\`
    const prose = "import { nope } from '@effect/not-real'"
    // import "@effect/not-a-comment"
  `
  assert.deepEqual(importedPackages(source), [
    "@effect/ai-openai",
    "@effect/platform-node",
    "@effect/sql-pg",
    "effect"
  ])
})

test("contextual ids are explicit semantic names, not content-derived hashes", async () => {
  const { examples } = await classifyDocExamples()
  const contextual = examples.filter((example) => example.disposition === "contextual")
  assert.ok(contextual.length > 0)
  assert.ok(contextual.every((example) => example.classificationSource === "registry"))
  assert.ok(contextual.every((example) => !/\.[a-f0-9]{16}$/.test(example.id)))
})

test("orphan runtime definitions and unknown fixtures are rejected", () => {
  assert.throws(() => assertRuntimeDefinitionsUsed({ runtimes: { orphan: { mode: "complete", expect: ["x"] } } }, new Set()), /Orphan runtime definition orphan/)
  assert.throws(() => assertKnownContextualFixtures([{ id: "demo", disposition: "contextual", fixture: "missing" }]), /unknown contextual fixture missing/)
})

test("fresh extraction preserves every canonical fence byte for byte", async () => {
  const { manifest } = await extractExamples()
  assert.equal(manifest.entries.length, manifest.fences)
  assert.equal(new Set(manifest.entries.map((entry) => entry.id)).size, manifest.fences)
  const harnessPaths = new Set(manifest.harnessInventory.map((entry) => entry.path))
  assert.ok(harnessPaths.has("pnpm-workspace.yaml"), "workspace definition must participate in the harness hash")
  assert.ok(harnessPaths.has("pnpm-lock.yaml"), "shared lockfile must participate in the harness hash")
  assert.ok(harnessPaths.has("validation/package.json"), "validation package must participate in the harness hash")
  assert.ok(!harnessPaths.has("validation/pnpm-lock.yaml"), "nested validation lockfiles are forbidden")
  for (const entry of manifest.entries) {
    const source = (await readFile(path.join(repositoryRoot, entry.source), "utf8")).split(/\r?\n/)
    const body = source.slice(entry.startLine - 1, entry.endLine).join("\n")
    const extracted = await readFile(path.join(repositoryRoot, ".validation", "generated", entry.output), "utf8")
    assert.equal(extracted, body, entry.id)
    assert.equal(sha256(extracted), entry.sha256, entry.id)
  }
  assert.ok(manifest.entries.filter((entry) => entry.disposition === "pseudocode").every((entry) => entry.evidence.typescript === "not-applicable" && entry.evidence.effect === "not-applicable"))
})
