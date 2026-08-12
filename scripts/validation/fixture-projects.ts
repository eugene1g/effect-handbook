import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { exactContextualGroups } from "../../validation/fixtures/exact-groups.ts"
import { generatedRoot, repositoryRoot, validationRoot } from "./example-model.ts"

const fixtureRoot = path.join(validationRoot, "fixtures")
const contextualRoot = path.join(generatedRoot, "contextual-projects")
const SUPPORTED_FIXTURES = new Set(["base", "http-rpc", "reactivity-core", "reactivity-transport", "reactivity-app", "application", "failure", "schema", "worker", "testing", "ai", "streaming", "troubleshooting"])

export function assertKnownContextualFixtures(examples) {
  for (const example of examples.filter((item) => item.disposition === "contextual")) {
    if (!SUPPORTED_FIXTURES.has(example.fixture)) throw new Error(`${example.id}: unknown contextual fixture ${example.fixture}`)
  }
}

const byId = (examples) => new Map(examples.map((example) => [example.id, example]))

const writeExact = async (example, destination, { prefix = "", suffix = "" } = {}) => {
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, `${prefix}${example.body}${suffix}`)
  const generated = await readFile(destination, "utf8")
  if (!generated.includes(example.body)) throw new Error(`${example.id}: contextual fixture does not consume the exact Markdown body`)
}

const copyFixture = async (name, destination) => {
  await cp(path.join(fixtureRoot, name), destination, { recursive: true })
}

const compileProject = (name, include, compilerOptions = {}) => ({
  name,
  config: {
    extends: path.relative(path.join(contextualRoot, name), path.join(validationRoot, "tsconfig.base.json")),
    compilerOptions,
    include
  }
})

const HTTP_DESTINATIONS = {
  "httpapi.endpoint-contract": "fixtures/httpapi.endpoint-contract/src/example.ts",
  "httpapi.group-contract": "fixtures/httpapi.group-contract/src/example.ts",
  "httpapi.application-contract": "fixtures/httpapi.application-contract/src/example.ts",
  "httpapi.response-schema": "fixtures/httpapi.response-schema/src/example.ts",
  "httpapi.authorization-contract": "fixtures/httpapi.authorization-contract/src/api/example.ts",
  "httpapi.authorization-layer": "fixtures/httpapi.authorization-layer/src/api/example.ts",
  "httpapi.group-handlers": "fixtures/httpapi.group-handlers/src/server/Comp/example.ts",
  "httpapi.server-layer": "fixtures/httpapi.server-layer/src/example.ts",
  "httpapi.typed-client": "fixtures/httpapi.typed-client/src/example.ts",
  "httpapi.openapi-document": "fixtures/httpapi.openapi-document/src/example.ts",
  "httpapi.swagger-route": "fixtures/httpapi.swagger-route/src/example.ts",
  "httpapi.scalar-route": "fixtures/httpapi.scalar-route/src/example.ts",
  "httpapi.in-process-test": "fixtures/httpapi.in-process-test/src/example.ts",
  "rpc.server-http-route": "fixtures/rpc.server-http-route/src/example.ts",
  "rpc.typed-client": "fixtures/rpc.typed-client/src/example.ts",
  "rpc.client-error-recovery": "fixtures/rpc.client-error-recovery/src/example.ts",
  "rpc.authenticated-middleware-layer": "fixtures/rpc.authenticated-middleware-layer/src/example.ts",
  "rpc.in-process-test": "fixtures/rpc.in-process-test/src/example.ts"
}

export async function materializeContextualProjects(examples) {
  assertKnownContextualFixtures(examples)
  const ids = byId(examples)
  const projects = []
  const consumed = new Set()

  const baseDir = path.join(contextualRoot, "base")
  await copyFixture("contextual-exact", baseDir)
  const base = examples.filter((example) => example.fixture === "base")
  for (const example of base) { await writeExact(example, path.join(baseDir, `${example.id}.${example.language}`)); consumed.add(example.id) }
  projects.push(compileProject("base", ["**/*.ts", "**/*.tsx"], {
    rootDirs: [".", path.relative(baseDir, path.join(fixtureRoot, "contextual-exact"))]
  }))

  const httpDir = path.join(contextualRoot, "http-rpc")
  await copyFixture("http-rpc", httpDir)
  const http = examples.filter((example) => example.fixture === "http-rpc")
  for (const example of http) {
    const destination = HTTP_DESTINATIONS[example.id]
    if (!destination) throw new Error(`${example.id}: no HTTP/RPC fixture destination`)
    await writeExact(example, path.join(httpDir, destination))
    consumed.add(example.id)
  }
  await writeFile(path.join(httpDir, "globals.d.ts"), `import type { Api as ApiValue, AuthorizationLayer as AuthorizationLayerValue, CompApiHandlers as CompApiHandlersValue, SystemApiHandlers as SystemApiHandlersValue } from "./shared/http-app.ts"\nimport type { Authenticated as AuthenticatedValue, CompClient, CompLive as CompLiveValue, CompRpc as CompRpcValue, CurrentManager as CurrentManagerValue } from "./shared/rpc-app.ts"\ndeclare global {\n const Api: typeof ApiValue\n const AuthorizationLayer: typeof AuthorizationLayerValue\n const CompApiHandlers: typeof CompApiHandlersValue\n const SystemApiHandlers: typeof SystemApiHandlersValue\n const CompRpc: typeof CompRpcValue\n const CompLive: typeof CompLiveValue\n const client: CompClient\n const Authenticated: typeof AuthenticatedValue\n const CurrentManager: typeof CurrentManagerValue\n}\nexport {}\n`)
  projects.push(compileProject("http-rpc", ["**/*.ts"], { rootDir: "." }))

  for (const fixture of ["reactivity-core", "reactivity-transport"]) {
    const directory = path.join(contextualRoot, fixture)
    await mkdir(directory, { recursive: true })
    const fixtureFile = fixture === "reactivity-core" ? "reactivity/globals.ts" : "reactivity/transport-globals.ts"
    await copyFixture(fixtureFile, path.join(directory, "globals.ts"))
    for (const example of examples.filter((item) => item.fixture === fixture)) {
      await writeExact(example, path.join(directory, `${example.id}.${example.language}`))
      consumed.add(example.id)
    }
    projects.push(compileProject(fixture, ["**/*.ts", "**/*.tsx"]))
  }

  const appDir = path.join(contextualRoot, "reactivity-app")
  await mkdir(appDir, { recursive: true })
  await copyFixture("reactivity/app/atoms.ts", path.join(appDir, "atoms.ts"))
  for (const example of examples.filter((item) => item.fixture === "reactivity-app")) {
    await writeExact(example, path.join(appDir, `${example.id}.${example.language}`))
    consumed.add(example.id)
  }
  projects.push(compileProject("reactivity-app", ["**/*.ts", "**/*.tsx"]))

  const testingDir = path.join(contextualRoot, "testing")
  await copyFixture("deep-dives/testing", testingDir)
  await writeExact(ids.get("testing.deterministic-layer"), path.join(testingDir, "test", "approval-layers.ts"))
  await writeExact(ids.get("testing.success-order"), path.join(testingDir, "test", "approval-success.test.ts"))
  await writeExact(ids.get("testing.typed-failure"), path.join(testingDir, "test", "approval-failure.test.ts"))
  for (const id of ["testing.deterministic-layer", "testing.success-order", "testing.typed-failure"]) consumed.add(id)
  projects.push(compileProject("testing", ["**/*.ts"]))

  const streamingDir = path.join(contextualRoot, "streaming")
  await copyFixture("deep-dives/streaming", streamingDir)
  await writeExact(ids.get("streaming.batched-ingestion"), path.join(streamingDir, "src", "employee-import.ts"))
  await writeExact(ids.get("streaming.file-source"), path.join(streamingDir, "src", "filesystem.ts"))
  await writeExact(ids.get("streaming.http-source"), path.join(streamingDir, "src", "http.ts"))
  await writeExact(ids.get("streaming.bounded-runtime-test"), path.join(streamingDir, "test", "employee-import.test.ts"))
  for (const id of ["streaming.batched-ingestion", "streaming.file-source", "streaming.http-source", "streaming.bounded-runtime-test"]) consumed.add(id)
  projects.push(compileProject("streaming", ["**/*.ts"]))

  const aiDir = path.join(contextualRoot, "ai")
  await mkdir(aiDir, { recursive: true })
  await copyFixture("deep-dives/ai/policy-tools.ts", path.join(aiDir, "policy-tools.ts"))
  await writeExact(ids.get("ai.provider-neutral-service"), path.join(aiDir, "policy-assistant.ts"))
  consumed.add("ai.provider-neutral-service")
  projects.push(compileProject("ai", ["**/*.ts"]))

  for (const [fixture, definition] of Object.entries(exactContextualGroups)) {
    const directory = path.join(contextualRoot, fixture)
    await mkdir(directory, { recursive: true })
    const fixtureExamples = examples.filter((example) => example.fixture === fixture)
    const unmatched = new Set(Object.keys(definition.files))
    for (const example of fixtureExamples) {
      const file = definition.files[example.id]
      if (!file) throw new Error(`${example.id}: no exact contextual scaffold in ${fixture}`)
      await writeExact(example, path.join(directory, file.destination), { prefix: file.prefix ?? "", suffix: file.suffix ?? "" })
      unmatched.delete(example.id)
      consumed.add(example.id)
    }
    if (unmatched.size > 0) throw new Error(`${fixture}: orphan exact contextual scaffolds ${[...unmatched].join(", ")}`)
    for (const [destination, contents] of Object.entries(definition.support ?? {})) {
      const output = path.join(directory, destination)
      await mkdir(path.dirname(output), { recursive: true })
      await writeFile(output, contents)
    }
    projects.push(compileProject(fixture, ["**/*.ts"]))
  }

  const troubleshootingDir = path.join(contextualRoot, "troubleshooting")
  await mkdir(troubleshootingDir, { recursive: true })
  const troubleshootingPrefixes = {
    "troubleshooting.effect-not-run": `import { Effect } from "effect"\ndeclare const employee: { readonly id: string }\ndeclare const saveEmployee: (employee: { readonly id: string }) => Effect.Effect<void>\ndeclare const validateEmployee: (employee: { readonly id: string }) => Effect.Effect<{ readonly id: string }>\n`,
    "troubleshooting.missing-service": `import { Context, Effect, Layer } from "effect"\nclass Users extends Context.Service<Users, {}>()("fixture/Users") {}\ndeclare const makeUsers: Effect.Effect<{}>\ndeclare const SqlLive: Layer.Layer<never>\ndeclare const program: Effect.Effect<void, never, Users>\n`,
    "troubleshooting.failure-vs-defect": `import { Effect, Schema } from "effect"\nclass NetworkError extends Schema.TaggedError<NetworkError>()("NetworkError", { cause: Schema.Defect() }) {}\ndeclare const url: string\ndeclare const cachedResponse: Effect.Effect<Response>\n`,
    "troubleshooting.scope-lifetime": `import { Context, Effect } from "effect"\nclass Connection { execute(_: string) { return Effect.succeed([] as ReadonlyArray<unknown>) } }\nconst FixturePool = Context.Service<{ readonly get: (_pool: unknown) => Effect.Effect<Connection> }>("fixture/Pool")\nconst Pool = { get: (_pool: unknown) => Effect.succeed(new Connection()) }\ndeclare const pool: typeof FixturePool.Service\n`,
    "troubleshooting.hanging-clock-fiber": `import { Effect, Fiber } from "effect"\nimport { TestClock } from "effect/testing"\nexport const wrapped = Effect.gen(function*() {\n`,
    "troubleshooting.typed-retry-channel": `import { Effect, Schedule, Schema } from "effect"\nclass HttpError extends Schema.TaggedError<HttpError>()("HttpError", { retryable: Schema.Boolean }) {}\ndeclare const callProvider: Effect.Effect<Response, HttpError>\ndeclare const reportPermanentFailure: (error: HttpError) => Effect.Effect<Response>\n`,
    "troubleshooting.schema-type-encoded": `import { Effect, Schema } from "effect"\n`
  }
  for (const example of examples.filter((item) => item.fixture === "troubleshooting")) {
    await writeExact(example, path.join(troubleshootingDir, `${example.id}.ts`), {
      prefix: troubleshootingPrefixes[example.id],
      suffix: example.id === "troubleshooting.hanging-clock-fiber" ? "\n})\n" : ""
    })
    consumed.add(example.id)
  }
  projects.push(compileProject("troubleshooting", ["**/*.ts"]))

  for (const project of projects) {
    const directory = path.join(contextualRoot, project.name)
    const config = { ...project.config, extends: path.relative(directory, path.join(validationRoot, "tsconfig.base.json")) }
    await writeFile(path.join(directory, "tsconfig.json"), `${JSON.stringify(config, null, 2)}\n`)
  }
  const contextual = examples.filter((example) => example.disposition === "contextual")
  const missing = contextual.filter((example) => !consumed.has(example.id))
  if (missing.length > 0) throw new Error(`Unconsumed contextual examples: ${missing.map((example) => `${example.id} (${example.fixture})`).join(", ")}`)
  if (consumed.size !== contextual.length) throw new Error(`Contextual fixture coverage mismatch: ${consumed.size} consumed for ${contextual.length} examples`)
  return projects.map((project) => ({ name: project.name, config: path.join(contextualRoot, project.name, "tsconfig.json") }))
}
