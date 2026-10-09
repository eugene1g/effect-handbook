import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { handbookPages, sitePages } from "../handbook.ts"
import { buildEssentials, essentialsWordBudget, essentialsWordCount } from "./build-essentials.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function canonicalSources() {
  const sources = new Map<string, string>()
  for (const page of sitePages) sources.set(page.source, await readFile(path.join(root, "docs", page.source), "utf8"))
  return sources
}

test("covers every concise page within the word budget", async () => {
  const essentials = buildEssentials(await canonicalSources())
  const words = essentialsWordCount(essentials)
  assert(words >= essentialsWordBudget.min && words <= essentialsWordBudget.max, `essentials is ${words} words`)
  for (const page of handbookPages) assert(essentials.includes(`](./${page.source})`), `${page.source} is missing from the essentials`)
  assert(!essentials.includes("deep-dives/testing-an-effect-application.md)"), "deep dives stay out of the essentials")
})

test("keeps labels and reach-for lines, drops code, and links to twin anchors", () => {
  const sources = new Map([["foundations/getting-started.md", ""]])
  for (const page of handbookPages) sources.set(page.source, sources.get(page.source) ?? "# Page\n")
  sources.set("data/schema.md", [
    "# Schema",
    "",
    "Intro paragraph that leads the page.",
    "",
    "## Schema",
    "",
    "`effect/Schema` — stable",
    "",
    "> **Note:** a callout that is skipped.",
    "",
    "The opening paragraph, with a [link](../data/functional-toolkit#brand).",
    "",
    "```ts",
    "const notInTheDigest = 1",
    "```",
    "",
    "### 1. Decoding",
    "",
    "**Reach for it when** you validate input.",
    ""
  ].join("\n"))
  const essentials = buildEssentials(sources)
  assert.match(essentials, /### \[Schema\]\(\.\/data\/schema\.md#schema-1\)/)
  assert.match(essentials, /`effect\/Schema` — stable/)
  assert.match(essentials, /The opening paragraph, with a \[link\]\(\.\/data\/functional-toolkit\.md#brand\)\./)
  assert.match(essentials, /Sections: \[1\. Decoding\]\(\.\/data\/schema\.md#_1-decoding|Sections: \[1\. Decoding\]\(\.\/data\/schema\.md#1-decoding\)/)
  assert.match(essentials, /\*\*Reach for it when\*\* you validate input\./)
  assert.doesNotMatch(essentials, /notInTheDigest|a callout that is skipped/)
})
