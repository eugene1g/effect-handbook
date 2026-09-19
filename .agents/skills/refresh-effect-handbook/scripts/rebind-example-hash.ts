#!/usr/bin/env node

// Re-bind hash-pinned entries in `validation/examples.json` after a REVIEWED edit to a canonical fence.
//
//   node <skill-dir>/scripts/rebind-example-hash.ts --all-inline
//       Re-binds every entry whose fence carries a matching `<!-- effect-example id=... -->` comment, and
//       lists hash-only entries that no longer match any fence (orphans).
//   node <skill-dir>/scripts/rebind-example-hash.ts <registry-id> "<unique substring of the edited fence>"
//       Re-binds one hash-only entry to the single fence in the same source page containing the substring.
//
// The registry is edited textually so its hand formatting survives. A hash is evidence that a fence was
// reviewed: read the diff of the fence before running this, and never run it to silence an unexpected change.

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const registryPath = path.join(repositoryRoot, "validation", "examples.json")

export function replaceHash(registryText, previous, next) {
  if (previous === next) return registryText
  if (registryText.split(previous).length !== 2) throw new Error(`hash ${previous.slice(0, 12)} is not unique in the registry`)
  return registryText.replace(previous, next)
}

export function planInlineRebinds(registryExamples, examples) {
  const byInlineId = new Map()
  const liveHashes = new Set()
  for (const example of examples) {
    liveHashes.add(`${example.source}\0${example.sha256}`)
    if (example.metadata?.id !== undefined) byInlineId.set(example.metadata.id, example)
  }
  const rebinds = []
  const orphans = []
  for (const entry of registryExamples) {
    const inline = byInlineId.get(entry.id)
    if (inline !== undefined) {
      if (inline.sha256 !== entry.sha256) rebinds.push({ id: entry.id, previous: entry.sha256, next: inline.sha256, location: `${entry.source}:${inline.openingLine}` })
    } else if (!liveHashes.has(`${entry.source}\0${entry.sha256}`)) {
      orphans.push({ id: entry.id, source: entry.source, disposition: entry.disposition })
    }
  }
  return { rebinds, orphans }
}

async function main() {
  const model = await import(path.join(repositoryRoot, "scripts/validation/example-model.ts"))
  const { examples } = await model.readCanonicalExamples()
  let text = readFileSync(registryPath, "utf8")
  const registry = JSON.parse(text).examples
  const args = process.argv.slice(2)

  if (args[0] === "--all-inline") {
    const { rebinds, orphans } = planInlineRebinds(registry, examples)
    for (const rebind of rebinds) {
      text = replaceHash(text, rebind.previous, rebind.next)
      console.log(`rebound ${rebind.id} (${rebind.location})`)
    }
    writeFileSync(registryPath, text)
    console.log(`rebound: ${rebinds.length}`)
    console.log(`orphans needing an explicit substring (${orphans.length}):`)
    for (const orphan of orphans) console.log(`  ${orphan.id}  [${orphan.source}]  ${orphan.disposition}`)
    return
  }

  const [id, needle] = args
  if (!id || !needle) {
    console.error('usage: rebind-example-hash.ts --all-inline | <registry-id> "<unique substring of the edited fence>"')
    process.exit(2)
  }
  const entry = registry.find((candidate) => candidate.id === id)
  if (!entry) throw new Error(`No registry entry ${id}`)
  const matches = examples.filter((example) => example.source === entry.source && example.body.includes(needle))
  if (matches.length !== 1) throw new Error(`${matches.length} fences in ${entry.source} contain the substring; it must select exactly one`)
  writeFileSync(registryPath, replaceHash(text, entry.sha256, matches[0].sha256))
  console.log(`${id}: ${entry.sha256.slice(0, 12)} -> ${matches[0].sha256.slice(0, 12)} (${entry.source}:${matches[0].openingLine})`)
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main()
