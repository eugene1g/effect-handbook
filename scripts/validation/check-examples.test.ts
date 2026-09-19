import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { assertDoctestEvidence, assertExpectedDiagnostic, effectDiagnosticProblems } from "./check-examples.ts"
import { repositoryRoot } from "./example-model.ts"

test("expected-invalid diagnostics require one exact code and message fragment", () => {
  assert.deepEqual(
    assertExpectedDiagnostic("example.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n", {
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'"
    }),
    { code: "TS2322", message: "Type 'string' is not assignable to type 'number'." }
  )
  assert.throws(() => assertExpectedDiagnostic("example.ts(1,7): error TS2322: Wrong\n", { code: "TS2345", message: "Wrong" }), /Expected TS2345/)
  assert.throws(() => assertExpectedDiagnostic("", { code: "TS2322", message: "Wrong" }), /exactly one TypeScript diagnostic/)
})

test("Effect diagnostics read severity from the located slot, not from paths or message text", () => {
  const advisory = "fixtures/rpc.client-error-recovery/src/example.ts(6,3): message effect(catchConditionalRefailToCatchIf): prefer catchIf over a conditional Effect.fail"
  const warning = "fixtures/base/src/example.ts(2,1): warning effect(floatingEffect): Effect must be yielded"
  const error = "fixtures/base/src/example.ts(9,4): error effect(missingEffectContext): missing service"
  assert.deepEqual(effectDiagnosticProblems([advisory, warning, error, ""].join("\n")), [warning, error])
  assert.deepEqual(effectDiagnosticProblems("Found 1 error in 1 file"), ["Found 1 error in 1 file"])
  assert.deepEqual(effectDiagnosticProblems("No diagnostics"), [])
})

const doctestExample = (id, source, name, runtime = id) => ({ id, source, name, openingLine: 10, runtime })
const doctestReport = (tests) => ({
  numTotalTests: tests.length,
  testResults: tests.map(({ source, title, status = "passed" }) => ({
    name: path.resolve(repositoryRoot, source),
    assertionResults: [{ title, fullName: title, status }]
  }))
})

test("doctest evidence maps every canonical source and test identity", () => {
  const examples = [
    doctestExample("one", "docs/one.md", "first"),
    doctestExample("two", "docs/two.md", "second")
  ]
  const report = doctestReport([
    { source: "docs/one.md", title: "first" },
    { source: "docs/two.md", title: "second" }
  ])
  assert.deepEqual(assertDoctestEvidence(report, examples, {
    one: { mode: "doctest", expect: ["first"] },
    two: { mode: "doctest", expect: ["second"] }
  }).map(({ id }) => id), ["one", "two"])
})

test("doctest evidence rejects missing, failed, mismatched, and duplicate tests", () => {
  const example = doctestExample("one", "docs/one.md", "first")
  const runtime = { one: { mode: "doctest", expect: ["first"] } }
  assert.throws(() => assertDoctestEvidence(doctestReport([]), [example], runtime), /coverage mismatch/)
  assert.throws(() => assertDoctestEvidence(doctestReport([{ source: "docs/one.md", title: "first", status: "failed" }]), [example], runtime), /status was failed/)
  assert.throws(() => assertDoctestEvidence(doctestReport([{ source: "docs/one.md", title: "other" }]), [example], runtime), /did not execute/)
  assert.throws(() => assertDoctestEvidence(doctestReport([{ source: "docs/one.md", title: "first" }]), [example], {
    one: { mode: "doctest", expect: ["missing evidence"] }
  }), /missed expected evidence/)
  const duplicate = doctestExample("two", "docs/one.md", "first", "two")
  assert.throws(() => assertDoctestEvidence(doctestReport([
    { source: "docs/one.md", title: "first" },
    { source: "docs/one.md", title: "first" }
  ]), [example, duplicate], {
    one: { mode: "doctest", expect: ["first"] },
    two: { mode: "doctest", expect: ["first"] }
  }), /duplicate source\/test identities/)
})
