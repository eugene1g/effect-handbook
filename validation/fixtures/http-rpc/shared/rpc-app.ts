import { BigDecimal, Context, Effect, Layer, Schema } from "effect"
import { Rpc, RpcClient, RpcGroup, RpcMiddleware } from "effect/unstable/rpc"

export class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()("EmployeeNotFound", {
  employeeId: Schema.String
}) {}

export class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()("BudgetExceeded", {
  employeeId: Schema.String,
  requested: Schema.BigDecimal
}) {}

export class Compensation extends Schema.Class<Compensation>("Compensation")({
  employeeId: Schema.String,
  level: Schema.Int,
  baseSalary: Schema.BigDecimal
}) {}

export class CompRpc extends RpcGroup.make(
  Rpc.make("GetComp", {
    payload: { employeeId: Schema.String },
    success: Compensation,
    error: EmployeeNotFound
  }),
  Rpc.make("ProposeRaise", {
    payload: { employeeId: Schema.String, amount: Schema.BigDecimal },
    success: Compensation,
    error: Schema.Union([EmployeeNotFound, BudgetExceeded])
  }),
  Rpc.make("ApproveGrant", {
    payload: { employeeId: Schema.String, shares: Schema.Natural },
    success: Schema.Void
  })
) {}

class CompService extends Context.Service<CompService>()("fixtures/RpcCompService", {
  make: Effect.succeed({
    find: (employeeId: string) => employeeId === "E-1"
      ? Effect.succeed(new Compensation({
          employeeId,
          level: 4,
          baseSalary: BigDecimal.fromBigInt(180_000n)
        }))
      : Effect.fail(new EmployeeNotFound({ employeeId })),
    raise: (employeeId: string, amount: BigDecimal.BigDecimal) =>
      Effect.succeed(new Compensation({
        employeeId,
        level: 4,
        baseSalary: BigDecimal.sum(BigDecimal.fromBigInt(180_000n), amount)
      })),
    grant: (_employeeId: string, _shares: number) => Effect.void
  })
}) {}

const CompServiceLive = Layer.effect(CompService, CompService.make)

export const CompLive = CompRpc.toLayer(
  Effect.gen(function*() {
    const comp = yield* CompService
    return {
      GetComp: ({ employeeId }) => comp.find(employeeId),
      ProposeRaise: ({ employeeId, amount }) => comp.raise(employeeId, amount),
      ApproveGrant: ({ employeeId, shares }) => comp.grant(employeeId, shares)
    }
  })
).pipe(Layer.provide(CompServiceLive))

export class CurrentManager extends Context.Service<CurrentManager, {
  readonly id: string
}>()("fixtures/CurrentManager") {}

export class Authenticated extends RpcMiddleware.Service<Authenticated, {
  provides: CurrentManager
}>()("fixtures/Authenticated") {}

const clientEffect = RpcClient.make(CompRpc)
export type CompClient = Effect.Success<typeof clientEffect>
