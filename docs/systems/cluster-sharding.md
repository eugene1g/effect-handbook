# Cluster & Sharding

Effect Cluster provides *entities*: stateful, addressable actors keyed by id, distributed across machines and reachable through typed RPC clients. A message to `dept-eng` is routed to the owning shard, the entity is spun up on demand, kept warm, and passivated when idle. Pair with durable message storage for at-least-once delivery that survives restarts.

> **Note:** The spine: **Entity** defines an addressable actor and its RPC protocol. **Sharding** routes every message. **Runner**/**Runners** host shards and talk to each other. **MessageStorage** makes delivery durable. **Singleton**, **Snowflake**, **EntityProxy**, **ClusterCron**, **ShardingConfig** hang off those four. Define entities, merge their layers, provide a cluster layer.

> **Official example:** Effect's release-matched [`ai-docs` cluster example](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/80_cluster) defines and runs a distributed entity.

> **Warning:** The entire cluster surface lives under `effect/unstable/cluster`. APIs may shift between minor versions. Pin your version and re-check signatures when you upgrade. Transport entrypoints (`NodeClusterSocket`, `NodeClusterHttp`) come from `@effect/platform-node`.

## Entity

`effect/unstable/cluster` — unstable

An `Entity` gives a stable *type name* and an *RPC protocol* to a family of values addressed by id. `Entity.make("Department", [RecordRaise, GetBudget])` declares a kind called Department, keyed by string id, with those RPCs. The cluster picks a shard for each id and routes requests to the owning runner.

**Mental model.** A sharded, stateful actor whose interface is an `RpcGroup`. Each live instance processes a mailbox sequentially (no locks needed), holds state in a plain `Ref`. Idle long enough and it is *passivated* — stopped, state dropped — then transparently recreated on the next message. Address an instance by id; the runtime materializes it.

Define the protocol with `Rpc.make`, register handlers with `entity.toLayer(...)`, get a typed client with `entity.client`. The handler builder is a normal `Effect.gen` that can allocate per-instance state and close over it.

```ts
import { BigDecimal, Effect, Ref, Schema } from "effect"
import { ClusterSchema, Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"

// 1. Define the protocol — two RPCs, each a plain Rpc.make. A department owns
//    its slice of the merit budget; you draw it down by recording raises.
const RecordRaise = Rpc.make("RecordRaise", {
  payload: { employeeId: Schema.String, amount: Schema.BigDecimal },
  success: Schema.BigDecimal // remaining budget after the raise
})
  // Annotate an RPC as Persisted so the message is durably stored before
  // delivery (at-least-once). A recorded raise must survive a node crash, so
  // without this it would be volatile and only sent over the network.
  .annotate(ClusterSchema.Persisted, true)

const GetBudget = Rpc.make("GetBudget", {
  success: Schema.BigDecimal
})

// 2. The entity is just a named bundle of RPCs.
const Department = Entity.make("Department", [RecordRaise, GetBudget])

// 3. Register handlers as a Layer. The builder runs once per live instance,
//    so the Ref is this department's private, in-memory merit budget.
const DepartmentLayer = Department.toLayer(
  Effect.gen(function*() {
    const budget = yield* Ref.make(BigDecimal.fromBigInt(250_000n))

    return Department.of({
      RecordRaise: ({ payload }) =>
        Ref.updateAndGet(budget, (b) => BigDecimal.subtract(b, payload.amount)),
      // Rpc.fork opts a single handler out of the default sequential
      // execution so budget reads can run concurrently with writes.
      GetBudget: () => Ref.get(budget).pipe(Rpc.fork)
    })
  }),
  // Passivation: if idle this long, stop the instance and recreate on demand.
  { maxIdleTime: "5 minutes" }
)
```

`entity.client` yields a function from id to a typed RPC client. Calling `departments("dept-eng")` gives the exact methods of the protocol — payloads and results checked against Schemas.

```ts
import { BigDecimal, Effect } from "effect"

const program = Effect.gen(function*() {
  const departmentFor = yield* Department.client
  const engineering = departmentFor("dept-eng")

  const remaining = yield* engineering.RecordRaise({
    employeeId: "emp-42",
    amount: BigDecimal.fromBigInt(8_000n)
  })
  yield* Effect.log(`engineering merit budget remaining: ${BigDecimal.format(remaining)}`)
})
```

> **Tip:** `toLayer` is the idiomatic path. For actor purists who want to own the message loop, `toLayerQueue` hands a `Queue.Dequeue` of request envelopes plus a `Replier` (`succeed`/`fail`/`failCause`/`complete`). Same delivery guarantees, lower-level control.

> **Note:** `toLayer` takes `maxIdleTime` (passivation), `concurrency` (defaults to sequential per instance), `mailboxCapacity`, and a `defectRetryPolicy`. Inside a handler read `Entity.CurrentAddress` (this entity's type/id/shard) and call `Entity.keepAlive(true)` to pin an instance alive while it holds a resource. For tests without transport, `Entity.makeTestClient(entity, layer)` builds an in-memory client.

**Reach for it when** you have per-key state that you want distributed across machines while keeping each key's logic single-threaded and addressable.

## Sharding

`effect/unstable/cluster` — unstable

The routing brain of the cluster; every entity client implicitly depends on it. `Sharding` decides which shard owns a given entity id, tracks shards belonging to the local runner, sends each message to a local handler or across the wire to the owning runner. Also registers entities and singletons, mints runner-local snowflake ids, and polls durable storage for persisted work.

**Mental model.** Entity ids are hashed into a fixed number of *shards* per group; shards are spread across healthy runners using a consistent hash ring weighted per runner. When you send to `dept-eng`, Sharding computes its `ShardId`, looks up the owning runner, and routes. When runners join or leave, shards are reassigned and entities migrate — client code never changes. You almost never call `Sharding` methods directly; provide its layer and let `Entity` and `Singleton` drive it.

```ts
import { Layer } from "effect"
import { NodeClusterSocket } from "@effect/platform-node"
import type { SqlClient } from "effect/unstable/sql"
import { Sharding } from "effect/unstable/cluster"

declare const SqlClientLayer: Layer.Layer<SqlClient.SqlClient>

// The transport entrypoint wires Sharding to a socket runner, SQL-backed
// message + runner storage, ping-based health, and env-driven config.
// You provide a SqlClient; you get a full cluster node.
const ClusterLayer = NodeClusterSocket.layer().pipe(
  Layer.provide(SqlClientLayer)
)

// Your entity layers depend on Sharding; provide the cluster layer to satisfy
// that dependency and you have a running runner.
declare const DepartmentLayer: Layer.Layer<never, never, Sharding.Sharding>

const RunnerProgram = DepartmentLayer.pipe(Layer.provide(ClusterLayer))
```

Service interface: `registerEntity` and `registerSingleton` (called under the hood by `Entity.toLayer` / `Singleton.make`), `makeClient` (called by `entity.client`), `getShardId`, `hasShardId`, `getSnowflake`, `isShutdown`, `getRegistrationEvents` (stream of registration events — handy to await startup), `pollStorage` to force a durable read.

> **Tip:** A process whose `ShardingConfig.runnerAddress` is `None` joins as a *client*: it can send messages but hosts no shards. Use the `layerClientOnly` variants on transport modules.

**Reach for it when** building cluster tooling or custom routing. Otherwise, provide its *layer*.

## Singleton

`effect/unstable/cluster` — unstable

Run an effect on exactly one node in the cluster, regardless of cluster size. `Singleton.make(name, effect)` returns a `Layer` that registers a background effect with Sharding. The runner owning the singleton's shard starts it; if ownership moves (node dies, rebalance) the fiber is interrupted on the old node and restarted on the new owner.

**Mental model.** A leader-elected fiber without writing the election. The singleton's name hashes to a shard; whoever owns that shard runs it. One owner at a time, automatic failover, zero coordination code.

```ts
import { Effect, Schedule } from "effect"
import { Singleton } from "effect/unstable/cluster"

// This loop runs on exactly one runner cluster-wide. It is the single source of
// truth for whether comp is frozen; if that runner dies, another picks it up.
const CompFreezeCoordinator = Singleton.make(
  "comp-freeze-coordinator",
  Effect.log("checking comp-freeze flag and broadcasting to departments...").pipe(
    // ... read the freeze flag, fan out to each Department entity ...
    Effect.repeat(Schedule.spaced("30 seconds")),
    Effect.forever
  ),
  { shardGroup: "default" }
)
```

> **Warning:** Failures from the effect are converted to *defects* — handle expected errors inside the effect if it should keep running. An effect that simply *completes* is held until ownership moves or the layer closes (wrap long-running work in `Effect.forever`). Registering the same name in the same shard group twice dies at registration.

**Reach for it when** you need a cluster-wide daemon that runs exactly once with failover, without standing up external coordination.

## Runner

`effect/unstable/cluster` — unstable

Metadata describing one process that can host shards. A `Runner` is a `Schema.Class` bundling a `RunnerAddress`, the shard `groups` it participates in, and a relative `weight` used when distributing shards.

**Mental model.** A row in the cluster's membership table. Each runner's address is added to its groups' hash rings with `weight` as its slice size — a higher weight earns proportionally more shards. Structurally compared and hashed by address + weight; serializes to/from JSON for exchange between nodes.

```ts
import { Runner, RunnerAddress } from "effect/unstable/cluster"

// A runner that hosts the "default" and "merit-cycle" groups, weighted 2x so it
// carries twice as many shards during the busy review season.
const self = Runner.make({
  address: RunnerAddress.make("10.0.0.4", 34431),
  groups: ["default", "merit-cycle"],
  weight: 2
})
```

**Reach for it when** building custom membership or storage backends. Standard deployments get `Runner` values constructed by the transport layer from `ShardingConfig`.

## Runners

`effect/unstable/cluster` — unstable

The node-to-node communication service. Where `Sharding` *decides* where a message goes, `Runners` *delivers* it. Can ping a runner, send a request or control envelope to a remote runner, notify a runner that work is waiting, and mark a runner address unavailable. Persisted notifications recover replies from storage; discarded volatile messages complete after delivery instead of waiting for an entity reply.

**Mental model.** The RPC transport between cluster members, expressed as its own `RpcGroup` (`Runners.Rpcs`). When a department lives on another machine, Sharding asks `Runners` to forward the envelope; the remote `RunnerServer` feeds it back into its own Sharding. Implementations: `layerNoop` (single-process, no networking), and the RPC-backed one driven by transport modules.

> **Note:** Configure `Runners` by choosing a transport layer. `SingleRunner.layer` and `TestRunner.layer` use `Runners.layerNoop`; `SocketRunner` / `HttpRunner` (via `NodeClusterSocket` / `NodeClusterHttp`) wire the RPC-backed version over real socket or HTTP/WebSocket. The pluggable seam is `Runners.RpcClientProtocol`.

**Reach for it when** implementing a new cluster transport. Otherwise, pick a runner layer.

## MessageStorage

`effect/unstable/cluster` — unstable

The durability boundary. `MessageStorage` is the pluggable backend that makes mailboxes *recoverable*. Saves requests, control envelopes, and replies; finds unprocessed messages for shards a runner owns; deduplicates requests by primary key; tracks reply handlers waiting on responses. Upgrades delivery from best-effort to **at-least-once that survives a crash**.

**Mental model.** When an RPC is annotated `ClusterSchema.Persisted`, the message is written to storage *before* being accepted; a restarted runner reads back its shards' unprocessed messages and resumes. Replies are stored too — a duplicate request (same primary key) returns the already-computed reply instead of re-running the handler. The contract is encoded (strings and bytes) so any database can back it.

- **noop / layerNoop** — No persistence. Volatile delivery only. Fine when every RPC is non-persisted.
- **MemoryDriver / layerMemory** — In-memory store for tests and single-process dev. Durable within the process lifetime; the engine behind TestRunner.
- **SqlMessageStorage** — Production choice: encodes envelopes and reply chunks into SQL tables, with migrations and dedup. Pairs with any `@effect/sql-*` client.

The save path returns a `SaveResult` tagged enum — `Success` or `Duplicate` (carrying the existing reply) — for raise-request dedup.

**Reach for it when** you mark RPCs `Persisted`. Pick `SqlMessageStorage` in production, `layerMemory` in tests.

## Snowflake

`effect/unstable/cluster` — unstable

Distributed unique ids. A `Snowflake` is a branded `bigint` packed from a millisecond timestamp, a 10-bit machine id, and a 12-bit per-machine sequence. Globally unique *and* roughly time-sortable without a central coordinator.

**Mental model.** Twitter's Snowflake scheme, Effect-native. High bits are time (since a 2025 epoch), middle bits identify the runner, low bits are a per-millisecond counter. Sort by the bigint to sort by creation time. The generator is `Clock`-backed, never moves time backward (absorbs clock drift), and rolls into the next millisecond if 4096 ids in one millisecond are exhausted.

```ts
import { Effect } from "effect"
import { Snowflake } from "effect/unstable/cluster"

const program = Effect.gen(function*() {
  const gen = yield* Snowflake.makeGenerator
  const raiseEventId = gen.nextUnsafe()      // a branded, sortable bigint

  // Decode it back into its parts whenever you need them — e.g. to learn which
  // runner stamped a raise event and exactly when.
  const { timestamp, machineId, sequence } = Snowflake.toParts(raiseEventId)
  const when = Snowflake.dateTime(raiseEventId)  // DateTime.Utc of creation
  yield* Effect.log(`raise event ${raiseEventId} from machine ${machineId} at ${when}`)
})

// Provide it as a service with Snowflake.layerGenerator.
```

Schemas: `SnowflakeFromBigInt` (branded bigint) and `SnowflakeFromString` (decodes/encodes via string, for JSON-safe transport).

**Reach for it when** you need ids that are unique across machines, sortable by time, and cheap to generate — for domain ids where a centralized sequence would be a bottleneck.

## EntityProxy

`effect/unstable/cluster` — unstable

A bridge that exposes a clustered entity to the outside world as a normal RPC service or HTTP API. `EntityProxy.toRpcGroup(entity)` derives an `RpcGroup`; `EntityProxy.toHttpApiGroup(name, entity)` derives an `HttpApiGroup`. Each entity RPC becomes a public operation whose payload gains an `entityId`, plus a fire-and-forget `...Discard` variant.

Normal derived RPC and HTTP request operations include `EntityNotAssignedToRunner` in their typed error channel when no runner currently owns the entity. The fire-and-forget `...Discard` variants deliberately do not expose that error, so use a normal request whenever assignment acknowledgement matters.

**Mental model.** The entity protocol is internal — it assumes the caller is inside the cluster. EntityProxy wraps it so an external client can hit a plain HTTP endpoint or RPC method. The generated handler (from `EntityProxyServer`) reads `entityId`, grabs the entity client, and forwards the call.

```ts
import { Layer, Schema } from "effect"
import { ClusterSchema, Entity, EntityProxy, EntityProxyServer } from "effect/unstable/cluster"
import { Rpc, RpcServer } from "effect/unstable/rpc"

const Department = Entity.make("Department", [
  Rpc.make("RecordRaise", {
    payload: {
      id: Schema.String,
      employeeId: Schema.String,
      amount: Schema.BigDecimal
    },
    primaryKey: ({ id }) => id,
    success: Schema.BigDecimal
  })
]).annotateRpcs(ClusterSchema.Persisted, true)

// Derive a public RpcGroup from the entity...
class DepartmentRpcs extends EntityProxy.toRpcGroup(Department) {}

// ...and serve it: the proxy handlers forward each call to the department client.
const ServerLayer = RpcServer.layer(DepartmentRpcs).pipe(
  Layer.provide(EntityProxyServer.layerRpcHandlers(Department))
)
```

**Reach for it when** you have entities behind the cluster wall and need to expose them to external callers over HTTP or RPC without hand-writing a forwarding controller per method.

## ClusterCron

`effect/unstable/cluster` — unstable

Distributed scheduled jobs. `ClusterCron.make` turns a `Cron.Cron` schedule into a `Layer` that coordinates one recurring job *across the whole cluster* rather than independently on every node.

**Mental model.** Singleton + Entity in combination. A singleton schedules the *first* run; each run is delivered as a *persisted* entity message whose `DeliverAt` time is the next cron tick, and the handler schedules the one after it. Persistence, single ownership, and message deduplication keep scheduling cluster-wide and failover-safe, but handler execution has at-least-once delivery semantics around crashes. Make the job effect idempotent or transactional. `skipIfOlderThan` stops it from stampeding through missed runs after downtime.

```ts
import { Cron, Effect } from "effect"
import { ClusterCron } from "effect/unstable/cluster"

// Kick off the quarterly merit-review cycle at 09:00 on the first day of Jan,
// Apr, Jul, and Oct — coordinated cluster-wide and delivered durably.
// Cron.parseUnsafe throws on a malformed expression; use Cron.parse for a Result.
const QuarterlyReviewKickoff = ClusterCron.make({
  name: "quarterly-review-kickoff",
  cron: Cron.parseUnsafe("0 9 1 1,4,7,10 *"),
  // ... replace this log with the work that creates the MeritCycle and fans out tasks.
  execute: Effect.log("opening the merit-review cycle: seeding budgets, notifying managers..."),
  skipIfOlderThan: "6 hours"
})
```

**Reach for it when** you want durable, deduplicated, failover-safe cron scheduling in a multi-node deployment and can make the scheduled effect safe for at-least-once delivery.

## ShardingConfig

`effect/unstable/cluster` — unstable

The configuration service for how *this* runner participates: its address, which shard groups it joins, how many shards per group, lock timing, mailbox and passivation limits, poll intervals, and health-check cadence.

**Mental model.** One config object per process, provided as a layer. Most important field: `runnerAddress` — `Some` means "I host shards"; `None` means client-only node. Other fields tune behavior: `shardsPerGroup` (granularity of distribution), `entityMaxIdleTime` (default passivation), `entityMailboxCapacity`, `*Interval` timings, and shard-lock settings for SQL-coordinated ownership.

```ts
import { ShardingConfig } from "effect/unstable/cluster"

// Programmatic config — sensible for tests / explicit setups.
const ConfigLayer = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMaxIdleTime: "10 minutes",
  entityMailboxCapacity: 4096
})

// Or load it from the environment (RUNNER_ADDRESS, SHARDS_PER_GROUP, ...).
const FromEnv = ShardingConfig.layerFromEnv()
```

> **Tip:** `layerDefaults` gives stock config; `layerFromEnv` reads a `Config` description for env-var-driven containers. Transport entrypoints default to `layerFromEnv` internally.

**Reach for it when** tuning cluster behavior, setting a runner's address/groups, or flipping a node into client-only mode.

> **Note:** Merge your entity layers, provide a cluster layer (bundles Sharding + Runners + storage + config), and launch. Swap `NodeClusterSocket.layer()` for `TestRunner.layer` to run the same entities single-process in a test.

```ts
import { Layer } from "effect"
import { NodeClusterSocket, NodeRuntime } from "@effect/platform-node"
import type { SqlClient } from "effect/unstable/sql"
import { Sharding } from "effect/unstable/cluster"

declare const SqlClientLayer: Layer.Layer<SqlClient.SqlClient>
declare const DepartmentLayer: Layer.Layer<never, never, Sharding.Sharding>

// Production: a real socket runner backed by SQL storage.
const ClusterLayer = NodeClusterSocket.layer().pipe(Layer.provide(SqlClientLayer))

const AppLayer = Layer.mergeAll(DepartmentLayer).pipe(Layer.provide(ClusterLayer))

Layer.launch(AppLayer).pipe(NodeRuntime.runMain)
```

**The supporting cast.** Smaller modules the headline acts lean on — addresses and ids, transport variants, durable backends, errors, metrics, and wire envelopes. Rarely imported directly, but knowing them makes type errors legible.

**Addresses & identifiers**

## EntityAddress

`effect/unstable/cluster` — unstable

The full routing target for one entity instance: `entityType` + `entityId` + `shardId`, bundled as a `Schema.Class`. Used by messages, persisted envelopes, and entity managers. Read the current one inside a handler via `Entity.CurrentAddress`.

## EntityId

`effect/unstable/cluster` — unstable

A branded `string` — the routing key sharding hashes to pick a shard. `EntityId.make("dept-eng")` brands a raw string. The "which instance" half of an address.

## EntityType

`effect/unstable/cluster` — unstable

A branded `string` naming a *family* of entities (e.g., the "Department" in `Entity.make("Department", ...)`). Distinguishes one kind of actor from another before any id is considered.

## RunnerAddress

`effect/unstable/cluster` — unstable

A `host` + `port` `Schema.Class` identifying how to reach a runner, with structural equality, hashing, and a stable primary key. `RunnerAddress.make("10.0.0.4", 34431)`.

## ShardId

`effect/unstable/cluster` — unstable

The address of a shard inside a group: a string `group` + numeric `id`, rendered as `group:id` at storage/routing boundaries. Entity ids hash into these; runners own sets of them.

## SingletonAddress

`effect/unstable/cluster` — unstable

The runtime address of a registered singleton: its `name` paired with the `ShardId` chosen from that name and shard group. Used in registration events and local fiber tracking.

## MachineId

`effect/unstable/cluster` — unstable

A branded integer marking the machine component of a runner — the middle bits of a Snowflake. Keeps the value distinct from a plain `number` in APIs.

**Runner transports & health**

## RunnerServer

`effect/unstable/cluster` — unstable

Server side of the runner protocol: receives ping/notify/request/stream/envelope messages from other runners and forwards them into local `Sharding`. `layer` is the full server; `layerClientOnly` for nodes that send but do not serve.

## RunnerHealth

`effect/unstable/cluster` — unstable

Decides whether a runner should be treated as alive, so Sharding knows when to move its shards. `layerNoop` (always alive), `layerPing` (heartbeat-based), and `layerK8s` (reads pod readiness).

## SingleRunner

`effect/unstable/cluster` — unstable

A single-process cluster layer: `Sharding` + no-op runner comms + no-op health + SQL message storage + env config, with SQL or in-memory runner storage. For embedded or small single-node deployments that still want durable entities. Requires a `SqlClient`.

## SocketRunner

`effect/unstable/cluster` — unstable

Runs runner RPCs over a raw socket transport on a provided `SocketServer`. `layer` serves and provides clients; `layerClientOnly` dials without hosting shards. The engine under `NodeClusterSocket`.

## HttpRunner

`effect/unstable/cluster` — unstable

Connects runner RPCs to HTTP and WebSocket transports — client protocol layers for dialing runner addresses, effects to serve handlers, and route layers for an `HttpRouter`. The engine under `NodeClusterHttp`.

## TestRunner

`effect/unstable/cluster` — unstable

The smallest useful cluster runtime for tests: `Sharding` over in-memory message + runner storage, no-op transport, always-healthy checks. Exercise entity registration, routing, and mailbox persistence with no RPC servers or database — just provide `TestRunner.layer`.

## K8sHttpClient

`effect/unstable/cluster` — unstable

A thin HTTP client for the in-cluster Kubernetes API, using the mounted service-account token. Backs the K8s-aware health check and pod helpers (list pods, create pod) for runners that manage their own infrastructure.

**Durable storage backends**

## SqlMessageStorage

`effect/unstable/cluster` — unstable

The production `MessageStorage`: encodes envelopes and reply chunks into SQL tables, redelivers unprocessed messages after restart, deduplicates by primary key, and replays reply chunks until acknowledged. Ships migrations and an optional table prefix. Provide via `layer` with any `@effect/sql-*` client.

## SqlRunnerStorage

`effect/unstable/cluster` — unstable

SQL-backed runner registration and shard-ownership: records runners, health flags, machine ids, and shard locks so multiple processes coordinate who owns each shard. Uses advisory locks on Postgres/MySQL when enabled.

> **Upgrade warning:** PostgreSQL advisory shard locks are namespaced by the `SqlRunnerStorage` table prefix. When upgrading a deployment that used unnamespaced lock keys, stop the whole cluster before rollout; mixing lock schemes can allow split ownership.

## RunnerStorage

`effect/unstable/cluster` — unstable

The typed service contract for runner registration and shard-lock state (which runners exist, their machine ids, which locks they hold). `layerMemory` for single-process/tests; `SqlRunnerStorage` implements it for real clusters.

**Annotations, errors & observability**

## ClusterSchema

`effect/unstable/cluster` — unstable

Annotations that add cluster behavior to RPCs and entities without touching payload/result schemas: `Persisted` (durable delivery), `WithTransaction`, `Uninterruptible`, `ShardGroup` (route ids to a group), and `ClientTracingEnabled`. Attach with `.annotate` / `.annotateRpcs`.

## ClusterError

`effect/unstable/cluster` — unstable

Structured, schema-backed failures of the cluster runtime: `EntityNotAssignedToRunner`, `MailboxFull`, `AlreadyProcessingMessage`, `PersistenceError`, `MalformedMessage`, `RunnerUnavailable`, `RunnerNotRegistered`. Catch with `Effect.catchTag`.

## ClusterMetrics

`effect/unstable/cluster` — unstable

Standard gauges the runtime updates while running: active `entities`, `singletons`, registered `runners`, `runnersHealthy`, and acquired `shards`. Wire to a metrics exporter for cluster visibility.

## ShardingRegistrationEvent

`effect/unstable/cluster` — unstable

Events emitted by `Sharding.getRegistrationEvents` when the local runner registers an entity (`EntityRegistered`) or singleton (`SingletonRegistered`). Await at startup to confirm entities and singletons are live, or assert on them in tests.

**Wire protocol & message shapes**

## Envelope

`effect/unstable/cluster` — unstable

The transport envelopes entities exchange: a `Request` wraps a decoded payload with target address, RPC tag, request id, headers, and tracing context; `AckChunk` acknowledges streamed reply chunks; `Interrupt` cancels an in-flight request. Includes JSON codecs and storage primary-key helpers.

## Message

`effect/unstable/cluster` — unstable

The message shapes moved through the cluster, in `Incoming` and `Outgoing` variants (request, envelope, interrupt). Carries entity requests and control messages between callers, storage, transports, and handlers, with serialize/deserialize helpers matched to RPC schemas.

## Reply

`effect/unstable/cluster` — unstable

Values produced by clustered RPC execution: a final `WithExit` carrying the RPC `Exit`, or a streaming `Chunk` carrying a non-empty batch of successes. `ReplyWithContext` carries encoding services; serialization helpers move replies through storage or transport.

## DeliverAt

`effect/unstable/cluster` — unstable

A protocol for message payloads that carry their own scheduled delivery time. Implement the `DeliverAt.symbol` method to return a target `DateTime`, and durable storage will hold the message until then. The mechanism behind ClusterCron's timed runs.

**Entity helpers & durable workflows**

## EntityProxyServer

`effect/unstable/cluster` — unstable

The handler side of EntityProxy: `layerRpcHandlers(entity)` and `layerHttpApi(api, name, entity)` implement the derived RPC/HTTP operations by reading `entityId`, calling the entity client, and forwarding the payload — including the discard variants.

## EntityResource

`effect/unstable/cluster` — unstable

Keeps a long-lived resource alive across routine entity restarts, tied to an entity address. `make({ acquire, idleTimeToLive })` wraps it with a close scope that survives passivation; `makeK8sPod` manages a pod. Pairs with `Entity.keepAlive`.

## ClusterWorkflowEngine

`effect/unstable/cluster` — unstable

Runs durable `Workflow` executions on top of cluster sharding and message storage. Adapts `WorkflowEngine` so executions, activities, deferred completions, resumes, interrupts, and durable clock wakeups all become persisted cluster entity messages — durable, distributed orchestration for multi-step workflows. Provide its `layer` to back a workflow runtime with the cluster.

> **Tip:** Use cluster entities when work is naturally addressed to a sharded identity and needs single-runner ownership. For the workflow definition, activity, retry, and durable-clock model that `ClusterWorkflowEngine` distributes, continue with [Workflows & Durable Execution](workflows-durable-execution).
