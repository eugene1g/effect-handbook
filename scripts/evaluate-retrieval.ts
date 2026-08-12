#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { capabilities } from "../handbook.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dataset = JSON.parse(await readFile(path.join(root, "evals/retrieval-cases.json"), "utf8"))
const byId = new Map(capabilities.map((entry) => [entry.id, entry]))
const stopWords = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "one", "all", "over", "when", "after", "before", "between"])

assert(dataset.schemaVersion === 1, "Unsupported retrieval dataset schema")
assert(Array.isArray(dataset.cases) && dataset.cases.length >= 50, "Retrieval suite must contain at least 50 cases")
assert(new Set(dataset.cases.map((entry) => entry.id)).size === dataset.cases.length, "Retrieval case ids must be unique")

let recall1 = 0
let recall3 = 0
let reciprocalRank = 0
let expectedItems = 0
let completeCases = 0
const failures = []

for (const testCase of dataset.cases) {
  validateCase(testCase)
  const ranked = capabilities
    .map((entry) => ({ entry, score: score(testCase.query, entry) }))
    .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
  const ranks = testCase.expected.map((id) => ranked.findIndex(({ entry }) => entry.id === id) + 1)
  expectedItems += ranks.length
  recall1 += ranks.filter((rank) => rank === 1).length
  recall3 += ranks.filter((rank) => rank > 0 && rank <= 3).length
  reciprocalRank += ranks.reduce((total, rank) => total + (rank > 0 ? 1 / rank : 0), 0)
  const cutoff = testCase.match === "all" ? Math.max(3, testCase.expected.length) : 3
  const complete = testCase.match === "all"
    ? ranks.every((rank) => rank > 0 && rank <= cutoff)
    : ranks.some((rank) => rank > 0 && rank <= cutoff)
  if (complete) completeCases++
  else {
    failures.push({
      id: testCase.id,
      query: testCase.query,
      expected: testCase.expected,
      match: testCase.match ?? "any",
      ranks,
      cutoff,
      top: ranked.slice(0, 3).map(({ entry, score }) => ({ id: entry.id, score }))
    })
  }
}

const count = dataset.cases.length
const report = {
  cases: count,
  expectedItems,
  expectedItemRecallAt1: recall1 / expectedItems,
  expectedItemRecallAt3: recall3 / expectedItems,
  meanReciprocalRank: reciprocalRank / expectedItems,
  completeCaseRate: completeCases / count,
  failures
}

if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2))
else console.log(`Retrieval evaluation: ${count} cases / ${expectedItems} required primitives; item Recall@1 ${percent(report.expectedItemRecallAt1)}; item Recall@3 ${percent(report.expectedItemRecallAt3)}; complete-case ${percent(report.completeCaseRate)}; MRR ${report.meanReciprocalRank.toFixed(3)}.`)

assert(report.expectedItemRecallAt3 >= 0.95, `Expected-item Recall@3 ${percent(report.expectedItemRecallAt3)} is below the 95% gate\n${JSON.stringify(failures, null, 2)}`)
assert(report.expectedItemRecallAt1 >= 0.75, `Expected-item Recall@1 ${percent(report.expectedItemRecallAt1)} is below the 75% gate`)
assert(report.completeCaseRate >= 0.95, `Complete-case rate ${percent(report.completeCaseRate)} is below the 95% gate\n${JSON.stringify(failures, null, 2)}`)

function validateCase(testCase) {
  for (const field of ["id", "query"]) assert(typeof testCase[field] === "string" && testCase[field].trim() !== "", `${testCase.id ?? "case"} has no ${field}`)
  for (const field of ["expected", "acceptable", "forbidden"]) assert(Array.isArray(testCase[field]), `${testCase.id}.${field} must be an array`)
  assert(testCase.expected.length > 0, `${testCase.id} has no expected capability`)
  assert(testCase.match === undefined || testCase.match === "all" || testCase.match === "any", `${testCase.id}.match must be all or any`)
  assert(testCase.expected.length === 1 || testCase.match === "all", `${testCase.id} has multiple expected capabilities and must use match=all`)
  assert(testCase.forbidden.length > 0, `${testCase.id} has no forbidden anti-pattern`)
  for (const id of [...testCase.expected, ...testCase.acceptable]) assert(byId.has(id), `${testCase.id} references unknown capability ${id}`)
  for (const id of testCase.expected) {
    const capability = byId.get(id)
    for (const field of dataset.requiredCapabilityFields) assert(typeof capability[field] === "string" && capability[field].trim() !== "", `${testCase.id} expected capability ${id} has no ${field}`)
    assert(typeof capability.page === "string" && typeof capability.anchor === "string", `${testCase.id} expected capability ${id} has no canonical page/anchor`)
  }
}

function score(query, entry) {
  const normalizedQuery = normalize(query)
  const queryTokens = tokens(normalizedQuery)
  const querySet = new Set(queryTokens)
  const symbols = entry.symbols.map(normalize)
  const tasks = entry.tasks.map(normalize)
  const titleText = normalize([...entry.symbols, ...entry.imports.map((imported) => imported.path)].join(" "))
  const taskText = normalize(tasks.join(" "))
  const proseText = normalize([entry.summary, entry.chooseWhen, entry.avoidWhen].join(" "))
  let value = 0
  for (const task of tasks) {
    if (normalizedQuery === task) value += 200
    else if (normalizedQuery.includes(task)) value += 140
    const taskTokens = tokens(task)
    const overlap = taskTokens.filter((token) => querySet.has(token)).length
    if (overlap > 0) {
      value += 90 * (overlap / taskTokens.length)
      value += 30 * (overlap / queryTokens.length)
    }
  }
  for (const symbol of symbols) {
    if (normalizedQuery.includes(symbol)) value += symbol.length <= 6 && !symbol.includes(" ") ? 24 : 100
  }
  for (const token of queryTokens) {
    if (titleText.split(" ").includes(token)) value += 8
    if (taskText.split(" ").includes(token)) value += 5
    if (proseText.split(" ").includes(token)) value += 1
  }
  return value
}

function normalize(value) {
  return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function tokens(value) {
  return [...new Set(value.split(/\s+/).filter((token) => token.length > 2 && !stopWords.has(token)))]
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`
}

function assert(condition, message) {
  if (!condition) {
    console.error(`Retrieval evaluation failed: ${message}`)
    process.exit(1)
  }
}
