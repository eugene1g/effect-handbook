# The Functional Toolkit

Effect ships a full standard library — structural equality, comparators, branded types, pattern matching, optics, arbitrary-precision decimals, and more — all composable with each other and the rest of the ecosystem.

## Match

`effect/Match` — stable

Exhaustive, composable pattern matching for TypeScript. Type-safe `switch` that narrows unions automatically, enforces case coverage, and composes through `pipe`.

**Mental model.** A `Matcher` is a function under construction. Start with `Match.type<YourUnion>()` (reusable matcher) or `Match.value(someValue)` (one-shot). Add arms with `when`, `tag`, `discriminator`, etc. — each narrows the remaining union. When remaining union is `never`, seal with `exhaustive`; otherwise use `orElse` for a catch-all. Result is `(input: I) => Result`.

```ts
import { Match, pipe } from "effect"

type PerformanceRating =
  | { _tag: "Exceeds"; percentileRank: number }
  | { _tag: "Meets" }
  | { _tag: "Below"; pipPlan: string }

// Build a reusable merit-multiplier function — type inferred as (rating: PerformanceRating) => number
const meritMultiplier = pipe(
  Match.type<PerformanceRating>(),
  Match.tag("Exceeds", ({ percentileRank }) => percentileRank >= 90 ? 0.05 : 0.04),
  Match.tag("Meets",   ()                   => 0.02),
  Match.tag("Below",   ()                   => 0),
  Match.exhaustive   // compile error if any tag is unhandled
)

meritMultiplier({ _tag: "Exceeds", percentileRank: 95 }) // 0.05
meritMultiplier({ _tag: "Meets" })                       // 0.02
```

**One-shot matching.** Use `Match.value` when you have a value in hand:

```ts
import { Match } from "effect"

type PerformanceRating =
  | { _tag: "Exceeds"; percentileRank: number }
  | { _tag: "Meets" }
  | { _tag: "Below"; pipPlan: string }

const reviewNote = (rating: PerformanceRating) =>
  Match.value(rating).pipe(
    Match.tag("Exceeds", () => "Eligible for accelerated promotion"),
    Match.tag("Meets",   () => "Eligible for standard merit increase"),
    Match.tag("Below",   ({ pipPlan }) => `On PIP: ${pipPlan}`),
    Match.exhaustive
  )

reviewNote({ _tag: "Below", pipPlan: "Q3-improvement" })
```

**Structural patterns.** `when` accepts any predicate or literal pattern — match by shape, not just tag:

```ts
import { Match, pipe } from "effect"

const classifyRaise = pipe(
  Match.type<unknown>(),
  Match.when(Match.string,  (s) => `Named plan: ${s}`),
  Match.when(Match.number,  (n) => `Fixed amount: $${n}`),
  Match.when({ _tag: "Exceeds" }, () => "High performer — top-of-band eligible"),
  Match.orElse(() => "No raise recommendation")
)
```

**Advanced arms.**

Key APIs: `Match.tag`, `Match.tags`, `Match.tagStartsWith`, `Match.when`, `Match.whenOr`, `Match.whenAnd`, `Match.not`, `Match.discriminator`, `Match.discriminators`, `Match.instanceOf`, `Match.is`

`Match.tag("Exceeds", "Meets", handler)` handles multiple tags in one arm. `Match.not(pattern, handler)` matches everything that does NOT match the pattern. `Match.tagStartsWith("Comp", handler)` useful for namespaced tags. `Match.withReturnType<R>()` pins the return type when TypeScript cannot infer it from arms alone.

Use when exhaustively pattern-matching unions — discriminated unions, workflow state machines, error types — and you want the compiler to enforce coverage.

## Order

`effect/Order` — stable

A typeclass for total ordering: `Order<A>` returns `-1 | 0 | 1`. All sorting, min/max, and clamp operations in Effect are backed by `Order`.

**Mental model.** Treat `Order` as a composable comparator. Built-ins for all primitives are Capitalized: `Order.Number`, `Order.String`, `Order.Boolean`, `Order.Date`, `Order.BigInt`.

```ts
import { Order, Array as Arr } from "effect"

// Built-in primitives (Capitalized)
const byNum = Order.Number   // Order<number>
const byStr = Order.String   // Order<string>

// Derive an order from a field
const byLevel = Order.mapInput(Order.Number, (e: { level: number }) => e.level)

// Combine: primary sort by level, secondary sort by baseSalary within the same level
const byLevelThenSalary = Order.combine(
  Order.mapInput(Order.Number, (e: { level: number; baseSalary: number }) => e.level),
  Order.mapInput(Order.Number, (e: { level: number; baseSalary: number }) => e.baseSalary)
)

const employees = [
  { name: "Ana",  level: 3, baseSalary: 120_000 },
  { name: "Ben",  level: 2, baseSalary: 95_000  },
  { name: "Cara", level: 3, baseSalary: 115_000  },
]

// Array.sort takes an Order directly
const sorted = Arr.sort(employees, byLevelThenSalary)
// [Ben(L2,$95k), Cara(L3,$115k), Ana(L3,$120k)]

// Sort by CompBand level then by band label — Order.Struct builds a struct comparator
const byBand = Order.Struct({
  level: Order.Number,
  label: Order.String,
})
```

**Combinators at a glance:**

Key APIs: Order.make, Order.mapInput, Order.combine, Order.combineAll, Order.flip, Order.Tuple, Order.Struct, Order.min, Order.max, Order.clamp, Order.isBetween

`Order.flip` reverses sort direction. `Order.Struct({ level: Order.Number, name: Order.String })` builds a struct comparator in one call. `Order.clamp(O)(min, max)(value)` pins a value to a range.

Use when sorting by multiple fields, finding min/max values, or clamping a value to a range.

## Equal

`effect/Equal` — stable

The structural equality protocol. `Equal.equals(a, b)` compares any two values using deep structural comparison for plain objects, arrays, Maps, Sets, and Dates; falls back to `[Equal.symbol]` for custom types.

**Mental model.** `Equal.equals(a, b)` compares by value, not reference. Types built with `Data` and collection types (`HashMap`, `HashSet`) implement the `Equal` interface and use it internally for membership and lookup.

Implement `Equal` on custom classes by satisfying the `Equal` interface (which extends `Hash`):

```ts
import { Equal, Hash } from "effect"

class Employee implements Equal.Equal {
  readonly id: string
  readonly name: string
  readonly level: number

  constructor(id: string, name: string, level: number) {
    this.id = id
    this.name = name
    this.level = level
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Employee && this.id === that.id
  }

  [Hash.symbol](): number {
    return Hash.string(this.id)
  }
}

const emp1 = new Employee("emp-001", "Alice",  3)
const emp2 = new Employee("emp-001", "Alice",  3)
const emp3 = new Employee("emp-002", "Bob",    2)

Equal.equals(emp1, emp2) // true  — same id
Equal.equals(emp1, emp3) // false — different id
```

Use when you need value-semantic equality on domain objects, want to use them as `HashMap` keys, or check membership in a `HashSet`.

## Hash

`effect/Hash` — stable

The hashing half of the equality protocol. `Hash.hash(value)` returns a stable integer hash, using structural hashing for plain objects/arrays and delegating to `[Hash.symbol]()` for custom types.

**Mental model.** Rarely called directly unless implementing a custom `Equal`. Compose hashes with `Hash.combine` for good distribution:

```ts
import { Hash } from "effect"

// Composing hashes for a composite key — e.g. (employeeId, cycleYear)
const h = Hash.combine(Hash.string("emp-001"))(Hash.number(2025))

// Helpers available
Hash.string("analyst@example.com")
Hash.number(3)
Hash.array(["L3", "Engineering", "NYC"])
Hash.structure({ departmentId: "eng", level: 3 })   // structureKeys over all own keys
const someObj = { employeeId: "emp-001" }
Hash.random(someObj)                                  // stable random hash per object identity
```

Use when implementing `[Hash.symbol]()` on a custom class that also implements `Equal`.

## Equivalence

`effect/Equivalence` — stable

A simple function type `(a: A, b: A) => boolean` with combinators for building custom equality predicates outside the `Equal` protocol.

**Mental model.** Where `Equal` is a protocol for arbitrary cross-type comparison, `Equivalence` is a typed comparator for a specific type — lighter when you don't need the full protocol. Built-ins are Capitalized: `Equivalence.String`, `Equivalence.Number`, `Equivalence.Boolean`, `Equivalence.Date`. Compose into struct and tuple comparators:

```ts
import { Equivalence } from "effect"

// Primitive equivalences (Capitalized exports)
Equivalence.String   // case-sensitive exact match
Equivalence.Number   // NaN-aware
Equivalence.Boolean
Equivalence.Date     // by getTime()

// Struct equivalence: compare comp bands by level and salary midpoint
const eqCompBand = Equivalence.Struct({
  level:  Equivalence.Number,
  midSalary: Equivalence.Number,
})

eqCompBand({ level: 3, midSalary: 130_000 }, { level: 3, midSalary: 130_000 })  // true

// Derive from an existing equivalence by projecting — compare employees by id only
const eqById = Equivalence.mapInput(
  Equivalence.String,
  (emp: { id: string }) => emp.id
)
```

Use when you need a custom equality predicate for deduplication, test assertions, or domain comparisons without implementing the full `Equal` interface.

## Ordering

`effect/Ordering` — stable

The type `Ordering = -1 | 0 | 1` — return value of any `Order<A>` comparator. Provides `Ordering.reverse` to flip a result and `Ordering.match` to branch on it. Mostly consumed by `Order` combinators internally; useful when implementing custom comparators combining multiple sub-comparisons.

```ts
import { Ordering } from "effect"

// Combine two sub-results: primary ordering wins, fall back to secondary on tie
const combined: Ordering.Ordering = firstResult !== 0 ? firstResult : secondResult
Ordering.reverse(-1)  // 1
Ordering.match(combined, { onLessThan: () => "lower band", onEqual: () => "same band", onGreaterThan: () => "higher band" })
```

## Combiner

`effect/Combiner` — stable

An associative binary operation: `combine(a, b)` produces another value of the same type. Building block for combining two values into one.

**Mental model.** A `Combiner<A>` merges two `A`s together. Carries no identity element — that is what `Reducer` adds. Note: `Combiner.intercalate` is curried — provide the separator first, then the base combiner.

```ts
import { Combiner, Number, String } from "effect"

// Sum two department merit budgets
const SumBudget = Combiner.make<number>((a, b) => a + b)
SumBudget.combine(120_000, 95_000)  // 215_000

// By picking the smaller/larger according to an Order — useful for capping budgets
const MinBudget = Combiner.min(Number.Order)
const MaxBudget = Combiner.max(Number.Order)

MinBudget.combine(120_000, 95_000)  // 95_000
MaxBudget.combine(120_000, 95_000)  // 120_000

// always keep the first / last value
const First = Combiner.first<string>()
const Last  = Combiner.last<string>()

// Intercalate: insert a separator between department codes
// Note: intercalate is curried — separator first, then combiner
const CommaSep = Combiner.intercalate(",")(String.ReducerConcat)
CommaSep.combine("HR", "ENG")  // "HR,ENG"

// Flip argument order (useful for non-commutative ops)
const Prepend = Combiner.flip(Combiner.make<string>((a, b) => a + b))
Prepend.combine("Engineering", "Senior ")  // "Senior Engineering"
```

Use when folding a non-empty collection into one value. Use `Reducer` when the collection may be empty.

## Reducer

`effect/Reducer` — stable

`Combiner` + an `initialValue` — enables folding empty collections. The `initialValue` acts as the identity element.

**Mental model.** Every primitive module ships ready-made reducers: `Number.ReducerSum`, `Number.ReducerMultiply`, `String.ReducerConcat`, `Boolean.ReducerAnd`, `Boolean.ReducerOr`, `BigInt.ReducerSum`. Roll your own with `Reducer.make`.

```ts
import { Reducer, Number } from "effect"

// Custom reducer for summing merit budgets
const BudgetSum = Reducer.make<number>((a, b) => a + b, 0)

// Sum department merit budgets — returns 0 for an empty org
const departments = [120_000, 95_000, 80_000, 150_000]
const totalBudget = departments.reduce(
  (acc, n) => Number.ReducerSum.combine(acc, n),
  Number.ReducerSum.initialValue
)
// => 445_000

BudgetSum.combine(120_000, 95_000)  // 215_000
BudgetSum.initialValue               // 0

// Flip reverses arg order (prepend instead of append)
const Prepend = Reducer.flip(BudgetSum)
```

Use when folding potentially-empty collections of values or building the identity element for a `Combiner`.

## Brand

`effect/Brand` — stable

Nominal typing for TypeScript. A `Branded<string, "EmployeeId">` is a `string` at runtime but a distinct type at compile time.

**Mental model.** Two flavors: *nominal* (no runtime validation, type assertion only — use when trusting the source) and *refined* (validated on construction, throws or returns a `Result` on failure — use when invariants are needed).

```ts
import { Brand, Schema } from "effect"

// ── Nominal brand (zero runtime cost) ────────────────────────────────────────
type EmployeeId = string & Brand.Brand<"EmployeeId">
const EmployeeId = Brand.nominal<EmployeeId>()

const id: EmployeeId = EmployeeId("emp-001")   // fine
// const bad: EmployeeId = "emp-001"            // type error — just a string

// ── Refined brand (runtime validation) ───────────────────────────────────────
// Money in cents: must be a non-negative integer
type MoneyCents = number & Brand.Brand<"MoneyCents">
const MoneyCents = Brand.make<MoneyCents>(
  (n) => (Number.isInteger(n) && n >= 0) || `Expected non-negative integer cents, got ${n}`
)

MoneyCents(12_500_00)    // 1_250_000 as MoneyCents (represents $12,500.00)
// MoneyCents(-1)         // throws BrandError at runtime

// Safe API — returns Result<MoneyCents, BrandError>
const result = MoneyCents.result(95_000_00)   // Result.succeed(...)
const none   = MoneyCents.option(-1)           // Option.none()
const ok     = MoneyCents.is(10_000_00)        // true

// ── Using a Schema check ──────────────────────────────────────────────────────
const NonNegativeInt = Brand.check<number & Brand.Brand<"NonNegativeInt">>(Schema.isInt())

// ── Combining multiple brands ─────────────────────────────────────────────────
// GrantShares must be a positive integer and below the authorized cap
type GrantShares = MoneyCents & Brand.Brand<"GrantShares">
const GrantShares = Brand.all(
  MoneyCents,
  Brand.make<GrantShares>((n) => n <= 100_000 || "grant exceeds authorized share cap")
)
```

Use to prevent primitive confusion — mixing `EmployeeId` with `DepartmentId`, salary cents with share counts, validated with raw strings — without wrapper classes at runtime.

## Optic

`effect/Optic` — stable

Composable, typed lenses and prisms for reading and immutably updating nested data. An optic describes a path into a data structure; compose paths then call `.get`, `.replace`, or `.modify`.

**Mental model.** Four optic types: `Optional` (may fail to focus) is the base; `Lens` (always-present field focus) and `Prism` (optional branch focus) are independent specializations of it; `Iso` (lossless bijection) is both a `Lens` and a `Prism`. Compose left-to-right via method chaining from `Optic.id<S>()`. `modify` returns a function `(s: S) => S` — call the result with the data.

```ts
import { Optic } from "effect"

type CompensationPlan = {
  readonly employeeId: string
  readonly base: { readonly annual: number; readonly currency: string }
  readonly equity: { readonly shares: number; readonly vestingMonths: number }
}

// Build a lens to a nested field
const annualBase = Optic.id<CompensationPlan>().key("base").key("annual")

const plan: CompensationPlan = {
  employeeId: "emp-001",
  base:   { annual: 120_000, currency: "USD" },
  equity: { shares: 5_000, vestingMonths: 48 },
}

annualBase.get(plan)                            // 120_000
annualBase.replace(130_000, plan)               // new plan with base.annual = 130_000

// modify returns a function — apply it to the data
const applyMerit = annualBase.modify((salary) => Math.round(salary * 1.04))
applyMerit(plan)                                // plan with base.annual = 124_800

// Deep-update equity shares with a 10% refresh grant
const equityShares = Optic.id<CompensationPlan>().key("equity").key("shares")
equityShares.modify((shares) => shares + Math.round(shares * 0.10))(plan)
// plan with equity.shares = 5_500
```

**Prisms for optional and union types.** Prisms focus on one branch and may fail — `getResult` returns a `Result`, `replaceResult` only updates if the prism can focus:

```ts
import { Optic, Option, Result, Schema } from "effect"

// Focus into Option — e.g. an optional managerId
const inner = Optic.id<Option.Option<string>>().compose(Optic.some())
inner.getResult(Option.some("mgr-007"))   // Result.succeed("mgr-007")
inner.getResult(Option.none())            // Result.fail(...)

// Validated prism using Schema checks — salary must be positive
const positiveSalary = Optic.id<number>().compose(
  Optic.fromChecks(Schema.isGreaterThan(0))
)
```

**Traversals** focus on all elements of a collection at once using `.forEach`:

```ts
import { Optic, Schema } from "effect"

type OrgChart = { readonly departments: ReadonlyArray<{ readonly headcount: number }> }

// Traversal over all department headcounts greater than 0
const positiveHeadcounts = Optic.id<OrgChart>()
  .key("departments")
  .forEach((dept) => dept.key("headcount").check(Schema.isGreaterThan(0)))

// Apply a function to every matching element
const scaled = positiveHeadcounts.modifyAll((n) => Math.ceil(n * 1.1))(org)
```

> **Note:** `replace` only clones objects along the focused path — all unrelated branches are reused by reference. This makes optic updates efficient even for deeply nested structures.

`notUndefined()` preserves optionality: called on an `Optional` it returns another `Optional`, while on a `Prism` it returns a `Prism`. Replacement through composed `Iso`/`Prism` optics writes without first reading the old focus, so setters do not unexpectedly fail merely because the getter cannot currently focus. Treat the optic as the public abstraction; its internal representation is not an API.

Use when updating deeply nested immutable data without boilerplate spread chains, or composing readers and writers for the same path.

## Predicate

`effect/Predicate` — stable

Type guards, refinements, and Boolean combinators. Both a utility belt of `isString`/`isNumber`/... guards and a combinator library for building complex predicates from simpler ones.

**Mental model.** A `Predicate<A>` is `(a: A) => boolean`. A `Refinement<A, B extends A>` is a type guard that narrows. Both compose:

```ts
import { Predicate } from "effect"

// Primitives
Predicate.isString("hello")    // true
Predicate.isNumber(42)         // true
Predicate.isNullish(null)      // true
Predicate.isNullish(undefined) // true
Predicate.isNotUndefined(0)    // true
Predicate.isTagged("Exceeds")({ _tag: "Exceeds", percentileRank: 95 })  // true

// Merit eligibility: employee must have a rating that is not "Below" and a level >= 2
const isMeritEligible = Predicate.and(
  Predicate.isTagged("Exceeds") as Predicate.Predicate<{ _tag: string; level: number }>,
  (e: { _tag: string; level: number }) => e.level >= 2
)

// Combinators
const isStringOrNumber  = Predicate.or(Predicate.isString, Predicate.isNumber)
const isNotNull         = Predicate.not(Predicate.isNull)

// Struct predicate: every field must pass — validate a RaiseRecommendation shape
const isRaiseRecommendation = Predicate.Struct({
  employeeId: Predicate.isString,
  amount:     Predicate.isNumber,
})

// Compose refinements: non-empty department code
const isNonEmptyString = Predicate.compose(
  Predicate.isString,
  (s: string): s is string => s.length > 0
)

// hasProperty type-safe property check
Predicate.hasProperty({ level: 3 }, "level")  // true

// Logical shortcuts
Predicate.every([Predicate.isString, (s: string) => s.length > 3])
Predicate.some([Predicate.isNull, Predicate.isUndefined])
```

Key APIs: isString, isNumber, isBoolean, isBigInt, isSymbol, isUndefined, isNull, isNullish, isObject, isFunction, isIterable, isDate, isError, isTagged, hasProperty, isTupleOf, and, or, not, xor, implies, compose

Use for runtime type narrowing, building eligibility predicates, or passing guards to `Array.filter`.

## BigDecimal

`effect/BigDecimal` — stable

Arbitrary-precision decimal arithmetic based on a `bigint` significand and integer scale. No floating-point rounding errors — `0.1 + 0.2 === 0.3` in BigDecimal.

**Mental model.** A `BigDecimal` is `value / 10^scale` where both are exact integers. All arithmetic preserves precision; division returns `Option<BigDecimal>` (use `divideUnsafe` if known non-zero). Parse from strings, format back to strings — never go through IEEE 754.

```ts
import { BigDecimal, pipe } from "effect"

// ── Merit increase calculation ────────────────────────────────────────────────
// Base salary $120,000.00 × 4% merit raise
const baseSalary  = BigDecimal.fromStringUnsafe("120000.00")
const meritRate   = BigDecimal.fromStringUnsafe("0.04")

const increase    = BigDecimal.multiply(baseSalary, meritRate)  // 4800.0000
const newSalary   = BigDecimal.sum(baseSalary, increase)        // 124800.0000

BigDecimal.format(newSalary)           // "124800.0000"
// Round to nearest dollar using the options object
BigDecimal.round(newSalary, { scale: 0, mode: "half-from-zero" })
// => BigDecimal representing 124800

// ── Equity grant value ────────────────────────────────────────────────────────
// 5,000 RSUs at current price $48.75 each
const sharePrice = BigDecimal.fromStringUnsafe("48.75")
const grantShares = BigDecimal.fromBigInt(5000n)

const grantValue = BigDecimal.multiply(sharePrice, grantShares)  // 243750.00
BigDecimal.format(grantValue)  // "243750.00"

// ── Comparison ────────────────────────────────────────────────────────────────
// Is the proposed salary above the band minimum?
BigDecimal.isGreaterThan(
  BigDecimal.fromStringUnsafe("124800"),   // proposed
  BigDecimal.fromStringUnsafe("115000")    // band min
) // true

BigDecimal.equals(
  BigDecimal.fromStringUnsafe("124800.00"),
  BigDecimal.fromStringUnsafe("124800.000")
) // true — normalize handles trailing zeros

// Safe division returns Option
const perShare = BigDecimal.divide(
  BigDecimal.fromStringUnsafe("243750"),
  BigDecimal.fromStringUnsafe("5000")
) // Option<BigDecimal> → Option.some(48.75)
```

**Rounding modes** are lowercase kebab strings: `"ceil"`, `"floor"`, `"to-zero"`, `"from-zero"`, `"half-ceil"`, `"half-floor"`, `"half-to-zero"`, `"half-from-zero"` (default), `"half-even"` (banker's), `"half-odd"`. Use `BigDecimal.round(value, { scale, mode })`.

**Order and Equivalence** are both exported — plug into `Array.sort` or collection APIs directly.

Use for any financial or compensation calculation where floating-point rounding is unacceptable.

## Differ

`effect/Differ` — stable

An interface for patch-based change tracking. A `Differ<T, Patch>` computes the difference between two `T`s as a `Patch`, combines patches, and applies a patch to produce an updated value.

**Mental model.** Typed diff/apply protocol. Rarely constructed by hand — consumed by data structures needing incremental updates (e.g., context propagation in the runtime). Implement when building patch-based state management:

```ts
import { Differ } from "effect"

// The interface:
// interface Differ<T, Patch> {
//   readonly empty: Patch
//   diff(oldValue: T, newValue: T): Patch
//   combine(first: Patch, second: Patch): Patch
//   patch(oldValue: T, patch: Patch): T
// }

// Example: track incremental changes to a merit budget pool (in cents)
const BudgetDiffer: Differ.Differ<number, number> = {
  empty: 0,
  diff:    (oldVal, newVal) => newVal - oldVal,
  combine: (a, b)           => a + b,
  patch:   (oldVal, delta)  => oldVal + delta
}

const delta1   = BudgetDiffer.diff(500_000, 450_000)  // -50_000 (first department draw)
const delta2   = BudgetDiffer.diff(450_000, 380_000)  // -70_000 (second department draw)
const combined = BudgetDiffer.combine(delta1, delta2)  // -120_000
BudgetDiffer.patch(500_000, combined)                  // 380_000 remaining
```

Use when building patch-sourced state propagation that needs to compute, merge, and replay incremental changes rather than replacing values wholesale.

## Newtype

`effect/Newtype` — stable

A zero-cost type wrapper — a type-level distinct alias for another type, with helpers to lift its `Equivalence`, `Order`, `Combiner`, and `Reducer` instances. Related to `Brand` but different: a Newtype carries no runtime value of its own; it is the carrier type with a phantom tag.

**Mental model.** Zero-overhead alternative to `Brand` when you only need distinct types without runtime validation. Pairs with `Optic.Iso` for lossless conversions. `makeIso` returns an `Iso` whose `.get` unwraps and `.set` wraps:

```ts
import { Newtype, Optic, Equivalence, Order } from "effect"

// Distinguish salary dollars from equity dollars at the type level
interface SalaryUSD extends Newtype.Newtype<"SalaryUSD", number> {}
const salaryIso = Newtype.makeIso<SalaryUSD>()

const base: SalaryUSD = salaryIso.set(120_000)   // 120_000 branded as SalaryUSD
salaryIso.get(base)                               // 120_000 (the plain number)

// Lift Order and Equivalence for the underlying number
const SalaryOrder = Newtype.makeOrder<SalaryUSD>(Order.Number)
const SalaryEq    = Newtype.makeEquivalence<SalaryUSD>(Equivalence.Number)
```

Use when you want unit-tagged types at zero runtime cost and don't need `Brand`'s validation machinery.

## Function

`effect/Function` — stable

Combinators for functional composition: `pipe`, `flow`, `identity`, `constant`, and indispensable utilities.

Re-exported from the `"effect"` barrel — typically `import { pipe, flow } from "effect"` rather than importing from this module directly.

```ts
import { pipe, flow, Function as F } from "effect"

// pipe: pass a value through a left-to-right pipeline
// Apply a merit raise and round to nearest dollar
const applyMerit = (base: number, rate: number) => pipe(
  base,
  (salary) => salary * (1 + rate),
  (raised) => Math.round(raised)
)
applyMerit(120_000, 0.04)  // 124_800

// flow: compose functions into a new function (no initial value)
const formatSalary = flow(
  (cents: number) => cents / 100,
  (dollars) => `$${dollars.toLocaleString()}`
)
formatSalary(12_480_000)  // "$124,800"

// identity / constant
F.identity(42)           // 42
F.constant(true)()       // true
F.constNull()            // null
F.constUndefined()       // undefined

// flip: swap the first two arguments of a function
const sub = (a: number) => (b: number) => a - b
F.flip(sub)(5_000)(120_000)   // 120_000 - 5_000 = 115_000

// compose: left-to-right function composition
// First extract level (string -> number), then format it
const formatLevel = F.compose(
  (s: string) => parseInt(s, 10),   // applied first
  (n: number) => `Level ${n}`       // applied second
)
formatLevel("3")  // "Level 3"

// dual: makes a function work data-first OR data-last (pipeable)
// — used extensively inside Effect to build the pipe-friendly API

// memoize: WeakMap-based memoization for object-keyed functions.
// memoizeIdempotent also caches the computed output as a fixed point.
type Normalized = { readonly name: string }
const normalize = F.memoizeIdempotent<Normalized>((person) => ({
  name: person.name.trim()
}))
const normalized = normalize({ name: "  Ada  " })
normalize(normalized) === normalized // true: the output is cached as its own result
```

Use `memoizeIdempotent` only when applying the original transformation again to its output would be observably idempotent; otherwise caching the output as a fixed point changes behavior.

Both memoizers are identity-based `WeakMap` caches, so structurally equal objects are different keys and mutating a key does not invalidate its cached value. `memoize` cannot return `undefined`: that value is reserved internally to mean “cache miss” (return `null` or another sentinel if absence is a legitimate result).

Use for `pipe` or `flow` (everyday use), or when building dual-mode utility functions for your own library.

## Number

`effect/Number` — stable

Pipeable arithmetic, comparisons, and ready-made `Reducer`s for `number`. Exports `Number.Order`, `Number.Equivalence`, `Number.ReducerSum`, `Number.ReducerMultiply`, `Number.ReducerMin`, `Number.ReducerMax`. Arithmetic ops (`sum`, `multiply`, `subtract`, `divide`, `remainder`) are data-last for pipeline use. Also `Number.clamp`, `Number.between`, `Number.sign`, `Number.parse` (safe string parse returning `Option`), `Number.round`, and `Number.nextPow2`.

```ts
import { Number as N, pipe } from "effect"

pipe(3, N.increment)          // 4
pipe(-1, N.sign)              // -1
N.sumAll([80_000, 95_000, 120_000])   // 295_000
N.parse("0.04")               // Option.some(0.04)
// Clamp a proposed salary to a comp band [min, max]
N.clamp({ minimum: 90_000, maximum: 160_000 })(185_000)  // 160_000
```

## String

`effect/String` — stable

Comprehensive, pipeable string API. Re-exports the global `String` constructor plus safe wrappers for common string operations. Notable additions over plain JS: `String.indexOf`/`lastIndexOf` return `Option`, `String.stripMargin` cleans multiline template literals, full case-conversion helpers (`camelCase`, `pascalCase`, `snakeToCamel`, `constantCase`, etc.).

```ts
import { String as S, pipe } from "effect"

pipe("  eng-l3-nyc  ", S.trim, S.toUpperCase)    // "ENG-L3-NYC"
S.stripMargin(`
  |employeeId: emp-001
  |level: 3
`)
// "employeeId: emp-001\nlevel: 3\n"

S.camelCase("merit_cycle")      // "meritCycle"
S.pascalCase("comp_band")       // "CompBand"
S.configCase("Payroll API URL") // "PAYROLL_API_URL"
// data-last: searchString first, then self
S.indexOf("emp")("hris-emp-001")  // Option.some(5)
```

## Boolean

`effect/Boolean` — stable

Boolean logic as pipeable functions. `Boolean.match` branches on a boolean like a mini pattern match. Logical connectives — `and`, `or`, `not`, `xor`, `nand`, `nor`, `implies`, `eqv` — as data-last functions. Includes `Boolean.every`/`some` for iterables and ready-made reducers `Boolean.ReducerAnd`/`ReducerOr`.

```ts
import { Boolean as B, pipe } from "effect"

const isPromotionEligible = true
pipe(isPromotionEligible, B.not)  // false
B.match(isPromotionEligible, {
  onTrue:  () => "schedule promotion review",
  onFalse: () => "standard merit only"
})
B.every([true, true, false])       // false  — all departments approved?
B.ReducerAnd.combine(true, false)  // false
```

## BigInt

`effect/BigInt` — stable

Arithmetic and comparison for native `bigint`. Mirrors the `Number` API — pipeable `sum`, `multiply`, `subtract`, `divide`, `remainder`, `abs`, `sign`, `clamp`, `between`. Additional math: `BigInt.gcd`, `BigInt.lcm`, `BigInt.sqrt`/`sqrtUnsafe`. Safe conversions: `BigInt.toNumber` → `Option`, `BigInt.fromString` → `Option`, `BigInt.fromNumber` → `Option`. Ready-made reducers: `BigInt.ReducerSum`, `BigInt.ReducerMultiply`; combiners: `BigInt.CombinerMax`, `BigInt.CombinerMin`.

```ts
import { BigInt as BI } from "effect"

// Share counts — large integers, safe as bigint
const totalGranted  = 50_000n
const totalVested   = 32_500n
const unvested      = BI.subtract(totalGranted, totalVested)  // 17_500n

BI.gcd(12n, 8n)               // 4n
BI.sqrt(10_000n)               // Option.some(100n)
BI.toNumber(totalGranted)      // Option.some(50000)
```

## Pipeable

`effect/Pipeable` — stable

The mixin that gives any object a `.pipe(...)` method, enabling `value.pipe(f, g, h)` fluent style. All Effect data types implement this. Extend `Pipeable.Class` or mix in `Pipeable.Mixin(Base)` to add `.pipe` to your own types. `Pipeable.pipeArguments` is the internal dispatch used by the `.pipe` implementation.

```ts
import { Pipeable } from "effect"

class SalaryBand extends Pipeable.Class {
  readonly min: number
  readonly mid: number
  readonly max: number

  constructor(min: number, mid: number, max: number) {
    super()
    this.min = min
    this.mid = mid
    this.max = max
  }
}

new SalaryBand(90_000, 120_000, 150_000)
  .pipe((band) => band.max - band.min)  // 60_000 (band spread)
```

## Symbol

`effect/Symbol` — stable

Re-exports the global `Symbol` constructor and provides `Symbol.isSymbol` (type guard), consistent with `Predicate.isSymbol`. Exists for import from `"effect"` without colliding with the JS global in tree-shaking-aware builds.

## RegExp

`effect/RegExp` — stable

Re-exports the global `RegExp` constructor, provides `RegExp.isRegExp` (type guard), and adds `RegExp.escape(string)` — escapes all regex metacharacters so a literal string can be safely embedded in a regex pattern.

```ts
import { RegExp as RE } from "effect"

// Safely search for an employee ID that might contain regex metacharacters
const empId = "emp.001+special"
const pattern = new RE.RegExp(`^${RE.escape(empId)}$`)
// pattern: /^emp\.001\+special$/
```

## UndefinedOr

`effect/UndefinedOr` — stable

Ergonomics for `A | undefined` without `Option` ceremony. Provides `UndefinedOr.map`, `UndefinedOr.match`, `UndefinedOr.getOrThrow`, `UndefinedOr.getOrThrowWith`, and `UndefinedOr.liftThrowable`. Bridges to `Combiner`/`Reducer`: `UndefinedOr.makeReducer(combiner)` and `UndefinedOr.makeReducerFailFast`.

```ts
import { UndefinedOr } from "effect"

// An employee's manager may or may not be set
const managerId: string | undefined = employee.managerId

UndefinedOr.map(managerId, (id) => `mgr:${id}`)   // string | undefined
UndefinedOr.getOrThrow(managerId)                   // string or throws
UndefinedOr.match(managerId, {
  onDefined:   (id) => `Reports to ${id}`,
  onUndefined: ()   => "No manager assigned (top-level)"
})
```

## Encoding

`effect/Encoding` — stable

Base64 and hex codecs — encoding always succeeds; decoding returns `Result<Uint8Array, EncodingError>`. Works on both `Uint8Array` and strings. URL-safe base64 variants included.

```ts
import { Encoding, Result } from "effect"

// Encode an employee JWT payload for transmission
const encoded = Encoding.encodeBase64("emp-001:merit-2025")   // base64 string
const decoded = Encoding.decodeBase64String(encoded)           // Result<string, EncodingError>

if (Result.isSuccess(decoded)) {
  console.log(decoded.success)  // "emp-001:merit-2025"
}

// Hex encoding for audit log checksums
Encoding.encodeHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))  // "deadbeef"
Encoding.decodeHex("deadbeef")  // Result<Uint8Array, EncodingError>

// URL-safe variants
Encoding.encodeBase64Url(someBytes)
Encoding.decodeBase64Url(someStr)
```

## Inspectable

`effect/Inspectable` — stable

Defines the `Inspectable` interface (`toJSON`, `toString`, `[NodeInspectSymbol]`) and a `BaseProto`/`Class` you can extend to make custom types print correctly in the Node.js REPL, logs, and test output. `Inspectable.toJson` first applies redaction, invokes an inspectable `toJSON`, and recursively handles arrays; plain objects otherwise remain unchanged. It is a structured inspection representation, not a promise that `JSON.stringify` can accept every nested value or cycle. String rendering uses `Formatter`.

```ts
import { Inspectable, Formatter } from "effect"

class CompBand extends Inspectable.Class {
  readonly level: number
  readonly min: number
  readonly mid: number
  readonly max: number

  constructor(level: number, min: number, mid: number, max: number) {
    super()
    this.level = level
    this.min = min
    this.mid = mid
    this.max = max
  }

  override toJSON() {
    return { _tag: "CompBand", level: this.level, min: this.min, mid: this.mid, max: this.max }
  }
  override toString(): string {
    return Formatter.format(this.toJSON())
  }
}

console.log(new CompBand(3, 90_000, 120_000, 150_000))
// { _tag: 'CompBand', level: 3, min: 90000, mid: 120000, max: 150000 }

String(new CompBand(3, 90_000, 120_000, 150_000))
// '{"_tag":"CompBand","level":3,"min":90000,"mid":120000,"max":150000}'
```

## Types

`effect/Types` — stable

Type-level utilities — no runtime code. Commonly encountered:

- **`Simplify<A>`** — Flattens intersection types into a readable object shape. Essential for IDE hover text.
- **`UnionToIntersection<T>`** — Converts `A | B | C` to `A & B & C`. Used in requirement accumulation.
- **`Equals<X, Y>`** — Type-level equality check, returns `true` or `false`. Useful in conditional types.
- **`Tags<E>`** — Extracts the string literal union of all `_tag` values from a discriminated union.
- **`Mutable<T>` / `DeepMutable<T>`** — Strips `readonly` from object properties, shallowly or recursively.
- **`NoInfer<A>`** — Prevents TypeScript from using a parameter site as an inference point — useful for pinning type parameters.

Also: `TupleOf`, `TupleOfAtLeast`, `MergeLeft`/`MergeRight`, `Concurrency`, `Invariant`/`Covariant`/`Contravariant` variance wrappers, `ExtractTag`, `ExcludeTag`, `ReasonOf`, `RequiredKeys`, and more.

## Utils

`effect/Utils` — stable

Advanced plumbing for libraries that implement Effect-style generator syntax; it is not a general application utility bag. `SingleShotGen<T, A>` is the one-yield iterator used to make a custom value work with `yield*`. The type-only `Variance` and `Gen<F>` encode environment, output, and error variance for a `TypeLambda`, which is how `Effect.gen`, `Option.gen`, and `Result.gen` infer the values yielded by their generators.

```ts
import { Option } from "effect"
import type { Utils } from "effect"

// A library can pin the common generator signature for its TypeLambda.
const optionGen: Utils.Gen<Option.OptionTypeLambda> = Option.gen

const value = optionGen(function*() {
  const n = yield* Option.some(41)
  return n + 1
}) // Option.some(42)
```

Most applications should use the owning module's `.gen` directly. Reach into `Utils` only when authoring a new Effect-like data type or generator DSL.

## Unify

`effect/Unify` — stable

A type-level mechanism that collapses a union of Effect-like types (e.g., `Effect<A> | Effect<B>`) into a single unified `Effect`. Makes `yield*` in `Effect.gen` work correctly across conditional branches returning different Effect types.

Rarely called directly, but `Unify.Unify<T>` appears in type signatures as the return type of generators and combinators that unify disparate branches. `Unify.unify(value)` is the runtime identity function carrying the type-level unification.

## HKT

`effect/HKT` — stable

Higher-Kinded Types for TypeScript, encoded via the defunctionalisation trick. TypeScript has no native HKT support, so Effect uses a `TypeLambda` interface as a "type function" mapping variance parameters to a concrete type via `Kind<F, In, Out2, Out1, Target>`.

Relevant when building typeclass instances (Functor, Traversable, etc.) for your own types, or reading internals of `Combiner`, `Reducer`, and `Equivalence`. Normal application code never touches `HKT` directly. Key exports: `TypeLambda`, `TypeClass`, `Kind`.
