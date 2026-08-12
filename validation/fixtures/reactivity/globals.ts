import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { RpcClient } from "effect/unstable/rpc"
import {
  AsyncResult,
  Atom,
  AtomHttpApi,
  AtomRegistry,
  Hydration
} from "effect/unstable/reactivity"
import type { ReactNode } from "react"

interface FixtureEmployee {
  readonly id: string
}

interface FixtureEquityGrant {
  readonly employeeId: string
  readonly vestedShares: number
}

interface FixtureHrisUnavailable {
  readonly _tag: "HrisUnavailable"
}

interface FixtureCompSummary {
  readonly employeeId: number
  readonly employeeName: string
  readonly baseSalary: number
  readonly proposedBase: number
  readonly level: string
}

interface FixtureRaiseRecommendation {
  readonly employeeId: string
  readonly percent: number
}

interface FixtureTodo {
  readonly id: number
  readonly text: string
  readonly done: boolean
}

class FixtureCompService extends Context.Service<
  FixtureCompService,
  {
    readonly listEmployees: (department: string) => Effect.Effect<ReadonlyArray<FixtureEmployee>>
  }
>()("fixtures/CompService") {}

const fixtureCompServiceLayer = Layer.succeed(
  FixtureCompService,
  FixtureCompService.of({
    listEmployees: (department) => Effect.succeed([{ id: `${department}:1` }])
  })
)

const FixtureCompServiceWithLayer = Object.assign(FixtureCompService, {
  layer: fixtureCompServiceLayer
})

class FixtureApi extends Context.Service<
  FixtureApi,
  {
    readonly list: Effect.Effect<ReadonlyArray<FixtureTodo>>
    readonly prices: Effect.Effect<ReadonlyArray<number>>
    readonly add: (text: string) => Effect.Effect<FixtureTodo>
    readonly toggle: (id: number) => Effect.Effect<FixtureTodo>
    readonly getById: (id: number) => Effect.Effect<FixtureTodo>
  }
>()("fixtures/Api") {}

const fixtureApiLayer = Layer.succeed(
  FixtureApi,
  FixtureApi.of({
    list: Effect.succeed([]),
    prices: Effect.succeed([]),
    add: (text) => Effect.succeed({ id: 1, text, done: false }),
    toggle: (id) => Effect.succeed({ id, text: "", done: true }),
    getById: (id) => Effect.succeed({ id, text: `todo-${id}`, done: false })
  })
)

const fixtureRuntime = Atom.runtime(fixtureApiLayer)
const fixtureRegistry = AtomRegistry.make()
const fixtureTodos = fixtureRuntime.atom(FixtureApi.use((api) => api.list))
const fixtureAddTodo = fixtureRuntime.fn((text: string) => FixtureApi.use((api) => api.add(text)))

const FixtureCompSummarySchema = {
  employeeId: 0,
  employeeName: "",
  baseSalary: 0,
  proposedBase: 0,
  level: ""
} satisfies FixtureCompSummary
void FixtureCompSummarySchema

const CompSummaryHttp = HttpApi.make("fixture-comp").add(
  HttpApiGroup.make("comp").add(
    HttpApiEndpoint.get("getCompSummary", "/employees/:id/comp", {
      params: { id: Schema.FiniteFromString },
      success: Schema.Struct({
        employeeId: Schema.Int,
        employeeName: Schema.String,
        baseSalary: Schema.Finite,
        proposedBase: Schema.Finite,
        level: Schema.String
      })
    })
  )
)

const FixtureCompClient = AtomHttpApi.Service()("fixtures/CompClient", {
  api: CompSummaryHttp,
  httpClient: Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("type-only fixture: no network request expected"))
  )
})

const fixtureServerRegistry = AtomRegistry.make()
const fixtureClientRegistry = AtomRegistry.make()
const fixtureProtocolLive = Layer.empty as Layer.Layer<RpcClient.Protocol>

declare global {
  type EquityGrant = FixtureEquityGrant
  type HrisUnavailable = FixtureHrisUnavailable
  type CompSummary = FixtureCompSummary
  type RaiseRecommendation = FixtureRaiseRecommendation
  type Todo = FixtureTodo

  const fetchEquityGrant: (employeeId: string) => Effect.Effect<FixtureEquityGrant, FixtureHrisUnavailable>
  const computeCompSummary: (
    employeeId: string,
    proposedRaisePct: number
  ) => Effect.Effect<FixtureCompSummary, FixtureHrisUnavailable>

  const CompService: typeof FixtureCompServiceWithLayer
  const ProtocolLive: typeof fixtureProtocolLive
  const CompClient: typeof FixtureCompClient

  const Api: typeof FixtureApi
  const runtime: typeof fixtureRuntime
  const registry: typeof fixtureRegistry
  const todos: typeof fixtureTodos
  const addTodo: typeof fixtureAddTodo

  const insertTodo: (text: string) => Effect.Effect<FixtureTodo>
  const listTodos: Effect.Effect<ReadonlyArray<FixtureTodo>>
  const db: {
    readonly insertRaise: (recommendation: FixtureRaiseRecommendation) => Effect.Effect<void>
  }

  const serverRegistry: typeof fixtureServerRegistry
  const clientRegistry: typeof fixtureClientRegistry
  const TodoList: () => ReactNode

  interface Window {
    readonly __ATOMS__: ReadonlyArray<Hydration.DehydratedAtom>
  }
}

// Keep imported runtime types part of the fixture's checked surface.
void AsyncResult
