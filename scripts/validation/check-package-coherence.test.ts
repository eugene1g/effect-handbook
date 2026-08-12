import assert from "node:assert/strict"
import test from "node:test"

import { assertDirectEffectImports, assertNoStaleEffectRelease, assertTargetShape, workspaceImporter } from "./check-package-coherence.ts"

test("selects the validation importer from the shared workspace lockfile", () => {
  const lockfile = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      typescript:\n        specifier: 7.0.2\n\n  validation:\n    dependencies:\n      effect:\n        specifier: 4.0.0-rc.108\n\npackages:\n\n  effect@4.0.0-rc.108: {}\n`
  assert.match(workspaceImporter(lockfile, "validation"), /effect:[\s\S]*specifier: 4\.0\.0-rc\.108/)
  assert.doesNotMatch(workspaceImporter(lockfile, "validation"), /typescript/)
  assert.throws(() => workspaceImporter(lockfile, "missing"), /no missing workspace importer/)
})

test("rejects stale Effect release assertions in tracked harness inputs", () => {
  assert.doesNotThrow(() => assertNoStaleEffectRelease(
    "target effect@4.0.0-rc.108",
    "fixture",
    "4.0.0-rc.108"
  ))
  assert.throws(() => assertNoStaleEffectRelease(
    "target effect@4.0.0-beta.107",
    "fixture",
    "4.0.0-rc.108"
  ), /stale Effect release 4\.0\.0-beta\.107/)
})

test("requires every Effect package imported by canonical examples to have an exact direct pin", () => {
  const examples = [{ packages: ["effect", "@effect/platform-node", "node:fs"] }]
  assert.doesNotThrow(() => assertDirectEffectImports(examples, {
    effect: "4.0.0-rc.108",
    "@effect/platform-node": "4.0.0-rc.108"
  }, "4.0.0-rc.108"))
  assert.throws(() => assertDirectEffectImports(examples, {
    effect: "4.0.0-rc.108"
  }, "4.0.0-rc.108"), /does not pin it directly/)
  assert.throws(() => assertDirectEffectImports(examples, {
    effect: "4.0.0-rc.108",
    "@effect/platform-node": "4.0.0-rc.107"
  }, "4.0.0-rc.108"), /does not match Effect/)
})

test("target validation rejects unknown fields and incomplete tool identity", () => {
  const target = {
    schemaVersion: 1,
    effect: {
      version: "4.0.0-rc.108",
      tag: "effect@4.0.0-rc.108",
      commit: "a".repeat(40),
      publishedAt: "2026-08-12T14:03:51.718Z",
      auditedAt: "2026-08-12"
    },
    tools: {
      node: ">=26 <27",
      pnpm: "11.18.0",
      typescript: "7.0.2",
      nodeTypes: "26.2.0",
      effectTsgo: "0.21.0",
      vitest: "4.1.10",
      doctest: "4.0.0-rc.108"
    },
    toolingExceptions: {}
  }
  assert.doesNotThrow(() => assertTargetShape(target))
  assert.throws(() => assertTargetShape({ ...target, surprise: true }), /unknown property surprise/)
  const { nodeTypes: _, ...incompleteTools } = target.tools
  assert.throws(() => assertTargetShape({ ...target, tools: incompleteTools }), /missing required property nodeTypes/)
})
