# EventLog & Event Sourcing

Event sourcing stores immutable facts (decisions that happened) in an append-only log and derives current state by replaying them. The `effect/eventlog` modules provide schema-typed events, a durable journal, handlers that fold events into projections, and a sync protocol (optionally end-to-end encrypted) for multi-device convergence.

> **Note:** **Event** + **EventGroup** define the contract: schema-typed events grouped together. **EventLog** is the runtime you write through — runs the matching handler, then commits to the journal. **EventJournal** (and **SqlEventJournal**) is the storage layer. **EventLogRemote** connects a local log to a server; **EventLogServer** (with **Encrypted**/**Unencrypted** variants, backed by **SqlEventLogServer***) is that server; **EventLogEncryption** provides end-to-end encryption; **EventLogSessionAuth** handles identity; **EventLogMessage** is the wire protocol.

## Event

`effect/eventlog` — unstable

`Event.make({ tag, primaryKey, payload, success, error })` defines one kind of fact. `tag` is the stable identifier; `primaryKey` extracts the aggregate/entity id from the decoded payload; `payload`, `success`, and `error` are Schemas. The payload Schema drives the `SchemaBinary` encoding (`event.payloadSchemaBinary`) used for journal entries and replication, so the payload schema is a persisted wire contract: evolve it compatibly.

An `Event` is the durable contract shared by writers, handlers, the journal, and remote replicas. `primaryKey` groups related events for projection and compaction. Events are typically created via `EventGroup.empty.add(...)` rather than `make` directly.

```ts
import { Schema } from "effect"
import { Event } from "effect/eventlog"

// A single fact: "a merit raise was approved for an employee".
const RaiseApproved = Event.make({
  tag: "RaiseApproved",
  payload: Schema.Struct({ employeeId: Schema.String, newSalary: Schema.BigDecimal }),
  primaryKey: (p) => p.employeeId // groups all comp events for one employee
})
```

> **Tip:** `Event.addError(event, schema)` widens an event's error channel by unioning in another error schema.

Use `Event` when naming an atomic, immutable recorded decision with a payload, an entity key, and typed handler outcomes.

## EventGroup

`effect/eventlog` — unstable

A collection of related events forming a contract. Start from `EventGroup.empty` and chain `.add({ tag, primaryKey, payload, ... })` per event. Pure description — no writes, no execution — handed to `EventLog.schema` (to build a writer) and `EventLog.group` (to attach handlers). Tracks every event's tag and payload at the type level, enabling exhaustive handler checking.

```ts
import { Schema } from "effect"
import { EventGroup } from "effect/eventlog"

// A bounded context: every compensation decision we record for an employee.
export const CompEvents = EventGroup.empty
  .add({
    tag: "RaiseApproved",
    payload: Schema.Struct({ employeeId: Schema.String, newSalary: Schema.BigDecimal }),
    primaryKey: (p) => p.employeeId
  })
  .add({
    tag: "GrantIssued",
    payload: Schema.Struct({ employeeId: Schema.String, shares: Schema.Natural }),
    primaryKey: (p) => p.employeeId
  })
  .add({
    tag: "BandChanged",
    payload: Schema.Struct({ employeeId: Schema.String, level: Schema.String }),
    primaryKey: (p) => p.employeeId
  })
```

> **Note:** `EventGroup.empty.addError(schema)` adds an error schema to every event in the group at once.

Use `EventGroup` to define the full set of events a feature or aggregate can emit as one typed contract.

## EventLog

`effect/eventlog` — unstable

The runtime service you write events through. Stitches together event groups, handlers, a journal, a local identity, optional remote replicas, and reactivity hooks. `EventLog.schema(...groups)` builds the typed writer contract; `EventLog.group(group, (handlers) => ...)` registers handlers; `EventLog.layer(schema, handlersLayer)` assembles the runtime.

Writing is handler-first: `log.write({ schema, event, payload })` runs the matching handler first, and the journal entry is committed only if the handler succeeds. Handlers update projections; a failed projection means the decision is not recorded. Atomicity between projection work and journal insertion depends on the backend and services used by the handler: `SqlEventJournal` wraps the operation in the `SqlClient` transaction, whereas the IndexedDB journal runs the arbitrary handler before a separate IndexedDB write. Get a typed write function with `EventLog.makeClient(schema)` — it takes one `{ event, payload }` object — or call `log.write` on the service directly. `log.writeMany` (and `EventJournal.writeMany`) writes a batch of local events under one lock, one handler transaction, and one journal commit; within a process, clock-based entry ids are strictly ascending.

> **Migration:** The function returned by `EventLog.makeClient` used to take positional `(event, payload)` arguments; call it with `client({ event: "RaiseApproved", payload })` instead.

```ts
import { BigDecimal, Effect, Layer, Ref, Schema } from "effect"
import { EventGroup, EventJournal, EventLog, EventLogEncryption } from "effect/eventlog"

// 1. The contract.
const CompEvents = EventGroup.empty.add({
  tag: "RaiseApproved",
  payload: Schema.Struct({ employeeId: Schema.String, newSalary: Schema.BigDecimal }),
  primaryKey: (p) => p.employeeId
})
const schema = EventLog.schema(CompEvents)

// 2. Handlers — run before the entry commits; this is where the salary projection updates.
const handlersLayer = (salaries: Ref.Ref<ReadonlyMap<string, BigDecimal.BigDecimal>>) =>
  EventLog.group(CompEvents, (handlers) =>
    handlers.handle("RaiseApproved", ({ payload }) =>
      Ref.update(salaries, (m) => new Map(m).set(payload.employeeId, payload.newSalary))
    )
  ).pipe(Layer.provide(EventLog.layerRegistry))

// 3. Assemble the runtime: schema + handlers + a journal + an identity.
const logLayer = (salaries: Ref.Ref<ReadonlyMap<string, BigDecimal.BigDecimal>>) =>
  EventLog.layer(schema, handlersLayer(salaries)).pipe(
    Layer.provide(EventJournal.layerMemory),
    Layer.provide(
      Layer.effect(EventLog.Identity, EventLog.makeIdentity).pipe(
        Layer.provide(EventLogEncryption.layerSubtle)
      )
    )
  )

// 4. Append a comp decision, and the handler fires; the entry is now in the journal.
const program = Effect.gen(function*() {
  const log = yield* EventLog.EventLog
  yield* log.write({
    schema,
    event: "RaiseApproved",
    payload: { employeeId: "emp-1", newSalary: BigDecimal.fromStringUnsafe("185000") }
  })
  const entries = yield* log.entries
  yield* Effect.log(`audit log has ${entries.length} entries`)
})
```

> **Tip:** `EventLog.groupReactivity(group, keys)` registers reactivity invalidation keys so the `Reactivity` system can refresh queries when matching events land; invalidations are flushed once per replayed remote batch. `EventLog.groupCompaction(group, effect)` registers a compactor: during replay, entries for one primary key are folded into a single replacement entry. `EventLog.groupBatchCompaction` compacts across primary keys and makes you forward or drop undecodable entries explicitly; both give the compactor `forward(entry)` to keep an entry unchanged at its original position. `log.destroy` wipes a store.

**Replay is all-or-nothing per batch.** A remote batch's handlers run in one `EventLog.HandlerTransaction`; if an entry fails to decode or its handler fails, the batch fails and is retried rather than being committed without its projection. A conflict is a stored entry for the same event and primary key with a strictly greater id, and every journal orders conflicts by entry id, so replicas converge.

Use `EventLog` for journal-backed, transactional, local-first event-sourced recording with reactive projections.

## EventRow

`effect/eventlog/EventRow` — unstable

Mutable rows that converge across replicas, built on one event per row type with `set`, `patch`, and `remove` payloads. `EventRow.make(tag, { key, schema, error? })` returns a value to pass to `EventGroup.add`; its `set(row)`, `patch(key, fields)`, and `remove(key)` return `{ event, payload }`, which spreads into `log.write`, is an item of `writeMany`, and is the argument of a `makeClient` client. `EventRow.handler(row, { set, patch, remove })` resolves newer conflicts per top-level field (last writer wins; nested values are atomic) and calls at most one storage callback; `EventRow.compaction` drops entries that newer ones shadow.

- **Keys.** `key` names a required string-like field, or declares several fields (`{ fields: ["parentId", "id"], derive? }`) for a composite or derived key. Key fields cannot be patched; to move a row, remove it and set it again.
- **The callback contract is what makes it converge.** `set` replaces the whole row, creating it if missing; `patch` updates an existing row and does nothing if it is missing (upserting can resurrect removed rows on some replicas); `remove` is idempotent. Empty patches skip the callback but are still journaled and synced.
- **Never compact row events with `groupCompaction` or `groupBatchCompaction`** — they run before stored conflicts are read and lose writes. Use `EventRow.compaction`.
- **Schema evolution is constrained.** Replay decodes old entries with the current schema: new fields must accept absence (`Schema.withDecodingDefaultKey`), a type change must keep the encoded type, and renames, narrowing, a new required field, or a changed key break old entries.

```ts
import { Effect, Schema } from "effect"
import { EventGroup, EventLog, EventRow } from "effect/eventlog"

const Proposal = EventRow.make("proposal", {
  key: "id",
  schema: Schema.Struct({ id: Schema.String, employeeId: Schema.String, increasePct: Schema.Number })
})
const Proposals = EventGroup.empty.add(Proposal)
const schema = EventLog.schema(Proposals)

const store = new Map<string, typeof Proposal.schema.Type>()

export const ProposalsLive = EventLog.group(Proposals, (handlers) =>
  handlers.handle(
    "proposal",
    EventRow.handler(Proposal, {
      set: (row) => Effect.sync(() => store.set(row.id, row)),
      patch: (id, fields) =>
        Effect.sync(() => {
          const row = store.get(id)
          if (row !== undefined) store.set(id, { ...row, ...fields })
        }),
      remove: (id) => Effect.sync(() => store.delete(id))
    })
  ))

export const adjust = Effect.fn("adjust")(function*(id: string, increasePct: number) {
  const log = yield* EventLog.EventLog
  yield* log.write({ schema, ...Proposal.patch(id, { increasePct }) })
})
```

Use `EventRow` for local-first, editable records (drafts, settings, lists) rather than hand-written last-writer-wins events.

## EventJournal

`effect/eventlog` — unstable

The storage engine for entries. Records committed entries, exposes them for replay, publishes local changes to subscribers, and tracks per-remote sequence metadata for exchange with other journals. Ships `EventJournal.layerMemory` (in-process, ephemeral) and `EventJournal.layerIndexedDb` (persistent in the browser). The IndexedDB journal upgrades existing databases automatically: version 3 adds an `[event, primaryKey, id]` index so remote writes read only the stored entries that can conflict, and upload progress is checkpointed by insertion order, so entries imported later with older ids are still forwarded. After that upgrade, entries the remote has not confirmed may be uploaded once more.

The append-only ledger underneath `EventLog`. An `Entry` carries a time-ordered `EntryId` (UUID v7 from a hybrid logical clock), the event tag, the primary key, and `SchemaBinary`-encoded payload bytes. `writeFromRemote` imports entries from another journal and deduplicates by id, enabling convergence between peer journals.

```ts
import { Effect } from "effect"
import { EventJournal } from "effect/eventlog"

const inspect = Effect.gen(function*() {
  const journal = yield* EventJournal.EventJournal
  const entries = yield* journal.entries // every committed comp decision, in order
  return entries.map((e) => e.event)
}).pipe(Effect.provide(EventJournal.layerMemory))
```

> **Note:** Entry ids are **time-ordered** (UUID v7) and generated from a hybrid logical clock: the memory, IndexedDB, and SQL journals give every local write an id after the latest id in their store, so a local write sorts after everything already committed even when the local clock is behind (IndexedDB and SQL read that id from the store, one extra read per `writeMany`). A clock running ahead is not clamped; an imported id more than 24 hours ahead of the local `Clock` logs a warning, and a store holding an id at the end of the UUID v7 range makes local writes fail with `EventJournalError`. Remote ids (`makeRemoteIdUnsafe`) identify peer journals for sequence tracking.

**Custom journals.** An `EventJournal` implementation must also provide `entriesById` (used to skip decrypting remote entries the journal already stores), `writeMany`, and `writeRemoteAcks` (record upload acknowledgements, advancing `nextRemoteSequence` only across contiguous sequences). `writeFromRemote` hands its `effect` the whole batch with conflicts read up front, and a repeated entry within one remote delivery keeps its first copy. `withRemoteUncommited(remoteId, f)` hands `f` the **non-empty** list of entries not yet sent to that remote and returns `Option.some(result)`; when nothing is uncommitted, `f` is not called and the result is `Option.none()`. A custom `EventJournal` implementation must keep that contract (the sync loop relies on it to skip empty remote writes), advance the remote cursor only when `f` succeeds, and fail with exactly the error `f` failed with.

Use `layerMemory` for tests, `layerIndexedDb` for offline clients, or `SqlEventJournal` on a server.

## EventLogEncryption

`effect/eventlog` — unstable

The crypto service for end-to-end-encrypted replication. Encrypts local journal entries into remote batches, decrypts incoming encrypted changes, hashes byte data, and generates event-log identities. `EventLogEncryption.layer` builds it from the `effect/crypto` `Aead`, `Digest`, and `SecureRandom` services in context (so Node apps can use the `NodeCrypto` layers); `EventLogEncryption.layerSubtle` supplies the Web Crypto layers on the `WebCrypto` reference (browsers, Node, edge).

Enables syncing through a backend that never sees plaintext. Keys are derived from the local `EventLog.Identity` (public key plus redacted private-key material); the server stores ciphertext keyed by public key and only the owning devices can decrypt. `EventLog.makeIdentity` uses this service to mint a fresh identity.

```ts
import { Effect } from "effect"
import { EventLogEncryption } from "effect/eventlog"

const roundTrip = Effect.gen(function*() {
  const enc = yield* EventLogEncryption.EventLogEncryption
  const identity = yield* enc.generateIdentity
  // Batches authenticate the store id and their plaintext entry ids.
  const batches = yield* enc.encrypt(identity, "comp-audit", entries)
  // ...ship ciphertext to the comp server; only this HRBP's devices can decrypt it...
  return { batches: batches.length, entries: batches.reduce((n, b) => n + b.entryIds.length, 0) }
}).pipe(Effect.provide(EventLogEncryption.layerSubtle))

declare const entries: ReadonlyArray<import("effect/eventlog").EventJournal.Entry>
```

> **Deployment warning:** Entries are encrypted in batches of up to 100 entries or about 256 KB of payload — one AES-GCM call per `EncryptedBatch` `{ entryIds, iv, encryptedBatch }` — and encrypted servers store and stream those batches. This replaced the per-entry `EncryptedEntry` format without migration: upgrade encrypted clients and servers together, and start encrypted servers on **fresh storage**, because existing per-entry rows are not read. Existing identities and derived signing keys are unchanged.

> **Migration:** `EncryptedEntry` / `EncryptedRemoteEntry` became `EncryptedBatch` / `EncryptedRemoteBatch`, `WriteEntries.encryptedEntries` became `batches`, `encrypt` / `decrypt` take the store id, and `EventLogEncryption.sha256String` is gone — use `digest.digestHex(Digest.sha256, bytes)` from `effect/crypto/Digest`.

Use `layerSubtle` with the encrypted remote/server pair when the sync server is untrusted and data must stay private.

## EventLogRemote

`effect/eventlog` — unstable

The client that connects a local event log to a remote replica. Writes local entries to a server, streams remote changes back from a given sequence number, and waits for local identity authentication. Two constructors: `EventLogRemote.makeEncrypted` / `layerEncrypted` (browser/edge, untrusted network) and `makeUnencrypted` / `layerUnencrypted` (trusted transports or tests).

Runs a background sync loop: push new local entries, pull new remote ones (via `writeFromRemote`), keeping journals converging. Encrypted mode encrypts before sending and decrypts on receive using `EventLogEncryption`, skipping entries the local journal already stores. The server **acknowledges** writes instead of echoing them back to the writing connection, and a reconnect resumes from the journal's current sequence. Chunked writes keep up to four parts in flight.

> **Deployment warning:** The acknowledgement protocol is a breaking wire change: upgrade clients and servers together; mixed versions are unsupported.

**Encrypted remote compaction.** When the encrypted server's `Storage` provides compaction (`SqlEventLogServerEncrypted.layerStorage({ compaction })` with `EventLogServerEncrypted.CompactionOptions`: `grace` 30 days, `lag` 24 hours, `stageTtl` 10 minutes, `thresholdFloor` 1,000 entries, `sweepInterval` 1 hour), the server advertises it in its hello response and an encrypted client compacts on the server's behalf — the server still never sees plaintext. `EventLogRemote.layerEncryptedWith({ compaction: false })` builds a client that never calls the compaction RPCs.

```ts
import { Layer } from "effect"
import { EventLogRemote } from "effect/eventlog"

// Add an end-to-end-encrypted sync replica for the comp audit log.
// layerEncrypted bundles the Web Crypto encryption layer internally, so you
// only supply an RpcClient.Protocol transport (HTTP/WebSocket) and the Registry.
// Use layerEncryptedWith({ compaction: false }) to opt out of remote compaction.
const SyncLayer = EventLogRemote.layerEncrypted
```

> **Warning:** The remote authenticates before writing — see [`EventLogSessionAuth`](#eventlogsessionauth). Writes wait until the challenge/response completes, so a client can be offline for an extended session and resync cleanly on reconnect.

**Failure handling in the sync loop.**

| Failure | What the runtime does |
| --- | --- |
| A remote write fails transiently (network drop, server restart) | Retried until it succeeds, on `Schedule.min([exponential(200 ms, ×1.5), spaced(10 s)])` — so the delay grows but never exceeds ten seconds. Pending local entries stay uncommitted for that remote and are sent after recovery. |
| The change stream from the remote ends or fails | Logged, then re-subscribed on the same schedule from the next unseen remote sequence. |
| The server answers a write or a change subscription with `Forbidden` (for example a server restart dropped the session binding) | The cached authentication is invalidated, the hello/authenticate handshake runs again, and the operation is retried — up to five times before the error surfaces as `EventLogRemoteError`. |
| Nothing is uncommitted for the remote | No write is attempted at all (`withRemoteUncommited` returns `Option.none()`). |

Remote delivery is therefore **at-least-once**: a write that reached the server but whose acknowledgement was lost is sent again. The shipped encrypted and unencrypted servers skip entry ids they already hold, so the redelivery is harmless; a custom server built on `EventLogServer.layerRpcHandlers` must de-duplicate by entry id in its `onWrite` as well.

Use `EventLogRemote` when a client needs to sync a local event log to a central server while remaining offline-capable.

## EventLogServer

`effect/eventlog` — unstable

Server-side handlers for the event-log remote protocol. `EventLogServer.layerRpcHandlers(options)` runs the hello/authenticate challenge flow, attaches the authenticated `EventLog.Identity` to subsequent requests, accepts single or chunked writes, and streams changes back. Also provides `EventLogServer.layerAuthMiddleware` for the auth boundary.

Protocol engine that the encrypted and unencrypted concrete servers build on. Accepts callbacks for binding a session key, handling `onWrite`, and producing a `changes` stream, wiring them to the `EventLogRemoteRpcs` contract. Typically not used directly — pick a variant below.

```ts
import { EventLogServer } from "effect/eventlog"

// The shared handlers/middleware the concrete comp servers build on:
const Auth = EventLogServer.layerAuthMiddleware
```

Use `EventLogServer` when building a custom sync server and wanting the handshake, auth, chunking, and change-streaming plumbing provided.

## EventLogServerEncrypted

`effect/eventlog` — unstable

A ready-made server that stores encrypted entries and replication metadata keyed by client public key and store id, streaming ciphertext back for the client to decrypt — plaintext is never visible server-side. `EventLogServerEncrypted.layer` mounts it over an `RpcServer.Protocol`; `layerStorageMemory` provides in-memory `Storage` for dev/tests. Use `SqlEventLogServerEncrypted` for durable storage.

SQL encrypted storage returns and publishes only newly inserted entries, so a client re-uploading a batch causes no duplicate broadcast. Custom `Storage` implementations write and stream batches, and must provide `entrySequences` (the sequence each entry was first stored at).

Use when hosting a sync endpoint that must not have access to plaintext data.

## EventLogServerUnencrypted

`effect/eventlog` — unstable

A plaintext server: accepts unencrypted batches, runs registered handlers server-side, stores entries, and streams backlog plus live changes. `EventLogServerUnencrypted.layer(schema, handlersLayer)` builds the full RPC server; supply infrastructure services `Storage` (e.g. `layerStorageMemory`), `EventLogServerAuthorization`, and `StoreMapping` (`layerStoreMappingStatic`). For trusted deployments, local dev, and tests.

Duplicate and conflict detection is indexed once per incoming batch: `Storage.entriesAfter` receives the batch as an optional third argument (custom storages that ignore it keep working) and returns `RemoteEntry` values, and SQL storage creates a `<prefix>_event_key_idx` index on startup. Inside a SQL transaction, publication waits for the outermost commit and is dropped on rollback.

During the `Authenticate` handshake, `EventLogServerAuthorization`'s identity check runs before the server resolves (or creates) the session's signing-key binding, so a rejected identity never causes a session-auth binding to be looked up or persisted on its behalf.

Use when the server is trusted and should run handlers/projections on synced events without an encryption layer.

## EventLogSessionAuth

`effect/eventlog` — unstable

Challenge-response auth for sync sessions. A peer proves control of a session signing key (Ed25519): the server issues a short-lived challenge with `makeSessionAuthChallenge`; the client signs a canonical payload (remote id + challenge + event-log public key + signing key) via `signSessionAuthPayload`; the server verifies with `verifySessionAuthenticateRequest`. Domain-separated by the `"eventlog-auth-v1"` context string.

Use when understanding or customizing how clients authenticate to an event-log server before replicating.

## EventLogMessage

`effect/eventlog` — unstable

The wire protocol shared by clients and servers. Defines branded `StoreId`s, protocol errors, the hello/authenticate handshake, remote calls for writes and changes (`WriteSingleRpc`, `WriteChunkedRpc`, `ChangesRpc`), and encrypted vs. plaintext entry message formats — bundled into the `EventLogRemoteRpcs` group with an `EventLogAuthentication` middleware. The contract `EventLogRemote` and both server variants implement.

Use when inspecting the protocol, implementing a custom transport, or debugging wire traffic.

## SqlEventJournal

`effect/eventlog` — unstable

A SQL-backed implementation of `EventJournal` on top of a `SqlClient`. `SqlEventJournal.layer(options?)` stores entries as encoded bytes and keeps per-remote sequence metadata in separate tables, giving a server or Node/SQLite program a durable journal that replays after restart. Drop-in replacement for `EventJournal.layerMemory`.

- **Driver byte types are normalized.** Entry ids and payloads decode whether the SQL driver returns a BLOB as `Uint8Array` or as a plain `ArrayBuffer`. PostgreSQL tables use `BYTEA` columns for entry and remote ids (not `UUID`); `BIGINT` timestamps decode whether the driver returns strings or bigints.

> **Upgrade note (PostgreSQL only):** Tables created before 4.0.2 used `UUID` columns for `id`, `remote_id`, and `entry_id`. These columns are not migrated automatically. Recreate the journal tables only after confirming they are empty, or externally migrate those three columns to `BYTEA` while preserving all other data.
- **Your callback's error is preserved.** A failure raised inside the `write` effect or the `withRemoteUncommited` callback comes back as that same error value in the typed channel, not wrapped in an `EventJournalError`; match on your own tags.
- **The write is transactional with the handler.** `write` and `writeMany` callbacks run in the journal transaction, so handler work that uses the same `SqlClient` commits or rolls back together with the journal insert, including on interruption. Inside an enclosing SQL transaction, local ids also sort after its uncommitted rows.
- **Large syncs stay within parameter limits.** Batch statements are split (down to the 100 parameters Durable Object SQLite allows) while still committing each batch in one transaction.
- **One row per imported entry.** The source remote of each imported entry is tracked on the entry instead of one row per entry per remote. Older journals migrate on first open (the remotes table is dropped; this needs a writable connection), and the first upload afterwards may resend unconfirmed entries, which the server treats as duplicates. The IndexedDB journal migrates to database version 2 the same way.

Use when a persistent, restart-surviving audit journal backed by Postgres, MySQL, or SQLite is needed.

## SqlEventLogServerEncrypted

`effect/eventlog` — unstable

The durable `Storage` for `EventLogServerEncrypted`, persisting ciphertext in SQL. `SqlEventLogServerEncrypted.layerStorage(options?)` requires `SqlClient` and `Digest.Digest` (from `effect/crypto/Digest`; `layerStorageSubtle` supplies the Web Crypto one) and creates tables for the server remote id, session-auth bindings, and encrypted batches, assigns stable sequence numbers, and streams changes — without the database ever seeing plaintext, since clients encrypt/decrypt. Pass `compaction` to enable encrypted remote compaction. The `insertBatchSize` option is gone, and the entry-id tables carry a sequence column, so encrypted servers need fresh storage after the batch-format change. Existing table-name encodings are unchanged.

Use when running an encrypted sync server that must survive restarts with a SQL backend.

## SqlEventLogServerUnencrypted

`effect/eventlog` — unstable

The durable `Storage` for `EventLogServerUnencrypted`, storing plaintext entries in SQL and streaming them back by store sequence. `SqlEventLogServerUnencrypted.layerStorage(options?)` creates dialect-specific tables for the server remote id, per-store sequence state, entries, and session-auth bindings. Pair with the unencrypted server layer for a trusted, restart-proof deployment.

Use when running a trusted plaintext sync server requiring SQL-backed durability.

> **Tip:** Client setup: define `EventGroup`s, build an `EventLog` over `EventJournal.layerIndexedDb`, register handlers that fold events into projections, wire `EventLog.groupReactivity` for live UI updates, add `EventLogRemote.layerEncrypted` to sync. Server setup: stand up `EventLogServerEncrypted.layer` backed by `SqlEventLogServerEncrypted.layerStorage`, using the same `EventLogMessage` protocol and `EventLogSessionAuth`. Result: each client writes offline to its own journal and converges through an end-to-end-encrypted server that never reads plaintext entries.
