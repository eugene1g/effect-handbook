import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api, CompRecord } from "../../api/Api.ts"

export const CompApiHandlers = HttpApiBuilder.group(Api, "comp", (handlers) => handlers.handle("getComp", ({ params }) => Effect.succeed(new CompRecord({ employeeId: params.id }))))
