# AI & Language Models

`effect/unstable/ai` provides a provider-agnostic AI toolkit. Business logic depends on `LanguageModel.LanguageModel` from context; a concrete provider (OpenAI, Anthropic, OpenRouter, or any OpenAI-compatible endpoint) is injected as a `Layer`. Schemas validate structured outputs and tool parameters, streaming is a `Stream`, errors are typed, and all calls are traced. Swapping providers requires changing a Layer, not application code.

> **Official companions:** The release-matched [AI examples](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/71_ai) cover language-model calls, tools, and stateful chat. The broader [AI documentation source tree](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src) and [`LLMS.md`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/LLMS.md) are the official executable corpus and coding-agent entry point.

> **Note:** Every example below assumes a provider client Layer built from `Config`. Providers need an `HttpClient` — you choose which one (here `FetchHttpClient`):

```ts
import { Config, Layer } from "effect"
import { OpenAiClient } from "@effect/ai-openai"
import { FetchHttpClient } from "effect/unstable/http"

// Reads OPENAI_API_KEY from your ConfigProvider; the key is Redacted, so it
// never leaks into logs. Provide an HttpClient for the provider to use.
const OpenAiClientLayer = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY")
}).pipe(Layer.provide(FetchHttpClient.layer))
```

## LanguageModel

`effect/unstable/ai/LanguageModel` — unstable

A provider-agnostic service for generating text, schema-validated objects, and streaming with first-class tool calling. Write against `LanguageModel.LanguageModel`; supply a provider Layer via `Effect.provide`.

Three verbs: `generateText` returns a rich response (text, tool calls/results, finish reason, token usage). `generateObject` asks for JSON and decodes it through your `Schema` — `response.value` is typed and validated; bad output becomes a typed `AiError`. `streamText` returns a `Stream` of response parts. Static functions (`LanguageModel.generateText(...)`) read the model from context; identical methods exist on the yielded service value.

```ts
import { Effect, Schema } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { OpenAiLanguageModel } from "@effect/ai-openai"

// 1) Plain text. `generateText` returns text + usage + finishReason.
//    Here: draft a concise performance-review summary from a manager's notes.
const draftReviewSummary = Effect.fn("draftReviewSummary")(function*(notes: string) {
  const response = yield* LanguageModel.generateText({
    prompt: `Summarize this engineer's annual performance in two sentences, ` +
      `neutral tone, suitable for a review packet:\n${notes}`
  })
  yield* Effect.log(`out tokens: ${response.usage.outputTokens.total}`)
  return response.text
})

// 2) Schema-validated object. The model's JSON is DECODED through this schema,
//    so `value` is a real, validated `RaiseRecommendation` — or a typed AiError.
const RaiseRecommendation = Schema.Struct({
  employeeId: Schema.String,
  rating: Schema.Literals(["below", "meets", "exceeds"]),
  proposedIncreasePct: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  rationale: Schema.String
})

const recommendRaise = Effect.fn("recommendRaise")(function*(reviewNotes: string) {
  const response = yield* LanguageModel.generateObject({
    objectName: "raise_recommendation",
    prompt: `From these review notes, propose a merit increase within band:\n${reviewNotes}`,
    schema: RaiseRecommendation
  })
  return response.value // typeof RaiseRecommendation.Type, fully decoded
})

// Provide a concrete provider at the edge. `.model(...)` returns a Model
// (a Layer) carrying the OpenAI client requirement — swap this one line to
// switch providers, no business-logic changes.
const program = draftReviewSummary("…").pipe(
  Effect.provide(OpenAiLanguageModel.model("gpt-5.2"))
)
```

Streaming yields typed parts; filter for the deltas you need:

```ts
import { Stream } from "effect"
import { LanguageModel, type Response } from "effect/unstable/ai"
import { OpenAiLanguageModel } from "@effect/ai-openai"

const summaryTokens = LanguageModel.streamText({
  prompt: "Draft talking points for a promotion case as a bulleted list."
}).pipe(
  // Each chunk is a Response part: text-start, text-delta, finish, tool-call…
  Stream.filter((part): part is Response.TextDeltaPart => part.type === "text-delta"),
  Stream.map((part) => part.delta),
  Stream.provide(OpenAiLanguageModel.model("gpt-5.2"))
)
```

> **Tip:** Because a model is just a Layer of requirements, you can wrap several in an `ExecutionPlan` — try a cheap model up to N times, then fall back to a stronger one — and apply it with `Effect.withExecutionPlan`. Use `plan.captureRequirements` to fold both providers' client requirements into your service Layer.

```ts
import { Effect, ExecutionPlan } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { OpenAiLanguageModel } from "@effect/ai-openai"
import { AnthropicLanguageModel } from "@effect/ai-anthropic"

const ReviewPlan = ExecutionPlan.make(
  { provide: OpenAiLanguageModel.model("gpt-5.2"), attempts: 3 },
  { provide: AnthropicLanguageModel.model("claude-opus-4-6"), attempts: 2 }
)

const draft = LanguageModel.generateText({ prompt: "Summarize this review cycle." })
  .pipe(Effect.withExecutionPlan(ReviewPlan))
```

**Reach for it when** you need any LLM call — text, validated structured data, streaming, or tool use — without coupling to a vendor SDK. This is the default entry point.

## Chat

`effect/unstable/ai/Chat` — unstable

A stateful conversation on top of `LanguageModel`. Owns a mutable history `Ref`; each turn automatically includes prior messages, and an agentic loop automatically appends tool results before the next turn.

Create with `Chat.empty`, `Chat.fromPrompt` (seed a system message), or `Chat.fromJson`/`fromExport` (rehydrate). Call `session.generateText({ prompt })` per turn; history is threaded automatically. Inspect or persist via `session.history` (a `Ref`) and `session.exportJson`. `Chat.makePersisted` / `Chat.layerPersisted` support durable sessions.

```ts
import { Effect, Ref } from "effect"
import { Chat, Prompt } from "effect/unstable/ai"
import { OpenAiLanguageModel } from "@effect/ai-openai"

// An HRBP assistant: a multi-turn helper for an HR business partner.
const hrbpSession = Effect.gen(function*() {
  // Seed with a system message; history is maintained automatically.
  const session = yield* Chat.fromPrompt(
    Prompt.empty.pipe(
      Prompt.setSystem("You are an HRBP assistant. Stay within comp policy and be concise.")
    )
  )

  const first = yield* session.generateText({
    prompt: "What's a typical merit increase for a strong-performing L4?"
  })
  // The next turn sees the previous question AND answer — no manual context.
  const second = yield* session.generateText({
    prompt: "And if their salary is already at band midpoint?"
  })

  const history = yield* Ref.get(session.history)
  yield* Effect.log(`history has ${history.content.length} messages`)

  // Persist the whole conversation as JSON and rehydrate later.
  const json = yield* session.exportJson
  return { first: first.text, second: second.text, json }
}).pipe(Effect.provide(OpenAiLanguageModel.model("gpt-5.2")))
```

For an agent, loop until the model stops calling tools — `Chat` folds each tool result back into history between turns:

```ts
import { Effect } from "effect"
import { Chat, Tool, Toolkit } from "effect/unstable/ai"

const runHrbpAgent = <Tools extends Record<string, Tool.Any>>(
  question: string,
  tools: Toolkit.Toolkit<Tools>
) =>
  Effect.gen(function*() {
    const session = yield* Chat.fromPrompt([
      { role: "system", content: "Use tools to ground every comp answer in real band data." },
      { role: "user", content: question }
    ])
    while (true) {
      const response = yield* session.generateText({ prompt: [], toolkit: tools })
      // Tool calls were executed and their results added to history for us.
      if (response.toolCalls.length > 0) continue
      return response.text // no more tool calls -> final answer
    }
  })
```

**Reach for it when** building a chatbot or agent that needs memory across turns, or needs save/restore of conversation state. For one-shot calls, plain `LanguageModel` is sufficient.

## Tool

`effect/unstable/ai/Tool` — unstable

A single typed function the model can call. Bundles a name, a description (shown to the model), a `parameters` `Schema` the model fills in, and a `success` `Schema` for the handler's result. Parameters are validated on the way in; results on the way out.

`Tool.make(name, { … })` defines user tools (handler required). `Tool.providerDefined` wraps server-side provider tools (web search, code interpreter — no handler needed). `failureMode: "error"` (default) routes handler failures to the effect's error channel; `"return"` feeds the error back to the model as a tool result. Annotate parameters with `.annotate({ description })` for better model guidance.

Call `.setNeedsApproval(true)` for a sensitive tool, or pass a function of `(params, { toolCallId, messages })` for dynamic approval. Toolkit handlers receive their own second context argument with the optional `toolCallId` and a `preliminary(result)` Effect for streaming progress; retain that ID when correlating approvals, audit records, and results.

```ts
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

const EmployeeId = Schema.String.pipe(Schema.brand("EmployeeId"))

// A tool that looks up an employee's CompBand. Name, description, an input
// schema the model fills, an output schema for the handler result. Per-parameter
// descriptions sharpen model behavior.
const LookupCompBand = Tool.make("LookupCompBand", {
  description: "Look up the salary band (min/mid/max) for an employee's level",
  parameters: Schema.Struct({
    employeeId: EmployeeId.annotate({ description: "e.g. 'emp-4821'" }),
    level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })).pipe(
      Schema.withDecodingDefault(Effect.succeed(4))
    ).annotate({ description: "Job level; defaults to 4 if unknown" })
  }),
  success: Schema.Struct({
    level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    min: Schema.Finite,
    mid: Schema.Finite,
    max: Schema.Finite
  }),
  // "error" (default): handler failures go to the effect error channel.
  // "return": failures are returned to the model as a tool result instead.
  failureMode: "error"
})
```

**Reach for it when** the model needs to fetch data or call an API mid-generation. Define the contract here; group and implement with `Toolkit`.

## Toolkit

`effect/unstable/ai/Toolkit` — unstable

A typed bundle of tools plus their handler implementations. `Toolkit.make(...tools)` groups any number of `Tool`s; `toolkit.toLayer(...)` produces a `Layer` satisfying every handler. The framework decodes parameters, invokes the right handler, validates the result, and feeds it back to the model automatically.

Handlers are plain Effects and can yield other services. `Toolkit.merge` combines toolkits. Provider-defined tools (e.g. `OpenAiTool.WebSearch`) can sit alongside user tools and run server-side, so they require no handler in `toLayer`.

```ts
import { Context, Effect, Layer, Schema } from "effect"
import { AiError, LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { OpenAiLanguageModel } from "@effect/ai-openai"

// Kept self-contained here; a real module would reuse the Tool declared above.
const LookupCompBand = Tool.make("LookupCompBand", {
  description: "Look up the salary band for a job level",
  parameters: Schema.Struct({ level: Schema.Int }),
  success: Schema.Struct({
    level: Schema.Int,
    min: Schema.Finite,
    mid: Schema.Finite,
    max: Schema.Finite
  })
})

const CompToolkit = Toolkit.make(LookupCompBand /*, GetEmployee, … */)

// Implement every handler. Use the effectful toLayer factory only when
// constructing the handlers themselves needs services.
const CompToolkitLayer = CompToolkit.toLayer({
  LookupCompBand: Effect.fn("LookupCompBand")(function*({ level }) {
    // In real code, yield* an Hris service and read the band table.
    return { level, min: 150_000, mid: 185_000, max: 220_000 }
  })
})

// Wire it into a model call. Set toolChoice: "required" to force a tool call.
class CompAssistant extends Context.Service<CompAssistant, {
  answer: (q: string) => Effect.Effect<string, AiError.AiError>
}>()("app/CompAssistant") {
  static layer = Layer.effect(
    CompAssistant,
    Effect.gen(function*() {
      const toolkit = yield* CompToolkit // resolves handlers from context
      // Capture OpenAiClient while constructing this service, so callers of
      // answer only see the declared AiError and no provider requirement.
      const model = yield* OpenAiLanguageModel.model("gpt-5.2").captureRequirements
      return CompAssistant.of({
        answer: Effect.fn("answer")(function*(question: string) {
          const response = yield* LanguageModel.generateText({
            prompt: question,
            toolkit,
            toolChoice: "auto"
          })
          // Inspect what the model did: response.toolCalls / response.toolResults
          return response.text
        }, Effect.provide(model))
      })
    })
  ).pipe(Layer.provide(CompToolkitLayer))
}
```

**Reach for it when** exposing one or more tools to a model. Define tools with `Tool`, group here, implement handlers with `toLayer`, and pass the toolkit to `generateText` or `Chat`.

## Prompt

`effect/unstable/ai/Prompt` — unstable

The provider-neutral representation of conversation input: an ordered list of `Message`s (system/user/assistant), each composed of typed `Part`s (text, file, reasoning, tool-call, tool-result).

`RawInput` means you can pass a plain string, an array of message objects, or a real `Prompt` — `Prompt.make` normalizes all three. Combinators: `Prompt.empty`, `concat` (append), `setSystem` (replace system message), `fromMessages`, and `fromResponseParts` (convert a model response into prompt history).

```ts
import { Prompt } from "effect/unstable/ai"

// A string is the simplest prompt (becomes a single user message).
const p0 = Prompt.make("Summarize this employee's review in one paragraph.")

// Build structured, multi-message prompts and compose them.
const system = Prompt.make([{ role: "system", content: "You are a compensation analyst." }])
const user = Prompt.make([{ role: "user", content: "Is this raise within band?" }])

const combined = Prompt.concat(system, user)
// Replace whatever system message exists with a new one.
const retargeted = Prompt.setSystem(combined, "You are a strict comp-policy reviewer.")
```

**Reach for it when** assembling prompts programmatically — injecting a system persona, stitching few-shot examples, or passing multi-part (text + file) input. For trivial calls, pass a string directly.

## Response

`effect/unstable/ai/Response` — unstable

The typed vocabulary of model output. A non-streaming call returns a `GenerateTextResponse` whose `content` is an array of `Part`s; streaming yields a sequence of `StreamPart`s. Convenience getters avoid manual part parsing.

Output is a tagged stream of parts: `text-start` / `text-delta` / `text-end`, `reasoning-*`, `tool-call`, `tool-result`, and a terminal `finish` carrying finish reason and token `Usage`. Accessors: `.text`, `.reasoningText`, `.toolCalls`, `.toolResults`, `.finishReason`, and `.usage` (with nested `inputTokens`/`outputTokens` breakdowns).

```ts
import { Effect } from "effect"
import { LanguageModel, type Response } from "effect/unstable/ai"

const inspect = Effect.gen(function*() {
  const res = yield* LanguageModel.generateText({ prompt: "Draft a one-line raise rationale." })

  res.text             // concatenated text parts
  res.finishReason     // "stop" | "length" | "tool-calls" | …
  res.usage.inputTokens.total
  res.usage.outputTokens.total

  // When streaming, branch on the part tag:
  const onPart = (part: Response.StreamPart<{}>) => {
    if (part.type === "text-delta") return part.delta
    if (part.type === "finish") return `done: ${part.reason}`
    return ""
  }
  return onPart
})
```

**Reach for it when** you need more than the final string — token accounting, finish reasons, reasoning traces, or precise streaming part handling.

## EmbeddingModel

`effect/unstable/ai/EmbeddingModel` — unstable

A provider-agnostic service for turning text into vectors. `embed(input)` returns one embedding; `embedMany(inputs)` returns a batch with usage metadata. The single-input path is backed by a `RequestResolver`, so concurrent `embed` calls are automatically batched into one provider request.

Write against `EmbeddingModel.EmbeddingModel`; provide a provider Layer (e.g. `OpenAiEmbeddingModel.model("text-embedding-3-small", { dimensions: 1536 })`). Results preserve input order; `embedMany([])` short-circuits without calling the provider. The configured vector size is available via the `EmbeddingModel.Dimensions` service.

```ts
import { Effect } from "effect"
import { EmbeddingModel } from "effect/unstable/ai"
import { OpenAiEmbeddingModel } from "@effect/ai-openai"

// Embed job descriptions so you can match roles, detect duplicate reqs, or
// power semantic search over the org's open positions.
const embedJobDescriptions = Effect.gen(function*() {
  const model = yield* EmbeddingModel.EmbeddingModel

  // Auto-batched: these two run concurrently but hit the provider once.
  const [backend, frontend] = yield* Effect.all(
    [
      model.embed("Senior Backend Engineer — distributed systems, Go, on-call"),
      model.embed("Senior Frontend Engineer — React, design systems, a11y")
    ],
    { concurrency: "unbounded" }
  )

  // Or batch explicitly; response.embeddings keeps input order.
  const batch = yield* model.embedMany([
    "Staff Data Scientist",
    "Engineering Manager",
    "Product Designer"
  ])
  return {
    backend: backend.vector,
    frontend: frontend.vector,
    count: batch.embeddings.length
  }
}).pipe(
  Effect.provide(
    OpenAiEmbeddingModel.model("text-embedding-3-small", { dimensions: 1536 })
  )
)
```

**Reach for it when** building semantic search, role-matching, deduplication, or RAG retrieval — anything requiring text-to-vector conversion with automatic batching.

## Model

`effect/unstable/ai/Model` — unstable

The provider-agnostic handle every provider's `.model(...)` returns. A `Model` is a `Layer` that supplies AI services (`LanguageModel`, optionally `EmbeddingModel`/`Dimensions`) and records two context values: `Model.ProviderName` and `Model.ModelName`.

`Model.make(provider, name, layer)` wraps any Layer producing a `LanguageModel` into a labeled, providable handle — useful for adapters (Bedrock, self-hosted models) not covered by satellite packages. Use `model.captureRequirements` to fold the provider's client requirement into a service Layer; read `Model.ProviderName`/`ModelName` to log or branch on which model ran.

```ts
import { Effect, Layer } from "effect"
import { LanguageModel, Model } from "effect/unstable/ai"

declare const bedrockLayer: Layer.Layer<LanguageModel.LanguageModel>

// Wrap any LanguageModel layer into a labeled, provider-agnostic handle.
const bedrock = Model.make("amazon-bedrock", "claude-3-5-haiku", bedrockLayer)

const program = Effect.gen(function*() {
  const provider = yield* Model.ProviderName // "amazon-bedrock"
  const name = yield* Model.ModelName      // "claude-3-5-haiku"
  yield* Effect.log(`drafting review summary with ${provider}/${name}`)
  return yield* LanguageModel.generateText({ prompt: "Summarize this review." })
}).pipe(Effect.provide(bedrock))
```

**Reach for it when** you need an unsupported provider, or want to read/log which provider+model handled a request.

## Tokenizer

`effect/unstable/ai/Tokenizer` — unstable

A service for counting tokens and truncating a `Prompt` to a token budget. `tokenize(input)` returns the token array (use `.length` for a count); `truncate(input, maxTokens)` drops whole messages from the front until the prompt fits.

`Tokenizer.make({ tokenize })` builds the service from a single tokenizing function — wrap a real provider tokenizer (e.g. tiktoken) or a cheap word-splitter for tests. `truncate` is implemented on top of `tokenize` by default.

```ts
import { Effect } from "effect"
import { Tokenizer } from "effect/unstable/ai"

// Estimate the size of a review packet before sending it to the model.
const countTokens = Effect.gen(function*() {
  const tokenizer = yield* Tokenizer.Tokenizer
  const tokens = yield* tokenizer.tokenize("Q3 self-review and manager feedback…")
  return tokens.length
})

// A simple word-based tokenizer service (swap in a real BPE one for prod).
const WordTokenizer = Tokenizer.make({
  tokenize: (prompt) =>
    Effect.succeed(
      prompt.content
        .flatMap((msg) =>
          typeof msg.content === "string"
            ? msg.content.split(" ")
            : msg.content.flatMap((p) => (p.type === "text" ? p.text.split(" ") : []))
        )
        .map((_, i) => i)
    )
})
```

**Reach for it when** you need to stay under a context window, estimate cost before a call, or trim long histories before sending.

## IdGenerator

`effect/unstable/ai/IdGenerator` — unstable

A service that mints identifiers for AI artifacts, primarily tool-call IDs. Uses Effect's `Random` under the hood, so it is deterministic under a seeded test runtime.

`IdGenerator.layer({ alphabet, prefix, separator, size })` produces IDs like `tool_A1B2C3D4`. The framework uses a sensible default; override to match a provider's expected ID format or to get reproducible IDs in tests via a custom `Service`.

```ts
import { Effect } from "effect"
import { IdGenerator } from "effect/unstable/ai"

const useIds = Effect.gen(function*() {
  const gen = yield* IdGenerator.IdGenerator
  return yield* gen.generateId() // e.g. "tool_A1B2C3D4"
})

// Configure the format, then provide it as a layer.
const program = useIds.pipe(
  Effect.provide(IdGenerator.layer({
    alphabet: "0123456789ABCDEF",
    prefix: "tool",
    separator: "_",
    size: 8
  }))
)
```

**Reach for it when** you need stable, formatted, or deterministic tool-call IDs in tests, or a specific ID shape a provider expects.

## Telemetry

`effect/unstable/ai/Telemetry` — unstable

Helpers that write standardized GenAI attributes onto OpenTelemetry spans, following OTel semantic conventions for LLMs (system, model, temperature, token usage, etc.). AI calls are already traced; this enriches those spans.

`addGenAIAnnotations(span, { system, request, response, usage })` stamps the correct attribute keys (it mutates the span). Provide a `CurrentSpanTransformer` to automatically annotate every AI span with custom logic. Pairs with `@effect/opentelemetry` for export.

```ts
import { Effect } from "effect"
import { Telemetry } from "effect/unstable/ai"

// Stamp GenAI attributes on the span around a review-drafting call so cost and
// token usage show up on your comp-tooling dashboards.
const annotated = Effect.gen(function*() {
  const span = yield* Effect.currentSpan
  Telemetry.addGenAIAnnotations(span, {
    system: "openai",
    request: { model: "gpt-5.2", temperature: 0.7 },
    usage: { inputTokens: 100, outputTokens: 50 }
  })
})
```

**Reach for it when** running AI in production and needing spans/metrics aligned with GenAI OTel conventions for cost dashboards, latency, and token tracking.

## AiError

`effect/unstable/ai/AiError` — unstable

The typed failure channel for all AI operations. Every provider call, tool invocation, and structured decode fails with an `AiError` carrying a structured `reason`, enabling LLM failures to be handled like any other Effect error.

One umbrella error (`AiError`, tag `"AiError"`) wrapping a discriminated `reason`: `RateLimitError`, `QuotaExhaustedError`, `AuthenticationError`, `ContentPolicyError`, `InvalidRequestError`, `InternalProviderError`, `InvalidOutputError`/`StructuredOutputError` (bad/unparseable model output), plus tool errors (`ToolNotFoundError`, `ToolParameterValidationError`, …). `AiError.AiErrorReason` is itself a `Schema`, so it can be embedded in domain error types.

```ts
import { Effect, Schedule, Schema } from "effect"
import { AiError, LanguageModel } from "effect/unstable/ai"

// Wrap provider failures in your own tagged error, reusing the reason schema.
class ReviewServiceError extends Schema.TaggedError<ReviewServiceError>()("ReviewServiceError", {
  reason: AiError.AiErrorReason
}) {}

const draftSummary = LanguageModel.generateText({
  prompt: "Summarize this employee's review."
}).pipe(
  // Retry only transient rate-limit failures with exponential backoff.
  Effect.retry({
    while: (error) => error.reason._tag === "RateLimitError",
    schedule: Schedule.exponential("200 millis")
  }),
  // Translate anything that still fails into our domain error.
  Effect.catchTag("AiError", (error) =>
    Effect.fail(new ReviewServiceError({ reason: error.reason }))
  )
)
```

**Reach for it when** you need robust error handling — retry on rate limits, surface auth/quota problems, or translate provider failures into domain error types.

## ResponseIdTracker

`effect/unstable/ai/ResponseIdTracker` — unstable

An optimization service for providers that support continuing from a prior response (e.g. OpenAI's Responses API `previousResponseId`). Records which prompt messages were sent with each response; a follow-up call can send only the new messages plus the prior response ID.

`markParts(parts, responseId)` records what produced a response; `prepareUnsafe(prompt)` returns an `Option` of `{ previousResponseId, prompt }` — the untracked suffix after the last assistant turn — when the prefix is fully recognized. Provide it as a Layer; compatible providers use it transparently to shrink request payloads.

```ts
import { Effect } from "effect"
import { Chat, ResponseIdTracker } from "effect/unstable/ai"

// Provide the tracker so a compatible provider reuses previousResponseId
// instead of re-sending the entire HRBP conversation each turn.
const withTracking = Effect.gen(function*() {
  const tracker = yield* ResponseIdTracker.make
  const chat = yield* Chat.fromPrompt("You are an HR policy assistant.")
  const provideTracker = Effect.provideService(
    ResponseIdTracker.ResponseIdTracker,
    tracker
  )

  yield* chat.generateText({ prompt: "Summarize our promotion policy." }).pipe(provideTracker)
  return yield* chat.generateText({ prompt: "Now list the exceptions." }).pipe(provideTracker)
})
```

Run the whole conversation with one compatible `LanguageModel` service. The same tracker instance must span the calls; constructing a tracker and returning it without providing `ResponseIdTracker.ResponseIdTracker` has no effect. OpenAI's WebSocket-mode integration (`OpenAiClient.layerWebSocketMode` / `withWebSocketMode`) installs a tracker; do not assume ordinary provider layers do.

**Reach for it when** running long multi-turn sessions against a provider that supports incremental continuation, to cut bandwidth and latency by not re-sending history.

## McpSchema

`effect/unstable/ai/McpSchema` — unstable

The complete Model Context Protocol (MCP) wire format as Effect `Schema`s and `Rpc` definitions: requests/results, resources and resource templates, prompts, completions, capabilities, and JSON-RPC error codes. The typed contract `McpServer` is built on.

Commonly used helpers: `McpSchema.param(name, schema)` declares typed parameters inside resource URI templates; `Role`, `Annotations`, and error types are also referenced directly. The heavier protocol machinery (Initialize, ListResources, CallTool, notifications) is consumed by the server runtime.

```ts
import { Schema } from "effect"
import { McpSchema } from "effect/unstable/ai"

// A typed URI-template parameter — e.g. the employee id in an HRIS resource.
const employeeIdParam = McpSchema.param("employeeId", Schema.String)

// Error codes and typed errors are provided too, e.g. for custom handlers.
McpSchema.INVALID_PARAMS_ERROR_CODE // -32602
```

**Reach for it when** building or extending an MCP server and needing the protocol's typed building blocks — especially `param` for resource/prompt templates.

## McpProtocol

`effect/unstable/ai/McpProtocol` — unstable

The versioned protocol adapter registry used by `McpServer`. The audited release implements MCP `2025-06-18` as `McpProtocol.v2025_06_18`; it binds the matching client/server RPC groups and transport rules. Server transports require a non-empty `protocols` list so negotiation is explicit rather than silently assuming whichever MCP revision a client sends.

```ts
import { McpProtocol, McpServer } from "effect/unstable/ai"

const StdioMcp = McpServer.layerStdio({
  name: "Comp Server",
  version: "1.0.0",
  protocols: [McpProtocol.v2025_06_18]
})
```

The 2025-06-18 adapter rejects JSON-RPC batches on its transport and requires the MCP protocol-version header where the transport carries headers. Put any future adapters you intentionally support in the same list; initialization selects the requested version and the server uses the first adapter as its fallback/default.

Streamable HTTP is strict at the boundary. If a request carries `Origin`, `layerHttp` returns 403 unless that exact origin appears in `allowedOrigins`. POST requires `Content-Type: application/json` (otherwise 415) and an `Accept` header that includes both `application/json` and `text/event-stream` with positive quality (otherwise 406).

**Reach for it when** constructing an MCP transport or deciding which protocol revisions a server is willing to negotiate.

## McpServer

`effect/unstable/ai/McpServer` — unstable

A batteries-included framework for building MCP servers — the protocol that lets editors and AI clients (Claude Desktop, IDEs) discover tools, resources, and prompts. Handles JSON-RPC plumbing; capabilities are registered as Layers and a transport is chosen.

`McpServer.toolkit(toolkit)` exposes a `Toolkit` as MCP tools; `McpServer.resource\`uri/${param}\`({...})` exposes resources/templates (with auto-completion); `McpServer.prompt({...})` exposes parameterized prompts. Transports: `layerStdio` (desktop clients), `layerHttp` (mount on an `HttpRouter`). Launch with `Layer.launch` + `NodeRuntime.runMain`.

```ts
import { Effect, Layer, Logger, Schema } from "effect"
import { NodeRuntime, NodeStdio } from "@effect/platform-node"
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai"

const employeeIdParam = McpSchema.param("employeeId", Schema.String)

// A resource template: hris://employee/<employeeId>, with id completion.
const EmployeeCard = McpServer.resource`hris://employee/${employeeIdParam}`({
  name: "Employee Card",
  completion: { employeeId: (_) => Effect.succeed(["emp-4821", "emp-5099"]) },
  content: Effect.fn(function*(_uri, employeeId) {
    return `Employee ${employeeId}: level 4, base 185000, rating "exceeds"`
  })
})

// A parameterized prompt the client can invoke.
const RaisePrompt = McpServer.prompt({
  name: "RaiseRationale",
  description: "Draft a within-band raise rationale for an employee",
  parameters: { employeeId: Schema.String },
  completion: { employeeId: () => Effect.succeed(["emp-4821", "emp-5099"]) },
  content: ({ employeeId }) =>
    Effect.succeed(`Write a merit-increase rationale for ${employeeId}, staying within band.`)
})

// Merge capabilities, provide the stdio server, and launch.
const ServerLayer = Layer.mergeAll(EmployeeCard, RaisePrompt).pipe(
  Layer.provide(McpServer.layerStdio({
    name: "Comp Server",
    version: "1.0.0",
    protocols: [McpProtocol.v2025_06_18]
  })),
  Layer.provide(NodeStdio.layer),
  Layer.provide(Layer.succeed(Logger.LogToStderr)(true))
)

Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
```

> **Tip:** Define a `Toolkit` once — say your `CompToolkit` with `LookupCompBand` — and you can both call it from a `LanguageModel` *and* expose it to external clients via `McpServer.toolkit(CompToolkit)`. Same handlers, two surfaces.

**Reach for it when** you want capabilities usable from Claude Desktop, an IDE, or any MCP client — without writing JSON-RPC by hand.

## AnthropicStructuredOutput

`effect/unstable/ai/AnthropicStructuredOutput` — unstable

The adapter enabling `generateObject` with Anthropic. `toCodecAnthropic(schema)` converts an Effect `Schema.Codec` into the JSON Schema subset Anthropic accepts and a matching codec to decode the model's reply back into the application type. The Anthropic provider wires this in automatically as its `codecTransformer`.

Schema rewriting is lossless where possible: tuples become numeric-key objects, records become `[key, value]` arrays, optional props become nullable required props, `oneOf` becomes `anyOf`. Unsupported shapes throw at conversion time. Call directly only when you need the raw JSON Schema for a custom Anthropic request.

**Reach for it when** you need Anthropic-compatible JSON Schema by hand. For normal use, call `generateObject` with the Anthropic provider — this runs automatically.

## OpenAiStructuredOutput

`effect/unstable/ai/OpenAiStructuredOutput` — unstable

The OpenAI counterpart. `toCodecOpenAI(schema)` turns an Effect `Schema.Codec` into OpenAI's structured-output JSON Schema subset plus a decoding codec. The OpenAI provider uses it automatically for `generateObject` and tool parameter schemas.

OpenAI-specific rewriting: `allOf` is flattened (OpenAI does not support it) and multiple regex filters are merged into one `pattern`. Unsupported schema kinds fail loudly at conversion. Use directly only to generate JSON Schema for a bespoke OpenAI call.

**Reach for it when** you need OpenAI-compatible JSON Schema directly. Otherwise, `generateObject` with the OpenAI provider already uses it.

## Provider packages

Primitives live in `effect/unstable/ai`; concrete providers ship as satellite packages. Each exposes `Client.layerConfig({ apiKey: Config.redacted(...) })` (requires an `HttpClient`) and a `LanguageModel.model(name)` (a `Model` Layer). All produce the same `LanguageModel` service; switching providers is a one-line Layer change.

- **pkg @effect/ai-openai** — OpenAI Responses API. `OpenAiClient.layerConfig`, `OpenAiLanguageModel.model("gpt-5.2")`, `OpenAiEmbeddingModel.model(name, { dimensions })`, provider-defined tools via `OpenAiTool` (e.g. `OpenAiTool.WebSearch`), and `OpenAiTelemetry`.

- **pkg @effect/ai-anthropic** — Anthropic Messages API. `AnthropicClient.layerConfig`, `AnthropicLanguageModel.model("claude-opus-4-6")`, `AnthropicTool`, and `AnthropicTelemetry`. Structured output bridged automatically through `AnthropicStructuredOutput`.

- **pkg @effect/ai-openrouter** — OpenRouter's unified gateway to many models. `OpenRouterClient.layerConfig` (supports `siteReferrer`/`siteTitle` for attribution) and `OpenRouterLanguageModel.model(name)` — one key, hundreds of models.

- **pkg @effect/ai-openai-compat** — Any OpenAI-compatible endpoint (local LLMs, Together, Groq, vLLM…). Same `OpenAiClient`/`OpenAiLanguageModel`/`OpenAiEmbeddingModel` API — point `apiUrl` at your server.

```ts
// Swapping providers is a one-line change at the edge — comp logic is untouched.
import { Config, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter"

const AnthropicLive = AnthropicLanguageModel.model("claude-opus-4-6").pipe(
  Layer.provide(
    AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })
      .pipe(Layer.provide(FetchHttpClient.layer))
  )
)

const OpenRouterLive = OpenRouterLanguageModel.model("openai/gpt-5.2").pipe(
  Layer.provide(
    OpenRouterClient.layerConfig({
      apiKey: Config.redacted("OPENROUTER_API_KEY"),
      siteTitle: Config.succeed("Comp Planner")
    }).pipe(Layer.provide(FetchHttpClient.layer))
  )
)
```

> **Note:** Configure a provider client from `Config` → write comp logic against `LanguageModel` → call `generateText` for a review summary, `generateObject` with a `Schema` for a validated `RaiseRecommendation`, and pass a `Toolkit` (e.g. `LookupCompBand`) for tool calls → provide a concrete `.model(...)` Layer at the edge. Same four moves whether you're on OpenAI, Anthropic, OpenRouter, or a local model.
