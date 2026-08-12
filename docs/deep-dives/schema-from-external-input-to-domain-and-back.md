# Schema — From External Input to Domain and Back

Effect Schema is most useful when it owns a complete boundary, not just an isolated validation call. This guide follows one value from untrusted JSON, form, or query input into a domain model, through application logic, and back to a JSON-safe representation. It targets `effect@4.0.0-rc.108`.

Use [Schema](../data/schema) for the complete module reference, [Errors, Option & Result](../foundations/errors-option-result) for failure modeling, [Configuration & Secrets](../foundations/configuration-secrets) for StringTree-backed configuration, and [HttpApi](../interfaces/http-api), [RPC](../interfaces/rpc), [SQL](../interfaces/sql), and [Persistence](../tooling/persistence) for the boundaries that consume Schemas.

## The boundary pipeline

A robust data path has five explicit stages:

1. **Carrier** — unknown JSON, text, `FormData`, `URLSearchParams`, a database row, or an RPC payload.
2. **Codec** — a `Schema.Codec<Type, Encoded, DecodingServices, EncodingServices>` that validates and transforms in both directions.
3. **Domain value** — the decoded `Type`, which application code can trust.
4. **Application logic** — services accept domain values and return domain values or typed errors; they do not cast unknown data.
5. **Representation** — encoding validates the outbound value and turns it into the exact carrier/storage shape.

The important distinction is `Type` versus `Encoded`. `Schema.DateFromString` has `Type = Date` and `Encoded = string`; `Schema.FiniteFromString` has `Type = number` and `Encoded = string`. A plain `Schema.Date` validates an in-memory `Date` but does not by itself claim that the wire contains an ISO string.

### Pick the runner for the surrounding code

The same Schema can be run in several styles. Pick at the boundary rather than forcing the whole application into one error representation.

| Surrounding code | Runner | Failure shape |
| --- | --- | --- |
| Effect program | `decodeUnknownEffect` / `encodeUnknownEffect` | typed `SchemaError` channel |
| Pure branching | `decodeUnknownResult` / `encodeUnknownResult` | `Result` |
| Optional probe | `decodeUnknownOption` or `.makeOption` | `Option` |
| Validated trusted edge | `decodeUnknownSync` / `encodeUnknownSync` | throws `SchemaError` |
| Promise-only host | `decodeUnknownPromise` / `encodeUnknownPromise` | rejected Promise |

Prefer the Effect runner inside services. Use a throwing runner only at an edge that already communicates through exceptions, and catch there.

## Start with the external contract

Suppose an API accepts a grant request as JSON. The external timestamp is text; the domain wants a `Date`. The identifier is a positive branded integer, and shares are a non-negative safe integer.

> **Example status — Runnable:** the block decodes a JSON request into a typed value.

```ts
import { Effect, Schema } from "effect"

const EmployeeId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("EmployeeId")
)
type EmployeeId = typeof EmployeeId.Type

const CreateGrantRequest = Schema.Struct({
  employeeId: EmployeeId,
  shares: Schema.Natural,
  grantedAt: Schema.DateFromString,
  note: Schema.optionalKey(Schema.String)
}).annotate({
  title: "CreateGrantRequest",
  description: "External request for a new equity grant"
})

type CreateGrantRequest = typeof CreateGrantRequest.Type
type CreateGrantRequestEncoded = typeof CreateGrantRequest.Encoded

const CreateGrantFromJsonText = Schema.fromJsonString(CreateGrantRequest)

const input = `{
  "employeeId": 42,
  "shares": 4000,
  "grantedAt": "2026-08-12T10:00:00.000Z"
}`

const program = Effect.gen(function*() {
  const request = yield* Schema.decodeUnknownEffect(CreateGrantFromJsonText)(input)
  return {
    id: request.employeeId,
    isDate: request.grantedAt instanceof Date,
    iso: request.grantedAt.toISOString()
  }
})

console.log(await Effect.runPromise(program))
// { id: 42, isDate: true, iso: "2026-08-12T10:00:00.000Z" }
```

The decoded type does not contain `unknown`, and `grantedAt` is already a valid `Date`. Invalid JSON, missing keys, a non-integer id, negative shares, and invalid date text all fail in the Schema error channel before business logic runs.

Do not parse with `JSON.parse`, cast the result, and then validate selected fields later. `Schema.fromJsonString(schema)` composes parsing and validation into one reversible codec.

## Separate transport input from the domain model

Sometimes the transport contract and domain value happen to have the same fields. They still have different responsibilities: a request describes what an external caller may submit; a domain class describes what the application owns after acceptance.

Keep domain-only fields, generated identifiers, and invariants out of the incoming schema. Construct the domain value after policy succeeds.

> **Example status — Contextual:** it uses `EmployeeId` and `CreateGrantRequest` from the preceding block.

```ts
import { Clock, Effect, Schema } from "effect"

const GrantId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("GrantId")
)

class Grant extends Schema.Class<Grant>("handbook/Grant")({
  id: GrantId,
  employeeId: EmployeeId,
  shares: Schema.Natural,
  grantedAt: Schema.Date,
  recordedAt: Schema.Date
}) {}

class GrantPolicyViolation extends Schema.TaggedError<GrantPolicyViolation>()(
  "GrantPolicyViolation",
  { employeeId: EmployeeId, reason: Schema.String }
) {}

const acceptGrant = Effect.fn("acceptGrant")(
  function*(request: CreateGrantRequest) {
    if (request.shares === 0) {
      return yield* new GrantPolicyViolation({
        employeeId: request.employeeId,
        reason: "a grant must contain at least one share"
      })
    }

    const now = new Date(yield* Clock.currentTimeMillis)
    const id = yield* Schema.decodeUnknownEffect(GrantId)(
      `${request.employeeId}:${request.grantedAt.toISOString()}`
    )

    return new Grant({
      id,
      employeeId: request.employeeId,
      shares: request.shares,
      grantedAt: request.grantedAt,
      recordedAt: now
    })
  }
)
```

Schema validation answers “does this input have the required shape and local constraints?” Domain policy answers “may this operation happen now?” Keep that distinction visible. A current-budget lookup or uniqueness check is application behavior, not a synchronous field validator.

## Encode outbound values deliberately

`Schema.Date` validates a runtime `Date`, but `Date` is not a JSON value. `Schema.toCodecJson(domainSchema)` derives a JSON-safe representation for supported values such as `Date`, `BigInt`, `Uint8Array`, maps, sets, classes, and `Option`. Compose that representation with `fromJsonString` when the carrier itself is JSON text.

> **Example status — Contextual:** this round-trips the `Grant` class above through JSON-safe data and JSON text.

```ts
import { Schema } from "effect"

const GrantJson = Schema.toCodecJson(Grant)
const GrantJsonText = Schema.fromJsonString(GrantJson)

declare const grant: Grant

// Domain Grant -> JSON string. Dates become canonical JSON-safe values.
const text = Schema.encodeUnknownSync(GrantJsonText)(grant)

// JSON string -> validated Grant instance.
const restored = Schema.decodeUnknownSync(GrantJsonText)(text)

console.log(restored instanceof Grant) // true
console.log(restored.recordedAt instanceof Date) // true
```

Do not assume `JSON.stringify(domainValue)` is the inverse of parsing it. Native JSON loses `Date`, `BigInt`, `Map`, `Set`, class identity, and other domain semantics. A canonical codec states and tests the reversible representation.

Custom declared types can attach a `toCodecJson` annotation. JSON Schema generation reuses that representation, keeping runtime serialization and published contracts aligned. If a type has no valid JSON representation, derivation should fail instead of silently inventing one.

## Adapt forms, query strings, config, and JSON

The domain Schema should not change just because the carrier changes. Derive a carrier codec around it.

`FormData` and `URLSearchParams` contain string-like leaves and use bracket notation for nested values. First derive the domain's StringTree codec, then wrap it with the carrier decoder.

> **Example status — Runnable:** modern Node and browsers provide both Web-standard carrier classes.

```ts
import { Schema } from "effect"

const GrantSearch = Schema.Struct({
  employeeId: Schema.Int.check(Schema.isGreaterThan(0)),
  minimumShares: Schema.Natural,
  includeCancelled: Schema.Boolean
})

const GrantSearchStringTree = Schema.toCodecStringTree(GrantSearch)
const GrantSearchFromQuery = Schema.fromURLSearchParams(GrantSearchStringTree)
const GrantSearchFromForm = Schema.fromFormData(GrantSearchStringTree)

const query = new URLSearchParams({
  employeeId: "42",
  minimumShares: "1000",
  includeCancelled: "false"
})

const form = new FormData()
form.set("employeeId", "42")
form.set("minimumShares", "1000")
form.set("includeCancelled", "false")

console.log(Schema.decodeUnknownSync(GrantSearchFromQuery)(query))
console.log(Schema.decodeUnknownSync(GrantSearchFromForm)(form))
// both: { employeeId: 42, minimumShares: 1000, includeCancelled: false }
```

This same StringTree model powers `Config.schema`. For plain JSON input, use `fromJsonString`; for already-parsed unknown JSON, decode the underlying Schema directly. Do not route every carrier through JSON text merely because JSON is familiar.

## Keep transformations reversible

A codec has a decode and an encode direction. A transformation that lowercases an email address on decode but cannot reconstruct the original spelling is not an isomorphism. That may be fine for an ingress-only parser, but it is a poor choice for a Schema later used to persist or round-trip the value.

Use `Schema.decodeTo(target, transformation)` for explicit two-way conversion. `SchemaTransformation.transform` is for total conversion; `SchemaGetter.transformOrFail` is for a direction that may reject. Test both directions for every custom transformation.

> **Example status — Runnable:** the cents representation is exact in both directions for safe integers.

```ts
import { Schema, SchemaTransformation } from "effect"

const DollarsFromCents = Schema.Int.pipe(
  Schema.decodeTo(
    Schema.Finite,
    SchemaTransformation.transform({
      decode: (cents) => cents / 100,
      encode: (dollars) => Math.round(dollars * 100)
    })
  )
)

const dollars = Schema.decodeUnknownSync(DollarsFromCents)(12_345)
const cents = Schema.encodeUnknownSync(DollarsFromCents)(dollars)

console.log(dollars, cents) // 123.45 12345
```

For money with arbitrary precision, use `BigDecimal` and an appropriate string codec rather than the floating-point example above. The point is ownership of the representation, not a recommendation to store currency in `number`.

## Make error reporting a boundary concern

High-level Schema runners fail with `SchemaError`, whose `.issue` is a structured `SchemaIssue` tree. Keep that tree while code needs field paths or localization; format it only at the transport/UI edge.

> **Example status — Runnable:** the decoder collects all field failures and returns Standard Schema-style path/message objects.

```ts
import { Effect, Schema, SchemaIssue } from "effect"

const Registration = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))
})

const validateRegistration = (input: unknown) =>
  Schema.decodeUnknownEffect(Registration)(input, {
    errors: "all",
    reportInput: true
  }).pipe(
    Effect.mapError((error) =>
      SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues
    )
  )

console.log(await Effect.runPromiseExit(validateRegistration({ name: "", level: 99 })))
```

Use first-error mode for fast machine-to-machine rejection when extra detail has no value. Use `{ errors: "all" }` for forms and batch imports where returning all actionable problems saves a round trip. `reportInput` can retain rejected values in issues, so enable it deliberately around sensitive data.

Do not catch a decoding failure and replace it with an arbitrary default unless compatibility policy explicitly permits that. `Schema.catchDecoding` is powerful precisely because it weakens the boundary.

## Derive tooling from the same contract

The same Schema can produce more than a decoder:

- `Schema.toJsonSchemaDocument` for OpenAPI/tooling contracts;
- `Schema.toArbitrary` for generated test inputs;
- `Schema.toEquivalence` for domain-aware equality;
- `Schema.toFormatter` for readable values;
- `Schema.toIso` for an optic between a Schema value and its isomorphic representation;
- `Schema.toStandardSchemaV1` for Standard Schema consumers.

Annotations such as title, description, examples, and constraints should live on the definition that owns them. Derived artifacts then change together instead of drifting as parallel documents.

> **Example status — Contextual:** it uses `CreateGrantRequest` from the first example and requires `fast-check` only for arbitrary generation.

```ts
import { Schema } from "effect"
import * as FastCheck from "fast-check"

const jsonSchema = Schema.toJsonSchemaDocument(CreateGrantRequest)
const equivalent = Schema.toEquivalence(CreateGrantRequest)
const arbitrary = Schema.toArbitrary(CreateGrantRequest)(FastCheck)

console.log(jsonSchema.schema)
console.log(equivalent(
  { employeeId: 42 as EmployeeId, shares: 10, grantedAt: new Date(0) },
  { employeeId: 42 as EmployeeId, shares: 10, grantedAt: new Date(0) }
))

FastCheck.assert(
  FastCheck.property(arbitrary, (value) => Schema.is(CreateGrantRequest)(value))
)
```

Generated examples prove that the arbitrary produces accepted `Type` values; they do not by themselves prove every business invariant or a decode/encode round trip. Add properties for the claims your codec makes.

## Evolve persisted and wire schemas safely

Once encoded values are persisted or exchanged with another process, the `Encoded` side is a durable contract. Treat changes differently:

- Adding a required field breaks old data unless decoding supplies a deliberate default.
- Renaming a key requires a compatibility transformation or migration.
- Changing a tag, representation identifier, or union discriminant changes dispatch.
- Tightening a check can make previously valid stored values unreadable.
- Changing only the in-memory `Type` may still change encoding if a transformation changes.

Use `withDecodingDefaultKey` for a genuine backward-compatible default, not to hide corrupt input. For long-lived persisted schema descriptions, use [SchemaRepresentation](../data/schema#schemarepresentation) with stable identities and the required revivers. For SQL table evolution, pair schema changes with [Migrator](../interfaces/sql#migrator) rather than hoping runtime decoding performs a database migration.

## Runnable capstone: request to domain to JSON and back

The capstone decodes a request, applies domain policy, constructs a domain class, encodes it through the canonical JSON codec, and restores the class. It uses `Clock` so time remains controllable in tests.

> **Example status — Runnable:** copy the block into a TypeScript file and run it with Node 26+.

```ts
import { Clock, Effect, Schema } from "effect"

const EmployeeId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("CapstoneEmployeeId")
)

const Request = Schema.Struct({
  employeeId: EmployeeId,
  shares: Schema.Natural,
  grantedAt: Schema.DateFromString
})

class Grant extends Schema.Class<Grant>("handbook/SchemaCapstoneGrant")({
  key: Schema.String,
  employeeId: EmployeeId,
  shares: Schema.Natural,
  grantedAt: Schema.Date,
  recordedAt: Schema.Date
}) {}

class EmptyGrant extends Schema.TaggedError<EmptyGrant>()("EmptyGrant", {
  employeeId: EmployeeId
}) {}

const RequestJsonText = Schema.fromJsonString(Request)
const GrantJsonText = Schema.fromJsonString(Schema.toCodecJson(Grant))

const accept = Effect.fn("Grant.accept")(function*(text: string) {
  const request = yield* Schema.decodeUnknownEffect(RequestJsonText)(text)
  if (request.shares === 0) {
    return yield* new EmptyGrant({ employeeId: request.employeeId })
  }
  const recordedAt = new Date(yield* Clock.currentTimeMillis)
  return new Grant({
    key: `${request.employeeId}:${request.grantedAt.toISOString()}`,
    employeeId: request.employeeId,
    shares: request.shares,
    grantedAt: request.grantedAt,
    recordedAt
  })
})

const program = Effect.gen(function*() {
  const grant = yield* accept(`{
    "employeeId": 42,
    "shares": 4000,
    "grantedAt": "2026-08-12T10:00:00.000Z"
  }`)
  const stored = yield* Schema.encodeUnknownEffect(GrantJsonText)(grant)
  const restored = yield* Schema.decodeUnknownEffect(GrantJsonText)(stored)
  return {
    stored,
    classRestored: restored instanceof Grant,
    sameInstant: restored.grantedAt.getTime() === grant.grantedAt.getTime()
  }
})

console.log(await Effect.runPromise(program))
```

## Test the contract in both directions

A boundary test should cover valid decoding, invalid decoding, encoding, round-trip behavior, and compatibility examples. If the codec needs services, provide them in the test just as the application does.

> **Example status — Contextual:** it tests the capstone definitions with `@effect/vitest` and virtual time.

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { TestClock } from "effect/testing"

it.effect("round-trips an accepted grant", () =>
  Effect.gen(function*() {
    yield* TestClock.setTime(new Date("2026-08-12T12:00:00.000Z").getTime())
    const grant = yield* accept(
      `{"employeeId":42,"shares":4000,"grantedAt":"2026-08-12T10:00:00.000Z"}`
    )
    const text = yield* Schema.encodeUnknownEffect(GrantJsonText)(grant)
    const restored = yield* Schema.decodeUnknownEffect(GrantJsonText)(text)

    assert.isTrue(restored instanceof Grant)
    assert.strictEqual(restored.recordedAt.toISOString(), "2026-08-12T12:00:00.000Z")
  }))

it("rejects malformed boundary data", () => {
  const result = Schema.decodeUnknownResult(RequestJsonText)(
    `{"employeeId":0,"shares":-1,"grantedAt":"not-a-date"}`,
    { errors: "all" }
  )
  assert.isTrue(Result.isFailure(result))
})
```

## Operational checklist

- Write down the carrier and the domain `Type`; choose a Codec when they differ.
- Decode unknown input once at ingress and never recover trust with a cast.
- Use `Finite`, integer/range checks, and brands where the domain is narrower than JavaScript's primitive.
- Keep local shape validation in Schema and stateful business policy in services.
- Model request/update/select variants explicitly; do not make one giant optional DTO serve every operation.
- Encode outbound and persisted values through the Schema rather than raw `JSON.stringify`.
- Derive a canonical JSON or StringTree codec for non-native values.
- Preserve `SchemaIssue` until the UI/transport boundary chooses a formatter.
- Enable all-errors and rejected-input reporting only where their detail is useful and safe.
- Annotate the owning Schema so JSON Schema, docs, generators, and errors share metadata.
- Test decode, encode, and round trip independently, including representative old stored values.
- Treat the encoded side of an API, RPC, event, or persisted value as a versioned contract.

The central rule is simple: **unknown data becomes trustworthy only by decoding, and domain data becomes portable only by encoding. One Schema should own both directions.**
