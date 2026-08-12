import assert from "node:assert/strict"
import * as FastCheck from "fast-check"
import {
  Cache,
  Channel,
  Chunk,
  Context,
  DateTime,
  Duration,
  Effect,
  ExecutionPlan,
  Formatter,
  JsonPatch,
  Layer,
  LayerRef,
  Random,
  Resource,
  Result,
  Schedule,
  Schema,
  SchemaIssue,
  SchemaRepresentation,
  ScopedRef,
  Stream
} from "effect"
import { McpProtocol } from "effect/unstable/ai"
import { CliConfig, GlobalFlag } from "effect/unstable/cli"
import { Ini, Toml, Yaml } from "effect/unstable/encoding"

const checks: Array<string> = []
const checked = (name: string) => checks.push(name)

// Schema.Number deliberately includes every JavaScript number. Domain models
// that reject NaN and infinities must opt into Schema.Finite.
// @effect-diagnostics-next-line schemaNumber:off
assert.equal(Schema.decodeUnknownSync(Schema.Number)(Number.POSITIVE_INFINITY), Infinity)
assert.throws(() => Schema.decodeUnknownSync(Schema.Finite)(Number.POSITIVE_INFINITY))
checked("Schema.Number and Schema.Finite runtime domains")

const hiddenInput = Schema.decodeUnknownResult(Schema.String)(123)
assert(Result.isFailure(hiddenInput))
assert.equal(SchemaIssue.hasInput(hiddenInput.failure.issue), false)

const reportedInput = Schema.decodeUnknownResult(Schema.String)(123, { reportInput: true })
assert(Result.isFailure(reportedInput))
assert.equal(SchemaIssue.hasInput(reportedInput.failure.issue), true)
assert.match(SchemaIssue.makeFormatterDefault()(reportedInput.failure.issue), /string/)
checked("SchemaIssue explicit formatting and opt-in input reporting")

const Employee = Schema.Struct({ id: Schema.Int, name: Schema.String })
const EmployeeArbitrary = Schema.toArbitrary(Employee)(FastCheck)
for (const employee of FastCheck.sample(EmployeeArbitrary, { numRuns: 10 })) {
  assert.equal(Schema.is(Employee)(employee), true)
}
checked("Schema.toArbitrary fast-check factory")

const JsonSchemaCompBand = Schema.Struct({
  level: Schema.Int.annotate({ description: "Job level" }),
  salaryMid: Schema.Int
})
const jsonSchemaDocument = Schema.toJsonSchemaDocument(JsonSchemaCompBand)
assert.equal(jsonSchemaDocument.dialect, "draft-2020-12")
assert.deepEqual(
  (jsonSchemaDocument.schema as any).properties.level,
  { type: "integer", allOf: [{ description: "Job level" }] }
)
checked("JSON Schema document wrapper and checked-field annotations")

const patchBefore = { recommendations: [{ salary: 100 }], approved: false }
const patchAfter = { recommendations: [{ salary: 110 }, { salary: 120 }], approved: true }
const jsonPatch = JsonPatch.get(patchBefore, patchAfter)
assert.deepEqual(jsonPatch.map((operation) => operation.path), [
  "/approved",
  "/recommendations/0/salary",
  "/recommendations/1"
])
assert.deepEqual(JsonPatch.apply(jsonPatch, patchBefore), patchAfter)
checked("JsonPatch deterministic operation order and application")

assert.equal(Formatter.formatJson({ shares: 4_000n }), '{"shares":"4000n"}')
checked("Formatter.formatJson encodes BigInt with an n suffix")

const checkedDocument = Schema.toRepresentation(Employee)
const checkedPersisted = SchemaRepresentation.toJson(checkedDocument)
const checkedRestored = SchemaRepresentation.fromJson(checkedPersisted)
assert.throws(
  () => SchemaRepresentation.fromRepresentation(checkedRestored, { revivers: [] }),
  /Missing reviver for effect\/schema\/isInt/
)

const PersistedEmployee = Schema.Struct({ id: Schema.String, name: Schema.String })
const document = Schema.toRepresentation(PersistedEmployee)
const persisted = SchemaRepresentation.toJson(document)
const restoredDocument = SchemaRepresentation.fromJson(persisted)
const restoredTop = SchemaRepresentation.fromRepresentation(restoredDocument, { revivers: [] })
const RestoredEmployee = Schema.make<Schema.Codec<{ readonly id: string; readonly name: string }>>(restoredTop.ast)
assert.deepEqual(
  Schema.decodeUnknownSync(RestoredEmployee)({ id: "e-7", name: "Ada" }),
  { id: "e-7", name: "Ada" }
)
checked("SchemaRepresentation persistence, restoration, and explicit check revivers")

assert.deepEqual(Channel.fromArray([[new Uint8Array([1, 2])], [new Uint8Array([3, 4])]] as const).pipe(
  Channel.mkUint8Array,
  Effect.runSync,
  Array.from
), [1, 2, 3, 4])
checked("Channel.mkUint8Array input and output shape")

const collected = Effect.runSync(Stream.runCollect(Stream.make("e1", "e2")))
assert.equal(globalThis.Array.isArray(collected), true)
assert.equal(Chunk.isChunk(collected), false)
assert.deepEqual(collected, ["e1", "e2"])
checked("Stream.runCollect returns Array")

const ini = Ini.parse("enabled=true\n[database.pool]\nsize=10")
assert.equal(ini.enabled, true)
assert.equal(Object.getPrototypeOf(ini), null)
assert.equal((ini.database as Record<string, Record<string, unknown>>).pool?.size, "10")

const toml = Toml.parse("title = \"Merit\"\n[database]\nenabled = true")
assert.equal(toml.title, "Merit")
assert.equal(Object.getPrototypeOf(toml), null)
assert.equal((toml.database as Record<string, unknown>).enabled, true)

const yaml = Yaml.parse("name: merit\nenabled: true\nports: [3000, 3001]")
assert.deepEqual(yaml, { name: "merit", enabled: true, ports: [3000, 3001] })
checked("INI, TOML, and YAML parser behavior")

assert.equal(McpProtocol.v2025_06_18.protocolVersion, "2025-06-18")
const cliConfig = CliConfig.make({ builtIns: [GlobalFlag.Help] })
assert.deepEqual(cliConfig.builtIns, [GlobalFlag.Help])
checked("MCP protocol adapter and CLI built-in configuration")

let retryAttempts = 0
const retried = Effect.suspend(() => {
  retryAttempts++
  return retryAttempts < 3 ? Effect.fail("transient") : Effect.succeed(retryAttempts)
}).pipe(Effect.retry(Schedule.recurs(2)))
assert.equal(Effect.runSync(retried), 3)
checked("Schedule.recurs retry boundary")

assert.deepEqual(
  Effect.runSync(Effect.gen(function*() {
    return [
      yield* Random.nextIntBetween(1, 5),
      yield* Random.nextIntBetween(1, 5),
      yield* Random.nextIntBetween(1, 5)
    ] as const
  }).pipe(Random.withSeed("merit-sim-v1"))),
  [1, 4, 3]
)
checked("Random.withSeed audited deterministic sequence")

const cliffStart = DateTime.makeUnsafe("2023-03-01T00:00:00Z")
const cliffDate = DateTime.add(cliffStart, { months: 12 })
assert.equal(DateTime.formatIsoDate(cliffDate), "2024-03-01")
assert.notEqual(
  DateTime.formatIsoDate(DateTime.addDuration(cliffStart, Duration.days(365))),
  DateTime.formatIsoDate(DateTime.add(cliffStart, { months: 12 }))
)
checked("calendar months differ from fixed 365-day duration across leap-year interval")

let cacheLookups = 0
const cacheProbe = await Effect.runPromise(Effect.gen(function*() {
  const cache = yield* Cache.make<string, number, string>({
    capacity: 2,
    lookup: (key) => Effect.suspend(() => {
      cacheLookups++
      return key === "failure" ? Effect.fail("failed") : Effect.succeed(key.length)
    })
  })
  yield* Effect.result(Cache.get(cache, "failure"))
  yield* Effect.result(Cache.get(cache, "failure"))
  yield* Cache.get(cache, "a")
  yield* Cache.get(cache, "bb")
  yield* Cache.get(cache, "a") // refresh access order
  yield* Cache.get(cache, "ccc")
  return {
    hasA: yield* Cache.has(cache, "a"),
    hasB: yield* Cache.has(cache, "bb")
  }
}))
assert.equal(cacheLookups, 4) // failed lookup once; a and bb misses, a hit, ccc miss
assert.deepEqual(cacheProbe, { hasA: true, hasB: false })
checked("Cache stores failed exits and evicts by access-order LRU")

const initialResourceFailure = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const resource = yield* Resource.manual(Effect.fail("initial acquisition failed" as const))
  return yield* Effect.result(Resource.get(resource))
})))
assert(Result.isFailure(initialResourceFailure))
assert.equal(initialResourceFailure.failure, "initial acquisition failed")
checked("Resource construction captures initial failure for first get")

const scopedRefEvents: Array<string> = []
const acquireNamed = (name: string) => Effect.acquireRelease(
  Effect.sync(() => {
    scopedRefEvents.push(`open:${name}`)
    return name
  }),
  () => Effect.sync(() => scopedRefEvents.push(`close:${name}`))
)
await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const ref = yield* ScopedRef.fromAcquire(acquireNamed("old"))
  yield* ScopedRef.set(ref, acquireNamed("new"))
})))
assert.deepEqual(scopedRefEvents, ["open:old", "open:new", "close:old", "close:new"])
checked("ScopedRef acquires replacement before closing old scope")

const Endpoint = Context.Service<{ readonly url: string }>("handbook-validation/Endpoint")
const fetchEndpoint = Effect.gen(function*() {
  const endpoint = yield* Endpoint
  return endpoint.url === "primary" ? yield* Effect.fail("unavailable" as const) : endpoint.url
})
const plan = ExecutionPlan.make(
  { provide: Layer.succeed(Endpoint, { url: "primary" }), attempts: 2 },
  { provide: Layer.succeed(Endpoint, { url: "backup" }) }
)
const planEvents: Array<string> = []
const selected = Effect.withExecutionPlan(fetchEndpoint, plan, {
  onEvent: (event) => Effect.sync(() => planEvents.push(`${event._tag}:${event.stepIndex}`))
})
assert.equal(Effect.runSync(selected), "backup")
assert.deepEqual(planEvents, [
  "AttemptStart:0",
  "AttemptFailure:0",
  "AttemptStart:0",
  "AttemptFailure:0",
  "AttemptStart:1",
  "AttemptSuccess:1"
])
checked("ExecutionPlan attempts, failover, and event order")

let generation = 0
class Catalog extends Context.Service<Catalog, { readonly generation: number }>()(
  "handbook-validation/Catalog"
) {}
const catalogLayer = Layer.sync(Catalog, () => ({ generation: ++generation }))
const layerRefResult = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const ref = yield* LayerRef.make(catalogLayer, {
    preload: true,
    idleTimeToLive: "1 minute"
  })
  const read = Effect.gen(function*() {
    return (yield* Catalog).generation
  })
  const before = yield* Effect.provide(read, ref.get)
  yield* ref.refresh
  const after = yield* Effect.provide(read, ref.get)
  return [before, after] as const
})))
assert.deepEqual(layerRefResult, [1, 2])
checked("LayerRef preload and refresh")

console.log(JSON.stringify({
  effect: "4.0.0-rc.108",
  nodeNativeTypeScript: true,
  checks
}, null, 2))
