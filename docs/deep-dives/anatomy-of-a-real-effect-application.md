# Anatomy of a Real Effect Application

This guide turns Effect's core primitives into one application shape. It targets `effect@4.0.0-rc.108`: domain values are Schemas, expected failures are tagged errors, behavior lives behind services, Layers own construction and cleanup, and the runtime is called only at an application edge.

Use the concise references when you need the complete API surface: [Core Runtime & Execution](../foundations/core-runtime-execution), [Services, Context & Layers](../foundations/services-context-layers), [Configuration & Secrets](../foundations/configuration-secrets), [Errors, Option & Result](../foundations/errors-option-result), [Schema](../data/schema), [Observability](../operations/observability), and [Testing & Dev Tooling](../tooling/testing-dev-tooling).

## The application shape

An Effect application is easiest to reason about as four concentric boundaries:

1. **Domain** — schemas, domain values, and expected errors. It knows nothing about databases, HTTP, or process startup.
2. **Capabilities** — service interfaces such as `EmployeeRepository` or `AuditLog`. Business logic depends on these interfaces through the Effect requirement channel.
3. **Implementations** — Layers that construct capabilities from configuration and lower-level services, and own any acquired resources.
4. **Edges** — an HTTP server, CLI, worker, test, or framework adapter that provides the completed Layer graph and runs the Effect.

Dependencies point inward. Domain logic never calls `Effect.runPromise`, reads `process.env`, creates an SDK client, or chooses a database driver. Those decisions belong at the outer edge.

### A practical source tree

> **Example status — Illustrative:** the names are a project layout, not library API.

```text
src/
  domain/
    Employee.ts          # Schema values and tagged domain errors
  services/
    EmployeeRepository.ts # capability only
    Compensation.ts       # use-case service
  layers/
    EmployeeRepositoryMemory.ts
    EmployeeRepositorySql.ts
    AppConfig.ts
  api/
    Api.ts                # transport contract, safe for clients to import
    Handlers.ts           # server implementation
  AppLive.ts              # production Layer graph
  Main.ts                 # the only process-runtime edge
test/
  Compensation.test.ts
```

Separate files are useful because they enforce ownership. They are not a reason to create a service for every helper: keep pure calculations as ordinary functions and introduce a service when behavior needs substitution, lifecycle, configuration, or another Effect capability.

## Model the boundary once

The domain schema should describe both the runtime value and the representation that crosses a boundary. A branded identifier prevents accidental mixing, a class gives the domain a named value, and tagged schema errors stay typed and serializable.

> **Example status — Runnable:** this block runs with the published `effect` package.

```ts
import { Effect, Schema } from "effect"

const EmployeeId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("EmployeeId")
)
type EmployeeId = typeof EmployeeId.Type

class Employee extends Schema.Class<Employee>("handbook/Employee")({
  id: EmployeeId,
  name: Schema.String.check(Schema.isMinLength(1)),
  baseSalary: Schema.Finite.check(Schema.isGreaterThan(0))
}) {}

class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()(
  "EmployeeNotFound",
  { id: EmployeeId }
) {}

class RaiseRejected extends Schema.TaggedError<RaiseRejected>()(
  "RaiseRejected",
  {
    id: EmployeeId,
    requestedPercent: Schema.Finite,
    maximumPercent: Schema.Finite
  }
) {}

const decodeEmployee = Schema.decodeUnknownEffect(Employee)

const program = Effect.gen(function*() {
  const employee = yield* decodeEmployee({
    id: 42,
    name: "Ada Lovelace",
    baseSalary: 120_000
  })
  return employee.id
})

console.log(await Effect.runPromise(program)) // 42, typed as EmployeeId
```

Decode unknown data at ingress and pass decoded values inward. Do not make every service re-parse the same object, and do not replace validation with `as Employee`. See [Schema — From External Input to Domain and Back](schema-from-external-input-to-domain-and-back) for the full boundary journey.

## Define capabilities before implementations

`Context.Service` describes what domain logic may do. Its methods return Effects so success, expected failure, and required dependencies remain visible in their types.

The implementation is a Layer. Naming a dependency-free implementation `layerNoDeps` makes the eventual wiring graph readable; a convenient `layer` may provide a normal production dependency when there is one unambiguous default.

> **Example status — Contextual:** place this after the domain definitions above. Every library import used by the block is included.

```ts
import { Context, Effect, Layer } from "effect"

class EmployeeRepository extends Context.Service<EmployeeRepository, {
  readonly findById: (
    id: EmployeeId
  ) => Effect.Effect<Employee, EmployeeNotFound>
  readonly save: (employee: Employee) => Effect.Effect<void>
}>()("handbook/EmployeeRepository") {
  static layerMemory = (seed: ReadonlyArray<Employee>) =>
    Layer.sync(EmployeeRepository, () => {
      const rows = new Map<number, Employee>(seed.map((employee) => [employee.id, employee]))
      return EmployeeRepository.of({
        findById: Effect.fn("EmployeeRepository.findById")(function*(id) {
          const employee = rows.get(id)
          if (employee === undefined) {
            return yield* new EmployeeNotFound({ id })
          }
          return employee
        }),
        save: Effect.fn("EmployeeRepository.save")(function*(employee) {
          rows.set(employee.id, employee)
        })
      })
    })
}

class Compensation extends Context.Service<Compensation, {
  readonly approveRaise: (
    id: EmployeeId,
    percent: number
  ) => Effect.Effect<Employee, EmployeeNotFound | RaiseRejected>
}>()("handbook/Compensation") {
  static layerNoDeps = Layer.effect(
    Compensation,
    Effect.gen(function*() {
      const employees = yield* EmployeeRepository
      const maximumPercent = 0.2

      return Compensation.of({
        approveRaise: Effect.fn("Compensation.approveRaise")(function*(id, percent) {
          if (percent < 0 || percent > maximumPercent) {
            return yield* new RaiseRejected({
              id,
              requestedPercent: percent,
              maximumPercent
            })
          }
          const current = yield* employees.findById(id)
          const updated = new Employee({
            id: current.id,
            name: current.name,
            baseSalary: current.baseSalary * (1 + percent)
          })
          yield* employees.save(updated)
          return updated
        })
      })
    })
  )
}
```

The use-case implementation reads `EmployeeRepository` once while its Layer is built. Callers see only the `Compensation` requirement; they do not know whether the repository is memory, SQL, or an HTTP client.

## Let Layers own resources and configuration

A Layer's build runs in a Scope. `Effect.acquireRelease` acquired inside `Layer.effect` is therefore released when the Layer is torn down, including after failure or interruption. Read configuration during construction rather than throughout business logic, and keep secrets redacted until the concrete client requires their raw value.

> **Example status — Contextual:** this is the production implementation of an application capability. `AuditClient` represents a third-party SDK supplied by the application.

```ts
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"

interface AuditClient {
  readonly write: (event: string) => Promise<void>
  readonly close: () => Promise<void>
}

declare const connectAuditClient: (options: {
  readonly endpoint: string
  readonly token: string
}) => Promise<AuditClient>

class AuditError extends Schema.TaggedError<AuditError>()("AuditError", {
  cause: Schema.Defect()
}) {}

class AuditLog extends Context.Service<AuditLog, {
  readonly write: (event: string) => Effect.Effect<void, AuditError>
}>()("handbook/AuditLog") {
  static layer = Layer.effect(
    AuditLog,
    Effect.gen(function*() {
      const endpoint = yield* Config.string("AUDIT_ENDPOINT")
      const token = yield* Config.redacted("AUDIT_TOKEN")
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => connectAuditClient({ endpoint, token: Redacted.value(token) }),
          catch: (cause) => new AuditError({ cause })
        }),
        (client) => Effect.promise(() => client.close())
      )

      return AuditLog.of({
        write: Effect.fn("AuditLog.write")((event: string) =>
          Effect.tryPromise({
            try: () => client.write(event),
            catch: (cause) => new AuditError({ cause })
          })
        )
      })
    })
  )
}
```

Do not acquire a resource outside Effect and then merely place it in a Layer: the Layer cannot finalize what it does not own. Conversely, do not wrap an already-managed Layer in a new manual Scope. Compose it and let one outer runtime close the graph.

## Assemble one graph at the edge

Build named Layer values and reuse them. Layer memoization is based on Layer object identity inside a build, so recreating an equivalent expression is not the same as sharing the same value.

> **Example status — Contextual:** it uses the services defined above and supplies an application seed.

```ts
import { Effect, Layer, Schema } from "effect"

const employeeId = Schema.decodeUnknownSync(EmployeeId)(42)
const EmployeeRepositoryLive = EmployeeRepository.layerMemory([
  new Employee({ id: employeeId, name: "Ada Lovelace", baseSalary: 120_000 })
])

const CompensationLive = Compensation.layerNoDeps.pipe(
  Layer.provide(EmployeeRepositoryLive)
)

const AppLive = Layer.merge(CompensationLive, AuditLog.layer)

const approve = Effect.gen(function*() {
  const compensation = yield* Compensation
  const audit = yield* AuditLog
  const employee = yield* compensation.approveRaise(employeeId, 0.08)
  yield* audit.write(`raise-approved:${employee.id}`)
  return employee
})

export const program = approve.pipe(Effect.provide(AppLive))
```

Use `Layer.provide(dependency)` when the dependency is an implementation detail and should disappear from the output. Use `Layer.provideMerge(dependency)` only when callers genuinely need both services. `Layer.merge` combines independent outputs. Avoid exposing every low-level service “just in case”; the remaining requirement type should describe the application's public capabilities.

## Choose the correct runtime edge

There are three common edges, and choosing the wrong one usually creates lifecycle problems.

### An Effect-native process

For a one-shot program, provide the Layer and pass the resulting Effect to the host runtime. For a server or permanent background process represented as Layers, `Layer.launch` keeps the graph alive until interruption. `NodeRuntime.runMain` and its Bun/Deno equivalents install process signal handling and map the final `Exit` to process termination.

> **Example status — Contextual:** this is an application entrypoint and requires `@effect/platform-node` at the same release line as `effect`.

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { AppLive, program } from "./AppLive.ts"

// One-shot command or batch:
program.pipe(NodeRuntime.runMain)

// A long-running app would instead launch its server/background Layer:
// Layer.launch(ServerLive.pipe(Layer.provide(AppLive))).pipe(NodeRuntime.runMain)
```

### A non-Effect host

When Hono, Express, a UI framework, or another callback-driven host owns execution, construct one `ManagedRuntime` for the application Layer, reuse it for every callback, and dispose it during host shutdown. Creating one runtime per request defeats Layer sharing and leaks resources if it is not disposed.

> **Example status — Contextual:** `handleRequest` is the callback exposed to the external host.

```ts
import { Effect, ManagedRuntime } from "effect"
import { AppLive } from "./AppLive.ts"
import { Compensation, employeeId } from "./domain.ts"

const runtime = ManagedRuntime.make(AppLive)

export const handleRequest = () =>
  runtime.runPromise(
    Compensation.use((service) => service.approveRaise(employeeId, 0.05))
  )

export const shutdown = () => runtime.dispose()
```

### A Web-standard handler

For serverless and edge hosts, prefer the HTTP adapter's layer-backed Web handler. Retain and call its `dispose` function; it owns the constructed Layer graph. The detailed choices live in [HTTP Server](../interfaces/http-server#httpeffect).

## A runnable vertical slice

This compact capstone keeps the same boundaries in one file: Schema values, tagged errors, a repository capability, a use-case service, a replaceable Layer, and one runtime call at the edge.

> **Example status — Runnable:** no ambient declarations or external services are required.

```ts
import { Context, Effect, Layer, Schema } from "effect"

const Id = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("Id"))
type Id = typeof Id.Type

class Account extends Schema.Class<Account>("handbook/Account")({
  id: Id,
  balance: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

class AccountNotFound extends Schema.TaggedError<AccountNotFound>()(
  "AccountNotFound",
  { id: Id }
) {}

class Accounts extends Context.Service<Accounts, {
  readonly get: (id: Id) => Effect.Effect<Account, AccountNotFound>
  readonly put: (account: Account) => Effect.Effect<void>
}>()("handbook/Accounts") {}

const AccountsMemory = (initial: ReadonlyArray<Account>) =>
  Layer.sync(Accounts, () => {
    const rows = new Map<number, Account>(initial.map((account) => [account.id, account]))
    return Accounts.of({
      get: Effect.fn("Accounts.get")(function*(id) {
        const account = rows.get(id)
        if (account === undefined) return yield* new AccountNotFound({ id })
        return account
      }),
      put: (account) => Effect.sync(() => void rows.set(account.id, account))
    })
  })

class Deposits extends Context.Service<Deposits, {
  readonly deposit: (id: Id, amount: number) => Effect.Effect<Account, AccountNotFound>
}>()("handbook/Deposits") {
  static layer = Layer.effect(
    Deposits,
    Effect.gen(function*() {
      const accounts = yield* Accounts
      return Deposits.of({
        deposit: Effect.fn("Deposits.deposit")(function*(id, amount) {
          const current = yield* accounts.get(id)
          const updated = new Account({ id, balance: current.balance + amount })
          yield* accounts.put(updated)
          yield* Effect.logInfo("deposit completed", { accountId: id, amount })
          return updated
        })
      })
    })
  )
}

const id = Schema.decodeUnknownSync(Id)(1)
const TestLive = Deposits.layer.pipe(
  Layer.provide(AccountsMemory([new Account({ id, balance: 100 })]))
)

const program = Deposits.use((service) => service.deposit(id, 25)).pipe(
  Effect.provide(TestLive)
)

console.log((await Effect.runPromise(program)).balance) // 125
```

The in-memory Layer is not “test code inside production logic.” It is one implementation of a stable capability. A SQL implementation can replace it without changing `Deposits` or its callers.

## Test at the capability boundary

Test the use case with a small Layer graph. Use a fresh in-memory Layer per test when isolation matters; `layer(...)` deliberately shares one built graph across its whole block.

> **Example status — Contextual:** place this beside the runnable capstone and execute it with Vitest 4.1+ and `@effect/vitest`.

```ts
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

describe("Deposits", () => {
  it.effect("updates the balance", () => {
    const IsolatedLive = Deposits.layer.pipe(
      Layer.provide(AccountsMemory([new Account({ id, balance: 100 })]))
    )

    return Effect.gen(function*() {
      const deposits = yield* Deposits
      const updated = yield* deposits.deposit(id, 25)
      assert.strictEqual(updated.balance, 125)
    }).pipe(Effect.provide(IsolatedLive))
  })
})
```

An application test should prove observable behavior and important lifetime semantics, not merely that a Layer builds. Add focused tests for typed failures, cleanup after interruption, retry decisions, and boundary round-trips where those are part of the contract.

## Operational checklist

- Decode unknown input once at each ingress; keep decoded domain values inside.
- Define expected errors as specific tagged values. Do not turn every failure into a defect.
- Keep pure calculations as functions; use services for replaceable or effectful capabilities.
- Give resource acquisition to the Layer that owns its lifetime and verify finalization.
- Name and reuse shared Layer values; use `Layer.fresh` only when a second instance is intentional.
- Hide implementation dependencies with `Layer.provide`; expose only capabilities callers need.
- Read config and unwrap secrets at the concrete integration boundary, not in domain logic.
- Add spans with `Effect.fn("qualified.name")`, and log/measure once at the boundary that owns an operation.
- Run the runtime only at an entrypoint, framework adapter, or test edge.
- Use one long-lived `ManagedRuntime` per external host integration and always dispose it.
- Prefer host `runMain` for Effect-native processes so signals interrupt the root and close scopes.
- Build a fresh test Layer for isolated tests; use shared Layer test blocks only deliberately.

The essential architecture is small: **Schema defines what crosses boundaries; services define what the application can do; Layers decide how and for how long; one outer runtime makes it happen.**
