const pageDescriptions = {
  "index.md": "How to use the Effect 4 Handbook, its version contract, conventions, and official companion resources.",
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
  "reference/choosing-effect-primitives.md": "Contrastive decision tables for selecting Effect primitives by errors, services, lifetime, backpressure, durability, and distribution.",
  "troubleshooting/troubleshooting-and-anti-patterns.md": "Searchable symptoms, causes, fixes, and common Effect code-generation anti-patterns.",
  "recipes/service-and-layers.md": "A runnable service with live and test Layers, explicit requirements, and lifecycle boundaries.",
  "recipes/schema-httpapi-sql-boundary.md": "A complete typed boundary from Schema through HttpApi to SQL persistence.",
  "recipes/resource-safe-bounded-worker.md": "A bounded Queue worker with structured concurrency, backpressure, and deterministic cleanup.",
  "recipes/retry-with-test-clock.md": "Typed retry policy tested deterministically with TestClock.",
  "recipes/production-observability.md": "Production logging, metrics, tracing, exporter Layers, and graceful flushing.",
  "recipes/graceful-entrypoint-and-shutdown.md": "A Node application entrypoint with scoped resources, signals, and graceful shutdown.",
  "recipes/managed-runtime-integration.md": "Safe integration of Effect services into imperative framework callbacks with ManagedRuntime.",
  "deep-dives/index.md": "Long-form Effect 4 guides that connect individual APIs into complete application patterns.",
  "deep-dives/reactivity-from-atoms-to-mastery.md": "A source-grounded journey from Atom fundamentals through invalidation, hydration, React, and a complete feature.",
  "deep-dives/testing-an-effect-application.md": "A testing strategy for typed failures, services, resources, time, concurrency, and integration boundaries.",
  "deep-dives/streaming-ingestion-without-accidental-buffering.md": "End-to-end streaming ingestion with bounded memory, backpressure, batching, resource safety, and failure handling.",
  "deep-dives/durability-and-distribution-ladder.md": "A decision-oriented progression from persistence through event history, workflows, and clustered entities.",
  "deep-dives/building-a-production-ai-capability.md": "A production AI architecture using provider-neutral models, schemas, tools, telemetry, retries, and explicit MCP boundaries.",
  "deep-dives/anatomy-of-a-real-effect-application.md": "A complete application composition from domain schemas and services through resources, observability, entrypoint, shutdown, and tests.",
  "deep-dives/schema-from-external-input-to-domain-and-back.md": "Schema boundaries from encoded input to domain types and back across HTTP, RPC, SQL, persistence, evolution, and tests.",
  "deep-dives/failure-retry-fallback-and-interruption.md": "A connected model of typed failure, defects, Cause, retry, fallback, interruption, and cleanup.",
  "deep-dives/structured-concurrency-through-a-bounded-worker.md": "A bounded worker architecture that composes Queue, fibers, Scope, backpressure, shutdown, and tests."
}

const pageRelated = Object.freeze({
  "deep-dives/index.md": ["reference/choosing-effect-primitives.md", "reference/cheat-sheet-index.md"],
  "deep-dives/reactivity-from-atoms-to-mastery.md": ["systems/reactivity-atom.md", "data/schema.md", "interfaces/http-api.md", "tooling/testing-dev-tooling.md"],
  "deep-dives/anatomy-of-a-real-effect-application.md": ["foundations/core-runtime-execution.md", "foundations/services-context-layers.md", "foundations/configuration-secrets.md", "operations/observability.md"],
  "deep-dives/schema-from-external-input-to-domain-and-back.md": ["data/schema.md", "interfaces/http-api.md", "interfaces/rpc.md", "interfaces/sql.md", "tooling/persistence.md"],
  "deep-dives/failure-retry-fallback-and-interruption.md": ["foundations/errors-option-result.md", "concurrency/scheduling-time.md", "foundations/core-runtime-execution.md", "systems/workflows-durable-execution.md"],
  "deep-dives/structured-concurrency-through-a-bounded-worker.md": ["concurrency/concurrency-coordination.md", "concurrency/streaming-channels.md", "tooling/testing-dev-tooling.md"],
  "deep-dives/testing-an-effect-application.md": ["tooling/testing-dev-tooling.md", "foundations/services-context-layers.md", "concurrency/scheduling-time.md"],
  "deep-dives/streaming-ingestion-without-accidental-buffering.md": ["concurrency/streaming-channels.md", "data/schema.md", "interfaces/platform-runtime-hosts.md"],
  "deep-dives/durability-and-distribution-ladder.md": ["tooling/persistence.md", "systems/event-log-event-sourcing.md", "systems/workflows-durable-execution.md", "systems/cluster-sharding.md"],
  "deep-dives/building-a-production-ai-capability.md": ["systems/ai-language-models.md", "data/schema.md", "operations/observability.md", "foundations/configuration-secrets.md"]
})

export const handbookRelease = Object.freeze({
  package: "effect",
  version: "4.0.0-rc.108",
  tag: "effect@4.0.0-rc.108",
  commit: "bef7bf38ae4b73d5511043f707aed083de5da7cc",
  publishedAt: "2026-08-12T14:03:51.718Z",
  auditedAt: "2026-08-12"
})

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
      }
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
      page("Troubleshooting & Anti-Patterns", "troubleshooting/troubleshooting-and-anti-patterns.md"),
      page("Recipe: A Service with Live and Test Layers", "recipes/service-and-layers.md"),
      page("Recipe: Schema to HttpApi to SQL", "recipes/schema-httpapi-sql-boundary.md"),
      page("Recipe: A Resource-Safe Bounded Worker", "recipes/resource-safe-bounded-worker.md"),
      page("Recipe: Typed Retry with TestClock", "recipes/retry-with-test-clock.md"),
      page("Recipe: Production Observability", "recipes/production-observability.md"),
      page("Recipe: A Graceful Node Entrypoint", "recipes/graceful-entrypoint-and-shutdown.md"),
      page("Recipe: ManagedRuntime at an Imperative Boundary", "recipes/managed-runtime-integration.md")
    ]
  },
  {
    text: "Tooling & Reference",
    items: [
      page("CLI Framework", "tooling/cli-framework.md"),
      page("Persistence", "tooling/persistence.md"),
      page("Testing & Dev Tooling", "tooling/testing-dev-tooling.md"),
      page("Cheat Sheet & Index", "reference/cheat-sheet-index.md")
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
      page("Anatomy of a Real Effect Application", "deep-dives/anatomy-of-a-real-effect-application.md"),
      page("Schema — From External Input to Domain and Back", "deep-dives/schema-from-external-input-to-domain-and-back.md"),
      page("Failure, Retry, Fallback, and Interruption", "deep-dives/failure-retry-fallback-and-interruption.md"),
      page("Structured Concurrency Through a Bounded Worker", "deep-dives/structured-concurrency-through-a-bounded-worker.md"),
      page("Testing an Effect Application", "deep-dives/testing-an-effect-application.md"),
      page("Streaming Ingestion Without Accidental Buffering", "deep-dives/streaming-ingestion-without-accidental-buffering.md"),
      page("The Durability and Distribution Ladder", "deep-dives/durability-and-distribution-ladder.md"),
      page("Building a Production AI Capability", "deep-dives/building-a-production-ai-capability.md")
    ]
  }
]

export const deepDivePages = deepDiveGroups.flatMap((group) => group.items)
export const siteGroups = [...handbookGroups, ...deepDiveGroups]
export const sitePages = siteGroups.flatMap((group) => group.items)

export const deepDiveAgentSummaries = Object.freeze({
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
    "foundations/core-runtime-execution.md",
    "foundations/services-context-layers.md",
    "foundations/configuration-secrets.md",
    "foundations/errors-option-result.md",
    "data/data-structures.md",
    "data/schema.md",
    "operations/caching-batching.md",
    "reference/choosing-effect-primitives.md",
    "troubleshooting/troubleshooting-and-anti-patterns.md",
    "recipes/service-and-layers.md",
    "recipes/retry-with-test-clock.md",
    "recipes/graceful-entrypoint-and-shutdown.md",
    "recipes/managed-runtime-integration.md",
    "tooling/testing-dev-tooling.md",
    "reference/cheat-sheet-index.md"
  ]),
  bundle("web", "Effect 4 Web & Service Boundaries", "effect-4-web.md", [
    "data/schema.md",
    "interfaces/http-client.md",
    "interfaces/http-server.md",
    "interfaces/http-api.md",
    "interfaces/rpc.md",
    "interfaces/platform-runtime-hosts.md",
    "systems/reactivity-atom.md",
    "recipes/schema-httpapi-sql-boundary.md"
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
