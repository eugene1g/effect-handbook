import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { handbookRelease, sitePages } from "../handbook.ts"
import { rewriteSiteLinks } from "./build-agent-handbook.ts"
import {
  artifactUrl,
  buildLlmsIndex,
  buildModuleIndex,
  buildRobotsTxt,
  checkPageMarkdownArtifacts,
  headingAnchors,
  renderMarkdownTwin,
  rewriteLinksToRelativeTwins,
  writePageMarkdownArtifacts
} from "./build-page-markdown.ts"

// The audited release, escaped for use inside a RegExp, so header assertions follow handbook.ts.
const releaseVersionPattern = handbookRelease.version.replaceAll(".", String.raw`\.`)

const root = path.resolve(import.meta.dirname, "..")

test("writes Markdown twins that preserve the source and detects drift", async (context) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "effect-handbook-markdown-"))
  context.after(() => rm(outputDirectory, { recursive: true, force: true }))

  const written = await writePageMarkdownArtifacts({ outputDirectory })
  assert.equal(written.pageCount, sitePages.length)
  assert.ok(written.moduleCount >= 300, `module index found only ${written.moduleCount} modules`)

  for (const page of sitePages) {
    const [source, twin] = await Promise.all([
      readFile(path.join(root, "docs", page.source), "utf8"),
      readFile(path.join(outputDirectory, page.source), "utf8")
    ])
    const [header, blank, ...rest] = twin.split("\n")
    assert.match(header, new RegExp(String.raw`^<!-- Markdown twin of \/\S* · The Effect 4 Handbook \(effect@${releaseVersionPattern}, audited \d{4}-\d{2}-\d{2}\) · Index: \/llms\.txt · Modules: \/effect-4-modules\.md · Agent guide: \/reference\/agent-guide\.md -->$`), page.source)
    assert.equal(blank, "", page.source)
    const body = rest.join("\n").replace(/^\*\*Contents:\*\* .*\n\n/m, "")
    // Apart from the header, the optional contents line, and `.md` link
    // targets, the twin is the canonical source: same headings, same fences.
    assert.deepEqual(headingAnchors(body), headingAnchors(source), page.source)
    assert.equal(body.split("\n```").length, source.split("\n```").length, page.source)
    assert.equal(rewriteLinksToRelativeTwins(source, page.source), body, page.source)
  }

  for (const name of ["llms.txt", "effect-4-modules.md", "effect-4-modules.json", "robots.txt", "versions.json"]) {
    await readFile(path.join(outputDirectory, name))
  }
  const published = JSON.parse(await readFile(path.join(outputDirectory, "versions.json"), "utf8"))
  assert.equal(published.artifactKind, "handbook-editions")
  assert.ok(published.editions.some((entry) => entry.status === "latest" && entry.id === published.latest))

  assert.equal((await checkPageMarkdownArtifacts({ outputDirectory })).ok, true)
  await writeFile(path.join(outputDirectory, "index.md"), "stale\n")
  const stale = await checkPageMarkdownArtifacts({ outputDirectory })
  assert.equal(stale.ok, false)
  assert.deepEqual(stale.mismatches, ["index.md"])
})

test("rewrites internal links to Markdown twins and leaves everything else alone", () => {
  const source = [
    "See [Effect](core-runtime-execution#effect), [deep dives](../deep-dives/), [home](../#stability-and-support),",
    "[kept](../reference/cheat-sheet-index.md), [same page](#here), [external](https://example.com/x), [root](/absolute).",
    "",
    "```ts",
    "// [not a link](core-runtime-execution)",
    "```"
  ].join("\n")
  const relative = rewriteLinksToRelativeTwins(source, "foundations/getting-started.md")
  assert.match(relative, /\[Effect\]\(core-runtime-execution\.md#effect\)/)
  assert.match(relative, /\[deep dives\]\(\.\.\/deep-dives\/index\.md\)/)
  assert.match(relative, /\[home\]\(\.\.\/index\.md#stability-and-support\)/)
  assert.match(relative, /\[kept\]\(\.\.\/reference\/cheat-sheet-index\.md\)/)
  assert.match(relative, /\[same page\]\(#here\)/)
  assert.match(relative, /\[external\]\(https:\/\/example\.com\/x\)/)
  assert.match(relative, /\[root\]\(\/absolute\)/)
  assert.match(relative, /\/\/ \[not a link\]\(core-runtime-execution\)/)

  const rooted = rewriteSiteLinks(source, "foundations/getting-started.md")
  assert.match(rooted, /\[Effect\]\(\.\/foundations\/core-runtime-execution\.md#effect\)/)
  assert.match(rooted, /\[deep dives\]\(\.\/deep-dives\/index\.md\)/)
  assert.match(rooted, /\[home\]\(\.\/index\.md#stability-and-support\)/)
  assert.match(rooted, /\[same page\]\(#here\)/)
})

test("adds a contents line only to long pages and dedupes anchors like the site", () => {
  const page = { source: "data/example.md", link: "/data/example" }
  const short = "# Title\n\nIntro.\n\n## One\n\n## Two\n"
  assert.doesNotMatch(renderMarkdownTwin(page, short), /\*\*Contents:\*\*/)

  const sections = Array.from({ length: 8 }, (_, index) => `## Section ${index === 7 ? "Two" : index + 1}`)
  const long = `# Title\n\nIntro.\n\n${sections.join("\n\nBody.\n\n")}\n\n### Section Two\n\n## Section Two\n`
  const twin = renderMarkdownTwin(page, long)
  assert.match(twin, /^<!-- Markdown twin of \/data\/example · /)
  const contents = twin.split("\n").find((line) => line.startsWith("**Contents:**"))
  assert.ok(contents)
  assert.match(contents, /\[Section 1\]\(#section-1\) · /)
  assert.match(contents, /\[Section Two\]\(#section-two\) · \[Section Two\]\(#section-two-2\)$/)
  assert.deepEqual(headingAnchors("# A\n\n## A\n\n### A\n\n```md\n# not a heading\n```\n").map((heading) => heading.anchor), ["a", "a-1", "a-2"])
})

test("indexes module sections from their stability labels", () => {
  const sources = new Map([[
    sitePages[0].source,
    "# Page\n\n## HttpClient\n\n`effect/http/HttpClient` — unstable\n\nBody.\n\n## Not a module\n\nProse.\n\n## Base64\n\n`effect/encoding/Base64` — stable\n\n```ts\n`effect/fake` — stable\n```\n\n## Queue\n\n`effect/Queue` — stable\n\n## Activity\n\n`effect/workflow` — unstable\n\n## NodeHttpServer\n\n`@effect/platform-node/NodeHttpServer` — unstable\n"
  ]])
  const modules = buildModuleIndex(sources)
  assert.deepEqual(modules.map((entry) => [entry.module, entry.importPath, entry.stability, entry.anchor, entry.area]), [
    ["Activity", "effect/workflow", "unstable", "activity", "effect/workflow"],
    ["Base64", "effect/encoding/Base64", "stable", "base64", "effect/encoding"],
    ["HttpClient", "effect/http/HttpClient", "unstable", "httpclient", "effect/http"],
    ["NodeHttpServer", "@effect/platform-node/NodeHttpServer", "unstable", "nodehttpserver", "@effect/platform-node"],
    ["Queue", "effect/Queue", "stable", "queue", "effect"]
  ])
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
  assert.match(index, /\[Using this handbook from an agent\]\(\/effect-handbook\/reference\/agent-guide\.md\)/)
  assert.match(index, /\[Module index\]\(\/effect-handbook\/effect-4-modules\.md\)/)
  assert.match(index, /\[Capability catalog\]\(\/effect-handbook\/effect-4-catalog\.json\)/)
  assert.match(index, /\[Example inventory and validation plan\]\(\/effect-handbook\/effect-4-examples\.json\)/)
  assert.match(index, /\[llms-full\.txt\]\(\/effect-handbook\/llms-full\.txt\)/)
  assert.match(index, new RegExp(String.raw`This is the \*\*4\.0 edition\*\* \(effect@${releaseVersionPattern}\)`))
  assert.match(index, /## Editions\n/)
  assert.match(index, new RegExp(String.raw`- \[4\.0 — effect@${releaseVersionPattern}\]\(\/effect-handbook\/4\.0\/llms\.txt\): audited \d{4}-\d{2}-\d{2} \(latest, this file\)\.`))
  assert.match(index, /## Domain bundles/)
  assert.match(index, /\(~\d+(\.\d)?K words\)/)
  assert.match(index, /## Intent and primitive map/)
  assert.match(index, /mutex/)
  assert.match(index, /## Data & Schema/)
  assert.match(index, /## Optional/)
  assert.match(index, /\[Schema\]\(\/effect-handbook\/data\/schema\.md\): .* \(~[\d.]+K words\)/)
  assert.match(index, /\[Reactivity — From Atoms to Mastery\]\(\/effect-handbook\/deep-dives\/reactivity-from-atoms-to-mastery\.md\)/)

  const robots = buildRobotsTxt({ base: "/effect-handbook/" })
  assert.match(robots, /^User-agent: \*\nAllow: \/\n/)
  assert.match(robots, /\/effect-handbook\/llms\.txt/)
  assert.match(robots, /major\.minor\): \/effect-handbook\/versions\.json/)
  assert.doesNotMatch(robots, /Sitemap:/)
  assert.match(buildRobotsTxt({ siteUrl: "https://example.com/handbook" }), /\nSitemap: https:\/\/example\.com\/handbook\/sitemap\.xml\n$/)
  assert.equal(handbookRelease.version, "4.0.2")
})
