import assert from "node:assert/strict"
import { Context, Effect, Exit, Layer, Queue, Schema } from "effect"
import {
  AsyncResult,
  Atom,
  AtomRegistry,
  Hydration,
  Reactivity
} from "effect/unstable/reactivity"

const family = Atom.family((id: number) => Atom.make(id))
assert.equal(family(1), family(1), "Atom.family must return the same live atom for an equal argument")
assert.notEqual(family(1), family(2), "Atom.family must distinguish unequal arguments")

const count = Atom.make(1)
const doubled = Atom.make((get) => get(count) * 2)
const derivedRegistry = AtomRegistry.make()
assert.equal(derivedRegistry.get(doubled), 2)
derivedRegistry.set(count, 5)
assert.equal(derivedRegistry.get(doubled), 10, "derived atoms must observe writes to tracked dependencies")
derivedRegistry.dispose()

const reactivity = Effect.runSync(Reactivity.make)
let invalidations = 0
const unregister = reactivity.registerUnsafe(["todos"], () => invalidations++)

Effect.runSync(reactivity.mutation(["todos"], Effect.succeed("ok")))
assert.equal(invalidations, 1, "successful mutation must invalidate")

const failed = Effect.runSyncExit(reactivity.mutation(["todos"], Effect.fail("nope")))
assert(Exit.isFailure(failed))
assert.equal(invalidations, 1, "failed mutation must not invalidate")

Effect.runSync(
  reactivity.withBatch(
    Effect.all([
      reactivity.mutation(["todos"], Effect.succeed(1)),
      reactivity.mutation(["todos"], Effect.succeed(2))
    ])
  )
)
assert.equal(invalidations, 2, "a batch must flush the same invalidation key once")
unregister()

let queryRuns = 0
const queryValues = Effect.runSync(
  Effect.scoped(
    Effect.gen(function*() {
      const queue = yield* reactivity.query(
        ["query-key"],
        Effect.sync(() => ++queryRuns)
      )
      const initial = yield* Queue.take(queue)
      yield* reactivity.invalidate(["query-key"])
      const refreshed = yield* Queue.take(queue)
      return [initial, refreshed] as const
    })
  )
)
assert.deepEqual(queryValues, [1, 2], "query must enqueue an initial value and a refreshed value")

const serializable = Atom.make("server-initial").pipe(
  Atom.serializable({ key: "probe:draft", schema: Schema.String })
)
const serverRegistry = AtomRegistry.make()
serverRegistry.set(serializable, "server-value")
const dehydrated = Hydration.dehydrate(serverRegistry)
assert.equal(dehydrated.length, 1)

const clientRegistry = AtomRegistry.make()
Hydration.hydrate(clientRegistry, dehydrated)
assert.equal(clientRegistry.get(serializable), "server-value", "hydrate-before-read must preload serializable state")
serverRegistry.dispose()
clientRegistry.dispose()

const syncFn = Atom.fn((value: number) => Effect.succeed(value))
const fnRegistry = AtomRegistry.make()
fnRegistry.set(syncFn, 42)
const syncFnResult = fnRegistry.get(syncFn)
assert(AsyncResult.isSuccess(syncFnResult))
assert.equal(syncFnResult.value, 42)
assert.equal(syncFnResult.waiting, false, "a synchronous Atom.fn may complete without exposing a waiting state")
fnRegistry.set(syncFn, Atom.Reset)
assert(AsyncResult.isInitial(fnRegistry.get(syncFn)), "Atom.Reset must restore Initial")
fnRegistry.dispose()

class ProbeTodoApi extends Context.Service<
  ProbeTodoApi,
  { readonly list: Effect.Effect<ReadonlyArray<string>> }
>()("probe/TodoApi") {}
const probeRuntime = Atom.runtime(
  Layer.succeed(ProbeTodoApi, ProbeTodoApi.of({ list: Effect.succeed(["live"]) }))
)
const probeTodos = probeRuntime.atom(ProbeTodoApi.use((api) => api.list))
const probeTestLayer = Layer.succeed(
  ProbeTodoApi,
  ProbeTodoApi.of({ list: Effect.succeed([]) })
)
const injectedRegistry = AtomRegistry.make({
  initialValues: [Atom.initialValue(probeRuntime.layer, probeTestLayer)]
})
assert.deepEqual(
  await Effect.runPromise(AtomRegistry.getResult(injectedRegistry, probeTodos)),
  [],
  "an initial value for runtime.layer must inject the test layer into runtime atoms"
)
injectedRegistry.dispose()

const failure = AsyncResult.fail("typed-error")
assert.equal(
  AsyncResult.matchWithWaiting(failure, {
    onWaiting: () => "waiting",
    onError: (error) => error,
    onDefect: () => "defect",
    onSuccess: () => "success"
  }),
  "typed-error",
  "matchWithWaiting must route typed failures to onError"
)

console.log(JSON.stringify({
  target: "effect@4.0.0-rc.108",
  probes: 13,
  status: "pass"
}))
