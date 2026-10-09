import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { handbookRelease } from "../handbook.ts"
import { releaseHistoryEntries, releaseHistoryProblems, releaseHistorySource } from "./release-history.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const page = [
  "# Release History",
  "",
  "## `effect@4.1.0` — audited 2026-12-01",
  "",
  "```md",
  "## `effect@9.9.9` — audited 2099-01-01",
  "```",
  "",
  "## `effect@4.0.2` — audited 2026-10-09",
  ""
].join("\n")

test("reads release entries in order and ignores fenced examples", () => {
  assert.deepEqual(releaseHistoryEntries(page), [
    { version: "4.1.0", auditedAt: "2026-12-01" },
    { version: "4.0.2", auditedAt: "2026-10-09" }
  ])
})

test("requires the current release to be the newest entry", () => {
  assert.deepEqual(releaseHistoryProblems(page, { version: "4.1.0", auditedAt: "2026-12-01" }), [])
  assert.match(releaseHistoryProblems(page, { version: "4.1.1", auditedAt: "2026-12-20" })[0], /add an entry for the current release/)
  assert.match(releaseHistoryProblems("# Release History\n", handbookRelease)[0], /has no release entries/)
})

test("rejects duplicate and out-of-order entries", () => {
  const swapped = "## `effect@4.0.2` — audited 2026-10-09\n\n## `effect@4.1.0` — audited 2026-12-01\n"
  assert(releaseHistoryProblems(swapped, { version: "4.0.2", auditedAt: "2026-10-09" }).some((problem) => problem.includes("not newest first")))
  const repeated = "## `effect@4.0.2` — audited 2026-10-09\n\n## `effect@4.0.2` — audited 2026-10-09\n"
  assert(releaseHistoryProblems(repeated, { version: "4.0.2", auditedAt: "2026-10-09" }).some((problem) => problem.includes("repeats")))
})

test("the canonical page records the audited release", async () => {
  const markdown = await readFile(path.join(root, "docs", releaseHistorySource), "utf8")
  assert.deepEqual(releaseHistoryProblems(markdown, handbookRelease), [])
})
