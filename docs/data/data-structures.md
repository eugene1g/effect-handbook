# Data Structures

Effect's data structure modules share a common design: immutable, `pipe`-first dual APIs, and structural `Equal`/`Hash` throughout. Once familiar with one module, the rest follow the same pattern.

## Array

`effect/Array` — stable

Operates on plain JavaScript `ReadonlyArray` values — no wrapper type. Every function is pure and returns a new array. Results are native arrays, compatible with any third-party code without conversion.

**Mental model.** Fully typed `lodash/fp`, integrated with Effect's `Order`/`Equal`/`Option`/`Result` types. Every function taking a self-argument first also has a curried overload for `pipe`.

Many functions produce `NonEmptyArray<A>` (alias: `readonly [A, ...A[]]`) when the output is guaranteed non-empty — `Array.make(1, 2, 3)`, `Array.sortBy(...)` on a non-empty input, and `Array.groupBy` values all yield the tighter type.

```ts
import { Array, Order, Result, Option, pipe } from "effect"

// --- domain types ---
type Employee = {
  readonly id: string
  readonly name: string
  readonly department: string
  readonly level: number
  readonly baseSalary: number
}

const employees: Employee[] = [
  { id: "e1", name: "Alice",   department: "Engineering", level: 4, baseSalary: 140_000 },
  { id: "e2", name: "Bob",     department: "Design",      level: 3, baseSalary: 110_000 },
  { id: "e3", name: "Carol",   department: "Engineering", level: 5, baseSalary: 165_000 },
  { id: "e4", name: "Dave",    department: "Design",      level: 2, baseSalary:  90_000 },
  { id: "e5", name: "Eve",     department: "Engineering", level: 3, baseSalary: 125_000 },
]

// --- building ---
// makeBy(n, f) — note: n is the first arg, f is second
const levels = Array.makeBy(6, (i) => i + 1)  // [1, 2, 3, 4, 5, 6]

// --- grouping by department ---
const byDept = Array.groupBy(employees, (e) => e.department)
// { Engineering: [Alice, Carol, Eve], Design: [Bob, Dave] } — values are NonEmptyArray

// --- sorting with multiple Orders ---
// Use Order.Number and Order.String (capitalised) for primitive orderings
const sorted = pipe(
  employees,
  Array.sortBy(
    Order.mapInput(Order.Number, (e: Employee) => e.level),
    Order.mapInput(Order.String, (e: Employee) => e.name)
  )
)
// [Dave(l2), Bob(l3), Eve(l3), Alice(l4), Carol(l5)]

// --- partition: split employees by whether salary is in-band ---
// CompBand: level -> { min, max }
const bands: Record<number, { min: number; max: number }> = {
  2: { min:  80_000, max: 100_000 },
  3: { min: 100_000, max: 140_000 },
  4: { min: 130_000, max: 160_000 },
  5: { min: 155_000, max: 200_000 },
}
const [outOfBand, inBand] = Array.partition(employees, (e) => {
  const band = bands[e.level]
  return band && e.baseSalary >= band.min && e.baseSalary <= band.max
    ? Result.succeed(e)
    : Result.fail({ employee: e, band })
})

// --- deduplication ---
const deptList = Array.dedupe(employees.map((e) => e.department))
// ["Engineering", "Design"]  — keeps first occurrence

// --- head/tail safely ---
const head: Option.Option<Employee> = Array.head(employees)
const tailOpt = Array.tail(employees)  // Option.some(rest)
```

Key APIs: make / makeBy / range / replicate, map / flatMap / flatten / filter / filterMap, sort / sortBy / sortWith, groupBy / group / groupWith, partition / separate, dedupe / dedupeWith / dedupeAdjacent, zip / unzip / intersperse, take / drop / span / splitAt / chunksOf, head / last / tail / init, reduce / reduceRight / scan / mapAccum, every / some / contains / findFirst / findLast, getSomes / getSuccesses / getFailures, unfold / cartesian / cartesianWith

> **Tip:** Most collection operators are dual: call `Array.map(arr, fn)` data-first, or `pipe(arr, Array.map(fn))` data-last.

Use for any immutable collection operation on plain arrays — sorting, grouping, deduplicating, partitioning, zipping. Covers ~90% of everyday collection work.

## Chunk

`effect/Chunk` — stable

An immutable ordered sequence with five internal backing shapes: empty, singleton, array, slice (`ISlice`), or concatenation tree (`IConcat`). Two chunks concatenated stay as a tree node — no data is copied at the join. Traversal materializes a non-array backing on demand and caches that readonly array; `Chunk.toArray` then returns a separate mutable copy.

**Mental model.** A balanced rope for arrays. Repeated `Array.appendAll` copies the accumulated array; `Chunk.appendAll` instead joins and rebalances immutable tree nodes without copying every element. That makes repeated concatenation much cheaper, although a join can walk and rebalance part of the tree rather than being strictly O(1). `NonEmptyChunk` mirrors `NonEmptyArray` and satisfies `NonEmptyIterable`.

Use `Array` for most things. Reach for `Chunk` when doing many concatenations (e.g., collecting emitted items from a `Stream`) and deferring materialisation.

```ts
import { Chunk, pipe } from "effect"

// Accumulate employee IDs without copying the whole prefix on every append
let acc = Chunk.empty<string>()
for (const empId of ["e1", "e2", "e3", "e4", "e5"]) {
  acc = Chunk.append(acc, empId)   // balanced tree join
}
const ids = Chunk.toArray(acc)     // ["e1", "e2", "e3", "e4", "e5"] — mutable copy

// Concatenation tree — merge two department chunks without copying
const engIds  = Chunk.make("e1", "e3", "e5")
const dsgIds  = Chunk.make("e2", "e4")
const allIds  = Chunk.appendAll(engIds, dsgIds)  // tree join; no element-by-element copy
console.log(Chunk.size(allIds))                   // 5

// Standard combinators work the same as Array
const seniorIds = pipe(
  Chunk.make(1, 2, 3, 4, 5),     // employee levels
  Chunk.filter((level) => level >= 4),
  Chunk.map((level) => `L${level}`)
)  // Chunk("L4", "L5")

// Stream.runCollect returns a plain Array in Effect 4
import { Stream } from "effect"
const program = pipe(
  Stream.make("e1", "e2", "e3"),
  Stream.map((id) => id.toUpperCase()),
  Stream.runCollect              // Effect<Array<string>>
)
```

Use when accumulating many small pieces and avoiding repeated array copies — especially in stream processing, recursive algorithms, or custom collectors.

## HashMap

`effect/HashMap` — stable

Immutable key-value map backed by a Hash Array Mapped Trie (HAMT). Lookup, insert, and delete are O(log 32 n) — effectively constant for practical sizes. Keys are hashed and compared via Effect's `Equal`/`Hash` protocol — structural equality, not reference equality.

**Mental model.** `HashMap` is to JavaScript's `Map` what `Array` is to a mutable array — same shape, fully immutable, pipe-friendly. Any value implementing `Equal` and `Hash` (including `Data.Class` instances) works as a key; two different objects with the same fields are the same key.

```ts
import { HashMap, Data, Option, pipe } from "effect"

// Data.Class gives structural Equal + Hash automatically.
// Use an Employee value-object as a HashMap key — two instances
// with identical fields are treated as the same key.
class Employee extends Data.Class<{
  readonly id: string
  readonly name: string
  readonly departmentId: string
  readonly level: number
}> {}

const alice1 = new Employee({ id: "e1", name: "Alice", departmentId: "d1", level: 4 })
const alice2 = new Employee({ id: "e1", name: "Alice", departmentId: "d1", level: 4 })
// alice1 !== alice2 by reference, but structurally Equal via Data.Class

// Store per-employee comp-band allocations
let allocations = HashMap.empty<Employee, number>()
allocations = HashMap.set(allocations, alice1, 8_000)  // merit raise amount

// alice2 has the same fields → lookup succeeds even though it's a different instance
console.log(HashMap.get(allocations, alice2))  // Option.some(8000)

// Build a department → merit budget map
const meritBudgets: HashMap.HashMap<string, number> = HashMap.make(
  ["Engineering",  250_000],
  ["Design",       120_000],
  ["Product",       80_000]
)

// Map: apply a 5% uplift to every department budget
const uplifted = pipe(
  meritBudgets,
  HashMap.map((budget) => Math.round(budget * 1.05))
)

// Filter to departments with budget > $100k
const largeBudgets = pipe(
  uplifted,
  HashMap.filter((budget) => budget > 100_000)
)
// HashMap { Engineering: 262500, Design: 126000 }

// Fold into a total merit pool
const totalPool = HashMap.reduce(meritBudgets, 0, (acc, budget) => acc + budget)
// 450000

// Bulk update via mutate (scoped local mutation — still returns immutable)
const updated = HashMap.mutate(meritBudgets, (draft) => {
  HashMap.set(draft, "Legal", 50_000)
  HashMap.remove(draft, "Product")
})
```

> **Tip:** For custom value-object keys, extend `Data.Class` / `Data.TaggedClass` or implement both `[Equal.symbol]` and `[Hash.symbol]`. Equal values must always produce the same hash.

Use when you need an immutable key-value store, especially with value-object keys.

## HashSet

`effect/HashSet` — stable

Immutable set backed by the same HAMT internals as `HashMap`. Membership tests and set-algebraic ops (`union`, `intersection`, `difference`, `isSubset`) use structural `Equal`/`Hash`. Two structurally equal items (same fields, different references) count as one member.

```ts
import { HashSet, Data, pipe } from "effect"

// Track which employees are included in the current merit cycle
class EmployeeRef extends Data.Class<{ id: string }> {}

const cycleA = HashSet.make(
  new EmployeeRef({ id: "e1" }),
  new EmployeeRef({ id: "e2" }),
  new EmployeeRef({ id: "e3" })
)
const cycleB = HashSet.make(
  new EmployeeRef({ id: "e2" }),
  new EmployeeRef({ id: "e3" }),
  new EmployeeRef({ id: "e4" })
)

// Employees in both cycles (reviewed twice — flag for audit)
const inBoth  = HashSet.intersection(cycleA, cycleB)
// HashSet { EmployeeRef("e2"), EmployeeRef("e3") }

// All employees touched by either cycle
const allTouched = HashSet.union(cycleA, cycleB)
// HashSet { e1, e2, e3, e4 }

// Employees only in cycle A (e.g., left before cycle B opened)
const onlyA = HashSet.difference(cycleA, cycleB)
// HashSet { EmployeeRef("e1") }

// Adding a structurally-equal element is a no-op
const deduped = pipe(cycleA, HashSet.add(new EmployeeRef({ id: "e1" })))
console.log(HashSet.size(deduped))  // still 3

// Iterate and collect IDs
const ids = pipe(
  allTouched,
  HashSet.map((ref) => ref.id),
  (set) => Array.from(set)
)
```

Use when you need set semantics (deduplication, union/intersection) on value objects or an immutable `Set`.

## Trie

`effect/Trie` — stable

Immutable prefix tree mapping `string` keys to values. Structurally like `HashMap<string, V>` but with first-class prefix operations: enumerate all keys starting with a given prefix, or find the longest stored key that is a prefix of a query string. Iteration yields `[key, value]` pairs in alphabetical order.

**Mental model.** Autocomplete index, URL router, or command-completion table — any use case where lookups cluster around common prefixes.

```ts
import { Trie, Array as Arr } from "effect"

// Employee-name autocomplete for the HR search box.
// Keys are lowercase full names; values are employee IDs.
const nameTrie = Trie.make(
  ["alice johnson",  "e1"],
  ["alice kim",      "e7"],
  ["bob martin",     "e2"],
  ["carol nguyen",   "e3"],
  ["carlos mendez",  "e9"],
  ["dave patel",     "e4"]
)

// Exact lookup by full name
console.log(Trie.get(nameTrie, "alice johnson"))  // Option.some("e1")

// All names that start with what the user has typed so far
const suggestions = Arr.fromIterable(Trie.keysWithPrefix(nameTrie, "alice"))
// ["alice johnson", "alice kim"]  (alphabetical)

// All entries under "car" — useful for typeahead with result IDs
const carEntries = Arr.fromIterable(Trie.entriesWithPrefix(nameTrie, "car"))
// [["carol nguyen", "e3"], ["carlos mendez", "e9"]]

// Longest-prefix match — find an employee whose name is a prefix of a longer query
const matched = Trie.longestPrefixOf(nameTrie, "carol nguyen (engineering)")
// Option.some(["carol nguyen", "e3"])

// Build an approval-path trie: keys are org-path strings, values are approver IDs
const approvalTrie = Trie.make(
  ["eng",           "vp-eng"],
  ["eng/backend",   "mgr-backend"],
  ["eng/frontend",  "mgr-frontend"],
  ["design",        "vp-design"]
)
const engApprovers = Arr.fromIterable(Trie.keysWithPrefix(approvalTrie, "eng"))
// ["eng", "eng/backend", "eng/frontend"]
```

Key APIs: `map`, `filter`, `filterMap`, `reduce`, `forEach`, `modify`, `insert`, `remove`, `insertMany`, `removeMany`.

Use when keys are strings and prefix-based lookup is a core operation.

## Graph

`effect/Graph` — stable

Typed graph with directed and undirected support, user-defined node and edge data, and algorithms: DFS, BFS, topological sort, Dijkstra's shortest path, cycle detection, connected components, and strongly-connected component decomposition. Nodes identified by `NodeIndex` (allocated number); edges by `EdgeIndex`.

**Mental model.** Create with `Graph.directed(mutate => ...)` or `Graph.undirected(mutate => ...)`. The callback receives a mutable snapshot; the result snaps back to immutable when it returns. For incremental updates, use `Graph.mutate(graph, draft => ...)`.

```ts
import { Graph, Array as Arr } from "effect"

// Model the org reporting hierarchy as a directed graph.
// Nodes hold employee names; edges point from manager to direct report.
const orgGraph = Graph.directed<string, void>((g) => {
  const ceo     = Graph.addNode(g, "CEO")
  const vpEng   = Graph.addNode(g, "VP Engineering")
  const vpDes   = Graph.addNode(g, "VP Design")
  const mgrBe   = Graph.addNode(g, "Mgr Backend")
  const mgrFe   = Graph.addNode(g, "Mgr Frontend")
  const alice   = Graph.addNode(g, "Alice")
  const carol   = Graph.addNode(g, "Carol")
  const bob     = Graph.addNode(g, "Bob")

  Graph.addEdge(g, ceo,   vpEng, undefined)
  Graph.addEdge(g, ceo,   vpDes, undefined)
  Graph.addEdge(g, vpEng, mgrBe, undefined)
  Graph.addEdge(g, vpEng, mgrFe, undefined)
  Graph.addEdge(g, mgrBe, alice, undefined)
  Graph.addEdge(g, mgrBe, carol, undefined)
  Graph.addEdge(g, vpDes, bob,   undefined)
})

// Topological order — valid top-down traversal for approval-chain evaluation
const topo  = Graph.topo(orgGraph)
const order = Arr.fromIterable(Graph.values(topo))
// ["CEO", "VP Engineering", "VP Design", "Mgr Backend", "Mgr Frontend", ...]

// DFS from the CEO node (index 0) — walk the approval chain depth-first
const dfsWalker = Graph.dfs(orgGraph, { start: [0], direction: "outgoing" })
const visited   = Arr.fromIterable(Graph.values(dfsWalker))

// Shortest approval-chain path between two employees.
// Re-build with numeric edge weights (hierarchy levels) for Dijkstra.
const weightedOrg = Graph.directed<string, number>((g) => {
  const ceo   = Graph.addNode(g, "CEO")
  const vpEng = Graph.addNode(g, "VP Engineering")
  const mgr   = Graph.addNode(g, "Mgr Backend")
  const alice = Graph.addNode(g, "Alice")
  Graph.addEdge(g, ceo,   vpEng, 1)
  Graph.addEdge(g, vpEng, mgr,   1)
  Graph.addEdge(g, mgr,   alice, 1)
})

const result = Graph.dijkstra(weightedOrg, {
  source: 0,   // CEO
  target: 3,   // Alice
  cost: (edgeData) => edgeData
})
// Option.some({ path: [0, 1, 2, 3], distance: 3, costs: [1, 1, 1] })

// Sanity check — no circular reporting relationships
console.log(Graph.isAcyclic(orgGraph))  // true

// Export to Mermaid for HR dashboard visualisation
const diagram = Graph.toMermaid(orgGraph, {
  nodeLabel: (name) => name
})
```

- **Traversal** — `dfs`, `bfs`, `dfsPostOrder`, `topo` — all return lazy `NodeWalker` iterators. Traversal accepts a `radius` limit and directed graphs can be explored with `direction: "outgoing" | "incoming" | "undirected"`.

- **Analysis** — `isAcyclic`, `isBipartite`, `connectedComponents`, `stronglyConnectedComponents`

- **Paths** — `dijkstra` for weighted shortest paths with non-negative costs. It returns `Option.none()` when the target is unreachable and throws `GraphError` for a missing endpoint or a cost that is negative or `NaN`. Use `bellmanFord` when negative edge weights are required; negative-cycle detection belongs to that algorithm and `floydWarshall`, not Dijkstra.

- **Composition and sets** — `make(kind)`, `compose`, `intersection`, `difference`, `symmetricDifference`, `complement`, and `sum` build graphs from graphs. `neighborhood(graph, node, { radius, direction })` returns the induced local subgraph. These operations preserve directed/undirected kind and remap node indexes, so do not assume input indexes survive in the result.

- **Export** — `toGraphViz` for DOT format, `toMermaid` for Mermaid diagram syntax — great for org-chart docs and debugging.

Use when modeling relationships — hierarchies, approval chains, dependency graphs, or any domain where connectivity is the core question.

## HashRing

`effect/HashRing` — stable

Weighted consistent-hashing ring. Register nodes (any value implementing `PrimaryKey`), each with an optional weight. Route string keys to nodes via `HashRing.get(ring, key)` (returns `A | undefined`), or precompute a balanced shard distribution with `HashRing.getShards(ring, shardCount)`.

**Mental model.** A sorted number line of 32-bit hash points. Each node gets `weight × baseWeight` virtual points. A lookup binary-searches the insertion position and chooses the nearer of the surrounding points (at an outer boundary it uses the nearest endpoint); it does not always choose the next clockwise point. When a node joins or leaves, nearby keys are the ones most likely to remap. The ring is mutable; `add`/`addMany`/`remove` mutate and return the same instance.

```ts
import { HashRing, PrimaryKey } from "effect"

// Payroll workers — each one processes a shard of the employee population.
// Nodes must implement PrimaryKey (a string identity protocol).
class PayrollWorker implements PrimaryKey.PrimaryKey {
  readonly workerId: string
  readonly region: string
  constructor(workerId: string, region: string) {
    this.workerId = workerId
    this.region = region
  }
  [PrimaryKey.symbol](): string { return this.workerId }
}

const w1 = new PayrollWorker("worker-1", "us-east")
const w2 = new PayrollWorker("worker-2", "us-west")
const w3 = new PayrollWorker("worker-3", "eu-west")

// Create ring with default baseWeight=128 virtual nodes per unit weight
const ring = HashRing.make<PayrollWorker>()
HashRing.addMany(ring, [w1, w2, w3])

// Route any employee ID to the responsible payroll worker
const owner1 = HashRing.get(ring, "employee:e1")  // PayrollWorker | undefined
const owner2 = HashRing.get(ring, "employee:e42") // PayrollWorker | undefined

// Give w1 twice the load — it handles more employees
HashRing.addMany(ring, [w1], { weight: 2 })

// Precompute shard ownership for 256 shards (e.g. for a Cluster entity map)
const shards = HashRing.getShards(ring, 256)
// Array<PayrollWorker> | undefined — shards[i] is the owner of shard i

// Remove a worker (employee keys remap minimally)
HashRing.remove(ring, w3)
```

> **Tip:** Nodes implement `PrimaryKey` via `[PrimaryKey.symbol](): string`.
> Membership and mutation operations (`add`, `addMany`, `has`, and `remove`)
> compare that key, so an equivalent node value targets the same ring member.

Use when distributing work across a dynamic set of nodes where stable key-to-node assignments with minimal remapping are needed.

## Record

`effect/Record` — stable

Pure helpers operating on plain JavaScript objects (`Record<K, V>` / `ReadonlyRecord<K, V>`). Every operation is immutable and returns a new plain object. Provides `map`, `filter`, `filterMap`, `reduce`, `partition`, `collect` (map + collect values into an array), and set operations (`union`, `intersection`, `difference`) over record values.

```ts
import { Record, Result, pipe } from "effect"

// Department merit budgets — a plain Record<string, number>
const budgets: Record<string, number> = {
  Engineering: 250_000,
  Design:      120_000,
  Product:      80_000,
  Legal:        40_000,
}

// Map: compute the per-headcount allocation given headcounts
const headcounts: Record<string, number> = {
  Engineering: 25,
  Design:      12,
  Product:      8,
  Legal:        4,
}
const perHead = Record.map(budgets, (budget, dept) =>
  Math.round(budget / (headcounts[dept] ?? 1))
)
// { Engineering: 10000, Design: 10000, Product: 10000, Legal: 10000 }

// Filter to departments with budgets above $100k
const largeDepts = Record.filter(budgets, (b) => b > 100_000)
// { Engineering: 250000, Design: 120000 }

// Collect to a summary array for a report
const summary = Record.collect(budgets, (dept, budget) =>
  `${dept}: $${budget.toLocaleString()}`
)
// ["Engineering: $250,000", "Design: $120,000", ...]

// Partition: split into under-budget and over-budget departments
// (budget ceiling = $150k)
const [overBudget, withinCeiling] = Record.partition(budgets, (b) =>
  b <= 150_000 ? Result.succeed(b) : Result.fail(b)
)

// Merge approved supplemental budgets (right/combiner wins on conflict)
const supplemental: Record<string, number> = { Engineering: 30_000, Sales: 60_000 }
const merged = Record.union(budgets, supplemental, (base, extra) => base + extra)
// { Engineering: 280000, Design: 120000, Product: 80000, Legal: 40000, Sales: 60000 }

// Keys are typed when possible
const depts: Array<string> = Record.keys(budgets)
```

`Record.fromIterableBy(items, keyOf)` is the concise dual constructor for indexing values by a derived string/symbol key. When assigning a dynamic key into a mutable object, use `Record.assignProperty(target, key, value)`: unlike `target[key] = value`, it safely treats `"__proto__"` as an ordinary own property instead of invoking the legacy prototype setter.

Use when you have a plain object and need to map, filter, or fold its values without writing manual `Object.fromEntries(Object.entries(o).map(...))` chains.

## Tuple

`effect/Tuple` — stable

Typed tuple helpers — construct, pick, omit, evolve, map, rename indices, and build structural `Equivalence` and `Order` for fixed-length tuples. All operations preserve the exact tuple type.

```ts
import { Tuple, Order } from "effect"

// A comp-band snapshot as a tuple: [level, minSalary, maxSalary]
const band = Tuple.make(4, 130_000, 160_000)
// type: readonly [number, number, number]

// Pick or omit positions — extract just the salary range (positions 1 & 2)
const range     = Tuple.pick(band, [1, 2])   // [130000, 160000]
const noLevel   = Tuple.omit(band, [0])       // [130000, 160000]

// Append an element (non-mutating) — attach a currency code
const withCcy = Tuple.appendElement(band, "USD")  // [4, 130000, 160000, "USD"]

// Structural Order — compare bands lexicographically: level first, then min salary
// Use Order.Number (capitalised) for numeric orderings
const BandOrder = Tuple.makeOrder([Order.Number, Order.Number, Order.Number])
console.log(BandOrder([3, 100_000, 130_000], [4, 130_000, 160_000]))  // -1 (level 3 < 4)

// Evolve individual slots with typed transforms
const adjusted = Tuple.evolve(band, [
  undefined,                            // index 0 (level) unchanged
  (min) => Math.round(min * 1.03),      // 3% min uplift
  (max) => Math.round(max * 1.03)       // 3% max uplift
])
// [4, 133900, 164800]
```

Use with fixed-arity tuples for type-safe manipulation — common in codegen outputs, multi-field keys, or zipped pairs.

## Struct

`effect/Struct` — stable

Helpers for typed plain objects: `pick` / `omit` fields, `evolve` individual values, `assign` additional fields, `renameKeys`, and derive structural `Equivalence` and `Order` from per-field comparators. All return new plain objects — no mutation, no class wrapping.

**Mental model.** Object surgery kit. Where `Record` iterates all values homogenously, `Struct` operates on known, typed fields. `evolve` takes a partial transformer map; only listed fields are changed; the rest pass through with correct types preserved.

```ts
import { Struct, Order, Equivalence, pipe } from "effect"

type Employee = {
  readonly id: string
  readonly name: string
  readonly departmentId: string
  readonly level: number
  readonly baseSalary: number
}

const alice: Employee = {
  id: "e1",
  name: "Alice",
  departmentId: "d-eng",
  level: 4,
  baseSalary: 140_000
}

// Pick specific fields — useful when sending to a public API or UI
const publicProfile = Struct.pick(alice, ["id", "name", "level"])
// { id: "e1", name: "Alice", level: 4 }

// Omit salary for a non-confidential export
const nonConfidential = Struct.omit(alice, ["baseSalary"])
// { id: "e1", name: "Alice", departmentId: "d-eng", level: 4 }

// Evolve specific fields — apply a merit increase and a promotion
const promoted = pipe(
  alice,
  Struct.evolve({
    level:      (l) => l + 1,                       // L4 → L5
    baseSalary: (s) => Math.round(s * 1.12)         // 12% raise
  })
)
// { id: "e1", name: "Alice", departmentId: "d-eng", level: 5, baseSalary: 156800 }

// Assign additional fields (like Object.assign but typed and immutable)
const withCycle = Struct.assign(alice, { meritCycle: "2026-Q1" as const })
// { ...alice, meritCycle: "2026-Q1" }

// Rename keys for an external system (e.g. HRIS field names)
const hrisPayload = Struct.renameKeys(alice, {
  id:   "employeeId",
  name: "fullName"
})
// { employeeId: "e1", fullName: "Alice", departmentId: "d-eng", ... }

// Derive structural Equivalence using Equivalence.String and Equivalence.Number
// (capitalised — Equivalence.string does not exist)
const EmployeeEq = Struct.makeEquivalence({
  id:           Equivalence.String,
  name:         Equivalence.String,
  departmentId: Equivalence.String,
  level:        Equivalence.Number,
  baseSalary:   Equivalence.Number,
})
console.log(EmployeeEq(alice, { ...alice }))  // true — same field values

// Derive lexicographic Order: sort employees by level desc, then name asc.
// Use Order.Number and Order.String (capitalised).
const EmployeeOrder = Struct.makeOrder({
  level:      Order.Number,
  name:       Order.String,
})
```

> **Tip:** Use `Struct.evolve` for heterogeneous, known-shape objects where each field has its own transformation; use `Record.map` for homogeneous string-keyed records.

Use to pick, omit, rename, or selectively transform fields on a typed plain object — especially at API boundaries, in mappers, or when building structural comparators.

## Iterable

`effect/Iterable` — stable

Combinators for any value implementing `[Symbol.iterator]` — arrays, strings, generators, sets, custom sequences. Transformations such as `map`, `filter`, and `take` return lazy iterables with no materialization until traversal. Terminal and aggregating operations such as `reduce`, `size`, `groupBy`, and `forEach` traverse eagerly and may allocate their complete result.

```ts
import { Iterable, Option, pipe, Array as Arr } from "effect"

// Generate all salary levels from 1 to infinity, lazily
// Iterable.makeBy(f, options?) — f receives the index; options.length caps it
const allLevels = Iterable.makeBy((n) => n + 1)           // 1, 2, 3, ...
const seniorLevels = Iterable.filter(allLevels, (l) => l >= 4)
const firstThree   = Iterable.take(seniorLevels, 3)
console.log(Arr.fromIterable(firstThree))  // [4, 5, 6]

// Build a vesting schedule: (month, vestedShares) pairs
// Unfold: seed is [month, totalGranted]; emit (month, shares) each step
const vestingSchedule = Iterable.unfold(
  [0, 10_000] as [number, number],
  ([month, remaining]) =>
    month < 48
      ? Option.some([
          [month + 1, Math.round(10_000 * (month + 1) / 48)] as const,
          [month + 1, remaining] as [number, number]
        ] as const)
      : Option.none()
)
const first4Months = Arr.fromIterable(Iterable.take(vestingSchedule, 4))
// [[1, 208], [2, 417], [3, 625], [4, 833]]

// Group employees by department (eager — returns a materialized record of NonEmptyArray)
const employees = [
  { name: "Alice", dept: "Engineering" },
  { name: "Bob",   dept: "Design" },
  { name: "Carol", dept: "Engineering" },
]
const byDept = Iterable.groupBy(employees, (e) => e.dept)
// { Engineering: [Alice, Carol], Design: [Bob] }

// Cartesian product of levels × rating labels — enumerate all comp scenarios
const levels  = [3, 4, 5]
const ratings = ["exceeds", "meets", "below"] as const
const scenarios = Arr.fromIterable(Iterable.cartesian(levels, ratings))
// [[3,"exceeds"],[3,"meets"],[3,"below"],[4,"exceeds"],...]
```

Key APIs: makeBy / range / replicate / repeat / forever, map / flatMap / filter / filterMap, take / takeWhile / drop, zip / zipWith / intersperse, groupBy / group / groupWith, unfold / cartesian / cartesianWith, dedupeAdjacent / dedupeAdjacentWith, getSomes / getSuccesses / getFailures, head / isEmpty / size / forEach / reduce

> **Note:** Iterable-to-iterable transformations preserve lazy traversal. Operations that return a scalar, array, record, map, or set consume the source; consult the return type rather than assuming every `Iterable` function is lazy. Corresponding `Array` transformations work eagerly on materialized arrays.

Use when you want lazy, composable iteration over any sequence without forcing it into an array.

## NonEmptyIterable

`effect/NonEmptyIterable` — stable

Type-level brand: `NonEmptyIterable<A>` extends `Iterable<A>` and carries `readonly [nonEmpty]: A` as a phantom field. Non-emptiness is visible at the type level with zero runtime cost — purely a TypeScript narrowing mechanism.

One runtime helper: `NonEmptyIterable.unprepend`, which safely destructures the head element and the remaining iterator. `NonEmptyChunk` and `NonEmptyArray` both satisfy `NonEmptyIterable`.

```ts
import { NonEmptyIterable, Chunk } from "effect"

// A confirmed non-empty list of employees in a merit cycle
// NonEmptyChunk satisfies NonEmptyIterable
const cycle: Chunk.NonEmptyChunk<string> = Chunk.make("e1", "e2", "e3")

// Safely extract the first employee and the rest — no Option needed
const [firstId, rest]: [string, Iterator<string>] =
  NonEmptyIterable.unprepend(cycle)

console.log(firstId)                                              // "e1"
console.log([...{ [Symbol.iterator]: () => rest }])               // ["e2", "e3"]

// Write a function that requires at least one employee in the cycle
function processLeadEmployee(
  employees: NonEmptyIterable.NonEmptyIterable<string>
): string {
  const [lead] = NonEmptyIterable.unprepend(employees)
  return lead
}
```

Use as a parameter type for functions requiring at least one element; call `unprepend` to safely access the first element without an `Option` dance.
