# Schema

Effect v4 rebuilt Schema around a single `Codec` abstraction: a two-way, validating, possibly-effectful bridge between two TypeScript types. `Type` is the decoded, in-memory value; `Encoded` is the wire/storage shape. `decode` goes Encoded → Type (with validation); `encode` goes Type → Encoded. `Schema.String` is the degenerate case (both sides `string`); `Schema.FiniteFromString` (`Encoded = string`, `Type = number`) is the usual numeric boundary. Satellite modules — `SchemaParser`, `SchemaIssue`, `SchemaGetter`, `SchemaTransformation`, `SchemaRepresentation` — are the implementation; `Schema` is the interface.

> **Official companion:** Effect's release-matched [comprehensive Schema guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.116/packages/effect/SCHEMA.md) goes substantially deeper into codecs, constraints, transformations, serialization, generated tooling, integrations, and migration.
>
> **Official guides:** [Introduction to Effect Schema](https://effect.website/docs/v4/schema/introduction) (its parse-option and `transformOrFail` spellings predate `rc.113`); section-specific guides are linked where they apply. These track Effect's `main` branch rather than the pinned `rc.116` release, so where they differ, this page and the tagged source win.

## Schema

`effect/Schema` — stable

The core module: declare data shape and validation; get back a value that is simultaneously a type-level description (`Type` and `Encoded`), a runtime validator, a two-way codec, and a seed for derived artifacts (JSON Schema, arbitraries, equivalence, formatters).

**Mental model.** A schema is a `Codec<Type, Encoded, RD, RE>`: decodes into `Type`, encodes from `Encoded`, decoding may require services `RD`, encoding may require services `RE`. Use `typeof Employee.Type` and `typeof Employee.Encoded` rather than reading the full `Schema.Struct<...>` type. When a `Schema.Schema<T>` widens and loses `Encoded`, call `Schema.revealCodec(schema)` to recover the full `Codec<T, E, RD, RE>` view.

**Prerequisites and naming.** Schema assumes `strict: true`. **Turn on `exactOptionalPropertyTypes` too**, because `Schema.optionalKey(S)` means "absent, or present as an `S`": with the flag off TypeScript accepts `{ key: undefined }` and the decoder then rejects it at runtime. Library names follow one rule worth copying for your own codecs: a bare name (`Schema.Date`, `Schema.Trimmed`) only validates, so `Encoded` equals `Type`; `TFromE` (`DateFromString`) or a verb (`Trim`) transforms. In generic code, extract types with `Schema.Schema.Type<S>`, `Schema.Codec.Encoded<S>`, `Schema.Codec.DecodingServices<S>`, and `Schema.Codec.EncodingServices<S>`.

> **Numeric boundary warning:** `Schema.Number` intentionally accepts `NaN`, `Infinity`, and `-Infinity` (their JSON encoding uses strings). `Schema.NumberFromString` can decode them too. For money, percentages, coordinates, scores, and most domain quantities, use `Schema.Finite` / `Schema.FiniteFromString`; add `Schema.Int`, `Schema.Natural`, range checks, or brands when the domain is narrower. Use bare `Number` only when non-finite IEEE-754 values are genuinely part of the model.

`Schema.Natural` means a non-negative safe integer, including zero. `Schema.Date` accepts only valid `Date` instances (an `Invalid Date` fails); use `DateFromString` or `DateFromMillis` for ISO text or safe-integer epoch milliseconds, and both reject transformations that produce an invalid date. `Schema.Void` is for ignored return values: it accepts any present runtime value and decodes it to `undefined`; use `Schema.Undefined` when the boundary must contain literal `undefined`.

### 1. Decoding and encoding — pick your result style

Runners form a matrix: how failures surface × whether input is typed (`decode`) or `unknown` (`decodeUnknown`). For untrusted external input use `decodeUnknownSync` at a boundary or `decodeUnknownEffect` inside a program.

```ts
import { Effect, Schema } from "effect"

// The HRIS sends salaries as strings. Encoded = string, Type = number — a real codec.
const SalaryFromString = Schema.FiniteFromString

// At a trusted boundary: throw on bad input.
console.log(Schema.decodeUnknownSync(SalaryFromString)("185000")) // 185000

// Inside a program: failures land in the typed error channel as a SchemaError.
const program = Effect.gen(function*() {
  const base = yield* Schema.decodeUnknownEffect(SalaryFromString)("185000")
  // base: number
  return base * 1.04 // a 4% merit bump
})

// Encoding goes the other way: Type -> Encoded (number -> the wire string).
Effect.runPromise(Schema.encodeUnknownEffect(SalaryFromString)(192400)).then(console.log)
// "192400"
```

| You want | Use | On failure |
| --- | --- | --- |
| Boundary code that fails loudly | `decodeUnknownSync(s)(x)` | throws `SchemaError` |
| Decode inside `Effect.gen` | `decodeUnknownEffect(s)(x)` | `Effect<A, SchemaError>` |
| Inspect an `Exit` | `decodeUnknownExit(s)(x)` | `Exit<A, SchemaError>` |
| Only ask whether it parses | `decodeUnknownOption(s)(x)` | `Option<A>` |
| A synchronous value without exceptions | `decodeUnknownResult(s)(x)` | `Result<A, SchemaError>` |
| Promise interop | `decodeUnknownPromise(s)(x)` | rejects |

> **Note:** Every runner has an `encode*` twin and a non-`Unknown` variant (`decodeSync`, etc.) for when the input type already matches `Encoded`.

**Choose the runner by who consumes the failure.**

- **Effect runner** when typed composition, services, or interruption matter. It is the only runner for an [effectful schema](#18-effectful-schemas-and-services): the `Sync`, `Option`, `Result`, `Exit`, and `Promise` runners accept only schemas whose `DecodingServices` / `EncodingServices` are `never` (a compile error otherwise). A service-free schema that still does *asynchronous* work is accepted by the types but not by the synchronous adapters: `decodeUnknownSync` and `decodeUnknownResult` throw a plain `Error` wrapping an `AsyncFiberError` defect instead of a `SchemaError`, and `decodeUnknownExit` returns a `Die`. Only `decodeUnknownPromise` tolerates async steps outside an Effect.
- **`Result` / `Exit`** when pure code branches on the outcome. **`Option`** only when discarding the diagnostics is intended.
- **Throwing `Sync`** only at an edge that already speaks exceptions (a script, a framework callback) and catches there.

> **Warning:** `Effect.sync(() => Schema.decodeUnknownSync(S)(input))` has error type `never`, so bad input becomes a **defect** that no `Effect.catchTag("SchemaError", ...)` can see. Inside an Effect, call `Schema.decodeUnknownEffect(S)(input)` so the expected boundary outcome stays in the typed error channel. The two sibling mistakes are casting (`input as Employee`) and `Effect.orElseSucceed(() => believableDefault)` straight after decoding, which hides a parse failure behind plausible data.

Per-call behavior — excess keys, error accumulation, concurrency, rejected-input reporting — is covered in [Parse options are boundary policy](#14-parse-options-are-boundary-policy).

Official guide: [Getting Started](https://effect.website/docs/v4/schema/getting-started) (its `"preserve"`, `propertyOrder`, and `parseOptions`-annotation passages do not apply to `rc.116`).

### 2. Type vs Encoded — the distinction that runs everything

A schema carries two TypeScript types. `toType` produces a schema whose `Encoded` equals its `Type` (useful when the input is already decoded and only validation is needed). `toEncoded` gives the wire shape. `flip` swaps both directions.

For generic APIs that only consume one direction, accept `Schema.Decoder<T, RD>` or `Schema.Encoder<E, RE>`; these retain the relevant type and service requirements while deliberately erasing the other direction. Use the full `Codec<T, E, RD, RE>` only when both decoding and encoding matter.

```ts
import { Schema } from "effect"

const schema = Schema.FiniteFromString
type T = typeof schema.Type    // number  (a salary in memory)
type E = typeof schema.Encoded // string  (the salary on the wire)

// Project a schema down to just the decoded side (Type == Encoded == number).
const justType = Schema.toType(schema)

// Project to just the encoded side (string).
const justEncoded = Schema.toEncoded(schema)

// Swap decode/encode directions: now decodes number -> string.
const flipped = Schema.flip(schema)
```

**What the projections keep.** `toType` keeps the checks attached to the decoded side and drops the transformation plus any encoded-side checks; `toEncoded` does the opposite. Neither result needs services. For `Schema.FiniteFromString.check(Schema.isGreaterThan(0))`, the `toType` projection validates a value that is already a number and still enforces the range (use it to avoid decoding container elements twice), while the `toEncoded` projection accepts any string — `"-1"` included — because the range check lives on the decoded side.

**Name both positions from day one**, even when they are identical: `type Employee = typeof Employee.Type` and `type EmployeeWire = typeof Employee.Encoded`. The second name lets a signature say "this has not crossed the boundary yet", and it removes the temptation to write a helper that takes the wire type and casts it to the domain type. When introducing Schema into existing code, start with structure plus `.check(...)` only; add brands, transformations, defaults, and classes once the boundary exists.

Official guide: [Schema Projections](https://effect.website/docs/v4/schema/projections).

### 3. Structs, the workhorse

`Struct` builds object schemas. Fields are schemas; wrap in `optionalKey` (key may be absent) or `optional` (absent or `undefined`) to control optionality. Spread `SomeStruct.fields` to reuse field sets across schemas.

```ts
import { Schema } from "effect"

// Audit columns we reuse on every persisted entity.
const Timestamped = Schema.Struct({
  createdAt: Schema.Date,
  updatedAt: Schema.Date
})

const Employee = Schema.Struct({
  ...Timestamped.fields,                  // reuse a field set
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String,
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })), // e.g. IC4 -> 4
  baseSalary: Schema.BigDecimalFromString, // currency: BigDecimal in memory, string on the wire
  managerId: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))) // top of the org chart has none
})

// { readonly createdAt: Date; readonly updatedAt: Date; readonly id: number;
//   readonly name: string; readonly level: number;
//   readonly baseSalary: BigDecimal; readonly managerId?: number }
type Employee = typeof Employee.Type

const alice = Schema.decodeUnknownSync(Employee)({
  createdAt: new Date(), updatedAt: new Date(),
  id: 1, name: "Alice", level: 5, baseSalary: "185000"
})
```

`optionalKey` and `optional` differ at runtime, not only in the type; the full input-state table, `null` handling, and `Option`-typed fields are in [Optional fields, null, and Option](#15-optional-fields-null-and-option).

**Deriving structs.** v4 has no `Schema.pick` / `omit` / `partial` / `required`. A struct is reshaped by passing a plain function over its `fields` record to `.mapFields(...)`, and the generic [`Struct`](data-structures#struct) module supplies those functions.

```ts
import { Schema, Struct, Tuple } from "effect"

const Employee = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String,
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  baseSalary: Schema.BigDecimalFromString
})

const PublicEmployee = Employee.mapFields(Struct.omit(["baseSalary"]))
const EmployeeRef = Employee.mapFields(Struct.pick(["id"]))
const EmployeePatch = Employee.mapFields(Struct.map(Schema.optionalKey)) // PATCH body: every key may be absent
const LevelChange = Employee.mapFields(Struct.mapPick(["level"], Schema.optionalKey)) // only `level` optional
const Audited = Employee.mapFields(Struct.assign({ updatedBy: Schema.String }))

// Different key names on the Encoded side: snake_case columns, camelCase domain.
const EmployeeRow = Schema.Struct({
  employeeId: Schema.Int,
  hiredAt: Schema.DateFromString
}).pipe(Schema.encodeKeys({ employeeId: "employee_id", hiredAt: "hired_at" }))

Schema.decodeUnknownSync(EmployeeRow)({ employee_id: 7, hired_at: "2026-01-05T00:00:00.000Z" })
// { employeeId: 7, hiredAt: Date }

// Add shared fields to every member of a union in one expression.
const AuditedAction = Schema.Union([
  Schema.TaggedStruct("Raise", { amount: Schema.Finite }),
  Schema.TaggedStruct("Bonus", { amount: Schema.Finite })
]).mapMembers(Tuple.map(Schema.fieldsAssign({ actorId: Schema.String })))
```

| Need | Pass to `mapFields` |
| --- | --- |
| Keep / drop keys | `Struct.pick([...])`, `Struct.omit([...])` |
| Make every key optional / required | `Struct.map(Schema.optionalKey)` or `Struct.map(Schema.optional)`; `Struct.map(Schema.requiredKey)` or `Struct.map(Schema.required)` |
| Change only some keys | `Struct.mapPick(keys, f)`, `Struct.mapOmit(keys, f)`, `Struct.evolve({ key: f })` |
| Add or replace fields | `Struct.assign({ ... })` |
| Rename decoded keys | `Struct.renameKeys({ old: "new" })`; pair it with `Schema.encodeKeys` to keep the old wire name |
| Mutable properties | `Struct.map(Schema.mutableKey)`; for an array or tuple schema use `Schema.mutable(schema)` (shallow; it keeps the schema's checks and annotations and throws for a schema that carries an encoding). Every constructor infers `readonly` by default |

> **Warning:** `mapFields` **drops struct-level `.check(...)` filters**, because the old predicate may not type-check against the new shape. Re-attach the rule, or pass `{ unsafePreserveChecks: true }` as the second argument when the predicate provably still applies.

`Schema.encodeKeys` leaves unmapped keys alone and fails at construction when two fields map to the same encoded name. `Schema.annotateKey({ ... })` attaches key-level metadata (`title`, `description`, `messageMissingKey`) that JSON Schema output and error messages use. Since `rc.113` a declared struct field may be **inherited** from the input's prototype and is copied to an own property of the output; check ownership before parsing if every field must be own.

### 4. Unions, literals, records, tuples

`Union([...])` normally evaluates viable members in order, but it first uses literal sentinel fields to discard contradicted candidates. RC 108 applies the same pruning to nested unions by collecting sentinels common to their members, so an error tree may omit branches already contradicted by the observed discriminator. `Literals([...])` is the array form of a literal union; supports `.pick([...])` and `.transform([...])`. `Record(key, value)` takes two positional schemas. `Tuple([...])` takes an element array. Refined key schemas in a `Record` select matching properties rather than rejecting the whole object.

```ts
import { Schema } from "effect"

const PerformanceRating = Schema.Literals(["exceeds", "meets", "below"])
const GrantKind = Schema.Union([Schema.Literal("RSU"), Schema.Literal("ISO")])
// merit budget per department: { readonly [departmentId: string]: BigDecimal }
const MeritBudgets = Schema.Record(Schema.String, Schema.BigDecimal)
// a comp-band row: readonly [level, salaryMid]
const BandRow = Schema.Tuple([
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  Schema.BigDecimalFromString
])

Schema.decodeUnknownSync(PerformanceRating)("exceeds")   // "exceeds"
Schema.decodeUnknownSync(BandRow)([5, "190000"])         // [5, BigDecimal]
```

If encoded record keys transform to the same output key, there is no collision combiner: later synchronous entries win, while effectful concurrent decoding can make completion order decide the winner. Design key transformations to remain injective instead of relying on overwrite order.

`TaggedUnion` builds a discriminated union from a map of tag → fields and provides a type-safe `.match`:

```ts
import { Schema } from "effect"

const CompAction = Schema.TaggedUnion({
  Raise:     { amount: Schema.BigDecimal },
  Promotion: {
    fromLevel: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    toLevel: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))
  },
  Bonus:     { amount: Schema.BigDecimal, reason: Schema.String }
})

const describe = CompAction.match({ _tag: "Promotion", fromLevel: 4, toLevel: 5 }, {
  Raise:     (r) => `raise of ${r.amount}`,
  Promotion: (p) => `promote ${p.fromLevel} -> ${p.toLevel}`,
  Bonus:     (b) => `bonus: ${b.reason}`
})
```

`TaggedUnion` and a union augmented with `Schema.toTaggedUnion(tag)` also expose `.discriminants`: an ordered tuple of their literal tag values. Duplicate or missing discriminants are rejected while building the augmented union. The same augmentation provides `.cases` (member schema per tag), `.guards`, `.isAnyOf([...tags])`, and `.matchOrElse(value, cases, orElse)`, which handles a subset of tags and hands every remaining member — typed as the residual union — to `orElse`.

**Tagged structs.** `Schema.tag("Raise")` is a literal field with a constructor default, and `Schema.TaggedStruct("Raise", fields)` is shorthand for a struct whose `_tag` is that field. **`make` fills the tag; decoding and encoding still require it on the wire.** When the external payload has no discriminator, `Schema.tagDefaultOmit` supplies it while decoding or constructing and strips it on encode.

```ts
import { Schema } from "effect"

const Raise = Schema.TaggedStruct("Raise", { amount: Schema.Finite })
Raise.make({ amount: 5 }) // { _tag: "Raise", amount: 5 }
// Schema.decodeUnknownSync(Raise)({ amount: 5 }) fails: Missing key at ["_tag"]

// The payroll vendor sends no discriminator: add it on decode, strip it on encode.
const VendorRaise = Schema.Struct({ amount: Schema.Finite }).mapFields((fields) => ({
  ...fields,
  _tag: Schema.tagDefaultOmit("Raise")
}))
Schema.decodeUnknownSync(VendorRaise)({ amount: 5 })                 // { amount: 5, _tag: "Raise" }
Schema.encodeUnknownSync(VendorRaise)({ _tag: "Raise", amount: 5 }) // { amount: 5 }
```

**Template literals and open-ended shapes.** `Schema.TemplateLiteral(parts)` only validates a string against a template; `Schema.TemplateLiteralParser(parts)` decodes the same string into a typed tuple and encodes it back, replacing regex-plus-split code. `TemplateLiteral` throws at construction when a part carries an encoding (`FiniteFromString`), so transformed parts belong in the parser. Since `onExcessProperty: "preserve"` no longer exists, properties beyond the declared fields survive decoding only when the schema models them.

```ts
import { Schema } from "effect"

// Validate only: Type is the template-literal string type `emp_${number}`.
const EmployeeRef = Schema.TemplateLiteral(["emp_", Schema.Finite])

// Parse: decode into a typed tuple, encode back to the string.
const GrantRef = Schema.TemplateLiteralParser([
  "grant-",
  Schema.FiniteFromString,
  "/",
  Schema.Literals(["RSU", "ISO"])
])
Schema.decodeUnknownSync(GrantRef)("grant-42/RSU")             // ["grant-", 42, "/", "RSU"]
Schema.encodeUnknownSync(GrantRef)(["grant-", 42, "/", "ISO"]) // "grant-42/ISO"

// Index signature next to fixed fields: extra string labels are kept and validated.
const LabeledEmployee = Schema.StructWithRest(
  Schema.Struct({ id: Schema.String }),
  [Schema.Record(Schema.String, Schema.String)]
)

// readonly [string, number?, ...boolean[]]
const ImportArgs = Schema.TupleWithRest(
  Schema.Tuple([Schema.String, Schema.optionalKey(Schema.Finite)]),
  [Schema.Boolean]
)

// A literal-union key yields a fixed-key object type: both keys are required.
const PayComponents = Schema.Record(Schema.Literals(["base", "bonus"]), Schema.Finite)
```

Also available: `Schema.NonEmptyArray(item)` (infers `readonly [A, ...A[]]`), `Schema.ArrayEnsure(item)` (a single value or an array decodes to an array; a one-element array encodes back to the single value), `Schema.UniqueSymbol(sym)`, `Schema.Enum(TsEnum)` (exposes `.enums`; rejects non-finite numeric members), `Schema.JsonObject` (a string-keyed record of `Schema.Json` values — arrays and non-JSON leaves such as `Date` fail), and the primitives `BigInt`, `Symbol`, `ObjectKeyword`, `Any`, `Unknown`, `Never`, `Null`. Schema values keep their parts public — `.fields`, `.members`, `.elements`, `.rest`, `.literals`, `.key` / `.value`, `.schema` — so they can be recombined. `Schema.Literal(0)` and `Schema.Literal(-0)` each accept either signed zero and preserve the input's sign; add a transformation when a canonical sign matters.

Official guide: [Basic Usage](https://effect.website/docs/v4/schema/basic-usage) (its "Transforming Keys" passage is stale: `rc.116` records accept transformed key schemas).

### 5. Refinements — `check` and `refine`

`check` attaches one or more filters (predicates that do not change the type); built-in filters now carry an `is` prefix. `refine` attaches a type-narrowing refinement. `Schema.makeFilter` builds ad-hoc filters that can return rich failures: `undefined`/`true` for success, a `string` message, a `{ path, issue }` for a nested failure, or an array of issues to report multiple failures at once.

```ts
import { Schema } from "effect"

// Built-in checks (note the `is` prefix). check takes a variadic list.
const Level = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10))
)
const NonEmptyName = Schema.String.check(Schema.isMinLength(1))
const VestingMonths = Schema.Natural.check(Schema.isBetween({ minimum: 0, maximum: 48 }))

// A custom cross-field check: a recommended salary must sit inside its band.
const RaiseRecommendation = Schema.Struct({
  proposedSalary: Schema.Finite,
  bandMin: Schema.Finite,
  bandMax: Schema.Finite
}).check(
  Schema.makeFilter((o) =>
    o.proposedSalary >= o.bandMin && o.proposedSalary <= o.bandMax
      ? undefined
      : { path: ["proposedSalary"], issue: "proposed salary is outside the comp band" }
  )
)
```

**Built-in checks by carrier.** Every one takes a trailing annotations argument (`{ message }`, `{ expected }`, ...); there are no bare `minLength`, `between`, or `pattern` names.

| Carrier | Checks |
| --- | --- |
| String | `isMinLength(n)`, `isMaxLength(n)`, `isLengthBetween(min, max)`, `isNonEmpty()`, `isPattern(regExp)`, `isStartsWith`, `isEndsWith`, `isIncludes`, `isTrimmed`, `isLowercased`, `isUppercased`, `isCapitalized`, `isUncapitalized`, `isUUID(version?)`, `isGUID`, `isULID`, `isBase64`, `isBase64Url` |
| Number | `isGreaterThan`, `isGreaterThanOrEqualTo`, `isLessThan`, `isLessThanOrEqualTo`, `isBetween({ minimum, maximum })`, `isInt`, `isInt32`, `isUint32`, `isFinite`, `isMultipleOf(n)` (throws for a zero or non-finite divisor) |
| Array | the string length checks, plus `isUnique()` and `isUniqueKey()` (unique first elements in an array of `[key, value]` tuples) |
| Map / Set, object | `isMinSize`, `isMaxSize`, `isSizeBetween`; `isMinProperties`, `isMaxProperties`, `isPropertiesLengthBetween`, `isPropertyNames(keySchema)` |
| `Date`, `bigint`, `BigDecimal` | the comparison family with a suffix: `isBetweenDate`, `isGreaterThanBigInt`, `isLessThanOrEqualToBigDecimal`, ... |

Prebuilt aliases cover the common combinations (`Schema.NonEmptyString`, `Schema.Int`, `Schema.Natural`, `Schema.Trimmed`). `Duration` has no dedicated family; write a `makeFilter` over `Duration` predicates.

**Filter annotations, `abort`, and groups.** `Schema.makeFilter(predicate, annotations?, abort?)` receives `(input, ast, options)` and may return `undefined` / `true` (pass), `false`, a message string, `{ path, issue }`, a full `SchemaIssue.Issue`, or an array of those. Its annotations decide what every derivation sees: `expected` / `message` for error text, **`toJsonSchema` so the rule reaches generated JSON Schema and OpenAPI (a custom predicate is otherwise invisible there)**, and `arbitraryConstraint` so the native generator satisfies the rule constructively instead of by rejection. `.abort()` on a filter stops later checks from running once it fails; `Schema.makeFilterGroup([...checks], annotations)` packages a reusable set.

```ts
import { Schema } from "effect"

const slugPattern = "^[a-z0-9-]+$"

const isSlug = Schema.makeFilter(
  (s: string) => new RegExp(slugPattern).test(s),
  {
    expected: "a lowercase slug",
    toJsonSchema: () => ({ pattern: slugPattern }),
    arbitraryConstraint: { patterns: [{ source: slugPattern, flags: "" }] }
  }
)

// An empty string reports only the first failure, even with { errors: "all" }.
const DepartmentSlug = Schema.String.check(Schema.isNonEmpty().abort(), isSlug)

const CodeLength = Schema.makeFilterGroup(
  [Schema.isMinLength(3), Schema.isMaxLength(10)],
  { title: "cost-center code length" }
)
const CostCenterCode = Schema.String.check(CodeLength, isSlug)
```

**Order of narrowing: structure, then checks, then a refinement only if the static type really narrows, then the brand.**

- **A check never trims, parses, or defaults** — that is a transformation ([section 6](#6-transformations-decodeto-getters)). A check that "fixes" its input cannot exist: the predicate's return value is a verdict, not a new value.
- **A check is synchronous and service-free.** "Is this cost-center code still free?" is an effectful decode step whose requirement stays visible in the schema type ([`SchemaGetter.checkEffect`](#schemagetter)), never a lookup hidden inside a predicate.
- **Bound attacker-reachable input in the schema itself** — string lengths, collection sizes, recursion depth — and test those bounds like any other rule.

Official guide: [Filters](https://effect.website/docs/v4/schema/filters).

### 6. Transformations — `decodeTo` + getters

Transformations are written with `decodeTo(target, transformation)`, where the transformation is a `SchemaTransformation` (two-way) or a pair of one-way `SchemaGetter`s.

```ts
import { Schema, SchemaGetter, SchemaTransformation } from "effect"

// Pair of getters: explicit decode + encode directions. Share count <-> string.
const SharesFromText = Schema.String.pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), {
    decode: SchemaGetter.transform((s) => Number(s)),
    encode: SchemaGetter.transform((n) => String(n))
  })
)

// A prebuilt two-way SchemaTransformation reads cleaner when one exists.
// The HRIS encodes employment status as "active"/"terminated".
const ActiveFromStatus = Schema.Literals(["active", "terminated"]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (status) => status === "active",
      encode: (isActive) => (isActive ? "active" : "terminated")
    })
  )
)

Schema.decodeUnknownSync(SharesFromText)("4000")    // 4000
Schema.decodeUnknownSync(ActiveFromStatus)("active") // true
```

For a transformation that can fail, use `SchemaGetter.transformEffect` and return an `Effect` that fails with a `SchemaIssue`. (It was named `transformOrFail` until `rc.113`; `SchemaTransformation.transformOrFail` became `SchemaTransformation.transformEffect` in the same release, matching `Config.mapEffect` and the rest of the library.) When a conversion is decode-only, use `SchemaGetter.forbiddenEncoding` as the `encode` leg so an attempt to encode fails with a `Forbidden` issue instead of inventing a value. For async validation, use `SchemaGetter.checkEffect` inside a `Schema.decode({...})` — the v4 replacement for `filterEffect`.

```ts
import { Effect, Number, Option, Schema, SchemaGetter, SchemaIssue } from "effect"

// A share count must be a real non-negative integer; reject junk like "abc".
const SharesFromStringStrict = Schema.String.pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), {
    decode: SchemaGetter.transformEffect((s) =>
      // Number.parse returns Option<number>; turn None into a schema issue.
      Option.match(Number.parse(s), {
        onNone: () => Effect.fail(new SchemaIssue.InvalidValue({ message: "not a share count" }, s)),
        onSome: (n) => Effect.succeed(n)
      })
    ),
    encode: SchemaGetter.String()
  })
)
```

**Data flow of `decodeTo`.** `source.pipe(Schema.decodeTo(target, bridge))` decodes with the *source* schema first, maps source `Type` to target `Encoded` through the bridge, then decodes with the *target* schema; encoding runs the same three steps in reverse. Three consequences:

- **When source `Type` already equals target `Encoded`, call `decodeTo(target)` with no bridge.** That is schema composition.
- **When the target is a container of the same item schema, wrap the item in `Schema.toType(item)`** so elements are not decoded twice.
- A transformation has **three independent failure sites** — the source schema, the getter, the target schema — and each takes its own message ([Custom error messages](#17-custom-error-messages)).

```ts
import { Schema } from "effect"

const PageRequest = Schema.Struct({ page: Schema.Int, size: Schema.Int })

// string -(URI-decode)-> string -(JSON.parse + validate)-> PageRequest
const PageFromQueryValue = Schema.StringFromUriComponent.pipe(
  Schema.decodeTo(Schema.fromJsonString(PageRequest))
)

Schema.decodeUnknownSync(PageFromQueryValue)("%7B%22page%22%3A1%2C%22size%22%3A20%7D")
// { page: 1, size: 20 }
```

Getters that call services or do asynchronous work are covered in [Effectful schemas and services](#18-effectful-schemas-and-services).

Official guide: [Schema Transformations](https://effect.website/docs/v4/schema/transformations) (it still spells `transformEffect` as `transformOrFail`, and it predates `SchemaGetter.forbiddenEncoding`).

### 7. Branded schemas

`brand` narrows the type nominally (no runtime check). `fromBrand` additionally wires in a `Brand.Constructor`'s checks.

```ts
import { BigDecimal, Schema } from "effect"

const EmployeeId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("EmployeeId"))
type EmployeeId = typeof EmployeeId.Type // number & Brand<"EmployeeId">

// Branding usually rides on top of validation. Money is a non-negative BigDecimal.
const Money = Schema.BigDecimal.check(
  Schema.isGreaterThanOrEqualToBigDecimal(BigDecimal.fromBigInt(0n))
).pipe(Schema.brand("Money"))
type Money = typeof Money.Type // BigDecimal & Brand<"Money">
```

**A brand is identity, not validation.** `Schema.String.pipe(Schema.brand("EmployeeId"))` accepts `""`; the rules come from the checks underneath. Three habits follow:

- **A brand is earned by decoding (or `make`).** `raw as EmployeeId` bypasses the gate and makes the brand meaningless, so reserve the cast for test fixtures of already-valid data.
- **Brands prevent mixing, they do not sanitize.** An `EmployeeId` that is also a SQL fragment is still a SQL fragment.
- **One owner per rule.** When a [`Brand`](functional-toolkit#brand) constructor already exists, reuse it with `Schema.fromBrand(identifier, constructor)` — identifier first — instead of restating its checks.

```ts
import { Brand, Schema } from "effect"

type PositiveInt = number & Brand.Brand<"PositiveInt">
const PositiveInt = Brand.check<PositiveInt>(Schema.isInt(), Schema.isGreaterThan(0))

// The schema runs the constructor's checks and produces the same branded type.
const PositiveIntSchema = Schema.Number.pipe(Schema.fromBrand("PositiveInt", PositiveInt))
Schema.decodeUnknownSync(PositiveIntSchema)(3) // 3 as PositiveInt; -3 fails
```

Official guide: [Branded Types](https://effect.website/docs/v4/code-style/branded-types).

### 8. Default values

`withConstructorDefault` fills a field when building a value with `Schema.make`/`new`. `withDecodingDefault` / `withDecodingDefaultKey` fill a missing field during decoding. Defaults are `Effect`s and may be effectful (generated id, clock-derived timestamp).

```ts
import { Effect, Schema } from "effect"

const GrantDefaults = Schema.Struct({
  // Filled by the constructor when omitted (rating has only a decoding default, so make still requires it).
  vestingMonths: Schema.Natural.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(48))
  ),
  // Filled while decoding when the HRIS omits the rating.
  rating: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("meets")))
})

GrantDefaults.make({ rating: "meets" })                 // { vestingMonths: 48, rating: "meets" }
Schema.decodeUnknownSync(GrantDefaults)({ vestingMonths: 36 }) // { vestingMonths: 36, rating: "meets" }
```

**Which side, and what triggers it.** Five helpers, two axes: is the default written in `Encoded` or `Type` terms, and does an explicit `undefined` count as "missing"?

| Helper | Default is written as | Fires when | Explicit `undefined` |
| --- | --- | --- | --- |
| `withDecodingDefaultKey(effect)` | an `Encoded` value, then decoded | key is absent | rejected |
| `withDecodingDefault(effect)` | an `Encoded` value, then decoded | key is absent or `undefined` | replaced by the default |
| `withDecodingDefaultTypeKey(effect)` | a `Type` value | key is absent | rejected |
| `withDecodingDefaultType(effect)` | a `Type` value | key is absent or `undefined` | replaced by the default |
| `withConstructorDefault(effect)` | the constructor input | only `make` / `new` | not applicable — decoding never consults it |

- **Prefer the `Type` variants once a field has a transformation**: the default for a `FiniteFromString` field is `1`, not `"1"`, and for a `DateTimeUtcFromString` field it can be `DateTime.now`, which reads the `Clock` and is therefore controllable with `TestClock`.
- **A decoding default fires for absence only.** An explicit `false`, `0`, or `""` is a present value and survives; an explicit value that violates the field's checks fails instead of being replaced; `null` is not absence. This is exactly the bug that `value || fallback` after decoding introduces.
- **`{ encodingStrategy }`** (all four decoding helpers) decides what encoding writes: `"passthrough"` (the default) emits the value; `"omit"` always drops the key, so a non-default value does not survive a round trip. `"omit"` suits constants — `Schema.tagDefaultOmit` is built from it.
- **Constructor defaults never apply while decoding**, including inside `Schema.Class`: an `optionalKey` field with `withConstructorDefault(Effect.succeed([]))` decodes to an absent key and gets `[]` only through `new` / `make`. They also do not make the encoded key optional.
- **A constructor default is re-evaluated on every `make` / `new`** (`Effect.sync(() => crypto.randomUUID())` yields fresh values), it **travels with the field** (`Schema.Struct({ id: Grant.fields.id })` inherits it), and an **outer default may be partial**: its type is the constructor *input*, so nested defaults complete it.

```ts
import { DateTime, Effect, Schema } from "effect"

const ApprovalPolicy = Schema.Struct({
  // Type-side default: a decoded number, not the wire string "1".
  requiredApprovers: Schema.FiniteFromString.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(1))
  ),
  // Clock-driven, so TestClock controls it in tests.
  effectiveAt: Schema.DateTimeUtcFromString.pipe(
    Schema.withDecodingDefaultTypeKey(DateTime.now)
  ),
  notifyManager: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true)))
})

Schema.decodeUnknownSync(ApprovalPolicy)({ notifyManager: false })
// { requiredApprovers: 1, effectiveAt: <now>, notifyManager: false } — the explicit false survives

const Notifications = Schema.Struct({
  channel: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("email"))),
  digest: Schema.Boolean
})
const ReviewCycleSettings = Schema.Struct({
  // Partial outer default; the inner `channel` default completes it.
  notifications: Notifications.pipe(Schema.withConstructorDefault(Effect.succeed({ digest: true })))
})
ReviewCycleSettings.make({}) // { notifications: { channel: "email", digest: true } }
```

**Test every default with three cases:** key omitted decodes to the default; an explicit falsy value is kept; an explicit invalid value still fails. A derived arbitrary cannot cover the first case — it generates `Type` values, never "key omitted" wire input — so keep these as named encoded fixtures.

Official guides: [Advanced Usage](https://effect.website/docs/v4/schema/advanced-usage) (decoding defaults and the missing / `undefined` / `null` tables), [Default Constructors](https://effect.website/docs/v4/schema/default-constructors) (nested, lazy, and class-level constructor defaults).

### 9. Classes and tagged errors

`Schema.Class` produces a real class whose constructor validates its fields, with a derived schema attached. `TaggedClass` auto-adds a `_tag`. `Error` and `TaggedError` produce yieldable, schema-validated errors: `yield* new EmployeeNotFound({...})` works inside `Effect.gen`. `Schema.Opaque` types the decoded value as a nominal class rather than its structural shape. A class supports `Base.extend<Sub>("Sub")(extraFields)` for schema-validated subclassing; the `Self` generic is required just as it is on `Schema.Class` (omit it and the result is the `MissingSelfGeneric` error type), and the subclass inherits fields, checks, getters, and methods.

These class builders are distinct from validating an existing JavaScript `Error`: use `Schema.ErrorInstance(options?)` for that. Its JSON representation contains `message` plus optional `name` and `cause`; stack data is omitted unless `includeStack` is enabled, and `excludeCause` removes the cause. Persisted schema representations containing it need `SchemaRepresentation.ErrorInstanceReviver` (every built-in reviver moved from `Schema` to `SchemaRepresentation` in `rc.113`, and the constructors were renamed to `makeReviverDeclaration`, `makeReviverFilter`, and `makeReviverFilterGroup`).

```ts
import { Effect, Schema } from "effect"

class EquityGrant extends Schema.Class<EquityGrant>("EquityGrant")({
  employeeId: Schema.Int.check(Schema.isGreaterThan(0)),
  shares: Schema.Natural,
  grantDate: Schema.Date
}) {}

const grant = new EquityGrant({ employeeId: 1, shares: 4000, grantDate: new Date() })
console.log(`${grant}`) // "EquityGrant({ employeeId: 1, shares: 4000, grantDate: ... })"

// The house error idiom: TaggedError + Schema.Defect() for the cause.
class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  cause: Schema.Defect()
}) {}

const lookup: Effect.Effect<never, EmployeeNotFound> =
  new EmployeeNotFound({ id: 42, cause: "no such row in HRIS" })
```

**What a class schema is.** A declaration wrapped around its field struct: decoding turns a plain object into an instance, encoding turns an instance back into a plain object (a plain object passed to `encode` fails with `Expected <identifier>`). So a class is a codec, not only a validated constructor.

- **The identifier is load-bearing.** It is exposed as `Grant.identifier`, stored in the AST, used in diagnostics and as the JSON Schema `$defs` name, and it drives a runtime marker that still recognizes instances after a hot-module reload replaces the constructor. It must be explicit because the JavaScript class name is not available while `extends` is evaluated and may be minified. Keep it unique and stable.
- **Instances compare structurally.** They extend `Data.Class`, so `Equal.equals(a, b)` is `true` for two separately decoded instances with equal fields while `a === b` is `false`. `Schema.toEquivalence(Grant)` compares the *declared fields* (it fell back to `Equal.equals`, which also saw undeclared runtime properties, before `rc.113`).
- **`new` always builds a fresh instance; `Grant.make(existing)`, `makeOption`, and `makeEffect` return an existing instance unchanged** (since `rc.113`).
- **The fields argument may be a whole `Schema.Struct(...).check(...)`**, so a cross-field rule is enforced by `new`, decoding, and encoding alike; a second argument carries annotations (`title`, `description`).

```ts
import { Equal, Schema } from "effect"

class CompBand extends Schema.Class<CompBand>("comp/CompBand")(
  Schema.Struct({ min: Schema.Finite, max: Schema.Finite }).check(
    Schema.makeFilter(({ min, max }) => min <= max || "min must not exceed max")
  ),
  { title: "Compensation band" }
) {
  get spread() {
    return this.max - this.min
  }
}

class LevelBand extends CompBand.extend<LevelBand>("comp/LevelBand")({
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))
}) {}

const decoded = Schema.decodeUnknownSync(LevelBand)({ min: 150_000, max: 210_000, level: 5 })
decoded instanceof LevelBand // true: plain object -> instance
decoded.spread               // 60000: inherited getter
Schema.encodeSync(LevelBand)(decoded) // { min: 150000, max: 210000, level: 5 }
Equal.equals(decoded, new LevelBand({ min: 150_000, max: 210_000, level: 5 })) // true
// new LevelBand({ min: 2, max: 1, level: 5 }) throws: the inherited cross-field check runs
```

**`Struct` or `Class`?** Default to `Struct` for boundary records. Choose `Class` for a validated constructor, methods or getters, nominal identity, or an integration that needs instances — not merely because the data is "domain data".

| Before committing to a class, test | Why |
| --- | --- |
| `new` / `make` with invalid input | constructors throw `Error("Schema validation failed")` with the issue in `cause` ([section 13](#13-construction-and-deliberate-fallbacks)) |
| decode produces an instance; encode leaks no internals | the class is a codec; getters and private state must not reach the wire |
| round trip under a stated equivalence | use `Equal.equals` or `Schema.toEquivalence`, never `===` |
| the JSON form | `JSON.stringify(instance)` is not the codec; derive `Schema.toCodecJson(Class)` |

Official guide: [Class APIs](https://effect.website/docs/v4/schema/classes) (its sample output for a failing `new` shows formatted issue text; `rc.116` throws the generic message described in section 13).

### 10. Annotations and derivations

`annotate` attaches metadata (title, description, examples, custom keys) that flows into JSON Schema, error messages, and docs. Derivations from the same schema object: `Arbitrary.schema` (native property-test generator, from `effect/unstable/arbitrary`), `toEquivalence` (structural equality), `toFormatter` (pretty-printer), `toStandardSchemaV1` (Standard Schema interop), `toJsonSchemaDocument`.

```ts
import { Schema } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"

const CompBand = Schema.Struct({
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  salaryMid: Schema.Finite
}).pipe(
  Schema.annotate({ title: "CompBand", description: "Salary midpoint for a level" })
)

const eq = Schema.toEquivalence(CompBand)
eq({ level: 5, salaryMid: 190000 }, { level: 5, salaryMid: 190000 }) // true

// Native generator for the decoded Type. `Schema.toArbitrary` and the fast-check
// bridge were removed in rc.113; checks like isBetween generate constructively.
const CompBandArb = Arbitrary.schema(CompBand) // Arbitrary<{ level: number; salaryMid: number }>
const fiveBands = Arbitrary.sampleEffect(CompBandArb, { count: 5, seed: 42 })
```

**Three attachment points.** `annotate` documents the decoded side, `Schema.annotateEncoded` the encoded side (the one JSON Schema sees for a transformation), and `Schema.annotateKey` a struct field or tuple element. **`.annotate(...)` called after `.check(...)` lands on the last check**, not on the base schema, and `Schema.resolveAnnotations(schema)` reads from the same place — so annotate first, then add checks, when the metadata describes the schema as a whole. `examples` and `default` annotations are documentation only; they never affect decoding or construction. A `parseOptions` annotation is ignored since `rc.113` ([section 14](#14-parse-options-are-boundary-policy)).

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
| `Schema.toFormatter` | builds `(value: Type) => string` following the schema; it does not validate. Distinct from the issue formatters in [`SchemaIssue`](#schemaissue) and from the general [`Formatter`](../operations/observability#formatter) module | `Schema.overrideToFormatter`; a `toFormatter` annotation; an `onBefore(ast, recur)` hook that intercepts node kinds (return `undefined` to keep the default) |
| `Arbitrary.schema` | built-in checks generate constructively; a custom filter is satisfied by rejection unless it carries an `arbitraryConstraint` annotation ([section 5](#5-refinements-check-and-refine)); a declaration supplies a generatable stand-in with a `toCodecArbitrary` annotation | see [Arbitrary](../tooling/testing-dev-tooling#arbitrary) (unstable) |
| `Schema.toStandardSchemaV1` | see [StandardSchema](#standardschema) | `leafHook`, `checkHook`, `parseOptions` |

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

Official guides: [Schema Annotations](https://effect.website/docs/v4/schema/annotations) (its `parseOptions` annotation row and its claim that `concurrency` reaches union members are obsolete in `rc.116`), [Schema to Equivalence](https://effect.website/docs/v4/schema/equivalence), [Schema to Formatter](https://effect.website/docs/v4/schema/formatter).

### 11. Serialization codecs

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

Do not use the internal `Schema.UnknownFromJsonString`; compose `Schema.fromJsonString(Schema.Unknown)` when the JSON value is intentionally unknown. The JSON forms of `Option`, `Result`, `Exit`, collections, and `Duration` are tabulated in [Effect data types at the boundary](#16-effect-data-types-at-the-boundary).

### 12. Recursive and custom schemas

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

### 13. Construction and deliberate fallbacks

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

Official guide: [Default Constructors](https://effect.website/docs/v4/schema/default-constructors) (it types `makeEffect` as failing with `SchemaError` and prints formatted text for a throwing `make`; `rc.116` behaves as the table above says).

### 14. Parse options are boundary policy

A schema describes a shape; parse options describe how *this boundary* wants that shape parsed. **Keep them at the call site, not in the schema**, so one schema can back a strict ingress and a tolerant reader without being duplicated.

| Option | Default | Effect |
| --- | --- | --- |
| `errors` | `"first"` | `"all"` collects every issue the traversal can reach |
| `onExcessProperty` | `"ignore"` | `"ignore"` **strips** undeclared keys from the result; `"error"` fails with an unexpected-key issue at that path. Applies to decoding and encoding, at every nesting level |
| `concurrency` | sequential | `number \| "unbounded"` with `Effect.forEach` semantics, for effectful children |
| `reportInput` | `false` | attaches rejected input values to issues (read them via `SchemaIssue.hasInput`); can retain secrets and PII |
| `disableChecks` | `false` | skips checks, still applies defaults and transformations ([section 13](#13-construction-and-deliberate-fallbacks)) |

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
- **The same option name controls [JSON Schema generation](#jsonschema).** Pass `"error"` in both places when the published document and the runtime parser must agree.
- **To keep unknown keys, model them** with `Schema.Record` or `Schema.StructWithRest` ([section 4](#4-unions-literals-records-tuples)). `onExcessProperty: "preserve"` was removed in `rc.113` because it let unvalidated values cross the boundary.
- **Options apply to the whole operation.** Since `rc.113` a `parseOptions` *annotation* no longer affects parsing, so there is no per-node override; `propertyOrder` is gone too, and decoded key order is unspecified — sort at presentation time if order matters.
- **`errors: "all"` does not mean "every rule ran".** An invalid field prevents a struct-level check from running (a cross-field rule is reported only once its fields parse), and an aborting filter stops later checks. Do not assert on the absence of an issue under `"all"`.
- **`concurrency` parallelizes product children only** — tuple and array elements, struct fields, record entries, structs with rest — independently at each nesting level. Union members always stay sequential, because speculatively running candidates would execute transformations that are not selected. With `errors: "first"` the first *observed* failure interrupts its siblings; array order is preserved, but issue order (and the winner of colliding transformed record keys) follows completion order.

### 15. Optional fields, null, and Option

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
- **`Schema.Option(S)` is not a wire codec.** It expects an actual `Option` on both sides and only transforms the payload, so raw JSON fails with `Expected Option`. The `OptionFrom*` family is what bridges wire absence to `Option`; [section 16](#16-effect-data-types-at-the-boundary) covers the JSON form of a real `Option`.
- **`null` is never absence unless the schema says so.** To collapse a wire `null` into an absent key (or a missing key into `null`), compose `optionalKey(NullOr(S))` with a `decodeTo` whose getters use `SchemaGetter.transformOptional` — see the example under [SchemaGetter](#schemagetter).

Official guide: [Advanced Usage](https://effect.website/docs/v4/schema/advanced-usage).

### 16. Effect data types at the boundary

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
| `Schema.Exit(A, E, D)` | `{ _tag: "Success", value }` or `{ _tag: "Failure", cause: [...] }`, where `cause` is a flat array of reasons such as `{ _tag: "Fail", error }` and `{ _tag: "Die", defect }`; `Schema.Defect()` revives error-like defects as `{ name, message }`. Since `rc.116`, `Schema.Cause` encodes each reason to exactly these wire fields, so strict encoding (`onExcessProperty: "error"`) yields the same output |
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
| Secrets | `Schema.Redacted(S, { label?, disallowJsonEncode? })`, `Schema.RedactedFromValue(S, { label?, disallowEncode? })` | the first expects a `Redacted` on both sides and, since `rc.116`, rewraps the inner schema's transformed result (`Schema.Redacted(Schema.NumberFromString)` decodes a `Redacted<string>` to a `Redacted<number>`, keeping the label); the second decodes a raw value and wraps it. The "refuse to encode" option is spelled differently on each |
| Sizes | `Schema.ByteSize`, `ByteSizeFromString`, `ByteSizeFromBigInt`, `ByteSizeFromNumber` | the string form requires a unit (`"5 MiB"`) and encodes the exact count as `"5242880 bytes"`; see [ByteSize](functional-toolkit#bytesize) |
| Graphs | `Schema.Graph("directed" \| "undirected", node, edge)` | immutable [Graph](data-structures#graph) values; derive `toCodecJson` for a `{ type, nodes, edges }` snapshot |
| Network (unstable) | `Schema.IpAddressFromString`, `Ipv4AddressFromString`, `Ipv6AddressFromString`, `IpNetworkFromString`, `InetAddressFromString`, `MacAddressFromString` | text to `effect/unstable/net` values; malformed text fails with a specific message |
| HTTP (unstable) | `Schema.UrlParams`, `Schema.Headers`, `Schema.Cookies`, `Schema.RecordFromUrlParams`, `Schema.RecordFromCookies`, `Schema.JsonFromUrlParamsField(field)` | moved here from the HTTP modules in `rc.113`; usage lives with [UrlParams](../interfaces/http-server#urlparams) |

Official guide: [Effect Data Types](https://effect.website/docs/v4/schema/effect-data-types).

### 17. Custom error messages

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
- **Schema-side text or presentation-side text — pick one owner.** Annotations suit messages that belong to the contract (or i18n keys); [formatter hooks](#schemaissue) suit wording that belongs to one UI.

Official guide: [Error Messages](https://effect.website/docs/v4/schema/error-messages).

### 18. Effectful schemas and services

A getter may do asynchronous work or `yield*` a service. The service then appears in the schema's `DecodingServices` (or `EncodingServices`) and flows into the `R` of `decodeUnknownEffect`, where a layer satisfies it. **An effectful schema needs an Effect runner** ([section 1](#1-decoding-and-encoding-pick-your-result-style)).

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
| Validate without changing the value | `SchemaGetter.checkEffect` inside `Schema.decode({ ... })` ([SchemaGetter](#schemagetter)) |
| A default or fallback that needs a service | an effectful default ([section 8](#8-default-values)) or `Schema.catchDecodingWithContext` |
| Run children in parallel | the `concurrency` parse option ([section 14](#14-parse-options-are-boundary-policy)) |

**Keep the requirement visible.** A lookup hidden inside a synchronous predicate cannot be provided, mocked, traced, or interrupted; a getter that names its service can. And keep the two questions apart: a schema answers "does this input have the required shape and local constraints, given reference data?"; whether the operation may happen *now* (budget left, cycle open) is domain policy that belongs in a service, with its own tagged error.

**Reach for it when** you need to validate, parse, serialize, or describe data crossing any boundary.

## SchemaAST

`effect/SchemaAST` — stable

The introspectable tree behind every schema. Each `Schema` has an `.ast`: a discriminated-union node (`String`, `Number`, `Literal`, `Objects`, `Arrays`, `Union`, `Suspend`, `Declaration`, …) carrying checks, annotations, encoding links, and parse context. This layer makes derivation possible — JSON Schema, arbitraries, equivalence, and the parser all read the AST.

**Mental model.** The AST is the compiler's IR for schemas. A transformation is an encoding link on a node; a refinement is a check on a node; `toType`/`toEncoded`/`flip` are tree rewrites. The `_tag` on every node plus `is*` guards (`isObjects`, `isUnion`, `isString`, …) support tree walking.

```ts
import { Schema, SchemaAST } from "effect"

const Employee = Schema.Struct({
  name: Schema.String,
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))
})

// Every schema exposes its AST node.
const ast = Employee.ast
console.log(ast._tag) // "Objects"

// Walk it: list the field keys and the tag of each field's AST.
if (SchemaAST.isObjects(ast)) {
  for (const ps of ast.propertySignatures) {
    console.log(ps.name, ps.type._tag) // "name" "String", "level" "Number"
  }
}

// Resolve annotations off any node without touching the Schema wrapper.
const title = SchemaAST.resolveTitle(Schema.String.annotate({ title: "Name" }).ast)
```

> **Note:** Handy AST utilities: `SchemaAST.getAST(schema)` (the node), `toType`/`toEncoded`/`flip` (memoized tree rewrites that power the `Schema`-level functions of the same name), `annotate`/`appendChecks`/`replaceEncoding` (build derived nodes), and `resolveTitle`/`resolveDescription`/`resolveIdentifier` (read annotations). The node classes — `Objects`, `Arrays`, `Union`, `Literal`, `Declaration` — are exported if you need to construct one. Since `rc.113` the `SchemaAST` and `SchemaIssue` nodes and the `SchemaTransformation` models are published as **structural instance interfaces**: `new` and `instanceof` still work, but a constructor's `prototype` is no longer part of the TypeScript API, so name the instance interface (`SchemaAST.AST`, `SchemaTransformation.Transformation<T, E>`) in type positions. `SchemaGetter.Getter<T, E, R>` is a tagged union with no constructor at all since `rc.116` ([SchemaGetter](#schemagetter)). `SchemaAST.Base` is gone; accept `SchemaAST.AST` and narrow with the `is*` guards. Since `rc.116`, `SchemaAST.Context.constructorDefault` holds the constructor-default `Effect` directly rather than a `SchemaAST.Link`; code that builds or reads a `Context` by hand passes or reads that `Effect`.

**Reach for it when** building tooling on top of schemas: custom JSON-Schema dialects, schema-driven UI generation, schema linters, or any code that reasons about a schema's structure rather than just runs it.

## SchemaParser

`effect/SchemaParser` — stable

The AST-walking interpreter that runs a schema against a value. The `decode*`/`encode*`/`is`/`asserts` functions on the `Schema` module are thin re-exports of `SchemaParser`. `SchemaParser.run` walks the AST once and returns `Effect<A, SchemaIssue.Issue>`; every other function is that result re-clothed in a different type.

**Mental model.** One traversal, many output skins. Reaching into `SchemaParser` directly is what custom `declare` codecs do to decode their type parameters.

```ts
import { Effect, Schema, SchemaIssue, SchemaParser } from "effect"

// The HRIS wraps paginated results in an envelope: { data: T }.
interface Page<A> { readonly data: A }
const isPage = (u: unknown): u is Page<unknown> =>
  typeof u === "object" && u !== null && "data" in u

// A custom container codec: use SchemaParser to decode the inner schema.
const Page = <A extends Schema.Top>(item: A) =>
  Schema.declareConstructor<Page<A["Type"]>, Page<A["Encoded"]>>()(
    [item],
    ([itemCodec]) => (u, ast, options) => {
      if (!isPage(u)) return Effect.fail(new SchemaIssue.InvalidType(ast, u, options))
      return Effect.map(
        SchemaParser.decodeUnknownEffect(itemCodec)(u.data, options),
        (data) => ({ data })
      )
    }
  )

const EmployeePage = Page(Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String
}))
```

`Schema.is(schema)` (type predicate) and `Schema.asserts(schema, input)` (TypeScript assertion) both originate here.

```ts
import { Schema } from "effect"

const Rating = Schema.Literals(["exceeds", "meets", "below"])
const isRating = Schema.is(Rating)
isRating("exceeds") // true, and narrows to the rating union

const input: unknown = "meets"
Schema.asserts(Rating, input) // throws if not a rating; otherwise narrows
input.toUpperCase()
```

Since `rc.116`, parsers look up each exact AST in a shared decoder registry. By default that entry is the interpreter; [SchemaJITCompiler](#schemajitcompiler) and [SchemaAOTCompiler](#schemaaotcompiler) can install compiled entries whose optional synchronous `decode`, `is`, and `make` fast paths the parser tries first, falling back to the detailed decoder to build the issue when a fast path rejects the input. The `SchemaParser` API and its results stay the same either way.

**Reach for it when** writing a custom `declare` codec and needing to decode/encode inner schemas, or building a low-level tool that wants the raw `Effect<A, Issue>` traversal. Day to day, call through `Schema`.

## SchemaCompiler

`effect/unstable/schema/SchemaCompiler` — unstable (new in `rc.116`)

The shared registry that maps an exact `SchemaAST.AST` to a `CompiledDecoder`: a required `decodeEffect` (complete decoding with detailed issues) plus optional `is`, `decode`, `make`, and `makeEffect` operations. The JIT and AOT compilers are both clients of this registry; `SchemaCompiler.set(ast, decoder)` is the manual entry point, and `SchemaCompiler.invalid` / `SchemaCompiler.missing` are the sentinels a fast path returns for "rejected, ask the detailed decoder" and "no value produced".

**Mental model.** A cache of parser implementations keyed by AST identity, never of parse results. A fast path only has to be right about valid input; everything else is delegated to `decodeEffect`, which produces the issue.

```ts
import { Effect, Schema, SchemaIssue } from "effect"
import { SchemaCompiler } from "effect/unstable/schema"

const EmployeeId = Schema.String.check(Schema.isPattern(/^E\d{6}$/))

// A hand-written fast path for a hot identifier check. The decoder is trusted to
// implement the AST's semantics exactly; decodeEffect supplies the detailed issue.
SchemaCompiler.set(EmployeeId.ast, {
  decode: (input) => typeof input === "string" && /^E\d{6}$/.test(input) ? input : SchemaCompiler.invalid,
  decodeEffect: (input) =>
    typeof input === "string" && /^E\d{6}$/.test(input)
      ? Effect.succeed(input)
      : Effect.fail(new SchemaIssue.InvalidValue({ message: "expected an employee id" }, input))
})
```

`set` replaces an earlier entry for the same AST, but parser functions that have already resolved an entry keep it. Type-side (`SchemaAST.toType`) and flipped (`SchemaAST.flip`, used for encoding) ASTs are separate keys.

**Reach for it when** you are writing a compiler or an integration that supplies decoders for specific ASTs. Application code normally goes through `SchemaJITCompiler` or `SchemaAOTCompiler` instead; a hand-written entry that disagrees with its schema silently changes what decodes.

## SchemaJITCompiler

`effect/unstable/schema/SchemaJITCompiler` — unstable (new in `rc.116`)

Generates decoder source for a schema at runtime and installs it through `new Function`. Two entry points: the side-effect import `effect/unstable/schema/SchemaJITCompiler/enable` compiles every schema lazily on first use, and `SchemaJITCompiler.enable(schema.ast)` compiles one schema and its parsing dependencies.

**Mental model.** A drop-in accelerator for the same parser. Operations compile lazily on first use; checks, transformations, and defaults are never executed at installation. Validators, structs, and homogeneous arrays get generated code; most transformations and all middleware still run through the interpreter, with compiled children.

```ts
import { Schema } from "effect"
import { SchemaJITCompiler } from "effect/unstable/schema"

const PayrollLine = Schema.Struct({
  employeeId: Schema.NonEmptyString,
  grossCents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  costCenters: Schema.Array(Schema.String)
})

// Selective: enable before the first decode of this schema anywhere in the process.
SchemaJITCompiler.enable(PayrollLine.ast)

const decodeLine = Schema.decodeUnknownSync(PayrollLine) // same API, same issues on failure

// Global alternative, as the entrypoint's first import:
// import "effect/unstable/schema/SchemaJITCompiler/enable"
```

Probed on `rc.116`, a four-field struct decoded about three times faster with JIT enabled and produced identical results and error messages. Where dynamic function construction is blocked (a Content Security Policy without `'unsafe-eval'`, some edge runtimes), compilation fails silently and parsing stays interpreted: nothing breaks, nothing gets faster. Enable **before first use**: a parser function that has already run keeps its interpreted entry, while one created but not yet called picks up the compiled entry.

**Reach for it when** profiling shows schema decoding on a hot path (high-volume ingestion, large payload arrays) in a runtime that allows `new Function`. Leave it off otherwise; results do not change, only speed.

## SchemaAOTCompiler

`effect/unstable/schema/SchemaAOTCompiler` — unstable (new in `rc.116`)

The build-time twin of the JIT compiler. `SchemaAOTCompiler.compile(targets)` returns the source of a static JavaScript module whose `install(asts)` export registers the generated decoders, so no code is constructed at runtime. The companion entrypoint `effect/unstable/schema/SchemaAOTCompiler/Build` exposes `build(options)`, which loads your schema modules, compiles their **direct** `Schema` exports, and writes a module that installs itself when imported. It needs `FileSystem` and `Path` and fails with `BuildError` or `PlatformError`.

**Mental model.** JIT output frozen into a file. Operations are opt-in per build (`"decode"` by default; add `"encode"`, `"is"`, `"make"`); anything not generated falls back to the interpreter.

```ts
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { build } from "effect/unstable/schema/SchemaAOTCompiler/Build"

// A build script: compile the schemas exported by the payroll module.
declare const loadPayrollSchemas: () => Promise<unknown> // () => import("./payroll/schemas.ts")

const writeAotModule = build({
  modules: { "./payroll/schemas.ts": loadPayrollSchemas },
  baseUrl: new URL("../src/", import.meta.url),
  outFile: "src/generated/schemas.aot.js",
  operations: ["decode", "encode"]
}).pipe(
  Effect.tap(({ schemas }) => Effect.log(`compiled ${schemas} schemas`)),
  Effect.provide(NodeServices.layer)
)

// Application entrypoint, before any schema is used:
// import "./generated/schemas.aot.js"
```

Probed on `rc.116`: the generated module installed and decoded correctly with `globalThis.Function` blocked, at a speed comparable to JIT. Regenerate the file whenever a schema definition or the Effect version changes; installation trusts that the ASTs match what was compiled. Bundler configurations that mark modules side-effect free must keep the generated import.

**Reach for it when** you want compiled decoders where `new Function` is unavailable (strict CSP, locked-down runtimes) or you want no code generation at startup. It trades a build step and a regenerate-on-change rule for that.

## SchemaGetter

`effect/SchemaGetter` — stable

A `Getter<T, E, R>` is one direction of a conversion: takes an optional encoded value and returns an optional decoded value, possibly failing with an issue or requiring services. Getters are the atoms of the v4 transformation model.

**Mental model.** A validating, possibly-effectful `map` for one leg of a codec. Built-in getters: `transform` (pure map), `transformEffect` (map that can reject or use services; `transformOrFail` before `rc.113`), `forbiddenEncoding` (the encode leg of a decode-only conversion), `transformOptional` (operate on the `Option` of presence — key to optional-field migrations), `checkEffect` (async validation), `passthrough`/`required`/`omit`, and ready-made conversions `String()`, `Number()`, `trim()`, `parseJson()`, `encodeBase64()`. When a getter must see a missing value *and* run an Effect, use `transformOptionalEffect((option, parseOptions) => Effect<Option>)`.

**Getters are data, operated on by functions (`rc.116`).** A `Getter` is a tagged union (`Passthrough`, `Transform`, `TransformOptional`, `TransformEffect`, `TransformOptionalEffect`) whose values expose only `pipe`. Chain and run them with the dual functions `SchemaGetter.map`, `SchemaGetter.compose`, and `SchemaGetter.run`; the former `getter.map`, `getter.compose`, and `getter.run` members, the public `new SchemaGetter.Getter(...)` constructor, and `SchemaGetter.onSome` / `onNone` are gone (use `transformEffect` for present values and `transformOptionalEffect` when the missing case matters).

```ts
import { Effect, Option, SchemaGetter } from "effect"

// Parse a pasted salary, then clamp negatives to zero: two steps, one getter.
const salaryCents = SchemaGetter.transform((text: string) => Number(text.replaceAll(",", ""))).pipe(
  SchemaGetter.compose(SchemaGetter.transform((cents: number) => Math.max(0, cents))),
  SchemaGetter.map(Math.round)
)

// Run a getter outside a schema (tests, tooling). The result is always an Effect of an Option.
const decoded = SchemaGetter.run(salaryCents, Option.some("12,500"), {})
const value = Effect.runSync(decoded) // Option.some(12500)
```

```ts
import { Option, Schema, SchemaGetter } from "effect"

// transformOptional is how v4 expresses optionalToRequired/requiredToOptional.
// Here: a missing managerId decodes to null (a top-level exec), and null encodes
// back to "missing".
const orgEntry = Schema.Struct({
  managerId: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))).pipe(
    Schema.decodeTo(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))), {
      decode: SchemaGetter.transformOptional(Option.orElseSome(() => null)),
      encode: SchemaGetter.transformOptional(Option.filter((value) => value !== null))
    })
  )
})

// Ready-made getters keep transformations terse. Normalize a pasted employee name.
const TrimmedName = Schema.String.pipe(
  Schema.decode({
    decode: SchemaGetter.trim(),
    encode: SchemaGetter.passthrough()
  })
)
```

**Effectful filters.** Ordinary checks are synchronous and service-free. For "is this code still free?" validation, use a same-type transformation whose decode leg is `SchemaGetter.checkEffect(f)`. The contract: `f(value, options)` returns an Effect that **succeeds** with `undefined` / `true` to pass, or with a message string or filter issue to fail — its error channel is `never`, and services it uses are tracked in the schema's `DecodingServices`. Being effectful, it needs an Effect runner.

```ts
import { Effect, Schema, SchemaGetter } from "effect"

declare const isCodeTaken: (code: string) => Effect.Effect<boolean>

const FreeCostCenterCode = Schema.NonEmptyString.pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((code: string) =>
      Effect.map(isCodeTaken(code), (taken) => (taken ? "cost-center code is already used" : undefined))
    ),
    encode: SchemaGetter.passthrough()
  })
)
```

**Reach for it when** defining a transformation and needing the decode or encode leg — especially for optional-field gymnastics (`transformOptional`), async checks (`checkEffect`), or built-in string/binary/JSON conversions.

## SchemaTransformation

`effect/SchemaTransformation` — stable

A `Transformation<T, E>` bundles both directions of a conversion — decode (E → T) and encode (T → E) — into one reusable value. Passed as the second argument to `decodeTo` when a clean two-way mapping exists.

**Mental model.** A named codec-fragment. Prebuilts: `transform`/`transformEffect` constructors plus `trim`, `toLowerCase`, `capitalize`, `numberFromString`, `dateFromString`, `optionFromNullOr`, `fromJsonString`, `uint8ArrayFromBase64String`. These are how `Schema.Trim`, `Schema.DateFromString`, etc. are defined internally. At the public schema level use `Schema.fromJsonString(inner, { reviver?, replacer?, space? })`; the old `Schema.UnknownFromJsonString` constant is internal.

```ts
import { Schema, SchemaTransformation } from "effect"

// Build your own two-way transformation in one shot. The HRIS stores an
// employee's eligible departments as a comma-separated string.
const csv = (separator: string) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform({
        decode: (s) => s.split(separator) as ReadonlyArray<string>,
        encode: (as) => as.join(separator)
      })
    )
  )

const DepartmentIds = csv(",")
Schema.decodeUnknownSync(DepartmentIds)("eng,design,ops") // ["eng", "design", "ops"]
Schema.encodeUnknownSync(DepartmentIds)(["eng", "ops"])   // "eng,ops"

// Or compose a prebuilt one (this is roughly how Schema.Capitalize is built).
const TitleCased = Schema.String.pipe(
  Schema.decodeTo(Schema.String.check(Schema.isCapitalized()), SchemaTransformation.capitalize())
)
```

**Ready-made codecs, so you do not rebuild them:** text — `Schema.Trim`, `StringFromBase64`, `StringFromBase64Url`, `StringFromHex`, `StringFromUriComponent`; numbers — `FiniteFromString`, `NumberFromString`, `BigIntFromString`, `BigDecimalFromString`; bytes — `Uint8ArrayFromBase64`, `Uint8ArrayFromHex`; time and web — `DateFromString`, `DateFromMillis`, `DateTimeUtcFromString`, `DateTimeUtcFromMillis`, `URLFromString`. Case codecs are assembled the way `TitleCased` is above: a checked target (`Schema.isLowercased()`, ...) plus `SchemaTransformation.toLowerCase()`, `toUpperCase()`, `capitalize()`, or `uncapitalize()`; `snakeToCamel()` serves key and identifier conversion.

**Composing and wrapping (`rc.116` names).** Chain two transformations with the dual `SchemaTransformation.composeTransformation(first, second)` or `first.pipe(SchemaTransformation.composeTransformation(second))`: decoding runs `first` then `second`, encoding runs them in reverse. The `first.compose(second)` method is gone. Pair two existing getters with `SchemaTransformation.makeTransformation({ decode, encode })` (formerly `SchemaTransformation.make`). `Transformation` and `Middleware` values are `Pipeable`.

```ts
import { Schema, SchemaTransformation } from "effect"

// Normalize a pasted work email: trim, then lowercase, as one reusable two-way step.
const normalizeEmail = SchemaTransformation.trim().pipe(
  SchemaTransformation.composeTransformation(SchemaTransformation.toLowerCase())
)

const WorkEmail = Schema.String.pipe(Schema.decode(normalizeEmail))
const email = Schema.decodeUnknownSync(WorkEmail)("  Ada.Lovelace@Example.COM ") // "ada.lovelace@example.com"
```

**Reach for it when** a transformation has a clean, symmetric decode/encode pair and you want it as a single reusable value, or when a library prebuilt covers the case.

## SchemaRepresentation

`effect/SchemaRepresentation` — stable

A compiler and persistence pipeline for schema structure. A live `Document` holds a representation root plus shared references; unlike persisted JSON, it may still contain runtime compiler callbacks and non-JSON annotation values. `toJson` is the explicit storage/transport boundary.

**Mental model.** Lower a schema with `Schema.toRepresentation(schema)` (or its AST with `SchemaRepresentation.toRepresentation(ast)`), then choose a branch: persist with `toJson`; compile to JSON Schema with `toJsonSchemaDocument`; or wrap with `toMultiDocument` and generate TypeScript via `toCodeDocument`. Multiple roots use `toRepresentations`, sharing one reference environment.

```ts
import { Schema, SchemaRepresentation } from "effect"

const CompBand = Schema.Struct({ level: Schema.Int, salaryMid: Schema.Int })

// The live representation is the compiler input.
const document = Schema.toRepresentation(CompBand)

// Persistence is explicit. Non-JSON annotations are omitted.
const persisted = SchemaRepresentation.toJson(document)
const restoredDocument = SchemaRepresentation.fromJson(persisted)

// Generate TypeScript source — e.g. typed comp models for a partner team.
const multi = SchemaRepresentation.toMultiDocument(document)
const codeDoc = SchemaRepresentation.toCodeDocument(multi)
const firstCode = codeDoc.codes[0]
if (firstCode) {
  console.log(firstCode.runtime) // the Schema.Struct({ ... }) expression as a string
  console.log(firstCode.Type)    // the corresponding TypeScript type as a string
}
```

`fromRepresentation(document, { revivers })` reconstructs a runtime schema; no declaration/check revivers are installed implicitly. The multi-root twin is `fromRepresentations`. Persisted documents using the legacy representation format are not wire-compatible; regenerate them or perform an explicit migration before loading them with the current pipeline. That includes documents written before `rc.113` that contain a `oneOf` union: the union mode moved from a top-level field to `{ options: { mode: "oneOf" } }` (and `SchemaAST.Union.mode` to `SchemaAST.Union.options?.mode`); the public `Schema.Union(members, { mode })` call is unchanged. Importing external JSON Schema patterns also requires an explicit trust choice: the default is to reject them, `{ patterns: "apply" }` evaluates patterns from a trusted document, and `{ patterns: "ignore" }` knowingly weakens validation.

**Reach for it when** you need code generation, JSON Schema compilation/import, or a deliberately persisted schema representation with shared references.

## SchemaIssue

`effect/SchemaIssue` — stable

The structured error tree produced when parsing fails. Leaf nodes: `InvalidType`, `InvalidValue`, `MissingKey`, `UnexpectedKey`, `Forbidden`, `OneOf`. Composite nodes: `Composite`, `Filter`, `Pointer`, `Encoding`, `AnyOf`. `SchemaError` (thrown/failed by runners) carries this tree in its `.issue` field.

**Mental model.** Parsing produces a tree of failures mirroring the data's shape. An issue does not format itself through `String(issue)`; formatting is explicit. `SchemaIssue.makeFormatterDefault()` returns a readable string, while `makeFormatterStandardSchemaV1()` returns `{ issues: [{ path, message }, ...] }`. Rejected inputs are omitted by default and are only attached when parsing with `{ reportInput: true }`; use `SchemaIssue.hasInput` before reading one.

```ts
import { Effect, Result, Schema, SchemaIssue } from "effect"

// A raw HRIS record we expect to decode into an Employee.
const Employee = Schema.Struct({
  name: Schema.String,
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))
})

const program = Schema.decodeUnknownEffect(Employee)({}, { reportInput: true, errors: "all" }).pipe(
  Effect.catchTag("SchemaError", (error) => {
    // error.issue is the structured tree; format it to { path, message }[].
    const issues = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues
    console.error(issues)
    // [ { path: ["name"],  message: "Missing key" },
    //   { path: ["level"], message: "Missing key" } ]
    return Effect.void
  })
)

// Human-readable formatting is explicit; String(issue) is not the formatter.
const result = Schema.decodeUnknownResult(Employee)({ name: 1, level: "senior" })
if (Result.isFailure(result)) {
  console.log(SchemaIssue.makeFormatterDefault()(result.failure.issue))
}
```

**Customize wording with formatter hooks.** `makeFormatterStandardSchemaV1` accepts a `leafHook` (terminal issues: `MissingKey`, `InvalidType`, `UnexpectedKey`, ...) and a `checkHook` (failed filters; return `undefined` to keep the `Expected ...` fallback). A hook handles the tags it cares about and delegates the rest to `SchemaIssue.defaultLeafHook` / `SchemaIssue.defaultCheckHook`, which honor `message` annotations first. This keeps wording — or translation keys — a presentation concern at the boundary instead of scattering strings through schemas, and `Schema.toStandardSchemaV1` accepts the same two hooks. The schema-side alternative is in [Custom error messages](#17-custom-error-messages).

```ts
import { Result, Schema, SchemaIssue } from "effect"

const RaiseRequest = Schema.Struct({ employeeId: Schema.String, percent: Schema.Finite })

const toFieldErrors = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === "MissingKey" ? "errors.required" : SchemaIssue.defaultLeafHook(issue)
})

const result = Schema.decodeUnknownResult(RaiseRequest)({}, { errors: "all" })
if (Result.isFailure(result)) {
  console.log(toFieldErrors(result.failure.issue).issues)
  // [ { path: ["employeeId"], message: "errors.required" },
  //   { path: ["percent"],    message: "errors.required" } ]
}
```

Official guide: [Error Formatters](https://effect.website/docs/v4/schema/error-formatters).

**Reach for it when** you need to act on a validation failure: render field-level errors, build custom messages for rejected rows, localize messages, or pattern-match issue tags to react differently to distinct failure kinds.

## Schema.SchemaError

`effect/Schema` — stable

The public error wrapper used by the high-level `Schema.decode*` and `Schema.encode*` adapters. `Schema.SchemaError` is tagged `"SchemaError"` and carries the raw `SchemaIssue.Issue` in `.issue`; its `.message` applies the default formatter. `Schema.isSchemaError` safely recognizes it, including across duplicated package copies. In RC 108 it lives in the `Schema` namespace; there is no standalone `effect/SchemaError` module.

```ts
import { Result, Schema, SchemaIssue, SchemaParser } from "effect"

const Employee = Schema.Struct({ id: Schema.String, level: Schema.Int })

// High-level Schema adapters wrap the issue.
const decoded = Schema.decodeUnknownResult(Employee)({ id: 1 })
if (Result.isFailure(decoded) && Schema.isSchemaError(decoded.failure)) {
  console.log(decoded.failure.message)
  console.log(SchemaIssue.makeFormatterDefault()(decoded.failure.issue))
}

// Low-level SchemaParser adapters expose SchemaIssue.Issue directly.
const raw = SchemaParser.decodeUnknownResult(Employee)({ id: 1 })
if (Result.isFailure(raw)) {
  console.log(raw.failure._tag)
}
```

`Schema.makeEffect` is another deliberate low-level exception: it fails with a raw `SchemaIssue.Issue`, not the wrapper. High-level sync/Promise runners throw or reject `SchemaError`; parser sync/Promise adapters throw a plain `Error` whose `cause` is the raw issue.

> **Existing classes:** Use `Schema.instanceOf(Constructor)` when the boundary already contains instances. It checks identity only (and needs a public constructor; fall back to `Schema.declare` with an `instanceof` guard otherwise) — to validate the instance's fields too, add a `Schema.makeFilter` that runs a struct decoder such as `Schema.decodeUnknownResult(Fields)` over the instance and returns the failure's `.issue`. For a struct-on-the-wire codec, explicitly combine the struct, `Schema.decodeTo`, and a `SchemaTransformation.transform` that constructs and projects the class; or define the model with `Schema.Class` when you own it.

**Reach for it when** you need to detect, transport, or explicitly format high-level schema failures. Reach for raw `SchemaIssue.Issue` via `SchemaParser` when implementing codecs or issue-tree tooling.

## JsonSchema

`effect/JsonSchema` — stable

Derive a JSON Schema document from any `Schema` and normalize/convert between JSON Schema dialects (Draft-07, Draft 2020-12, OpenAPI 3.0/3.1). `Schema.toJsonSchemaDocument` produces the document; this module handles dialect plumbing (`$ref` resolution, OpenAPI component keys, cross-dialect conversion). Annotations (`description`, `title`, custom keys via `includeAnnotationKey`) flow into output.

```ts
import { Schema } from "effect"

// The request body for "set a salary band" on the compensation API.
const CompBand = Schema.Struct({
  level: Schema.Int.annotate({ description: "Job level, e.g. 5 for IC5" }),
  salaryMid: Schema.Int
})

const doc = Schema.toJsonSchemaDocument(CompBand)
console.log(JSON.stringify(doc.schema, null, 2))
// {
//   "type": "object",
//   "properties": {
//     "level": {
//       "type": "integer",
//       "description": "Job level, e.g. 5 for IC5"
//     },
//     "salaryMid": { "type": "integer" }
//   },
//   "required": ["level", "salaryMid"],
//   "additionalProperties": true
// }

// Publish a closed contract instead: unknown properties are rejected by validators.
const closed = Schema.toJsonSchemaDocument(CompBand, { onExcessProperty: "error" })
// closed.schema.additionalProperties === false
```

Two generation defaults changed in `rc.113` for documents you generate yourself with `Schema.toJsonSchemaDocument`. (OpenAPI documents derived by `HttpApi` are a separate path: probed on `rc.116`, `OpenApi.fromApi` still emits **closed** objects, `"additionalProperties": false` — see [HTTP API](../interfaces/http-api).)

- **Objects are open by default.** Generation now mirrors Effect decoding, which ignores excess properties unless told otherwise, so a `Struct` emits `"additionalProperties": true`. The old `{ additionalProperties }` generation option is gone: use `{ onExcessProperty: "ignore" }` (the default) or `{ onExcessProperty: "error" }` for a closed object, and model a schema-valued "rest" with `Schema.Record` or `Schema.StructWithRest` rather than an option. If a consumer relied on the previous closed default — a strict validator, a generated client, a structured-output provider — opt back in explicitly.
- **Check constraints and annotations are compacted** into the node when no keyword collides (`"type": "integer", "description": …`) instead of being wrapped in `allOf`. `allOf` still appears when merging would overwrite a keyword. Snapshot tests of generated documents need refreshing.

On the import side (`SchemaRepresentation.fromJsonSchemaDocument`), unsupported references, validation keywords, and object-valued `const`/`enum` are now **rejected with a path-qualified explanation** instead of being silently weakened.

**What the document describes.** Four rules explain most surprising output:

- **It describes the `Encoded` side.** Generation goes through the canonical JSON codec, so a `FiniteFromString` field is `{ "type": "string" }` and a `Schema.Option(...)` is a union of tagged objects — never the in-memory `Type`. For the same reason `.annotate(...)` on a transformation documents the decoded side, which JSON Schema never sees; use `Schema.annotateEncoded({ description })` to reach the document. A `Schema.fromJsonString(inner)` field becomes `{ "type": "string", "contentMediaType": "application/json" }`.
- **`identifier` creates `$ref` definitions.** The result is `{ dialect, schema, definitions }`. A schema carrying an `identifier` annotation (a class identifier counts) is hoisted into `definitions` and referenced as `{ "$ref": "#/$defs/<identifier>" }`. A recursive schema is always emitted through a definition; without an identifier the generator invents the name, so give it one. This is what controls reusable component names in OpenAPI documents and structured-output schemas.
- **Checks become keywords only when they know how.** Built-in checks map to `minLength`, `pattern`, numeric bounds, `uniqueItems`, and so on. A custom `Schema.makeFilter` contributes nothing unless it carries a `toJsonSchema` annotation ([section 5](#5-refinements-check-and-refine)); `{ generateDescriptions: true }` turns each check's `expected` text into a `description`.
- **`optionalKey` and `optional` differ on the wire.** `optionalKey` only removes the property from `required`; `optional` also widens the property to allow `null`, because JSON cannot carry `undefined`.

```ts
import { JsonSchema, Schema } from "effect"

interface OrgNode {
  readonly name: string
  readonly reports: ReadonlyArray<OrgNode>
}

const OrgNode: Schema.Codec<OrgNode> = Schema.Struct({
  name: Schema.String,
  reports: Schema.Array(Schema.suspend((): Schema.Codec<OrgNode> => OrgNode))
}).annotate({ identifier: "OrgNode" }) // a stable $defs name for the cycle

const orgDoc = Schema.toJsonSchemaDocument(OrgNode)
// orgDoc.schema      -> { "$ref": "#/$defs/OrgNode" }
// orgDoc.definitions -> { OrgNode: { "type": "object", ... "items": { "$ref": "#/$defs/OrgNode" } } }

// Generation always targets Draft 2020-12; other dialects are pure conversions.
const draft07 = JsonSchema.toDocumentDraft07(orgDoc) // also toDocumentDraft04, toMultiDocumentOpenApi3_1
```

**Which model owns which artifact.** A value schema knows a shape. It does not know methods, paths, parameter locations, status codes, per-endpoint errors, security, or media types; those facts live on the assembled `HttpApi`. So **derive JSON Schema from `Schema` for value contracts, and derive the OpenAPI document from the API** with [`OpenApi.fromApi`](../interfaces/http-api#openapi). Point a generator at the wrong model and its output silently lacks everything that only the other model records.

Official guide: [Schema to JSON Schema](https://effect.website/docs/v4/schema/json-schema) (it documents an `additionalProperties` generation option and closed-by-default output; `rc.116` uses `onExcessProperty` and is open by default).

**Reach for it when** you need a machine-readable *value* contract for external consumers: JSON Schema config validation, cross-language codegen of a payload, or structured-output LLM prompting. For an HTTP API description, generate OpenAPI from `HttpApi` instead.

## StandardSchema

`effect/StandardSchema` — stable (new in `rc.112`)

The **type definitions** of the [Standard Schema](https://standardschema.dev) V1 specification — `StandardSchemaV1`, `StandardTypedV1`, and the experimental `StandardJSONSchemaV1` — vendored verbatim so `effect` no longer depends on `@standard-schema/spec`. The module is types only; the conversion lives on `Schema`.

`Schema.toStandardSchemaV1(schema, { leafHook?, checkHook?, parseOptions? })` returns a value that is *both* the original schema and a Standard Schema, so libraries that accept Standard Schema (form libraries, routers, tRPC-style tooling) can validate with an Effect schema. Validation runs the schema's decoder: the result is `{ value }` or `{ issues }`, where each issue carries a `path` and a message produced by the hooks. It is synchronous unless the schema needs an asynchronous step, in which case `validate` returns a `Promise` — consumers must handle both.

```ts
import { Schema } from "effect"
import type { StandardSchema } from "effect"

const RaiseRequest = Schema.Struct({
  employeeId: Schema.NonEmptyString,
  raisePercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.15 }))
})

// One value: still an Effect Schema, and also a Standard Schema V1.
const standard = Schema.toStandardSchemaV1(RaiseRequest)

// A library-facing signature can name the vendored type directly.
const validateWith = <I, O>(schema: StandardSchema.StandardSchemaV1<I, O>, input: unknown) =>
  schema["~standard"].validate(input)

const result = validateWith(standard, { employeeId: "", raisePercent: 0.4 })
if (!(result instanceof Promise) && result.issues) {
  result.issues.map((issue) => issue.path) // [["employeeId"], ["raisePercent"]]
}
```

Only decoding is exposed — Standard Schema has no encode direction — and a schema that requires decoding services cannot be converted. `Schema.toStandardJSONSchemaV1` targets a still-experimental extension of the spec; treat it as unstable.

Integration facts: the vendor string is `"effect"`; the adapter collects **all** issues by default (pass `{ parseOptions: { errors: "first" } }` to change that); `leafHook` / `checkHook` are the same hooks [`SchemaIssue`](#schemaissue) formatters take; and a **defect** raised while decoding is not thrown but reported as one issue without a `path`, whose message is the rendered cause — stack trace included — so never show a path-less issue to an end user verbatim.

Official guide: [Schema to Standard Schema](https://effect.website/docs/v4/schema/standard-schema).

**Reach for it when** a third-party library asks for a Standard Schema and you want your Effect schema to remain the single source of truth.

## JsonPatch

`effect/JsonPatch` — stable

Compute and apply deterministic diffs over JSON values. A `JsonPatch` is an ordered list of `add`/`remove`/`replace` operations addressed by JSON Pointer paths (deterministic subset of RFC 6902). `get(oldValue, newValue)` produces the patch; `apply(patch, value)` replays it without mutating the input.

```ts
import { JsonPatch } from "effect"

// A merit-cycle review: the plan before and after a manager's edits.
const before = { recommendations: [{ employeeId: 1, newSalary: 185000 }], approved: false }
const after  = {
  recommendations: [{ employeeId: 1, newSalary: 192400 }, { employeeId: 2, newSalary: 150000 }],
  approved: true
}

const patch = JsonPatch.get(before, after)
// [ { op: "replace", path: "/approved",                    value: true },
//   { op: "replace", path: "/recommendations/0/newSalary", value: 192400 },
//   { op: "add",     path: "/recommendations/1",           value: { employeeId: 2, newSalary: 150000 } } ]

JsonPatch.apply(patch, before) // deep-equals `after`
```

> **Tip:** For schema-typed values, `Schema.toDifferJsonPatch(schema)` gives you a `Differ` that diffs decoded values straight into a `JsonPatch` — handy for optimistic edits and audit logs where you want diffs of domain types, not raw JSON.

**Reach for it when** syncing state across a wire and wanting minimal diffs, or when needing an auditable record of exactly how structured data changed.

## JsonPointer

`effect/JsonPointer` — stable

The RFC 6901 conversions underlying `JsonPatch` paths and JSON Schema `$ref`s. `escapeToken` encodes `~`→`~0` and `/`→`~1`; `unescapeToken` reverses it. `formatUriFragment(path)` and `parseUriFragment(fragment)` convert a whole token path to and from the `#/...` URI-fragment form, adding percent-encoding; parsing returns `undefined` for a malformed fragment.

```ts
import { JsonPointer } from "effect"

// A comp-band key like "eng/backend" needs escaping to live in a pointer path.
JsonPointer.escapeToken("eng/backend~ic5")   // "eng~1backend~0ic5"
JsonPointer.unescapeToken("eng~1backend~0ic5") // "eng/backend~ic5"

// Whole-pointer URI fragments, as used by "$ref" (added in rc.113).
JsonPointer.formatUriFragment(["$defs", "eng/backend"]) // "#/$defs/eng~1backend"
JsonPointer.parseUriFragment("#/$defs/eng~1backend")    // ["$defs", "eng/backend"]
JsonPointer.parseUriFragment("#/%")                     // undefined: not a valid fragment
```

**Reach for it when** building or parsing JSON Pointer paths by hand, particularly for keys containing slashes or tildes.

## Model

`effect/unstable/schema/Model` — unstable

Define a domain model once and derive operation-specific variants: `select`, `insert`, `update` (database-facing) and `json`, `jsonCreate`, `jsonUpdate` (API-facing). Field declaration helpers encode per-variant behavior: `Model.GeneratedByDb` (omit on insert, present on select), `Model.DateTimeInsertFromDate` (set on insert), `Model.DateTimeUpdateFromDate` (set on update), `Model.Sensitive` (hidden from JSON), `Model.FieldOption` (nullable column ↔ `Option`).

```ts
import { Schema } from "effect"
import { Model } from "effect/unstable/schema"

export const EmployeeId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("EmployeeId"))

export class Employee extends Model.Class<Employee>("Employee")({
  id: Model.GeneratedByDb(EmployeeId),       // omitted on insert, present on select
  name: Schema.String,
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  baseSalary: Model.Sensitive(Schema.BigDecimal), // hidden from the JSON API
  createdAt: Model.DateTimeInsertFromDate,   // set when inserting
  updatedAt: Model.DateTimeUpdateFromDate    // set when updating
}) {}

Employee         // select schema (the default variant)
Employee.insert  // insert schema — no `id`, `createdAt` required, no `updatedAt`
Employee.update  // update schema
Employee.json    // outward JSON API shape — no baseSalary
Employee.jsonCreate
Employee.jsonUpdate

// Any variant can be promoted to a real class with derived getters.
class EmployeeJson extends Schema.Class<EmployeeJson>("EmployeeJson")(Employee.json) {
  get displayName() { return `${this.name} (L${this.level})` }
}
```

**Reach for it when** persisted shape, write shape, and public API shape diverge — almost any real domain entity. Natural companion to the SQL modules: `Employee.insert` is exactly the schema an insert query wants.

## VariantSchema

`effect/unstable/schema/VariantSchema` — unstable

The general "one definition, many variants" mechanism that `Model` is built on. `VariantSchema.make({ variants, defaultVariant })` produces a toolkit — `Struct`, `Class`, `Union`, `Field`, `FieldOnly`, `FieldExcept`, `fieldEvolve`, `extract` — specialized to your variant names. `Model` is `VariantSchema.make({ variants: ["select","insert","update","json","jsonCreate","jsonUpdate"], defaultVariant: "select" })`.

**Mental model.** Fix a set of views over the same data, then declare each field's behavior per view: shared by all variants (plain schema), restricted to some (`FieldOnly(["read"])`), excluded from some (`FieldExcept(["public"])`), or given a different schema per variant (`Field({ read: ..., write: ... })`). The toolkit derives a real `Schema` for every variant.

```ts
import { Schema } from "effect"
import { VariantSchema } from "effect/unstable/schema"

// Define your own variant axis — what an employee sees vs. what an HRBP sees.
const { Class, Field, FieldExcept } = VariantSchema.make({
  variants: ["employee", "hrbp"],
  defaultVariant: "employee"
})

class CompProfile extends Class<CompProfile>("CompProfile")({
  employeeId: Schema.Int.check(Schema.isGreaterThan(0)),
  baseSalary: Schema.BigDecimal,
  // present everywhere, but only HRBPs see the performance rating:
  rating: FieldExcept(["employee"])(Schema.String),
  // different schema per variant (e.g. employees see a masked band label):
  bandLabel: Field({ employee: Schema.String, hrbp: Schema.String })
}) {}

CompProfile      // the "employee" variant (default)
CompProfile.hrbp // the "hrbp" variant, including rating
```

**Reach for it when** you need `Model`'s "derive many shapes from one" power with a different set of variants than the built-in DB/JSON ones.

## Testing schemas with TestSchema

`effect/testing/TestSchema` — stable

Assertion helpers for testing schemas. `new TestSchema.Asserts(schema)` groups checks: decoding succeeds/fails as expected, encoding round-trips, `make` behaves, and the derived arbitrary generates valid values. `Decoding` and `Encoding` are also exported standalone.

**Mental model.** A schema has three behaviors — decode, encode, construct — plus a derived generator. `arbitrary().verifyGeneration()` property-tests that everything the schema's native `Arbitrary` produces actually satisfies `Schema.is`, catching impossible constraints and broken transformations.

```ts
import { Schema } from "effect"
import { TestSchema } from "effect/testing"

// An equity grant whose vesting math we want to trust for any generated value.
const EquityGrant = Schema.Struct({
  shares: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
  vestingMonths: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 48 }))
})

const asserts = new TestSchema.Asserts(EquityGrant)

// Decoding: succeed (optionally asserting the transformed output) and fail-with-message.
await asserts.decoding().succeed({ shares: 4000, vestingMonths: 48 })

// Transformations: assert the decoded value differs from the input.
await new TestSchema.Asserts(Schema.FiniteFromString).decoding().succeed("4000", 4000)
await new TestSchema.Asserts(Schema.FiniteFromString).encoding().succeed(4000, "4000")

// Sample the derived arbitrary and assert that generated grants satisfy the schema.
// This is a useful property-based check, not a mathematical proof.
asserts.arbitrary().verifyGeneration()
```

**A requirement is done when both its accepted and its rejected case have a test.** Pair every schema rule with the test that proves it:

| Schema requirement | Proof |
| --- | --- |
| Required field | the same input without the key fails |
| Finite set of literals or tags | an unknown literal fails |
| Optional key | omitted input decodes, *and* a bad present value fails |
| Check (range, pattern, cross-field) | an invalid value fails; valid values pass through unchanged |
| Decoding default | omitted decodes to the default; an explicit falsy value is kept; an explicit invalid value fails |
| Transformation | decode output and encode output are each asserted, not only the round trip |
| Unknown ingress | the failure is a `SchemaError` in the error channel, not a defect |

**The minimum set per boundary is four cases**: one valid wire object (decoded, then encoded back), one missing required field, one bad value, and one excess property under the policy that boundary chose ([section 14](#14-parse-options-are-boundary-policy)).

Two limits of derived generators shape the rest: `Arbitrary.schema` produces valid decoded `Type` values, so it can test invariants and round trips but **never rejection, key omission, or malformed wire input** — keep a handful of named *encoded* fixtures for those (and one regression fixture per representation bug). And it knows only the schema: a cross-field business rule must be a schema `check` (constructive where possible) or a residual `Arbitrary.filter`, which spends the discard budget. The round-trip law worth asserting is described in the [Schema deep dive](../deep-dives/schema-from-external-input-to-domain-and-back#test-the-contract-in-both-directions).

Official guide: [Schema to Arbitrary](https://effect.website/docs/v4/schema/arbitrary).

**Reach for it when** writing tests for schemas — especially custom transformations and refinements. `verifyGeneration(options?)` runs a native `Arbitrary.checkEffect` property (20 runs by default) that generated values satisfy `Schema.is`; `verifyLosslessTransformation(options?)` checks decode∘encode round trips. Both take `Arbitrary.CheckOptions` (`{ seed, runs, maxDiscards, maxShrinks, replay }`) directly, bound unsuccessful generation, and report the shrunk input and replay token on failure. `decoding().fail(input, message)` pins down error messages.
