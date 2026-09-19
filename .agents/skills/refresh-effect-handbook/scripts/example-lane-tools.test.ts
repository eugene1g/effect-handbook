import assert from "node:assert/strict"
import test from "node:test"

import { pageDisposition, relabelDiagnostics } from "./check-page-examples.ts"
import { planInlineRebinds, replaceHash } from "./rebind-example-hash.ts"

const fence = (overrides = {}) => ({ source: "docs/a.md", sha256: "h1", openingLine: 10, body: "const a = 1", metadata: undefined, ...overrides })

test("page checker compiles bare fences and unregistered run recipes, and skips registered exceptions", () => {
  const registry = [{ id: "ctx.one", source: "docs/a.md", sha256: "h2", disposition: "contextual" }]
  assert.deepEqual(pageDisposition(fence(), registry), { disposition: "compile", registeredId: undefined })
  assert.deepEqual(pageDisposition(fence({ metadata: { id: "new-recipe", check: "run" } }), registry), { disposition: "compile", registeredId: undefined })
  assert.deepEqual(pageDisposition(fence({ sha256: "h2" }), registry), { disposition: "contextual", registeredId: "ctx.one" })
  assert.deepEqual(pageDisposition(fence({ metadata: { id: "ctx.one" }, sha256: "edited" }), registry), { disposition: "contextual", registeredId: "ctx.one" })
  assert.deepEqual(pageDisposition(fence({ metadata: { id: "p", check: "pseudocode" } }), registry), { disposition: "pseudocode", registeredId: undefined })
})

test("page checker reports diagnostics against the Markdown location", () => {
  const output = "../.validation/scratch/lane-x/examples/a.L10.ts(3,5): error TS2339: nope"
  assert.equal(relabelDiagnostics(output, { "a.L10.ts": "docs/a.md:10" }), "docs/a.md:10 [a.L10.ts](3,5): error TS2339: nope")
})

test("rebinding replaces exactly one unique hash and preserves the rest of the registry text", () => {
  const text = '{ "examples": [\n  { "id": "x",   "sha256": "aaa" },\n  { "id": "y", "sha256": "bbb" }\n] }'
  assert.equal(replaceHash(text, "aaa", "ccc"), text.replace("aaa", "ccc"))
  assert.equal(replaceHash(text, "aaa", "aaa"), text)
  assert.throws(() => replaceHash(`${text}aaa`, "aaa", "ccc"), /not unique/)
  assert.throws(() => replaceHash(text, "zzz", "ccc"), /not unique/)
})

test("inline ids are re-bound, unmatched hash-only entries are orphans, and untouched entries are left alone", () => {
  const registry = [
    { id: "inline.changed", source: "docs/a.md", sha256: "old", disposition: "run" },
    { id: "hash.only.lost", source: "docs/a.md", sha256: "gone", disposition: "contextual" },
    { id: "hash.only.kept", source: "docs/a.md", sha256: "kept", disposition: "contextual" }
  ]
  const examples = [
    fence({ metadata: { id: "inline.changed" }, sha256: "new", openingLine: 5 }),
    fence({ sha256: "kept" })
  ]
  assert.deepEqual(planInlineRebinds(registry, examples), {
    rebinds: [{ id: "inline.changed", previous: "old", next: "new", location: "docs/a.md:5" }],
    orphans: [{ id: "hash.only.lost", source: "docs/a.md", disposition: "contextual" }]
  })
})
