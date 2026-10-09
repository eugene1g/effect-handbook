# Cluster & Sharding

Effect Cluster provides *entities*: stateful, addressable actors keyed by id, distributed across machines and reachable through typed RPC clients. A message to `dept-eng` is routed to the owning shard, the entity is spun up on demand, kept warm, and passivated when idle. Pair with durable message storage for at-least-once delivery that survives restarts.

> **Note:** The spine: **Entity** defines an addressable actor and its RPC protocol. **Sharding** routes every message. **Runner**/**Runners** host shards and talk to each other. **MessageStorage** makes delivery durable. **Singleton**, **Snowflake**, **EntityProxy**, **ClusterCron**, **ShardingConfig** hang off those four. Define entities, merge their layers, provide a cluster layer.

> **Official example:** Effect's release-matched [`ai-docs` cluster example](https://github.com/Effect-TS/effect/tree/effect%404.0.2/ai-docs/src/80_cluster) defines and runs a distributed entity.

> **Warning:** The entire cluster surface lives under `effect/cluster`. APIs may shift between minor versions. Pin your version and re-check signatures when you upgrade. Transport entrypoints (`NodeClusterSocket`, `NodeClusterHttp`) come from `@effect/platform-node`; `@effect/platform-bun` and `@effect/platform-deno` ship the matching `BunCluster*` / `DenoCluster*` modules.

> **Note:** The socket and HTTP/WebSocket runner transports serialize runner-to-runner traffic with `SchemaBinary` by default (`serialization: "binary"`); `"ndjson"` (newline-delimited JSON) is the interoperable alternative when you need a text wire format. Every runner **and** every client-only node of one cluster must agree on this setting. See [Transport options](#transport-options).

## Entity

`effect/cluster` — unstable

An `Entity` gives a stable *type name* and an *RPC protocol* to a family of values addressed by id. `Entity.make("Department", [RecordRaise, GetBudget])` declares a kind called Department, keyed by string id, with those RPCs. The cluster picks a shard for each id and routes requests to the owning runner.

**Mental model.** A sharded, stateful actor whose interface is an `RpcGroup`. Each live instance processes a mailbox sequentially (no locks needed), holds state in a plain `Ref`. Idle long enough and it is *passivated* — stopped, state dropped — then transparently recreated on the next message. Address an instance by id; the runtime materializes it.

Define the protocol with `Rpc.make`, register handlers with `entity.toLayer(...)`, get a typed client with `entity.client`. The handler builder is a normal `Effect.gen` that can allocate per-instance state and close over it.

```ts
import { BigDecimal, Effect, Ref, Schema } from "effect"
import { ClusterSchema, Entity } from "effect/cluster"
import { Rpc } from "effect/rpc"

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

> **Note:** `toLayer` takes `maxIdleTime` (passivation; the `ShardingConfig.entityMaxIdleTime` default is one minute), `concurrency` (defaults to sequential per instance), `mailboxCapacity`, a `defectRetryPolicy`, `disableFatalDefects`, and `spanAttributes`. By default a handler defect is *fatal to the instance*: the runtime logs it, waits according to `defectRetryPolicy`, rebuilds the instance, and re-delivers the requests that were in flight — so handlers must tolerate redelivery. With `disableFatalDefects: true` only the failing call reports the defect and the instance keeps running. Inside a handler read `Entity.CurrentAddress` (this entity's type/id/shard) and call `Entity.keepAlive(true)` to pin an instance alive while it holds a resource. For tests without transport, `Entity.makeTestClient(entity, layer)` builds an in-memory client. It honors the entity layer's `disableFatalDefects` setting: without it, one handler defect also fails the other calls pending on that entity id in the test.

> **Note:** Handlers resolve services from the context in which the entity is *registered* — what you provide to the `entity.toLayer(...)` layer wins. Services that were only present when `Sharding` itself was constructed remain a fallback, not an override.

**Reach for it when** you have per-key state that you want distributed across machines while keeping each key's logic single-threaded and addressable.

## Sharding

`effect/cluster` — unstable

The routing brain of the cluster; every entity client implicitly depends on it. `Sharding` decides which shard owns a given entity id, tracks shards belonging to the local runner, sends each message to a local handler or across the wire to the owning runner. Also registers entities and singletons, mints runner-local snowflake ids, and polls durable storage for persisted work.

**Mental model.** Entity ids are hashed into a fixed number of *shards* per group; shards are spread across healthy runners using a consistent hash ring weighted per runner. When you send to `dept-eng`, Sharding computes its `ShardId`, looks up the owning runner, and routes. When runners join or leave, shards are reassigned and entities migrate — client code never changes. You almost never call `Sharding` methods directly; provide its layer and let `Entity` and `Singleton` drive it.

```ts
import { Layer } from "effect"
import { NodeClusterSocket } from "@effect/platform-node"
import type { SqlClient } from "effect/sql"
import { Sharding } from "effect/cluster"

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

A local send that is waiting for an entity type to register is bounded: once the shared runner-registration deadline elapses, it fails with an `Entity type ... not registered` defect instead of waiting forever, and a send to a still-unregistered dynamic entity type fails immediately once that deadline has passed.

> **Tip:** A process whose `ShardingConfig.runnerAddress` is `None` joins as a *client*: it can send messages but hosts no shards. Use the `layerClientOnly` variants on transport modules.

### Transport options

`NodeClusterSocket.layer(options?)` and `NodeClusterHttp.layer({ transport, ...options })` (and the Bun and Deno equivalents) take the same option set. Every runner **and** every client-only node of one cluster must agree on the serialization.

| Option | Default | Meaning |
| --- | --- | --- |
| `transport` (`NodeClusterHttp` only, required) | — | `"http"` or `"websocket"` between runners. |
| `serialization` | `"binary"` | `"binary"` = `RpcSerialization.layerSchemaBinary` (schema-derived frames); `"ndjson"` = newline-delimited JSON. This is the runner wire format, so it is a deployment-wide choice. |
| `serializationMaxBufferSize` | 16 MiB | Largest frame (`"binary"`) or buffered line (`"ndjson"`) a runner accepts; `"unbounded"` removes the limit. Raise it deliberately — it bounds memory per connection. |
| `clientOnly` | `false` | `true` builds a node that sends but hosts no shards and opens no server. |
| `storage` | `"sql"` | `"sql"` = `SqlMessageStorage` + `SqlRunnerStorage` (requires a `SqlClient`); `"local"` = no message persistence and in-memory runner storage (single process only); `"byo"` = you provide `MessageStorage` and `RunnerStorage`. |
| `runnerHealth` | `"ping"` | `"k8s"` reads pod readiness instead (`runnerHealthK8s: { namespace, labelSelector }`). |
| `shardingConfig` | — | Partial `ShardingConfig` merged over the environment-derived values. |

```ts
import { Layer } from "effect"
import { NodeClusterSocket } from "@effect/platform-node"
import type { SqlClient } from "effect/sql"

declare const SqlClientLayer: Layer.Layer<SqlClient.SqlClient>

// Pin to "ndjson" when a deployment needs a text wire format instead of the
// binary default — every runner and client-only node must agree.
const TextWireCluster = NodeClusterSocket.layer({
  serialization: "ndjson",
  serializationMaxBufferSize: 8 * 1024 * 1024,
  shardingConfig: { maxResidentEntities: 5_000 }
}).pipe(Layer.provide(SqlClientLayer))
```

For what the serialization layers do on the wire, see [RPC](../interfaces/rpc).

### Rebalance and shutdown behavior

- **Shard assignment comes from `HashRing`** (the stable `effect/HashRing` module): one ring per shard group, each runner added with its `weight`. An eligible runner sitting at the first ring position is not skipped once other runners have reached their allocation quota.
- **A persisted call never fails just because ownership is moving.** The caller keeps waiting on message storage; only a shutdown of the caller's own runner ends the wait, and it does so by interruption (see [EntityProxy](#entityproxy)).
- **Teardown bookkeeping is bounded.** Whether an interrupt is "transient" is decided from live teardown state — entity, shard, singleton, entity type, or node shutdown — rather than from a growing set of fiber ids, so mass passivation does not leak memory.
- **Process death skips finalizers.** Entity finalizers and `Entity.keepAlive` scopes run on graceful passivation and shutdown only; recovery after a kill relies on runner health checks, shard-lock release or expiry (`shardLockExpiration` defaults to 35 seconds), and redelivery of persisted messages — never on cleanup code having run.

**Reach for it when** building cluster tooling or custom routing. Otherwise, provide its *layer*.

## Singleton

`effect/cluster` — unstable

Run an effect on exactly one node in the cluster, regardless of cluster size. `Singleton.make(name, effect)` returns a `Layer` that registers a background effect with Sharding. The runner owning the singleton's shard starts it; if ownership moves (node dies, rebalance) the fiber is interrupted on the old node and restarted on the new owner.

**Mental model.** A leader-elected fiber without writing the election. The singleton's name hashes to a shard; whoever owns that shard runs it. One owner at a time, automatic failover, zero coordination code.

```ts
import { Effect, Schedule } from "effect"
import { Singleton } from "effect/cluster"

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

`effect/cluster` — unstable

Metadata describing one process that can host shards. A `Runner` is a `Schema.Class` bundling a `RunnerAddress`, the shard `groups` it participates in, and a relative `weight` used when distributing shards.

**Mental model.** A row in the cluster's membership table. Each runner's address is added to its groups' hash rings with `weight` as its slice size — a higher weight earns proportionally more shards. Structurally compared and hashed by address + weight; serializes to/from JSON for exchange between nodes.

```ts
import { Runner, RunnerAddress } from "effect/cluster"

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

`effect/cluster` — unstable

The node-to-node communication service. Where `Sharding` *decides* where a message goes, `Runners` *delivers* it. Can ping a runner, send a request or control envelope to a remote runner, notify a runner that work is waiting, and mark a runner address unavailable. Persisted notifications recover replies from storage; discarded volatile messages complete after delivery instead of waiting for an entity reply.

**Mental model.** The RPC transport between cluster members, expressed as its own `RpcGroup` (`Runners.Rpcs`). When a department lives on another machine, Sharding asks `Runners` to forward the envelope; the remote `RunnerServer` feeds it back into its own Sharding. Implementations: `layerNoop` (single-process, no networking), and the RPC-backed one driven by transport modules.

> **Note:** Configure `Runners` by choosing a transport layer. `SingleRunner.layer` and `TestRunner.layer` use `Runners.layerNoop`; `SocketRunner` / `HttpRunner` (via `NodeClusterSocket` / `NodeClusterHttp`) wire the RPC-backed version over real socket or HTTP/WebSocket. The pluggable seam is `Runners.RpcClientProtocol`. The platform transport layers choose the RPC serialization for that protocol (`SchemaBinary` by default, NDJSON on request — see [Transport options](#transport-options)).

**Reach for it when** implementing a new cluster transport. Otherwise, pick a runner layer.

## MessageStorage

`effect/cluster` — unstable

The durability boundary. `MessageStorage` is the pluggable backend that makes mailboxes *recoverable*. Saves requests, control envelopes, and replies; finds unprocessed messages for shards a runner owns; deduplicates requests by primary key; tracks reply handlers waiting on responses. Upgrades delivery from best-effort to **at-least-once that survives a crash**.

**Mental model.** When an RPC is annotated `ClusterSchema.Persisted`, the message is written to storage *before* being accepted; a restarted runner reads back its shards' unprocessed messages and resumes. Replies are stored too — a duplicate request (same primary key) returns the already-computed reply instead of re-running the handler. The contract is encoded (strings and bytes) so any database can back it.

- **noop / layerNoop** — No persistence. Volatile delivery only. Fine when every RPC is non-persisted.
- **MemoryDriver / layerMemory** — In-memory store for tests and single-process dev. Durable within the process lifetime; the engine behind TestRunner.
- **SqlMessageStorage** — Production choice: encodes envelopes and reply chunks into SQL tables, with migrations and dedup. Pairs with any `@effect/sql-*` client.

The save path returns a `SaveResult` tagged enum — `Success` or `Duplicate` (carrying the existing reply) — for raise-request dedup.

**Reads are bounded and claim only what they return.** `unprocessedMessages(shardIds, { limit?, addresses? })` reads at most `limit` messages (the runner passes `ShardingConfig.unprocessedMessageBatchSize`) and can be restricted to specific entity addresses. Only the returned messages are claimed; everything else stays eligible for a later poll, which is what lets a runner at its residency cap keep serving resident entities without starving the rest. The in-memory driver applies the same ten-minute claim window as SQL, and `resetAddress` / `resetAddresses` / `resetShards` make claimed messages eligible again immediately.

**Custom backends.** `MessageStorage.makeEncoded(encoded)` lifts an `Encoded` driver (strings and bytes) into the typed service. The driver contract's reset operation is the batched `resetAddresses(addresses)`, so a hand-written driver must implement that form. `SqlMessageStorage.makeEncoded({ prefix? })` returns the SQL `Encoded` driver on its own when you want to wrap or compose it.

**Without `MessageStorage` (`noop`/`layerNoop`), completed request ids are not retained.** Redelivering a request id that already completed re-runs it instead of failing with `AlreadyProcessingMessage` — that dedup guarantee needs real storage.

**Reach for it when** you mark RPCs `Persisted`. Pick `SqlMessageStorage` in production, `layerMemory` in tests.

## Snowflake

`effect/cluster` — unstable

Distributed unique ids. A `Snowflake` is a branded `bigint` packed from a millisecond timestamp, a 10-bit machine id, and a 12-bit per-machine sequence. Globally unique *and* roughly time-sortable without a central coordinator.

**Mental model.** Twitter's Snowflake scheme, Effect-native. High bits are time (since a 2025 epoch), middle bits identify the runner, low bits are a per-millisecond counter. Sort by the bigint to sort by creation time. The generator is `Clock`-backed, never moves time backward (absorbs clock drift), and rolls into the next millisecond if 4096 ids in one millisecond are exhausted.

```ts
import { Effect } from "effect"
import { Snowflake } from "effect/cluster"

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

`effect/cluster` — unstable

A bridge that exposes a clustered entity to the outside world as a normal RPC service or HTTP API. `EntityProxy.toRpcGroup(entity)` derives an `RpcGroup`; `EntityProxy.toHttpApiGroup(name, entity)` derives an `HttpApiGroup`. Each entity RPC becomes a public operation whose payload gains an `entityId`, plus a fire-and-forget `...Discard` variant.

Normal derived RPC and HTTP request operations include `EntityNotAssignedToRunner` in their typed error channel. The fire-and-forget `...Discard` variants deliberately do not expose that error, so use a normal request whenever assignment acknowledgement matters.

**What `EntityNotAssignedToRunner` means now.** Treat it as *genuine* non-assignment — typically a volatile send that reached a runner which does not own the shard. For a **persisted** message, the transient states of a rebalance no longer surface as errors:

| Situation while a caller awaits a persisted reply | Caller observes |
| --- | --- |
| The entity moves to another runner, or is shut down before replying | Nothing — the caller keeps waiting and receives the reply from message storage once the next owner has processed the request. |
| The **local** runner (the one hosting the caller) is shutting down | The call is **interrupted**, not failed: the request is already durable and will be served by the next owner. Do not map this interrupt to a domain error or a retry. |
| The runner is at `maxResidentEntities` | The send succeeds; the message waits in storage for a free slot. |

Volatile sends have no storage to fall back on, so they still fail fast: `EntityNotAssignedToRunner`, `RunnerUnavailable`, or `MailboxFull`.

**Mental model.** The entity protocol is internal — it assumes the caller is inside the cluster. EntityProxy wraps it so an external client can hit a plain HTTP endpoint or RPC method. The generated handler (from `EntityProxyServer`) reads `entityId`, grabs the entity client, and forwards the call.

```ts
import { Layer, Schema } from "effect"
import { ClusterSchema, Entity, EntityProxy, EntityProxyServer } from "effect/cluster"
import { Rpc, RpcServer } from "effect/rpc"

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

`effect/cluster` — unstable

Distributed scheduled jobs. `ClusterCron.make` turns a `Cron.Cron` schedule into a `Layer` that coordinates one recurring job *across the whole cluster* rather than independently on every node.

**Mental model.** Singleton + Entity in combination. A singleton schedules the *first* run; each run is delivered as a *persisted* entity message whose `DeliverAt` time is the next cron tick, and the handler schedules the one after it. Persistence, single ownership, and message deduplication keep scheduling cluster-wide and failover-safe, but handler execution has at-least-once delivery semantics around crashes. Make the job effect idempotent or transactional. `skipIfOlderThan` stops it from stampeding through missed runs after downtime.

```ts
import { Cron, Effect } from "effect"
import { ClusterCron } from "effect/cluster"

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

`effect/cluster` — unstable

The configuration service for how *this* runner participates: its address, which shard groups it joins, how many shards per group, lock timing, mailbox and passivation limits, poll intervals, and health-check cadence.

**Mental model.** One config object per process, provided as a layer. Most important field: `runnerAddress` — `Some` means "I host shards"; `None` means client-only node. `runnerListenAddress` is the local bind address, defaulting to `runnerAddress`; from the environment it resolves to `None` unless `listenHost` is set, even when `listenPort` is valid — supply `listenHost` to configure a distinct listen address. Other fields tune behavior: `shardsPerGroup` (granularity of distribution), `entityMaxIdleTime` (default passivation), `entityMailboxCapacity`, `*Interval` timings, and shard-lock settings for SQL-coordinated ownership.

```ts
import { ShardingConfig } from "effect/cluster"

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

### Capacity limits and their defaults

Every limit below is per runner. Environment names are the constant-case form of the field (`MAX_RESIDENT_ENTITIES`, `ENTITY_MAILBOX_CAPACITY`, …).

| Field | Default | What happens at the limit |
| --- | --- | --- |
| `maxResidentEntities` | `10_000` | No new entity is spawned. The storage read loop stops admitting messages for **new** addresses (they stay in storage until a slot frees up) and keeps serving resident ones; a **volatile** send to a new address fails with `MailboxFull`; a **persisted** send still succeeds. `"unbounded"` restores the old behavior and can only be set programmatically — the environment form accepts positive integers only. |
| `unprocessedMessageBatchSize` | `1024` | Upper bound on messages read from storage in one poll; a full batch that delivered work triggers an immediate follow-up read instead of waiting for the poll interval. |
| `entityMailboxCapacity` | `4096` | A request to a resident entity whose mailbox is full fails with `MailboxFull` (volatile) or stays in storage for redelivery (persisted). |
| `entityMaxIdleTime` | 1 minute | Idle instances are passivated, which frees a residency slot. |
| `entityTerminationTimeout` | 15 seconds | Longest wait for an entity to terminate during shutdown or rebalance (chosen to fit inside Kubernetes' default grace period). |

**Size `maxResidentEntities` from memory, not from traffic.** It is a safety valve against an activation storm (for example a cold start draining a large backlog); when it engages, persisted work is delayed rather than lost, so alert on the `entities` gauge from [`ClusterMetrics`](#clustermetrics) approaching the cap and on storage backlog age.

**Reach for it when** tuning cluster behavior, setting a runner's address/groups, or flipping a node into client-only mode.

> **Note:** Merge your entity layers, provide a cluster layer (bundles Sharding + Runners + storage + config), and launch. Swap `NodeClusterSocket.layer()` for `TestRunner.layer` to run the same entities single-process in a test.

```ts
import { Layer } from "effect"
import { NodeClusterSocket, NodeRuntime } from "@effect/platform-node"
import type { SqlClient } from "effect/sql"
import { Sharding } from "effect/cluster"

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

`effect/cluster` — unstable

The full routing target for one entity instance: `entityType` + `entityId` + `shardId`, bundled as a `Schema.Class`. Used by messages, persisted envelopes, and entity managers. Read the current one inside a handler via `Entity.CurrentAddress`.

## EntityId

`effect/cluster` — unstable

A branded `string` — the routing key sharding hashes to pick a shard. `EntityId.make("dept-eng")` brands a raw string. The "which instance" half of an address.

## EntityType

`effect/cluster` — unstable

A branded `string` naming a *family* of entities (e.g., the "Department" in `Entity.make("Department", ...)`). Distinguishes one kind of actor from another before any id is considered.

## RunnerAddress

`effect/cluster` — unstable

A `host` + `port` `Schema.Class` identifying how to reach a runner, with structural equality, hashing, and a stable primary key. `RunnerAddress.make("10.0.0.4", 34431)`.

## ShardId

`effect/cluster` — unstable

The address of a shard inside a group: a string `group` + numeric `id`, rendered as `group:id` at storage/routing boundaries. Entity ids hash into these; runners own sets of them.

## SingletonAddress

`effect/cluster` — unstable

The runtime address of a registered singleton: its `name` paired with the `ShardId` chosen from that name and shard group. Used in registration events and local fiber tracking.

## MachineId

`effect/cluster` — unstable

A branded integer marking the machine component of a runner — the middle bits of a Snowflake. Keeps the value distinct from a plain `number` in APIs.

**Runner transports & health**

## RunnerServer

`effect/cluster` — unstable

Server side of the runner protocol: receives ping/notify/request/stream/envelope messages from other runners and forwards them into local `Sharding`. `layer` is the full server; `layerClientOnly` for nodes that send but do not serve.

A **volatile** (non-`Persisted`) request that is interruptible is bound to the calling runner's connection: when that caller disconnects, the entity handler is interrupted and its mailbox slot is released, instead of running on for nobody. Persisted requests and `Uninterruptible` RPCs are unaffected and still run to completion, so a caller that reconnects must not assume a volatile call it lost was abandoned before its side effects.

## RunnerHealth

`effect/cluster` — unstable

Decides whether a runner should be treated as alive, so Sharding knows when to move its shards. `layerNoop` (always alive), `layerPing` (heartbeat-based), and `layerK8s` (reads pod readiness).

## SingleRunner

`effect/cluster` — unstable

A single-process cluster layer: `Sharding` + no-op runner comms + no-op health + SQL message storage + env config, with SQL or in-memory runner storage. For embedded or small single-node deployments that still want durable entities. Requires a `SqlClient`.

## SocketRunner

`effect/cluster` — unstable

Runs runner RPCs over a raw socket transport on a provided `SocketServer`. `layer` serves and provides clients; `layerClientOnly` dials without hosting shards. The engine under `NodeClusterSocket`.

## HttpRunner

`effect/cluster` — unstable

Connects runner RPCs to HTTP and WebSocket transports — client protocol layers for dialing runner addresses, effects to serve handlers, and route layers for an `HttpRouter`. The engine under `NodeClusterHttp`. Client URLs are built from the runner address plus the configured path, inserting a `/` only when the path lacks one, so a slash-prefixed path such as `/cluster/rpc` is used as written (earlier builds produced a doubled slash).

## TestRunner

`effect/cluster` — unstable

The smallest useful cluster runtime for tests: `Sharding` over in-memory message + runner storage, no-op transport, always-healthy checks. Exercise entity registration, routing, and mailbox persistence with no RPC servers or database — just provide `TestRunner.layer`.

## K8sHttpClient

`effect/cluster` — unstable

A thin HTTP client for the in-cluster Kubernetes API, using the mounted service-account token. Backs the K8s-aware health check and pod helpers (list pods, create pod) for runners that manage their own infrastructure.

## K8sTypes

`effect/cluster/K8sTypes` — unstable

Type-only Kubernetes declarations used by the cluster helpers: the transitive closure of `Pod` (spec, containers, volumes, affinity, status, metadata), vendored from `kubernetes-types` 1.30 so the `kubernetes-types` dependency could be dropped. `K8sHttpClient.makeCreatePod` takes a `K8sTypes.Pod`. It carries no runtime code and is not a general Kubernetes client model — import it when you construct a pod spec for the cluster helpers, not as a substitute for a full Kubernetes SDK.

**Durable storage backends**

## SqlMessageStorage

`effect/cluster` — unstable

The production `MessageStorage`: encodes envelopes and reply chunks into SQL tables, redelivers unprocessed messages after restart, deduplicates by primary key, and replays reply chunks until acknowledged. Ships migrations and an optional table prefix (`layerWith({ prefix })`; default `cluster`). Provide via `layer` with any `@effect/sql-*` client; the layer also requires a `Crypto` service, which the platform cluster entrypoints supply. `makeEncoded({ prefix? })` exposes the SQL `MessageStorage.Encoded` driver by itself for custom storage composition. Changing the prefix after deployment points the runtime at a different set of tables, including the migration history.

## SqlRunnerStorage

`effect/cluster` — unstable

SQL-backed runner registration and shard-ownership: records runners, health flags, machine ids, and shard locks so multiple processes coordinate who owns each shard. Uses advisory locks on Postgres/MySQL when enabled.

> **Note:** PostgreSQL advisory shard locks are namespaced by the `SqlRunnerStorage` table prefix. Changing the prefix on a running deployment points lock keys at a different namespace; stop the whole cluster before rolling out such a change, since mixing lock schemes can allow split ownership.

> **Note:** Advisory locks live on a reserved connection. While lock storage is unhealthy, the liveness probe runs on the shared pool instead of that reserved connection, so a hung reserved connection cannot stall shard-lock recovery, and failed probes are logged as warnings instead of being swallowed. With `shardLockDisableAdvisory` (row-based locks instead of advisory locks), acquisition, refresh, and bulk release all take their row locks in a consistent order to avoid lock-order deadlocks. Locks are leases, not fencing: a paused former owner can still issue a write after takeover, so protect external writes with idempotency keys or a version check in the sink.

## RunnerStorage

`effect/cluster` — unstable

The typed service contract for runner registration and shard-lock state (which runners exist, their machine ids, which locks they hold). `layerMemory` for single-process/tests; `SqlRunnerStorage` implements it for real clusters.

**Annotations, errors & observability**

## ClusterSchema

`effect/cluster` — unstable

Annotations that add cluster behavior to RPCs and entities without touching payload/result schemas: `Persisted` (durable delivery), `WithTransaction`, `Uninterruptible` (`true`, `"client"`, or `"server"`), `ShardGroup` (route ids to a group), `ClientTracingEnabled`, and `Dynamic` (compute server-side annotations from the decoded request). Attach with `.annotate` / `.annotateRpcs`. A `WithTransaction` value computed through `Dynamic` is kept when the entity re-runs a request, after a handler defect or after an interrupt that a server-uninterruptible persisted request ignores.

`ClusterSchema.Abandon` is different: it is not something you attach. It marks the *interruption* a runner raises when it abandons a persisted request that must continue under another owner (shutdown, shard loss). `ClusterWorkflowEngine` recognizes that mark and treats the interrupt as an abandoned run attempt — see [Workflows & Durable Execution](workflows-durable-execution#abandoned-run-attempts). Application code should let such an interrupt propagate rather than catching it.

## ClusterError

`effect/cluster` — unstable

Structured, schema-backed failures of the cluster runtime: `EntityNotAssignedToRunner`, `MailboxFull`, `AlreadyProcessingMessage`, `PersistenceError`, `MalformedMessage`, `RunnerUnavailable`, `RunnerNotRegistered`. Catch with `Effect.catchTag`.

| Error | Raised when | Usual response |
| --- | --- | --- |
| `EntityNotAssignedToRunner` | The addressed shard is genuinely not owned by the runner that received a volatile send. Transient rebalance states of a *persisted* message no longer produce it (see [EntityProxy](#entityproxy)). | Retry after a short delay; `refreshAssignmentsInterval` defaults to 3 seconds. |
| `MailboxFull` | An entity's mailbox is at `entityMailboxCapacity`, **or** the runner is at `maxResidentEntities` and a volatile send targets a new address. | Back-pressure the caller, or mark the RPC `Persisted` so it waits in storage instead. |
| `RunnerUnavailable` | The owning runner could not be reached. | Bounded retry; a volatile message may not have been delivered. |
| `PersistenceError` | Message storage failed. | Treat as infrastructure failure; do not assume the message was saved. |

## ClusterMetrics

`effect/cluster` — unstable

Standard gauges the runtime updates while running: active `entities`, `singletons`, registered `runners`, `runnersHealthy`, and acquired `shards`. Wire to a metrics exporter for cluster visibility.

## ShardingRegistrationEvent

`effect/cluster` — unstable

Events emitted by `Sharding.getRegistrationEvents` when the local runner registers an entity (`EntityRegistered`) or singleton (`SingletonRegistered`). Await at startup to confirm entities and singletons are live, or assert on them in tests.

**Wire protocol & message shapes**

## Envelope

`effect/cluster` — unstable

The transport envelopes entities exchange: a `Request` wraps a decoded payload with target address, RPC tag, request id, headers, and tracing context; `AckChunk` acknowledges streamed reply chunks; `Interrupt` cancels an in-flight request. Includes JSON codecs and storage primary-key helpers.

## Message

`effect/cluster` — unstable

The message shapes moved through the cluster, in `Incoming` and `Outgoing` variants (request, envelope, interrupt). Carries entity requests and control messages between callers, storage, transports, and handlers, with serialize/deserialize helpers matched to RPC schemas.

## Reply

`effect/cluster` — unstable

Values produced by clustered RPC execution: a final `WithExit` carrying the RPC `Exit`, or a streaming `Chunk` carrying a non-empty batch of successes. `ReplyWithContext` carries encoding services; serialization helpers move replies through storage or transport.

## DeliverAt

`effect/cluster` — unstable

A protocol for message payloads that carry their own scheduled delivery time. Implement the `DeliverAt.symbol` method to return a target `DateTime`, and durable storage will hold the message until then. The mechanism behind ClusterCron's timed runs.

**Entity helpers & durable workflows**

## EntityProxyServer

`effect/cluster` — unstable

The handler side of EntityProxy: `layerRpcHandlers(entity)` and `layerHttpApi(api, name, entity)` implement the derived RPC/HTTP operations by reading `entityId`, calling the entity client, and forwarding the payload — including the discard variants. Both layers require `Sharding` plus the entity RPCs' server-side **and client-side** schema services (`Rpc.ServicesServer` and `Rpc.ServicesClient`), because the proxy decodes the public request and then re-encodes it as an entity client. If a payload or result schema needs a service to encode or decode, provide it to the proxy layer too.

## EntityResource

`effect/cluster` — unstable

Keeps a long-lived resource alive across routine entity restarts, tied to an entity address. `make({ acquire, idleTimeToLive })` wraps it with a close scope that survives passivation; `makeK8sPod` manages a pod. Pairs with `Entity.keepAlive`.

## ClusterWorkflowEngine

`effect/cluster` — unstable

Runs durable `Workflow` executions on top of cluster sharding and message storage. Adapts `WorkflowEngine` so executions, activities, deferred completions, resumes, interrupts, and durable clock wakeups all become persisted cluster entity messages — durable, distributed orchestration for multi-step workflows. Provide its `layer` to back a workflow runtime with the cluster.

- **Its entities passivate after a fixed ten seconds.** Workflow and durable-clock entities ignore `entityMaxIdleTime`: a completed or suspended execution releases its residency slot quickly and is rebuilt from storage when its next message arrives. Do not keep process-local state in a workflow body and expect it to survive a suspension.
- **A transient interrupt is an abandoned attempt, not a failure.** When the owning runner shuts down or loses the shard, the run stops with nothing persisted, without compensation and without resuming a parent, and replays on the next owner.
- **Deferred completions survive a handover.** A `DurableDeferred` completion that reaches a new owner before its first local run of the execution is retained for that run, and the wake-up waits until the current run's reply is persisted, so a completion racing a shard move is not lost. See [DurableDeferred](workflows-durable-execution#durabledeferred).
- **Residency applies to workflows too.** Each running execution occupies an entity slot, so size `maxResidentEntities` for the number of executions a runner may have active at once.

> **Tip:** Use cluster entities when work is naturally addressed to a sharded identity and needs single-runner ownership. For the workflow definition, activity, retry, and durable-clock model that `ClusterWorkflowEngine` distributes, continue with [Workflows & Durable Execution](workflows-durable-execution).
