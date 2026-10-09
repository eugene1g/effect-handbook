# Schema in Depth

This page continues the [Schema](schema) guide past the everyday codec work. It covers what you reach for once a schema owns a real boundary: annotations and derived artifacts, serialization codecs, recursive and custom schemas, deliberate construction fallbacks, parse options as boundary policy, optional fields and `null`, Effect data types on the wire, custom error messages, and schemas that need services. Every section builds on the `Type` / `Encoded` model from the main page; the lower-level modules behind it are on [Schema Tooling & Internals](schema-tooling).

## 1. Annotations and derivations

`annotate` attaches metadata (title, description, examples, custom keys) that flows into JSON Schema, error messages, and docs. Derivations from the same schema object: `Arbitrary.schema` (native property-test generator, from `effect/Arbitrary`), `toEquivalence` (structural equality), `toFormatter` (pretty-printer), `toStandardSchemaV1` (Standard Schema interop), `toJsonSchemaDocument`.

```ts
import { Arbitrary, Schema } from "effect"

const CompBand = Schema.Struct({
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  salaryMid: Schema.Finite
}).pipe(
  Schema.annotate({ title: "CompBand", description: "Salary midpoint for a level" })
)

const eq = Schema.toEquivalence(CompBand)
eq({ level: 5, salaryMid: 190000 }, { level: 5, salaryMid: 190000 }) // true

// Native generator for the decoded Type: there is no `Schema.toArbitrary` or
// fast-check bridge; checks like isBetween generate constructively.
const CompBandArb = Arbitrary.schema(CompBand) // Arbitrary<{ level: number; salaryMid: number }>
const fiveBands = Arbitrary.sampleEffect(CompBandArb, { count: 5, seed: 42 })
```

**Three attachment points.** `annotate` documents the decoded side, `Schema.annotateEncoded` the encoded side (the one JSON Schema sees for a transformation), and `Schema.annotateKey` a struct field or tuple element. **`.annotate(...)` called after `.check(...)` lands on the last check**, not on the base schema, and `Schema.resolveAnnotations(schema)` reads from the same place — so annotate first, then add checks, when the metadata describes the schema as a whole. `examples` and `default` annotations are documentation only; they never affect decoding or construction. A `parseOptions` annotation is ignored ([section 5](#5-parse-options-are-boundary-policy)).

**Typed custom annotations.** Annotations are an open record. Make a team-specific key (a PII marker, a deprecation flag, a UI hint) type-checked by augmenting the `Annotations` interface, and read it back with `Schema.resolveAnnotations` (key-level ones with `Schema.resolveAnnotationsKey`).

```ts
import { Schema } from "effect"

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly containsPii?: boolean | undefined
    }
  }
}

const NationalId = Schema.String.annotate({ containsPii: true })

const containsPii = (schema: Schema.Top): boolean =>
  Schema.resolveAnnotations(schema)?.["containsPii"] === true
```

**Derivation rules worth knowing.**

| Derivation | Rule | Customize with |
| --- | --- | --- |
| `Schema.toEquivalence` | compares only what the schema describes (extra properties are ignored) and recurses through structs and arrays; schemas that say nothing about structure (`Unknown`, `Any`, an un-annotated declaration) fall back to `Equal.equals` | `Schema.overrideToEquivalence(() => (a, b) => ...)` for "same id means same entity"; a `toEquivalence` annotation on a declaration |
| `Schema.toFormatter` | builds `(value: Type) => string` following the schema; it does not validate. Distinct from the issue formatters in [`SchemaIssue`](schema-tooling#schemaissue) and from the general [`Formatter`](../operations/observability#formatter) module | `Schema.overrideToFormatter`; a `toFormatter` annotation; an `onBefore(ast, recur)` hook that intercepts node kinds (return `undefined` to keep the default) |
| `Arbitrary.schema` | built-in checks generate constructively; a custom filter is satisfied by rejection unless it carries an `arbitraryConstraint` annotation ([section 5 of Schema](schema#5-refinements-check-and-refine)); a declaration supplies a generatable stand-in with a `toCodecArbitrary` annotation | see [Arbitrary](../tooling/testing-dev-tooling#arbitrary) (unstable) |
| `Schema.toStandardSchemaV1` | see [StandardSchema](schema-tooling#standardschema) | `leafHook`, `checkHook`, `parseOptions` |

```ts
import { Schema } from "effect"

const Employee = Schema.Struct({ id: Schema.Int, displayName: Schema.String })

// Identity-style equality: a renamed employee is still the same entity.
const sameEmployee = Schema.toEquivalence(
  Employee.pipe(Schema.overrideToEquivalence(() => (a, b) => a.id === b.id))
)
sameEmployee({ id: 1, displayName: "Ada" }, { id: 1, displayName: "Ada L." }) // true

// Audit-log formatter that masks every string leaf.
const auditLine = Schema.toFormatter(Employee, {
  onBefore: (ast) => (ast._tag === "String" ? () => "<masked>" : undefined)
})
auditLine({ id: 1, displayName: "Ada" }) // { "id": 1, "displayName": <masked> }
```

Official guides: [Schema Annotations](https://effect.website/docs/v4/schema/annotations) (its `parseOptions` annotation row and its claim that `concurrency` reaches union members are obsolete in 4.0.2), [Schema to Equivalence](https://effect.website/docs/v4/schema/equivalence), [Schema to Formatter](https://effect.website/docs/v4/schema/formatter).

## 2. Serialization codecs

Boundary formats are codecs, not ad-hoc `JSON.stringify` calls. `fromJsonString(schema)` parses JSON text and then validates the parsed value; `fromFormData(schema)` and `fromURLSearchParams(schema)` do the same for browser form and query-string containers. In the other direction, derive a canonical representation with `toCodecJson`, `toCodecStringTree`, or `toCodecIso`.

`toCodecJson` recursively makes non-JSON-native values—such as `Date`, `BigInt`, `Uint8Array`, maps, sets, classes, and `Option`—reversible through JSON-safe data. A declaration or class can provide a custom `toCodecJson` annotation; JSON Schema generation reuses that representation, so runtime serialization and the published contract stay aligned. `toCodecStringTree` converts leaves to strings for form/query/XML-shaped data, while `toCodecIso` exposes a schema's isomorphic representation for transformations and optics.

```ts
import { Schema } from "effect"

const Grant = Schema.Struct({
  employeeId: Schema.String,
  shares: Schema.Natural,
  grantedAt: Schema.Date
})

// Runtime value <-> JSON-safe object. Date encodes as an ISO string.
const GrantJson = Schema.toCodecJson(Grant)
const encoded = Schema.encodeUnknownSync(GrantJson)({
  employeeId: "e-42",
  shares: 4_000,
  grantedAt: new Date("2026-08-12T10:00:00.000Z")
})
const decoded = Schema.decodeUnknownSync(GrantJson)(encoded)

// Complete JSON-text boundary: string <-> decoded Grant. Derive the JSON-safe
// representation first, then parse/stringify that representation.
const GrantFromJsonText = Schema.fromJsonString(GrantJson)
const roundTrip = Schema.decodeUnknownSync(GrantFromJsonText)(
  JSON.stringify(encoded)
)
```

Do not use the internal `Schema.UnknownFromJsonString`; compose `Schema.fromJsonString(Schema.Unknown)` when the JSON value is intentionally unknown. The JSON forms of `Option`, `Result`, `Exit`, collections, and `Duration` are tabulated in [Effect data types at the boundary](#7-effect-data-types-at-the-boundary).

## 3. Recursive and custom schemas

Use `Schema.suspend(() => schema)` to make a recursive edge lazy. Recursive declarations are the main case where an explicit `Schema.Codec<Type, Encoded>` annotation is useful because TypeScript cannot infer a self-reference safely. For an otherwise unsupported runtime type, use `Schema.declare(guard, annotations?)`; use `declareConstructor` when the custom type itself is parameterized by child schemas. Prefer `Schema.instanceOf` for ordinary class-instance checks.

```ts
import { Schema } from "effect"

interface OrgNode {
  readonly employeeId: string
  readonly reports: ReadonlyArray<OrgNode>
}

const OrgNode: Schema.Codec<OrgNode> = Schema.Struct({
  employeeId: Schema.String,
  reports: Schema.Array(
    Schema.suspend((): Schema.Codec<OrgNode> => OrgNode)
  )
})

const Url = Schema.declare(
  (value): value is URL => value instanceof URL,
  { expected: "URL" }
)
```

**When `Encoded` differs from `Type`.** `Schema.Codec<OrgNode>` only works while both sides coincide. As soon as a field transforms (`DateFromString`, `FiniteFromString`), annotate the `suspend` thunk with both parameters — `Schema.Codec<Node, NodeEncoded>` — or TypeScript reports an assignability error. Keep the non-recursive fields in a constant and derive both interfaces from it, adding only the recursive member by hand. A recursive `Schema.Class` follows the same rule with the class itself as the `Type` (`Schema.Codec<Department, DepartmentEncoded>`), and mutually recursive schemas annotate the `suspend` on each back-edge.

```ts
import { Schema } from "effect"

const fields = { name: Schema.String, openedAt: Schema.DateFromString }

interface Department extends Schema.Struct.Type<typeof fields> {
  readonly children: ReadonlyArray<Department>
}
interface DepartmentEncoded extends Schema.Struct.Encoded<typeof fields> {
  readonly children: ReadonlyArray<DepartmentEncoded>
}

const Department = Schema.Struct({
  ...fields,
  children: Schema.Array(
    Schema.suspend((): Schema.Codec<Department, DepartmentEncoded> => Department)
  )
})
```

**Give a declaration an encoded form.** `Schema.declare` only knows how to *recognize* a value. Without a `toCodecJson` or `toCodec` annotation, `Schema.toCodecJson` uses `Json` as the encoded schema: JSON-native declaration values can encode unchanged, while non-JSON values such as `URL` instances fail with `Expected JSON value`. Supply an explicit representation when the domain value is not already JSON or needs a different wire shape. The mechanism is an annotation returning `Schema.link<T>()(representationSchema, { decode, encode })`: `toCodecJson` for the JSON form, `toCodecStringTree` / `toCodecIso` for the other canonical codecs, `toCodecArbitrary` for a generatable stand-in, plus `toEquivalence` and `toFormatter`. Inside a custom parser, build issues as `new SchemaIssue.InvalidType(ast, input, options)` / `new SchemaIssue.InvalidValue({ message }, input, options)` so `reportInput` is honored.

```ts
import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect"

// A teaching declaration; for real URLs use the built-in Schema.URL / Schema.URLFromString.
const BenefitsPortalUrl = Schema.declare(
  (value): value is URL => value instanceof URL,
  {
    expected: "URL",
    toCodecJson: () =>
      Schema.link<URL>()(Schema.String, {
        decode: SchemaGetter.transformEffect((text: string, options) =>
          Effect.try({
            try: () => new URL(text),
            catch: () => new SchemaIssue.InvalidValue({ message: "not a URL" }, text, options)
          })
        ),
        encode: SchemaGetter.transform((url: URL) => url.href)
      })
  }
)

const PortalJson = Schema.toCodecJson(Schema.Struct({ portal: BenefitsPortalUrl }))
Schema.encodeUnknownSync(PortalJson)({ portal: new URL("https://benefits.example.com") })
// { portal: "https://benefits.example.com/" }
```

In generic helpers, use `S extends Schema.Top` (or a narrower constraint) and return `S`-derived types. Avoid broad `Schema.Top`, `Schema.Schema<T>`, or `Schema.Codec<T, E>` annotations on concrete non-recursive schemas: widening erases mutability, optionality, constructor, and other type-level metadata baked into the precise schema.

Official guides: [Advanced Usage](https://effect.website/docs/v4/schema/advanced-usage) (mutual recursion, declarations with type parameters), [Class APIs](https://effect.website/docs/v4/schema/classes) (recursive classes).

## 4. Construction and deliberate fallbacks

**Construction is not decoding.** `make`, `makeOption`, `makeEffect`, and class `new` take the decoded `Type` (after constructor defaults) and run checks; they never turn an encoded string into a transformed value, so `Schema.FiniteFromString.make` wants a number. Decode wire input; construct in already-trusted code.

| Constructor | On invalid input | Use when |
| --- | --- | --- |
| `.make(input)` / `new Class(input)` | throws a plain `Error("Schema validation failed")` whose `cause` is the `SchemaIssue.Issue` — not a `SchemaError`, and the message is not formatted | invalid input is a programming bug |
| `.makeOption(input)` | `Option.none()` | probing |
| `.makeEffect(input)` | fails with the raw `SchemaIssue.Issue` | the failure should stay typed |

```ts
import { Schema, SchemaIssue } from "effect"

const Level = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))

try {
  Level.make(42)
} catch (error) {
  // The thrown message is generic; the structured issue rides in `cause`.
  if (error instanceof Error && SchemaIssue.isIssue(error.cause)) {
    console.log(SchemaIssue.makeFormatterDefault()(error.cause)) // Expected a value between 1 and 10
  }
}

Level.makeOption(42)                    // Option.none()
Level.make(42, { disableChecks: true }) // 42 — a deliberate hole
```

> **Warning:** `{ disableChecks: true }` (a second argument to every constructor and class `new`, and a parse option for decoding) skips checks while still applying defaults and transformations. It is a measured optimization for data that was validated moments ago, never an ingress default.


**Deliberate fallbacks.** `SchemaParser.makeOption(schema)` is the standalone form of `.makeOption(...)`. `Schema.catchDecoding` can replace a decoding failure with an effectful `Option` fallback; `catchDecodingWithContext` may additionally require services. These middlewares intentionally weaken a boundary, so reserve them for an explicit compatibility/defaulting policy rather than hiding malformed input.

Official guide: [Default Constructors](https://effect.website/docs/v4/schema/default-constructors) (it types `makeEffect` as failing with `SchemaError` and prints formatted text for a throwing `make`; 4.0.2 behaves as the table above says).

## 5. Parse options are boundary policy

A schema describes a shape; parse options describe how *this boundary* wants that shape parsed. **Keep them at the call site, not in the schema**, so one schema can back a strict ingress and a tolerant reader without being duplicated.

| Option | Default | Effect |
| --- | --- | --- |
| `errors` | `"first"` | `"all"` collects every issue the traversal can reach |
| `onExcessProperty` | `"ignore"` | `"ignore"` **strips** undeclared keys from the result; `"error"` fails with an unexpected-key issue at that path. Applies to decoding and encoding, at every nesting level |
| `concurrency` | sequential | `number \| "unbounded"` with `Effect.forEach` semantics, for effectful children |
| `reportInput` | `false` | attaches rejected input values to issues (read them via `SchemaIssue.hasInput`); can retain secrets and PII |
| `disableChecks` | `false` | skips checks, still applies defaults and transformations ([section 4](#4-construction-and-deliberate-fallbacks)) |

```ts
import { Schema } from "effect"

const PayrollTarget = Schema.Struct({
  id: Schema.NonEmptyString,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0))
})

// Tolerant reader: undeclared keys are stripped from the result.
const decodeLenient = Schema.decodeUnknownEffect(PayrollTarget)

// Strict ingress: a typo'd or smuggled key is an error; report everything at once.
const decodeStrict = Schema.decodeUnknownEffect(PayrollTarget, {
  onExcessProperty: "error",
  errors: "all"
})

const input = { id: "adp", timeoutMs: 5_000, admin: true }
const lenient = decodeLenient(input) // succeeds with { id: "adp", timeoutMs: 5000 }
const strict = decodeStrict(input)   // fails: Expected no excess property at ["admin"]

// Options given when applying the decoder override the creation-time ones, key by key.
const firstOnly = decodeStrict(input, { errors: "first" })
```

- **The excess-property policy is part of the contract.** A struct *looks* strict in its type while the runtime quietly accepts `{ id, admin: true }` and drops the extra key. That is right for a tolerant reader or a projection, and wrong for a config file, a signed payload, a PATCH body, or any input where a typo'd or smuggled key must be noticed. Decide per boundary and test the chosen policy — it is the case most often forgotten.
- **The same option name controls [JSON Schema generation](schema-tooling#jsonschema).** Pass `"error"` in both places when the published document and the runtime parser must agree.
- **To keep unknown keys, model them** with `Schema.Record` or `Schema.StructWithRest` ([section 4 of Schema](schema#4-unions-literals-records-tuples)). There is no `onExcessProperty: "preserve"` option, because it would let unvalidated values cross the boundary.
- **Options apply to the whole operation.** A `parseOptions` *annotation* does not affect parsing, so there is no per-node override; there is no `propertyOrder` option either, and decoded key order is unspecified — sort at presentation time if order matters.
- **Excess-property checks only see enumerable own properties.** A non-enumerable own property — `Error#stack` on a `TaggedError` instance, for example — is never flagged as an excess property, even under `onExcessProperty: "error"`, unless the schema explicitly declares it; the same rule applies to the properties an index signature can match.
- **`errors: "all"` does not mean "every rule ran".** An invalid field prevents a struct-level check from running (a cross-field rule is reported only once its fields parse), and an aborting filter stops later checks. Do not assert on the absence of an issue under `"all"`.
- **`concurrency` parallelizes product children only** — tuple and array elements, struct fields, record entries, structs with rest — independently at each nesting level. Union members always stay sequential, because speculatively running candidates would execute transformations that are not selected. With `errors: "first"` the first *observed* failure interrupts its siblings; array order is preserved, but issue order (and the winner of colliding transformed record keys) follows completion order.

## 6. Optional fields, null, and Option

A field specification must answer five input states: key absent, present `undefined`, present `null`, present valid, present invalid (always a failure). The helpers differ in exactly those cells.

| Field schema | Key absent | `undefined` | `null` | Decoded `Type` | `None` encodes to |
| --- | --- | --- | --- | --- | --- |
| `Schema.optionalKey(S)` | absent | **fails** | fails | `key?: A` | — |
| `Schema.optional(S)` | absent | `undefined` | fails | `key?: A \| undefined` | — |
| `Schema.optionalKey(Schema.NullOr(S))` | absent | fails | `null` | `key?: A \| null` | — |
| `Schema.OptionFromOptionalKey(S)` | `None` | fails | fails | `Option<A>` | absent key |
| `Schema.OptionFromOptional(S)` | `None` | `None` | fails | `Option<A>` | absent key |
| `Schema.OptionFromOptionalNullOr(S)` | `None` | `None` | `None` | `Option<A>` | absent key, or `{ onNoneEncoding: null \| undefined }` |
| `Schema.OptionFromNullOr(S)` | fails | fails | `None` | `Option<A>` | `null` |
| `Schema.OptionFromUndefinedOr(S)` | fails | `None` | fails | `Option<A>` | `undefined` |
| `Schema.OptionFromNullishOr(S)` | fails | `None` | `None` | `Option<A>` | `undefined`, or `{ onNoneEncoding: null }` |

```ts
import { Schema } from "effect"

const Employee = Schema.Struct({
  name: Schema.String,
  nickname: Schema.OptionFromOptionalKey(Schema.String),       // wire: key may be absent
  managerId: Schema.OptionFromNullOr(Schema.FiniteFromString), // wire: numeric string or null (a nullable column)
  phone: Schema.OptionFromOptionalNullOr(Schema.String)        // wire: absent | undefined | null
})

Schema.decodeUnknownSync(Employee)({ name: "Ada", managerId: null })
// { name: "Ada", nickname: Option.none(), managerId: Option.none(), phone: Option.none() }
```

- **`optionalKey` rejects an explicit `undefined`**; only `optional` accepts it. With `exactOptionalPropertyTypes` off, TypeScript will not flag `{ key: undefined }` even though decoding fails.
- **`Schema.Option(S)` is not a wire codec.** It expects an actual `Option` on both sides and only transforms the payload, so raw JSON fails with `Expected Option`. The `OptionFrom*` family is what bridges wire absence to `Option`; [section 7](#7-effect-data-types-at-the-boundary) covers the JSON form of a real `Option`.
- **`null` is never absence unless the schema says so.** To collapse a wire `null` into an absent key (or a missing key into `null`), compose `optionalKey(NullOr(S))` with a `decodeTo` whose getters use `SchemaGetter.transformOptional` — see the example under [SchemaGetter](schema-tooling#schemagetter).

Official guide: [Advanced Usage](https://effect.website/docs/v4/schema/advanced-usage).

## 7. Effect data types at the boundary

**Two steps, not one.** The constructors for Effect's own data types — `Schema.Option`, `Schema.Result`, `Schema.Exit`, `Schema.ReadonlyMap`, `Schema.ReadonlySet`, `Schema.HashMap`, `Schema.HashSet`, `Schema.Duration`, `Schema.Redacted` — take the *runtime value* on both sides and apply the inner schemas only to the contents. The wire form is a separate, explicit step: `Schema.toCodecJson(schema)`.

```ts
import { HashMap, Schema } from "effect"

const MeritBudgets = Schema.HashMap(Schema.String, Schema.FiniteFromString)

// Runtime value on both sides: HashMap<string, string> -> HashMap<string, number>.
// Raw JSON fails here with "Expected HashMap".
Schema.decodeUnknownSync(MeritBudgets)(HashMap.make(["eng", "100"]))

// The JSON form is opt-in: an array of [key, value] entries.
const MeritBudgetsJson = Schema.toCodecJson(MeritBudgets)
Schema.decodeUnknownSync(MeritBudgetsJson)([["eng", "100"]]) // HashMap with "eng" -> 100
```

| Schema | Canonical JSON form (`toCodecJson`) |
| --- | --- |
| `Schema.Option(A)` | `{ _tag: "None" }` or `{ _tag: "Some", value }` |
| `Schema.Result(A, E)` | `{ _tag: "Success", success }` or `{ _tag: "Failure", failure }` |
| `Schema.Exit(A, E, D)` | `{ _tag: "Success", value }` or `{ _tag: "Failure", cause: [...] }`, where `cause` is a flat array of reasons such as `{ _tag: "Fail", error }` and `{ _tag: "Die", defect }`; `Schema.Defect()` revives error-like defects as `{ name, message }`. `Schema.Cause` encodes each reason to exactly these wire fields, so strict encoding (`onExcessProperty: "error"`) yields the same output |
| `ReadonlySet` / `HashSet` | array of items |
| `ReadonlyMap` / `HashMap` | array of `[key, value]` entries |
| `Schema.Duration` | `{ _tag: "Millis", value }`, `{ _tag: "Nanos", value: "<digits>" }`, or an infinity tag, so infinite and sub-millisecond durations survive |

**Pick a `Duration` codec by the precision you promise.**

| Codec | `Encoded` | Notes |
| --- | --- | --- |
| `Schema.Duration` | a `Duration` | no wire claim; derive `toCodecJson` for the tagged form above |
| `Schema.DurationFromMillis` | `number` | a nanosecond-precision duration beyond 2^53 ns does not round-trip |
| `Schema.DurationFromNanos` | `bigint` | lossless for finite durations |
| `Schema.DurationFromString` | `string` | decodes anything `Duration.fromInput` parses (`"250 millis"`), encodes parseable text (`"2000 millis"`); it is what `Config.Duration` uses |

The general lesson: when the encoded carrier is narrower than the `Type`, either constrain the `Type` with a check (which also constrains the derived arbitrary) or exclude that field from generic round-trip properties and test it with explicit values.

**Other boundary schemas in `effect/Schema`.**

| Area | Schemas | Notes |
| --- | --- | --- |
| Secrets | `Schema.Redacted(S, { label?, disallowJsonEncode? })`, `Schema.RedactedFromValue(S, { label?, disallowEncode? })` | the first expects a `Redacted` on both sides and rewraps the inner schema's transformed result (`Schema.Redacted(Schema.NumberFromString)` decodes a `Redacted<string>` to a `Redacted<number>`, keeping the label); the second decodes a raw value and wraps it. The "refuse to encode" option is spelled differently on each |
| Sizes | `Schema.ByteSize`, `ByteSizeFromString`, `ByteSizeFromBigInt`, `ByteSizeFromNumber` | the string form requires a unit (`"5 MiB"`) and encodes the exact count as `"5242880 bytes"`; see [ByteSize](functional-toolkit#bytesize) |
| Graphs | `Schema.Graph("directed" \| "undirected", node, edge)` | immutable [Graph](data-structures#graph) values; derive `toCodecJson` for a `{ type, nodes, edges }` snapshot |
| Network (unstable) | `Schema.IpAddressFromString`, `Ipv4AddressFromString`, `Ipv6AddressFromString`, `IpNetworkFromString`, `InetAddressFromString`, `MacAddressFromString` | text to `effect/net` values; malformed text fails with a specific message |
| HTTP (unstable) | `Schema.UrlParams`, `Schema.Headers`, `Schema.Cookies`, `Schema.RecordFromUrlParams`, `Schema.RecordFromCookies`, `Schema.JsonFromUrlParamsField(field)` | live in `effect/Schema`, not the HTTP modules; usage lives with [UrlParams](../interfaces/http-server#urlparams) |

Official guide: [Effect Data Types](https://effect.website/docs/v4/schema/effect-data-types).

## 8. Custom error messages

Messages are plain annotations on the node that fails. The default formatters honor them first and fall back to generated text.

| Failure | Where the text goes |
| --- | --- |
| Type mismatch | `.annotate({ message })` on the base schema, **before** any `.check(...)` |
| A failed built-in check | the check's trailing argument: `Schema.isMinLength(3, { message })`, or `{ expected }` to keep the `Expected ...` wording |
| A nested type mismatch | `identifier` — the message reads `Expected RaiseForm` instead of a structural dump |
| Missing key | `Schema.annotateKey({ messageMissingKey })` on the field |
| Unexpected key (under `onExcessProperty: "error"`) | `messageUnexpectedKey` on the struct |

```ts
import { Result, Schema, SchemaIssue } from "effect"

const RaiseForm = Schema.Struct({
  employeeId: Schema.String.annotate({ message: "employee id must be text" })
    .check(Schema.isMinLength(3, { message: "employee id is too short" }))
    .pipe(Schema.annotateKey({ messageMissingKey: "employee id is required" })),
  percent: Schema.Finite.annotate({ identifier: "RaisePercent" }),
  level: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 10 }, { expected: "a level from 1 to 10" })
  )
}).annotate({ identifier: "RaiseForm", messageUnexpectedKey: "unknown field" })

const result = Schema.decodeUnknownResult(RaiseForm)(
  { percent: "x", level: 99, extra: 1 },
  { errors: "all", onExcessProperty: "error" }
)
if (Result.isFailure(result)) {
  console.log(SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues)
  // [ { path: ["extra"],      message: "unknown field" },
  //   { path: ["employeeId"], message: "employee id is required" },
  //   { path: ["percent"],    message: "Expected RaisePercent" },
  //   { path: ["level"],      message: "Expected a level from 1 to 10" } ]
}
```

- **`.annotate(...)` after `.check(...)` targets the last check.** `Schema.String.check(Schema.isMinLength(3)).annotate({ message })` customizes the length failure and leaves the type mismatch as `Expected string`.
- **A transformation has three message sites**: the source schema, the getter's own issue, and the target schema.
- **Schema-side text or presentation-side text — pick one owner.** Annotations suit messages that belong to the contract (or i18n keys); [formatter hooks](schema-tooling#schemaissue) suit wording that belongs to one UI.

Official guide: [Error Messages](https://effect.website/docs/v4/schema/error-messages).

## 9. Effectful schemas and services

A getter may do asynchronous work or `yield*` a service. The service then appears in the schema's `DecodingServices` (or `EncodingServices`) and flows into the `R` of `decodeUnknownEffect`, where a layer satisfies it. **An effectful schema needs an Effect runner** ([section 1 of Schema](schema#1-decoding-and-encoding-pick-your-result-style)).

```ts
import { Context, Effect, Schema, SchemaGetter, SchemaIssue } from "effect"
import type { Layer } from "effect"

class EmployeeDirectory extends Context.Service<EmployeeDirectory, {
  readonly exists: (id: string) => Effect.Effect<boolean>
}>()("app/EmployeeDirectory") {}

const KnownEmployeeId = Schema.NonEmptyString.pipe(
  Schema.decode({
    decode: SchemaGetter.transformEffect((id: string, options) =>
      Effect.gen(function*() {
        const directory = yield* EmployeeDirectory
        if (yield* directory.exists(id)) return id
        return yield* Effect.fail(
          new SchemaIssue.InvalidValue({ message: "unknown employee" }, id, options)
        )
      })
    ),
    encode: SchemaGetter.passthrough()
  })
)
// typeof KnownEmployeeId.DecodingServices is EmployeeDirectory

const RaiseBatch = Schema.Array(
  Schema.Struct({ employeeId: KnownEmployeeId, percent: Schema.Finite })
)

declare const DirectoryLive: Layer.Layer<EmployeeDirectory>

// Eight lookups at a time; the requirement is discharged where the program is assembled.
const decodeBatch = (input: unknown) =>
  Schema.decodeUnknownEffect(RaiseBatch)(input, { concurrency: 8, errors: "all" }).pipe(
    Effect.provide(DirectoryLive)
  )
```

| Need | Use |
| --- | --- |
| Convert with a service or async step | `SchemaGetter.transformEffect((value, options) => Effect)` — fail with a `SchemaIssue` |
| Validate without changing the value | `SchemaGetter.checkEffect` inside `Schema.decode({ ... })` ([SchemaGetter](schema-tooling#schemagetter)) |
| A default or fallback that needs a service | an effectful default ([section 8 of Schema](schema#8-default-values)) or `Schema.catchDecodingWithContext` |
| Run children in parallel | the `concurrency` parse option ([section 5](#5-parse-options-are-boundary-policy)) |

**Keep the requirement visible.** A lookup hidden inside a synchronous predicate cannot be provided, mocked, traced, or interrupted; a getter that names its service can. And keep the two questions apart: a schema answers "does this input have the required shape and local constraints, given reference data?"; whether the operation may happen *now* (budget left, cycle open) is domain policy that belongs in a service, with its own tagged error.

**Reach for it when** you need to validate, parse, serialize, or describe data crossing any boundary.
