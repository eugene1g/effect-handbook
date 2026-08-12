# Schema

Effect v4 rebuilt Schema around a single `Codec` abstraction: a two-way, validating, possibly-effectful bridge between two TypeScript types. `Type` is the decoded, in-memory value; `Encoded` is the wire/storage shape. `decode` goes Encoded → Type (with validation); `encode` goes Type → Encoded. `Schema.String` is the degenerate case (both sides `string`); `Schema.FiniteFromString` (`Encoded = string`, `Type = number`) is the usual numeric boundary. Satellite modules — `SchemaParser`, `SchemaIssue`, `SchemaGetter`, `SchemaTransformation`, `SchemaRepresentation` — are the implementation; `Schema` is the interface.

> **Official companion:** Effect's release-matched [comprehensive Schema guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/SCHEMA.md) goes substantially deeper into codecs, constraints, transformations, serialization, generated tooling, integrations, and migration.

## Schema

`effect/Schema` — stable

The core module: declare data shape and validation; get back a value that is simultaneously a type-level description (`Type` and `Encoded`), a runtime validator, a two-way codec, and a seed for derived artifacts (JSON Schema, arbitraries, equivalence, formatters).

**Mental model.** A schema is a `Codec<Type, Encoded, RD, RE>`: decodes into `Type`, encodes from `Encoded`, decoding may require services `RD`, encoding may require services `RE`. Use `typeof Employee.Type` and `typeof Employee.Encoded` rather than reading the full `Schema.Struct<...>` type. When a `Schema.Schema<T>` widens and loses `Encoded`, call `Schema.revealCodec(schema)` to recover the full `Codec<T, E, RD, RE>` view.

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

`TaggedUnion` and a union augmented with `Schema.toTaggedUnion(tag)` also expose `.discriminants`: an ordered tuple of their literal tag values. Duplicate or missing discriminants are rejected while building the augmented union.

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

### 6. Transformations — `decodeTo` + getters

In v4, `transform`/`transformOrFail` are largely replaced by `decodeTo(target, transformation)` where the transformation is a `SchemaTransformation` (two-way) or a pair of one-way `SchemaGetter`s.

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

For a transformation that can fail, use `SchemaGetter.transformOrFail` and return an `Effect` that fails with a `SchemaIssue`. For async validation, use `SchemaGetter.checkEffect` inside a `Schema.decode({...})` — the v4 replacement for `filterEffect`.

```ts
import { Effect, Number, Option, Schema, SchemaGetter, SchemaIssue } from "effect"

// A share count must be a real non-negative integer; reject junk like "abc".
const SharesFromStringStrict = Schema.String.pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), {
    decode: SchemaGetter.transformOrFail((s) =>
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

### 9. Classes and tagged errors

`Schema.Class` produces a real class whose constructor validates its fields, with a derived schema attached. `TaggedClass` auto-adds a `_tag`. `Error` and `TaggedError` produce yieldable, schema-validated errors: `yield* new EmployeeNotFound({...})` works inside `Effect.gen`. `Schema.Opaque` types the decoded value as a nominal class rather than its structural shape. `Class` instances support `.extend("SubName")(extraFields)` for schema-validated subclassing.

These class builders are distinct from validating an existing JavaScript `Error`: use `Schema.ErrorInstance(options?)` for that. Its JSON representation contains `message` plus optional `name` and `cause`; stack data is omitted unless `includeStack` is enabled, and `excludeCause` removes the cause. Persisted schema representations containing it need `Schema.ErrorInstanceReviver`.

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

### 10. Annotations and derivations

`annotate` attaches metadata (title, description, examples, custom keys) that flows into JSON Schema, error messages, and docs. Derivations from the same schema object: `toArbitrary` (fast-check generator), `toEquivalence` (structural equality), `toFormatter` (pretty-printer), `toStandardSchemaV1` (Standard Schema interop), `toJsonSchemaDocument`.

```ts
import { Schema } from "effect"
import * as FastCheck from "fast-check"

const CompBand = Schema.Struct({
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  salaryMid: Schema.Finite
}).pipe(
  Schema.annotate({ title: "CompBand", description: "Salary midpoint for a level" })
)

const eq = Schema.toEquivalence(CompBand)
eq({ level: 5, salaryMid: 190000 }, { level: 5, salaryMid: 190000 }) // true

const makeCompBandArbitrary = Schema.toArbitrary(CompBand)
const CompBandArb = makeCompBandArbitrary(FastCheck) // fast-check Arbitrary<CompBand>
```

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

Do not use the internal `Schema.UnknownFromJsonString`; compose `Schema.fromJsonString(Schema.Unknown)` when the JSON value is intentionally unknown.

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

In generic helpers, use `S extends Schema.Top` (or a narrower constraint) and return `S`-derived types. Avoid broad `Schema.Top`, `Schema.Schema<T>`, or `Schema.Codec<T, E>` annotations on concrete non-recursive schemas: widening erases mutability, optionality, constructor, and other type-level metadata baked into the precise schema.

### 13. Construction and deliberate fallbacks

Every schema has `.make(...)`; validation failures throw. `.makeOption(...)` and `SchemaParser.makeOption(schema)` provide the non-throwing constructor form, returning `Option.none()` for schema issues. `Schema.catchDecoding` can replace a decoding failure with an effectful `Option` fallback; `catchDecodingWithContext` may additionally require services. These middlewares intentionally weaken a boundary, so reserve them for an explicit compatibility/defaulting policy rather than hiding malformed input.

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

> **Note:** Handy AST utilities: `SchemaAST.getAST(schema)` (the node), `toType`/`toEncoded`/`flip` (memoized tree rewrites that power the `Schema`-level functions of the same name), `annotate`/`appendChecks`/`replaceEncoding` (build derived nodes), and `resolveTitle`/`resolveDescription`/`resolveIdentifier` (read annotations). The node classes — `Objects`, `Arrays`, `Union`, `Literal`, `Declaration` — are exported if you need to construct one.

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

**Reach for it when** writing a custom `declare` codec and needing to decode/encode inner schemas, or building a low-level tool that wants the raw `Effect<A, Issue>` traversal. Day to day, call through `Schema`.

## SchemaGetter

`effect/SchemaGetter` — stable

A `Getter<T, E, R>` is one direction of a conversion: takes an optional encoded value and returns an optional decoded value, possibly failing with an issue or requiring services. Getters are the atoms of the v4 transformation model.

**Mental model.** A validating, possibly-effectful `map` for one leg of a codec. Built-in getters: `transform` (pure map), `transformOrFail` (map that can reject), `transformOptional` (operate on the `Option` of presence — key to optional-field migrations), `checkEffect` (async validation), `passthrough`/`required`/`omit`, and ready-made conversions `String()`, `Number()`, `trim()`, `parseJson()`, `encodeBase64()`.

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

**Reach for it when** defining a transformation and needing the decode or encode leg — especially for optional-field gymnastics (`transformOptional`), async checks (`checkEffect`), or built-in string/binary/JSON conversions.

## SchemaTransformation

`effect/SchemaTransformation` — stable

A `Transformation<T, E>` bundles both directions of a conversion — decode (E → T) and encode (T → E) — into one reusable value. Passed as the second argument to `decodeTo` when a clean two-way mapping exists.

**Mental model.** A named codec-fragment. Prebuilts: `transform`/`transformOrFail` constructors plus `trim`, `toLowerCase`, `capitalize`, `numberFromString`, `dateFromString`, `optionFromNullOr`, `fromJsonString`, `uint8ArrayFromBase64String`. These are how `Schema.Trim`, `Schema.DateFromString`, etc. are defined internally. At the public schema level use `Schema.fromJsonString(inner, { reviver?, replacer?, space? })`; the old `Schema.UnknownFromJsonString` constant is internal.

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

`fromRepresentation(document, { revivers })` reconstructs a runtime schema; no declaration/check revivers are installed implicitly. The multi-root twin is `fromRepresentations`. Persisted documents using the legacy representation format are not wire-compatible; regenerate them or perform an explicit migration before loading them with the current pipeline. Importing external JSON Schema patterns also requires an explicit trust choice: the default is to reject them, `{ patterns: "apply" }` evaluates patterns from a trusted document, and `{ patterns: "ignore" }` knowingly weakens validation.

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

> **Existing classes:** Use `Schema.instanceOf(Constructor)` when the boundary already contains instances. For a struct-on-the-wire codec, explicitly combine the struct, `Schema.decodeTo`, and a `SchemaTransformation.transform` that constructs and projects the class; or define the model with `Schema.Class` when you own it.

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
//       "allOf": [{ "description": "Job level, e.g. 5 for IC5" }]
//     },
//     "salaryMid": { "type": "integer" }
//   },
//   "required": ["level", "salaryMid"],
//   "additionalProperties": false
// }
```

**Reach for it when** you need machine-readable schema for external consumers: OpenAPI specs, JSON Schema config validation, codegen for another language, or structured-output LLM prompting.

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

The two RFC 6901 token conversions underlying `JsonPatch` paths. `escapeToken` encodes `~`→`~0` and `/`→`~1`; `unescapeToken` reverses it.

```ts
import { JsonPointer } from "effect"

// A comp-band key like "eng/backend" needs escaping to live in a pointer path.
JsonPointer.escapeToken("eng/backend~ic5")   // "eng~1backend~0ic5"
JsonPointer.unescapeToken("eng~1backend~0ic5") // "eng/backend~ic5"
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

**Mental model.** A schema has three behaviors — decode, encode, construct — plus a derived generator. `arbitrary().verifyGeneration()` property-tests that everything the schema's fast-check arbitrary produces actually decodes, catching impossible constraints and broken transformations.

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

**Reach for it when** writing tests for schemas — especially custom transformations and refinements. `verifyGeneration()` runs a FastCheck property (20 cases by default, configurable through `params`) that generated values satisfy `Schema.is`; use the separate lossless-transformation helpers when testing round trips. `decoding().fail(input, message)` pins down error messages.
