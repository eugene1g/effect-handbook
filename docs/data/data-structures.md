# Data Structures

Effect's data structure modules share a common design: immutable, `pipe`-first dual APIs, and structural `Equal`/`Hash` throughout. Once familiar with one module, the rest follow the same pattern.

> **Official guides:** [Chunk](https://effect.website/docs/v4/data-types/chunk) (its `unsafeFromArray` heading is a stale name; 4.0.0 spells it `Chunk.fromArrayUnsafe`), [HashSet](https://effect.website/docs/v4/data-types/hash-set), [Equal](https://effect.website/docs/v4/trait/equal). These track Effect's `main` branch rather than the pinned 4.0.0 release, so where they differ, this page and the tagged source win.

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
// partition returns [passes, fails] — matches, then non-matches
const [inBand, outOfBand] = Array.partition(employees, (e) => {
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

**`groupBy` keeps finite keys.** When the key selector returns a literal union, the result type is `Record.ReadonlyRecord.GroupByResult<K, NonEmptyArray<A>>` — every possible key is known and *optional*, because a group with no members is simply absent at runtime. A selector typed `string` still yields an open `Record<string, NonEmptyArray<A>>`. `Iterable.groupBy` is typed the same way.

```ts
import { Array } from "effect"

type Rating = "exceeds" | "meets" | "below"
interface Review {
  readonly employeeId: string
  readonly rating: Rating
}
declare const reviews: ReadonlyArray<Review>

const byRating = Array.groupBy(reviews, (review) => review.rating)
// { readonly exceeds?: NonEmptyArray<Review>; readonly meets?: ...; readonly below?: ... }

const onPlan = byRating.below ?? [] // a rating nobody received has no key
// byRating.outstanding              // type error: the selector can never produce it
```

**Counts are normalised.** Every count argument in `Array`, `Chunk`, `Iterable`, and `String` (`take`, `drop`, `takeRight`, `chunksOf`, `makeBy`, `replicate`, ...) is floored when fractional and treated as `0` when `NaN` or non-positive, so `Array.take(xs, 1.7)` takes one element and `Array.take(xs, NaN)` takes none. Constructors that promise a non-empty result (`makeBy`, `replicate`, `chunksOf`) clamp the count to at least `1`.

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

**Getting data in and out.** Conversion is where accidental copies and accidental sharing happen:

| Direction | Function | Cost and sharing |
| --- | --- | --- |
| In | `Chunk.fromIterable(xs)` | Materialises a non-array iterable once; **an array input is wrapped as-is, not copied**, and a `Chunk` input is returned unchanged |
| In | `Chunk.fromArrayUnsafe(xs)` / `fromNonEmptyArrayUnsafe(xs)` | Wraps the array without copying — the explicit spelling of the same sharing |
| In | `Chunk.make(...)` / `Chunk.of(a)` | Fresh `NonEmptyChunk` |
| Out | `Chunk.toReadonlyArray(chunk)` | Returns the (cached) backing array; no copy once materialised |
| Out | `Chunk.toArray(chunk)` | A mutable copy you own |

**A chunk built from an array aliases that array**, so mutating the source afterwards changes the chunk (`xs[0] = 99` shows up in both forms above). Copy first (`Chunk.fromIterable([...xs])`) when the source outlives the call and may still be written to. Both `toArray` and `toReadonlyArray` keep non-emptiness in the type: a `NonEmptyChunk<A>` converts to a non-empty array type. Chunks compare by value — `Equal.equals(Chunk.make(1, 2), Chunk.make(1, 2))` is `true` — and count arguments (`take`, `drop`, ...) follow the normalisation rule described under [Array](#array).

Use when accumulating many small pieces and avoiding repeated array copies — especially in stream processing, recursive algorithms, or custom collectors.

Official guide: [Chunk](https://effect.website/docs/v4/data-types/chunk) (it says `fromIterable` copies its input; in 4.0.0 that is only true for non-array iterables).

## HashMap

`effect/HashMap` — stable

Immutable key-value map backed by a Hash Array Mapped Trie (HAMT). Lookup, insert, and delete are O(log 32 n) — effectively constant for practical sizes. Keys are hashed and compared via Effect's `Equal`/`Hash` protocol — structural equality, not reference equality.

**Mental model.** `HashMap` is to JavaScript's `Map` what `Array` is to a mutable array — same shape, fully immutable, pipe-friendly. Keys are compared with `Equal.equals`, which in Effect 4 is structural by default: two plain object literals, two arrays, two instances of the same `Data.Class`, or two Schema-decoded structs with the same contents are the same key (a `Data.Class` instance is not equal to a bare literal with the same fields, because prototype keys such as `pipe` take part in the comparison). Reach for a custom `[Equal.symbol]` / `[Hash.symbol]` only when identity should be a *subset* of the fields.

```ts
import { HashMap, Data, Option, pipe } from "effect"

// Use an Employee value-object as a HashMap key — two instances with identical
// fields are the same key. `Data.Class` is used here for the constructor and
// `.pipe`; two plain `{ id, name, ... }` literals would dedupe the same way.
class Employee extends Data.Class<{
  readonly id: string
  readonly name: string
  readonly departmentId: string
  readonly level: number
}> {}

const alice1 = new Employee({ id: "e1", name: "Alice", departmentId: "d1", level: 4 })
const alice2 = new Employee({ id: "e1", name: "Alice", departmentId: "d1", level: 4 })
// alice1 !== alice2 by reference, but Equal.equals(alice1, alice2) is true

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

> **Tip:** Plain objects already work as keys. Implement both `[Equal.symbol]` and `[Hash.symbol]` (see [Equal](./functional-toolkit#equal)) when only some fields define identity, and keep the law: equal values must always produce the same hash.

> **Warning:** Hashes are cached per object, so **a key must not change after it has been hashed**. Mutating a field of an object that is already a `HashMap` key or `HashSet` member strands the entry: a structurally equal lookup no longer finds it. Treat anything you put in a hash collection as frozen.

Use when you need an immutable key-value store, especially with value-object keys.

## HashSet

`effect/HashSet` — stable

Immutable set backed by the same HAMT internals as `HashMap`. Membership tests and set-algebraic ops (`union`, `intersection`, `difference`, `isSubset`) use structural `Equal`/`Hash`. Two structurally equal items (same fields, different references) count as one member.

**Structural membership needs no wrapper.** Plain object literals — and therefore values decoded from a `Schema.Struct` — dedupe on their own; a native `Set` does not, because it ignores `Equal` and compares references. The flip side: *every* enumerable field participates, so an incidental field (a request id, a fetched-at timestamp) makes two records of the same entity distinct. When identity is narrower than the shape, project to the identifying fields first or give the class a custom `Equal`/`Hash`.

```ts
import { HashSet } from "effect"

// Native Set compares references; HashSet compares structure
const nativeSize = new Set([{ id: "e1" }, { id: "e1" }]).size             // 2
const hashSetSize = HashSet.size(HashSet.make({ id: "e1" }, { id: "e1" })) // 1

// An incidental field defeats dedupe — every enumerable field counts
const withNoise = HashSet.make(
  { id: "e1", requestId: "r-1" },
  { id: "e1", requestId: "r-2" }
)
const noisySize = HashSet.size(withNoise) // 2
```

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

Key APIs: empty / make / fromIterable, add / remove / has, union / intersection / difference / isSubset, map / filter / some / every / reduce, size / isEmpty

**Immutable or mutable?** `HashSet` returns a new set per change, which makes it safe to share across fibers, keep in a `Ref`, or return from a function. [MutableHashSet](../concurrency/state-mutable-references#mutablehashset) updates in place and is the cheaper choice for building a set inside one synchronous loop. Converting to an array (`Array.from(set)`) copies every element, so do it once at the boundary, not inside a hot loop.

Use when you need set semantics (deduplication, union/intersection) on value objects or an immutable `Set`.

Official guides: [HashSet](https://effect.website/docs/v4/data-types/hash-set), [Equal](https://effect.website/docs/v4/trait/equal).

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
// [["carlos mendez", "e9"], ["carol nguyen", "e3"]]  (alphabetical: "carl" < "caro")

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

Typed graph with directed and undirected support, user-defined node and edge data, and a broad algorithm set: DFS/BFS/topological traversal, shortest paths (Dijkstra, A*, Bellman-Ford, Floyd-Warshall), path enumeration, cycle witnesses, connectivity analysis, minimum spanning forests, transitive reduction, bipartite matching, and maximum flow / minimum cut. Nodes identified by `NodeIndex` (allocated number); edges by `EdgeIndex`.

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
// Option.some({ path: [0, 1, 2, 3], edges: [0, 1, 2], distance: 3, costs: [1, 1, 1] })

// Sanity check — no circular reporting relationships
console.log(Graph.isAcyclic(orgGraph))  // true

// Export to Mermaid for HR dashboard visualisation
const diagram = Graph.toMermaid(orgGraph, {
  nodeLabel: (name) => name
})
```

- **Traversal** — `dfs`, `bfs`, `dfsPostOrder`, `topo` — all return lazy `NodeWalker` iterators. Traversal accepts a `radius` limit and directed graphs can be explored with `direction: "outgoing" | "incoming" | "undirected"`. `externals(graph, { direction })` walks the sources or sinks.

- **Local queries** — `neighbors` / `successors` / `predecessors` for adjacent nodes; `incidentEdges`, `outgoingEdges`, `incomingEdges`, and `edgesBetween(graph, source, target)` for edge indexes (parallel edges are all returned); `degree` for undirected graphs and `inDegree` / `outDegree` for directed ones.

- **Reachability and connectivity** — `hasPath(graph, source, target, { direction })` answers yes/no without building a path; `unweightedDistances(graph, source)` returns a `Map` of hop counts. Whole-graph predicates are kind-specific: `isConnected` and `isTree` (undirected), `isWeaklyConnected` and `isStronglyConnected` (directed). The partitions behind them are `connectedComponents`, `weaklyConnectedComponents`, and `stronglyConnectedComponents`; `bridges`, `articulationPoints`, and `biconnectedComponents` find the single points of failure of an undirected graph.

- **Cycles** — `isAcyclic` is the boolean check; `findCycle` returns `Option<{ path, edges }>`, a concrete witness whose `path` repeats its first node at the end. Use the witness in an error message instead of reporting "there is a cycle somewhere". `isBipartite` checks two-colorability of an undirected graph.

- **Paths** — `dijkstra` for weighted shortest paths with non-negative costs, `astar` when a heuristic can guide the search, `bellmanFord` when costs may be negative, `floydWarshall` for all pairs. A `PathResult` is `{ path, edges, distance, costs }`: node indexes, the traversed **edge indexes**, the numeric total, and the original edge data along the route. All of them return `Option.none()` (or `Infinity` / `null` entries for `floydWarshall`) when the target is unreachable. `simplePaths(graph, { source, target, limit })` lazily enumerates loop-free routes and `allShortestPaths(graph, { source, target, cost, limit })` enumerates every route tied for the minimum; both return an iterable `PathWalker`, and because the number of simple paths can be exponential, **pass a `limit` unless the graph is known to be small**.

- **Optimisation** — `minimumSpanningForest(graph, cost)` (undirected, Kruskal; disconnected inputs give a forest), `transitiveReduction(dag)` (drops every edge implied by a longer route), `maximumBipartiteMatching(graph)` (largest set of disjoint pairs, as `{ left, right, edge }`), and `maximumFlow` / `minimumCut` (`{ source, target, capacity }` on a directed graph; `maximumFlow` reports per-edge flows, `minimumCut` the crossing edges plus the node partition on each side).

- **Composition and sets** — `make(kind)`, `compose`, `intersection`, `difference`, `symmetricDifference`, `complement`, and `sum` build graphs from graphs. `neighborhood(graph, node, { radius, direction })` returns the local subgraph around a node. These operations preserve directed/undirected kind and remap node indexes, so do not assume input indexes survive in the result. **`inducedSubgraph(graph, nodeIndexes)`, `minimumSpanningForest`, and `transitiveReduction` are the index-preserving exceptions**: surviving nodes and edges keep their original indexes, so results can be joined back to the source graph.

- **Bulk mutation** — inside `Graph.mutate`, `removeNodes(draft, indexes)` and `removeEdges(draft, indexes)` delete in one pass; missing and duplicate indexes are ignored, and removing a node removes its incident edges. A callback that is *transforming* a graph (`mapNodes`, `filterEdges`, ...) may not mutate that same graph — doing so throws `GraphError`.

- **Snapshots** — `Graph.toSnapshot(graph)` produces plain data `{ type, nodes: [{ index, data }], edges: [{ index, source, target, data }] }` and `Graph.fromSnapshot(snapshot)` rebuilds an equal graph with the *same* indexes (`Equal.equals` holds across the round trip). This is the persistence and wire shape; `Schema.Graph(kind, nodeSchema, edgeSchema)` is the matching codec. `fromSnapshot` throws `GraphError` for out-of-order indexes or an edge whose endpoint is missing. `toJSON()` is an inspection summary, not this format.

- **Export** — `toGraphViz` for DOT format, `toMermaid` for Mermaid diagram syntax — great for org-chart docs and debugging.

- **Typing a parameter** — accept any immutable graph as `Graph.Graph<N, E, Graph.Kind>`. There is no separate `Graph.Proto` interface to name.

> **Warning:** Graph functions are synchronous and **throw** `Graph.GraphError` (a `Data.TaggedError`) instead of returning it: a missing node index, a kind mismatch (`degree` on a directed graph, `maximumFlow` on an undirected one), a negative or `NaN` Dijkstra cost, arithmetic that leaves the finite number range, or a negative cycle that affects the `bellmanFord` target (`floydWarshall` rejects any negative cycle). `Option.none()` is reserved for "unreachable". At an Effect boundary, wrap the call in `Effect.try` and keep the `GraphError` as a typed failure.

### Witnesses, reductions, and matchings

```ts
import { Array as Arr, Effect, Equal, Graph, Option } from "effect"

// Payroll-run steps; an edge means "must finish before"
const steps = Graph.directed<string, void>((g) => {
  const lock  = Graph.addNode(g, "lock-timesheets") // 0
  const gross = Graph.addNode(g, "compute-gross")   // 1
  const tax   = Graph.addNode(g, "compute-tax")     // 2
  const net   = Graph.addNode(g, "compute-net")     // 3
  Graph.addEdge(g, lock,  gross, undefined) // edge 0
  Graph.addEdge(g, gross, tax,   undefined) // edge 1
  Graph.addEdge(g, tax,   net,   undefined) // edge 2
  Graph.addEdge(g, gross, net,   undefined) // edge 3 — implied by 1 + 2
  Graph.addEdge(g, lock,  net,   undefined) // edge 4 — implied by 0 + 1 + 2
})

// Reachability without building a path
const netNeedsLock = Graph.hasPath(steps, 0, 3)                                  // true
const upstreamOfNet = Graph.hasPath(steps, 3, 0, { direction: "incoming" })      // true
const fanIn = Graph.inDegree(steps, 3)                                           // 3

// Keep only the edges that carry information; surviving edges keep their indexes
const minimal = Graph.transitiveReduction(steps)
const keptEdges = Graph.toSnapshot(minimal).edges.map((edge) => edge.index)      // [0, 1, 2]

// Every loop-free route, lazily — bound it
const routes = Arr.fromIterable(Graph.simplePaths(steps, { source: 0, target: 3, limit: 10 }))
// 3 routes; routes[0] = { path: [0, 1, 2, 3], edges: [0, 1, 2], distance: 3, costs: [...] }

// A cycle comes back as a witness you can print
const broken = Graph.mutate(steps, (g) => {
  Graph.addEdge(g, 3, 0, undefined) // edge 5: compute-net -> lock-timesheets
})
const witness = Graph.findCycle(broken)
// Option.some({ path: [0, 1, 2, 3, 0], edges: [0, 1, 2, 5] })
const describeCycle = Option.map(witness, ({ path }) =>
  path.map((index) => Option.getOrElse(Graph.getNode(broken, index), () => "?")).join(" -> ")
)

// Snapshots round-trip with identical indexes
const restored = Graph.fromSnapshot(Graph.toSnapshot(steps))
const sameGraph = Equal.equals(restored, steps) // true

// Calibration: pair each reviewer with one employee they are allowed to review
const eligibility = Graph.undirected<string, void>((g) => {
  const ana = Graph.addNode(g, "reviewer:ana") // 0
  const ben = Graph.addNode(g, "reviewer:ben") // 1
  const e1  = Graph.addNode(g, "employee:e1")  // 2
  const e2  = Graph.addNode(g, "employee:e2")  // 3
  Graph.addEdge(g, ana, e1, undefined)
  Graph.addEdge(g, ana, e2, undefined)
  Graph.addEdge(g, ben, e1, undefined)
})
const pairs = Graph.maximumBipartiteMatching(eligibility)
// [{ left: 0, right: 3, edge: 1 }, { left: 1, right: 2, edge: 2 }] — everyone is covered

// GraphError is thrown, so give it a typed channel at the Effect boundary
const reduceSafely = (graph: Graph.Graph<string, void, "directed">) =>
  Effect.try({
    try: () => Graph.transitiveReduction(graph),
    catch: (error) =>
      error instanceof Graph.GraphError ? error : new Graph.GraphError({ message: String(error) })
  })
const rejected = reduceSafely(broken) // fails with GraphError: "Cannot transitively reduce cyclic graph"
```

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

`get` and `getShards` answer different questions. `get(ring, key)` is a pure nearest-point lookup. `getShards(ring, count)` builds a *balanced* table: each node is capped at its weight's share of `count` (at least one shard), and shards whose nearest node is already full spill to the next eligible node — so a shard's owner is not always the node `get` would pick for the same hash. Both return `undefined` for an empty ring. `count` is normalised like other Effect counts: fractions are floored, and `NaN` or a non-positive value yields an empty array.

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
// (budget ceiling = $150k). partition returns [passes, fails].
const [withinCeiling, overBudget] = Record.partition(budgets, (b) =>
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

`Tuple.evolve` types each slot from its transform: a slot whose transform is `undefined` keeps its element type, and a slot whose transform *may* be `undefined` at the type level (an optional function) is typed as the union of the transformed and the original element, matching what happens at runtime.

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

// Derive lexicographic Order: sort employees by level, then by name (both ascending;
// wrap a field's Order in Order.flip for descending).
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

`Iterable.groupBy` shares `Array.groupBy`'s typing: a literal-union key selector yields a record whose known keys are optional (see [Array](#array)), and count arguments such as `take(n)` and `drop(n)` are normalised the same way.

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
