# Tasks given to the evaluation agents

Every agent received `RULES.md` plus one task below. Each ran independently (Claude Sonnet), starting from the live `llms.txt`.

| Id | Task |
| --- | --- |
| t1-retry-http | GET an employee with the HTTP client, decode with Schema, retry only on 503 or a 2-second per-attempt timeout with exponential backoff from 200ms for at most 3 retries, typed `EmployeeNotFound` on 404; fake HttpClient returning 503 twice then success. |
| t2-bounded-worker | Bounded queue (capacity 100, producers wait), exactly 4 concurrent workers, graceful shutdown that finishes current jobs, accepts no new ones, and logs abandoned jobs. |
| t3-schema-decode | Raise request from untrusted JSON: branded `E-\d{4}` id, numeric-string positive amount, ISO date, optional `note` key; typed `InvalidRaiseRequest`; encode back. |
| t4-service-layers | `EmployeeRepository` and `RaiseService` with typed errors, live and test Layers, plus `@effect/vitest` tests. |
| t5-httpapi | Schema-first HttpApi `GET /employees/:id` with a typed 404, Node server on port 3000, and a derived typed client. |
| t6-cache | Per-level cache: 10-minute TTL, single-flight for concurrent requests, capacity 500, failures not cached. |
| t7-ndjson-stream | Stream a large NDJSON file from disk, decode lines with Schema, skip and count malformed lines, write in batches of 100 with bounded memory. |
| t8-express-cancel | Call Effect from an Express route with app-lifetime Layers, interrupt on client disconnect, abort the downstream fetch, map errors to status codes, shut down on SIGTERM. |
| t9-otlp | Spans, a counter, and trace-correlated logs exported over OTLP/HTTP to localhost:4318 as `comp-service`, flushed on shutdown. |
| t10-durability | Decision: which of Persistence, EventLog, Workflow/Activity, and Cluster entities a multi-day, restart-safe, auditable payroll approval needs, and what guarantee the payment call gets. |
