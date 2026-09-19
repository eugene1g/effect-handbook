# Platform & Runtime Hosts

Effect's platform layer separates service interfaces (in the core `effect` package, runtime-agnostic) from concrete implementations (provided as a Layer from `@effect/platform-node`, `@effect/platform-bun`, `@effect/platform-deno`, or `@effect/platform-browser`). Business logic imports only from `effect/*`; only the entrypoint imports the platform package. Swapping the Layer swaps the runtime.

> **Official guides:** [Introduction to Effect Platform](https://effect.website/docs/v4/platform/introduction) (its module table lists a `PlatformLogger` that `rc.116` does not ship — the function is `Logger.toFile` — and it routes Deno through `@effect/platform-node`, while `rc.116` also publishes `@effect/platform-deno`). These track Effect's `main` branch rather than the pinned `rc.116` release, so where they differ, this page and the tagged source win.

Who owns each of these runtimes, and when it is disposed, is a separate question from which Layer implements a service: see [Choosing a host](#choosing-a-host) below and [Owning Lifetimes — Startup, Readiness, and Shutdown](../deep-dives/owning-lifetimes-startup-readiness-and-shutdown).

## FileSystem

`effect/FileSystem` — stable

Service interface for filesystem operations: read, write, stat, copy, move, delete, make directories, create temp paths, stream bytes, watch for changes. Discrete operations return an `Effect` failing with `PlatformError` (`BadArgument` or `SystemError` carrying the OS reason); `stream` and `watch` expose that failure through a `Stream`.

Mental model: typed composable wrapper over `node:fs/promises`, working identically on Bun. Business modules import from `effect/FileSystem`; the entrypoint imports `NodeFileSystem.layer`. Use `FileSystem.layerNoop` to stub in tests.

Common methods: `readFileString` / `writeFileString` (text), `readFile` / `writeFile` (`Uint8Array`), `exists`, `stat`, `makeDirectory`, `copy`, `remove`, `stream` (lazy byte `Stream`, configurable chunk size), and `glob(pattern, { root, exclude })`. `watch(path)` observes direct children by default; pass `{ recursive: true }` for subdirectories. Scoped helpers `makeTempDirectoryScoped` and `makeTempFileScoped` auto-clean on scope close. An opened `File` is the public handle type; its `seek(offset, from)` takes and returns a plain `bigint` position and rejects a negative result with `BadArgument`, leaving the cursor unchanged (there is no longer a public `FileDescriptor` type).

The service covers the whole `node:fs` surface, so reaching for raw `node:fs` costs typed errors and testability without buying an operation:

| Group | Operations |
| --- | --- |
| Whole-file I/O | `readFile`, `readFileString`, `writeFile`, `writeFileString` (both writes take `flag` and `mode`) |
| Streams and handles | `stream` (lazy bytes), `sink` (a byte `Sink`; opens with flag `"w"` unless you pass one, so use `{ flag: "a" }` to append), `open` (a scoped `File`: `read`, `readAlloc`, `write`, `writeAll`, `seek`, `truncate`, `sync`, `stat`) |
| Directories and trees | `makeDirectory` (`recursive`), `readDirectory` (`recursive`), `glob`, `copy` (like `cp -r`), `rename`, `remove` (`recursive`, `force`) |
| Single files and links | `copyFile`, `truncate`, `link`, `symlink`, `readLink`, `realPath` |
| Metadata and permissions | `exists`, `access` (`readable`, `writable`), `stat`, `chmod`, `chown`, `utimes` |
| Temporary paths | `makeTempDirectory`, `makeTempFile`, and the `…Scoped` variants that delete on scope close |
| Change notification | `watch` |

**Sizes are `ByteSize` values.** The `FileSystem.Size` brand and the `FileSystem.KiB` / `MiB` / `GiB` / `TiB` / `PiB` helpers were removed in `rc.113`. `File.Info.size` is now a stable [`ByteSize.ByteSize`](../data/functional-toolkit#bytesize) — an exact non-negative `bigint` brand — so compare it with `ByteSize.isGreaterThan` and friends rather than with `>`. `stream`'s `offset` and `bytesToRead` accept any `ByteSize.Input`; `chunkSize` and `truncate`'s `length` are plain `number`s. Optional numeric `stat` metadata that exceeds the safe-integer range is reported as `Option.none()` instead of failing the whole call. The same exact-arithmetic pass (`rc.113`) reached HTTP file responses: [`HttpPlatform`](./http-server#httpplatform) clamps a requested range to the file's size, so `Content-Length` always matches the bytes actually sent.

```ts
import { ByteSize, FileSystem } from "effect"
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
  if (ByteSize.isGreaterThan(info.size, ByteSize.mebibytes(100))) {
    yield* Effect.log(`large employee dump (${ByteSize.format(info.size, { system: "binary" })}), streaming instead`)
    const bytes = fs.stream("./data/employees.bin", { chunkSize: 64 * 1024 })
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

Official guide: [FileSystem](https://effect.website/docs/v4/platform/file-system).

### Testing without a disk

`FileSystem.layerNoop(partial)` builds a complete service from only the methods the code under test calls (`FileSystem.makeNoop(partial)` is the same object without the Layer, for `Effect.provideService`). **A forgotten override is loud, not silent:** on `rc.116` most defaults fail with a typed `PlatformError` whose reason is `NotFound`; `makeDirectory` and the `makeTemp*` family die with `not implemented`; only `exists` (answers `false`) and `remove` (succeeds) are quiet.

```ts
import { Effect, FileSystem } from "effect"

const TestFs = FileSystem.layerNoop({
  readFileString: (path) =>
    path === "./data/comp_bands.csv"
      ? Effect.succeed("level,min,mid,max\nL5,100,120,140")
      : Effect.die(`unexpected read: ${path}`)
})

const firstBand = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const csv = yield* fs.readFileString("./data/comp_bands.csv")
  return csv.split("\n")[1] // "L5,100,120,140"
}).pipe(Effect.provide(TestFs))
```

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

Official guide: [Path](https://effect.website/docs/v4/platform/path).

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

**Re-prompt by recursion, deferred with `Effect.suspend`.** A validation loop is the prompt calling itself; `suspend` makes the self-reference lazy so each retry is built only when it is needed. The error channel is the union of the two operations: `readLine` fails with `QuitError`, `display` with `PlatformError`.

```ts
import { Effect, Option, Terminal } from "effect"
import type { PlatformError } from "effect"

const parsePercent = (input: string): Option.Option<number> => {
  const value = Number(input.trim())
  return input.trim() !== "" && value >= 0 && value <= 25 ? Option.some(value) : Option.none()
}

// Ask until the answer parses. Ctrl+C / Ctrl+D ends the loop as QuitError.
const askMeritPercent: Effect.Effect<
  number,
  Terminal.QuitError | PlatformError.PlatformError,
  Terminal.Terminal
> = Effect.gen(function*() {
  const terminal = yield* Terminal.Terminal
  yield* terminal.display("Merit increase % (0-25): ")
  const answer = parsePercent(yield* terminal.readLine)
  if (Option.isSome(answer)) return answer.value
  yield* terminal.display("Enter a number between 0 and 25.\n")
  return yield* Effect.suspend(() => askMeritPercent)
})
```

A small script does not need the whole aggregate: `NodeTerminal.layer` (or `BunTerminal.layer`) provides `Terminal` alone.

When to use: CLIs, interactive prompts, or TUI-adjacent tools requiring testable platform-independent I/O.

Official guide: [Terminal](https://effect.website/docs/v4/platform/terminal).

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

Platform-agnostic cryptographic primitives backed by the host's secure RNG: `randomBytes`, `digest` (SHA-1/256/384/512), `randomUUIDv4`, `randomUUIDv7`, `randomULID`, `randomInt`, `randomBetween`, `randomIntBetween`, `randomBoolean`, `randomShuffle`. Sync-named variants are still `Effect`s — call with `yield*`.

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

`crypto.randomULID` (`rc.116`) returns a 26-character, uppercase Crockford base32 ULID: 10 characters of millisecond timestamp from the current `Clock`, then 80 secure random bits. ULIDs sort by creation time across milliseconds, with no ordering within one millisecond, and because the timestamp comes from `Clock`, a `TestClock` pins the prefix in tests. Reach for it when an identifier must be time-sortable and shorter than a UUID in URLs or file names (payroll-run exports, say); `randomUUIDv7` gives the same ordering in a `uuid` column.

When to use: secure randomness, UUIDs, or hashing inside an Effect with testable, non-global injection.

## Socket

`effect/unstable/socket/Socket` — unstable

Platform-neutral abstraction for a bidirectional socket (TCP, Unix domain, or WebSocket). Since `rc.113` a `Socket` is **pull-based**: it exposes a scoped `reader` and a scoped `writer`, and nothing is read from the transport until the consumer pulls.

- `socket.reader` — acquiring it *dials the connection*; its scope owns the connection lifetime. It yields a `Reader` whose `pull` returns the next non-empty batch (one buffer for TCP, one entry per WebSocket frame) and whose `upgrade(options?)` wraps a live TCP connection in TLS (STARTTLS). `Socket.readerBytes(socket)` and `Socket.readerString(socket, encoding?)` acquire a pull already normalized to `Uint8Array` or `string`.
- `socket.writer` — acquisition cannot fail. It yields a `Writer` with `write(chunk | CloseEvent)` and `writeAll(chunks)`; both wait for the transport's native drain signal, so a slow peer backpressures the producer. Writes issued while disconnected suspend until the next connection.

Mental model: a connection is a scoped read loop. Code placed between acquiring the reader and the first `pull` runs exactly once per (re)connection, which is where a handshake belongs. A `pull` **never completes normally** — every termination, a clean close included, fails with `SocketError` wrapping a `SocketCloseError` (or `SocketReadError`, `SocketWriteError`, `SocketOpenError`, `SocketUpgradeError`). Reconnection is therefore ordinary `Effect.retry` around the scoped loop, not a special socket option.

Backpressure is end to end: TCP pauses while nobody pulls; pausable WebSockets pause at `highWaterMark` (64 KiB by default) and resume after draining. Browser WebSockets cannot pause, so they fail with `SocketReadError` when a configured `highWaterMark` is exceeded — size it for the burst you expect.

WebSockets: `Socket.makeWebSocket(url)` creates a `Socket` from a URL; `Socket.layerWebSocket(url)` provides it as a service. A `WebSocketConstructor` service controls the underlying constructor (inject `ws` in Node, use the global in browsers). Its second argument is either subprotocols or a typed `WebSocketClientOptions` (`{ headers }` for the opening handshake, e.g. an `Authorization` header): the Node and Bun constructors honor it, while the global/browser constructor throws a `TypeError`, because browsers cannot set handshake headers. `makeWebSocket` forwards only `protocols`, so to send headers call the constructor service yourself and wrap the result with `Socket.fromWebSocket`.

TCP in Node: use `NodeSocket.layerNet(opts)` where `opts` is a `Net.NetConnectOpts` object (e.g., `{ host, port }`). There is no `layerTCP` export.

```ts
import { Socket } from "effect/unstable/socket"
import { NodeSocket } from "@effect/platform-node"
import { Effect, Schedule } from "effect"

// Connect to the payroll service over TCP, send a sync trigger, log every ack.
const triggerPayrollSync = Effect.gen(function*() {
  const socket = yield* Socket.Socket

  // Acquiring the reader dials; this scope owns the connection.
  const pull = yield* Socket.readerString(socket)
  const writer = yield* socket.writer

  // Runs once per (re)connection, before the first pull: the handshake slot.
  yield* writer.write("SYNC:merit-cycle-2025\n")

  // Pull until the peer closes. The close arrives as a SocketError failure.
  while (true) {
    for (const ack of yield* pull) {
      yield* Effect.log(`payroll ack: ${ack}`)
    }
  }
}).pipe(
  Effect.scoped,
  // Every termination is a failure, so reconnecting is plain retry.
  Effect.retry({ schedule: Schedule.exponential("200 millis"), times: 5 }),
  // NodeSocket.layerNet — correct name; no layerTCP exists
  Effect.provide(NodeSocket.layerNet({ host: "127.0.0.1", port: 4000 }))
)
```

For combinator-style consumption, `Socket.toStream(socket)` is a read-only binary `Stream` backed by the same pull, and `Socket.toChannel` / `Socket.toChannelString` expose the duplex connection as a `Channel`. All three fail on close for the same reason `pull` does.

> **Warning:** `Socket.run`, `Socket.runString`, and `Socket.runRaw` were removed in `rc.113`, along with the `onOpen` callback, the close-code predicates, `SendQueueCapacity`, and `fromWebSocket`'s `onInitialRun` option. `Socket.make` now takes `{ reader, writer }`. Migrate a `run*` handler to a scoped pull loop, move `onOpen` logic to just before the first pull, and replace close-code checks with retry (or `Effect.catch` on `SocketError`) around the loop.

When to use: typed Effect-native TCP or WebSocket communication over a persistent connection.

## SocketServer

`effect/unstable/socket/SocketServer` — unstable

Server-side counterpart to `Socket`. The `SocketServer` service exposes: `address` — the bound `NetAddress.SocketAddress` (an `InetAddressV4 | InetAddressV6` with `address` and `port`, or a `UnixPathAddress` with `path`) — and `run(handler)`, a never-ending Effect that accepts connections and passes each as a `Socket.Socket` to the handler. Errors are `SocketServerError` with reason `SocketServerOpenError | SocketServerUnknownError`.

Mental model: provide a handler; the server calls it concurrently per accepted connection. Each handler gets a fresh `Socket` whose scope closes when the handler completes. An accepted socket starts **paused** and its reader attaches to the existing connection, so it cannot reconnect after close — a failed `pull` simply ends that handler. `NodeSocketServer.layer({ port: 4000 })` wires up a Node TCP server; `NodeSocketServer.layerWebSocket({ port: 8080 })` wires up a WebSocket server backed by `ws`.

```ts
import { NetAddress } from "effect/unstable/net"
import { Socket, SocketServer } from "effect/unstable/socket"
import { NodeSocketServer } from "@effect/platform-node"
import { Effect } from "effect"

// A small HRIS push-notification server: echo events back with a prefix
const hrisNotificationServer = Effect.gen(function*() {
  const server = yield* SocketServer.SocketServer
  const bound = NetAddress.isInetAddress(server.address)
    ? NetAddress.formatInet(server.address)
    : server.address.path
  yield* Effect.log(`HRIS push server listening on ${bound}`)

  return yield* server.run((socket) =>
    Effect.gen(function*() {
      const pull = yield* Socket.readerString(socket)
      const writer = yield* socket.writer
      while (true) {
        for (const msg of yield* pull) {
          yield* writer.write(`ACK:${msg}`)
        }
      }
    }).pipe(
      Effect.scoped,
      // The peer hanging up is the normal end of this connection, not a server fault.
      Effect.catchTag("SocketError", (error) => Effect.logDebug("connection closed", error))
    )
  )
}).pipe(
  Effect.provide(NodeSocketServer.layer({ port: 4000 })),
  Effect.scoped
)
```

The bound address and every accepted peer address are [`NetAddress`](#netaddress) values rather than strings.

When to use: accepting TCP or WebSocket connections — custom protocols, push event relays, or bidirectional streaming pipelines.

## NetAddress

`effect/unstable/net/NetAddress` — unstable (new in `rc.113`)

Pure, platform-neutral **values** for network addresses: `Ipv4Address` / `Ipv6Address` (`IpAddress`), `MacAddress`, internet socket addresses `InetAddressV4` / `InetAddressV6` (`InetAddress`, an IP plus a port), and `UnixPathAddress`. `SocketAddress = InetAddress | UnixPathAddress` is what `SocketServer.address` and `HttpServer.address` now report. Every value implements `Equal` and `Hash`, so addresses work as `HashMap` keys and compare structurally.

Mental model: parse once at the boundary, then pass a typed address instead of a string. Parsing is *checked* — `ipFromString`, `inetAddressFromString`, and `macAddressFromString` return a `Result` with a `NetAddressError`, and each has a throwing `*Unsafe` twin for trusted literals. Formatting is canonical: `formatIp`, `formatInet` (brackets IPv6 before the port), and `formatUrlHost` (brackets IPv6 for use inside a URL; scoped IPv6 is rejected by the URL helpers). Classification predicates — `isLoopback`, `isPrivate`, `isLinkLocal`, `isMulticast`, `isUniqueLocal`, `isUnspecified` — replace ad-hoc prefix string checks, which is what an SSRF or allow-list guard should be built on.

```ts
import { Result } from "effect"
import { IpNetwork, NetAddress } from "effect/unstable/net"

// Untrusted input: checked parsing returns a Result, never throws.
const parsed = NetAddress.ipFromString("10.20.3.999")
if (Result.isFailure(parsed)) {
  console.log(parsed.failure._tag) // "NetAddressError"
}

// Trusted literal: the Unsafe twin throws on a typo instead of limping on.
const payrollHost = NetAddress.ipFromStringUnsafe("10.20.3.7")
NetAddress.isLoopback(payrollHost) // false
NetAddress.formatIp(payrollHost)   // "10.20.3.7"

// A socket address keeps the port typed; IPv6 is bracketed when formatted.
const hris = NetAddress.inetAddressFromStringUnsafe("[2001:db8::1]:8443")
hris.port                               // 8443
NetAddress.formatInet(hris)             // "[2001:db8::1]:8443"
NetAddress.formatUrlHost(hris.address)  // "[2001:db8::1]"

// Allow-list an outbound webhook target by CIDR membership, not by string prefix.
const internalRange = IpNetwork.fromStringUnsafe("10.20.0.0/16")
const isInternal = IpNetwork.contains(internalRange, payrollHost) // true
```

Some socket APIs take the host and the port separately (`node:net`'s `{ host, port }`, a driver's `host` field). `formatHost(address)` (`rc.116`) renders only the numeric host, without brackets or port, and keeps a nonzero IPv6 scope ID as a `%` suffix. The reverse, `inetAddressFromHostString(host, port, scopeIds?)`, parses an unbracketed numeric host plus a port into an `InetAddress` and returns a `Result`; a hostname such as `payroll.internal` is a failure, because this module never resolves DNS. A **named** IPv6 zone (`fe80::1%en0`) needs a map from interface name to numeric scope ID, which `scopeIdsFromInterfaces(Object.entries(os.networkInterfaces()))` builds from entries you supply; numeric zones need no map, and an unknown name fails with `unknown IPv6 interface`.

```ts
import { Result } from "effect"
import { NetAddress } from "effect/unstable/net"
import { networkInterfaces } from "node:os"

// A payroll relay configured with `host` and `port` as separate settings.
const scopeIds = NetAddress.scopeIdsFromInterfaces(Object.entries(networkInterfaces()))
const relay = NetAddress.inetAddressFromHostString("fe80::1%lo0", 8443, scopeIds)
if (Result.isSuccess(relay)) {
  NetAddress.formatHost(relay.success) // "fe80::1%1" (lo0's scope ID on this host)
  NetAddress.formatInet(relay.success) // "[fe80::1%1]:8443"
}
```

`Schema` ships matching codecs — `Schema.IpAddressFromString`, `Schema.InetAddressFromString`, `Schema.MacAddressFromString`, `Schema.SocketAddress`, and the v4/v6-specific variants — so a config value or request field decodes straight to an address. Migration: replace reads of a server address's old `hostname` with `NetAddress.formatIp(address.address)`, and use `address.path` for Unix sockets. Bun and Deno HTTP server layers can now fail with `ServeError` when the listener address cannot be converted.

When to use: any time an address crosses a boundary — config, request data, allow/deny lists, logging a bound listener — and whenever address equality or classification matters.

## IpNetwork

`effect/unstable/net/IpNetwork` — unstable (new in `rc.113`)

A CIDR network: a network address plus a prefix length, generic over the address family (`Ipv4Network`, `Ipv6Network`). Construction is strict — `IpNetwork.fromString("10.20.3.7/16")` **fails** because host bits are set; use `IpNetwork.fromAddress` (which masks them) or go through `IpInterface` when you have a host address. Operations: `contains(network, address)`, `containsNetwork`, `overlaps`, `firstAddress` / `lastAddress`, `addressCount` (a `bigint`, since an IPv6 range does not fit a `number`), and `format`. PostgreSQL `cidr` columns decode to `IpNetwork` in the native `@effect/sql-pg` client.

When to use: allow/deny lists, subnet planning, and tenant or region routing by address range.

## IpInterface

`effect/unstable/net/IpInterface` — unstable (new in `rc.113`)

An address **with** its prefix length — `10.20.3.7/16` — the form a host or network interface is configured with. Unlike `IpNetwork`, host bits are preserved. `IpInterface.fromString` parses it (with `ParseOptions`), `IpInterface.format` renders it, and `IpNetwork.fromInterface(iface)` yields the containing network (`10.20.0.0/16`). PostgreSQL `inet` columns decode to `IpInterface`.

When to use: modelling "this host, on this subnet" without losing either half.

## Worker

`effect/unstable/workers/Worker` — unstable

Parent-side API for communicating with a worker thread or IPC child process. A `Worker<O, I>` provides: `send(message: I)` — fire a typed message into the worker; `run(handler)` — a never-completing Effect calling the handler for each emitted `O`. Errors are `WorkerError`.

Mental model: typed bidirectional channel where `I` flows in and `O` flows out. The parent buffers sends until the worker signals readiness, then drains the queue.

Setup: call `NodeWorker.layer(spawnFn)` to provide both `WorkerPlatform` and `Spawner`; acquire a typed `Worker` via `WorkerPlatform.spawn(id)`. The spawn function receives a numeric ID and returns a `WorkerThreads.Worker` or IPC `ChildProcess`.

Lifetime: `run` owns the worker. **A worker that exits or throws — before or after the ready handshake — fails `run`** with a `WorkerError` whose reason is `WorkerReceiveError` (since `rc.113` a worker that dies before signalling readiness no longer leaves `run` hanging uninterruptibly). When the scope around `run` closes, the Node and Bun adapters send the worker a close message, wait up to five seconds for it to exit, and then call `terminate()` (Node: `kill("SIGKILL")` for an IPC child) — so worker-side finalizers get a bounded chance to run. The browser adapter only sends the close message; it does not terminate a dedicated worker you spawned.

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

Worker-side counterpart to `Worker`. A `WorkerRunner<O, I>` listens for `I` messages from the parent (tagged by port ID), calls the handler, and sends `O` replies via `send(portId, message)` or `sendUnsafe`. The optional `disconnects` queue notifies when a port closes; the browser and Deno runners provide it (many ports can share one worker there), the Node runner has a single parent and does not. An RPC server running over a worker forwards every disconnect, so a closed port's in-flight requests are interrupted rather than left running.

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

`make` also has a template-literal form, with or without options first. **Interpolations are arguments, never shell text:** each interpolated value becomes exactly one argument (an array becomes several), so untrusted input cannot inject a command; the literal part is split on whitespace only, so quotes are *not* parsed — put anything containing a space in an interpolation (probed on `rc.116`; `rc.113` also fixed the template form losing the arguments that followed an astral-Unicode escape).

```ts
import { ChildProcess } from "effect/unstable/process"

const employee = "Ada Lovelace; rm -rf /" // stays one harmless argument
const flags = ["--format=csv", "--cycle=2026 H1"]

// payroll-cli ["export", "--format=csv", "--cycle=2026 H1", "--employee", "Ada Lovelace; rm -rf /"]
const exportOne = ChildProcess.make`payroll-cli export ${flags} --employee ${employee}`

// Options first, then the template.
const listing = ChildProcess.make({ cwd: "/app/payroll", forceKillAfter: "2 seconds" })`ls -la`
```

When to use: composing commands before running them, separating command description from execution.

## ChildProcessSpawner

`effect/unstable/process/ChildProcessSpawner` — unstable

Service that executes `ChildProcess.Command` values.

Key APIs: spawner.string(cmd), spawner.lines(cmd), spawner.spawn(cmd)

`string` collects stdout as a single string. `lines` collects stdout as `Array<string>`. `streamString` / `streamLines` are the incremental `Stream` forms, and `exitCode(cmd)` runs a command for its status alone; all five take `{ includeStderr }` except `exitCode`. `spawn` returns a scoped `ChildProcessHandle` with `stdout`, `stderr`, `all` (merged) as byte `Stream`s, and `exitCode` as an Effect waiting for process completion. Exit code is a branded `ExitCode`; compare with `ChildProcessSpawner.ExitCode(0)`.

Platform implementations: `NodeServices.layer` includes `NodeChildProcessSpawner.layer`; Bun uses `BunServices.layer`.

**Termination waits, and only `forceKillAfter` bounds it.** On Node and Bun, closing the scope around `spawn` (or calling `handle.kill(options?)`) signals the child's whole *process group* with `killSignal` (default `SIGTERM`), then waits for the leader to exit and up to one more second for descendants to disappear. Nothing escalates by default, so a child that ignores `SIGTERM` holds the scope — and therefore your shutdown — open until it exits by itself (probed: a `trap '' TERM; sleep 4` child delayed release by the remaining four seconds). Set `forceKillAfter` on the command (or pass it to `kill`) to send `SIGKILL` to the group at that deadline; the probe then released in 300 ms. The waits use native timers rather than the Effect `Clock`, so they elapse under `TestClock` without `adjust`. Since `rc.116` the Node and Bun spawners also clean up the group when the leader has already exited, successfully or by a signal, before the scope closes: a grandchild the command left running in the background (`sh -c 'sleep 47 & exit 0'` in the probe) is gone once the scope closes. That cleanup targets a numeric process-group ID, so if the group disappears and the operating system reuses its ID first, an unrelated group can be signalled. On Windows the tree is ended with `taskkill /T /F` and only the leader is awaited; the Deno adapter differs again (see [Platform packages](#platform-packages)).

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

Two `rc.113` packaging changes: `@effect/platform-node/Mime` was deleted along with the `mime` dependency — use [`Mime`](./http-server#mime) from `effect/unstable/http`; and `NodeRedis` moved from `ioredis` to the `redis` (node-redis) client, so the optional peer dependency is now `redis >=5.0.0 <7.0.0`.

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

`BrowserRuntime.runMain` listens for **`pagehide`** (it was `beforeunload` before `rc.113`) and interrupts the root fiber when the document is being discarded. A *persisted* `pagehide` — the page entering the back/forward cache — is ignored, because that document may be restored with its fibers intact. The interruption is best effort: the browser may tear the page down before asynchronous finalizers, network flushes, or timers complete, so persist anything important before unload rather than in a finalizer.

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

## Choosing a host

A platform Layer says *how* a capability is implemented. The host decides something more important: **who owns the runtime, what cancels work, and whether cleanup is actually awaited.** Pick the row first, then the package.

| Host | Runner and owner | What the host guarantees | What it cannot promise |
| --- | --- | --- | --- |
| Node / Bun / Deno process | `NodeRuntime.runMain`, `BunRuntime.runMain`, `DenoRuntime.runMain` once at the root; the launched Layer's scope owns everything | SIGINT and SIGTERM interrupt the main fiber; finalizers run; the process exits after teardown with `0`, `130` (interrupt-only), or the error's exit code | Surviving SIGKILL or an expired grace period; signal delivery when another process is PID 1 in the container; identical signal behavior on Windows — verify on the target |
| Web-standard handler (serverless, edge) | `HttpRouter.toWebHandler` or `HttpEffect.toWebHandlerLayer` returns `{ handler, dispose }`; module scope owns the Layer, each request owns its own scope | The Layer is built eagerly; each request's scope closes once its response body has finished; `request.signal` interrupts the request fiber | That `dispose` is ever awaited, that the isolate is reused, or that work continues after the response. A Fetch-shaped API is not Node: no `node:*` modules unless the platform says so |
| Foreign framework callback (Express, Hono, UI, plugin API) | One `ManagedRuntime`, created at boot and disposed by the host's shutdown hook | One shared Layer graph; idempotent `dispose()` | Cancellation and drain — nothing happens unless you forward the host's `AbortSignal` and stop admission yourself |
| Browser page | `BrowserRuntime.runMain` | A non-persisted `pagehide` interrupts the main fiber | Completion of asynchronous finalizers or network flushes during teardown |
| Worker thread or IPC child | The parent's scope around `Worker.run`; worker side runs a `WorkerRunner` with its platform Layer | Node and Bun: close message, five-second grace, then `terminate()` | Worker-side cleanup that needs longer than the grace; termination of a browser worker (the adapter only asks it to close) |
| CLI | `Command.run` handed to the platform `runMain` | Same as a process; Ctrl+C inside a prompt is a typed `QuitError` | — |
| Test | The scope of `it.effect` / `it.layer` | Scope closes at the end of the test; time is virtual | Anything about real signals, ports, files, or bundling — fakes do not exercise them |

- **Same program, different owner.** Business code is identical in every row; only the outermost line and the platform Layer change. If a module has to know which row it runs in, a platform import has leaked inward.
- **Server-side rendering is two hosts.** The server request and the hydrated page have separate scopes and runtimes: serialize validated data across that seam, never a service, fiber, `Scope`, or runtime.
- **Edge isolates may forbid timers at module scope.** Since `rc.113` the default scheduler falls back to a microtask when setting a timer throws (Cloudflare Workers' global scope), so an Effect run at module load no longer crashes there. A module-level `ManagedRuntime` amortizes acquisition across invocations of a reused isolate, but it must not capture request data and must not assume disposal runs.
- **Platform-specific defaults follow the host.** `Logger.consolePretty()` detects TTY versus browser rendering; pin one with `Logger.consolePrettyTty` or `Logger.consolePrettyBrowser`. `Logger.toFile` writes through the `FileSystem` service, so it needs a platform Layer in scope (both in [Observability](../operations/observability#logger)).

Official guide: [Runtime (platform)](https://effect.website/docs/v4/platform/runtime) (it gives the exit code as only `0` or `1` and names only SIGINT; `rc.116` also uses `130` and handles SIGTERM). Recipes: [a graceful Node entrypoint](../recipes/graceful-entrypoint-and-shutdown), [ManagedRuntime at an imperative boundary](../recipes/managed-runtime-integration), and [request cancellation through a host](../recipes/request-cancellation-through-a-host).

### Keep platform and unstable imports behind a capability

**Let domain code depend on a small app-owned service, and let exactly one module import the platform package or the `effect/unstable/*` path that implements it.** The reason is churn as much as portability: `effect/unstable/*` modules may change in any release, and during the release-candidate series stable ones moved too (`rc.113` reshaped `Socket`, removed the `FileSystem` size helpers, and deleted `@effect/platform-node/Mime`). A quarantined import turns such a release into a one-file change. Tests provide a fake Layer instead of patching globals.

```ts
import { Context, Data, Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

class PayrollCliFailed extends Data.TaggedError("PayrollCliFailed")<{
  readonly cause: unknown
}> {}

// Domain code sees only this capability.
class PayrollCli extends Context.Service<PayrollCli, {
  readonly pendingEmployeeIds: Effect.Effect<ReadonlyArray<string>, PayrollCliFailed>
}>()("app/PayrollCli") {
  // The one place that knows about the unstable process API.
  static layer = Layer.effect(
    PayrollCli,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return {
        pendingEmployeeIds: spawner.lines(
          ChildProcess.make`payroll-cli list-pending --format=ids`
        ).pipe(Effect.mapError((cause) => new PayrollCliFailed({ cause })))
      }
    })
  )

  static layerTest = (ids: ReadonlyArray<string>) =>
    Layer.succeed(PayrollCli)({ pendingEmployeeIds: Effect.succeed(ids) })
}
```

> **Note:** This applies to *leaf* capabilities — a file store, a status client, a subprocess. Framework-level unstable modules such as `HttpApi`, `RpcServer`, or `SqlClient` are used directly throughout a codebase; manage those by pinning one Effect version and re-auditing on upgrade (see [Incompatible unstable package versions](../troubleshooting/troubleshooting-and-anti-patterns#incompatible-unstable-package-versions)).

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
