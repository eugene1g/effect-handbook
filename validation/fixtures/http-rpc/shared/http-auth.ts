import { Context, Schema } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import type { Employee } from "./http-domain.ts"

export class CurrentUser extends Context.Service<CurrentUser, Employee>()(
  "fixtures/CurrentUser"
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 }
) {}

export class Authorization extends HttpApiMiddleware.Service<Authorization, {
  provides: CurrentUser
  requires: never
}>()("fixtures/Authorization", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}
