import assert from "node:assert/strict"
import test from "node:test"

import { declaredNames, expectedOutputs, isPlaceholderFailure } from "./execute-examples.ts"

test("reads JSON-literal output comments the way console.log prints them", () => {
  const body = [
    'console.log(total) // 42000',
    'console.log(label) // "comp bands re-published"',
    'console.log(seen) // ["planning"]',
    'console.log(result) // => true',
    'console.log(a, b) // "ambiguous"',
    'console.log(grant) // EquityGrant({ ... })'
  ].join("\n")
  assert.deepEqual(expectedOutputs(body), ["42000", "comp bands re-published", "[ 'planning' ]", "true"])
})

test("accepts a ReferenceError only for a name the fence declares", () => {
  const declared = declaredNames("declare const PayrollDbFixture: Layer.Layer<PayrollDb>\nexport declare function makeService(): void\n")
  assert.deepEqual([...declared].sort(), ["PayrollDbFixture", "makeService"])
  assert(isPlaceholderFailure("ReferenceError: makeService is not defined", declared))
  assert(isPlaceholderFailure("PayrollDbFixture is not defined", declared))
  assert(!isPlaceholderFailure("ReferenceError: Deno is not defined", declared))
})
