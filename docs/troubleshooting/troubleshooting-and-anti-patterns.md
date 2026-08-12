# Troubleshooting & Anti-Patterns

Debug Effect code in this order: read `Effect<A, E, R>`, inspect the complete `Cause` or `Exit`, check ownership and termination, and only then change the implementation. Most “Effect bugs” are mismatches between the intended success, failure, requirement, or lifetime and the type that was actually built.

## Fast symptom map

| Symptom | Likely cause | First correction |
| --- | --- | --- |
| Nothing happened | An Effect was constructed but never executed, or a branch was never composed into the returned Effect. | Return/yield the Effect; run only the fully provided top-level program. |
| A service remains in `R` | Its Layer was not provided, or it was hidden under the wrong Layer composition. | Trace the missing service tag and provide its live/test Layer at the composition root. |
| `catch` does not handle a crash | The failure is a defect or interruption, not a typed `E`. | Inspect `Cause`; fix defects rather than silently widening recovery. |
| “Scope closed” or a handle stops working | A scoped value escaped its owning scope. | Move its use inside `Effect.scoped`, or expose it through a scoped Layer/ManagedRuntime. |
| Process never exits | A live server/stream/fiber is intentionally running, or a child is waiting on Queue/Deferred/Latch. | Decide the termination protocol; bound, end, interrupt, or supervise it. |
| TestClock test hangs | The sleeping Effect was joined before virtual time advanced. | Fork work, adjust the TestClock, then join. |
| Retry never happens | The error was converted to a defect, caught earlier, or rejected by the Schedule. | Keep retryable failures typed until after a bounded, filtered retry. |
| Schema types seem reversed | Application `Type` and external `Encoded` were used at the wrong boundary. | Decode inbound `Encoded` to `Type`; encode `Type` before storage/wire output. |
| Missing `FileSystem`, `HttpClient`, `Path`, or server service | A capability was imported without a platform implementation Layer. | Provide the Node/Bun/Deno/browser/fetch implementation at the outer edge. |
| Structurally incompatible unstable types | `effect` and `@effect/*` packages are from different releases. | Pin every Effect package to the exact same version and inspect the installed graph. |

## “My Effect never ran”

An Effect is a lazy description. Calling a function that returns an Effect, placing an Effect inside `Effect.sync`, or constructing one inside an unreturned callback does not execute it.

**Contextual fragment — wrong and corrected composition.**

```ts
// Wrong: the callback constructs an Effect and discards it.
const wrong = Effect.sync(() => saveEmployee(employee))

// Correct: compose the returned Effect.
const correct = Effect.flatMap(validateEmployee(employee), saveEmployee)

// Also correct inside Effect.gen: yield the operation.
const correctGen = Effect.gen(function*() {
  const valid = yield* validateEmployee(employee)
  return yield* saveEmployee(valid)
})
```

Run with `Effect.runPromise`, `runSync`, or a platform `runMain` only at the application boundary and only after `R` is fully supplied. Calling a runner inside a service breaks structured concurrency, dependency propagation, interruption, and testing.

If a branch appears skipped, inspect the returned structure: `Effect.when`/`unless` conditionally run work, `Option`/`Result` combinators can select another branch, and `Effect.as` changes only the success value—it does not execute a discarded Effect hidden in a callback.

## A service is still present in R

`R` is a set of unsatisfied service tags. Read a diagnostic such as `Effect<User, DbError, Users | SqlClient>` literally: the program still needs both services.

**Contextual fragment — provide dependencies at the edge.**

```ts
const UsersLive = Layer.effect(Users, makeUsers).pipe(
  Layer.provide(SqlLive) // SqlLive is used to build Users and is not re-exposed.
)

const main = program.pipe(
  Effect.provide(UsersLive)
)
```

Use `Layer.provide(dependency)` when the dependency exists only to construct that Layer. Use `Layer.provideMerge(dependency)` when the dependency must also remain in the output for other consumers. `Layer.merge` combines sibling outputs; it does not automatically feed one sibling into another.

Reuse the same named Layer value when several branches must share one pool or scoped resource. Layer memoization is based on object identity inside one build graph; reconstructing equivalent expressions can acquire separate instances.

Do not silence a missing service with a cast. Find the tag in `R`, locate its implementation Layer, and decide whether it belongs under one component or at the application root.

## Typed failure versus defect and interruption

`Effect.fail(error)` contributes to `E`. `Effect.die(defect)`, thrown exceptions not captured by an Effect constructor, and impossible-state bugs are defects. Interruption records that a fiber was cancelled. All are represented in `Cause`, but ordinary typed recovery sees only failures.

**Contextual fragment — preserve the intended channel.**

```ts
const request = Effect.tryPromise({
  try: () => fetch(url),
  catch: (cause) => new NetworkError({ cause })
})

const recovered = request.pipe(
  Effect.catchTag("NetworkError", () => cachedResponse)
)

// Use at a deliberate boundary only: this removes NetworkError from E by
// turning it into a defect. Effect.catchTag can no longer recover it afterward.
const unrecoverable = request.pipe(Effect.orDie)
```

Use `Effect.exit` when success/failure should become data and `Effect.catchCause` when cleanup, reporting, or a true boundary must examine the complete cause. Do not catch every Cause and pretend interruption or defects are ordinary domain failures; doing so can prevent shutdown and hide bugs.

## Scope closed or resource leaked

A value acquired with `Effect.acquireRelease`, `Pool.get`, `ScopedCache.get`, `PubSub.subscribe`, server Layers, or platform handles belongs to a Scope. The finalizer runs when that scope closes, regardless of success, typed failure, defect, or interruption.

**Contextual fragment — keep acquisition and use under one scope.**

```ts
const query = Effect.scoped(
  Effect.gen(function*() {
    const connection = yield* Pool.get(pool)
    return yield* connection.execute("select 1")
  })
)
```

Returning `connection` from `Effect.scoped` is a bug: its borrow has already ended. Return plain data, move the caller into the same scope, or expose the owned resource through a scoped Layer whose consumers run while that Layer is alive.

For a whole Effect application, use `Layer.launch` and a platform `runMain`. For repeated calls from a non-Effect host, use one `ManagedRuntime` and always call `dispose()` (or use `await using`). Do not allocate a new ManagedRuntime, pool, client Layer, or Scope per request unless isolation is intentional.

## Fiber, Queue, Deferred, Latch, and TestClock hangs

A hang usually means the program has no event capable of satisfying its wait:

- `Fiber.join` waits for that fiber’s completion. Joining a server, `Effect.never`, or an unbounded stream is intentionally permanent.
- `Queue.take` waits for an element; a bounded `Queue.offer` waits for capacity. Supply a producer/consumer and call `Queue.end` or `Queue.fail` when the protocol finishes.
- `Deferred.await` needs one completion path on every outcome. If completion follows a fallible operation, use `Effect.exit`/`Deferred.complete` or an ensuring/finalizer strategy.
- `Latch.await` waits until open. Decide which supervised fiber owns `Latch.open` and what happens on its failure.
- A bare `SubscriptionRef.changes`, PubSub stream, or Queue stream is live. Tests and finite consumers should use `Stream.take`, timeout, or an explicit end signal.

**Contextual fragment — virtual time must be driven from another fiber.**

```ts
const fiber = yield* Effect.sleep("10 seconds").pipe(
  Effect.as("ready"),
  Effect.forkChild
)

yield* TestClock.adjust("10 seconds")
const result = yield* Fiber.join(fiber)
```

The deadlocking order is “join, then adjust”: execution can never reach the adjustment. `@effect/vitest` supplies TestClock to `it.effect`; use `it.live` only when real time is genuinely under test.

Prefer `forkChild`, `forkScoped`, `FiberSet`, `FiberMap`, or another owner-aware supervisor. `forkDetach` deliberately escapes the parent and should be rare; detached work can keep resources or business work alive beyond the request that created it.

## Retrying the wrong error channel

`Effect.retry` reacts to typed failure, not defects, and reruns the entire wrapped Effect. Place it around the smallest idempotent operation, before `orDie`, and filter by retryability.

**Contextual fragment — bounded and classified retry.**

```ts
const retryTransient = Schedule.exponential("200 millis").pipe(
  Schedule.setInputType<HttpError>(),
  Schedule.while(({ input }) => input.retryable),
  Schedule.upTo({ times: 5 })
)

const response = callProvider.pipe(
  Effect.retry(retryTransient),
  Effect.catchTag("HttpError", reportPermanentFailure)
)
```

Do not retry validation errors, authentication/authorization failures, schema defects, or permanent 4xx responses. Respect provider backoff and `Retry-After`, add jitter for many clients, and cap attempts or elapsed duration.

Retried external writes are not automatically exactly once. Use an idempotency key, database uniqueness/transaction, or outbox. Workflow Activities are also delivered at least once until their completed Exit is durably recorded.

## Schema Type and Encoded mismatch

For a Schema `S`, `S["Encoded"]` is the boundary representation and `S["Type"]` is the domain value after decoding. A transformation makes the distinction visible—`Schema.NumberFromString` is encoded as a string and decoded as a number.

**Contextual fragment — decode inbound, encode outbound.**

```ts
const EmployeeId = Schema.NumberFromString

const id: Effect.Effect<number, Schema.SchemaError> =
  Schema.decodeUnknownEffect(EmployeeId)("42")

const encoded: Effect.Effect<string, Schema.SchemaError> =
  Schema.encodeEffect(EmployeeId)(42)
```

HttpApi decodes request params/query/payload before the handler and encodes handler successes/errors for the response. `SqlSchema` encodes its request before `execute` and decodes unknown driver rows afterward. Do not decode a value again merely because it crossed an internal function boundary.

Use `Schema.Unknown` only when the domain genuinely accepts arbitrary data. For numbers from untrusted input, choose the real domain: `Schema.Finite`, `Schema.Int`, `Schema.Natural`, or checks such as `Schema.isBetween`. `Schema.Number` accepts JavaScript `NaN` and infinities; it is not a default “safe JSON number” validator.

## Missing platform Layer

Effect separates capabilities from host implementations. Importing `FileSystem`, `Path`, `HttpClient`, or server interfaces gives types and operations, not a Node/Bun/Deno/browser implementation.

Typical outer-edge choices include:

| Requirement | Example implementation Layer |
| --- | --- |
| outbound `HttpClient` | `FetchHttpClient.layer`, `NodeHttpClient.layerUndici` / `layerNodeHttp`, or the host equivalent |
| `FileSystem` | `NodeFileSystem.layer`, Bun/Deno equivalent, or `FileSystem.layerNoop` in a narrow test |
| `Path` | `Path.layer` |
| Node HTTP server | `NodeHttpServer.layer(createServer, options)` |
| terminal/worker/platform services | the corresponding `@effect/platform-*` Layer |

Keep platform imports at composition roots. Domain services should depend on the capability interface, so tests can provide deterministic Layers without importing Node globals.

## Incompatible unstable package versions

All `effect` and `@effect/*` packages in this handbook target `4.0.0-rc.108`. Unstable packages share internal symbols, Schema types, Context tags, and peer dependencies; mixing release lines can produce huge structural errors or values that look identical but are not compatible.

Inspect the installed graph rather than only `package.json`:

**Runnable diagnostic command.**

```sh
pnpm list --depth Infinity --json
```

Pin exact versions—no caret or tilde—for `effect` and every `@effect/*` runtime package, update them together, and install with the committed lockfile. Tool-only packages can have separately documented version lines, but their Effect peer must still resolve coherently.

## Generated-code anti-pattern index

| Anti-pattern | Why it is wrong | Preferred shape |
| --- | --- | --- |
| `async`/`await` throughout Effect services | Native Promise work escapes typed errors, services, cancellation, and test services. | Compose Effects; wrap a real Promise boundary once with `Effect.tryPromise` or `Effect.promise` when it cannot fail. |
| `Effect.runPromise` inside a service method | Starts a nested runtime, erases `R`, weakens structured concurrency, and turns typed failure into Promise rejection. | Return `Effect<A, E, R>`; run at the outermost host boundary. |
| `Date.now()`, `new Date()`, `Math.random()` in domain work | Bypasses Clock/Random services and deterministic tests; direct workflow use also breaks replay determinism. | Use Effect Clock/DateTime/Random APIs; use TestClock and seeded/test services. Put nondeterminism in a Workflow Activity. |
| `{ concurrency: "unbounded" }` over uncontrolled input | Can exhaust sockets, memory, API quotas, or database connections. | Use a numeric bound, shared Semaphore, bounded Queue/Stream stage, or Pool. |
| Manual acquire/use without a finalizer | Failure or interruption leaks the handle. | `Effect.acquireRelease`, `acquireUseRelease`, a scoped Layer, Pool, ScopedCache, or another owner-aware primitive. |
| `Stream.runCollect` on unknown or infinite input | Materializes the full stream and may never return or exhaust memory. | Incremental `runForEach`, a bounded Sink, batching, or streaming output. |
| Retrying every failure forever | Retries permanent failures and amplifies outages. | Typed retryable errors, `Schedule.while`, jitter, and hard time/attempt bounds. |
| Assuming exactly-once delivery | A crash can occur after an external commit and before acknowledgement/journaling. | Idempotency keys, uniqueness constraints, transactions/outbox, and at-least-once-safe handlers. |
| `Schema.Number` for every external number | Accepts `NaN` and infinities and says nothing about integer/range constraints. | `Schema.Finite`, `Schema.Int`, `Schema.Natural`, BigDecimal/BigInt codecs, and explicit checks. |
| `Effect.catch(() => fallback)` everywhere | Erases domain distinctions and often hides operational failures. | Recover by tag/reason at the layer that owns the policy; preserve unexpected failures. |
| Rebuilding Layers inline at multiple branches | Different Layer identities may acquire duplicate pools/resources. | Name and reuse one Layer value inside the composition graph. |
| Using `declare const` in a supposedly runnable example | It type-checks only because the actual dependency is missing. | Label it contextual, or supply a complete fixture/runnable program. |

## What to capture in a bug report

Record the exact package versions and lockfile, the inferred `Effect<A, E, R>`, the complete pretty-printed Cause/Exit, whether the program was interrupted, the owning Scope, and a minimal reproducer using the same platform Layer. For time/concurrency bugs, record the queue capacity/strategy, concurrency bound, fiber ownership, schedule, and whether TestClock or the live clock was installed.

Then consult [Core Runtime & Execution](../foundations/core-runtime-execution.md), [Services, Context & Layers](../foundations/services-context-layers.md), [Errors, Option & Result](../foundations/errors-option-result.md), [Concurrency & Coordination](../concurrency/concurrency-coordination.md), [Schema](../data/schema.md), and [Testing & Dev Tooling](../tooling/testing-dev-tooling.md) for the full API surface.
