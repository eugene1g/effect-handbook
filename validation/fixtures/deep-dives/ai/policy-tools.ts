// deep-dives/building-a-production-ai-capability.md:47-90
import { Context, Effect, Schema } from "effect"
import { AiError, Tool, Toolkit } from "effect/unstable/ai"

const PolicyExcerpt = Schema.Struct({
  policyId: Schema.String,
  title: Schema.String,
  section: Schema.String,
  excerpt: Schema.String
})
type PolicyExcerpt = Schema.Schema.Type<typeof PolicyExcerpt>

class PolicyCatalog extends Context.Service<PolicyCatalog, {
  readonly searchAuthorized: (
    query: string,
    limit: number
  ) => Effect.Effect<ReadonlyArray<PolicyExcerpt>, AiError.AiError>
}>()("app/PolicyCatalog") {}

const SearchPolicies = Tool.make("SearchPolicies", {
  description: "Search policy text the current user is authorized to read",
  parameters: Schema.Struct({
    query: Schema.String.annotate({
      description: "A concise policy question, without employee personal data"
    }),
    limit: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: 8 })
    )
  }),
  success: Schema.Array(PolicyExcerpt),
  failureMode: "error"
})

export const PolicyToolkit = Toolkit.make(SearchPolicies)

export const PolicyToolkitLive = PolicyToolkit.toLayer(
  Effect.gen(function*() {
    const catalog = yield* PolicyCatalog
    return PolicyToolkit.of({
      SearchPolicies: Effect.fn("SearchPolicies")(function*({ query, limit }) {
        return yield* catalog.searchAuthorized(query, limit)
      })
    })
  })
)
