// Scaffolds for contextual Markdown examples whose surrounding declarations live
// in earlier sections of the same guide. The validation materializer inserts the
// canonical fence body between `prefix` and `suffix`; this file never stores a
// quoted or rewritten copy of that body.

const applicationDomainPrefix = `import { Schema as FixtureSchema } from "effect"

const EmployeeId = FixtureSchema.Int.check(FixtureSchema.isGreaterThan(0)).pipe(
  FixtureSchema.brand("FixtureEmployeeId")
)
type EmployeeId = typeof EmployeeId.Type

class Employee extends FixtureSchema.Class<Employee>("fixture/Employee")({
  id: EmployeeId,
  name: FixtureSchema.String,
  baseSalary: FixtureSchema.Finite
}) {}

class EmployeeNotFound extends FixtureSchema.TaggedError<EmployeeNotFound>()(
  "EmployeeNotFound",
  { id: EmployeeId }
) {}

class RaiseRejected extends FixtureSchema.TaggedError<RaiseRejected>()(
  "RaiseRejected",
  {
    id: EmployeeId,
    requestedPercent: FixtureSchema.Finite,
    maximumPercent: FixtureSchema.Finite
  }
) {}

`

const applicationLayerPrefix = `import {
  Context as FixtureContext,
  Effect as FixtureEffect,
  Layer as FixtureLayer,
  Schema as FixtureSchema
} from "effect"

const EmployeeId = FixtureSchema.Int.check(FixtureSchema.isGreaterThan(0)).pipe(
  FixtureSchema.brand("FixtureLayerEmployeeId")
)
type EmployeeId = typeof EmployeeId.Type

class Employee extends FixtureSchema.Class<Employee>("fixture/LayerEmployee")({
  id: EmployeeId,
  name: FixtureSchema.String,
  baseSalary: FixtureSchema.Finite
}) {}

class EmployeeRepository extends FixtureContext.Service<EmployeeRepository, {
  readonly findById: (id: EmployeeId) => FixtureEffect.Effect<Employee>
}>()("fixture/LayerEmployeeRepository") {
  static layerMemory = (seed: ReadonlyArray<Employee>) =>
    FixtureLayer.sync(EmployeeRepository, () => {
      const rows = new Map<number, Employee>(seed.map((employee) => [employee.id, employee]))
      return EmployeeRepository.of({
        findById: (id) => FixtureEffect.succeed(rows.get(id) ?? seed[0]!)
      })
    })
}

class Compensation extends FixtureContext.Service<Compensation, {
  readonly approveRaise: (id: EmployeeId, percent: number) => FixtureEffect.Effect<Employee>
}>()("fixture/LayerCompensation") {
  static layerNoDeps = FixtureLayer.effect(
    Compensation,
    FixtureEffect.map(EmployeeRepository, (employees) => Compensation.of({
      approveRaise: (id, percent) => FixtureEffect.map(
        employees.findById(id),
        (employee) => new Employee({
          id: employee.id,
          name: employee.name,
          baseSalary: employee.baseSalary * (1 + percent)
        })
      )
    }))
  )
}

class AuditLog extends FixtureContext.Service<AuditLog, {
  readonly write: (event: string) => FixtureEffect.Effect<void>
}>()("fixture/AuditLog") {
  static layer = FixtureLayer.succeed(AuditLog, AuditLog.of({
    write: () => FixtureEffect.void
  }))
}

`

const applicationTestPrefix = `import {
  Context as FixtureContext,
  Effect as FixtureEffect,
  Layer as FixtureLayer,
  Schema as FixtureSchema
} from "effect"

const AccountId = FixtureSchema.Int.check(FixtureSchema.isGreaterThan(0)).pipe(
  FixtureSchema.brand("FixtureAccountId")
)
type AccountId = typeof AccountId.Type

class Account extends FixtureSchema.Class<Account>("fixture/Account")({
  id: AccountId,
  balance: FixtureSchema.Finite
}) {}

class Accounts extends FixtureContext.Service<Accounts, {
  readonly get: (id: AccountId) => FixtureEffect.Effect<Account>
  readonly put: (account: Account) => FixtureEffect.Effect<void>
}>()("fixture/Accounts") {}

const AccountsMemory = (seed: ReadonlyArray<Account>) =>
  FixtureLayer.sync(Accounts, () => {
    const rows = new Map<number, Account>(seed.map((account) => [account.id, account]))
    return Accounts.of({
      get: (id) => FixtureEffect.succeed(rows.get(id) ?? seed[0]!),
      put: (account) => FixtureEffect.sync(() => void rows.set(account.id, account))
    })
  })

class Deposits extends FixtureContext.Service<Deposits, {
  readonly deposit: (id: AccountId, amount: number) => FixtureEffect.Effect<Account>
}>()("fixture/Deposits") {
  static layer = FixtureLayer.effect(
    Deposits,
    FixtureEffect.map(Accounts, (accounts) => Deposits.of({
      deposit: (id, amount) => FixtureEffect.gen(function*() {
        const account = yield* accounts.get(id)
        const updated = new Account({ id, balance: account.balance + amount })
        yield* accounts.put(updated)
        return updated
      })
    }))
  )
}

const id = FixtureSchema.decodeUnknownSync(AccountId)(1)

`

const failureTypesPrefix = `import { Schema as FixtureSchema } from "effect"

class EmployeeNotFound extends FixtureSchema.TaggedError<EmployeeNotFound>()(
  "EmployeeNotFound",
  { employeeId: FixtureSchema.String }
) {}

class HrisUnavailable extends FixtureSchema.TaggedError<HrisUnavailable>()(
  "HrisUnavailable",
  {
    operation: FixtureSchema.String,
    retryable: FixtureSchema.Boolean,
    cause: FixtureSchema.optionalKey(FixtureSchema.Defect())
  }
) {}

`

const failureRetryPrefix = `import {
  Schedule as FixtureSchedule,
  Schema as FixtureSchema
} from "effect"

class HrisUnavailable extends FixtureSchema.TaggedError<HrisUnavailable>()(
  "HrisUnavailable",
  {
    operation: FixtureSchema.String,
    retryable: FixtureSchema.Boolean,
    cause: FixtureSchema.optionalKey(FixtureSchema.Defect())
  }
) {}

const hrisRetry = FixtureSchedule.exponential("200 millis").pipe(
  FixtureSchedule.setInputType<HrisUnavailable>()
)

`

const schemaRequestPrefix = `import { Schema as FixtureSchema } from "effect"

const EmployeeId = FixtureSchema.Int.check(FixtureSchema.isGreaterThan(0)).pipe(
  FixtureSchema.brand("FixtureSchemaEmployeeId")
)
type EmployeeId = typeof EmployeeId.Type

const CreateGrantRequest = FixtureSchema.Struct({
  employeeId: EmployeeId,
  shares: FixtureSchema.Natural,
  grantedAt: FixtureSchema.DateFromString,
  note: FixtureSchema.optionalKey(FixtureSchema.String)
})
type CreateGrantRequest = typeof CreateGrantRequest.Type

`

const schemaGrantPrefix = `import { Schema as FixtureSchema } from "effect"

const FixtureGrantId = FixtureSchema.String.check(FixtureSchema.isMinLength(1)).pipe(
  FixtureSchema.brand("FixtureGrantId")
)
const FixtureEmployeeId = FixtureSchema.Int.check(FixtureSchema.isGreaterThan(0)).pipe(
  FixtureSchema.brand("FixtureGrantEmployeeId")
)

class Grant extends FixtureSchema.Class<Grant>("fixture/Grant")({
  id: FixtureGrantId,
  employeeId: FixtureEmployeeId,
  shares: FixtureSchema.Natural,
  grantedAt: FixtureSchema.Date,
  recordedAt: FixtureSchema.Date
}) {}

`

const schemaRoundTripPrefix = `import {
  Clock as FixtureClock,
  Effect as FixtureEffect,
  Schema as FixtureSchema
} from "effect"

const FixtureEmployeeId = FixtureSchema.Int.check(FixtureSchema.isGreaterThan(0)).pipe(
  FixtureSchema.brand("FixtureRoundTripEmployeeId")
)
const FixtureGrantId = FixtureSchema.String.check(FixtureSchema.isMinLength(1)).pipe(
  FixtureSchema.brand("FixtureRoundTripGrantId")
)
const FixtureRequest = FixtureSchema.Struct({
  employeeId: FixtureEmployeeId,
  shares: FixtureSchema.Natural,
  grantedAt: FixtureSchema.DateFromString
})

class Grant extends FixtureSchema.Class<Grant>("fixture/RoundTripGrant")({
  id: FixtureGrantId,
  employeeId: FixtureEmployeeId,
  shares: FixtureSchema.Natural,
  grantedAt: FixtureSchema.Date,
  recordedAt: FixtureSchema.Date
}) {}

const RequestJsonText = FixtureSchema.fromJsonString(FixtureRequest)
const GrantJsonText = FixtureSchema.fromJsonString(FixtureSchema.toCodecJson(Grant))

const accept = (input: string) => FixtureEffect.gen(function*() {
  const request = yield* FixtureSchema.decodeUnknownEffect(RequestJsonText)(input)
  const recordedAt = new Date(yield* FixtureClock.currentTimeMillis)
  const id = yield* FixtureSchema.decodeUnknownEffect(FixtureGrantId)(
    \`\${request.employeeId}:\${request.grantedAt.toISOString()}\`
  )
  return new Grant({ ...request, id, recordedAt })
})

`

const workerDomainPrefix = `import { Schema as FixtureSchema } from "effect"

class RecalculateEmployee extends FixtureSchema.Class<RecalculateEmployee>(
  "fixture/RecalculateEmployee"
)({
  jobId: FixtureSchema.String,
  employeeId: FixtureSchema.String,
  attempt: FixtureSchema.Natural
}) {}

class JobFailed extends FixtureSchema.TaggedError<JobFailed>()(
  "JobFailed",
  {
    jobId: FixtureSchema.String,
    retryable: FixtureSchema.Boolean,
    reason: FixtureSchema.String
  }
) {}

`

const appLiveSupport = `import { Context, Effect, Layer } from "effect"

export class Compensation extends Context.Service<Compensation, {
  readonly approveRaise: (id: number, percent: number) => Effect.Effect<number>
}>()("fixture/BoundaryCompensation") {}

export const AppLive = Layer.succeed(Compensation, Compensation.of({
  approveRaise: (id, percent) => Effect.succeed(id * (1 + percent))
}))

export const program = Compensation.use((service) =>
  service.approveRaise(42, 0.05)
).pipe(Effect.provide(AppLive), Effect.asVoid)
`

const applicationBoundaryDomainSupport = `export { Compensation } from "./AppLive.ts"
export const employeeId = 42
`

export const exactContextualGroups = {
  application: {
    files: {
      "application.repository-service": {
        destination: "repository-service.ts",
        prefix: applicationDomainPrefix
      },
      "application.live-layer-graph": {
        destination: "live-layer-graph.ts",
        prefix: applicationLayerPrefix
      },
      "application.node-entrypoint": {
        destination: "node-entrypoint.ts"
      },
      "application.managed-runtime-boundary": {
        destination: "managed-runtime-boundary.ts"
      },
      "application.capability-test": {
        destination: "capability-test.ts",
        prefix: applicationTestPrefix
      }
    },
    support: {
      "AppLive.ts": appLiveSupport,
      "domain.ts": applicationBoundaryDomainSupport
    }
  },
  failure: {
    files: {
      "failure.narrow-recovery": {
        destination: "narrow-recovery.ts",
        prefix: failureTypesPrefix
      },
      "failure.typed-retry-policy": {
        destination: "typed-retry-policy.ts",
        prefix: failureTypesPrefix
      },
      "failure.idempotent-retry": {
        destination: "idempotent-retry.ts",
        prefix: failureRetryPrefix
      }
    }
  },
  schema: {
    files: {
      "schema.grant-domain-model": {
        destination: "grant-domain-model.ts",
        prefix: schemaRequestPrefix
      },
      "schema.grant-json-codec": {
        destination: "grant-json-codec.ts",
        prefix: schemaGrantPrefix
      },
      "schema.derived-tooling": {
        destination: "derived-tooling.ts",
        prefix: schemaRequestPrefix
      },
      "schema.round-trip-test": {
        destination: "round-trip-test.ts",
        prefix: schemaRoundTripPrefix
      }
    }
  },
  worker: {
    files: {
      "worker.bounded-queue-pipeline": {
        destination: "bounded-queue-pipeline.ts",
        prefix: workerDomainPrefix
      },
      "worker.failure-as-result": {
        destination: "failure-as-result.ts",
        prefix: workerDomainPrefix
      },
      "worker.shared-semaphore": {
        destination: "shared-semaphore.ts",
        prefix: workerDomainPrefix
      },
      "worker.dynamic-fiber-set": {
        destination: "dynamic-fiber-set.ts",
        prefix: workerDomainPrefix
      }
    }
  }
}
