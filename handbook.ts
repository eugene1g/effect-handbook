const pageDescriptions = {
  "index.md": "How to use the Effect 4 Handbook, its version contract, conventions, and official companion resources.",
  "foundations/getting-started.md": "Installing the Effect 4 release line, TypeScript and ESM settings, a first program, import forms, and editor tooling.",
  "foundations/core-runtime-execution.md": "Effect creation, composition, execution, fibers, scopes, runtime behavior, and execution planning.",
  "foundations/services-context-layers.md": "Typed services, Context, References, Layer construction, memoization, and resource lifecycles.",
  "foundations/configuration-secrets.md": "Configuration providers, validation, secrets, redaction, and application configuration patterns.",
  "foundations/errors-option-result.md": "Typed errors, defects, Cause, Exit, Option, Result, recovery, retry, and failure modeling.",
  "concurrency/concurrency-coordination.md": "Structured concurrency and coordination with fibers, queues, deferred values, semaphores, latches, and pools.",
  "concurrency/software-transactional-memory.md": "Composable atomic state and coordination with STM, transactional references, queues, maps, sets, and locks.",
  "concurrency/state-mutable-references.md": "Mutable and synchronized state using Ref, SynchronizedRef, SubscriptionRef, PubSub, and related primitives.",
  "concurrency/streaming-channels.md": "Streams, sinks, channels, codecs, multipart parsing, and incremental data processing.",
  "concurrency/scheduling-time.md": "Schedules, retries, repetition, Duration, DateTime, Clock, Cron, and time-zone-aware execution.",
  "data/data-structures.md": "Effect's immutable collections, equality, hashing, ordering, numeric types, and data-oriented utilities.",
  "data/functional-toolkit.md": "Functional composition with Function, Match, Predicate, Equivalence, Order, Optic, Brand, and utilities.",
  "data/schema.md": "Schema modeling, validation, transformation, errors, representations, arbitrary generation, and persistence.",
  "operations/observability.md": "Logging, metrics, tracing, OpenTelemetry and OTLP export, inspection, and diagnostics.",
  "operations/caching-batching.md": "Caching, request batching, resolvers, resource-aware memoization, and deduplicated data loading.",
  "interfaces/http-client.md": "Typed HTTP clients, requests, responses, middleware, retries, cookies, tracing, and platform layers.",
  "interfaces/http-server.md": "HTTP servers, routers, incoming messages, multipart handling, static files, and host integrations.",
  "interfaces/http-api.md": "Contract-first HTTP APIs, endpoints, schemas, handlers, middleware, clients, OpenAPI, and security.",
  "interfaces/rpc.md": "Typed RPC requests, routers, clients, transports, serialization, streaming, and middleware.",
  "interfaces/sql.md": "SQL clients, schemas, resolvers, models, migrations, transactions, streams, and provider adapters.",
  "interfaces/platform-runtime-hosts.md": "Node, Bun, Deno, browser, Cloudflare, filesystem, path, terminal, worker, and runtime services.",
  "systems/reactivity-atom.md": "Effect's reactive Atom graph, registries, hydration, typed clients, and framework bindings.",
  "systems/ai-language-models.md": "Language models, tools, agents, chat, MCP, prompt handling, and provider integrations.",
  "systems/workflows-durable-execution.md": "Durable workflows, activities, retries, interruption, persistence, and operational recovery.",
  "systems/cluster-sharding.md": "Cluster membership, sharding, entities, runners, proxies, messaging, and distributed coordination.",
  "systems/event-log-event-sourcing.md": "Event logs, event sourcing, projections, encryption, identity, and session authorization.",
  "tooling/cli-framework.md": "Typed command-line applications, arguments, flags, prompts, completions, help, and error handling.",
  "tooling/persistence.md": "Persistence services, backing stores, serialization, primary keys, and durable application state.",
  "tooling/testing-dev-tooling.md": "Effect testing, Vitest integration, generators, doctests, language tooling, and repository tools.",
  "reference/cheat-sheet-index.md": "A task-oriented Effect 4 cheat sheet and linked index into the concise handbook.",
  "reference/agent-guide.md": "How a coding agent should read this handbook: which Markdown artifact to fetch for which task, the .md URL rule, catalog and example-inventory fields, citing sections, and a drop-in instructions block.",
  "reference/choosing-effect-primitives.md": "Contrastive decision tables for selecting Effect primitives by errors, services, lifetime, backpressure, durability, and distribution.",
  "troubleshooting/troubleshooting-and-anti-patterns.md": "Searchable symptoms, causes, fixes, and common Effect code-generation anti-patterns.",
  "reference/review-checklists.md": "Design-review and code-review checklists for Effect services, errors, lifetimes, concurrency, boundaries, persistence, observability, and tests.",
  "recipes/service-and-layers.md": "A runnable service with live and test Layers, explicit requirements, and lifecycle boundaries.",
  "recipes/schema-httpapi-sql-boundary.md": "A complete typed boundary from Schema through HttpApi to SQL persistence.",
  "recipes/resource-safe-bounded-worker.md": "A bounded Queue worker with structured concurrency, backpressure, and deterministic cleanup.",
  "recipes/retry-with-test-clock.md": "Typed retry policy tested deterministically with TestClock.",
  "recipes/production-observability.md": "Production logging, metrics, tracing, exporter Layers, and graceful flushing.",
  "recipes/graceful-entrypoint-and-shutdown.md": "A Node application entrypoint with scoped resources, signals, and graceful shutdown.",
  "recipes/managed-runtime-integration.md": "Safe integration of Effect services into imperative framework callbacks with ManagedRuntime.",
  "recipes/request-cancellation-through-a-host.md": "Forwarding a host's cancellation through ManagedRuntime and into a Promise adapter so abandoned requests stop their work.",
  "recipes/transactional-write-with-outbox.md": "An atomic SQL write with a transactional outbox, commit-before-deliver ordering, and honest at-least-once delivery.",
  "deep-dives/index.md": "Long-form Effect 4 guides that connect individual APIs into complete application patterns.",
  "deep-dives/reactivity-from-atoms-to-mastery.md": "A source-grounded journey from Atom fundamentals through invalidation, hydration, React, and a complete feature.",
  "deep-dives/testing-an-effect-application.md": "A testing strategy for typed failures, services, resources, time, concurrency, and integration boundaries.",
  "deep-dives/streaming-ingestion-without-accidental-buffering.md": "End-to-end streaming ingestion with bounded memory, backpressure, batching, resource safety, and failure handling.",
  "deep-dives/durability-and-distribution-ladder.md": "A decision-oriented progression from persistence through event history, workflows, and clustered entities.",
  "deep-dives/building-a-production-ai-capability.md": "A production AI architecture using provider-neutral models, schemas, tools, telemetry, retries, and explicit MCP boundaries.",
  "deep-dives/exposing-an-effect-application-over-mcp.md": "Serving an Effect application to AI clients over MCP: transports and protocol eras, catalog shaping, OAuth resource-server authorization, human-in-the-loop round trips, idempotency, and in-process tests.",
  "deep-dives/anatomy-of-a-real-effect-application.md": "A complete application composition from domain schemas and services through resources, observability, entrypoint, shutdown, and tests.",
  "deep-dives/schema-from-external-input-to-domain-and-back.md": "Schema boundaries from encoded input to domain types and back across HTTP, RPC, SQL, persistence, evolution, and tests.",
  "deep-dives/failure-retry-fallback-and-interruption.md": "A connected model of typed failure, defects, Cause, retry, fallback, interruption, and cleanup.",
  "deep-dives/structured-concurrency-through-a-bounded-worker.md": "A bounded worker architecture that composes Queue, fibers, Scope, backpressure, shutdown, and tests.",
  "deep-dives/adopting-effect-in-an-existing-codebase.md": "An incremental strategy for bringing Effect into a Promise-based TypeScript codebase: audit, characterize, migrate leaf-first, and keep one interop seam.",
  "deep-dives/owning-lifetimes-startup-readiness-and-shutdown.md": "Who owns each resource and fiber, startup as a transaction, readiness and draining, one shutdown path, and callback bridges across hosts."
}

const pageRelated = Object.freeze({
  "deep-dives/exposing-an-effect-application-over-mcp.md": ["systems/ai-language-models.md", "interfaces/http-server.md", "interfaces/rpc.md", "deep-dives/building-a-production-ai-capability.md"],
  "deep-dives/index.md": ["reference/choosing-effect-primitives.md", "reference/cheat-sheet-index.md"],
  "deep-dives/reactivity-from-atoms-to-mastery.md": ["systems/reactivity-atom.md", "data/schema.md", "interfaces/http-api.md", "tooling/testing-dev-tooling.md"],
  "deep-dives/anatomy-of-a-real-effect-application.md": ["foundations/core-runtime-execution.md", "foundations/services-context-layers.md", "foundations/configuration-secrets.md", "operations/observability.md"],
  "deep-dives/schema-from-external-input-to-domain-and-back.md": ["data/schema.md", "interfaces/http-api.md", "interfaces/rpc.md", "interfaces/sql.md", "tooling/persistence.md"],
  "deep-dives/failure-retry-fallback-and-interruption.md": ["foundations/errors-option-result.md", "concurrency/scheduling-time.md", "foundations/core-runtime-execution.md", "systems/workflows-durable-execution.md"],
  "deep-dives/structured-concurrency-through-a-bounded-worker.md": ["concurrency/concurrency-coordination.md", "concurrency/streaming-channels.md", "tooling/testing-dev-tooling.md"],
  "deep-dives/testing-an-effect-application.md": ["tooling/testing-dev-tooling.md", "foundations/services-context-layers.md", "concurrency/scheduling-time.md"],
  "deep-dives/streaming-ingestion-without-accidental-buffering.md": ["concurrency/streaming-channels.md", "data/schema.md", "interfaces/platform-runtime-hosts.md"],
  "deep-dives/durability-and-distribution-ladder.md": ["tooling/persistence.md", "systems/event-log-event-sourcing.md", "systems/workflows-durable-execution.md", "systems/cluster-sharding.md"],
  "deep-dives/building-a-production-ai-capability.md": ["systems/ai-language-models.md", "data/schema.md", "operations/observability.md", "foundations/configuration-secrets.md"],
  "deep-dives/adopting-effect-in-an-existing-codebase.md": ["foundations/getting-started.md", "foundations/core-runtime-execution.md", "recipes/managed-runtime-integration.md", "tooling/testing-dev-tooling.md"],
  "deep-dives/owning-lifetimes-startup-readiness-and-shutdown.md": ["foundations/core-runtime-execution.md", "foundations/services-context-layers.md", "interfaces/platform-runtime-hosts.md", "recipes/graceful-entrypoint-and-shutdown.md", "recipes/request-cancellation-through-a-host.md"],
  "foundations/getting-started.md": ["foundations/core-runtime-execution.md", "tooling/testing-dev-tooling.md", "deep-dives/adopting-effect-in-an-existing-codebase.md"],
  "reference/review-checklists.md": ["reference/choosing-effect-primitives.md", "troubleshooting/troubleshooting-and-anti-patterns.md"],
  "reference/agent-guide.md": ["index.md", "reference/cheat-sheet-index.md", "reference/choosing-effect-primitives.md", "troubleshooting/troubleshooting-and-anti-patterns.md"],
  "reference/cheat-sheet-index.md": ["reference/agent-guide.md", "reference/choosing-effect-primitives.md"],
  "recipes/request-cancellation-through-a-host.md": ["recipes/managed-runtime-integration.md", "foundations/core-runtime-execution.md", "deep-dives/owning-lifetimes-startup-readiness-and-shutdown.md"],
  "recipes/transactional-write-with-outbox.md": ["interfaces/sql.md", "recipes/schema-httpapi-sql-boundary.md", "deep-dives/durability-and-distribution-ladder.md"]
})

export const handbookRelease = Object.freeze({
  package: "effect",
  version: "4.0.2",
  tag: "effect@4.0.2",
  commit: "269a7c864351231d42e6e95b7fa8f32050df3691",
  publishedAt: "2026-10-07T18:21:31.965Z",
  auditedAt: "2026-10-09"
})

function upstreamUrl(kind: "blob" | "tree", pathname: string): string {
  return `https://github.com/Effect-TS/effect/${kind}/${encodeURIComponent(handbookRelease.tag)}/${pathname}`
}

// The "Official Effect" navigation menu. It lives here rather than in the
// VitePress config so `pnpm docs:links` can check these URLs without
// installing the site's dependencies. Release-pinned links must name a path
// that exists at `handbookRelease.tag`; the official site's guides track `main`.
export const officialEffectLinks: ReadonlyArray<{ readonly text: string; readonly link: string }> = Object.freeze([
  // The upstream cookbook (formerly a `cookbooks/` folder on the pre-release
  // repository, absent from the tagged source) is published as the official
  // site's v4 Schedule cookbook.
  { text: "Schedule cookbook", link: "https://effect.website/docs/v4/scheduling/cookbook" },
  { text: "Schema guide", link: upstreamUrl("blob", "packages/effect/SCHEMA.md") },
  { text: "AI documentation source", link: upstreamUrl("tree", "ai-docs/src") },
  { text: "LLMS.md", link: upstreamUrl("blob", "LLMS.md") }
])

export const handbookGroups = [
  {
    text: "Start Here",
    items: [
      {
        text: "Orientation",
        title: "The Effect 4 Handbook — A Guided Tour of Effect v4",
        description: pageDescriptions["index.md"],
        source: "index.md",
        link: "/",
        related: pageRelated["index.md"] ?? []
      },
      page("Getting Started", "foundations/getting-started.md")
    ]
  },
  {
    text: "Runtime Fundamentals",
    items: [
      page("Core Runtime & Execution", "foundations/core-runtime-execution.md"),
      page("Services, Context & Layers", "foundations/services-context-layers.md"),
      page("Configuration & Secrets", "foundations/configuration-secrets.md"),
      page("Errors, Option & Result", "foundations/errors-option-result.md")
    ]
  },
  {
    text: "Concurrency & Streams",
    items: [
      page("Concurrency & Coordination", "concurrency/concurrency-coordination.md"),
      page("Software Transactional Memory", "concurrency/software-transactional-memory.md"),
      page("State & Mutable References", "concurrency/state-mutable-references.md"),
      page("Streaming & Channels", "concurrency/streaming-channels.md"),
      page("Scheduling & Time", "concurrency/scheduling-time.md")
    ]
  },
  {
    text: "Data & Schema",
    items: [
      page("Data Structures", "data/data-structures.md"),
      page("The Functional Toolkit", "data/functional-toolkit.md"),
      page("Schema", "data/schema.md")
    ]
  },
  {
    text: "Runtime Services",
    items: [
      page("Observability", "operations/observability.md"),
      page("Caching & Batching", "operations/caching-batching.md")
    ]
  },
  {
    text: "Web & Integrations",
    items: [
      page("HTTP Client", "interfaces/http-client.md"),
      page("HTTP Server", "interfaces/http-server.md"),
      page("HttpApi", "interfaces/http-api.md"),
      page("RPC", "interfaces/rpc.md"),
      page("SQL", "interfaces/sql.md"),
      page("Platform & Runtime Hosts", "interfaces/platform-runtime-hosts.md")
    ]
  },
  {
    text: "Application Systems",
    items: [
      page("Reactivity & Atom", "systems/reactivity-atom.md"),
      page("AI & Language Models", "systems/ai-language-models.md"),
      page("Workflows & Durable Execution", "systems/workflows-durable-execution.md"),
      page("Cluster & Sharding", "systems/cluster-sharding.md"),
      page("EventLog & Event Sourcing", "systems/event-log-event-sourcing.md")
    ]
  },
  {
    text: "Decisions & Recipes",
    items: [
      page("Choosing Effect Primitives", "reference/choosing-effect-primitives.md"),
      page("Review Checklists", "reference/review-checklists.md"),
      page("Troubleshooting & Anti-Patterns", "troubleshooting/troubleshooting-and-anti-patterns.md"),
      page("Recipe: A Service with Live and Test Layers", "recipes/service-and-layers.md"),
      page("Recipe: Schema to HttpApi to SQL", "recipes/schema-httpapi-sql-boundary.md"),
      page("Recipe: A Resource-Safe Bounded Worker", "recipes/resource-safe-bounded-worker.md"),
      page("Recipe: Typed Retry with TestClock", "recipes/retry-with-test-clock.md"),
      page("Recipe: Production Observability", "recipes/production-observability.md"),
      page("Recipe: A Graceful Node Entrypoint", "recipes/graceful-entrypoint-and-shutdown.md"),
      page("Recipe: ManagedRuntime at an Imperative Boundary", "recipes/managed-runtime-integration.md"),
      page("Recipe: Request Cancellation Through a Host", "recipes/request-cancellation-through-a-host.md"),
      page("Recipe: A Transactional Write with an Outbox", "recipes/transactional-write-with-outbox.md")
    ]
  },
  {
    text: "Tooling & Reference",
    items: [
      page("CLI Framework", "tooling/cli-framework.md"),
      page("Persistence", "tooling/persistence.md"),
      page("Testing & Dev Tooling", "tooling/testing-dev-tooling.md"),
      page("Cheat Sheet & Index", "reference/cheat-sheet-index.md"),
      page("Using the Handbook from an Agent", "reference/agent-guide.md")
    ]
  }
]

export const handbookPages = handbookGroups.flatMap((group) => group.items)

export const deepDiveGroups = [
  {
    text: "Deep Dives",
    items: [
      page("Deep Dives", "deep-dives/index.md"),
      page("Reactivity — From Atoms to Mastery", "deep-dives/reactivity-from-atoms-to-mastery.md"),
      page("Adopting Effect in an Existing TypeScript Codebase", "deep-dives/adopting-effect-in-an-existing-codebase.md"),
      page("Anatomy of a Real Effect Application", "deep-dives/anatomy-of-a-real-effect-application.md"),
      page("Owning Lifetimes — Startup, Readiness, and Shutdown", "deep-dives/owning-lifetimes-startup-readiness-and-shutdown.md"),
      page("Schema — From External Input to Domain and Back", "deep-dives/schema-from-external-input-to-domain-and-back.md"),
      page("Failure, Retry, Fallback, and Interruption", "deep-dives/failure-retry-fallback-and-interruption.md"),
      page("Structured Concurrency Through a Bounded Worker", "deep-dives/structured-concurrency-through-a-bounded-worker.md"),
      page("Testing an Effect Application", "deep-dives/testing-an-effect-application.md"),
      page("Streaming Ingestion Without Accidental Buffering", "deep-dives/streaming-ingestion-without-accidental-buffering.md"),
      page("The Durability and Distribution Ladder", "deep-dives/durability-and-distribution-ladder.md"),
      page("Building a Production AI Capability", "deep-dives/building-a-production-ai-capability.md"),
      page("Exposing an Effect Application over MCP", "deep-dives/exposing-an-effect-application-over-mcp.md")
    ]
  }
]

export const deepDivePages = deepDiveGroups.flatMap((group) => group.items)
export const siteGroups = [...handbookGroups, ...deepDiveGroups]
export const sitePages = siteGroups.flatMap((group) => group.items)

export const deepDiveAgentSummaries = Object.freeze({
  "deep-dives/exposing-an-effect-application-over-mcp.md": "Architecture: McpServer is an external boundary over an existing Toolkit, not the agent loop; one server declares its protocol eras and serves stateless and session clients alike; the catalog is shaped with annotations, Tool.Strict, and EnabledWhen; HttpRouter middleware makes the server an OAuth resource server that derives tenant and scopes from token claims; human approval uses elicit on session eras and an HMAC-sealed InputRequired round trip on the stateless era; retried calls are idempotent; the server is tested in-process through HttpRouter.toWebHandler.",
  "deep-dives/adopting-effect-in-an-existing-codebase.md": "Architecture: audit each function for hidden failure, dependency, lifetime, and cancellation behavior; pin current behavior with characterization tests; migrate leaf-first behind an unchanged external contract; keep exactly one seam where Promise meets Effect; make adapters cancellable before adding retry or timeout policy; take early test wins with provideService.",
  "deep-dives/owning-lifetimes-startup-readiness-and-shutdown.md": "Architecture: every resource and fiber has one named owner scope; startup is a transaction that either completes or releases what it acquired; readiness and draining are explicit states separate from liveness; one shutdown operation closes intake, drains, then releases in reverse order; callback bridges into host frameworks carry cancellation and never outlive their owner.",
  "deep-dives/reactivity-from-atoms-to-mastery.md": "Architecture: AtomRegistry owns the reactive graph and lifecycle; Atom.runtime supplies Effect services; Reactivity keys drive targeted invalidation; Hydration crosses the SSR boundary; framework bindings consume AsyncResult without hiding typed failures.",
  "deep-dives/anatomy-of-a-real-effect-application.md": "Architecture: schemas and tagged errors define domain boundaries; Context services separate policy from infrastructure; live and test Layers compose Config, SQL/HTTP resources, and observability; one scoped entrypoint owns startup, interruption, finalizers, and shutdown.",
  "deep-dives/schema-from-external-input-to-domain-and-back.md": "Architecture: decode unknown encoded input once at each boundary, operate on validated Type values internally, and encode deliberately for HTTP, RPC, SQL, or persistence; transformations, classes, versioned representations, and property tests preserve the contract.",
  "deep-dives/failure-retry-fallback-and-interruption.md": "Architecture: model expected failures in E, retain defects and interruption in Cause, classify before retrying, constrain Schedule policies, keep fallback semantics explicit, and acquire resources in Scope so interruption cannot skip cleanup.",
  "deep-dives/structured-concurrency-through-a-bounded-worker.md": "Architecture: a bounded Queue owns backpressure, scoped child fibers own worker lifetime, concurrency is explicit, shutdown closes intake and joins/interrupts workers, and tests assert capacity, cleanup, and interruption rather than timing by sleep.",
  "deep-dives/testing-an-effect-application.md": "Architecture: substitute services with test Layers, inspect typed errors and Exit values, virtualize time, verify resource finalizers and fiber behavior, and reserve live integration Layers for the boundary behavior a unit test cannot prove.",
  "deep-dives/streaming-ingestion-without-accidental-buffering.md": "Architecture: Stream pulls incrementally, transformations preserve backpressure, Sink/Channel handle consumption and protocol seams, bounded batching limits memory, and Scope owns sources and destinations; restart recovery requires explicit record identity, checkpoints, idempotent writes, or a durable job boundary.",
  "deep-dives/durability-and-distribution-ladder.md": "Architecture: choose the lowest rung that meets the guarantee—Persistence for current state/results, EventLog for replayable history, Workflow for restartable orchestration, and Cluster entities for distributed identity and ownership—while designing external effects for at-least-once delivery.",
  "deep-dives/building-a-production-ai-capability.md": "Architecture: provider-neutral LanguageModel services sit behind Layers; Schema constrains structured outputs and tools; Toolkit/Chat controls tool execution; retry and observability wrap provider calls; MCP is an explicit external protocol boundary with transport security and lifecycle requirements."
})

export const agentBundles = [
  bundle("core", "Effect 4 Core", "effect-4-core.md", [
    "index.md",
    "foundations/getting-started.md",
    "foundations/core-runtime-execution.md",
    "foundations/services-context-layers.md",
    "foundations/configuration-secrets.md",
    "foundations/errors-option-result.md",
    "data/data-structures.md",
    "data/functional-toolkit.md",
    "data/schema.md",
    "operations/caching-batching.md",
    "reference/choosing-effect-primitives.md",
    "reference/review-checklists.md",
    "troubleshooting/troubleshooting-and-anti-patterns.md",
    "recipes/service-and-layers.md",
    "recipes/retry-with-test-clock.md",
    "recipes/graceful-entrypoint-and-shutdown.md",
    "recipes/managed-runtime-integration.md",
    "recipes/request-cancellation-through-a-host.md",
    "tooling/testing-dev-tooling.md",
    "reference/cheat-sheet-index.md",
    "reference/agent-guide.md"
  ]),
  bundle("web", "Effect 4 Web & Service Boundaries", "effect-4-web.md", [
    "data/schema.md",
    "interfaces/http-client.md",
    "interfaces/http-server.md",
    "interfaces/http-api.md",
    "interfaces/rpc.md",
    "interfaces/platform-runtime-hosts.md",
    "systems/reactivity-atom.md",
    "recipes/schema-httpapi-sql-boundary.md",
    "recipes/request-cancellation-through-a-host.md"
  ]),
  bundle("concurrency", "Effect 4 Concurrency & Streaming", "effect-4-concurrency.md", [
    "foundations/core-runtime-execution.md",
    "concurrency/concurrency-coordination.md",
    "concurrency/software-transactional-memory.md",
    "concurrency/state-mutable-references.md",
    "concurrency/streaming-channels.md",
    "concurrency/scheduling-time.md",
    "recipes/resource-safe-bounded-worker.md",
    "recipes/retry-with-test-clock.md"
  ]),
  bundle("distributed", "Effect 4 Durable & Distributed Systems", "effect-4-distributed.md", [
    "tooling/persistence.md",
    "interfaces/sql.md",
    "systems/workflows-durable-execution.md",
    "systems/cluster-sharding.md",
    "systems/event-log-event-sourcing.md",
    "recipes/transactional-write-with-outbox.md",
    "reference/choosing-effect-primitives.md"
  ]),
  bundle("ai", "Effect 4 AI", "effect-4-ai.md", [
    "foundations/services-context-layers.md",
    "data/schema.md",
    "operations/observability.md",
    "systems/ai-language-models.md",
    "recipes/production-observability.md"
  ])
]

export { capabilities, capabilityDomains } from "./handbook-capabilities.ts"

export function slugifyHeading(input) {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "section"
}

function page(title, source) {
  const route = source === "index.md"
    ? "/"
    : source.endsWith("/index.md")
    ? `/${source.slice(0, -"index.md".length)}`
    : `/${source.replace(/\.md$/, "")}`
  return {
    text: title,
    title,
    description: pageDescriptions[source],
    source,
    link: route,
    related: pageRelated[source] ?? []
  }
}

function bundle(id, title, filename, sources) {
  return Object.freeze({ id, title, filename, sources: Object.freeze(sources) })
}
