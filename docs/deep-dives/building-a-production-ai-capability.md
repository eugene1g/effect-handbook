# Building a Production AI Capability

Audited against `effect@4.0.0-rc.108`, the matching `ai-docs` examples, and the implementation of `effect/unstable/ai` on 2026-08-12.

A production AI feature is not a prompt wrapped in an HTTP handler. It is a normal application capability with a typed input boundary, an injectable model, narrowly authorized tools, validated output, explicit limits, observable cost, and a deterministic test seam.

This guide builds a policy assistant that answers an HR partner's question from an authorized policy catalog. It keeps the model behind a service so the rest of the application never depends on a provider SDK.

The AI APIs are unstable in RC 108. Pin Effect and the matching provider packages together, and re-audit before upgrading.

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

The Schema validates shape and constraints. It does not prove that the answer is true, that a citation supports the claim, or that policy permits an action. Those require grounded tools, application checks, and human review appropriate to the risk.

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

Tool parameter decoding rejects malformed calls before the handler runs, and tool success values are encoded through their Schema. `failureMode: "error"` keeps a handler failure in the Effect error channel. Use `"return"` only when exposing the failure to the model is an intentional recovery strategy and the error content is safe to reveal.

Descriptions influence model behavior; they are not a security boundary. Keep authorization in the handler even if the system prompt says the same thing.

## Build a provider-neutral service

Business code should depend on `LanguageModel.LanguageModel`, not `OpenAiClient` or another vendor client. A provider model is a `Layer`; select and configure it at the application edge. `Config.redacted` prevents the API key's value from appearing in ordinary logs and inspection.

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
  apiKey: Config.redacted("OPENAI_API_KEY")
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

## Put MCP at an explicit trust boundary

`McpServer` is the external protocol boundary for exposing selected tools and resources to other agents. It is not the in-process agent loop: keep ordinary application tool calls on `Toolkit`, and add MCP only when another process needs discovery and invocation over stdio or Streamable HTTP.

Every server layer must declare the protocol versions it accepts, for example `protocols: [McpProtocol.v2025_06_18]`; do not silently accept an unspecified or future wire contract. A stdio layer owns the process stream lifecycle. An HTTP layer owns an HTTP server route and must be deployed with its origin and media checks intact: requests carrying `Origin` are rejected unless the exact origin is allowlisted, POST requires `Content-Type: application/json`, and `Accept` must allow both JSON and event-stream responses. Put authentication, tenant binding, tool authorization, rate limits, audit logging, and request-size limits outside or inside the handlers as appropriate—protocol negotiation does not supply product authorization.

Treat MCP handlers like any other externally reachable Effect service. Decode arguments through Schema, expose the smallest safe capability, provide their Layers once for the server lifetime, and make consequential operations idempotent. See the concise [MCP server reference](../systems/ai-language-models.md#mcpserver) for layer configuration and transport details.

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

Do not collect the stream into an array or one string before sending it to the client; that preserves the type but discards streaming's latency and memory benefits. See [Streaming Ingestion Without Accidental Buffering](./streaming-ingestion-without-accidental-buffering.md) for the same principle at data-ingestion scale.

## Test the capability without calling a provider

Make prompt assembly, authorization, retrieval, citation verification, and output policy ordinary pure or Effect code. Those tests should not depend on a network model. At the AI boundary, provide a deterministic `LanguageModel` made from encoded response parts.

**Runnable.** This fake is the RC 108 test seam used by Effect's own AI tests.

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

## Operational checklist

- Keep provider selection and credentials in Layers and `Config`, outside business services.
- Treat prompts, retrieved documents, model text, and tool arguments as untrusted input.
- Validate machine-consumed output with Schema and apply domain invariants afterward.
- Authorize every tool in its handler; expose narrow domain operations, not generic infrastructure access.
- Require and audit human approval for consequential actions.
- Use stable idempotency keys for tools that write externally.
- Bound agent turns, retries, tool concurrency, token budgets, history, and wall-clock duration.
- Record model/provider, latency, finish reason, token usage, tool calls, failures, and fallback selection.
- Redact secrets and minimize personal or confidential content sent to providers.
- Define retention, regional processing, deletion, incident-response, and provider-data-use policy.
- Maintain deterministic fakes plus a small live-provider contract suite.
- Pin unstable Effect/provider package versions and review changelogs together.

Continue with [AI & Language Models](../systems/ai-language-models.md), [Configuration & Secrets](../foundations/configuration-secrets.md), [Observability](../operations/observability.md), [Testing an Effect Application](./testing-an-effect-application.md), and [The Durability and Distribution Ladder](./durability-and-distribution-ladder.md).
