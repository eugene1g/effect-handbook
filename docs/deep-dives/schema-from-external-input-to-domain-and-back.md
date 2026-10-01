# Schema — From External Input to Domain and Back

Effect Schema is most useful when it owns a complete boundary, not just an isolated validation call. This guide follows one value from untrusted JSON, form, or query input into a domain model, through application logic, and back to a JSON-safe representation. It targets `effect@4.0.0`.

Use [Schema](../data/schema) for the complete module reference, [Errors, Option & Result](../foundations/errors-option-result) for failure modeling, [Configuration & Secrets](../foundations/configuration-secrets) for StringTree-backed configuration, and [HttpApi](../interfaces/http-api), [RPC](../interfaces/rpc), [SQL](../interfaces/sql), and [Persistence](../tooling/persistence) for the boundaries that consume Schemas.

## The boundary pipeline

A robust data path has five explicit stages:

1. **Carrier** — unknown JSON, text, `FormData`, `URLSearchParams`, a database row, or an RPC payload.
2. **Codec** — a `Schema.Codec<Type, Encoded, DecodingServices, EncodingServices>` that validates and transforms in both directions.
3. **Domain value** — the decoded `Type`, which application code can trust.
4. **Application logic** — services accept domain values and return domain values or typed errors; they do not cast unknown data.
5. **Representation** — encoding validates the outbound value and turns it into the exact carrier/storage shape.

The important distinction is `Type` versus `Encoded`. `Schema.DateFromString` has `Type = Date` and `Encoded = string`; `Schema.FiniteFromString` has `Type = number` and `Encoded = string`. A plain `Schema.Date` validates an in-memory `Date` but does not by itself claim that the wire contains an ISO string.

### Answer eight questions before writing the schema

A boundary schema is a small contract. Write the answers down (a comment above the schema is enough) before choosing combinators:

1. **Producer and trust** — who creates this input, and why is it trusted or not?
2. **`Encoded`** — the exact wire shape, including which keys may be absent, `null`, or `undefined`.
3. **`Type`** — the value application code wants to hold.
4. **Decode behavior** — normalization, defaults, and any service the decoder needs.
5. **Encode behavior** — what is written back, and what is lost if decoding normalized.
6. **Failure detail** — first error or all errors, and whether rejected input may be reported.
7. **Excess-key policy** — strip or reject ([parse options](../data/schema#14-parse-options-are-boundary-policy)).
8. **Equivalence** — the relation under which a round trip is expected to hold.

Separate schemas for one concept are legitimate when representation or disclosure differs (a public DTO and a persisted row). Join them with a named, tested mapping or a shared field set — never with `as`, an object spread that happens to type-check, or a duplicated field list.

### Pick the runner for the surrounding code

The same Schema can be run in several styles. Pick at the boundary rather than forcing the whole application into one error representation.

| Surrounding code | Runner | Failure shape |
| --- | --- | --- |
| Effect program | `decodeUnknownEffect` / `encodeUnknownEffect` | typed `SchemaError` channel |
| Pure branching | `decodeUnknownResult` / `encodeUnknownResult` | `Result` |
| Optional probe | `decodeUnknownOption` or `.makeOption` | `Option` |
| Validated trusted edge | `decodeUnknownSync` / `encodeUnknownSync` | throws `SchemaError` |
| Promise-only host | `decodeUnknownPromise` / `encodeUnknownPromise` | rejected Promise |

Prefer the Effect runner inside services. Use a throwing runner only at an edge that already communicates through exceptions, and catch there. A schema whose getters use services or asynchronous work can *only* run through the Effect runner.

> **Warning:** `Effect.sync(() => Schema.decodeUnknownSync(S)(input))` compiles, has error type `never`, and turns bad input into a defect that no `Effect.catchTag("SchemaError", ...)` can handle. Malformed input is an *expected* boundary outcome: keep it in the typed channel with `Schema.decodeUnknownEffect`.

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

## Treat stored rows as another encoded form

A database row is a third representation of the same concept, with its own rules: snake_case columns, integer booleans, exact numerics delivered as text, driver-specific timestamps. Two shortcuts cause most storage bugs: using the decoded domain type as the row type (a cast at the driver), and assuming the HTTP encoding is also the storage encoding.

- **Give the row its own schema wherever naming or representation differs**, and **reuse the field schemas** (ids, brands, checked numbers) so each rule is defined once.
- **Decode rows inside the repository.** A malformed row then fails at the storage boundary — before any service sees it — with a diagnostic that names the field and the rule.
- **Encode on the way in** with the same schema, so the write path cannot drift from the read path.

> **Example status — Contextual:** the block type-checks on its own; `selectGrantRows` stands for a query supplied by the application.

```ts
import { Effect, Schema, SchemaTransformation } from "effect"

const EmployeeId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("EmployeeId")
)

// SQLite-style boolean column: 0 | 1 on disk, boolean in the domain.
const BooleanFromBit = Schema.Literals([0, 1]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (bit) => bit === 1,
      encode: (flag) => (flag ? 1 : 0)
    })
  )
)

// The row is its own Encoded form: snake_case keys, integer booleans, exact numeric text.
const GrantRow = Schema.Struct({
  employeeId: EmployeeId, // the same field schema the API contract uses
  shares: Schema.Natural,
  strikePrice: Schema.BigDecimalFromString, // NUMERIC as text; never through a float
  cancelled: BooleanFromBit,
  grantedAt: Schema.DateFromString
}).pipe(
  Schema.encodeKeys({
    employeeId: "employee_id",
    strikePrice: "strike_price",
    grantedAt: "granted_at"
  })
)

declare const selectGrantRows: (
  employeeId: number
) => Effect.Effect<ReadonlyArray<unknown>>

// Decode inside the repository: a bad row fails here, naming the field and the rule.
const findGrants = Effect.fn("GrantRepository.findGrants")(
  function*(employeeId: typeof EmployeeId.Type) {
    const rows = yield* selectGrantRows(employeeId)
    return yield* Schema.decodeUnknownEffect(Schema.Array(GrantRow))(rows)
  }
)
```

[SqlSchema](../interfaces/sql#sqlschema) wires this decoding into query helpers, and [Model](../data/schema#model) derives the select, insert, update, and JSON variants from one definition when the shapes differ only per operation.

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

Custom declared types can attach a `toCodecJson` annotation. JSON Schema generation reuses that representation, keeping runtime serialization and published contracts aligned. A bare declaration without a `toCodecJson` or `toCodec` annotation still derives: JSON-native values can encode unchanged, while non-JSON values such as `URL` instances fail with `Expected JSON value`. JSON Schema generation emits an unconstrained `{}` for a bare declaration. Derivation alone does not prove a usable representation, so test the encode direction of every custom type.

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

Use `Schema.decodeTo(target, transformation)` for explicit two-way conversion. `SchemaTransformation.transform` is for total conversion; `SchemaGetter.transformEffect` is for a direction that may reject or needs a service. When a conversion is honestly decode-only — a digest, a lowercased lookup key — say so with `SchemaGetter.forbiddenEncoding` as the encode leg, so encoding fails with a clear issue instead of inventing a value. Test both directions for every custom transformation.

> **Example status — Runnable:** a two-way floating-point conversion, not a lossless codec over its full accepted domain.

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

The sample round-trips, but `Schema.Int` alone does not make division and multiplication by 100 exact: `9_007_199_254_740_990` cents decodes to `90071992547409.9` and encodes back to `9_007_199_254_740_991`. In the other direction, `Schema.Finite` accepts fractional-cent values such as `1.234`, which encode to `123` cents and decode to `1.23`. Retain integer minor units throughout, or use `BigDecimal` with an appropriate string codec for exact decimal money. If using `number`, constrain and test both domains against the precision you promise; do not infer reversibility from the presence of both functions.

The same ownership question applies to every carrier narrower than its `Type`: `Schema.DurationFromMillis` cannot round-trip a nanosecond-precision duration, while `DurationFromNanos` and `DurationFromString` can. Pick the codec by the precision you promise ([Effect data types at the boundary](../data/schema#16-effect-data-types-at-the-boundary)).

Official guide: [Schema Transformations](https://effect.website/docs/v4/schema/transformations) (it may still spell `transformEffect` as `transformOrFail`). The official guides track Effect's `main` branch rather than a specific tagged release, so where they differ, this page and the tagged `effect@4.0.0` source win.

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

Wording is a separate decision from structure. Put text that belongs to the contract on the schema (`message`, `expected`, `identifier`, `messageMissingKey`, `messageUnexpectedKey` — see [Custom error messages](../data/schema#17-custom-error-messages)); put text that belongs to one UI, or translation keys, in the formatter's `leafHook` / `checkHook` ([SchemaIssue](../data/schema#schemaissue)).

### Keep "malformed" and "does not match" as different outcomes

Some boundaries both *parse* a document and *evaluate* it: a payroll export checked against its declared totals, an HRIS webhook checked against a partner contract. They have two failures with different owners and different policies. Malformed input means the producer is broken — retrying is pointless and the alert goes to the integration owner. A well-formed document that does not match is a business signal — it may be retried after a correction and the alert goes to the domain owner. Collapse both into "validation failed" and bad configuration looks like a failing partner, or the reverse.

> **Example status — Runnable:** the block defines both outcomes and the function that separates them.

```ts
import { Effect, Schema } from "effect"

class MalformedPayrollFile extends Schema.TaggedError<MalformedPayrollFile>()(
  "MalformedPayrollFile",
  { message: Schema.String }
) {}

class PayrollTotalsMismatch extends Schema.TaggedError<PayrollTotalsMismatch>()(
  "PayrollTotalsMismatch",
  { declaredCents: Schema.Int, actualCents: Schema.Int }
) {}

const PayrollFile = Schema.Struct({
  declaredTotalCents: Schema.Int,
  lines: Schema.Array(
    Schema.Struct({ employeeId: Schema.NonEmptyString, netCents: Schema.Int })
  )
})

const acceptPayrollFile = Effect.fn("acceptPayrollFile")(function*(input: unknown) {
  // Outcome 1: not a payroll file at all. Fix the producer; do not retry.
  const file = yield* Schema.decodeUnknownEffect(PayrollFile)(input).pipe(
    Effect.mapError((error) => new MalformedPayrollFile({ message: error.message }))
  )

  // Outcome 2: a well-formed file whose content is wrong. A signal for finance.
  const actualCents = file.lines.reduce((sum, line) => sum + line.netCents, 0)
  if (actualCents !== file.declaredTotalCents) {
    return yield* new PayrollTotalsMismatch({
      declaredCents: file.declaredTotalCents,
      actualCents
    })
  }
  return file
})
```

Degenerate-but-valid input stays valid: a file with no lines and a declared total of zero is a correct file, not a malformed one. Reserve the malformed outcome for input the schema cannot read.

Official guides: [Error Messages](https://effect.website/docs/v4/schema/error-messages), [Error Formatters](https://effect.website/docs/v4/schema/error-formatters).

## Derive tooling from the same contract

The same Schema can produce more than a decoder:

- `Schema.toJsonSchemaDocument` for *value* contracts: config validation, structured-output prompts, cross-language codegen of a payload;
- `Arbitrary.schema` (from `effect/Arbitrary`) for generated test inputs;
- `Schema.toEquivalence` for domain-aware equality;
- `Schema.toFormatter` for readable values;
- `Schema.toIso` for an optic between a Schema value and its isomorphic representation;
- `Schema.toStandardSchemaV1` for Standard Schema consumers.

Annotations such as title, description, examples, and constraints should live on the definition that owns them. Derived artifacts then change together instead of drifting as parallel documents.

**Derive each artifact from the model that owns its facts.** A value schema knows a shape; it does not know methods, paths, parameter locations, status codes, per-endpoint errors, security, or media types. Those live on the assembled `HttpApi`, so the OpenAPI document is projected from it with [`OpenApi.fromApi`](../interfaces/http-api#openapi), which reuses your schemas for the payload parts. JSON Schema describes the `Encoded` side, is open to extra properties by default, and names `$defs` after `identifier` annotations — see [JsonSchema](../data/schema#jsonschema).

> **Example status — Contextual:** it uses `CreateGrantRequest` from the first example. Generation uses Effect's native `Arbitrary` module; there is no `fast-check` bridge.

```ts
import { Arbitrary, Effect, Schema } from "effect"

const jsonSchema = Schema.toJsonSchemaDocument(CreateGrantRequest)
const equivalent = Schema.toEquivalence(CreateGrantRequest)
const arbitrary = Arbitrary.schema(CreateGrantRequest)

console.log(jsonSchema.schema)
console.log(equivalent(
  { employeeId: 42 as EmployeeId, shares: 10, grantedAt: new Date(0) },
  { employeeId: 42 as EmployeeId, shares: 10, grantedAt: new Date(0) }
))

// checkEffect returns a structured result instead of throwing on falsification.
const generationCheck = Arbitrary.checkEffect(arbitrary, Schema.is(CreateGrantRequest), { runs: 100 }).pipe(
  Effect.map((result) => result._tag === "Passed" ? "ok" : Arbitrary.formatCheckFailure(result))
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

**The technique for a changed representation: accept old and new shapes on the encoded side, decode both into the one domain `Type`, and encode only the new form.** A union of codecs does exactly that — every member decodes to the same `Type`, and because encoding tries members in order, putting the new form first means only the new form is ever written. Pin representative old values as regression fixtures so tightening a check cannot silently orphan stored data.

> **Example status — Runnable:** legacy rows stored whole dollars as a JSON number; current rows store exact decimal text.

```ts
import { BigDecimal, Schema, SchemaGetter } from "effect"

const LegacyWholeDollars = Schema.Int.pipe(
  Schema.decodeTo(Schema.BigDecimal, {
    decode: SchemaGetter.transform((dollars: number) => BigDecimal.fromBigInt(BigInt(dollars))),
    encode: SchemaGetter.forbiddenEncoding // the old form is read, never written
  })
)

// New form first: encoding tries members in order.
const StoredSalary = Schema.Union([Schema.BigDecimalFromString, LegacyWholeDollars])

const SalaryRow = Schema.Struct({ employeeId: Schema.NonEmptyString, baseSalary: StoredSalary })

const legacy = Schema.decodeUnknownSync(SalaryRow)({ employeeId: "e-1", baseSalary: 185000 })
const current = Schema.decodeUnknownSync(SalaryRow)({ employeeId: "e-1", baseSalary: "185000.50" })

console.log(Schema.encodeUnknownSync(SalaryRow)(legacy))  // { employeeId: "e-1", baseSalary: "185000" }
console.log(Schema.encodeUnknownSync(SalaryRow)(current)) // { employeeId: "e-1", baseSalary: "185000.5" }
```

For a renamed key, keep the wire name stable with [`Schema.encodeKeys`](../data/schema#3-structs-the-workhorse) while the domain name changes, or accept both shapes with the same union technique during a migration window. Use `withDecodingDefaultKey` for a genuine backward-compatible default, not to hide corrupt input. For long-lived persisted schema descriptions, use [SchemaRepresentation](../data/schema#schemarepresentation) with stable identities and the required revivers. For SQL table evolution, pair schema changes with [Migrator](../interfaces/sql#migrator) rather than hoping runtime decoding performs a database migration.

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

### Assert the law that actually holds

The claim a codec makes is about round trips, and three different laws hide under that name:

| Law | Holds when | Notes |
| --- | --- | --- |
| `decode(encode(t))` is equivalent to `t` | encoding loses nothing | compare under a *named* equivalence — `Equal.equals` for `Schema.Class` values, or `Schema.toEquivalence(schema)` — never `===`, because decoding builds fresh instances |
| `encode(decode(e))` equals `e` | decoding does not normalize | false for trimming, URL canonicalization, timestamp precision, legacy-form upgrades; do not demand it there |
| **Idempotence after the first pass**: with `first = decode(encode(t))`, `decode(encode(first))` is equivalent to `first` | for every correct codec | the law worth asserting by default: it tolerates one normalization and still catches drift |

> **Example status — Runnable:** a property over schema-derived values; `checkEffect` returns a structured result instead of throwing.

```ts
import { Arbitrary, Effect, Equal, Schema } from "effect"

class ReviewLink extends Schema.Class<ReviewLink>("handbook/ReviewLink")({
  employeeId: Schema.NonEmptyString,
  portal: Schema.URLFromString,
  openedAt: Schema.DateTimeUtcFromString
}) {}

const roundTrip = (value: ReviewLink) =>
  Schema.decodeUnknownSync(ReviewLink)(Schema.encodeSync(ReviewLink)(value))

const stableAfterFirstPass = Arbitrary.checkEffect(
  Arbitrary.schema(ReviewLink),
  (sample) => {
    const first = roundTrip(sample)
    const second = roundTrip(first)
    return Equal.equals(first, second) // true, while first === second is false
  },
  { runs: 100, seed: 11 }
).pipe(
  Effect.map((result) => result._tag === "Passed" ? "ok" : Arbitrary.formatCheckFailure(result))
)
```

A schema-derived generator has two blind spots, and both need hand-written fixtures. It produces valid decoded values, so it can never exercise **key omitted → default**, an explicit falsy value that must survive, or malformed wire input; keep a handful of *named encoded* fixtures for those (a bad brand pattern, a malformed URL, an impossible timestamp, an invalid explicit default, one representative row per legacy form). And it knows only the schema: a cross-field business rule must be a schema `check`, or a residual `Arbitrary.filter`, which spends the discard budget. Record the seed and the shrunk counterexample when a property fails, and keep a regression example per representation bug. The per-requirement proof table and the four-case minimum are in [Testing schemas with TestSchema](../data/schema#testing-schemas-with-testschema).

## Operational checklist

- Write down the carrier and the domain `Type`; choose a Codec when they differ.
- Decode unknown input once at ingress and never recover trust with a cast.
- Choose the excess-property policy per boundary (`"ignore"` strips, `"error"` rejects), pass it at the call site, and test it; use the same choice for generated JSON Schema.
- Inside an Effect, decode with `decodeUnknownEffect`; a throwing decoder wrapped in `Effect.sync` turns bad input into a defect.
- Keep "malformed input" and "valid input that does not match" as separately tagged outcomes.
- Use `Finite`, integer/range checks, and brands where the domain is narrower than JavaScript's primitive.
- Keep local shape validation in Schema and stateful business policy in services.
- Model request/update/select variants explicitly; do not make one giant optional DTO serve every operation.
- Give a stored row its own encoded form, reuse the field schemas, and decode rows inside the repository.
- Encode outbound and persisted values through the Schema rather than raw `JSON.stringify`.
- Derive a canonical JSON or StringTree codec for non-native values.
- Preserve `SchemaIssue` until the UI/transport boundary chooses a formatter.
- Enable all-errors and rejected-input reporting only where their detail is useful and safe.
- Annotate the owning Schema so JSON Schema, docs, generators, and errors share metadata.
- Test decode, encode, and round trip independently, including representative old stored values; assert idempotence after the first pass under a named equivalence.
- Test every default three ways: omitted, explicit falsy, explicit invalid.
- Treat the encoded side of an API, RPC, event, or persisted value as a versioned contract.

The central rule is simple: **unknown data becomes trustworthy only by decoding, and domain data becomes portable only by encoding. One Schema should own both directions.**
