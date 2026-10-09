import assert from "node:assert/strict"
import {
  ByteSize,
  Cache,
  Cause,
  Channel,
  Chunk,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  ExecutionPlan,
  Fiber,
  Filter,
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
  SchemaTransformation,
  ScopedRef,
  Stream
} from "effect"
import { McpProtocol } from "effect/ai"
import { Arbitrary } from "effect"
import { CliConfig, GlobalFlag } from "effect/cli"
import { Ini, SchemaBinary, Toml, Yaml } from "effect/encoding"
import { HttpClient, HttpClientResponse } from "effect/http"
import { KeyValueStore } from "effect/persistence"
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/rpc"

const checks: Array<string> = []
const checked = (name: string) => checks.push(name)

// Schema.Number deliberately includes every JavaScript number. Domain models
// that reject NaN and infinities must opt into Schema.Finite.
// @effect-diagnostics-next-line schemaNumber:off
assert.equal(Schema.decodeUnknownSync(Schema.Number)(Number.POSITIVE_INFINITY), Infinity)
assert.throws(() => Schema.decodeUnknownSync(Schema.Finite)(Number.POSITIVE_INFINITY))
checked("Schema.Number and Schema.Finite runtime domains")

const JsonDeclaration = Schema.declare(
  (value): value is { readonly id: string } =>
    typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
)
assert.deepEqual(Schema.encodeUnknownSync(Schema.toCodecJson(JsonDeclaration))({ id: "e-7" }), { id: "e-7" })
const UrlDeclaration = Schema.declare((value): value is URL => value instanceof URL)
assert.throws(
  () => Schema.encodeUnknownSync(Schema.toCodecJson(UrlDeclaration))(new URL("https://example.com")),
  /Expected JSON value/
)
checked("bare declarations encode JSON-native values but reject non-JSON values without a representation")

const DollarsFromCents = Schema.Int.pipe(Schema.decodeTo(Schema.Finite, SchemaTransformation.transform({
  decode: (cents) => cents / 100,
  encode: (dollars) => Math.round(dollars * 100)
})))
const decodeCents = Schema.decodeUnknownSync(DollarsFromCents)
const encodeDollars = Schema.encodeUnknownSync(DollarsFromCents)
assert.equal(encodeDollars(decodeCents(12_345)), 12_345)
assert.equal(encodeDollars(decodeCents(9_007_199_254_740_990)), 9_007_199_254_740_991)
assert.equal(decodeCents(encodeDollars(1.234)), 1.23)
checked("floating-point cents conversion loses precision within the accepted safe-integer and finite domains")

const hiddenInput = Schema.decodeUnknownResult(Schema.String)(123)
assert(Result.isFailure(hiddenInput))
assert.equal(SchemaIssue.hasInput(hiddenInput.failure.issue), false)

const reportedInput = Schema.decodeUnknownResult(Schema.String)(123, { reportInput: true })
assert(Result.isFailure(reportedInput))
assert.equal(SchemaIssue.hasInput(reportedInput.failure.issue), true)
assert.match(SchemaIssue.makeFormatterDefault()(reportedInput.failure.issue), /string/)
checked("SchemaIssue explicit formatting and opt-in input reporting")

const Employee = Schema.Struct({ id: Schema.Int, name: Schema.String })
const EmployeeArbitrary = Arbitrary.schema(Employee)
const employeeSamples = await Effect.runPromise(Arbitrary.sampleEffect(EmployeeArbitrary, { count: 10, seed: 42 }))
assert.equal(employeeSamples.length, 10)
for (const employee of employeeSamples) {
  assert.equal(Schema.is(Employee)(employee), true)
}
assert.deepEqual(
  await Effect.runPromise(Arbitrary.sampleEffect(EmployeeArbitrary, { count: 10, seed: 42 })),
  employeeSamples
)
checked("native Arbitrary.schema sampling is Schema-valid and seed-deterministic")

const passedCheck = await Effect.runPromise(
  Arbitrary.checkEffect(EmployeeArbitrary, Schema.is(Employee), { runs: 50, seed: 1 })
)
assert.equal(passedCheck._tag, "Passed")
const falsifiedCheck = await Effect.runPromise(
  Arbitrary.checkEffect(Arbitrary.schema(Schema.Int), (n) => n < 5, { runs: 200, seed: 1 })
)
assert.equal(falsifiedCheck._tag, "Falsified")
assert(falsifiedCheck._tag === "Falsified")
assert.equal(falsifiedCheck.shrunkInput, 5)
assert.deepEqual(falsifiedCheck.failure, { _tag: "ReturnedFalse" })
assert.equal(typeof falsifiedCheck.replay, "string")
assert.equal(typeof Arbitrary.formatCheckFailure(falsifiedCheck), "string")
assert.equal(Arbitrary.formatCheckFailure(passedCheck), undefined)
const replayedCheck = await Effect.runPromise(
  Arbitrary.checkEffect(Arbitrary.schema(Schema.Int), (n) => n < 5, { replay: falsifiedCheck.replay })
)
assert.equal(replayedCheck._tag, "Falsified")
const exhaustedCheck = await Effect.runPromise(
  Arbitrary.checkEffect(
    Arbitrary.schema(Schema.Int.check(Schema.makeFilter(() => false))),
    () => true,
    { runs: 10, seed: 1, maxDiscards: 50 }
  )
)
assert.equal(exhaustedCheck._tag, "Exhausted")
checked("Arbitrary.checkEffect returns Passed/Falsified/Exhausted data, shrinks, and replays")

const unconstrainedInts = await Effect.runPromise(
  Arbitrary.sampleEffect(Arbitrary.schema(Schema.Int), { count: 400, seed: 1 })
)
assert(unconstrainedInts.every((n) => Math.abs(n) <= 100))
const boundedInts = await Effect.runPromise(
  Arbitrary.sampleEffect(
    Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 50_000, maximum: 300_000 }))),
    { count: 200, seed: 1 }
  )
)
assert(boundedInts.every((n) => n >= 50_000 && n <= 300_000))
checked("Arbitrary default size keeps unconstrained ints small; explicit Schema bounds are honored")

const probeUpload = ByteSize.mebibytes(25)
assert.equal(ByteSize.toBigInt(probeUpload), 26_214_400n)
assert.equal(ByteSize.format(probeUpload), "25 MiB")
assert.equal(ByteSize.format(probeUpload, { system: "decimal" }), "26.21 MB")
assert.equal(ByteSize.format(probeUpload, { unit: "KiB", precision: 0 }), "25600 KiB")
assert.deepEqual(ByteSize.fromInput("64 KiB"), ByteSize.fromInput(65_536))
assert.deepEqual(ByteSize.fromString("1.5 KiB"), ByteSize.fromInput(1536))
assert.equal(ByteSize.fromString("1.5 B")._tag, "None")
assert.equal(ByteSize.fromInput(-1)._tag, "None")
assert.equal(ByteSize.divide(probeUpload, 0)._tag, "None")
checked("ByteSize exact units, binary-default formatting, and partial parsing/arithmetic")

// 4.0.2: Stream.partition yields [passes, fails]; Effect.orElseSucceed receives the error; Stream.scan seeds lazily.
const [evens, odds] = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const [passes, fails] = yield* Stream.partition(
    Stream.make(1, 2, 3, 4),
    Filter.fromPredicate((n: number) => n % 2 === 0),
    { capacity: 4 }
  )
  return yield* Effect.all([Stream.runCollect(passes), Stream.runCollect(fails)], { concurrency: 2 })
})))
assert.deepEqual([evens, odds], [[2, 4], [1, 3]])
assert.equal(await Effect.runPromise(Effect.fail("stale").pipe(Effect.orElseSucceed((error) => `fallback:${error}`))), "fallback:stale")
assert.deepEqual(await Effect.runPromise(Stream.runCollect(Stream.make(1, 2, 3).pipe(Stream.scan(() => 0, (sum, n) => sum + n)))), [0, 1, 3, 6])
checked("Stream.partition order, Effect.orElseSucceed error argument, and lazy Stream.scan seed")

// 4.0.2: Stream.scan emits its seed for an empty stream; Effect.retry does not retry a cause that
// contains a defect; a pending interruption wins when an uninterruptible region fails.
assert.deepEqual(await Effect.runPromise(Stream.runCollect(Stream.empty.pipe(Stream.scan(() => 0, (sum: number, n: number) => sum + n)))), [0])
let mixedCauseAttempts = 0
await Effect.runPromiseExit(
  Effect.suspend(() => {
    mixedCauseAttempts++
    return Effect.failCause(Cause.combine(Cause.fail("typed"), Cause.die("defect")))
  }).pipe(Effect.retry({ times: 3 }))
)
assert.equal(mixedCauseAttempts, 1)
const pendingInterrupt = await Effect.runPromise(Effect.gen(function*() {
  const started = yield* Deferred.make<void>()
  let recovered = false
  const fiber = yield* Effect.forkChild(
    Effect.uninterruptible(Effect.gen(function*() {
      yield* Deferred.succeed(started, undefined)
      yield* Effect.sleep("10 millis")
      return yield* Effect.fail("typed")
    })).pipe(Effect.catch(() => Effect.sync(() => { recovered = true })))
  )
  yield* Deferred.await(started)
  yield* Fiber.interrupt(fiber)
  const exit = yield* Fiber.await(fiber)
  return { recovered, interruptedOnly: exit._tag === "Failure" && exit.cause.reasons.every((reason) => reason._tag === "Interrupt") }
}))
assert.deepEqual(pendingInterrupt, { recovered: false, interruptedOnly: true })
checked("Stream.scan seed on empty streams, Effect.retry skipping defect causes, and pending interruption over a failed uninterruptible region")

const BinaryFrame = Schema.Struct({ runId: Schema.String.pipe(SchemaBinary.fieldId(1)), netPay: Schema.Finite })
const binaryCodec = SchemaBinary.toCodec(BinaryFrame)
const binaryBytes = Schema.encodeUnknownSync(binaryCodec)({ runId: "run_2025_06", netPay: 6100 })
assert(binaryBytes instanceof Uint8Array)
assert.deepEqual(Schema.decodeUnknownSync(binaryCodec)(binaryBytes), { runId: "run_2025_06", netPay: 6100 })
const binaryRoundTrip = await Effect.runPromise(
  Stream.make({ runId: "a", netPay: 1 }, { runId: "b", netPay: 2 }).pipe(
    Stream.pipeThroughChannel(SchemaBinary.encode(BinaryFrame)()),
    Stream.pipeThroughChannel(SchemaBinary.decode(BinaryFrame, { maxFrameSize: 1024 })()),
    Stream.runCollect
  )
)
assert.deepEqual(binaryRoundTrip, [{ runId: "a", netPay: 1 }, { runId: "b", netPay: 2 }])
const truncatedFrame = await Effect.runPromiseExit(
  Stream.make(binaryBytes.slice(0, binaryBytes.length - 1)).pipe(
    Stream.pipeThroughChannel(SchemaBinary.decode(BinaryFrame)()),
    Stream.runCollect
  )
)
assert.equal(truncatedFrame._tag, "Failure")
checked("SchemaBinary codec and channels round-trip; a truncated trailing frame fails")

const JsonSchemaCompBand = Schema.Struct({
  level: Schema.Int.annotate({ description: "Job level" }),
  salaryMid: Schema.Int
})
const jsonSchemaDocument = Schema.toJsonSchemaDocument(JsonSchemaCompBand)
assert.equal(jsonSchemaDocument.dialect, "draft-2020-12")
assert.deepEqual(
  (jsonSchemaDocument.schema as any).properties.level,
  { type: "integer", description: "Job level" }
)
assert.equal((jsonSchemaDocument.schema as any).additionalProperties, true)
assert.equal(
  (Schema.toJsonSchemaDocument(JsonSchemaCompBand, { onExcessProperty: "error" }).schema as any).additionalProperties,
  false
)
checked("JSON Schema document wrapper, compacted annotations, and open-by-default objects")

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

await Effect.runPromise(Effect.gen(function*() {
  const store = yield* KeyValueStore.KeyValueStore
  let callbackCalled = false
  assert.equal(yield* store.modify("missing", () => {
    callbackCalled = true
    return "created"
  }), undefined)
  assert.equal(callbackCalled, false)
  assert.equal(yield* store.get("missing"), undefined)
  yield* store.set("version", "0")
  assert.equal(yield* store.modify("version", (value) => String(Number(value) + 1)), "1")

  // Model an asynchronous backend: both callers read the same snapshot before
  // either can write. Preserve primitives, not the memory store's derived modify.
  const { modify: _modify, modifyUint8Array: _modifyBytes, ...primitives } = store
  const bothRead = yield* Deferred.make<void>()
  let reads = 0
  const asynchronousStore = KeyValueStore.make({
    ...primitives,
    get: (key) => Effect.gen(function*() {
      const snapshot = yield* store.get(key)
      if (++reads === 2) yield* Deferred.succeed(bothRead, undefined)
      yield* Deferred.await(bothRead)
      return snapshot
    })
  })
  yield* Effect.all([
    asynchronousStore.modify("version", (value) => String(Number(value) + 1)),
    asynchronousStore.modify("version", (value) => String(Number(value) + 1))
  ], { concurrency: 2 })
  assert.equal(yield* store.get("version"), "2", "two increments from 1 lose one update")
}).pipe(Effect.provide(KeyValueStore.layerMemory), Effect.timeout("5 seconds")))
checked("KeyValueStore.modify skips missing keys and its derived read-modify-write is not atomic")

let rpcRequestsSent = 0
const emptyResponseClient = HttpClient.make((request) => Effect.sync(() => {
  rpcRequestsSent++
  return HttpClientResponse.fromWeb(request, new Response("[]", { status: 200 }))
}))
const rpcProtocol = RpcClient.layerProtocolHttp({ url: "http://example.test/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, emptyResponseClient))
)
const rpcResult = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const client = yield* RpcClient.make(RpcGroup.make(Rpc.make("Ping", { success: Schema.String })))
  return yield* Effect.result(client.Ping())
})).pipe(Effect.provide(rpcProtocol), Effect.timeout("5 seconds")))
assert.equal(rpcRequestsSent, 1)
assert(Result.isFailure(rpcResult))
assert.equal(rpcResult.failure._tag, "RpcClientError")
assert.equal(rpcResult.failure.reason._tag, "RpcClientDefect")
assert.equal(rpcResult.failure.reason.message, "Received empty HTTP response from RPC server")
checked("RpcClientError can occur after sending a request and receiving an HTTP response")

console.log(JSON.stringify({
  effect: "4.0.2",
  nodeNativeTypeScript: true,
  checks
}, null, 2))
