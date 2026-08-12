# Reactivity & Atom

For a connected, application-oriented treatment of these modules, see [Reactivity — From Atoms to Mastery](../deep-dives/reactivity-from-atoms-to-mastery).

> **Note:** Eight core modules under `effect/unstable/reactivity`, one mental model. **Atom** describes a reactive value (a constant, a derived computation, a writable cell, or an Effect/Stream). **AtomRegistry** is the store that runs atoms, caches them, and tracks the dependency graph. **AsyncResult** is the loading/success/failure state every effectful atom produces. **AtomRef** is a lightweight standalone observable cell (no registry). **Reactivity** is the low-level key-based invalidation engine. **AtomHttpApi** and **AtomRpc** turn a typed comp-service client into ready-made query/mutation atoms. **Hydration** ships server-computed atom state to the client. Then three framework bindings wrap it for components.

## Atom

`effect/unstable/reactivity/Atom` — unstable

An `Atom<A>` is not a value — it's a recipe with a `read` function the registry runs, plus metadata for caching, laziness, and refresh. `Atom.make` is overloaded: pass a plain value for a writable cell, a function of `get` for a derived/computed atom, or an `Effect`/`Stream` for an atom whose value is an `AsyncResult`.

Mental model: spreadsheet cells. A writable atom is a cell you type into. A derived atom is a formula cell — it calls `get(other)` to read inputs, and the registry records that edge so the formula reruns only when an input changes. An effectful atom is an async formula; instead of a bare value it exposes the *state* of that computation.

```ts
import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"

// 1. Writable state — pass a plain value. Atom.make(x) returns Writable<x>.
// A planner-controlled proposed raise, in percent.
const proposedRaisePct = Atom.make(4)

// 2. Derived / computed — a function of `get`. Re-reads only when the raise changes.
// New salary as a multiplier of the current base (base read elsewhere).
const raiseMultiplier = Atom.make((get) => 1 + get(proposedRaisePct) / 100)

// 3. Effect-backed — value becomes AsyncResult<EquityGrant, HrisUnavailable>.
const equityGrant = Atom.make(
  Effect.gen(function*() {
    return yield* fetchEquityGrant("emp_1042")
  })
)

// 4. Derived effectful — depends on another atom AND runs an Effect.
// Re-fetch the comp summary whenever the proposed raise changes.
const compSummary = Atom.make((get) =>
  Effect.gen(function*() {
    const pct = get(proposedRaisePct) // tracked dependency
    return yield* computeCompSummary("emp_1042", pct)
  })
)
```

For event-driven work, use `Atom.fn`. It returns an `AtomResultFn<Arg, A, E>`: a writable atom whose value is an `AsyncResult` and whose *write* kicks off the computation with the supplied argument. Write `Atom.Reset` to clear it or `Atom.Interrupt` to cancel the in-flight fiber. `Atom.fnSync` is the synchronous sibling (value is an `Option` until first call).

```ts
import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"

interface RaiseRecommendation {
  readonly employeeId: string
  readonly newSalary: number
}
declare const recordRaise: (rec: RaiseRecommendation) => Effect.Effect<void>

// A "mutation"-style atom: setting a raise recommendation runs the Effect.
// The construction option allows overlapping writes; without it, a new write
// replaces the in-flight one.
const submitRaise = Atom.fn(
  (rec: RaiseRecommendation) => recordRaise(rec),
  { concurrent: true }
)
// registry.set(submitRaise, rec)            -> Initial -> waiting -> Success
// registry.set(submitRaise, Atom.Reset)     -> back to Initial
// registry.set(submitRaise, Atom.Interrupt) -> cancel the in-flight write
```

> **Tip:** `Atom.map` / `Atom.mapResult` transform an atom's value (the latter maps inside the `AsyncResult` success). Every atom uses `Object.is` by default; `Atom.withEquality<A>(equals)` installs a comparator that suppresses dependent and listener updates when successive values compare equal. `Atom.keepAlive` stops an atom being disposed when it has no subscribers; `Atom.setIdleTTL(atom, "30 seconds")` disposes it after a quiet period instead. `Atom.family((employeeId) => Atom.make(...))` memoizes one atom per argument (via `WeakRef` where available). `Atom.withLabel` tags an atom for debugging. `Atom.subscriptionRef` bridges a `SubscriptionRef` into an atom, and `Atom.pull` turns a `Stream` into a paginated, writable "load more" atom.

Other high-value combinators stay on the same graph: `debounce(duration)` delays noisy publications; `withRefresh(duration)` schedules a refresh; `swr({ staleTime, ... })` adds stale-while-revalidate behavior; `withFallback(fallback)` supplies an async result while the primary is `Initial`; and `optimistic` / `optimisticFn` model provisional mutation state with refresh or rollback. `batch(fn)` coalesces synchronous writes. Persistence and URL helpers include platform-neutral `kvs` (schema-typed `KeyValueStore` persistence), browser-oriented `searchParam`, and browser-only `refreshOnWindowFocus`; on the server, `withServerValue`, `withServerValueInitial`, and `getServerValue` provide deterministic reads. The Reactivity deep dive shows these in a connected application.

**Where services come from.** An effectful atom that needs services can't conjure a Layer out of thin air. `Atom.runtime(layer)` builds an `AtomRuntime` — itself an atom holding the built `Context` — and gives you `runtime.atom(...)`, `runtime.fn(...)`, and `runtime.pull(...)` constructors that run Effects with that layer provided. By default its `Layer.MemoMap` is registry-scoped: derived atoms share built services inside one `AtomRegistry`, while separate SSR requests and tests build isolated instances. Use `Atom.context({ memoMap })` only when you intentionally need custom or cross-registry sharing.

```ts
import { Effect } from "effect"
import { Atom } from "effect/unstable/reactivity"

// The built Layer is shared by live/retained runtime atoms in this registry.
// If the final consumer is disposed, a later read may acquire it again.
const runtime = Atom.runtime(CompService.layer)

// This effect can `yield* CompService` — the runtime provides it.
const roster = runtime.atom(
  Effect.gen(function*() {
    const comp = yield* CompService
    return yield* comp.listEmployees("dept_eng")
  })
)
```

**Reach for it when** you have application state — local, derived, or fetched — that something needs to react to.

## AtomRegistry

`effect/unstable/reactivity/AtomRegistry` — unstable

The store. A `Registry` evaluates atoms, caches their current values in `Node`s, tracks parent/child dependency links, applies writes and refreshes, fans out to subscribers, and disposes unused nodes. Atoms are stateless descriptions; the registry is where state lives. The same atom can hold different values in two different registries. Most apps have exactly one (a framework provider creates it); tests and SSR spin up throwaway registries freely.

Mental model: the spreadsheet engine. Atoms are formulas; the registry is the running document with cached cell values and the recalculation graph. It also owns the scheduler that batches update work.

```ts
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

const proposedRaisePct = Atom.make(4)
const raiseMultiplier = Atom.make((get) => 1 + get(proposedRaisePct) / 100)

const registry = AtomRegistry.make()

registry.get(proposedRaisePct)   // 4
registry.set(proposedRaisePct, 6)
registry.get(raiseMultiplier)    // 1.06 — recomputed because the raise changed

// Subscribe imperatively; returns an unsubscribe fn.
const cancel = registry.subscribe(raiseMultiplier, (m) => console.log("multiplier =", m))
registry.set(proposedRaisePct, 8) // logs: multiplier = 1.08
cancel()

// `mount` keeps an atom alive (and running, for effectful atoms) for a lifetime.
const unmount = registry.mount(proposedRaisePct)
unmount()
```

**As a service.** `AtomRegistry` is also a `Context.Service` with a `layer`. `AtomRegistry.getResult` waits for an `AsyncResult` atom to leave `Initial`. `AtomRegistry.toStream` / `toStreamResult` turn an atom into a `Stream` of its changes. `make` accepts `initialValues` (seed atoms before first read — basis of hydration), a custom `scheduleTask`, and a `defaultIdleTTL`.

**Reach for it when** you need to read or write atoms outside a component — in tests, in an Effect, at the SSR boundary — or to scope a self-contained bundle of reactive state to a subtree.

## AtomRef

`effect/unstable/reactivity/AtomRef` — unstable

A standalone observable cell — read, set, `map`, `subscribe` — that does *not* go through a registry. `AtomRef.make(value)` gives a mutable ref; `.prop("field")` derives a child ref focused on one property of an object (or index of an array), and writing the child writes back through the parent immutably. `AtomRef.collection(items)` manages a reactive list of item refs with `push`/`insertAt`/`remove`.

Mental model: a featherweight observable independent of the spreadsheet. Equality-aware — a `set` to an equal value is a no-op and notifies nobody. No dependency graph, no async story. Use for fine-grained form state where a stable handle to one nested field should re-render only its own consumers.

```ts
import { AtomRef } from "effect/unstable/reactivity"

// A single editable raise recommendation form.
const draft = AtomRef.make({ employeeId: "emp_1042", raisePct: 4, note: "" })

const raisePct = draft.prop("raisePct") // AtomRef<number> focused on .raisePct
raisePct.set(6)                          // updates draft to { ..., raisePct: 6 }
draft.value                              // { employeeId: "emp_1042", raisePct: 6, note: "" }

const cancel = raisePct.subscribe((p) => console.log("raise ->", p))
raisePct.update((p) => p + 1)            // logs: raise -> 7
cancel()
```

> **Note:** Don't confuse `AtomRef` with a handle to an atom's value. It is its own cell type, used standalone. The bridge in the other direction is `Atom.subscriptionRef`, which lifts a `SubscriptionRef` into a registry-managed atom. In React, `useAtomRef(ref)` subscribes a component straight to an `AtomRef`.

**Reach for it when** you want surgical, per-field observable state with minimal machinery and no need for the registry's dependency tracking.

## AsyncResult

`effect/unstable/reactivity/AsyncResult` — unstable

The state of an asynchronous value. An `AsyncResult<A, E>` is one of three tags — `Initial` (no value yet), `Success` (carries `value` + `timestamp`), `Failure` (carries a `Cause<E>` on `.cause`, plus a `previousSuccess`) — and *every* state also carries a `waiting` boolean. The `waiting` flag lets you keep showing the last value while a refresh, retry, or revalidation is in flight instead of flashing back to a spinner.

Mental model: `Exit` plus "I might still be loading," designed for rendering. Every effectful atom (`Atom.make(effect)`, `Atom.fn`, query atoms) produces one. You almost never construct these by hand — you *match* on them.

```ts
import { AsyncResult } from "effect/unstable/reactivity"

declare const result: AsyncResult.AsyncResult<CompSummary, HrisUnavailable>

// Three-way match — initial vs failure vs success.
// onFailure receives the Failure, whose `.cause` is a Cause<HrisUnavailable>.
const view = AsyncResult.match(result, {
  onInitial: () => "Loading comp…",
  onFailure: (f) => `Error: ${f.cause}`,
  onSuccess: (s) => `${s.value.employeeName}: $${s.value.proposedBase}`
})

// The UI-grade matcher: treats `waiting` (and Initial) as one "loading-ish"
// case, and splits Failure into your typed error vs an unexpected defect.
const ui = AsyncResult.matchWithWaiting(result, {
  onWaiting: (r) => ({ status: "loading", stale: AsyncResult.value(r) }),
  onError: (e) => ({ status: "error", error: e }),       // e is HrisUnavailable
  onDefect: (d) => ({ status: "crash", defect: d }),
  onSuccess: (s) => ({ status: "ready", data: s.value })
})
```

> **Tip:** `AsyncResult.value(r)` returns an `Option<A>` of the latest success and, while a `Failure` is showing, falls back to its `previousSuccess`. `getOrElse` supplies a default, `map`/`flatMap` transform the success, and guards `isSuccess`/`isFailure`/`isInitial`/`isWaiting` let you branch directly. Because `Failure` holds a full `Cause`, `matchWithError` and `matchWithWaiting` are preferred over a raw three-way match when defects and typed errors should render differently. `AsyncResult.Schema` encodes results across the wire — used by `AtomHttpApi`/`AtomRpc` for hydration.

**Reach for it when** — any atom backed by an Effect or Stream gives you one; render its four states (loading, stale-while-revalidating, error, success) cleanly.

## AtomHttpApi

`effect/unstable/reactivity/AtomHttpApi` — unstable

The bridge from a typed `HttpApi` client to ready-made atoms. `AtomHttpApi.Service<Self>()(id, { api, httpClient })` builds a `Context.Service` that wraps the generated client and exposes two atom factories: `.query(group, endpoint, request)` returns a read atom of `AsyncResult<Success, Error>`, and `.mutation(group, endpoint)` returns an `AtomResultFn` you write to fire the call. It owns its own `Atom.runtime`, so the HTTP client layer is provided automatically.

Mental model: your API definition is the contract; this turns each endpoint into a reactive cell. Query atoms are deduped via `Atom.family` when their complete request keys are structurally equal: endpoint, params/query/payload/headers, response mode, reactivity keys, TTL, and serialization key all participate. For decoded-only queries, a `serializationKey` makes the decoded result hydratable and must be stable and unique for each distinct request within an endpoint, or different query atoms can share the same hydration identity. `timeToLive` controls idle retention, and `reactivityKeys` enable auto-refresh. Mutations run the endpoint and invalidate their supplied reactivity keys on success.

```ts
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { FetchHttpClient } from "effect/unstable/http"
import { AtomHttpApi } from "effect/unstable/reactivity"

const CompSummary = Schema.Struct({
  employeeId: Schema.Int,
  baseSalary: Schema.Finite,
  level: Schema.String
})

const CompApi = HttpApi.make("comp").add(
  HttpApiGroup.make("comp").add(
    HttpApiEndpoint.get("getCompSummary", "/employees/:id/comp", {
      params: { id: Schema.FiniteFromString },
      success: CompSummary
    })
  )
)

// One service = the client + atom factories, with its HTTP client layer baked in.
class CompClient extends AtomHttpApi.Service<CompClient>()("app/CompClient", {
  api: CompApi,
  httpClient: FetchHttpClient.layer,
  baseUrl: "https://hr.internal/api"
}) {}

// This API declares no endpoint/middleware errors, so the typed result is
// AsyncResult<CompSummary, never>. Transport and decoding failures are defects.
const summary1042 = CompClient.query("comp", "getCompSummary", {
  params: { id: 1042 },
  serializationKey: "comp:1042" // makes it hydratable
})
```

Query atoms preserve endpoint and middleware errors in the typed error channel. The client catches transport and response-decoding failures and converts them to defects, so render those through the `Cause`/`onDefect` path. A declared write endpoint would be exposed with `CompClient.mutation(group, endpoint)`; this read-only example deliberately does not invent one.

**Reach for it when** you have an `HttpApi` and want its endpoints as cache-aware, hydratable, auto-invalidating query/mutation atoms.

## AtomRpc

`effect/unstable/reactivity/AtomRpc` — unstable

Same as `AtomHttpApi` but for an `RpcGroup`. `AtomRpc.Service<Self>()(id, { group, protocol })` builds a service over a flattened RPC client with the same `.query(tag, payload, options)` and `.mutation(tag)` factories. If an RPC's success is an `RpcSchema.Stream`, its query returns a *pull atom* (`Atom.PullResult`) — write to it to pull the next batch and accumulate streamed results.

Mental model: same query/mutation/invalidation machinery as HTTP, keyed off the procedure `tag` + payload. `reactivityKeys` and idle retention (`timeToLive`) carry over. A non-stream query can also use a `serializationKey`; keep it unique for each distinct payload within its RPC tag. Streaming pull queries ignore serialization keys. Per-request `headers` are RPC-flavored. Supply the transport as the `protocol` layer; the runtime is built for you.

```ts
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { AtomRpc } from "effect/unstable/reactivity"

const CompRpcs = RpcGroup.make(
  Rpc.make("getVestedEquity", {
    payload: { employeeId: Schema.String },
    success: Schema.Struct({
      employeeId: Schema.String,
      vestedShares: Schema.Natural,
      grantDate: Schema.String
    })
  })
)

class CompRpcClient extends AtomRpc.Service<CompRpcClient>()("app/CompRpcClient", {
  group: CompRpcs,
  protocol: ProtocolLive // your RpcClient.Protocol transport layer
}) {}

// Query atom: AsyncResult<{ employeeId, vestedShares, grantDate }, RpcClientError | ...>.
const vested = CompRpcClient.query(
  "getVestedEquity",
  { employeeId: "emp_1042" },
  { serializationKey: "vested:1042" }
)

// Mutation atom, with key-based invalidation on success:
// const grant = CompRpcClient.mutation("recordEquityGrant")
// registry.set(grant, { payload: { employeeId: "emp_1042", shares: 1200 }, reactivityKeys: ["equity"] })
```

**Reach for it when** your backend speaks Effect RPC and you want the frontend to consume it as atoms — including streaming procedures surfaced as incremental pull atoms.

## Hydration

`effect/unstable/reactivity/Hydration` — unstable

Server-to-client state transfer for atoms. `Hydration.dehydrate(registry)` walks a registry and encodes every atom marked `Atom.serializable`; decoded-only HttpApi queries and non-stream RPC queries become serializable when given a `serializationKey`. Entries are keyed by that serialization key. With the default `encodeInitialAs: "ignore"`, or with `"value-only"`, the array is JSON-compatible; embed it only through a framework-safe escaped serialization channel, never raw string interpolation into a `<script>`. `Hydration.hydrate(registry, state)` preloads encoded values into another registry *before* atoms are first read, so the client renders without an initial refetch.

Mental model: freeze-dry the relevant cells on the server, ship the value packet in your HTML, and reconstitute it into the client registry. `encodeInitialAs: "promise"` instead attaches a live `resultPromise`; it is only for a streaming transport that preserves promises and must not be JSON-stringified or embedded as ordinary data.

```ts
import { Hydration } from "effect/unstable/reactivity"

// On the server, after rendering with a registry that ran your comp query atoms:
const packet = Hydration.dehydrate(serverRegistry)
// JSON-serialize `packet` into the page…

// On the client, before first render:
Hydration.hydrate(clientRegistry, packet)
```

For custom serializable atoms, the codec covers the atom's complete value. In particular, an effectful atom needs an `AsyncResult.Schema(...)`, not just its success schema; the release-matched [comprehensive upstream Schema guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/SCHEMA.md) covers codecs and serialization in depth.

**Reach for it when** you do SSR or static rendering and want fetched atom state to survive the trip to the browser instead of refetching on mount.

## Reactivity

`effect/unstable/reactivity/Reactivity` — unstable

The low-level invalidation engine that reactivity keys ride on. `Reactivity` is a `Context.Service` that maps arbitrary keys to handlers: `invalidate(keys)` runs every handler registered for those keys, `mutation(keys, effect)` wraps an effect so a successful run invalidates them, and `query(keys, effect)` / `stream(keys, effect)` expose an effect as a queue/stream that *reruns* whenever its keys are invalidated. It caches nothing — it is pure pub/sub for "this data changed."

Mental model: the wiring under the magic. When an `AtomHttpApi` mutation lists `reactivityKeys: ["comp"]` and a query atom was built with matching keys, this service connects the write to the refetch. You rarely call it directly, but it explains how cache invalidation propagates and lets you wire key-based invalidation into non-atom Effects.

```ts
import { Effect } from "effect"
import { Reactivity } from "effect/unstable/reactivity"

const recordRaise = (rec: RaiseRecommendation) =>
  Effect.gen(function*() {
    const reactivity = yield* Reactivity.Reactivity
    // run the write, and on success invalidate everything keyed "comp".
    return yield* reactivity.mutation(["comp"], db.insertRaise(rec))
  })
```

**Reach for it when** you need key-based invalidation outside the atom layer (e.g. a SQL repo), or to understand what `reactivityKeys` are doing.

## Framework bindings

The core above is framework-agnostic. Each binding (1) provides an `AtomRegistry` through the framework's context and (2) exposes hooks/primitives that subscribe a component to that registry.

- **pkg @effect/atom-react** — React hooks + `RegistryProvider`. `useAtomValue(atom)` reads, `useAtom(writable)` returns `[value, set]`, `useAtomSet` / `useAtomRefresh` / `useAtomMount` give write/refresh/keep-alive without subscribing, and `useAtomSuspense` reads an `AsyncResult` atom through React Suspense. `HydrationBoundary` applies dehydrated state; `ScopedAtom.make` makes a subtree-local atom.

- **pkg @effect/atom-solid** — The Solid binding. `useAtomValue(() => atom)` returns an accessor, `useAtom(() => writable)` returns an accessor/setter tuple, and `useAtomResource` bridges an `AsyncResult` atom to a Solid resource.

- **pkg @effect/atom-vue** — The Vue binding. `useAtomValue(() => atom)` returns a readonly `Ref`, while `useAtom(() => writable)` returns a readonly `Ref` plus a setter through Vue's provide/inject registry.

## @effect/atom-react in practice

`@effect/atom-react` — pkg

Hooks built on `React.useSyncExternalStore` that read from the nearest `RegistryContext`. Wrap your tree in `RegistryProvider`; it creates one registry, accepts an optional `defaultIdleTTL`, and schedules whole-registry disposal 500 ms after unmount so an immediate remount can reuse it. The provider does not impose an idle TTL unless you pass one. The fallback context uses a standalone registry with a 400 ms default idle TTL, so a lone hook still works without a provider.

Mental model: the hooks are the only React-specific code. `useAtomValue` subscribes and re-renders on change; `useAtom` adds a setter; `useAtomSuspense` throws a promise while the result is `Initial` so a `<Suspense>` boundary shows the fallback (and throws the squashed cause for an error boundary unless you pass `includeFailure`).

```tsx
import { RegistryProvider, useAtomValue, useAtom } from "@effect/atom-react"
import { Atom } from "effect/unstable/reactivity"

// A writable atom for a proposed raise %, and a derived preview of the new base.
const proposedRaisePct = Atom.make(4)
const newBasePreview = Atom.make((get) => Math.round(120000 * (1 + get(proposedRaisePct) / 100)))

function RaiseSlider() {
  const [pct, setPct] = useAtom(proposedRaisePct) // [value, setter]
  const newBase = useAtomValue(newBasePreview)    // read-only, re-renders on change
  return (
    <label>
      Raise {pct}% → new base ${newBase.toLocaleString()}
      <input
        type="range" min={0} max={20} value={pct}
        onChange={(e) => setPct(e.target.valueAsNumber)}
      />
    </label>
  )
}

export function App() {
  return (
    <RegistryProvider>
      <RaiseSlider />
    </RegistryProvider>
  )
}
```

### End-to-end: effectful atom → AsyncResult → React

A query atom from `AtomHttpApi` (or an RPC client) produces an `AsyncResult`; the component reads it with `useAtomValue` and renders the four states with `AsyncResult.matchWithWaiting`. No `useEffect`, no manual loading flags, no race conditions.

```tsx
import { Option } from "effect"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/unstable/reactivity"

// `CompClient` is the AtomHttpApi.Service from the AtomHttpApi section above.
const summary1042 = CompClient.query("comp", "getCompSummary", {
  params: { id: 1042 },
  serializationKey: "comp:1042"
})

function CompSummaryCard() {
  const result = useAtomValue(summary1042) // AsyncResult<CompSummary, never>

  return AsyncResult.matchWithWaiting(result, {
    // Initial or revalidating: keep showing the last good summary if we have it.
    onWaiting: (r) =>
      Option.match(AsyncResult.value(r), {
        onNone: () => <p>Loading compensation…</p>,
        onSome: (s) => (
          <p aria-busy="true">Refreshing employee {s.employeeId}: ${s.baseSalary.toLocaleString()}</p>
        )
      }),
    onError: (e) => <p role="alert">Declared endpoint error: {String(e)}</p>,
    onDefect: (d) => <p role="alert">Unexpected defect: {String(d)}</p>,
    onSuccess: (s) => (
      <div>
        <h3>Employee {s.value.employeeId}</h3>
        <p>Base salary: ${s.value.baseSalary.toLocaleString()}</p>
        <p>Level: {s.value.level}</p>
      </div>
    )
  })
}
```

> **Tip:** Prefer Suspense over manual matching? `const s = useAtomSuspense(summary1042)` returns the `Success` directly and suspends while `Initial` — wrap the component in `<Suspense fallback>` and an error boundary. For SSR, render on the server with a registry, `Hydration.dehydrate` it, ship the packet, and feed it to `<HydrationBoundary state={packet}>` on the client.

**Reach for it when** building UI: `useAtom` for local writable state, `useAtomValue` + `matchWithWaiting` (or `useAtomSuspense`) for fetched data, `useAtomSet` for mutations, and `RegistryProvider`/`HydrationBoundary` at the edges.
