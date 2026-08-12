# Platform & Runtime Hosts

Effect's platform layer separates service interfaces (in the core `effect` package, runtime-agnostic) from concrete implementations (provided as a Layer from `@effect/platform-node`, `@effect/platform-bun`, `@effect/platform-deno`, or `@effect/platform-browser`). Business logic imports only from `effect/*`; only the entrypoint imports the platform package. Swapping the Layer swaps the runtime.

## FileSystem

`effect/FileSystem` — stable

Service interface for filesystem operations: read, write, stat, copy, move, delete, make directories, create temp paths, stream bytes, watch for changes. Discrete operations return an `Effect` failing with `PlatformError` (`BadArgument` or `SystemError` carrying the OS reason); `stream` and `watch` expose that failure through a `Stream`.

Mental model: typed composable wrapper over `node:fs/promises`, working identically on Bun. Business modules import from `effect/FileSystem`; the entrypoint imports `NodeFileSystem.layer`. Use `FileSystem.layerNoop` to stub in tests.

Common methods: `readFileString` / `writeFileString` (text), `readFile` / `writeFile` (`Uint8Array`), `exists`, `stat`, `makeDirectory`, `copy`, `remove`, `stream` (lazy byte `Stream`, configurable chunk size), and `glob(pattern, { root, exclude })`. `watch(path)` observes direct children by default; pass `{ recursive: true }` for subdirectories. Scoped helpers `makeTempDirectoryScoped` and `makeTempFileScoped` auto-clean on scope close. An opened `File` is the public handle type; its `seek(offset, from)` returns the new branded `FileSystem.Size` offset (there is no longer a public `FileDescriptor` type).

**Size helpers.** `FileSystem.Size`, `FileSystem.KiB`, `FileSystem.MiB`, `FileSystem.GiB`, `FileSystem.TiB`, `FileSystem.PiB` produce branded `bigint` values accepted by `truncate` and compared against `File.Info.size`.

```ts
import { FileSystem } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"

// Read a comp-bands CSV and stream large files in chunks
const loadCompBands = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem

  // Load the comp-bands definition for this merit cycle
  const csv = yield* fs.readFileString("./data/comp_bands.csv")
  const bands = csv.split("\n").slice(1).map((row) => {
    const [level, min, mid, max] = row.split(",")
    return { level, min: Number(min), mid: Number(mid), max: Number(max) }
  })

  // Write a lock file so a second process knows the import is running
  const lockExists = yield* fs.exists("./data/.import.lock")
  if (!lockExists) {
    yield* fs.writeFileString("./data/.import.lock", `started:${new Date().toISOString()}`)
  }

  // Stat the full employee dump — stream it if it's large
  const info = yield* fs.stat("./data/employees.bin")
  if (info.size > FileSystem.MiB(100)) {
    yield* Effect.log("large employee dump, streaming instead")
    const bytes = fs.stream("./data/employees.bin", { chunkSize: FileSystem.KiB(64) })
    yield* bytes.pipe(Stream.runDrain)
  }

  // Scoped temp file for an in-progress export — deleted automatically
  const tmp = yield* fs.makeTempFileScoped({ prefix: "merit-export-" })
  yield* fs.writeFileString(tmp, JSON.stringify(bands))
  yield* Effect.log(`staged comp bands at: ${tmp}`)

  return bands
})

// Entrypoint wires in the Node implementation
const program = loadCompBands.pipe(
  Effect.provide(NodeFileSystem.layer),
  // ... NodeRuntime.runMain
)
```

`fs.watch(path)` returns a `Stream<WatchEvent>` whose tags are `Create`, `Update`, and `Remove`. Watching is host-dependent and may fail with `PlatformError`; a platform layer supplies the `FileSystem.WatchBackend`.

When to use: any filesystem I/O in an Effect program. Use `FileSystem.layerNoop` to stub in unit tests.

## Path

`effect/Path` — stable

Service interface wrapping platform path utilities: `join`, `resolve`, `dirname`, `basename`, `extname`, `normalize`, `relative`, `isAbsolute`, `parse`, `format`, plus effectful `fromFileUrl` and `toFileUrl` helpers. The `sep` property gives the platform separator.

Mental model: `node:path` as a service. Core `Path.layer` deliberately provides POSIX semantics. On Node/Bun/Deno, the aggregate host layer supplies the host-aware implementation; Node also exposes `NodePath.layerPosix` and `NodePath.layerWin32` for cross-platform tooling and tests.

```ts
import { FileSystem, Path } from "effect"
import { Effect } from "effect"

// Build an export file path for this merit cycle's raise recommendations
const buildExportPath = Effect.fn("buildExportPath")(
  function*(cycleId: string, outputDir: string) {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem

    // Ensure the output directory exists
    yield* fs.makeDirectory(outputDir, { recursive: true })

    // Compose a timestamped CSV path: <outputDir>/merit-<cycleId>-raises.csv
    const filename = `merit-${cycleId}-raises.csv`
    const fullPath = path.join(outputDir, filename)

    yield* Effect.log(`export path: ${fullPath}`)
    return fullPath
  }
)
```

`fromFileUrl` and `toFileUrl` are effectful because malformed or unsupported URLs fail with `PlatformError.BadArgument`; use them instead of slicing `file:` strings by hand.

When to use: building or decomposing file paths inside an Effect. Inject via service rather than calling `path.join` directly so tests can control path logic.

## Terminal

`effect/Terminal` — stable

Interactive terminal I/O: query dimensions (`columns`, `rows`), read a line (`readLine`), receive a stream of key events (`readInput`), display text (`display`). Input reading fails with `QuitError` on Ctrl+C or Ctrl+D.

Mental model: the abstraction `@effect/cli` builds on. Provide a fake terminal in tests via `Terminal.make` to assert output and simulate input without a real TTY.

```ts
import { Terminal } from "effect"
import { Effect } from "effect"

// Interactive CLI prompt for confirming a merit cycle run
const confirmMeritRun = Effect.gen(function*() {
  const terminal = yield* Terminal.Terminal
  yield* terminal.display("Confirm merit cycle run? [y/N] ")
  const answer = yield* terminal.readLine
  if (answer.toLowerCase() !== "y") {
    yield* Effect.log("Aborted by user.")
    return false
  }
  yield* terminal.display("Starting merit cycle processing...\n")
  return true
})
// QuitError surfaces if user hits Ctrl+C — handle or let it propagate
```

When to use: CLIs, interactive prompts, or TUI-adjacent tools requiring testable platform-independent I/O.

## Stdio

`effect/Stdio` — stable

Lower-level counterpart to `Terminal`: `process.argv` via `args`, write `Sink`s for stdout and stderr (accepting `string | Uint8Array`), raw byte `Stream` for stdin, and `stdinIsTerminal` / `stdoutIsTerminal` effects for adapting output to pipes versus TTYs. I/O can fail with `PlatformError`. `Stdio.layerTest` lets you stub any field for unit testing.

Mental model: where `Terminal` is for interactive programs, `Stdio` is for pipeable Unix-filter style tools — read stdin, write stdout, parse argv.

```ts
import { Stdio } from "effect"
import { Effect, Stream } from "effect"

// A pipeable tool that accepts NDJSON employee records on stdin
// and echoes validated records to stdout
const validateEmployeeStream = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args         // ReadonlyArray<string>
  const interactive = yield* stdio.stdoutIsTerminal
  yield* Effect.log(`argv: ${args.join(" ")}`)
  yield* Effect.log(`stdout is ${interactive ? "interactive" : "redirected"}`)

  // Pipe stdin → decode text → validate → stdout
  yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.map((chunk) => chunk.trim()),
    Stream.filter((line) => line.length > 0),
    Stream.run(stdio.stdout())
  )
})
```

When to use: streaming CLI tools, stdin byte processing, or typed argv access without globals.

## Crypto

`effect/Crypto` — stable

Platform-agnostic cryptographic primitives backed by the host's secure RNG: `randomBytes`, `digest` (SHA-1/256/384/512), `randomUUIDv4`, `randomUUIDv7`, `randomInt`, `randomBetween`, `randomIntBetween`, `randomBoolean`, `randomShuffle`. Sync-named variants are still `Effect`s — call with `yield*`.

Mental model: CSPRNG-backed replacement for `Math.random()` and `crypto.randomUUID()`, injected through a service. Provide a deterministic fake via `Crypto.make` for testing.

Digest operations take a `Uint8Array` and return a `Uint8Array`. Convert to hex manually (`Buffer.from(hash).toString("hex")`) — the service stays minimal by design.

```ts
import { Crypto, Effect } from "effect"
import { NodeServices } from "@effect/platform-node"

// Hash an employee national ID for pseudonymous storage in the equity ledger
const hashNationalId = Effect.fn("hashNationalId")(
  function*(employeeId: string, nationalId: string) {
    const crypto = yield* Crypto.Crypto

    // Stable time-ordered UUID for the ledger entry PK
    const grantId = yield* crypto.randomUUIDv7

    // SHA-256 hash of the national ID for pseudonymous cross-referencing
    const encoder = new TextEncoder()
    const hash = yield* crypto.digest("SHA-256", encoder.encode(nationalId))
    const hex = Buffer.from(hash).toString("hex")

    yield* Effect.log(`employee=${employeeId} grantId=${grantId} idHash=${hex.slice(0, 8)}...`)
    return { grantId, nationalIdHash: hex }
  }
)

const program = hashNationalId("emp-001", "123-45-6789").pipe(
  Effect.provide(NodeServices.layer)
)
```

When to use: secure randomness, UUIDs, or hashing inside an Effect with testable, non-global injection.

## Socket

`effect/unstable/socket/Socket` — unstable

Platform-neutral abstraction for a bidirectional socket (TCP, Unix domain, or WebSocket). A `Socket` exposes three run modes — `run` (binary `Uint8Array` handler), `runString` (text handler), `runRaw` (either) — and a scoped `writer` sending `Uint8Array | string | CloseEvent`. Typed errors: `SocketReadError`, `SocketWriteError`, `SocketOpenError`, `SocketCloseError`, all wrapped in `SocketError`.

Mental model: a duplex channel run in a fiber. The run loop drives incoming messages; outbound writes go via the scoped writer. Adapt to an Effect `Channel` via `Socket.toChannel` for stream/channel combinator integration.

WebSockets: `Socket.makeWebSocket(url)` creates a `Socket` from a URL; `Socket.layerWebSocket(url)` provides it as a service. A `WebSocketConstructor` service controls the underlying constructor (inject `ws` in Node, use the global in browsers).

TCP in Node: use `NodeSocket.layerNet(opts)` where `opts` is a `Net.NetConnectOpts` object (e.g., `{ host, port }`). There is no `layerTCP` export.

```ts
import { Socket } from "effect/unstable/socket"
import { NodeSocket } from "@effect/platform-node"
import { Effect } from "effect"

// Connect to the payroll service over TCP and send a sync trigger
const triggerPayrollSync = Effect.gen(function*() {
  const socket = yield* Socket.Socket

  // Acquire the scoped writer — closed when the scope ends
  const write = yield* socket.writer

  // Start reading acknowledgements in the background
  yield* socket.runString((msg) =>
    Effect.log(`payroll ack: ${msg}`)
  ).pipe(Effect.forkChild)

  yield* write(`SYNC:merit-cycle-2025\n`)
  yield* Effect.sleep("1 second")
  yield* write(new Socket.CloseEvent(1000, "done"))
}).pipe(
  // NodeSocket.layerNet — correct name; no layerTCP exists
  Effect.provide(NodeSocket.layerNet({ host: "127.0.0.1", port: 4000 })),
  Effect.scoped
)
```

When to use: typed Effect-native TCP or WebSocket communication over a persistent connection.

## SocketServer

`effect/unstable/socket/SocketServer` — unstable

Server-side counterpart to `Socket`. The `SocketServer` service exposes: `address` (bound `TcpAddress | UnixAddress`) and `run(handler)` — a never-ending Effect that accepts connections and passes each as a `Socket.Socket` to the handler. Errors are `SocketServerError` with reason `SocketServerOpenError | SocketServerUnknownError`.

Mental model: provide a handler; the server calls it concurrently per accepted connection. Each handler gets a fresh `Socket` whose scope closes when the handler completes. `NodeSocketServer.layer({ port: 4000 })` wires up a Node TCP server; `NodeSocketServer.layerWebSocket({ port: 8080 })` wires up a WebSocket server backed by `ws`.

```ts
import { SocketServer } from "effect/unstable/socket"
import { NodeSocketServer } from "@effect/platform-node"
import { Effect } from "effect"

// A small HRIS push-notification server: echo events back with a prefix
const hrisNotificationServer = Effect.gen(function*() {
  const server = yield* SocketServer.SocketServer
  const addr = server.address as { port: number }
  yield* Effect.log(`HRIS push server listening on port ${addr.port}`)

  return yield* server.run((socket) =>
    socket.runString((msg) =>
      Effect.gen(function*() {
        // socket.writer is a scoped Effect — acquire it inside the handler scope
        const write = yield* socket.writer
        yield* write(`ACK:${msg}`)
      })
    )
  )
}).pipe(
  Effect.provide(NodeSocketServer.layer({ port: 4000 })),
  Effect.scoped
)
```

When to use: accepting TCP or WebSocket connections — custom protocols, push event relays, or bidirectional streaming pipelines.

## Worker

`effect/unstable/workers/Worker` — unstable

Parent-side API for communicating with a worker thread or IPC child process. A `Worker<O, I>` provides: `send(message: I)` — fire a typed message into the worker; `run(handler)` — a never-completing Effect calling the handler for each emitted `O`. Errors are `WorkerError`.

Mental model: typed bidirectional channel where `I` flows in and `O` flows out. The parent buffers sends until the worker signals readiness, then drains the queue.

Setup: call `NodeWorker.layer(spawnFn)` to provide both `WorkerPlatform` and `Spawner`; acquire a typed `Worker` via `WorkerPlatform.spawn(id)`. The spawn function receives a numeric ID and returns a `WorkerThreads.Worker` or IPC `ChildProcess`.

```ts
import { Worker } from "effect/unstable/workers"
import { NodeWorker } from "@effect/platform-node"
import { Effect } from "effect"
import * as WorkerThreads from "node:worker_threads"

// Parent side: dispatch vesting-schedule computations to worker threads
// Each message is an EquityGrant; workers reply with vestedShares count
const workerLayer = NodeWorker.layer(
  (id) => new WorkerThreads.Worker(new URL("./vesting-worker.js", import.meta.url))
)

const computeVestedSharesInParallel = Effect.gen(function*() {
  const platform = yield* Worker.WorkerPlatform
  // Spawn a typed Worker: output = number (vestedShares), input = EquityGrant id
  const worker = yield* platform.spawn<number, string>(0)

  // Send a grant ID; the worker replies with vestedShares
  yield* worker.send("grant-2024-001")

  return yield* worker.run((vestedShares) =>
    Effect.log(`vested shares computed: ${vestedShares}`)
  )
}).pipe(
  Effect.scoped,
  Effect.provide(workerLayer)
)
```

When to use: offloading CPU-heavy computation to a worker thread while retaining typed error handling and structured concurrency.

## WorkerRunner

`effect/unstable/workers/WorkerRunner` — unstable

Worker-side counterpart to `Worker`. A `WorkerRunner<O, I>` listens for `I` messages from the parent (tagged by port ID), calls the handler, and sends `O` replies via `send(portId, message)` or `sendUnsafe`. The optional `disconnects` queue notifies when a port closes.

Mental model: if `Worker` is the client, `WorkerRunner` is the server. Write the worker's main function by yielding the `WorkerRunnerPlatform` service and calling `platform.start()`, then provide the platform layer from `NodeWorkerRunner.layer`.

```ts
// vesting-worker.ts — runs inside the worker thread
import { WorkerRunner } from "effect/unstable/workers"
import { NodeWorkerRunner } from "@effect/platform-node"
import { Effect } from "effect"

// Receive a grant ID, compute vested shares, reply to parent
const runner = Effect.gen(function*() {
  const platform = yield* WorkerRunner.WorkerRunnerPlatform
  // start<O, I>() — O is what we send back, I is what we receive
  const workerRunner = yield* platform.start<number, string>()

  yield* workerRunner.run((portId, grantId) =>
    Effect.gen(function*() {
      // CPU-bound vesting math
      const vestedShares = computeVested(grantId)
      yield* workerRunner.send(portId, vestedShares)
    })
  )
}).pipe(
  Effect.provide(NodeWorkerRunner.layer),
  Effect.runFork
)

function computeVested(grantId: string): number {
  // ... real vesting schedule math here
  return 1000
}
```

When to use: writing the worker-thread side of a Worker/WorkerRunner pair.

## WorkerError

`effect/unstable/workers/WorkerError` — unstable

Typed error union for worker communication. `WorkerError` wraps one of four reasons: `WorkerSpawnError` (worker failed to start), `WorkerSendError` (message serialization failed), `WorkerReceiveError` (message decode failed), `WorkerUnknownError` (anything else). Catch with `Effect.catchTag("WorkerError", ...)`.

## Transferable

`effect/unstable/workers/Transferable` — unstable

Zero-copy worker message delivery. Annotate schema fields with `Transferable.schema`; the `Transferable.Collector` service collects the backing `ArrayBuffer`, `MessagePort`, or `ImageData` buffer and passes it as the `postMessage` transfer list — no structured-clone copy. Essential for large binary payloads between parent and worker at native speed.

## ChildProcess

`effect/unstable/process/ChildProcess` — unstable

Value type describing a command to run — a typed `ProcessBuilder`. Use `ChildProcess.make(cmd, args, options)` to create a `StandardCommand`, or chain two commands with `ChildProcess.pipeTo` to create a `PipedCommand` (shell `|` equivalent). Modifiers: `setEnv`, `setCwd`, `prefix`.

Mental model: a `Command` is pure data describing what to run. Nothing executes until passed to a `ChildProcessSpawner`. Commands are composable and trivially testable. On Windows, the Node spawner hides the child console/GUI window by default unless the command is detached; set `windowsHide: false` explicitly when a visible window is intended. The option has no effect on other hosts.

```ts
import { ChildProcess } from "effect/unstable/process"

// Describe a payroll-export command (pure data, nothing runs yet)
const payrollExportCmd = ChildProcess.make("payroll-cli", ["export", "--format=csv"])

// Pipe pipeline: export payroll data and sign it
const signedExport = ChildProcess.make("payroll-cli", ["export", "--format=csv"]).pipe(
  ChildProcess.pipeTo(ChildProcess.make("gpg", ["--sign", "--armor"]))
)

// Override environment for a production payroll run
const prodExportCmd = ChildProcess.make("payroll-cli", ["export"]).pipe(
  ChildProcess.setEnv({ PAYROLL_ENV: "production", DB_HOST: "prod-db.internal" }),
  ChildProcess.setCwd("/app/payroll")
)
```

When to use: composing commands before running them, separating command description from execution.

## ChildProcessSpawner

`effect/unstable/process/ChildProcessSpawner` — unstable

Service that executes `ChildProcess.Command` values.

Key APIs: spawner.string(cmd), spawner.lines(cmd), spawner.spawn(cmd)

`string` collects stdout as a single string. `lines` collects stdout as `Array<string>`. `spawn` returns a scoped `ChildProcessHandle` with `stdout`, `stderr`, `all` (merged) as byte `Stream`s, and `exitCode` as an Effect waiting for process completion. Exit code is a branded `ExitCode`; compare with `ChildProcessSpawner.ExitCode(0)`.

Platform implementations: `NodeServices.layer` includes `NodeChildProcessSpawner.layer`; Bun uses `BunServices.layer`.

```ts
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { NodeServices } from "@effect/platform-node"
import { Console, Data, Effect, Stream } from "effect"

class PayrollExportFailed extends Data.TaggedError("PayrollExportFailed")<{
  readonly exitCode: ChildProcessSpawner.ExitCode
}> {}

// Spawn a payroll-export child process and stream its output line by line
const runPayrollExport = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  // Collect the version string of the payroll CLI tool
  const cliVersion = yield* spawner.string(
    ChildProcess.make("payroll-cli", ["--version"])
  )
  yield* Effect.log(`payroll-cli version: ${cliVersion.trim()}`)

  // Collect which employee IDs are in the current export batch
  const batchIds = yield* spawner.lines(
    ChildProcess.make("payroll-cli", ["list-pending", "--format=ids"])
  )
  yield* Effect.log(`batch size: ${batchIds.length} employees`)

  // Stream a long-running payroll export, logging each output line
  yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(
      ChildProcess.make("payroll-cli", ["export", "--format=csv"], {
        env: { PAYROLL_ENV: "production" },
        extendEnv: true
      })
    )

    yield* handle.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Console.log(`[payroll-export] ${line}`))
    )

    const code = yield* handle.exitCode
    if (code !== ChildProcessSpawner.ExitCode(0)) {
      return yield* new PayrollExportFailed({ exitCode: code })
    }
  }))

  return batchIds
}).pipe(Effect.provide(NodeServices.layer))
```

When to use: running external tools with typed I/O, structured error handling, and streamed output.

## Platform packages

The services above are interfaces. Platform packages provide concrete Layer implementations and a `runMain` entry point.

**@effect/platform-node** — package

Implements FileSystem, Path, Terminal, Stdio, Crypto, ChildProcessSpawner, Socket, SocketServer, Worker, WorkerRunner, HTTP, Redis, cluster transports, and stream adapters using Node.js APIs. `NodeServices.layer` is deliberately narrower: it aggregates ChildProcessSpawner, Crypto, FileSystem, Path, Stdio, and Terminal. Sockets, workers, HTTP (`NodeHttpServer.layer`), and other adapters have explicit layers.

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  // ... your app
})

program.pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
```

**@effect/platform-bun** — package

Bun-native counterparts cover the same broad host responsibilities, but use `Bun*` namespaces and layers rather than promising every Node adapter is interchangeable. Like Node's aggregate, `BunServices.layer` includes ChildProcessSpawner, Crypto, FileSystem, Path, Stdio, and Terminal; HTTP, sockets, workers, Redis, and cluster adapters remain explicit.

```ts
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  // same code as the Node version
})

program.pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
```

**@effect/platform-deno** — package

The Deno host package (Deno 2.5+) covers FileSystem, Path, Crypto, Stdio, Terminal, child processes, HTTP client/server, sockets, workers, Redis, multipart parsing, key-value storage, and cluster HTTP/socket adapters. `DenoServices.layer` is the standard aggregate; specialized HTTP/socket/worker layers remain explicit. `DenoRuntime.runMain` installs structured SIGINT/SIGTERM interruption and teardown.

The Deno child-process adapter has narrower process-control semantics than Node: commands using `detached` or `additionalFds` fail as unsupported, and killing a handle terminates only the direct child, not its descendants. Design process-tree cleanup explicitly when Deno is a deployment target.

```ts
import { DenoRuntime, DenoServices } from "@effect/platform-deno"
import { Effect, FileSystem } from "effect"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString("./deno.json")
})

program.pipe(
  Effect.provide(DenoServices.layer),
  DenoRuntime.runMain
)
```

**@effect/platform-node-shared** — package

Contains implementation shared by the Node, Bun, and Deno adapters: Node-compatible Path/FileSystem/Terminal/child-process/socket/worker/Redis building blocks. It is public for adapter authors, but application entrypoints should normally depend on the host package rather than assembling these internals.

**@effect/platform-browser** — package

Browser-specific implementations: `BrowserCrypto.layer` (Web Crypto API), `BrowserSocket.layer` (native WebSocket), `BrowserWorker.layer` and `BrowserWorkerRunner.layer` (dedicated/shared workers via `postMessage`). No FileSystem or ChildProcess in browsers. Additional APIs include `Permissions`, `Clipboard`, `Geolocation`, typed DOM event streams, Fetch/XHR clients, browser persistence/key-value layers, and the typed IndexedDB subsystem below.

`BrowserRuntime.runMain` attaches a `beforeunload` listener to interrupt the root fiber on page navigation.

```ts
import { BrowserRuntime, BrowserWorker } from "@effect/platform-browser"
import { Effect } from "effect"

const app = Effect.gen(function*() {
  // browser-specific effects
})

app.pipe(
  Effect.provide(BrowserWorker.layer((id) => new Worker(new URL("./worker.js", import.meta.url)))),
  BrowserRuntime.runMain
)
```

## Browser IndexedDB

`@effect/platform-browser/IndexedDb*` — package

Five modules form a schema-aware, versioned database rather than a thin `IDBRequest` wrapper:

| Module | Responsibility |
| --- | --- |
| `IndexedDb` | `indexedDB` / `IDBKeyRange` capability service plus valid-key schemas; `layerWindow` uses browser globals. |
| `IndexedDbTable` | An object-store descriptor with a `Schema`, key path, typed index paths, auto-increment and durability metadata. Declaring an index does not create it. |
| `IndexedDbVersion` | A non-empty set of tables representing one schema version. |
| `IndexedDbDatabase` | Ordered migrations, database layer, `getQueryBuilder`, and destructive `rebuild`. |
| `IndexedDbQueryBuilder` | Schema-encoded writes and decoded reads, index/key ranges, pagination/streaming, transactions, and reactive invalidation. |

```ts
import {
  IndexedDb,
  IndexedDbDatabase,
  IndexedDbTable,
  IndexedDbVersion
} from "@effect/platform-browser"
import { Effect, Layer, Schema } from "effect"

const Todo = IndexedDbTable.make({
  name: "todo",
  schema: Schema.Struct({
    id: Schema.Int,
    title: Schema.String,
    completed: Schema.Boolean
  }),
  keyPath: "id",
  indexes: { titleIndex: "title" }
})

const V1 = IndexedDbVersion.make(Todo)

class AppDb extends IndexedDbDatabase.make(
  V1,
  Effect.fn(function*(migration) {
    yield* migration.createObjectStore("todo")
    yield* migration.createIndex("todo", "titleIndex")
  })
) {}

const program = Effect.gen(function*() {
  const db = yield* AppDb.getQueryBuilder
  yield* db.from("todo").insert({
    id: 1,
    title: "Review salary bands",
    completed: false
  })
  return yield* db.from("todo").select("titleIndex").equals("Review salary bands")
}).pipe(
  Effect.provide(
    AppDb.layer("comp-planner").pipe(Layer.provide(IndexedDb.layerWindow))
  )
)
```

Use `.add(V2, (from, to) => ...)` to preserve/copy rows while changing stores or indexes. `withTransaction({ tables, mode: "readwrite" })(effect)` aborts writes when the effect fails. Queries provide `equals`, comparison/range operators, `limit`, `offset`, `reverse`, `filter`, `first`, paged `stream`, and reactive variants; mutations expose invalidation. `rebuild` deletes and recreates the database, so data not reintroduced by migrations is lost.

**Reach for it when** a browser application needs local, typed, queryable state with deliberate migrations and transactions. For simple keys, use `BrowserKeyValueStore`; for generic persistence, `BrowserPersistence.layerIndexedDb` builds on this stack.

## Other browser capabilities

| API | What it adds |
| --- | --- |
| `Permissions.query` | Typed permission status; querying does not itself grant permission. |
| `Clipboard` | Text/blob reads and writes, subject to browser security and user-activation rules. |
| `Geolocation` | Current position and a scoped `watchPosition` stream with typed permission/timeout failures. |
| `BrowserStream` | Typed `window` and `document` event streams with automatic listener cleanup. |
| `BrowserHttpClient` | Portable Fetch layer plus an XHR escape hatch and array-buffer response mode. |
| `BrowserKeyValueStore` | LocalStorage, SessionStorage, or IndexedDB-backed key/value layers. |
| `BrowserPersistence` | The unstable Persistence abstraction backed by IndexedDB, including TTL behavior. |

> **Tip:** Browser APIs remain ordinary services and layers. At portable test boundaries, `FileSystem.layerNoop`, `Stdio.layerTest`, and a deterministic `Crypto.make(...)` implementation avoid reaching host globals.
