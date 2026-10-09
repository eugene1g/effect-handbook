# Schema Tooling & Internals

The modules behind [Schema](schema): the AST every schema compiles to, the parser and its ahead-of-time and JIT compilers, getters and transformations as plain data, schema representations, the issue tree and `SchemaError`, JSON Schema and Standard Schema adapters, JSON Patch and Pointer, data models, and `TestSchema`. Most applications use these indirectly; read a section when you generate artifacts from schemas, write tooling, or need to understand a failure at the issue level.

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

> **Note:** Handy AST utilities: `SchemaAST.getAST(schema)` (the node), `toType`/`toEncoded`/`flip` (memoized tree rewrites that power the `Schema`-level functions of the same name), `annotate`/`appendChecks`/`replaceEncoding` (build derived nodes), and `resolveTitle`/`resolveDescription`/`resolveIdentifier` (read annotations). The node classes — `Objects`, `Arrays`, `Union`, `Literal`, `Declaration` — are exported if you need to construct one. The `SchemaAST` and `SchemaIssue` nodes and the `SchemaTransformation` models are published as **structural instance interfaces**: `new` and `instanceof` still work, but a constructor's `prototype` is not part of the TypeScript API, so name the instance interface (`SchemaAST.AST`, `SchemaTransformation.Transformation<T, E>`) in type positions. `SchemaGetter.Getter<T, E, R>` is a tagged union with no constructor at all ([SchemaGetter](#schemagetter)). `SchemaAST.Base` does not exist; accept `SchemaAST.AST` and narrow with the `is*` guards. `SchemaAST.Context.constructorDefault` holds the constructor-default `Effect` directly rather than a `SchemaAST.Link`; code that builds or reads a `Context` by hand passes or reads that `Effect`.

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

Parsers look up each exact AST in a shared decoder registry. By default that entry is the interpreter; [SchemaJITCompiler](#schemajitcompiler) and [SchemaAOTCompiler](#schemaaotcompiler) can install compiled entries whose optional synchronous `decode`, `is`, and `make` fast paths the parser tries first, falling back to the detailed decoder to build the issue when a fast path rejects the input. The `SchemaParser` API and its results stay the same either way.

**Reach for it when** writing a custom `declare` codec and needing to decode/encode inner schemas, or building a low-level tool that wants the raw `Effect<A, Issue>` traversal. Day to day, call through `Schema`.

## SchemaCompiler

`effect/schema/SchemaCompiler` — unstable

The shared registry that maps an exact `SchemaAST.AST` to a `CompiledDecoder`: a required `decodeEffect` (complete decoding with detailed issues) plus optional `is`, `decode`, `make`, and `makeEffect` operations. The JIT and AOT compilers are both clients of this registry; `SchemaCompiler.set(ast, decoder)` is the manual entry point, and `SchemaCompiler.invalid` / `SchemaCompiler.missing` are the sentinels a fast path returns for "rejected, ask the detailed decoder" and "no value produced".

**Mental model.** A cache of parser implementations keyed by AST identity, never of parse results. A fast path only has to be right about valid input; everything else is delegated to `decodeEffect`, which produces the issue.

```ts
import { Effect, Schema, SchemaIssue } from "effect"
import { SchemaCompiler } from "effect/schema"

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

`effect/schema/SchemaJITCompiler` — unstable

Generates decoder source for a schema at runtime and installs it through `new Function`. Two entry points: the side-effect import `effect/schema/SchemaJITCompiler/enable` compiles every schema lazily on first use, and `SchemaJITCompiler.enable(schema.ast)` compiles one schema and its parsing dependencies.

**Mental model.** A drop-in accelerator for the same parser. Operations compile lazily on first use; checks, transformations, and defaults are never executed at installation. Validators, structs, and homogeneous arrays get generated code; most transformations and all middleware still run through the interpreter, with compiled children.

```ts
import { Schema } from "effect"
import { SchemaJITCompiler } from "effect/schema"

const PayrollLine = Schema.Struct({
  employeeId: Schema.NonEmptyString,
  grossCents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  costCenters: Schema.Array(Schema.String)
})

// Selective: enable before the first decode of this schema anywhere in the process.
SchemaJITCompiler.enable(PayrollLine.ast)

const decodeLine = Schema.decodeUnknownSync(PayrollLine) // same API, same issues on failure

// Global alternative, as the entrypoint's first import:
// import "effect/schema/SchemaJITCompiler/enable"
```

In practice, a four-field struct decodes about three times faster with JIT enabled and produces identical results and error messages. Where dynamic function construction is blocked (a Content Security Policy without `'unsafe-eval'`, some edge runtimes), compilation fails silently and parsing stays interpreted: nothing breaks, nothing gets faster. Enable **before first use**: a parser function that has already run keeps its interpreted entry, while one created but not yet called picks up the compiled entry.

**Reach for it when** profiling shows schema decoding on a hot path (high-volume ingestion, large payload arrays) in a runtime that allows `new Function`. Leave it off otherwise; results do not change, only speed.

## SchemaAOTCompiler

`effect/schema/SchemaAOTCompiler` — unstable

The build-time twin of the JIT compiler. `SchemaAOTCompiler.compile(targets)` returns the source of a static JavaScript module whose `install(asts)` export registers the generated decoders, so no code is constructed at runtime. The companion entrypoint `effect/schema/SchemaAOTCompiler/Build` exposes `build(options)`, which loads your schema modules, compiles their **direct** `Schema` exports, and writes a module that installs itself when imported. It needs `FileSystem` and `Path` and fails with `BuildError` or `PlatformError`.

**Mental model.** JIT output frozen into a file. Operations are opt-in per build (`"decode"` by default; add `"encode"`, `"is"`, `"make"`); anything not generated falls back to the interpreter.

```ts
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { build } from "effect/schema/SchemaAOTCompiler/Build"

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

The generated module installs and decodes correctly with `globalThis.Function` blocked, at a speed comparable to JIT. Regenerate the file whenever a schema definition or the Effect version changes; installation trusts that the ASTs match what was compiled. Bundler configurations that mark modules side-effect free must keep the generated import.

**Reach for it when** you want compiled decoders where `new Function` is unavailable (strict CSP, locked-down runtimes) or you want no code generation at startup. It trades a build step and a regenerate-on-change rule for that.

## SchemaGetter

`effect/SchemaGetter` — stable

A `Getter<T, E, R>` is one direction of a conversion: takes an optional encoded value and returns an optional decoded value, possibly failing with an issue or requiring services. Getters are the atoms of the v4 transformation model.

**Mental model.** A validating, possibly-effectful `map` for one leg of a codec. Built-in getters: `transform` (pure map), `transformEffect` (map that can reject or use services), `forbiddenEncoding` (the encode leg of a decode-only conversion), `transformOptional` (operate on the `Option` of presence — key to optional-field migrations), `checkEffect` (async validation), `passthrough`/`required`/`omit`, and ready-made conversions `String()`, `Number()`, `trim()`, `parseJson()`, `encodeBase64()`. When a getter must see a missing value *and* run an Effect, use `transformOptionalEffect((option, parseOptions) => Effect<Option>)`.

**Getters are data, operated on by functions.** A `Getter` is a tagged union (`Passthrough`, `Transform`, `TransformOptional`, `TransformEffect`, `TransformOptionalEffect`) whose values expose only `pipe`. Chain and run them with the dual functions `SchemaGetter.map`, `SchemaGetter.compose`, and `SchemaGetter.run` (there are no `getter.map`, `getter.compose`, or `getter.run` members, no public `new SchemaGetter.Getter(...)` constructor, and no `SchemaGetter.onSome` / `onNone` — use `transformEffect` for present values and `transformOptionalEffect` when the missing case matters).

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

**Composing and wrapping.** Chain two transformations with the dual `SchemaTransformation.composeTransformation(first, second)` or `first.pipe(SchemaTransformation.composeTransformation(second))`: decoding runs `first` then `second`, encoding runs them in reverse. There is no `first.compose(second)` method. Pair two existing getters with `SchemaTransformation.makeTransformation({ decode, encode })`. `Transformation` and `Middleware` values are `Pipeable`.

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

`fromRepresentation(document, { revivers })` reconstructs a runtime schema; no declaration/check revivers are installed implicitly. The multi-root twin is `fromRepresentations`. Persisted documents using an older representation format are not wire-compatible; regenerate them or perform an explicit migration before loading them with the current pipeline. That includes older documents containing a `oneOf` union, whose mode now lives at `{ options: { mode: "oneOf" } }` (`SchemaAST.Union.options?.mode`, not a top-level field); the public `Schema.Union(members, { mode })` call is unaffected. Importing external JSON Schema patterns also requires an explicit trust choice: the default is to reject them, `{ patterns: "apply" }` evaluates patterns from a trusted document, and `{ patterns: "ignore" }` knowingly weakens validation.

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

**Customize wording with formatter hooks.** `makeFormatterStandardSchemaV1` accepts a `leafHook` (terminal issues: `MissingKey`, `InvalidType`, `UnexpectedKey`, ...) and a `checkHook` (failed filters; return `undefined` to keep the `Expected ...` fallback). A hook handles the tags it cares about and delegates the rest to `SchemaIssue.defaultLeafHook` / `SchemaIssue.defaultCheckHook`, which honor `message` annotations first. This keeps wording — or translation keys — a presentation concern at the boundary instead of scattering strings through schemas, and `Schema.toStandardSchemaV1` accepts the same two hooks. The schema-side alternative is in [Custom error messages](schema-in-depth#8-custom-error-messages).

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

The public error wrapper used by the high-level `Schema.decode*` and `Schema.encode*` adapters. `Schema.SchemaError` is tagged `"SchemaError"` and carries the raw `SchemaIssue.Issue` in `.issue`; its `.message` applies the default formatter. `Schema.isSchemaError` safely recognizes it, including across duplicated package copies. It lives in the `Schema` namespace; there is no standalone `effect/SchemaError` module.

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

Two things to know about documents you generate yourself with `Schema.toJsonSchemaDocument`. (OpenAPI documents derived by `HttpApi` are a separate path: `OpenApi.fromApi` emits **closed** objects, `"additionalProperties": false` — see [HTTP API](../interfaces/http-api).)

- **Objects are open by default.** Generation now mirrors Effect decoding, which ignores excess properties unless told otherwise, so a `Struct` emits `"additionalProperties": true`. The old `{ additionalProperties }` generation option is gone: use `{ onExcessProperty: "ignore" }` (the default) or `{ onExcessProperty: "error" }` for a closed object, and model a schema-valued "rest" with `Schema.Record` or `Schema.StructWithRest` rather than an option. If a consumer relied on the previous closed default — a strict validator, a generated client, a structured-output provider — opt back in explicitly.
- **Check constraints and annotations are compacted** into the node when no keyword collides (`"type": "integer", "description": …`) instead of being wrapped in `allOf`. `allOf` still appears when merging would overwrite a keyword. Snapshot tests of generated documents need refreshing.

On the import side (`SchemaRepresentation.fromJsonSchemaDocument`), unsupported references, validation keywords, and object-valued `const`/`enum` are now **rejected with a path-qualified explanation** instead of being silently weakened.

**What the document describes.** Four rules explain most surprising output:

- **It describes the `Encoded` side.** Generation goes through the canonical JSON codec, so a `FiniteFromString` field is `{ "type": "string" }` and a `Schema.Option(...)` is a union of tagged objects — never the in-memory `Type`. For the same reason `.annotate(...)` on a transformation documents the decoded side, which JSON Schema never sees; use `Schema.annotateEncoded({ description })` to reach the document. A `Schema.fromJsonString(inner)` field becomes `{ "type": "string", "contentMediaType": "application/json" }`.
- **`identifier` creates `$ref` definitions.** The result is `{ dialect, schema, definitions }`. A schema carrying an `identifier` annotation (a class identifier counts) is hoisted into `definitions` and referenced as `{ "$ref": "#/$defs/<identifier>" }`. A recursive schema is always emitted through a definition; without an identifier the generator invents the name, so give it one. This is what controls reusable component names in OpenAPI documents and structured-output schemas.
- **Checks become keywords only when they know how.** Built-in checks map to `minLength`, `pattern`, numeric bounds, `uniqueItems`, and so on. A custom `Schema.makeFilter` contributes nothing unless it carries a `toJsonSchema` annotation ([section 5 of Schema](schema#5-refinements-check-and-refine)); `{ generateDescriptions: true }` turns each check's `expected` text into a `description`.
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

Official guide: [Schema to JSON Schema](https://effect.website/docs/v4/schema/json-schema) (it documents an `additionalProperties` generation option and closed-by-default output; 4.0.2 uses `onExcessProperty` and is open by default).

**Reach for it when** you need a machine-readable *value* contract for external consumers: JSON Schema config validation, cross-language codegen of a payload, or structured-output LLM prompting. For an HTTP API description, generate OpenAPI from `HttpApi` instead.

## StandardSchema

`effect/StandardSchema` — stable

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

// Whole-pointer URI fragments, as used by "$ref".
JsonPointer.formatUriFragment(["$defs", "eng/backend"]) // "#/$defs/eng~1backend"
JsonPointer.parseUriFragment("#/$defs/eng~1backend")    // ["$defs", "eng/backend"]
JsonPointer.parseUriFragment("#/%")                     // undefined: not a valid fragment
```

**Reach for it when** building or parsing JSON Pointer paths by hand, particularly for keys containing slashes or tildes.

## Model

`effect/schema/Model` — unstable

Define a domain model once and derive operation-specific variants: `select`, `insert`, `update` (database-facing) and `json`, `jsonCreate`, `jsonUpdate` (API-facing). Field declaration helpers encode per-variant behavior: `Model.GeneratedByDb` (omit on insert, present on select), `Model.DateTimeInsertFromDate` (set on insert), `Model.DateTimeUpdateFromDate` (set on update), `Model.Sensitive` (hidden from JSON), `Model.FieldOption` (nullable column ↔ `Option`).

```ts
import { Schema } from "effect"
import { Model } from "effect/schema"

export const EmployeeId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("EmployeeId"))

// Every Model helper below is part of the unstable `effect/schema/Model` module.
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

`effect/schema/VariantSchema` — unstable

The general "one definition, many variants" mechanism that `Model` is built on. `VariantSchema.make({ variants, defaultVariant })` produces a toolkit — `Struct`, `Class`, `Union`, `Field`, `FieldOnly`, `FieldExcept`, `fieldEvolve`, `extract` — specialized to your variant names. `Model` is `VariantSchema.make({ variants: ["select","insert","update","json","jsonCreate","jsonUpdate"], defaultVariant: "select" })`.

**Mental model.** Fix a set of views over the same data, then declare each field's behavior per view: shared by all variants (plain schema), restricted to some (`FieldOnly(["read"])`), excluded from some (`FieldExcept(["public"])`), or given a different schema per variant (`Field({ read: ..., write: ... })`). The toolkit derives a real `Schema` for every variant.

```ts
import { Schema } from "effect"
import { VariantSchema } from "effect/schema"

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

`effect/testing/TestSchema` — unstable

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

// TestSchema is unstable end to end — every member used below is too.
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

**The minimum set per boundary is four cases**: one valid wire object (decoded, then encoded back), one missing required field, one bad value, and one excess property under the policy that boundary chose ([section 5 of Schema in Depth](schema-in-depth#5-parse-options-are-boundary-policy)).

Two limits of derived generators shape the rest: `Arbitrary.schema` produces valid decoded `Type` values, so it can test invariants and round trips but **never rejection, key omission, or malformed wire input** — keep a handful of named *encoded* fixtures for those (and one regression fixture per representation bug). And it knows only the schema: a cross-field business rule must be a schema `check` (constructive where possible) or a residual `Arbitrary.filter`, which spends the discard budget. The round-trip law worth asserting is described in the [Schema deep dive](../deep-dives/schema-from-external-input-to-domain-and-back#test-the-contract-in-both-directions).

Official guide: [Schema to Arbitrary](https://effect.website/docs/v4/schema/arbitrary).

**Reach for it when** writing tests for schemas — especially custom transformations and refinements. `verifyGeneration(options?)` runs a native `Arbitrary.checkEffect` property (20 runs by default) that generated values satisfy `Schema.is`; `verifyRoundTrip(options?)` (with an Effect-returning `verifyRoundTripEffect` twin) checks decode∘encode round trips. Both take `Arbitrary.CheckOptions` (`{ seed, runs, maxDiscards, maxShrinks, replay }`) directly, bound unsuccessful generation, and report the shrunk input and replay token on failure. `decoding().fail(input, message)` pins down error messages; `decoding().failEffect` / `encoding().succeedEffect` / `encoding().failEffect` are the lazy-`Effect` twins of `fail` / `succeed`.
