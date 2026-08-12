import { Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Rpc, RpcClient, RpcGroup } from "effect/unstable/rpc"

const FixtureHttpApi = HttpApi.make("fixture-http-api").add(
  HttpApiGroup.make("users")
    .add(
      HttpApiEndpoint.get("getUser", "/users/:id", {
        params: { id: Schema.FiniteFromString },
        success: Schema.Struct({ id: Schema.Finite, name: Schema.String })
      })
    )
    .add(
      HttpApiEndpoint.post("saveUser", "/users/:id", {
        params: { id: Schema.FiniteFromString },
        payload: Schema.Struct({ name: Schema.String }),
        success: Schema.Struct({ id: Schema.Finite, name: Schema.String })
      })
    )
)

const FixtureHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("type-only fixture: no network request expected"))
)

const FixtureRpcs = RpcGroup.make(
  Rpc.make("getProfile", {
    payload: { id: Schema.Finite },
    success: Schema.Struct({ id: Schema.Finite, name: Schema.String })
  }),
  Rpc.make("saveProfile", {
    payload: { id: Schema.Finite, name: Schema.String },
    success: Schema.Struct({ id: Schema.Finite, name: Schema.String })
  })
)

const FixtureRpcProtocol = Layer.empty as Layer.Layer<RpcClient.Protocol>

declare global {
  const Api: typeof FixtureHttpApi
  const HttpClientLive: typeof FixtureHttpClientLive
  const Rpcs: typeof FixtureRpcs
  const RpcProtocol: typeof FixtureRpcProtocol
  const ProtocolLive: typeof FixtureRpcProtocol
}
