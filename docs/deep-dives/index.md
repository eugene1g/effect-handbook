# Deep Dives

Long-form guides build a working mental model across related Effect APIs. They complement the concise, module-by-module handbook chapters and include larger examples, operational guidance, and design tradeoffs.

## Available guides

- [Reactivity — From Atoms to Mastery](reactivity-from-atoms-to-mastery) — follow `Reactivity`, `Atom`, `AtomRegistry`, `AsyncResult`, `AtomRef`, hydration, and React integration from the dependency graph through a complete Todos feature. It assumes the Effect/Layer basics and is designed for application developers building reactive clients or SSR UI.
- [Anatomy of a Real Effect Application](anatomy-of-a-real-effect-application) — compose domain schemas, errors, services, Layers, configuration, resources, observability, an entrypoint, shutdown, and tests into one application.
- [Schema — From External Input to Domain and Back](schema-from-external-input-to-domain-and-back) — follow encoded input through decoding, domain modeling, transformations, HTTP/RPC/SQL/persistence boundaries, evolution, and property tests.
- [Failure, Retry, Fallback, and Interruption](failure-retry-fallback-and-interruption) — connect `E`, `Cause`, retry classification, fallback, interruption, finalizers, and operational policy.
- [Structured Concurrency Through a Bounded Worker](structured-concurrency-through-a-bounded-worker) — build and test a Queue-based worker with backpressure, supervised fibers, resource safety, and graceful shutdown.
- [Testing an Effect Application](testing-an-effect-application) — validate services, Layers, typed failures, virtual time, resources, fibers, HTTP boundaries, and integration seams without global mocks.
- [Streaming Ingestion Without Accidental Buffering](streaming-ingestion-without-accidental-buffering) — preserve bounded memory and backpressure from input framing through decoding, batching, writes, recovery, and shutdown.
- [The Durability and Distribution Ladder](durability-and-distribution-ladder) — choose deliberately among Persistence, EventLog, Workflow, and Cluster as durability and distribution requirements increase.
- [Building a Production AI Capability](building-a-production-ai-capability) — compose provider-neutral models, Schema-backed outputs and tools, resilience, telemetry, testing, and MCP exposure.

For quick lookup rather than a connected walkthrough, use the concise [handbook](../), [primitive chooser](../reference/choosing-effect-primitives), and topic reference pages.

## How deep dives fit the handbook

The concise topics remain the module-by-module lookup surface. Deep dives connect several modules into one mental model, retain the operational gotchas needed by the larger example, and link back to the concise reference for exhaustive API inventory. Authoring instructions live in the repository README.
