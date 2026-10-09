# Schema

Effect v4 rebuilt Schema around a single `Codec` abstraction: a two-way, validating, possibly-effectful bridge between two TypeScript types. `Type` is the decoded, in-memory value; `Encoded` is the wire/storage shape. `decode` goes Encoded → Type (with validation); `encode` goes Type → Encoded. `Schema.String` is the degenerate case (both sides `string`); `Schema.FiniteFromString` (`Encoded = string`, `Type = number`) is the usual numeric boundary. Satellite modules — `SchemaParser`, `SchemaIssue`, `SchemaGetter`, `SchemaTransformation`, `SchemaRepresentation` — are the implementation; `Schema` is the interface.

**This page covers the everyday codec work** (sections 1–9 below). [Schema in Depth](schema-in-depth) continues with annotations, serialization, recursion, parse options, optional fields, and effectful schemas; [Schema Tooling & Internals](schema-tooling) covers the AST, compilers, issues, JSON Schema, and `TestSchema`.

> **Official companion:** Effect's release-matched [comprehensive Schema guide](https://github.com/Effect-TS/effect/blob/effect%404.0.2/packages/effect/SCHEMA.md) goes substantially deeper into codecs, constraints, transformations, serialization, generated tooling, integrations, and migration.
>
> **Official guides:** [Introduction to Effect Schema](https://effect.website/docs/v4/schema/introduction) (its parse-option and `transformOrFail` spellings are stale — see the sections below); section-specific guides are linked where they apply. These track Effect's `main` branch rather than this page's tagged 4.0.2 source, so where they differ, this page and the tagged source win.

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

- **Effect runner** when typed composition, services, or interruption matter. It is the only runner for an [effectful schema](schema-in-depth#9-effectful-schemas-and-services): the `Sync`, `Option`, `Result`, `Exit`, and `Promise` runners accept only schemas whose `DecodingServices` / `EncodingServices` are `never` (a compile error otherwise). A service-free schema that still does *asynchronous* work is accepted by the types but not by the synchronous adapters: `decodeUnknownSync` and `decodeUnknownResult` throw a plain `Error` wrapping an `AsyncFiberError` defect instead of a `SchemaError`, and `decodeUnknownExit` returns a `Die`. Only `decodeUnknownPromise` tolerates async steps outside an Effect.
- **`Result` / `Exit`** when pure code branches on the outcome. **`Option`** only when discarding the diagnostics is intended.
- **Throwing `Sync`** only at an edge that already speaks exceptions (a script, a framework callback) and catches there.

> **Warning:** `Effect.sync(() => Schema.decodeUnknownSync(S)(input))` has error type `never`, so bad input becomes a **defect** that no `Effect.catchTag("SchemaError", ...)` can see. Inside an Effect, call `Schema.decodeUnknownEffect(S)(input)` so the expected boundary outcome stays in the typed error channel. The two sibling mistakes are casting (`input as Employee`) and `Effect.orElseSucceed(() => believableDefault)` straight after decoding, which hides a parse failure behind plausible data.

Per-call behavior — excess keys, error accumulation, concurrency, rejected-input reporting — is covered in [Parse options are boundary policy](schema-in-depth#5-parse-options-are-boundary-policy).

Official guide: [Getting Started](https://effect.website/docs/v4/schema/getting-started) (its `"preserve"`, `propertyOrder`, and `parseOptions`-annotation passages do not apply to 4.0.2).

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

`optionalKey` and `optional` differ at runtime, not only in the type; the full input-state table, `null` handling, and `Option`-typed fields are in [Optional fields, null, and Option](schema-in-depth#6-optional-fields-null-and-option).

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

`Schema.encodeKeys` leaves unmapped keys alone and fails at construction when two fields map to the same encoded name. `Schema.annotateKey({ ... })` attaches key-level metadata (`title`, `description`, `messageMissingKey`) that JSON Schema output and error messages use. A declared struct field may be **inherited** from the input's prototype and is copied to an own property of the output; check ownership before parsing if every field must be own.

### 4. Unions, literals, records, tuples

`Union([...])` normally evaluates viable members in order, but it first uses literal sentinel fields to discard contradicted candidates. The same pruning applies to nested unions by collecting sentinels common to their members, so an error tree may omit branches already contradicted by the observed discriminator. `Literals([...])` is the array form of a literal union; supports `.pick([...])` and `.transform([...])`. `Schema.StringForLiteralAutocomplete` is an alias for `Schema.String` that editors treat as a plain string for autocomplete purposes; pair it with `Union` and `Literals` to accept any string while still suggesting the known literals (`Union([StringForLiteralAutocomplete, Literals(["GET", "POST"])])`). `Record(key, value)` takes two positional schemas. `Tuple([...])` takes an element array. Refined key schemas in a `Record` select matching properties rather than rejecting the whole object.

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

`TaggedUnion` and a union augmented with `Schema.toTaggedUnion(tag)` also expose `.tag` (the property key used as discriminator, e.g. `"_tag"`) and `.discriminants` (an ordered tuple of their literal tag values). Duplicate or missing discriminants are rejected while building the augmented union. The same augmentation provides `.cases` (member schema per tag), `.guards`, `.isAnyOf([...tags])`, and `.matchOrElse(value, cases, orElse)`, which handles a subset of tags and hands every remaining member — typed as the residual union — to `orElse`.

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

Official guide: [Basic Usage](https://effect.website/docs/v4/schema/basic-usage) (its "Transforming Keys" passage is stale: 4.0.2 records accept transformed key schemas).

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
| String | `isMinLength(n)`, `isMaxLength(n)`, `isBetweenLength(min, max)`, `isMinCodePoints(n)`, `isMaxCodePoints(n)`, `isBetweenCodePoints(min, max)`, `isNonEmpty()`, `isPattern(regExp)`, `isStartingWith`, `isEndingWith`, `isIncluding`, `isTrimmed`, `isLowercased`, `isUppercased`, `isCapitalized`, `isUncapitalized`, `isUUID(version?)`, `isGUID`, `isULID`, `isBase64`, `isBase64Url` |
| Number | `isGreaterThan`, `isGreaterThanOrEqualTo`, `isLessThan`, `isLessThanOrEqualTo`, `isBetween({ minimum, maximum })`, `isInt`, `isInt32`, `isUint32`, `isFinite`, `isMultipleOf(n)` (throws for a zero or non-finite divisor) |
| Array | the string length checks, plus `isUnique()` and `isUniqueKey()` (unique first elements in an array of `[key, value]` tuples) |
| Map / Set, object | `isMinSize`, `isMaxSize`, `isBetweenSize`; `isMinProperties`, `isMaxProperties`, `isBetweenProperties`, `isPropertyNames(keySchema)` |
| `Date`, `bigint`, `BigDecimal` | the comparison family with a suffix: `isBetweenDate`, `isGreaterThanBigInt`, `isLessThanOrEqualToBigDecimal`, ... |

Prebuilt aliases cover the common combinations (`Schema.NonEmptyString`, `Schema.Int`, `Schema.Natural`, `Schema.Trimmed`). `Duration` has no dedicated family; write a `makeFilter` over `Duration` predicates.

`isMinLength`/`isMaxLength`/`isBetweenLength` count UTF-16 code units; `isMinCodePoints`/`isMaxCodePoints`/`isBetweenCodePoints` count Unicode code points instead, so a string with astral characters (emoji, many CJK extension characters) is measured the way a person reading it would count. The code-unit checks still drive generated JSON Schema: `isMinLength`/`isMaxLength`/`isBetweenLength` export `minLength`/`maxLength` as an estimated code-point bound (`Math.ceil(unitsLength / 2)`) rather than the exact unit count, since JSON Schema's `minLength`/`maxLength` are defined over code points — treat the exported bound as approximate when round-tripping through JSON Schema.

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
- **A check is synchronous and service-free.** "Is this cost-center code still free?" is an effectful decode step whose requirement stays visible in the schema type ([`SchemaGetter.checkEffect`](schema-tooling#schemagetter)), never a lookup hidden inside a predicate.
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

For a transformation that can fail, use `SchemaGetter.transformEffect` and return an `Effect` that fails with a `SchemaIssue`; the two-way equivalent is `SchemaTransformation.transformEffect`, matching `Config.mapEffect` and the rest of the library. When a conversion is decode-only, use `SchemaGetter.forbiddenEncoding` as the `encode` leg so an attempt to encode fails with a `Forbidden` issue instead of inventing a value. For async validation, use `SchemaGetter.checkEffect` inside a `Schema.decode({...})` — the v4 replacement for `filterEffect`.

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
- A transformation has **three independent failure sites** — the source schema, the getter, the target schema — and each takes its own message ([Custom error messages](schema-in-depth#8-custom-error-messages)).

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

Getters that call services or do asynchronous work are covered in [Effectful schemas and services](schema-in-depth#9-effectful-schemas-and-services).

Official guide: [Schema Transformations](https://effect.website/docs/v4/schema/transformations) (it still spells `transformEffect` as `transformOrFail`, and it predates `SchemaGetter.forbiddenEncoding` — this page and the tagged 4.0.2 source win).

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

**`identifier` must be a single concrete string literal.** `Schema.brand` rejects a union, a widened `string`, or an open template-literal type for its identifier at the type level — the brand key has to be one known name. The brand is also type-only: it narrows the TypeScript type but is not recorded as an AST annotation, so schema representations and generated schema code omit it entirely. Reapply `Schema.brand` after rebuilding a representation or regenerating a schema when the nominal type still matters (checks added by `fromBrand` do survive, via the constructor's own `.checks`). `Schema.fromBrand`'s `identifier` must match the constructor's one brand key; apply `fromBrand` repeatedly to compose distinct brands, and represent alternatives with `Union`.

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

These class builders are distinct from validating an existing JavaScript `Error`: use `Schema.ErrorInstance(options?)` for that. Its JSON representation contains `message` plus optional `name` and `cause`; stack data is omitted unless `includeStack` is enabled, and `excludeCause` removes the cause. Persisted schema representations containing it need `SchemaRepresentation.ErrorInstanceReviver`; every built-in reviver lives in `SchemaRepresentation`, built from `SchemaRepresentation.makeReviverDeclaration`, `makeReviverFilter`, and `makeReviverFilterGroup`.

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
- **Instances compare structurally.** They extend `Data.Class`, so `Equal.equals(a, b)` is `true` for two separately decoded instances with equal fields while `a === b` is `false`. `Schema.toEquivalence(Grant)` compares only the *declared fields*, ignoring any undeclared runtime properties on the instance.
- **`new` always builds a fresh instance; `Grant.make(existing)`, `makeOption`, and `makeEffect` return an existing instance unchanged.**
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
| `new` / `make` with invalid input | constructors throw `Error("Schema validation failed")` with the issue in `cause` ([section 4 of Schema in Depth](schema-in-depth#4-construction-and-deliberate-fallbacks)) |
| decode produces an instance; encode leaks no internals | the class is a codec; getters and private state must not reach the wire |
| round trip under a stated equivalence | use `Equal.equals` or `Schema.toEquivalence`, never `===` |
| the JSON form | `JSON.stringify(instance)` is not the codec; derive `Schema.toCodecJson(Class)` |

Official guide: [Class APIs](https://effect.website/docs/v4/schema/classes) (its sample output for a failing `new` shows formatted issue text; 4.0.2 throws the generic message described in [section 4 of Schema in Depth](schema-in-depth#4-construction-and-deliberate-fallbacks)).
