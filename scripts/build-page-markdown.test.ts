import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { sitePages } from "../handbook.ts"
import {
  artifactUrl,
  buildLlmsIndex,
  checkPageMarkdownArtifacts,
  writePageMarkdownArtifacts
} from "./build-page-markdown.ts"

const root = path.resolve(import.meta.dirname, "..")

test("writes byte-identical Markdown mirrors and detects drift", async (context) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "effect-handbook-markdown-"))
  context.after(() => rm(outputDirectory, { recursive: true, force: true }))

  const written = await writePageMarkdownArtifacts({ outputDirectory })
  assert.equal(written.pageCount, sitePages.length)

  for (const page of sitePages) {
    const [source, mirror] = await Promise.all([
      readFile(path.join(root, "docs", page.source)),
      readFile(path.join(outputDirectory, page.source))
    ])
    assert.deepEqual(mirror, source, page.source)
  }

  assert.equal((await checkPageMarkdownArtifacts({ outputDirectory })).ok, true)
  await writeFile(path.join(outputDirectory, "index.md"), "stale\n")
  const stale = await checkPageMarkdownArtifacts({ outputDirectory })
  assert.equal(stale.ok, false)
  assert.deepEqual(stale.mismatches, ["index.md"])
})

test("builds grouped links for root, Pages base, and an absolute site URL", () => {
  assert.equal(artifactUrl("data/schema.md"), "/data/schema.md")
  assert.equal(
    artifactUrl("data/schema.md", "/effect-handbook/"),
    "/effect-handbook/data/schema.md"
  )
  assert.equal(
    artifactUrl("data/schema.md", "/effect-handbook/", "https://example.com/ignored/path"),
    "https://example.com/ignored/path/data/schema.md"
  )

  const previousSiteUrl = process.env.HANDBOOK_SITE_URL
  delete process.env.HANDBOOK_SITE_URL
  const index = buildLlmsIndex({ base: "/effect-handbook/", siteUrl: null })
  if (previousSiteUrl === undefined) delete process.env.HANDBOOK_SITE_URL
  else process.env.HANDBOOK_SITE_URL = previousSiteUrl
  assert.match(index, /^# The Effect 4 Handbook\n/)
  assert.match(index, /\[Capability catalog\]\(\/effect-handbook\/effect-4-catalog\.json\)/)
  assert.match(index, /\[Example inventory and validation plan\]\(\/effect-handbook\/effect-4-examples\.json\)/)
  assert.match(index, /## Domain bundles/)
  assert.match(index, /## Intent and primitive map/)
  assert.match(index, /mutex/)
  assert.match(index, /## Data & Schema/)
  assert.match(index, /## Optional/)
  assert.match(index, /\[Schema\]\(\/effect-handbook\/data\/schema\.md\)/)
  assert.match(index, /\[Reactivity — From Atoms to Mastery\]\(\/effect-handbook\/deep-dives\/reactivity-from-atoms-to-mastery\.md\)/)
})
