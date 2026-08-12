import { Context, Effect, Layer, Redacted, Schema } from "effect"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema
} from "effect/unstable/httpapi"
import { Authorization, CurrentUser, Unauthorized } from "./http-auth.ts"
import {
  BandViolation,
  CompRecord,
  Employee,
  EmployeeId,
  EmployeeNotFound,
  GrantInput,
  RaiseInput
} from "./http-domain.ts"

const getComp = HttpApiEndpoint.get("getComp", "/employees/:id/comp", {
  params: { id: Schema.FiniteFromString.pipe(Schema.decodeTo(EmployeeId)) },
  success: CompRecord,
  error: [EmployeeNotFound, BandViolation]
})

const postRaise = HttpApiEndpoint.post("postRaise", "/employees/:id/raise", {
  params: { id: Schema.FiniteFromString.pipe(Schema.decodeTo(EmployeeId)) },
  payload: RaiseInput,
  success: CompRecord,
  error: BandViolation
})

const postGrant = HttpApiEndpoint.post("postGrant", "/employees/:id/grants", {
  payload: GrantInput,
  success: HttpApiSchema.NoContent
})

const me = HttpApiEndpoint.get("me", "/me", { success: Employee })

export class CompGroup extends HttpApiGroup.make("comp")
  .add(getComp, postRaise, postGrant, me)
  .middleware(Authorization)
  .prefix("/comp") {}

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent })
) {}

export class Api extends HttpApi.make("fixture-api").add(CompGroup).add(SystemApi) {}

export class CompService extends Context.Service<CompService, {
  readonly getComp: (id: number) => Effect.Effect<CompRecord, EmployeeNotFound | BandViolation>
  readonly recordRaise: (id: number, input: RaiseInput) => Effect.Effect<CompRecord, BandViolation>
  readonly recordGrant: (input: GrantInput) => Effect.Effect<void>
}>()("fixtures/CompService") {
  static readonly layer = Layer.succeed(this)({
    getComp: (id) => id === 999
      ? Effect.fail(new BandViolation({ message: "invalid band" }))
      : id > 0
      ? Effect.succeed(new CompRecord({ employeeId: id, level: 4, baseSalary: 180_000 }))
      : Effect.fail(new EmployeeNotFound()),
    recordRaise: (id, input) => input.amount >= 0
      ? Effect.succeed(new CompRecord({ employeeId: id, level: 4, baseSalary: 180_000 + input.amount }))
      : Effect.fail(new BandViolation({ message: "negative raise" })),
    recordGrant: (_input) => Effect.void
  })
}

export const AuthorizationLayer = Layer.effect(
  Authorization,
  Effect.succeed(Authorization.of({
    bearer: (httpEffect, { credential }) =>
      Redacted.value(credential) === "hrbp-token"
        ? Effect.provideService(
            httpEffect,
            CurrentUser,
            new Employee({ id: 1, name: "Dana HRBP", level: 6, baseSalary: 0 })
          )
        : Effect.fail(new Unauthorized({ message: "Invalid bearer token" }))
  }))
)

export const CompApiHandlers = HttpApiBuilder.group(
  Api,
  "comp",
  Effect.fn(function*(handlers) {
    const comp = yield* CompService
    return handlers
      .handle("getComp", ({ params }) =>
        comp.getComp(params.id).pipe(Effect.catchTag("BandViolation", Effect.die)))
      .handle("postRaise", ({ params, payload }) => comp.recordRaise(params.id, payload))
      .handle("postGrant", ({ payload }) => comp.recordGrant(payload).pipe(Effect.orDie))
      .handle("me", () => CurrentUser)
  })
).pipe(Layer.provide([CompService.layer, AuthorizationLayer]))

export const SystemApiHandlers = HttpApiBuilder.group(
  Api,
  "system",
  (handlers) => handlers.handle("health", () => Effect.void)
)
