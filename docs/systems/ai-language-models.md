# AI & Language Models

`effect/unstable/ai` provides a provider-agnostic AI toolkit. Business logic depends on `LanguageModel.LanguageModel` from context; a concrete provider (OpenAI, Anthropic, OpenRouter, or any OpenAI-compatible endpoint) is injected as a `Layer`. Schemas validate structured outputs and tool parameters, streaming is a `Stream`, errors are typed, and all calls are traced. Swapping providers requires changing a Layer, not application code. For fixed-answer judgments (a label, a rating on a scale, or a probability) there is a second, narrower service, [`DecisionModel`](#decisionmodel), with its own providers.

> **Official companions:** The release-matched [AI examples](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.116/ai-docs/src/71_ai) cover language-model calls, tools, and stateful chat. The broader [AI documentation source tree](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.116/ai-docs/src) and [`LLMS.md`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.116/LLMS.md) are the official executable corpus and coding-agent entry point.

> **Note:** Every example below assumes a provider client Layer built from `Config`. Providers need an `HttpClient` — you choose which one (here `FetchHttpClient`):

```ts
import { Config, Layer } from "effect"
import { OpenAiClient } from "@effect/ai-openai"
import { FetchHttpClient } from "effect/unstable/http"

// Reads OPENAI_API_KEY from your ConfigProvider; the key is Redacted, so it
// never leaks into logs. Provide an HttpClient for the provider to use.
const OpenAiClientLayer = OpenAiClient.layerConfig({
  apiKey: Config.Redacted("OPENAI_API_KEY")
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

### Tool-call resolution: concurrency and manual dispatch

When the `toolkit` you pass carries handlers, `generateText`, `generateObject`, and `streamText` resolve the model's tool calls **during the call**: parameters are decoded, handlers run, and the results come back in `response.toolResults`. Two options on every generation call govern that step.

| Option | Default | Rule |
| --- | --- | --- |
| `concurrency` | `"unbounded"` | **Set a number whenever a handler touches a rate-limited or stateful dependency**, because one model turn may request many tool calls and they all start at once by default. |
| `disableToolCallResolution` | `false` | **Pass `true` when the application must run its own gates (authorization, approval, idempotency claim) before any handler executes.** The tools are still advertised to the model; no handler runs. |

With `disableToolCallResolution: true` the response carries tool calls whose `params` stay in their **encoded** form (they are still checked against the parameter schema's encoded side, so a malformed call fails with `InvalidOutputError`), no handler result is produced for them, and handler errors and handler services drop out of the call's error and requirement types. Dispatch a call yourself through the toolkit's `handle(name, encodedParams, toolCallId?, parseOptions?)`, which decodes the parameters, runs the handler, and returns a `Stream` of `{ result, encodedResult, isFailure, failureOrigin, preliminary }` values: preliminary results first, then the final one. The optional `SchemaAST.ParseOptions` (added in `rc.116`) tune the parameter decode; `{ onExcessProperty: "error" }` rejects arguments the schema does not declare. With `failureMode: "error"` a parameter failure fails the returned Effect and a handler failure fails the stream instead of producing a final value.

Every failure is tagged with the phase that produced it, a `Tool.FailureOrigin`: `"parameters"` (arguments did not decode), `"handler"` (the handler failed), or `"result"` (the handler's output failed to validate or encode). A returned failure carries it as `failureOrigin`; a raised one carries it as the `Toolkit.FailureOrigin` annotation on its `Cause`, read with `Context.get(Cause.annotations(cause), Toolkit.FailureOrigin)`. Use it to tell "the model sent bad arguments" from "the tool broke" without parsing messages.

```ts
import { Effect, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"

class RaiseGateDenied extends Schema.TaggedError<RaiseGateDenied>()("RaiseGateDenied", {
  toolCallId: Schema.String,
  reason: Schema.String
}) {}

const SubmitRaise = Tool.make("SubmitRaise", {
  description: "Submit a merit increase for HRBP approval",
  parameters: Schema.Struct({ employeeId: Schema.String, increasePct: Schema.Finite }),
  success: Schema.Struct({ requestId: Schema.String })
})
const RaiseToolkit = Toolkit.make(SubmitRaise)

// Application policy: actor, tenant, band limits, idempotency claim.
declare const authorizeRaise: (
  toolCallId: string,
  params: { readonly employeeId: string; readonly increasePct: number }
) => Effect.Effect<void, RaiseGateDenied>

const proposeAndSubmit = Effect.fn("proposeAndSubmit")(function*(notes: string) {
  const toolkit = yield* RaiseToolkit // handlers come from RaiseToolkit.toLayer(...)
  const response = yield* LanguageModel.generateText({
    prompt: `Propose a merit increase from these notes:\n${notes}`,
    toolkit,
    disableToolCallResolution: true // the model proposes; nothing executes yet
  })

  const requestIds: Array<string> = []
  for (const call of response.toolCalls) {
    yield* authorizeRaise(call.id, call.params)
    // Run `handle` and drain its stream in the same Effect: the handler is a
    // child fiber of this call, so interrupting the request interrupts it too.
    const results = yield* toolkit.handle(call.name, call.params, call.id)
    const final = yield* Stream.runLast(results)
    // `result` is the success type, the declared failure type, or a
    // Tool.ExecutionFailure; `isFailure` is a plain boolean, so narrow structurally.
    if (final._tag === "Some" && "requestId" in final.value.result) {
      requestIds.push(final.value.result.requestId)
    }
  }
  return requestIds
})
```

> **Note:** When a response finishes with an incomplete reason (anything other than `"stop"`, `"tool-calls"`, or `"pause"` — for example `"length"`), automatic resolution does not start handlers. Each executable tool call instead receives a synthesized failed result of type `"execution-interrupted"` so the history stays well-formed for the next provider request.

### Service types are branded

`LanguageModel.LanguageModel`, `EmbeddingModel.EmbeddingModel`, `Chat.Chat`, and `Reactivity.Reactivity` each name **both** the Context key and the service interface; the older `LanguageModel.Service` / `Chat.Service` / `EmbeddingModel.Service` type aliases no longer exist. Each interface carries a `[TypeId]` brand. **Build implementations with the module's constructor** (`LanguageModel.make`, `EmbeddingModel.make`, `Chat.empty` / `Chat.fromPrompt`, `Reactivity.make`), because the constructor adds the brand; an object literal written by hand must include `[LanguageModel.TypeId]: LanguageModel.TypeId` (and the equivalent for the other modules) to type-check.

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

For an agent, loop until the model stops calling tools — `Chat` folds each tool result back into history between turns. **Give the loop a turn limit**: a model that keeps requesting tools would otherwise spend tokens until something external stops it.

```ts
import { Effect, Schema } from "effect"
import { Chat, Tool, Toolkit } from "effect/unstable/ai"

class AgentTurnLimit extends Schema.TaggedError<AgentTurnLimit>()("AgentTurnLimit", {
  turns: Schema.Int
}) {}

const runHrbpAgent = <Tools extends Record<string, Tool.Any>>(
  question: string,
  tools: Toolkit.Toolkit<Tools>,
  maxTurns = 6
) =>
  Effect.gen(function*() {
    const session = yield* Chat.fromPrompt([
      { role: "system", content: "Use tools to ground every comp answer in real band data." },
      { role: "user", content: question }
    ])
    for (let turn = 1; turn <= maxTurns; turn++) {
      const response = yield* session.generateText({ prompt: [], toolkit: tools, concurrency: 4 })
      // Tool calls were executed and their results added to history for us.
      if (response.toolCalls.length === 0) return response.text // final answer
    }
    return yield* new AgentTurnLimit({ turns: maxTurns })
  })
```

**History rules.**

- **`Chat` is in-process session state, not a store.** Its history `Ref` has no tenant, version, or concurrency control; wrap it, or use `Chat.makePersisted({ storeId })` / `Chat.layerPersisted` over a durable `BackingPersistence` layer (see [Persistence](../tooling/persistence)), when several requests or processes can touch one conversation.
- **Exported history is a persisted format.** `exportJson` keeps text parts, provider options, and files generated by the model when a response is folded back into the prompt, so a rehydrated session replays the same context. Tool results inside that history are encoded with the schema chosen by their `isFailure` flag (see [Tool](#tool)); review stored histories when a tool's success or failure schema changes.
- **Completed approvals stay in the response.** When a non-streaming turn resolves a previously approved tool call, the finished result is retained in that response, so `Chat` records it and later turns do not execute the approved tool again.
- **Keep incomplete turns out of later prompts.** If a turn fails, times out, or is interrupted mid-stream, persist that status and rebuild future context only from turns that reached a terminal `finish` part.

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

### Failure results and their wire format

A tool call ends in one of four shapes, and the encoded form of each is a **persisted contract** once it lands in a `Chat` history or your own store.

| Outcome | `isFailure` | Value in `result` | Encoded with |
| --- | --- | --- | --- |
| Handler succeeded | `false` | the `success` type | `success` schema |
| Handler failed with the declared `failure` type (`failureMode: "return"`) | `true` | the `failure` type | `Tool.failureResultSchema(tool)` |
| Framework or handler produced an `AiError` (`failureMode: "return"`) | `true` | `AiError.AiError` | `Tool.failureResultSchema(tool)` |
| Call was denied by an approval response, or never ran because the response finished incomplete | `true` | `Tool.ExecutionFailure` — `{ type: "execution-denied" \| "execution-interrupted", reason }` | `Tool.failureResultSchema(tool)` |

- **Declare `failure` when the model should see a domain error.** `Tool.make(name, { failure: BandNotFound, failureMode: "return" })` types the handler's error channel; `failureMode: "error"` keeps the same failure in the Effect error channel instead.
- **`Tool.failureResultSchema(tool)` is `Schema.Union([AiError.AiError, tool.failureSchema, Tool.ExecutionFailure])`.** Use it, not the bare `failure` schema, when you decode stored failed results.
- **The codec is selected by `isFailure`, never guessed from the value.** A tool with `success: Schema.Number` and `failure: Schema.NumberFromString` stores a failed `404` as `"404"`. Histories written before `rc.113` that encoded failures through the success schema need a migration.
- **`Tool.FailureResult` and `Tool.Result` include `Tool.ExecutionFailure` in both failure modes**, so an exhaustive narrowing of a failed result has one more case. (`Response.ToolResultPart(...)` is typed as a `Schema.Codec` rather than a `Schema.decodeTo`; this only matters if you wrote that type out.)
- **Parameter validation follows `failureMode` too.** A call whose arguments do not decode produces `ToolParameterValidationError` (`toolName` and `description` only — the rejected arguments are no longer attached as `toolParams`). Under `"error"` the generation fails with that `AiError`; under `"return"` the error goes back to the model as a failed tool result so it can correct the call. Either way the handler does not run.

> **Note:** `Tool.dynamic(name, { parameters })` accepts a Schema **or** a raw JSON Schema for tools discovered at runtime (for example from an MCP server). After `tool.setParameters(schema)` the replacement schema is what gets advertised to the model. A tool annotated `.annotate(Tool.Strict, true)` needs an Effect Schema to be served over MCP: from `rc.116` `McpServer.toolkit` / `registerToolkit` dies at registration on a strict dynamic tool whose parameters are raw JSON Schema, because the server could not enforce strictness on it. Annotate intent with `Tool.Title`, `Tool.Readonly`, `Tool.Destructive`, `Tool.Idempotent`, and `Tool.OpenWorld`; `McpServer` forwards them as MCP tool hints.

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

Yielding a toolkit (`yield* CompToolkit`) resolves its handlers from context and returns a `Toolkit.WithHandler` with two members: `tools` and `handle(name, params, toolCallId?)`. `handle` takes the **encoded** parameter type — what a provider or a stored tool call actually holds — decodes it, and returns an Effect of a result `Stream`. That is the entry point for [manual dispatch](#tool-call-resolution-concurrency-and-manual-dispatch) and for tests that exercise one handler without a model.

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

> **Note:** A vector is only comparable with vectors from the same space. Store the provider, model name, `dimensions`, and your own normalization/schema version beside every embedding, and when any of them changes, build a fresh, separately versioned index from new embeddings.

**Reach for it when** building semantic search, role-matching, deduplication, or RAG retrieval — anything requiring text-to-vector conversion with automatic batching.

## Decision

`effect/unstable/ai/Decision` — unstable

A decision definition is plain data: one input `Schema` plus named questions whose answers come from a closed set. `Decision.make({ input, decisions })` builds it; nothing calls a model until [`DecisionModel.decide`](#decisionmodel) answers every decision in the definition in **one** provider call.

Three kinds of question:

| Constructor | Asks | Answer |
| --- | --- | --- |
| `Decision.classify({ instructions, criteria })` | Which label fits; `criteria` maps each label to a description. | `{ label, probabilities, confidence? }` — `label` is the provider's pick and need not be the most probable label. |
| `Decision.rate({ instructions, criteria })` | Where the input sits on an ordered scale; `criteria` lists levels lowest first. | `{ rating, label, probabilities, confidence? }` — `rating` is the probability-weighted position in `[0, levels - 1]` and can fall between two levels; `label` is the most probable level (the first one on a tie). |
| `Decision.probability({ instructions, criteria: { false, true } })` | How likely a statement about the input holds. | `{ probability }` — the probability of `true`. |

Answer keys and label types are inferred from the definition. The constructors validate eagerly and **throw**: `classify` needs at least two labels, `rate` at least two distinct levels, and `make` at least one decision. Define them at module level so a malformed definition fails at startup, not mid-request.

```ts
import { Schema } from "effect"
import { Decision } from "effect/unstable/ai"

// The input schema is the contract: `decide` encodes the value with
// Schema.toCodecJson and sends the JSON as the decision state.
export const RaiseRequest = Schema.Struct({
  employeeId: Schema.String,
  level: Schema.Int,
  requestedIncreasePct: Schema.Finite,
  justification: Schema.String
})

// Three judgments about one raise request, answered together.
export const RaiseRequestTriage = Decision.make({
  input: RaiseRequest,
  decisions: {
    basis: Decision.classify({
      instructions: "What the manager's justification mainly rests on",
      criteria: {
        performance: "Documented results or scope beyond the current level",
        market: "Pay below market for the role, or a competing offer",
        retention: "Flight risk or a critical skill without a backup",
        other: "None of the above"
      }
    }),
    evidence: Decision.rate({
      instructions: "How well the justification is supported by specifics",
      criteria: ["unsupported", "anecdotal", "specific", "documented"]
    }),
    needsHrbpReview: Decision.probability({
      instructions: "The request needs an HR business partner's review before approval",
      criteria: {
        false: "A routine request within merit-cycle policy",
        true: "An exception, an out-of-band amount, or sensitive circumstances"
      }
    })
  }
})
```

**Reach for it when** a question has a fixed answer space — routing, triage, policy checks, quality ratings — and you want the answer as a label or number your code can threshold, not as prose.

## DecisionModel

`effect/unstable/ai/DecisionModel` — unstable

The provider-neutral service that answers a `Decision` definition. `DecisionModel.decide(definition, { input })` encodes the input with `Schema.toCodecJson` (an explicit `undefined` field becomes `null`; an absent one stays absent), sends that state and every decision to the provider in one request, validates the reply, and returns `{ answers, usage }`. It requires `DecisionModel.DecisionModel` plus the input schema's encoding services, and fails only with `AiError`.

The reply is validated before your code sees it; the provider is not trusted to follow the contract:

- every decision is answered with its own kind, and a classify label must be one of its criteria keys;
- each distribution covers every label or level and sums to 1 within `1e-6`; `confidence` and `probability` lie in `[0, 1]`; a rating lies in `[0, levels - 1]`;
- a violation fails with reason `InvalidOutputError`, and an input that cannot be encoded fails with `InvalidUserInputError` before any provider call.

Validation proves shape, not calibration: whether a `0.3` means 30% depends on the provider. Choose thresholds from labeled historical cases, and treat them as application policy.

```ts
import { Effect, Layer, Schema } from "effect"
import { Decision, DecisionModel } from "effect/unstable/ai"
import { TypeSafeDecisionModel } from "@effect/ai-typesafe"

// Kept self-contained here; a real module would import the definition above.
const RaiseRequest = Schema.Struct({
  employeeId: Schema.String,
  requestedIncreasePct: Schema.Finite,
  justification: Schema.String
})

const RaiseRequestTriage = Decision.make({
  input: RaiseRequest,
  decisions: {
    evidence: Decision.rate({
      instructions: "How well the justification is supported by specifics",
      criteria: ["unsupported", "anecdotal", "specific", "documented"]
    }),
    needsHrbpReview: Decision.probability({
      instructions: "The request needs an HR business partner's review before approval",
      criteria: { false: "Routine, within policy", true: "Exception or sensitive" }
    })
  }
})

type Route = "hrbp-review" | "return-to-manager" | "auto-approve"

// Both answers come from one provider call; the thresholds are HR policy.
const routeRaiseRequest = Effect.fn("routeRaiseRequest")(function*(
  request: typeof RaiseRequest.Type
) {
  const { answers } = yield* DecisionModel.decide(RaiseRequestTriage, { input: request })
  const route: Route = answers.needsHrbpReview.probability >= 0.3
    ? "hrbp-review"
    : answers.evidence.rating < 1.5
    ? "return-to-manager"
    : "auto-approve"
  return route
})

declare const request: typeof RaiseRequest.Type

// Production: a provider's `.model(...)` is a Model Layer, like LanguageModel's.
// It still requires TypeSafeClient (see Provider packages below).
const routed = routeRaiseRequest(request).pipe(
  Effect.provide(TypeSafeDecisionModel.model("jev-latest"))
)

// Tests: a scripted provider. The core validates its answers exactly as it
// does a real provider's, and derives the rating label from the distribution.
const ScriptedDecisions = Layer.effect(
  DecisionModel.DecisionModel,
  DecisionModel.make({
    decide: () =>
      Effect.succeed({
        answers: {
          evidence: {
            _tag: "Rate",
            rating: 2.4,
            probabilities: { unsupported: 0.05, anecdotal: 0.1, specific: 0.25, documented: 0.6 }
          },
          needsHrbpReview: { _tag: "Probability", probability: 0.1 }
        },
        usage: { inputTokens: undefined, outputTokens: undefined }
      })
  })
)

const routedInTest = routeRaiseRequest(request).pipe(Effect.provide(ScriptedDecisions))
```

`DecisionModel.make({ decide })` is also how to adapt an unsupported provider: `decide` receives `{ state, decisions }` and returns answers tagged `"Classify"`, `"Rate"`, or `"Probability"` plus token `usage`. Returned answers and their probability records have `null` prototypes, so compare fields rather than deep-equality against an object literal.

**DecisionModel or `generateObject`?**

| Need | Use |
| --- | --- |
| A label, a level, or a likelihood from a fixed set, with a probability distribution to threshold on | `DecisionModel` |
| Several such judgments over the same input, in one call and one validated response | `DecisionModel` with several named decisions |
| Free-form fields, a rationale, nested data, a system prompt or conversation history, or tool calls | `LanguageModel.generateObject` / `generateText` |
| A provider that has no decisions API | `LanguageModel.generateObject` with a `Schema.Literals` field |

A `confidence` field in a `generateObject` schema is text the model wrote about itself; a `DecisionModel` answer is a range-checked probability, or a distribution the core checked for completeness and normalization. The trade is expressiveness: a decision has only its per-question `instructions` and `criteria`, no prompt, history, or tools.

**Reach for it when** routing, triage, or scoring must be a number your code can threshold and audit. Keep `LanguageModel` for anything that needs words, structure, or tools.

## Model

`effect/unstable/ai/Model` — unstable

The provider-agnostic handle every provider's `.model(...)` returns. A `Model` is a `Layer` that supplies AI services (`LanguageModel`, `EmbeddingModel`/`Dimensions`, or `DecisionModel`) and records two context values: `Model.ProviderName` and `Model.ModelName`.

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

**`truncate` keeps the newest messages.** It walks backward from the last message, re-tokenizes the whole retained suffix each time (so tokens the tokenizer charges *between* messages count against the budget), and stops at the first message that would overflow. It never splits a message, and it does not pin a leading system message — re-apply the system prompt with `Prompt.setSystem` after truncating when the persona must survive. Token counts from your tokenizer are an estimate for budgeting; the provider's reported `usage` is the reconciliation.

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
  // Retry only transient rate-limit failures, and only a bounded number of
  // times: `upTo` caps both the recurrence count and the total backoff window.
  Effect.retry({
    while: (error) => error.reason._tag === "RateLimitError",
    schedule: Schedule.exponential("200 millis").pipe(
      Schedule.upTo({ times: 3, duration: "10 seconds" })
    )
  }),
  // One absolute deadline for the call and all of its retries.
  Effect.timeout("30 seconds"),
  // Translate anything that still fails into our domain error.
  Effect.catchTag("AiError", (error) =>
    Effect.fail(new ReviewServiceError({ reason: error.reason }))
  )
)
```

### Classifying a failure before retrying

Every reason class has an `isRetryable` getter, and `AiError` forwards it (`error.isRetryable`) together with `error.retryAfter` — the provider's requested delay when the reason is a `RateLimitError` that carried one.

| `reason._tag` | `isRetryable` | What to do |
| --- | --- | --- |
| `RateLimitError` | `true` | Back off; honor `retryAfter` when present. |
| `InternalProviderError`, `NetworkError` with `reason: "TransportError"` | `true` | Bounded retry. |
| `InvalidOutputError`, `StructuredOutputError`, `ToolNotFoundError`, `ToolParameterValidationError` | `true` | The model produced something unusable; a retry re-bills the whole prompt, so cap it tightly. |
| `AuthenticationError`, `QuotaExhaustedError`, `ContentPolicyError`, `InvalidRequestError`, `UnsupportedSchemaError`, `InvalidToolResultError`, `ToolResultEncodingError`, `ToolConfigurationError`, `ToolkitRequiredError`, `InvalidUserInputError`, `UnknownError`, other `NetworkError` reasons | `false` | Fix credentials, quota, input, or code; do not loop. |

- **Retry only before output or side effects exist.** Never retry after streamed text has reached the caller or after a mutating tool was dispatched; count every retry against the same token and time budget as the first attempt.
- **A fallback model is a different capability, not a retry.** Re-validate tool, schema, and media support for it, and never use a fallback to get around a `ContentPolicyError`.
- **`AuthenticationError` has an optional `description`.** On HTTP 401/403 the provider's own error text is passed through and appended to the kind-based hint, so logs say what was actually rejected. `AiError.HttpRequestDetails` and `AiError.HttpResponseDetails` are exported schemas for the request/response context attached to HTTP-derived reasons.

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

The versioned protocol adapter registry used by `McpServer`. The audited release ships five adapters — `McpProtocol.v2024_11_05`, `v2025_03_26`, `v2025_06_18`, `v2025_11_25`, and (new in `rc.116`) `v2026_07_28` — each binding the matching client/server RPC groups and transport rules. The `2025-11-25` adapter adds sampling with tools, form- and URL-based elicitation, and `McpSchema.Icon` metadata (source URI, MIME type, sizes, light/dark theme) for server info, resources, resource templates, prompts, and tools. Server transports require a non-empty `protocols` list so negotiation is explicit rather than silently assuming whichever MCP revision a client sends.

**`2026-07-28` is stateless.** It drops `initialize` and protocol-level sessions: each request carries its own protocol version and client metadata, a client can call `server/discover` to read the server's identity, capabilities, and instructions, and change notifications are delivered through `subscriptions/listen` when the transport can push. It works over both stdio and Streamable HTTP, and it can share a `protocols` list with the session-based revisions, so one server can serve old and new clients; a server accepts at most one stateless revision. Adapters now describe their transport rules through a `runtime` descriptor (`McpProtocol.StatefulRuntimeDescriptor` / `StatelessRuntimeDescriptor`) instead of the former `transport` field, which matters only if you wrote your own adapter.

```ts
import { McpProtocol, McpServer } from "effect/unstable/ai"

// Session-based clients negotiate 2025-11-25; stateless clients use 2026-07-28.
const StdioMcp = McpServer.layerStdio({
  name: "Comp Server",
  version: "1.0.0",
  protocols: [McpProtocol.v2025_11_25, McpProtocol.v2026_07_28]
})
```

The 2025-06-18 adapter rejects JSON-RPC batches on its transport. The `MCP-Protocol-Version` header is validated only on requests **after** initialization: an `initialize` request negotiates from the version offered in its body and reports the selected version in the response, so a fresh client whose default header is not registered is no longer rejected with `400` before negotiation can happen. List every adapter you intentionally support; initialization selects the requested version and the server uses the first adapter as its fallback/default.

Streamable HTTP is strict at the boundary. If a request carries `Origin`, `layerHttp` returns 403 unless that exact origin appears in `allowedOrigins`. POST requires `Content-Type: application/json` (otherwise 415) and an `Accept` header that includes both `application/json` and `text/event-stream` with positive quality (otherwise 406).

**Reach for it when** constructing an MCP transport or deciding which protocol revisions a server is willing to negotiate.

## McpServer

`effect/unstable/ai/McpServer` — unstable

A batteries-included framework for building MCP servers — the protocol that lets editors and AI clients (Claude Desktop, IDEs) discover tools, resources, and prompts. Handles JSON-RPC plumbing; capabilities are registered as Layers and a transport is chosen.

`McpServer.toolkit(toolkit)` exposes a `Toolkit` as MCP tools; `McpServer.resource\`uri/${param}\`({...})` exposes resources/templates (with auto-completion); `McpServer.prompt({...})` exposes parameterized prompts, with an optional human-readable `title` beside the `name` (from `rc.116`, also on `registerPrompt`). Transports: `layerStdio` (desktop clients), `layerHttp` (mount on an `HttpRouter`). Every server constructor (`layer`, `layerStdio`, `layerHttp`, `run`) accepts an optional `instructions` string, returned in the initialization and discovery responses to tell a client how to use the server. Launch with `Layer.launch` + `NodeRuntime.runMain`.

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
  title: "Raise rationale",
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
    instructions: "Read employee cards before drafting; never propose an out-of-band raise.",
    protocols: [McpProtocol.v2025_06_18]
  })),
  Layer.provide(NodeStdio.layer),
  Layer.provide(Layer.succeed(Logger.LogToStderr)(true))
)

Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
```

> **Tip:** Define a `Toolkit` once — say your `CompToolkit` with `LookupCompBand` — and you can both call it from a `LanguageModel` *and* expose it to external clients via `McpServer.toolkit(CompToolkit)`. Same handlers, two surfaces.

**What an MCP client sees from a toolkit tool.**

| Handler outcome | Wire result | Logged and reported to `ErrorReporter` |
| --- | --- | --- |
| Success | `isError: false`; the encoded result as JSON text, plus `structuredContent` **only when it is a JSON object** (never `null` or an array, which MCP forbids there) | no |
| Arguments fail the parameter schema (a `Tool.Strict` tool also rejects undeclared properties) | Protocols `2024-11-05`, `2025-03-26`, `2025-06-18`: a JSON-RPC `InvalidParams` error. Protocols `2025-11-25` and `2026-07-28`: an `isError: true` result carrying the validation message, so the calling model can correct itself | no |
| Declared `failure`, `failureMode: "error"`, value is an `Error` instance | `isError: true` with that error's `message` — give the error class a meaningful `message`, because a bare tagged error has an empty one | no |
| Declared `failure`, `failureMode: "error"`, any other value | `isError: true` with the failure encoded through its schema as JSON text | no |
| Declared `failure`, `failureMode: "return"` | `isError: true` with the encoded failure payload as JSON text | no |
| An undeclared failure or `AiError`, a defect, or a result that fails its `success` schema or cannot be serialized | `isError: true` with a fixed internal-error message — details never reach the client | yes |

A failed call never carries `structuredContent`. Declared failures are part of the tool's contract, so from `rc.116` the server sends them to the client and does not log or report them; everything else is logged at error level and handed to the configured `ErrorReporter`s, so provide one when you need alerting on tool faults (see [Observability](../operations/observability)). Both failure modes now produce `isError: true`: choose `"error"` when the client should read a short message, and `"return"` when it should receive the structured failure payload. Either way the declared failure is visible to the client, so keep secrets and internal detail out of it.

Tool input schemas follow `Tool.Strict`: a strict tool advertises `additionalProperties: false` and the server rejects extra arguments, while a non-strict tool advertises `additionalProperties: true` and ignores them. A top-level `$ref` in a parameter schema is inlined, because MCP requires an object at the root.

- **Server identity can carry icons.** `layer`, `layerStdio`, `layerHttp`, and `run` accept `icons: ReadonlyArray<McpSchema.Icon>` (`src`, optional `mimeType`, `sizes`, `theme`). The `McpSchema.Resource`, `ResourceTemplate`, `Prompt`, and `Tool` schemas have the same optional field for entries registered through the lower-level `McpServer` registry service.
- **Prompt and resource callbacks receive decoded values.** `McpServer.prompt` / `registerPrompt` pass `content` the *decoded* type of each `parameters` schema, and resource templates resolve over both stdio and Streamable HTTP.

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

## Production rules for model calls

The modules above make a model call typed; they do not make it safe. These rules are the short form of [Building a Production AI Capability](../deep-dives/building-a-production-ai-capability), which works through each with code.

| Concern | Rule | Mechanism on this page |
| --- | --- | --- |
| Trust | **Treat user text, retrieved text, prior model output, tool arguments, and tool results as untrusted**; take actor, tenant, approval, idempotency key, and policy version only from trusted request context, never from model output. | Handler closes over trusted services; Schemas validate shape, not authority. |
| Tool execution | **Bound tool concurrency and keep mutations behind your own gate.** | `concurrency`, `disableToolCallResolution`, `toolkit.handle`, `setNeedsApproval`. |
| Loops | **Every agent loop has a turn limit and a typed exhaustion error.** | Bounded `for` loop around `Chat.generateText`. |
| Budgets | **Every limit is finite and checked before dispatch**: estimate prompt tokens and reserve worst-case output before the call; treat returned `usage` as reconciliation. | `Tokenizer`, `response.usage`, `Effect.timeout`. |
| Retries | **Classify by `reason`, bound the schedule, and stop once output or a side effect exists.** | `error.isRetryable`, `error.retryAfter`, `Schedule.upTo`. |
| Structured output | **The local `Schema` decode is authoritative** even when the provider advertises strict JSON; never fall back to parsing prose. | `generateObject`, `StructuredOutputError`. |
| Dynamic and MCP tools | **Allow-list tool names, snapshot and validate their schemas locally, and re-review when a server changes them.** | `Tool.dynamic`, `Tool.getJsonSchema`. |
| Media input | **Validate MIME type, size, count, and URI scheme before a file part leaves the process**; never let a prompt trigger an implicit URL fetch. | `Prompt` file parts. |
| Telemetry | **Record model, provider, latency, finish reason, usage, and tool names; keep prompts, keys, and reasoning text out of spans and logs.** | `Telemetry`, `Model.ProviderName` / `ModelName`, `Config.Redacted`. |

**Testing checklist.** Provide a scripted `LanguageModel` built with `LanguageModel.make` (it can record prompts and replay tool calls, failures, or a stream that never ends) and assert: a bounded multi-turn run succeeds; an unauthorized or unapproved call reaches **zero** handlers; a repeated call id produces one side effect; each budget fails at its exact edge; malformed tool arguments and unknown tool names fail closed; an interrupted stream leaves a recorded incomplete turn and runs its finalizers. Fakes prove policy, recorded HTTP fixtures prove adapter parsing, and a small separately authorized live suite proves only that the remote API still behaves as recorded.

## Provider packages

Primitives live in `effect/unstable/ai`; concrete providers ship as satellite packages. Each exposes a `Client.layerConfig(...)` that reads a `Config.Redacted` API key (requires an `HttpClient`) and one or more `.model(name)` constructors (each a `Model` Layer). Every language-model provider produces the same `LanguageModel` service, and every decision provider the same `DecisionModel` service; switching providers is a one-line Layer change.

- **pkg @effect/ai-openai** — OpenAI Responses API. `OpenAiClient.layerConfig`, `OpenAiLanguageModel.model("gpt-5.2")`, `OpenAiEmbeddingModel.model(name, { dimensions })`, provider-defined tools via `OpenAiTool` (e.g. `OpenAiTool.WebSearch`), and `OpenAiTelemetry`. A web search `search` action's `sources` can be URL sources (`{ type: "url", url }`) or, from `rc.116`, API sources (`{ type: "api", name }`, such as `oai-weather`), so narrow each source on `type` before reading `url` or `name`; code that read `source.url` directly no longer type-checks. Prompt caching can be steered explicitly: set `options: { openai: { promptCacheBreakpoint: { mode: "explicit" } } }` on a system message or a text part to mark the end of a reusable prefix (the provider documents this for GPT-5.6 or later and may reject it on earlier models).

- **pkg @effect/ai-anthropic** — Anthropic Messages API. `AnthropicClient.layerConfig`, `AnthropicLanguageModel.model("claude-opus-4-6")`, `AnthropicTool`, and `AnthropicTelemetry`. Structured output bridged automatically through `AnthropicStructuredOutput`.

- **pkg @effect/ai-openrouter** — OpenRouter's unified gateway to many models. `OpenRouterClient.layerConfig` (supports `siteReferrer`/`siteTitle` for attribution) and `OpenRouterLanguageModel.model(name)` — one key, hundreds of models. From `rc.116` it also offers `OpenRouterDecisionModel.model(name)`, a [`DecisionModel`](#decisionmodel) over OpenRouter's alpha Decisions API; it requires full label and level distributions, and accepts only a string, object, or array as the encoded input (other JSON values fail with `InvalidUserInputError`). The `OpenRouterClient.Service` interface gained `createDecisions`, so a hand-written client or test mock must now implement it.

- **pkg @effect/ai-typesafe** — New in `rc.116`: a `DecisionModel`-only provider for TypeSafe's System One API; it has no `LanguageModel`. `TypeSafeClient.layerConfig()` reads `TYPESAFE_API_KEY` by default (pass `apiKey` / `apiUrl` Configs to override), and `TypeSafeDecisionModel.model("jev-latest")` provides the service; versioned identifiers such as `"jev-1.13.0"` also work. The client does not retry, and a rate-limit error carries the provider's retry delay when one is sent, so apply the [retry rules](#classifying-a-failure-before-retrying) yourself.

- **pkg @effect/ai-openai-compat** — Any OpenAI-compatible endpoint (local LLMs, Together, Groq, vLLM…). Same `OpenAiClient`/`OpenAiLanguageModel`/`OpenAiEmbeddingModel` API — point `apiUrl` at your server.

```ts
// Swapping providers is a one-line change at the edge — comp logic is untouched.
import { Config, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter"
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"

const AnthropicLive = AnthropicLanguageModel.model("claude-opus-4-6").pipe(
  Layer.provide(
    AnthropicClient.layerConfig({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") })
      .pipe(Layer.provide(FetchHttpClient.layer))
  )
)

const OpenRouterLive = OpenRouterLanguageModel.model("openai/gpt-5.2").pipe(
  Layer.provide(
    OpenRouterClient.layerConfig({
      apiKey: Config.Redacted("OPENROUTER_API_KEY"),
      siteTitle: Config.succeed("Comp Planner")
    }).pipe(Layer.provide(FetchHttpClient.layer))
  )
)

// A DecisionModel provider is wired the same way; it reads TYPESAFE_API_KEY.
const TypeSafeDecisionsLive = TypeSafeDecisionModel.model("jev-latest").pipe(
  Layer.provide(TypeSafeClient.layerConfig().pipe(Layer.provide(FetchHttpClient.layer)))
)
```

> **Note:** Configure a provider client from `Config` → write comp logic against `LanguageModel` → call `generateText` for a review summary, `generateObject` with a `Schema` for a validated `RaiseRecommendation`, and pass a `Toolkit` (e.g. `LookupCompBand`) for tool calls → provide a concrete `.model(...)` Layer at the edge. Same four moves whether you're on OpenAI, Anthropic, OpenRouter, or a local model.
