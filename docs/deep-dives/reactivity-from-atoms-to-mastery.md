# Reactivity — From Atoms to Mastery

A source-grounded tour of Effect 4's reactive state layer — the same primitives that power TanStack-Query-style data fetching, SSR hydration, and fine-grained UI state, but built natively on Effects, Streams, Layers, scopes, and typed errors.

This guide shares the handbook's **2026-08-12** audit target, `effect@4.0.0-rc.108`. The reactivity APIs are under `unstable/`, so pin compatible package versions and re-audit before upgrading.

For a compact module-by-module API reference, use the [Reactivity & Atom handbook topic](../systems/reactivity-atom). This deep dive repeats only the details needed to connect those modules into an application-level mental model.

**Choose a path:** start with the [mental model](#orientation-mental-model), jump to [read/write invalidation](#reactivity-atom), focus on [SSR hydration](#hydration-ssr) or [React bindings](#atomreact-react-bindings), or go straight to the [complete Todos feature](#mastery-capstone).

## Orientation & mental model

Before any API: hold two worlds in your head. You already live in the first one.

1.  **① Effect world** — Pure *descriptions*: `Effect`, `Stream`, `Layer`. Nothing runs until executed. You write these already.
2.  **② Atom graph** — A lazy dependency graph of *reactive values*. An `Atom` describes how to produce/refresh one cell of state.
3.  **③ Registry** — The live *runtime*. `AtomRegistry` runs atom reads, memoises values, tracks deps, runs Effects, and disposes the unused.
4.  **④ View** — Framework bindings subscribe to atoms in a registry: React hooks, Solid accessors, and Vue composables. SSR state crosses the boundary through Hydration.

Reactive state libraries you know — Jotai, Recoil, Zustand, TanStack Query — solve "derive values, cache async data, re-render on change." Effect 4's core reactivity modules put those graph and data-fetching primitives beside **Effect** and **Stream**, while satellite packages bind them to React, Solid, and Vue. Nodes can therefore inherit structured concurrency, interruption, typed errors, retries, and `Layer`-provided dependencies inside the state graph.

### The cast of characters

| Module | What it is | Lives in |
| --- | --- | --- |
| `Reactivity` | Key-based pub/sub invalidation service. The wiring that says "this write affects these reads." | `effect/unstable/reactivity` |
| `Atom` | A description of one reactive value — static, derived, Effect-backed, or Stream-backed. | `effect/unstable/reactivity` |
| `AtomRegistry` | The runtime store that holds atom state, deps, subscriptions, and lifecycle. | `effect/unstable/reactivity` |
| `AsyncResult` | `Initial \| Success \| Failure` (+ `waiting`) — the shape every async atom yields. | `effect/unstable/reactivity` |
| `AtomRef` | Standalone synchronous observable cells (no registry). Fine-grained local mutable state. | `effect/unstable/reactivity` |
| `Hydration` | `dehydrate`/`hydrate` serializable atoms for SSR. | `effect/unstable/reactivity` |
| `AtomHttpApi` | Typed HttpApi clients exposed as query and mutation atoms. | `effect/unstable/reactivity` |
| `AtomRpc` | Typed unary and streaming RPC clients exposed as atoms. | `effect/unstable/reactivity` |
| `AtomReact` | React hooks, provider, Suspense, and hydration boundary. | `@effect/atom-react` |

### Imports you'll use everywhere

**import surface**

```ts
// These six foundational namespaces are under the core package. The same
// barrel also exports AtomHttpApi and AtomRpc integrations.
import {
  Atom,
  AtomRef,
  AtomRegistry,
  AsyncResult,
  Reactivity,
  Hydration,
} from "effect/unstable/reactivity"

// The React bindings ("AtomReact") are a sibling package:
import {
  RegistryProvider,
  useAtom,
  useAtomValue,
  useAtomSet,
  useAtomSuspense,
  HydrationBoundary,
} from "@effect/atom-react"
```

> **Caution:** These modules live under `unstable/` and can change between releases. This guide describes the audited target above.

> **Takeaway:** An **Atom is a value, not a hook**. Define atoms once at module scope. They are inert descriptions; a **Registry** brings them to life. This separation is what makes them testable, server-renderable, and shareable across frameworks.

## Reactivity — the foundation

Start at the bottom. `Reactivity` is a tiny service that does one thing: connect *writes* to dependent *reads* by key. It stores **no values** itself — it just remembers "who cares about key K" and fires them when K is invalidated.

Everything *key-reactive* in this layer bottoms out here: atoms that auto-refresh on a mutation, SQL queries that refetch after an insert, and typed-client invalidation. Ordinary writable/derived atom dependencies are tracked separately by `AtomRegistry`'s graph.

### The service surface

**Reactivity.ts**

```ts
import type { Effect, Queue, Scope, Stream } from "effect"

// Reactivity is a Context.Service. Its methods (paraphrased):
interface ReactivityService {
  // imperative register/fire (no Effect, no scope):
  registerUnsafe(keys: Keys, handler: () => void): () => void  // returns unregister
  invalidateUnsafe(keys: Keys): void

  // effectful equivalents:
  invalidate(keys: Keys): Effect.Effect<void>
  mutation<A, E, R>(keys: Keys, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>  // invalidate AFTER success
  query<A, E, R>(keys: Keys, effect: Effect.Effect<A, E, R>): Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope>
  stream<A, E, R>(keys: Keys, effect: Effect.Effect<A, E, R>): Stream.Stream<A, E, Exclude<R, Scope.Scope>>
  withBatch<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>  // coalesce invalidations
}

// Keys are either a flat array, or a record of "table -> ids":
type Keys = ReadonlyArray<unknown> | Readonly<Record<string, ReadonlyArray<unknown>>>
//   ["todos"]                 -> coarse, whole-collection key
//   { todos: [id1, id2] }     -> fires the "todos" key AND "todos:id1", "todos:id2"
```

### The whole idea in one program

**register + invalidate**

```ts
import { Effect } from "effect"
import { Reactivity } from "effect/unstable/reactivity"

const program = Effect.gen(function* () {
  const reactivity = yield* Reactivity.Reactivity

  // someone reading the "users" collection registers interest:
  const unregister = reactivity.registerUnsafe(["users"], () => {
    console.log("users changed — re-run my read")
  })

  // ...elsewhere, a write happens and announces it:
  reactivity.invalidateUnsafe(["users"]) // -> logs "users changed — re-run my read"

  unregister()
})

program.pipe(Effect.provide(Reactivity.layer), Effect.runFork)
```

### Mutations and queries

The effectful combinators are the ergonomic surface. `mutation` wraps a write so its keys are invalidated *only on success*. `query` turns a read into a live `Queue` that re-emits whenever its keys change. The registration is torn down automatically when the surrounding `Scope` closes.

**mutation + query (pipeable accessors)**

```ts
import { Effect, Queue } from "effect"
import { Reactivity } from "effect/unstable/reactivity"

// a write that invalidates ["todos"] after it succeeds:
const addTodo = (text: string) =>
  Reactivity.mutation(insertTodo(text), ["todos"])
//  Effect<Todo, E, Reactivity | DbR>

// a live read keyed on ["todos"]:
const watchTodos = Effect.gen(function* () {
  const queue = yield* Reactivity.query(listTodos, ["todos"])
  while (true) {
    const todos = yield* Queue.take(queue) // initial value, then every refresh
    console.log("todos now:", todos.length)
  }
}) // requires Reactivity + Scope

// run a batch of writes, fire each invalidation once at the end:
const importMany = Reactivity.Reactivity.pipe(
  Effect.flatMap((r) => r.withBatch(Effect.all([addTodo("a"), addTodo("b")])))
)
```

> **Source note:** `Reactivity` stringifies string, number, bigint, and boolean keys and hashes other values with `Hash.hash`. The record form `{ todos: [id] }` expands to both the table key `todos` and each `todos:id` key. Use that expansion for mutations; register detail reads directly on `` `todos:${id}` `` when they must avoid unrelated row invalidations. Query reruns are serialized: while one run is active, repeated invalidations coalesce into at most one pending rerun.

> **Takeaway:** You rarely call `Reactivity` directly in app code. It reappears below as the engine behind `Atom.withReactivity` and `reactivityKeys` — but understanding "keys connect writes to reads, no value caching" makes the rest click.

## Atom — reactive values

An `Atom<A>` is a description of one reactive value. Three flavours to start: a writable *state cell*, a *derived* computation, and (next chapters) Effect/Stream-backed atoms.

**Atom.ts — the basics**

```ts
import { Atom } from "effect/unstable/reactivity"

// 1. A writable state cell — like useState, but defined ONCE at module scope:
const count = Atom.make(0)                       // Atom.Writable<number>

// 2. A derived atom. The `get` function reads other atoms and, by reading them,
//    declares them as dependencies. Re-runs automatically when they change:
const double = Atom.make((get) => get(count) * 2) // Atom<number>

// 3. Derived atoms compose — depend on as many atoms as you like:
const summary = Atom.make((get) => `count=${get(count)} double=${get(double)}`)
```

That's the entire surface for pure state: `Atom.make(value)` for a source of truth, `Atom.make((get) => ...)` for anything derived. The dependency graph is implicit — reading an atom inside a `read` function subscribes to it. No dependency arrays.

### The `get` context is richer than it looks

The `get` passed to a read function is an `AtomContext`. Beyond `get(atom)` it can read without subscribing, await async atoms, manage its own lifecycle, and even write:

**AtomContext powers**

```ts
import { Effect, Option } from "effect"
import { Atom } from "effect/unstable/reactivity"

const a = Atom.make(1)
const b = Atom.make(2)
const c = Atom.make(3)
const other = Atom.make(4)
const asyncAtom = Atom.make(Effect.succeed(5))
const optionAtom = Atom.make(Option.some(6))
const action = Atom.fn((input: number) => Effect.succeed(input))

const derived = Atom.make((get) => {
  get(a)                    // read + subscribe (re-run when `a` changes)
  get.once(b)               // read WITHOUT subscribing (snapshot, no re-run)
  get.self<number>()        // Option of this atom's previous value
  get.setSelf(123)          // push a new value for THIS atom (async sources use this)
  get.addFinalizer(() => {}) // cleanup when this atom is disposed/refreshed
  get.mount(other)          // keep `other` alive for this atom's lifetime
  get.subscribe(c, (v) => {/* side-effect on change */})
  get.refresh(other)        // request recomputation of another atom
  get.refreshSelf()         // request recomputation of this atom
  const awaited = get.result(asyncAtom)       // Effect that awaits success
  const snapshot = get.resultOnce(asyncAtom)  // same, without subscribing
  const some = get.some(optionAtom)            // Effect that awaits Some
  const someSnapshot = get.someOnce(optionAtom)
  const changes = get.stream(other)            // Stream of registry values
  const successes = get.streamResult(asyncAtom)
  const actionResult = get.setResult(action, 7) // Effect that writes and awaits success when run
  void [awaited, snapshot, some, someSnapshot, changes, successes, actionResult]
  get.registry              // the active AtomRegistry
  return get(a) + get.once(b)
})
```

### Lifecycle flags (preview)

Every atom carries `lazy` and `keepAlive` metadata, tunable with copy-combinators. We'll use them properly once the registry is in play:

**combinators (copy-on-write)**

```ts
import { Atom } from "effect/unstable/reactivity"

const a = Atom.make(0).pipe(Atom.keepAlive)               // never auto-disposed
const b = Atom.make(0).pipe(Atom.setIdleTTL("30 seconds")) // dispose 30s after last use
const c = Atom.make(0).pipe(Atom.withLabel("myCounter"))   // debug label
const d = Atom.make((get) => get(a)).pipe(Atom.map((n) => n + 1)) // map a value
const e = Atom.make({ x: 0, y: 0 }).pipe(
  Atom.withEquality<{ x: number; y: number }>(
    (left, right) => left.x === right.x && left.y === right.y,
  )
)
```

> **Source note:** `Atom.make` is heavily overloaded. With a plain value it returns `Writable<A>`; with a function it returns a derived `Atom<A>`; with an `Effect` or `Stream` it returns `Atom<AsyncResult<A,E>>` (chapters 4–5). `autoDispose` undoes `keepAlive`, `setLazy` controls eager rebuilding while mounted, and `withEquality` replaces the default `Object.is` comparison so comparator-equal values do not notify listeners or dependents.

> **Caution:** An atom by itself does nothing — `double` above has never computed anything. It has no value until a **registry** reads it. That's next.

## AtomRegistry — the runtime

The registry is where atoms come alive. It stores each atom's current value in a *node*, wires up the dependency graph, runs Effects, notifies subscribers, and garbage-collects atoms nobody is using.

**AtomRegistry.ts — read / write / subscribe**

```ts
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

const count = Atom.make(0)
const double = Atom.make((get) => get(count) * 2)

const registry = AtomRegistry.make()

registry.get(double)            // 0   — computed on demand
registry.set(count, 5)
registry.get(double)            // 10  — recomputed because `count` changed

// subscribe returns an unsubscribe function; immediate delivery is opt-in:
const cancel = registry.subscribe(
  double,
  (v) => console.log("double =", v),
  { immediate: true },
)
registry.set(count, 10)         // logs "double = 20"
cancel()

// other writes:
registry.update(count, (n) => n + 1)
registry.modify(count, (n) => [`was ${n}`, n + 1]) // [returnValue, nextValue]
registry.refresh(double)        // force recomputation
```

### Lifecycle & garbage collection

This is the part that surprises people. Atoms are **lazy** and **auto-disposed** by default. If nothing subscribes to (or mounts) an atom, the registry drops its node after an idle tick — and the next read rebuilds it from its definition.

**GC behaviour (from the test suite)**

```ts
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

const counter = Atom.make(0)
const r = AtomRegistry.make()

r.set(counter, 1)
r.get(counter)                  // 1
await new Promise((res) => setTimeout(res)) // one idle tick passes
r.get(counter)                  // 0  ← node was disposed, rebuilt from initial!

// Keep state across idle periods when you need persistence:
const kept = Atom.make(0).pipe(Atom.keepAlive)
// ...or hold it explicitly for a scope:
const release = r.mount(kept)   // mounted => never idle-disposed
// release() later
```

> **Source note:** Auto-dispose keeps memory bounded automatically: a per-route data atom evaporates when you navigate away. Reach for `keepAlive` / `setIdleTTL` / `mount` only for state that must outlive its subscribers (a session, a cache you want warm).

### The Node

Each atom maps to a `Node` exposing `value()`, `Set`-backed `parents`, `children`, and `listeners`, plus `currentState()` → `"uninitialized" | "stale" | "valid" | "removed"`. You rarely touch nodes directly, but Hydration walks them. Dependency tracking remains intact when a node is invalidated during a batched rebuild.

### Registry as a Layer + the service accessors

The registry is also a `Context.Service`, so you can read/write atoms from inside ordinary Effects. `Atom.get`, `Atom.set`, `Atom.refresh`, `Atom.getResult` etc. all require the `AtomRegistry` service:

**registry as a service**

```ts
import { Effect } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

const count = Atom.make(0)

const program = Effect.gen(function* () {
  yield* Atom.set(count, 42)
  return yield* Atom.get(count)            // requires AtomRegistry
})

program.pipe(
  Effect.provide(AtomRegistry.layer),      // a fresh registry, disposed with the scope
  Effect.runPromise,
)
```

> **Source note:** `AtomRegistry.make({ initialValues, scheduleTask, timeoutResolution, defaultIdleTTL })` tunes scheduling and GC. `initialValues` pre-seeds atoms — the hook React's `RegistryProvider` and test setups use to inject values/layers.

> **Takeaway:** One registry = one isolated world of state. Make one per server request (SSR), one per React tree (the provider), one per test. Atoms are shared definitions; registries are the instances.

## AsyncResult — async state

The moment an atom is backed by an `Effect` or `Stream`, its value is an `AsyncResult<A, E>`. This is the data type that makes loading/error/stale UI states first-class.

**AsyncResult.ts — the shape**

```ts
import type { AsyncResult } from "effect/unstable/reactivity"

// The exact exported union has three variants, and every one carries `waiting`:
type State<A, E = never> = AsyncResult.AsyncResult<A, E>
// AsyncResult.Initial<A, E>  — never asked yet
// AsyncResult.Success<A, E>  — { value, timestamp, waiting }
// AsyncResult.Failure<A, E>  — { cause, previousSuccess, waiting }

// `waiting` is orthogonal to the variant: a Success can be `waiting: true`
// (you have data AND a refresh is in-flight) — that's stale-while-revalidate baked in.
```

This two-axis design (variant × waiting) is the whole trick. A refresh doesn't throw away your data — it flips `waiting` to `true` on the existing `Success`, so your UI can show data *and* a spinner without bespoke state machines.

### Constructors & guards

**constructing / inspecting**

```ts
import { AsyncResult } from "effect/unstable/reactivity"

const r = AsyncResult.success<number, Error>(42)
const fallback = 0

AsyncResult.initial<number, Error>()        // Initial
AsyncResult.success(42)                       // Success(42)
AsyncResult.fail(new Error("boom"))           // Failure(typed error)
AsyncResult.waiting(AsyncResult.success(42))  // Success(42), waiting: true

AsyncResult.isInitial(r); AsyncResult.isSuccess(r); AsyncResult.isFailure(r)
AsyncResult.isWaiting(r)                       // true for any waiting variant

AsyncResult.value(r)                           // Option<A>
AsyncResult.getOrElse(r, () => fallback)
AsyncResult.map(r, (a) => a + 1)               // map success channel
AsyncResult.flatMap(r, (a) => AsyncResult.success(a * 2))
```

### Rendering: `match`, `matchWithWaiting`, and the fluent `builder`

Three idioms, increasing in power. `match` is the exhaustive 3-way switch. `matchWithWaiting` collapses `Initial` + `waiting` into one "loading" branch and splits failures into typed errors vs. defects — usually what a UI wants:

**matchers**

```ts
import { Data } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"

class LoadError extends Data.TaggedError("LoadError")<{}> {}
const result: AsyncResult.AsyncResult<ReadonlyArray<number>, LoadError> =
  AsyncResult.success([])

// exhaustive 3-way
const label = AsyncResult.match(result, {
  onInitial: () => "idle",
  onFailure: (f) => `failed`,
  onSuccess: (s) => `value: ${s.value}`,
})

// UI-shaped: loading vs typed error vs defect vs success
const ui = AsyncResult.matchWithWaiting(result, {
  onWaiting: () => "Loading…",
  onError:   (e) => `Error: ${e.message}`,   // your typed E
  onDefect:  (d) => `Unexpected: ${d}`,      // squashed non-error cause
  onSuccess: (s) => `Loaded ${s.value.length} rows`,
})
```

The `builder` is a type-tracked fluent renderer: the compiler only exposes `.exhaustive()` once every possible case is handled, and it has tag-aware helpers like `.onErrorTag`:

**AsyncResult.builder**

```ts
import { Data } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"

class NotFoundError extends Data.TaggedError("NotFoundError")<{ id: string }> {}
class PermissionError extends Data.TaggedError("PermissionError")<{}> {}
declare const result: AsyncResult.AsyncResult<ReadonlyArray<number>, NotFoundError | PermissionError>

const rendered = AsyncResult.builder(result)
  .onInitial(() => "—")
  .onWaiting(() => "Loading…")
  .onErrorTag("NotFoundError", (e) => `Missing ${e.id}`) // narrow by _tag
  .onError((e) => `Error: ${e}`)
  .onDefect((d) => `Crash: ${d}`)
  .onSuccess((value) => `Got ${value.length}`)
  .orElse(() => "unreachable")     // or .exhaustive() once all cases are covered
```

### Combining several results

**AsyncResult.all**

```ts
import { AsyncResult } from "effect/unstable/reactivity"

const userResult = AsyncResult.success({ id: 1 })
const settingsResult = AsyncResult.success({ theme: "dark" })
const prefsResult = AsyncResult.success({ compact: true })

// First non-success short-circuits; if all succeed you get a Success of the tuple/record,
// marked `waiting` if any input was waiting:
const combined = AsyncResult.all([userResult, settingsResult] as const)
const named = AsyncResult.all({ user: userResult, prefs: prefsResult })
```

> **Takeaway:** `AsyncResult` ≈ a typed `RemoteData` with a stale flag. You won't usually construct it by hand — atoms produce it — but mastering `matchWithWaiting`/`builder` is what makes your render code clean.

## Effectful atoms & Runtime

Now the payoff for being Effect-native. Back an atom with an `Effect` and it manages the fiber, scope, interruption, and result for you. Back it with a `Layer` via the default `Atom.runtime` factory and your atoms can use real services.

### Effect- and Stream-backed atoms

**Atom.make(effect)**

```ts
import { Data, Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"

interface User { readonly id: number }
class FetchError extends Data.TaggedError("FetchError")<{ cause: unknown }> {}
const fetchUser = (url: string) => Effect.tryPromise({
  try: async () => await fetch(url).then((response) => response.json()) as User,
  catch: (cause) => new FetchError({ cause }),
})
const anonymousUser: User = { id: 0 }
const userId = Atom.make(1)

// value type is AsyncResult<User, E>. The registry forks the effect in a scope,
// sets Initial(waiting) -> Success | Failure, and interrupts it on dispose/refresh.
const me = Atom.make(fetchUser("/api/me"))

// Seed an initial value to skip the Initial state:
const meSeeded = Atom.make(fetchUser("/api/me"), { initialValue: anonymousUser })

// Depend on other atoms inside the effect — re-fetches when `userId` changes:
const profile = Atom.make((get) =>
  fetchUser(`/api/users/${get(userId)}`)
)
```

> **Source note:** On `refresh`, an effect atom keeps its previous `Success` value but sets `waiting: true` until the new run resolves — automatic stale-while-revalidate. A `Stream` source updates the atom on every emission (last value wins), failing with `NoSuchElementError` if the stream ends empty.

### `Atom.runtime` — atoms that use services

Most real data access needs dependencies (an API client, a DB, config). `Atom.runtime(layer)` builds a runtime and hands you `.atom`, `.fn`, `.pull`, and `.subscriptionRef` constructors whose effects can require that layer's services. The default factory's `Layer.MemoMap` is itself an atom: derived runtimes share services inside one `AtomRegistry`, while separate registries remain isolated for SSR and tests. Use `Atom.context({ memoMap })` only when you intentionally need custom or cross-registry memoization. If Layers are new, first read [Services, Context & Layers](../foundations/services-context-layers).

**service + runtime (mirrors the test idiom)**

```ts
import { Clock, Context, Effect, Layer } from "effect"
import { Atom } from "effect/unstable/reactivity"

interface Todo { id: number; text: string; done: boolean }

// An Effect 4 service:
class Api extends Context.Service<Api, {
  readonly list: Effect.Effect<ReadonlyArray<Todo>>
  readonly add: (text: string) => Effect.Effect<Todo>
  readonly getById: (id: number) => Effect.Effect<Todo>
  readonly toggle: (id: number) => Effect.Effect<Todo>
  readonly prices: Effect.Effect<ReadonlyArray<number>>
}>()("app/Api") {}

const ApiLive = Layer.effect(
  Api,
  Effect.gen(function* () {
    return Api.of({
      list: Effect.succeed([]),
      add: Effect.fn(function*(text: string) {
        const id = yield* Clock.currentTimeMillis
        return { id, text, done: false }
      }),
      getById: (id) => Effect.succeed({ id, text: `Todo ${id}`, done: false }),
      toggle: (id) => Effect.succeed({ id, text: `Todo ${id}`, done: true }),
      prices: Effect.succeed([]),
    })
  }),
)

// Build the runtime atom ONCE from the layer:
const runtime = Atom.runtime(ApiLive)

// Derive an effectful atom that needs the Api service:
const todos = runtime.atom(Api.use((api) => api.list))
//    ^ Atom<AsyncResult<ReadonlyArray<Todo>, never>>
```

The following short snippets continue to use this `Api`, `runtime`, and a registry from the same feature module; they focus on one constructor at a time.

### `Atom.fn` — action / mutation atoms

A `fn` atom is a *writable* atom whose write value is the function argument. Writing an arg kicks off the Effect; reading the atom gives you the live `AsyncResult`. This is your "mutation" primitive — form submits, button actions, etc.

**Atom.fn**

```ts
import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"

const searchEffect = (query: string) => Effect.succeed(query)

const addTodo = runtime.fn((text: string) => Api.use((api) => api.add(text)))
//    ^ AtomResultFn<string, Todo, never>   (a Writable<AsyncResult<Todo>, string | Reset | Interrupt>)

// drive it from a registry (or from the React hooks covered below):
registry.set(addTodo, "Buy milk")     // runs the effect; async work exposes waiting, then Success
registry.get(addTodo)                 // AsyncResult<Todo>
registry.set(addTodo, Atom.Reset)     // back to Initial
registry.set(addTodo, Atom.Interrupt) // interrupt the in-flight fiber

// Atom.fn options: initialValue, concurrent (don't cancel previous run)
// runtime.fn additionally supports static reactivityKeys.
const search = Atom.fn((q: string) => searchEffect(q), { concurrent: true })
```

Asynchronous executions expose a waiting state before completion. A synchronous effect can complete directly as `Success` without an observable waiting state.

There's also `Atom.fnSync` for synchronous functions (returns `Option<A>` before the first call, or a seeded value).

### `Atom.pull` — streaming & pagination

**Atom.pull**

```ts
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

// A writable atom over a Stream. It pulls the first chunk, and each write pulls
// the next — accumulating items by default. Great for "load more" / infinite scroll.
declare const pagedStream: import("effect").Stream.Stream<Item>
interface Item { readonly id: number }

const feed = Atom.pull(pagedStream)   // Writable<PullResult<Item>, void>
const registry = AtomRegistry.make()
registry.get(feed)                    // AsyncResult<{ items: NonEmptyArray<Item>; done: boolean }>
registry.set(feed, undefined)         // pull the next page
```

The exact success type uses a non-empty batch: `{ readonly done: boolean; readonly items: Array.NonEmptyArray<Item> }`. The top-level constructor pulls once on first read and accumulates later chunks unless you pass `{ disableAccumulation: true }`.

### `Atom.family` — parameterised atoms

**Atom.family**

```ts
import { Atom } from "effect/unstable/reactivity"

// Memoised factory: the SAME atom instance for the same arg (WeakRef-GC'd).
// Essential — never call runtime.atom(...) inline in render with a new arg each time.
const todoById = Atom.family((id: number) =>
  runtime.atom(Api.use((api) => api.getById(id)))
)
registry.get(todoById(1)) // stable atom for id=1
```

### The combinator toolbox

Effect 4 ships the data-fetching niceties you'd otherwise pull in a library for. All are pipeable atom→atom transforms:

| Combinator | Purpose |
| --- | --- |
| `map` / `mapResult` | Transform the value (or the success channel of an `AsyncResult` atom). |
| `swr({ staleTime, revalidateOnFocus, focusSignal })` | Stale-while-revalidate; focus refresh requires an explicit signal. |
| `debounce(duration)` | Publish source changes only after they settle. |
| `withRefresh(duration)` | Auto-refresh on an interval. |
| `optimistic` / `optimisticFn` | Optimistic updates with automatic rollback on failure. |
| `withFallback(fallbackAtom)` | Show a fallback result while the primary is still `Initial`. |
| `kvs({ runtime, key, schema, defaultValue })` | Persist an atom to a `KeyValueStore` (e.g. localStorage). |
| `searchParam(name, { schema })` | Two-way bind an atom to a URL query parameter. |
| `refreshOnWindowFocus` | Refresh whenever the tab regains focus. |

**combinators in practice**

```ts
import { Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"

const prices = runtime.atom(Api.use((a) => a.prices)).pipe(
  Atom.swr({
    staleTime: "10 seconds",
    revalidateOnFocus: true,
    focusSignal: Atom.windowFocusSignal,
  }),
  Atom.withLabel("prices"),
)

const page = Atom.searchParam("page", { schema: Schema.FiniteFromString }) // Option<number>, ?page=3
const draft = Atom.make("").pipe(Atom.serializable({ key: "draft", schema: Schema.String }))
```

`Atom.windowFocusSignal` is browser-only. Omit it during SSR, or supply a custom focus signal that is safe in both environments. With `revalidateOnFocus: true`, freshness still respects `staleTime`; use `"always"` to force a refresh on every signal.

`Atom.serializable` only adds hydration metadata; it does not persist to browser storage. For real local persistence, create a runtime from `@effect/platform-browser`'s `BrowserKeyValueStore.layerLocalStorage` and pass it to `Atom.kvs` with a schema, key, and default value.

> **Takeaway:** Think in three roles: **queries** (`runtime.atom(effect)`, read-only async state), **mutations** (`runtime.fn(arg => effect)`, write-triggered), and **derivations** (`Atom.make((get) => …)` / `map`). Everything else is a combinator on top.

## AtomRef — local mutable state

A different tool for a different job. `AtomRef` is a standalone, synchronous, observable cell — **no registry involved**. Reach for it for high-frequency, fine-grained local state: form fields, cursor positions, editor buffers.

**AtomRef.ts**

```ts
import { AtomRef } from "effect/unstable/reactivity"

const form = AtomRef.make({ name: "", email: "" })

const unsub = form.subscribe((v) => console.log("form:", v))
form.update((f) => ({ ...f, name: "Ada" }))   // notifies subscribers
form.set({ name: "Ada", email: "a@x.dev" })
form.value                                      // current value, read synchronously
```

### Property lenses & derived refs

The superpower is `prop`: a typed lens into one field that is itself a fully reactive `AtomRef`. Subscribers to a prop ref only fire when *that field* changes (equality-gated) — fine-grained updates without re-rendering the whole form.

**prop lenses, map, collection**

```ts
import { AtomRef } from "effect/unstable/reactivity"

const form = AtomRef.make({ name: "", email: "" })

const name = form.prop("name")     // AtomRef<string> backed by form.name
name.set("Grace")                   // updates form.name AND notifies both refs
name.value                          // "Grace"

const upper = name.map((n) => n.toUpperCase())  // ReadonlyRef<string>, derived

// reactive collections of item refs:
const todos = AtomRef.collection([{ text: "a" }, { text: "b" }])
todos.push({ text: "c" })
todos.toArray()                     // raw values
todos.subscribe((refs) => {/* fires on insert/remove/item change */})
```

> **Source note:** `set` is a no-op when the new value is `Equal.equals` to the current one — so derived/prop refs don't churn. Equality & hashing are based on the contained value.

|  | `Atom` | `AtomRef` |
| --- | --- | --- |
| Runtime | Needs an `AtomRegistry` | Standalone, none |
| Model | Lazy dependency graph, async-capable | Eager synchronous cell |
| Async | Effects/Streams → `AsyncResult` | Synchronous values only |
| Best for | App/query/derived state, data fetching | Fast local UI state, form fields, lenses |

> **Takeaway:** Use `Atom` for the reactive graph; drop to `AtomRef` when you want imperative, allocation-light, per-field reactivity that never touches the registry. In React they pair via `useAtomRef` / `useAtomRefPropValue`.

## Reactivity ⇄ Atom

Now we close the loop from the foundation above. The reason `Reactivity` exists is so a **mutation** can invalidate keys and any **query atom** watching those keys refetches — automatically, with zero manual wiring.

### Two halves: `withReactivity` on reads, `reactivityKeys` on writes

**auto-invalidation loop**

```ts
import { Atom } from "effect/unstable/reactivity"

// READ side: a query atom that refreshes whenever ["todos"] is invalidated.
const todos = runtime.atom(Api.use((a) => a.list)).pipe(
  Atom.withReactivity(["todos"])
)

// WRITE side: a mutation that invalidates ["todos"] on success.
const addTodo = runtime.fn(
  (text: string) => Api.use((a) => a.add(text)),
  { reactivityKeys: ["todos"] }
)

// Wire-up complete. Now:
registry.set(addTodo, "Walk dog")
//   -> the effect succeeds
//   -> ["todos"] is invalidated through the Reactivity service
//   -> the `todos` atom refreshes itself (stale-while-revalidate)
//   No refetch() call, no cache keys to juggle.
```

Under the hood, `withReactivity(keys)` registers a handler that calls `get.refresh(self)` when the keys fire; `reactivityKeys` wraps the mutation's effect in `Reactivity.mutation(effect, keys)` so the keys invalidate after success. Both share the runtime's single `Reactivity` service.

### Collection plus row-level invalidation

**record keys**

```ts
import { Atom, Reactivity } from "effect/unstable/reactivity"

// A per-item query listens only to its exact row key:
const todoById = Atom.family((id: number) =>
  runtime.atom(Api.use((a) => a.getById(id))).pipe(
    Atom.withReactivity([`todos:${id}`])
  )
)

// The record form invalidates BOTH "todos" and "todos:<id>". A list listening
// on ["todos"] and the matching detail both refresh; unrelated details do not.
const toggle = runtime.fn(
  (id: number) => Reactivity.mutation(
    Api.use((a) => a.toggle(id)),
    { todos: [id] },
  ),
)
```

Do not register a detail query with `{ todos: [id] }`: record keys always include the shared `todos` key, so every detail registered that way would refresh for every row mutation (and the matching detail handler can be reached through both expanded keys).

> **Caution:** The runtime `.fn` option `reactivityKeys` is static. For keys computed from an argument, wrap the effect with `Reactivity.mutation` as above. Reads use `Atom.withReactivity(keys)` with the default factory or `runtime.factory.withReactivity(keys)` with a custom factory; runtime `.atom` has no `reactivityKeys` option.

> **Takeaway:** This is the Effect-native answer to query invalidation: declare which keys a read depends on and which keys a write affects; the runtime does the bookkeeping. It composes with `swr`, `optimistic`, and families.

## Hydration — SSR

Server-render with real atom values, ship them in the HTML payload, and rehydrate on the client so the first paint is correct and interactive without a flash of loading. The contract is small: mark atoms `serializable`, then `dehydrate` on the server and `hydrate` on the client.

### 1\. Mark atoms serializable

**Atom.serializable**

```ts
import { Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"

// Attach a stable key + a Schema codec. Only serializable atoms are dehydrated.
const username = Atom.make("").pipe(
  Atom.serializable({ key: "username", schema: Schema.String })
)
// The schema must encode/decode the atom's VALUE type (here: string).
// For async atoms, you provide a codec for their AsyncResult value.
```

### 2\. Dehydrate on the server, hydrate on the client

**Hydration.ts**

```ts
import { Hydration } from "effect/unstable/reactivity"

// --- server: after rendering into a per-request registry ---
const snapshot = Hydration.dehydrate(serverRegistry) // Initial results are ignored
// serialize `snapshot` into the HTML (e.g. window.__ATOMS__ = ...)

// --- client: preload BEFORE the atoms are first read ---
Hydration.hydrate(clientRegistry, window.__ATOMS__)
//  encoded values are loaded by key via registry.setSerializable(...)
```

> **Source note:** `encodeInitialAs: "ignore"` is the default; `"value-only"` emits the encoded `Initial` value. `"promise"` attaches a live `resultPromise`, so it is only suitable for a streaming transport that preserves promises—not JSON embedded in HTML. `Hydration.toValues` narrows dehydrated entries for transports that need the concrete record shape. `hydrate` applies values by key and does not reject older `dehydratedAt` timestamps, so ordering and freshness remain the caller's responsibility.

For an async atom, the serialization schema must cover the whole `AsyncResult`, not only its success value. Construct it with `AsyncResult.Schema({ success: UserSchema, error: UserErrorSchema })`.

For the codec model behind this boundary, use the handbook's concise [Schema topic](../data/schema), then Effect's release-matched [comprehensive Schema guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/SCHEMA.md) for the long-form treatment.

`withReactivity` preserves the underlying initial-value target, so a preloaded serializable atom still refreshes the correct source atom.

### Deterministic server reads

Some atoms must read differently on the server (no `window`, no `Date.now()` drift). Override their server-side read:

**withServerValue**

```ts
import { Atom } from "effect/unstable/reactivity"

const startedAt = Atom.make(() => Date.now()).pipe(
  Atom.withServerValue(() => 0) // stable on the server -> no hydration mismatch
)
// For async atoms: Atom.withServerValueInitial keeps them Initial(waiting) on the server.
// Read with Atom.getServerValue(atom, registry) when rendering server-side.
```

> **Takeaway:** SSR = three verbs: `serializable` (opt in + give a codec), `dehydrate` (snapshot a registry), `hydrate` (preload another). The React layer wraps step 3 in a component (next).

## AtomReact — React bindings

The `@effect/atom-react` package connects atoms to components: a registry provider, a family of hooks built on `useSyncExternalStore` (SSR-safe), Suspense integration for `AsyncResult`, and a hydration boundary. This guide demonstrates React; the concise [Reactivity & Atom topic](../systems/reactivity-atom#framework-bindings) lists the Solid and Vue equivalents.

### Provider + the two everyday hooks

**counter.tsx**

```tsx
import { RegistryProvider, useAtom, useAtomValue } from "@effect/atom-react"
import { Atom } from "effect/unstable/reactivity"

const count = Atom.make(0)
const double = Atom.make((get) => get(count) * 2)

function Counter() {
  const [n, setN] = useAtom(count)          // value + setter (setter takes value or updater)
  const d = useAtomValue(double)            // read-only subscription
  return <button onClick={() => setN((x) => x + 1)}>{n} (×2 = {d})</button>
}

export function App() {
  return (
    <RegistryProvider>                       {/* one registry for this subtree */}
      <Counter />
    </RegistryProvider>
  )
}
```

### The hook family

| Hook | Use |
| --- | --- |
| `useAtomValue(atom, selector?)` | Subscribe + read. Optional selector maps before subscribing. |
| `useAtom(atom, { mode? })` | `[value, setter]` for a writable atom. |
| `useAtomSet(atom, { mode? })` | Setter only (no re-render on value). `mode: "promise" \| "promiseExit"` for mutations. |
| `useAtomInitialValues(values)` | Seed atom values in the current registry during first render. |
| `useAtomMount(atom)` | Keep an atom alive for the component's lifetime. |
| `useAtomRefresh(atom)` | Returns a `refresh()` callback. |
| `useAtomSuspense(atom, opts)` | Read an `AsyncResult` atom via Suspense (throws a promise while loading). |
| `useAtomSubscribe(atom, f)` | Run a side-effect on change without rendering the value. |
| `useAtomRef(ref)` | Subscribe to a standalone `AtomRef`. |
| `useAtomRefProp(ref, prop)` | Memoize and return a writable property ref. |
| `useAtomRefPropValue(ref, prop)` | Subscribe directly to one property value. |

### Async data with Suspense + mutations

**todos.tsx**

```tsx
import { Suspense } from "react"
import { useAtomSuspense, useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/unstable/reactivity"

function TodoList() {
  // suspends until the atom leaves Initial; throws the squashed cause/error on failure
  const result = useAtomSuspense(todos)        // result: AsyncResult.Success<Todo[]>
  return <ul>{result.value.map((t) => <li key={t.id}>{t.text}</li>)}</ul>
}

function AddTodo() {
  // "promise" mode -> setter returns a Promise that resolves on success
  const add = useAtomSet(addTodo, { mode: "promise" })
  return <button onClick={() => add("New task")}>Add</button>
}

// Read just a slice with a stable selector (no re-render unless it changes):
const todoCount = (r: Atom.Type<typeof todos>) =>
  AsyncResult.isSuccess(r) ? r.value.length : 0

function TodoCount() {
  const n = useAtomValue(todos, todoCount)
  return <span>{n} todos</span>
}

function Screen() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <TodoList /><AddTodo /><TodoCount />
    </Suspense>
  )
}
```

### Subtree-scoped atoms & SSR hydration

**ScopedAtom + HydrationBoundary**

```tsx
import { HydrationBoundary, useAtomValue } from "@effect/atom-react"
import * as ScopedAtom from "@effect/atom-react/ScopedAtom"
import { Atom } from "effect/unstable/reactivity"

// Each <Provider> instance owns its OWN atom — different subtrees don't share state:
const Counter = ScopedAtom.make(() => Atom.make(0))
function View() {
  const atom = Counter.use()
  return <span>{useAtomValue(atom)}</span>
}
// Render with: <Counter.Provider><View /></Counter.Provider>

// SSR: feed dehydrated state into the nearest registry before children read.
function Page({ dehydrated }: { dehydrated: any }) {
  return (
    <HydrationBoundary state={dehydrated}>
      <TodoList />
    </HydrationBoundary>
  )
}
```

> **Source note:** Hooks use `useSyncExternalStore` with a server snapshot (`Atom.getServerValue`). `RegistryProvider` creates one registry per subtree and lets you opt into `defaultIdleTTL`; the fallback `RegistryContext` uses 400ms. Provider disposal waits 500ms after unmount and is canceled if it remounts. Suspense promise caches are isolated per registry. `HydrationBoundary` hydrates brand-new atoms during render, but defers values for atoms already present until after commit — so a transition cannot update the current UI early.

> **Takeaway:** Define atoms at module scope; `useAtomValue`/`useAtom` for sync state, `useAtomSuspense` + a Suspense boundary for queries, `useAtomSet({mode:"promise"})` for mutations. Suspense always waits for `Initial`; a waiting state alone does not suspend unless `suspendOnWaiting: true`. A waiting `Success` is returned, while a `Failure` is returned only with `includeFailure: true` and otherwise throws `Cause.squash`. Pair with `RegistryProvider` (client) and `HydrationBoundary` (SSR).

Selectors are compared with the mapped atom's default `Object.is` equality. Keep selector functions stable (module scope or `useCallback`) when identity churn matters, because an inline selector produces a fresh mapped atom whenever the function identity changes.

## Typed HttpApi and RPC atoms

`AtomHttpApi` and `AtomRpc` connect Effect's typed clients to the same registry, runtime, reactivity, retention, and hydration machinery. They are the high-level path when your data source already has an [HttpApi](../interfaces/http-api) or [RPC](../interfaces/rpc) contract.

```ts
import { AtomHttpApi, AtomRpc } from "effect/unstable/reactivity"

// Given an HttpApi contract `Api` and an HTTP client layer `HttpClientLive`:
const Http = AtomHttpApi.Service()("app/Http", {
  api: Api,
  httpClient: HttpClientLive,
})
const user = Http.query("users", "getUser", {
  params: { id: 1 },
  reactivityKeys: { users: [1] },
  timeToLive: "30 seconds",
  serializationKey: "1",
})
const saveUser = Http.mutation("users", "saveUser")

// Given an RpcGroup `Rpcs` and client protocol layer `RpcProtocol`:
const RpcClient = AtomRpc.Service()("app/Rpc", {
  group: Rpcs,
  protocol: RpcProtocol,
})
const profile = RpcClient.query("getProfile", { id: 1 }, {
  reactivityKeys: { profiles: [1] },
  timeToLive: "30 seconds",
  serializationKey: "1",
})
const saveProfile = RpcClient.mutation("saveProfile")
```

Both services expose the underlying typed client and an atom `.runtime`. Their query options can add static reactivity keys, an idle TTL (or infinite keep-alive), and a stable hydration serialization key. Mutations accept reactivity keys with each write request. A streaming RPC query becomes a writable pull atom, so writing `undefined` requests the next chunk. The query builders preserve serialization and idle-retention metadata when reactivity wrapping is applied; separately, `Atom.withReactivity` preserves the hydration initial-value target.

## Mastery — capstone

One small Todos feature ties the central primitives together: a service-backed runtime, a query atom with auto-invalidation, URL state, a serializable shared draft atom, Suspense rendering, and a registry-level test. This is the shape of real Effect 4 reactive code.

### The atoms (define once, framework-agnostic)

**todos/atoms.ts**

```ts
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { AsyncResult, Atom } from "effect/unstable/reactivity"

interface Todo { id: number; text: string; done: boolean }

export class TodoApi extends Context.Service<TodoApi, {
  readonly list: Effect.Effect<ReadonlyArray<Todo>>
  readonly add: (text: string) => Effect.Effect<Todo>
  readonly toggle: (id: number) => Effect.Effect<Todo>
}>()("app/TodoApi") {}
const TodoApiLive = Layer.effect(TodoApi, Effect.gen(function* () {
  // ...real HTTP client built from a Layer dependency...
  return TodoApi.of({
    list: Effect.succeed([]),
    add: Effect.fn(function*(text: string) {
      const id = yield* Clock.currentTimeMillis
      return { id, text, done: false }
    }),
    toggle: (id: number) => Effect.succeed({ id, text: "", done: true }),
  })
}))

// 1) one runtime for the whole feature (services shared within each registry)
export const runtime = Atom.runtime(TodoApiLive)

// 2) QUERY: auto-refreshes when ["todos"] is invalidated; stays fresh for 15s
export const todosAtom = runtime.atom(TodoApi.use((a) => a.list)).pipe(
  Atom.withReactivity(["todos"]),
  Atom.swr({ staleTime: "15 seconds" }),
  Atom.withLabel("todos"),
)

// 3) MUTATIONS: invalidate ["todos"] on success -> the query refetches itself
export const addTodo = runtime.fn(
  (text: string) => TodoApi.use((a) => a.add(text)),
  { reactivityKeys: ["todos"] },
)
export const toggleTodo = runtime.fn(
  (id: number) => TodoApi.use((a) => a.toggle(id)),
  { reactivityKeys: ["todos"] },
)

// 4) ancillary state: filter in the URL, draft marked for SSR hydration
export const filter = Atom.searchParam("filter") // ?filter=active
export const draft  = Atom.make("").pipe(Atom.serializable({ key: "draft", schema: Schema.String }))

// 5) DERIVED view model — recomputes when todos or filter change
export const visibleTodos = Atom.make((get) => {
  const f = get(filter)
  return AsyncResult.map(get(todosAtom), (todos) =>
    f === "active" ? todos.filter((todo) => !todo.done)
      : f === "done" ? todos.filter((todo) => todo.done)
      : todos
  )
})
```

The draft is deliberately a registry-managed `Atom`: it is shared by the feature and carries hydration metadata. For a component-local form buffer that does not participate in the graph or cross an SSR boundary, use an `AtomRef` instead.

### The UI (thin — all logic lives in atoms)

**todos/TodoApp.tsx**

```tsx
import { Suspense } from "react"
import { RegistryProvider, useAtomSuspense, useAtomSet, useAtom } from "@effect/atom-react"
import { visibleTodos, addTodo, toggleTodo, draft } from "./atoms.ts"

function List() {
  const result = useAtomSuspense(visibleTodos)     // suspends while Initial
  const toggle = useAtomSet(toggleTodo)
  return (
    <ul>
      {result.value.map((t) => (
        <li key={t.id} onClick={() => toggle(t.id)}>{t.done ? "✓" : "○"} {t.text}</li>
      ))}
    </ul>
  )
}

function Composer() {
  const [text, setText] = useAtom(draft)
  const add = useAtomSet(addTodo, { mode: "promise" })
  return (
    <form onSubmit={(e) => { e.preventDefault(); add(text).then(() => setText("")) }}>
      <input value={text} onChange={(e) => setText(e.target.value)} />
    </form>
  )
}

export function TodoApp() {
  return (
    <RegistryProvider>
      <Composer />
      <Suspense fallback={<p>Loading todos…</p>}><List /></Suspense>
    </RegistryProvider>
  )
}
```

### Testing — just a registry, no React

This uses the same test Layers and Effect-aware runner covered in [Testing & Dev Tooling](../tooling/testing-dev-tooling).

**todos/atoms.test.ts**

```ts
import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AtomRegistry, Atom } from "effect/unstable/reactivity"
import { runtime, TodoApi, todosAtom } from "./atoms.ts"

const TodoApiTest = Layer.succeed(TodoApi, TodoApi.of({
  list: Effect.succeed([]),
  add: (text: string) => Effect.succeed({ id: 1, text, done: false }),
  toggle: (id: number) => Effect.succeed({ id, text: "", done: true }),
}))

it("derives and reacts", () => {
  const count = Atom.make(0)
  const double = Atom.make((get) => get(count) * 2)
  const r = AtomRegistry.make()
  expect(r.get(double)).toBe(0)
  r.set(count, 5)
  expect(r.get(double)).toBe(10)
})

it("injects a test layer via initialValues", async () => {
  // swap the runtime's layer for a deterministic one — no network in tests:
  const r = AtomRegistry.make({
    initialValues: [Atom.initialValue(runtime.layer, TodoApiTest)],
  })
  const todos = await Effect.runPromise(AtomRegistry.getResult(r, todosAtom))
  expect(todos).toEqual([])
})
```

### Performance & correctness checklist

-   **Define atoms at module scope.** Never call `Atom.make`/`runtime.atom` inside render with fresh args — use `Atom.family` for parameterised atoms.
-   **Lean on auto-dispose.** Default lazy + GC keeps memory bounded. Add `keepAlive`/`setIdleTTL`/`useAtomMount` only for state that must outlive its subscribers.
-   **Select narrowly.** `useAtomValue(atom, selector)` subscribes to the mapped slice. Keep selectors stable, and remember their output uses `Object.is` unless you build an atom with custom equality.
-   **Use `AtomRef` for purely local hot state.** Form keystrokes and cursor moves that do not need graph dependencies, sharing, or hydration fit its prop lenses; use an `Atom` when that state deliberately participates in those capabilities.
-   **Batch & debounce.** `Atom.batch(() => { … })` coalesces synchronous writes; `Atom.debounce` tames noisy sources.
-   **Prefer reactivity keys over manual refresh.** Let mutations invalidate; let queries refetch. Manual `refresh` is the escape hatch, not the default.
-   **Mind error boundaries.** `useAtomSuspense` throws `Cause.squash(cause)` on failure unless you pass `includeFailure: true`.
-   **One registry per world.** Per request on the server, per tree on the client, per test. Dehydrate/hydrate to bridge server→client.

> **Takeaway:** You now have the full picture: `Reactivity` wires writes to reads · `Atom` describes reactive values · `AtomRegistry` runs & GCs them · `AsyncResult` models async state · `AtomRef` handles fine-grained local state · `Hydration` crosses the SSR boundary · `AtomReact` binds it to the view. Same primitives, from a counter to a production data layer.
