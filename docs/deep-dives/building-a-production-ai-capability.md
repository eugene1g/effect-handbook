# Building a Production AI Capability

Audited against `effect@4.0.0-rc.115`, the matching `ai-docs` examples, and the implementation of `effect/unstable/ai` on 2026-09-18.

A production AI feature is not a prompt wrapped in an HTTP handler. It is a normal application capability with a typed input boundary, an injectable model, narrowly authorized tools, validated output, explicit limits, observable cost, and a deterministic test seam.

This guide builds a policy assistant that answers an HR partner's question from an authorized policy catalog. It keeps the model behind a service so the rest of the application never depends on a provider SDK.

The AI APIs are unstable in `rc.115`. Pin Effect and the matching provider packages together, and re-audit before upgrading.

## Define the product contract before the prompt

Decide what the caller receives and what failure means. Free-form text is appropriate for drafting. If another program will act on the answer, use `LanguageModel.generateObject` with a Schema and treat schema failure as a typed AI failure—not as a partially trustworthy result.

**Runnable.** These schemas are the stable application boundary; provider response shapes remain inside the adapter.

```ts
import { Schema } from "effect"

export const PolicyCitation = Schema.Struct({
  policyId: Schema.String,
  title: Schema.String,
  section: Schema.String
})

export const PolicyAnswer = Schema.Struct({
  answer: Schema.String,
  citations: Schema.Array(PolicyCitation),
  confidence: Schema.Literals(["low", "medium", "high"]),
  needsHumanReview: Schema.Boolean
})

export type PolicyAnswer = Schema.Schema.Type<typeof PolicyAnswer>
```

The Schema validates shape and constraints. It does not prove that the answer is true, that a citation supports the claim, or that policy permits an action. Those require grounded tools, application checks, and human review appropriate to the risk. The local decode is also the *only* authority on shape: a provider's "strict JSON" mode narrows what the model emits, but `generateObject` still decodes the reply through your Schema, and a reply that fails must stay a typed `StructuredOutputError` rather than being rescued by parsing prose.

## Draw the trust boundary before writing a tool

Write down which values the capability may believe. Everything a model can influence is input to be validated; nothing a model can influence may grant authority.

| Value | Source | Treat as |
| --- | --- | --- |
| Actor, tenant, roles, session | Authenticated request context, bound into services before the model runs | **Trusted** — the only source for authorization |
| Approval decision, approver identity, approved arguments | Your approval store, written by an authenticated human action | **Trusted**, and only for the exact call id and argument digest it was issued for |
| Idempotency key, policy version, price table, limits | Server-issued and persisted | **Trusted** — never derived from model text |
| User question, uploaded files | The caller | Untrusted input |
| Retrieved documents and tool **results** | Your stores and third parties | Untrusted content: it can carry instructions aimed at the model |
| Model text, tool **names and arguments**, citations, confidence | The model | Untrusted output: validate the shape, then re-check authority in code |

Three consequences follow. **Fail closed** when identity, authorization, approval, a required price or usage figure, or a safety bound cannot be established — an absent limit is an error, not "unlimited". **Keep egress deliberate**: know which provider receives which data, under which retention terms, and strip what the task does not need. **Separate guidance from enforcement**: prompts steer, Schemas validate representation, and only handler code proves authorization, freshness, or safety.

## Put authoritative data behind tools

Tools are typed calls from the model into your application. `Tool.make` defines the name, description, parameter Schema, and success Schema. `Toolkit.make` groups tools, and `toolkit.toLayer` supplies their handlers.

Do not let a tool accept an arbitrary database predicate, URL, file path, or tenant id. Define the smallest domain operation the model needs. The handler—not the model—must enforce tenant scope, authorization, row-level policy, rate limits, and audit recording.

**Contextual.** `PolicyCatalog` is the authorized application port. Its live layer is expected to bind the current actor and tenant before returning search results.

```ts
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
```

Tool parameter decoding rejects malformed calls before the handler runs, and tool success values are encoded through their Schema. What happens to the rejection follows the tool's `failureMode`, exactly as a handler failure does: under `"error"` (the default, used here) the generation fails with an `AiError` whose reason is `ToolParameterValidationError`; under `"return"` the same error is handed back to the model as a failed tool result so it can repair the call. Use `"return"` only when exposing the failure to the model is an intentional recovery strategy and the error content is safe to reveal — authentication, authorization, and approval failures are never "recoverable tool text".

Tool calls requested in one model turn are resolved **with unbounded concurrency unless you pass `concurrency`**. A search tool that fans out to a rate-limited index, or any tool holding a connection, needs an explicit number on every `generateText` / `generateObject` / `streamText` call that carries the toolkit.

Descriptions influence model behavior; they are not a security boundary. Keep authorization in the handler even if the system prompt says the same thing.

## Build a provider-neutral service

Business code should depend on `LanguageModel.LanguageModel`, not `OpenAiClient` or another vendor client. A provider model is a `Layer`; select and configure it at the application edge. `Config.Redacted` prevents the API key's value from appearing in ordinary logs and inspection.

**Contextual.** This is a complete Effect adapter. The deployment still supplies `PolicyCatalog`; `OPENAI_API_KEY` is read through the configured `ConfigProvider`.

```ts
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Config, Context, Effect, Layer, Schedule, Schema } from "effect"
import { AiError, LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { PolicyToolkit, PolicyToolkitLive } from "./policy-tools.js"

const PolicyCitation = Schema.Struct({
  policyId: Schema.String,
  title: Schema.String,
  section: Schema.String
})

const PolicyAnswer = Schema.Struct({
  answer: Schema.String,
  citations: Schema.Array(PolicyCitation),
  confidence: Schema.Literals(["low", "medium", "high"]),
  needsHumanReview: Schema.Boolean
})
type PolicyAnswer = Schema.Schema.Type<typeof PolicyAnswer>

class PolicyAssistantError extends Schema.TaggedError<PolicyAssistantError>()(
  "PolicyAssistantError",
  { reason: AiError.AiErrorReason }
) {}

export class PolicyAssistant extends Context.Service<PolicyAssistant, {
  readonly answer: (
    question: string
  ) => Effect.Effect<PolicyAnswer, PolicyAssistantError>
}>()("app/PolicyAssistant") {
  static readonly layer = Layer.effect(
    PolicyAssistant,
    Effect.gen(function*() {
      const toolkit = yield* PolicyToolkit
      const model = yield* OpenAiLanguageModel.model("gpt-5.2").captureRequirements

      const answer = Effect.fn("PolicyAssistant.answer")(
        function*(question: string) {
          const response = yield* LanguageModel.generateObject({
            objectName: "policy_answer",
            schema: PolicyAnswer,
            toolkit,
            toolChoice: "auto",
            prompt: [
              {
                role: "system",
                content:
                  "Answer only from SearchPolicies results. Cite every material claim. " +
                  "If evidence is missing or conflicting, say so and require human review."
              },
              { role: "user", content: question }
            ]
          })

          yield* Effect.logInfo("policy assistant completed").pipe(
            Effect.annotateLogs({
              finishReason: response.finishReason,
              outputTokens: response.usage.outputTokens.total,
              citationCount: response.value.citations.length
            })
          )

          return response.value
        },
        Effect.provide(model),
        Effect.retry({
          while: (error) => error.reason._tag === "RateLimitError",
          schedule: Schedule.max([
            Schedule.exponential("200 millis"),
            Schedule.recurs(3)
          ])
        }),
        Effect.catchTag("AiError", (error) =>
          Effect.fail(new PolicyAssistantError({ reason: error.reason }))
        )
      )

      return PolicyAssistant.of({ answer })
    })
  ).pipe(Layer.provide(PolicyToolkitLive))
}

const OpenAiClientLive = OpenAiClient.layerConfig({
  apiKey: Config.Redacted("OPENAI_API_KEY")
}).pipe(Layer.provide(FetchHttpClient.layer))

export const PolicyAssistantLive = PolicyAssistant.layer.pipe(
  Layer.provide(OpenAiClientLive)
)
```

The relative imports point to the preceding contract module. In a single-file prototype, place those declarations above the service instead.

Retry only failures known to be transient. Authentication, quota exhaustion, invalid requests, content-policy rejection, and invalid structured output need different handling. Bound both retries and total request duration at the application boundary.

If you need provider or model fallback, an `ExecutionPlan` can provide successive model layers. A fallback is still a semantic change: models differ in tool support, output quality, safety behavior, price, and context limits. Exercise every planned model in contract tests.

## Separate read tools from actions

A read-only retrieval tool can often execute automatically. A tool that changes payroll, sends a message, creates a ticket, or reveals sensitive data needs a stronger boundary.

**Illustrative.** Marking a tool as approval-gated tells the AI framework to produce an approval request instead of silently executing it. The surrounding application must authenticate the approver, show the exact decoded arguments, persist the decision when required, and provide the matching approval response.

<!-- effect-example id=ai.approval-gated-tool check=pseudocode -->
```ts
import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"

export const SubmitPolicyException = Tool.make("SubmitPolicyException", {
  description: "Submit a policy exception after an authorized human approves it",
  parameters: Schema.Struct({
    employeeId: Schema.String,
    policyId: Schema.String,
    rationale: Schema.String
  }),
  success: Schema.Struct({ requestId: Schema.String })
}).setNeedsApproval(true)
```

Approval does not replace authorization or idempotency. Recheck both inside the eventual handler, bind the approval to the actor and exact arguments, and pass a stable request id to the destination so a retried tool result cannot create two actions.

Once a human decision exists, the application appends a `tool-approval-response` part (`approvalId`, `approved`, optional `reason`) to the conversation and calls the model again with the same handler-equipped toolkit. The framework then runs an approved call before contacting the provider, or records a denied one as a failed result of type `"execution-denied"`. Completed approval results are retained in the response, so a `Chat` records them and a later turn does not execute the approved tool a second time.

### Keep the framework from executing a mutation before your gates run

`setNeedsApproval` covers "a human must say yes". It does not cover "authenticate, authorize at execution time, claim an idempotency record, and only then invoke". For that, stop the framework from resolving tool calls at all: pass `disableToolCallResolution: true`, inspect the proposed calls, run your own protocol, and dispatch through the toolkit's `handle`.

**Contextual.** `ActionLedger` is the application's tenant-scoped idempotency store and `Authorizer` its policy port; both are bound to the authenticated actor before this code runs.

```ts
import { Context, Effect, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"

class ActionRefused extends Schema.TaggedError<ActionRefused>()("ActionRefused", {
  toolCallId: Schema.String,
  reason: Schema.Literals(["unauthorized", "not-approved", "duplicate"])
}) {}

class ActionOutcomeUnknown extends Schema.TaggedError<ActionOutcomeUnknown>()(
  "ActionOutcomeUnknown",
  { operationId: Schema.String }
) {}

const SubmitPolicyException = Tool.make("SubmitPolicyException", {
  description: "Submit a policy exception for an employee",
  parameters: Schema.Struct({
    employeeId: Schema.String,
    policyId: Schema.String,
    rationale: Schema.String
  }),
  success: Schema.Struct({ requestId: Schema.String })
})
const ActionToolkit = Toolkit.make(SubmitPolicyException)
type ExceptionArgs = typeof SubmitPolicyException.parametersSchema.Type

class Authorizer extends Context.Service<Authorizer, {
  // Resolves actor and tenant from trusted context, never from `args`.
  readonly authorize: (toolCallId: string, args: ExceptionArgs) => Effect.Effect<void, ActionRefused>
}>()("app/Authorizer") {}

class ActionLedger extends Context.Service<ActionLedger, {
  // Atomically claims a server-issued operation id for this intent and
  // persists "dispatched" before returning it.
  readonly claim: (toolCallId: string, args: ExceptionArgs) => Effect.Effect<string, ActionRefused>
  readonly settle: (
    operationId: string,
    outcome: "succeeded" | "failed-known" | "unknown"
  ) => Effect.Effect<void>
}>()("app/ActionLedger") {}

export const proposeThenSubmit = Effect.fn("proposeThenSubmit")(function*(question: string) {
  const toolkit = yield* ActionToolkit
  const authorizer = yield* Authorizer
  const ledger = yield* ActionLedger

  const response = yield* LanguageModel.generateText({
    prompt: question,
    toolkit,
    disableToolCallResolution: true // propose only; nothing has executed
  })

  const submitted: Array<string> = []
  for (const call of response.toolCalls) {
    yield* authorizer.authorize(call.id, call.params)
    const operationId = yield* ledger.claim(call.id, call.params)

    // `handle` and the full consumption of its stream stay in one Effect, so
    // interrupting this request also interrupts the handler fiber.
    const outcome = yield* toolkit.handle(call.name, call.params, call.id).pipe(
      Effect.flatMap(Stream.runLast),
      // A typed handler failure is a known outcome.
      Effect.tapError(() => ledger.settle(operationId, "failed-known")),
      Effect.timeout("20 seconds"),
      // A timeout or interruption AFTER dispatch is not a known failure.
      Effect.catchTag("TimeoutError", () =>
        ledger.settle(operationId, "unknown").pipe(
          Effect.andThen(Effect.fail(new ActionOutcomeUnknown({ operationId })))
        )),
      Effect.onInterrupt(() => ledger.settle(operationId, "unknown"))
    )

    if (outcome._tag === "Some" && "requestId" in outcome.value.result) {
      yield* ledger.settle(operationId, "succeeded")
      submitted.push(outcome.value.result.requestId)
    }
  }
  return submitted
})
```

The mutation is a protocol with a ledger, not a function call:

1. **Decode and normalize** the arguments (the toolkit does the decode; `params` above is still the encoded form, which for this schema is identical).
2. **Resolve actor and tenant from trusted context**, authorize at execution time, and verify any approval against the call id, an argument digest, the actor, the tenant, its expiry, and the policy version you expected.
3. **Derive the idempotency key from a server-issued operation id**, the tenant, the operation kind, and the normalized intent — not from the tool-call id, which changes when the model retries.
4. **Claim the ledger entry atomically and persist `dispatched` before invoking.** A duplicate claim converges on the first outcome instead of dispatching again.
5. **Record `succeeded`, `failed-known`, or `unknown`.** A timeout or interruption after dispatch is *unknown*: never replay it blindly; reconcile through the destination's idempotency or status API.
6. **Return only bounded, safe data to the model.** Ledger state, policy reasons, and stack traces stay server-side.

## Put MCP at an explicit trust boundary

`McpServer` is the external protocol boundary for exposing selected tools and resources to other agents. It is not the in-process agent loop: keep ordinary application tool calls on `Toolkit`, and add MCP only when another process needs discovery and invocation over stdio or Streamable HTTP.

Every server layer must declare the protocol versions it accepts, for example `protocols: [McpProtocol.v2025_06_18]`; do not silently accept an unspecified or future wire contract. A stdio layer owns the process stream lifecycle. An HTTP layer owns an HTTP server route and must be deployed with its origin and media checks intact: requests carrying `Origin` are rejected unless the exact origin is allowlisted, POST requires `Content-Type: application/json`, and `Accept` must allow both JSON and event-stream responses. Put authentication, tenant binding, tool authorization, rate limits, audit logging, and request-size limits outside or inside the handlers as appropriate—protocol negotiation does not supply product authorization.

Treat MCP handlers like any other externally reachable Effect service. Decode arguments through Schema, expose the smallest safe capability, provide their Layers once for the server lifetime, and make consequential operations idempotent. An MCP client only ever sees a declared failure's `message` or a fixed internal-error text; undeclared failures, `AiError`s, and defects are recovered into an `isError` result **and** handed to the configured `ErrorReporter`s, so wire a reporter if tool faults should page someone. Keep MCP-exposed tools on `failureMode: "error"`: a `"return"` tool's failure is delivered as ordinary content that the client cannot distinguish from success. See the concise [MCP server reference](../systems/ai-language-models.md#mcpserver) for layer configuration and transport details.

## Bound every agentic loop

`Chat` owns conversation history and appends resolved tool calls and results between turns. It is useful when a task genuinely needs multiple model/tool rounds. It is not a reason to use an unbounded `while (true)` loop in production.

**Contextual.** The toolkit and model are Context requirements. This loop terminates with a typed failure after `maxTurns` model calls.

```ts
import { Effect, Schema } from "effect"
import { Chat, Tool, Toolkit } from "effect/unstable/ai"

class AgentTurnLimit extends Schema.TaggedError<AgentTurnLimit>()(
  "AgentTurnLimit",
  { turns: Schema.Int }
) {}

export const runBoundedAgent = <Tools extends Record<string, Tool.Any>>(
  question: string,
  toolkit: Toolkit.Toolkit<Tools>,
  maxTurns = 6
) =>
  Effect.gen(function*() {
    const chat = yield* Chat.fromPrompt([
      {
        role: "system",
        content: "Use the available tools for evidence. Never invent a tool result."
      },
      { role: "user", content: question }
    ])

    for (let turn = 1; turn <= maxTurns; turn++) {
      const response = yield* chat.generateText({
        prompt: [],
        toolkit,
        toolChoice: "auto"
      })
      if (response.toolCalls.length === 0) return response.text
    }

    return yield* new AgentTurnLimit({ turns: maxTurns })
  })
```

Also bound tool concurrency, provider retries, per-tool timeouts, accumulated history, response tokens, and total wall-clock time. Persist chat only when the product needs continuity; define retention and deletion rules because prompts, tool results, and exported history may contain sensitive data.

### Validate the budget, reserve before dispatch, account per turn

A turn limit bounds iterations; it does not bound cost. Treat the budget as data with its own invariants, and enforce it *before* each model call.

**Contextual.** The reservation uses a `Tokenizer` estimate; the provider's reported usage reconciles it afterwards.

```ts
import { Effect, Ref, Schema } from "effect"
import { Chat, Tokenizer, Tool, Toolkit } from "effect/unstable/ai"

class BudgetRejected extends Schema.TaggedError<BudgetRejected>()("BudgetRejected", {
  limit: Schema.Literals(["policy", "turns", "tokens"]),
  detail: Schema.String
}) {}

interface AgentBudget {
  readonly maxTurns: number
  readonly maxTotalTokens: number
  readonly maxOutputTokensPerTurn: number
}

// Fixed ceilings the caller cannot raise. NaN, Infinity, negatives, and
// fractions are rejected instead of being read as "no limit".
const ceiling: AgentBudget = { maxTurns: 8, maxTotalTokens: 60_000, maxOutputTokensPerTurn: 4_000 }

const validateBudget = (budget: AgentBudget) =>
  Effect.gen(function*() {
    for (const key of ["maxTurns", "maxTotalTokens", "maxOutputTokensPerTurn"] as const) {
      const value = budget[key]
      if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling[key]) {
        return yield* new BudgetRejected({ limit: "policy", detail: `${key}=${String(value)}` })
      }
    }
    return budget
  })

export const runBudgetedAgent = <Tools extends Record<string, Tool.Any>>(
  question: string,
  toolkit: Toolkit.Toolkit<Tools>,
  requested: AgentBudget
) =>
  Effect.gen(function*() {
    const budget = yield* validateBudget(requested)
    const tokenizer = yield* Tokenizer.Tokenizer
    const spent = yield* Ref.make(0)
    const chat = yield* Chat.fromPrompt([
      { role: "system", content: "Use the available tools for evidence." },
      { role: "user", content: question }
    ])

    for (let turn = 1; turn <= budget.maxTurns; turn++) {
      // Reserve BEFORE dispatch: estimated context + worst-case output.
      const history = yield* Ref.get(chat.history)
      const estimate = (yield* tokenizer.tokenize(history)).length
      const reserved = estimate + budget.maxOutputTokensPerTurn
      if ((yield* Ref.get(spent)) + reserved > budget.maxTotalTokens) {
        return yield* new BudgetRejected({ limit: "tokens", detail: `turn ${turn}` })
      }

      const response = yield* chat.generateText({
        prompt: [],
        toolkit,
        toolChoice: "auto",
        concurrency: 2
      })

      // Reconcile with what the provider billed; ADD per turn, never max().
      const billed = (response.usage.inputTokens.total ?? estimate) +
        (response.usage.outputTokens.total ?? budget.maxOutputTokensPerTurn)
      yield* Ref.update(spent, (total) => total + billed)

      if (response.toolCalls.length === 0) return response.text
    }
    return yield* new BudgetRejected({ limit: "turns", detail: String(budget.maxTurns) })
  }).pipe(
    // One absolute deadline for the whole run; the timeout interrupts the
    // in-flight provider request and any running tool handlers.
    Effect.timeout("90 seconds")
  )
```

Rules the example encodes, and the ones it leaves to the surrounding service:

- **A missing or malformed limit fails closed.** `Infinity`, `NaN`, a negative number, or a caller-supplied limit above the fixed ceiling is a rejected policy, not an unlimited one.
- **Returned usage is reconciliation, not first enforcement.** By the time usage arrives the money is spent. If a provider omits usage, charge the reservation.
- **Bound each outgoing context separately from the billed total.** Every turn re-sends history; truncate or summarize before the context limit rather than after a provider error.
- **Retries draw from the same budgets**, and a retry is only legal before any streamed output reached the caller and before any mutating tool was dispatched.
- **An abort signal is not a timeout.** Race a timeout that interrupts, and bound stream *consumption* as well as stream creation — a stream that is never drained holds its connection.
- **Share limiters at the service boundary.** A `Semaphore` created per invocation limits nothing across requests; build it once in the service's Layer.
- **Require one valid terminal `finish` per completed turn**, and treat unknown part types that would cause an action as denied by default.

## Stream without hiding completion state

`LanguageModel.streamText` returns a `Stream` of tagged response parts. Forward text deltas incrementally, but also observe the terminal finish part for usage and reason. Cancellation should interrupt the model request through the stream scope.

**Contextual.** This projection intentionally exposes only text deltas. A production transport should separately record the terminal finish part and translate stream errors.

```ts
import { Stream } from "effect"
import { LanguageModel, type Response } from "effect/unstable/ai"

export const streamPolicyDraft = (question: string) =>
  LanguageModel.streamText({
    prompt: [
      { role: "system", content: "Draft policy guidance; do not make decisions." },
      { role: "user", content: question }
    ]
  }).pipe(
    Stream.filter(
      (part): part is Response.TextDeltaPart => part.type === "text-delta"
    ),
    Stream.map((part) => part.delta)
  )
```

### Persist a streamed turn with a status

A streamed turn can end four ways: a terminal `finish` part, a typed failure, a timeout, or interruption when the client disconnects. Only the first produced a turn that is safe to show the model again.

1. **Record the turn as `incomplete` before consuming the stream**, keyed by a server-issued turn id.
2. **Append bounded semantic events** (text accumulated so far, tool calls, tool results) — not raw provider frames, and never unbounded.
3. **Mark it `complete` only after a valid terminal `finish` part and reconciled usage.** Use `Stream.onExit` (or a scoped finalizer) to write `failed` or `interrupted` for every other ending.
4. **Rebuild later prompts only from complete, compatible turns.** Store the tool-definition and schema versions with each turn; a half-written assistant message or a tool call without its result makes the next provider request malformed.

`Chat` itself is in-process mutable state with no tenant, version, or concurrency control. When completeness or shared ownership matters, keep the authoritative transcript in your own store and hydrate a `Chat` from it per request with `Chat.fromPrompt` or `Chat.fromExport`.

Do not collect the stream into an array or one string before sending it to the client; that preserves the type but discards streaming's latency and memory benefits. See [Streaming Ingestion Without Accidental Buffering](./streaming-ingestion-without-accidental-buffering.md) for the same principle at data-ingestion scale.

## Test the capability without calling a provider

Make prompt assembly, authorization, retrieval, citation verification, and output policy ordinary pure or Effect code. Those tests should not depend on a network model. At the AI boundary, provide a deterministic `LanguageModel` made from encoded response parts.

**Runnable.** This fake is the `rc.115` test seam used by Effect's own AI tests. `LanguageModel.make` also stamps the service's `[TypeId]` brand, which a hand-written object literal would have to add itself.

```ts
import { Effect, Layer, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"

export const FakeLanguageModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () =>
      Effect.succeed([
        {
          type: "text",
          text: "The policy requires manager and HR approval."
        }
      ]),
    streamText: () => Stream.empty
  })
)

export const example = LanguageModel.generateText({
  prompt: "What approvals are required?"
}).pipe(
  Effect.map((response) => response.text),
  Effect.provide(FakeLanguageModel)
)
```

A single canned answer proves little about an agent. A **scripted** model replays one list of encoded parts per turn and records exactly what it was sent, so a test can assert on prompts, turn counts, and tool dispatch.

**Runnable.** Each inner array is one model turn; the second turn only happens if the first tool call was resolved.

```ts
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { Chat, LanguageModel, Tool, Toolkit, type Prompt, type Response } from "effect/unstable/ai"

const usage = { inputTokens: { total: 12 }, outputTokens: { total: 8 } }

const script: ReadonlyArray<Array<Response.PartEncoded>> = [
  [
    { type: "tool-call", id: "call-1", name: "SearchPolicies", params: { query: "parental leave", limit: 3 } },
    { type: "finish", reason: "tool-calls", usage, response: undefined }
  ],
  [
    { type: "text", text: "Policy HR-12 grants sixteen weeks." },
    { type: "finish", reason: "stop", usage, response: undefined }
  ]
]

const SearchPolicies = Tool.make("SearchPolicies", {
  description: "Search policy text the current user may read",
  parameters: Schema.Struct({ query: Schema.String, limit: Schema.Int }),
  success: Schema.Array(Schema.String)
})
const PolicyToolkit = Toolkit.make(SearchPolicies)

export const scriptedRun = Effect.gen(function*() {
  const prompts = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])
  const searches = yield* Ref.make<ReadonlyArray<string>>([])

  const ScriptedModel = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) =>
        Ref.modify(prompts, (seen) => [script[seen.length] ?? [], [...seen, options.prompt]]),
      streamText: () => Stream.never // a stream that never ends, for timeout tests
    })
  )
  const Handlers = PolicyToolkit.toLayer({
    SearchPolicies: ({ query }) =>
      Ref.update(searches, (all) => [...all, query]).pipe(Effect.as(["HR-12 §3: sixteen weeks"]))
  })

  const answer = yield* Effect.gen(function*() {
    const toolkit = yield* PolicyToolkit
    const chat = yield* Chat.fromPrompt("How long is parental leave?")
    // Turn 1 requests the tool; Chat appends the call and its result to history.
    yield* chat.generateText({ prompt: [], toolkit, concurrency: 1 })
    const second = yield* chat.generateText({ prompt: [], toolkit, concurrency: 1 })
    return second.text
  }).pipe(Effect.provide([ScriptedModel, Handlers]))

  const seen = yield* Ref.get(prompts)
  return {
    answer, // "Policy HR-12 grants sixteen weeks."
    modelTurns: seen.length, // 2
    secondPromptRoles: seen[1]?.content.map((message) => message.role), // ["user", "assistant", "tool"]
    searches: yield* Ref.get(searches) // ["parental leave"]
  }
})
```

Give every other capability boundary a fake with the same discipline: a toolkit handler with a `Deferred` barrier before and after its commit point (to interrupt at each), tenant-aware stores that enforce compound keys, an approval fake whose bound fields can each be varied independently, a `TestClock` and fixed price table, and a telemetry collector that rejects attribute keys outside an allow-list.

Use provider integration tests for the smaller set of behaviors the fake cannot prove: provider request translation, structured-output compatibility, tool-call encoding, streaming event order, safety responses, and fallback behavior. Do not make assertions on stylistic wording; assert schemas, invariants, cited evidence, tool authorization, limits, and failure classification.

## Capstone test plan

For the policy assistant, cover these paths:

1. A permitted user retrieves only authorized policy excerpts; a cross-tenant query returns none even when the model asks for it.
2. Malformed tool parameters never reach the handler.
3. A valid structured response decodes to `PolicyAnswer`; malformed JSON, a missing citation, and an invalid confidence value fail through the AI error channel.
4. A rate-limit error retries within the bound; authentication and invalid-output errors do not loop indefinitely.
5. A mutating tool cannot execute before a correctly bound approval, and redelivery creates one external action.
6. The agent stops at the configured turn limit and interrupts outstanding tools when the request is cancelled.
7. Streaming emits early deltas without collecting the full result, reports terminal usage, and closes on client cancellation.
8. Logs and traces contain request ids, model identity, latency, finish reason, token usage, and tool names—but no API keys, full sensitive prompts, or hidden reasoning.
9. Each approval mismatch — wrong call id, changed arguments, another actor or tenant, expired, stale policy version — produces zero dispatches.
10. Concurrent and sequential duplicates of one intent dispatch once and return the same recorded outcome.
11. A timeout *before* dispatch is reported as a safe failure; a timeout *after* dispatch is recorded as `unknown` and is not retried automatically.
12. Every budget fails at its exact edge (turn `maxTurns + 1`, the first token over the total), and a non-finite or over-ceiling budget is rejected before any model call.
13. A partially consumed stream leaves a persisted `incomplete`/`interrupted` turn, runs its finalizers, and that turn is absent from the next prompt.
14. A canary string planted in a retrieved document never appears in tool arguments for another tenant, in logs, or in telemetry attributes.

State what each layer of the suite proves. Deterministic fakes prove *policy*. Recorded or mock HTTP transports prove *adapter* parsing, streaming order, and cancellation. A small, separately authorized live-provider lane proves only that the remote API still matches the recording today.

## Adjacent capabilities, same discipline

- **Embeddings.** Persist provider, model, `dimensions`, normalization, and a schema version beside each vector. When any of them changes, build a new versioned index and re-embed; never compare vectors from different spaces.
- **Fallback models.** A fallback is a separately configured capability. Re-validate its tool, structured-output, and media support in contract tests, and never route to it in order to get past a content-policy refusal.
- **Dynamic and MCP-sourced tools.** Authenticate the server, allow-list tool names, snapshot each tool's JSON Schema and validate arguments locally, map every tool to an application capability with its own policy, and reject a changed schema until a human has reviewed it.
- **Media input.** Check magic bytes, MIME type, dimensions, duration, size, count, and URI scheme before a file part is sent; do not let a prompt cause an implicit URL fetch.
- **Stored tool results.** A result is encoded with the success or the failure schema according to its `isFailure` flag, and failed results may be a `Tool.ExecutionFailure`. Treat exported `Chat` history as a versioned persisted format and review it when a tool's schemas change.

## Operational checklist

- Keep provider selection and credentials in Layers and `Config`, outside business services.
- Treat prompts, retrieved documents, model text, and tool arguments as untrusted input.
- Validate machine-consumed output with Schema and apply domain invariants afterward.
- Authorize every tool in its handler; expose narrow domain operations, not generic infrastructure access.
- Require and audit human approval for consequential actions.
- Use stable, server-issued idempotency keys for tools that write externally, and record `unknown` outcomes instead of replaying them.
- Set `concurrency` on every call that carries a toolkit; use `disableToolCallResolution` when your own gates must run before a handler.
- Bound agent turns, retries, tool concurrency, token budgets, history, and wall-clock duration — and reject any budget that is missing, non-finite, or above the fixed ceiling.
- Keep failed, timed-out, and interrupted turns out of later prompts.
- Record model/provider, latency, finish reason, token usage, tool calls, failures, and fallback selection.
- Redact secrets and minimize personal or confidential content sent to providers.
- Define retention, regional processing, deletion, incident-response, and provider-data-use policy.
- Maintain deterministic fakes plus a small live-provider contract suite.
- Pin unstable Effect/provider package versions and review changelogs together.

Continue with [AI & Language Models](../systems/ai-language-models.md), [Configuration & Secrets](../foundations/configuration-secrets.md), [Observability](../operations/observability.md), [Testing an Effect Application](./testing-an-effect-application.md), and [The Durability and Distribution Ladder](./durability-and-distribution-ladder.md).
