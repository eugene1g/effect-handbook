import assert from "node:assert/strict"
import test from "node:test"

import { checkoutDirectoryName, releaseProblems } from "./audit-latest-effect.ts"

test("derives an ignored clone name from a safe published version", () => {
  assert.equal(checkoutDirectoryName("4.0.0-rc.108"), "effect-ci-4.0.0-rc.108")
  assert.equal(checkoutDirectoryName("4.0.0+build.2"), "effect-ci-4.0.0-build.2")
  assert.throws(() => checkoutDirectoryName("../effect"), /unsafe Effect version/)
})

test("accepts the exact non-deprecated handbook release", () => {
  assert.deepEqual(
    releaseProblems({ version: "4.0.0-rc.108", deprecated: null }, { version: "4.0.0-rc.108" }),
    []
  )
})

test("reports release drift and deprecation independently", () => {
  assert.deepEqual(
    releaseProblems(
      { version: "4.0.0-rc.109", deprecated: "withdrawn" },
      { version: "4.0.0-rc.108" }
    ),
    [
      "highest published Effect v4 4.0.0-rc.109 is deprecated: withdrawn",
      "handbook targets 4.0.0-rc.108, but the highest published Effect v4 is 4.0.0-rc.109"
    ]
  )
})

test("reports tagged source and npm metadata drift for the same version", () => {
  assert.deepEqual(
    releaseProblems(
      {
        version: "4.0.0-rc.108",
        deprecated: null,
        gitTag: "effect@4.0.0-rc.108",
        npmPublishedAt: "2026-08-12T14:03:51.718Z",
        gitHead: "bbbb"
      },
      {
        version: "4.0.0-rc.108",
        tag: "effect@4.0.0-rc.108",
        publishedAt: "2026-08-12T14:03:51.718Z",
        commit: "aaaa"
      },
      "cccc"
    ),
    [
      "handbook records source commit aaaa, but tag effect@4.0.0-rc.108 resolves to cccc",
      "npm gitHead bbbb does not match tagged source commit cccc"
    ]
  )
})
