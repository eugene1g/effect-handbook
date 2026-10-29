# Release History

This page records how the handbook has evolved: one entry per audited Effect release, newest first. Each entry names the release the handbook was audited against, the changes in Effect that a reader of the previous entry needs to know about, and what changed in the handbook itself.

It is a curated reader's changelog, not a copy of Effect's. Entries keep only what changes how you write or operate Effect code: behavior, types, stability, renamed options, span and metric names, and new public surfaces. Fixes that only made the implementation match what the handbook already described are left out. The per-package `CHANGELOG.md` files in the [Effect repository](https://github.com/Effect-TS/effect) stay the authoritative record of every change.

**Reading it when you upgrade.** Find the entry for the version you are pinned to, then read every entry above it. Each entry's items link to the handbook section that now owns the topic. Read that section rather than the summary line. Editions are published per `major.minor` (see [Match the edition to the installed Effect version](agent-guide#match-the-edition-to-the-installed-effect-version)); a patch release updates its edition in place and gets its own entry here.

## `effect@4.1.0` — audited 2026-10-29

Edition **4.1** (new edition; the 4.0 edition is frozen at `effect@4.0.5`). Tag [`effect@4.1.0`](https://github.com/Effect-TS/effect/tree/effect%404.1.0), commit [`9a91b192`](https://github.com/Effect-TS/effect/commit/9a91b1926a5fbfaffd302a7a41a94d4d53a1154e), published 2026-10-29. Baseline: `effect@4.0.5` (published 2026-10-15). Range reviewed: all package changelogs, changesets, and 579 commits covering published 4.0.6, 4.0.7, and 4.1.0. npm omits `gitHead`; the package integrity, provenance, and published source were checked against the release tag.

### Changes in Effect that matter to readers

**New public surfaces and stability**

- No module present in 4.0.5 changed its module-level `@stability`. New modules:
  - unstable: root `Bytes`, `SemVer`, `SemVerRange`; `effect/encoding` `Csv`, `JsonArray`, `Tar`; `EventRow`, `ProblemDetails`, `OtlpProxy`, `UserDirectories`, `CommandLine`, `MigratorFileSystem`, `TerminalCapabilities`, `McpTest`, and the new `effect/crypto` family;
  - experimental: `Glob`, `TextDiff`, `Xml`, `Zip`, `persistence/CircuitBreaker`, `McpClient`, `McpClientError`.

  Sources: [#9441](https://github.com/Effect-TS/effect/pull/9441), [#9243](https://github.com/Effect-TS/effect/pull/9243), [#9291](https://github.com/Effect-TS/effect/pull/9291), [#9431](https://github.com/Effect-TS/effect/pull/9431), [#9148](https://github.com/Effect-TS/effect/pull/9148), [#9420](https://github.com/Effect-TS/effect/pull/9420), [#9419](https://github.com/Effect-TS/effect/pull/9419), [#9434](https://github.com/Effect-TS/effect/pull/9434), [#9438](https://github.com/Effect-TS/effect/pull/9438), [#9646](https://github.com/Effect-TS/effect/pull/9646), [#8862](https://github.com/Effect-TS/effect/pull/8862). Stable modules gain a few unstable exports: `Match.literals`/`literalsExhaustive`, `Metric.remove`/`registerUnsafe`, `Pool.stats` ([#9824](https://github.com/Effect-TS/effect/pull/9824), [#9572](https://github.com/Effect-TS/effect/pull/9572), [#9090](https://github.com/Effect-TS/effect/pull/9090)). See [Stability and support](../#stability-and-support).
- Deep imports of nested `internal` modules are blocked by the package `exports` map ([#9326](https://github.com/Effect-TS/effect/pull/9326)). **Migration:** import only public entry points. See [Getting Started](../foundations/getting-started).
- **Migration:** `effect/Crypto` and `effect/testing/TestCrypto` are removed in favour of `effect/crypto/*`: `SecureRandom`, `Digest`, `Aead`, `Cipher`, `Mac`, `Signature`, `Kdf`, `KeyAgreement`, `KeyWrap`, `KeyFormat`, `CryptoError`, `WebCrypto` ([#9126](https://github.com/Effect-TS/effect/pull/9126)). This also supersedes the 4.0.5 `TestCrypto` and `randomUUIDv4()` notes.
  - Crypto is no longer bundled in the `*Services` layers. Provide `NodeCrypto`/`BunCrypto`/`DenoCrypto`/`BrowserCrypto` `.layer` (or a per-family `layer*`), or a core `layerWebCrypto`.
  - Tests use `Layer.mock`.
  - `SqlMessageStorage`, `SingleRunner` and encrypted event-log server storage now require `Digest.Digest`.
  - Persisted workflow IDs, idempotency keys and event-log encodings are unchanged.

  See [Cryptography](../interfaces/cryptography), [Deterministic crypto in tests](../tooling/testing-dev-tooling#deterministic-crypto-in-tests).

**Runtime, errors, and layers**

- Defects take precedence in mixed causes. Typed recovery (`catch`, `catchTag`, error-mapping recovery, retry) skips a cause that contains a defect and turns every typed error in it into a defect; error mapping maps every typed error in place ([#9516](https://github.com/Effect-TS/effect/pull/9516), [#9433](https://github.com/Effect-TS/effect/pull/9433)). Use `catchCause` or `catchDefect` to handle such causes. See [Recovery and mixed causes](../foundations/errors-option-result#recovery-and-mixed-causes), [Typed recovery and mixed causes](../deep-dives/failure-retry-fallback-and-interruption#typed-recovery-and-mixed-causes).
- Composed layers are memoized by identity again, as in v3. A composed layer shared by several parents is built once per `MemoMap`, including any `Layer.fresh` dependencies inside it ([#9634](https://github.com/Effect-TS/effect/pull/9634)). Wrap the composed layer itself in `Layer.fresh` for a separate copy. See [What is shared and what is rebuilt](../foundations/services-context-layers#what-is-shared-and-what-is-rebuilt).
- `Ref` and `MutableRef` compare by reference ([#9768](https://github.com/Effect-TS/effect/pull/9768)). `ArrayBuffer`s compare and hash by bytes ([#9769](https://github.com/Effect-TS/effect/pull/9769)). **Migration:** `Exit.hasFails`/`hasDies`/`hasInterrupts` and `AsyncResult.isInterrupted` are no longer type guards; narrow with `Exit.isFailure` ([#9799](https://github.com/Effect-TS/effect/pull/9799)). See [Ref](../concurrency/state-mutable-references#ref), [Exit](../foundations/fibers-scopes-runtimes#exit).
- New small runtime APIs:
  - `Effect.ignore({ log: "Unhandled" })` and its Stream/Channel variants ([#9510](https://github.com/Effect-TS/effect/pull/9510));
  - `Semaphore.takeScoped` ([#9962](https://github.com/Effect-TS/effect/pull/9962));
  - `Effect.fnUntraced` accepting `{ self }` ([#9713](https://github.com/Effect-TS/effect/pull/9713)).

  Release failures nobody observes (RcMap/RcRef idle expiry, ScopedCache scans) are logged at `UnhandledLogLevel` ([#9388](https://github.com/Effect-TS/effect/pull/9388)). See [Semaphore](../concurrency/concurrency-coordination#semaphore), [RcMap](../concurrency/concurrency-coordination#rcmap).
- `Schedule.fibonacci` now repeats the initial delay (100, 100, 200, 300 ms…), so later retries come sooner ([#9917](https://github.com/Effect-TS/effect/pull/9917)). `Cron`/`Schedule.cron` gain `onDstOverlap` for repeated local times ([#9905](https://github.com/Effect-TS/effect/pull/9905)). `Duration` gains `formatIso`/`fromIso` (exact units only) and `toMicros` ([#9891](https://github.com/Effect-TS/effect/pull/9891), [#9973](https://github.com/Effect-TS/effect/pull/9973)). See [Cron](../concurrency/scheduling-time#cron), [Duration](../concurrency/scheduling-time#duration).
- Upstream stream failures in `Stream.run`, `peel` and `aggregate*` bypass `Sink.mapError`/`catch*`/`orElse` and reach the caller unchanged ([#9803](https://github.com/Effect-TS/effect/pull/9803)). See [Sink](../concurrency/streaming-channels#sink).

**HTTP, HttpApi, and platform hosts**

- **Migration:** `HttpMiddleware.xForwardedHeaders` is now a function taking `{ trustedProxies }` (an `IpNetwork` list), and applies `X-Forwarded-*` only from trusted peers. `HttpServerRequest.toURL` uses the new `request.protocol`, and the peer is `request.peerAddress` ([#9701](https://github.com/Effect-TS/effect/pull/9701)). Node `originalUrl` is absolute when a Host header is present; read paths from `url` ([#9415](https://github.com/Effect-TS/effect/pull/9415)). See [HttpMiddleware](../interfaces/http-server#httpmiddleware).
- Request data leaks less:
  - `HttpClientError` `toJSON` shows only the method and redacted URL ([#9855](https://github.com/Effect-TS/effect/pull/9855));
  - `HttpServerError` messages carry only the path ([#10011](https://github.com/Effect-TS/effect/pull/10011));
  - AWS SigV4 query parameters are redacted by default ([#9903](https://github.com/Effect-TS/effect/pull/9903)).

  **Migration:** `AiError.HttpRequestDetails` and `Response.HttpRequestDetails` are removed, and `NetworkError` exposes `method` and `url` instead of `request` ([#10010](https://github.com/Effect-TS/effect/pull/10010)). See [HttpClientError](../interfaces/http-client#httpclienterror), [AiError](../systems/ai-language-models#aierror).
- **Migration:** `HttpClient.withCookiesRef` takes a `Ref<ReadonlyArray<Cookie>>` (not `Ref<Cookies>`) and sends cookies only to the matching host, path and scheme. Seed it with `Cookies.mergeIntoArray` ([#9614](https://github.com/Effect-TS/effect/pull/9614)). **Migration:** received request methods are typed `string`; exhaustive switches need a default or `HttpMethod.isHttpMethod` ([#8766](https://github.com/Effect-TS/effect/pull/8766)). See [HttpClient](../interfaces/http-client#httpclient).
- `Headers` gains typed HTTP-date and `Retry-After` parsing, with matching `Schema` codecs. Invalid or fractional `Retry-After` values are now ignored by `retryTransient`/`withRateLimiter` ([#9709](https://github.com/Effect-TS/effect/pull/9709)). Other additions:
  - `HttpClient.isTransientError`/`isTransientResponse` ([#9059](https://github.com/Effect-TS/effect/pull/9059));
  - experimental `HttpClient.withCircuitBreaker` ([#9646](https://github.com/Effect-TS/effect/pull/9646));
  - `HttpClientResponse.toWeb` ([#9673](https://github.com/Effect-TS/effect/pull/9673)).

  `FetchHttpClient` fails with `EncodeError` on runtimes without streaming request bodies unless `StreamBodyFallback` is `"buffer"` ([#9567](https://github.com/Effect-TS/effect/pull/9567)). See [HttpClient](../interfaces/http-client#httpclient).
- Raw HTTP/1.1 upgrades (`HttpClientRequest.upgrade`, `HttpApiSchema.Upgrade`) arrive. Custom `HttpClientResponse` implementations must add `upgrade` ([#9339](https://github.com/Effect-TS/effect/pull/9339)). Upgrade endpoints can declare `101` headers and buffered payloads, and can sit alongside ordinary success responses ([#9751](https://github.com/Effect-TS/effect/pull/9751), [#9945](https://github.com/Effect-TS/effect/pull/9945)). **Migration:** hand-built `HttpApiClient.Upgraded` mocks need the `UpgradedTypeId` brand; narrow with `HttpApiClient.isUpgraded`. See [Upgrades](../interfaces/http-api#upgrades).
- New `HttpApi` features:
  - streaming request payloads via `StreamUint8Array`/`StreamNdjson`, with `maxBytes` limits and `HttpApiPayloadTooLarge` (413) ([#9575](https://github.com/Effect-TS/effect/pull/9575));
  - opt-in RFC 9457 Problem Details via `HttpApiError.Problem` and `HttpApiMiddleware.layerProblemDetails` ([#9706](https://github.com/Effect-TS/effect/pull/9706));
  - `HttpApiClient.decodeResponse` ([#9944](https://github.com/Effect-TS/effect/pull/9944)).

  Oversized bodies return 413, and web/Bun/Deno servers now enforce `MaxBodySize` on buffered reads ([#9835](https://github.com/Effect-TS/effect/pull/9835)). See [Problem Details](../interfaces/http-api#problem-details-rfc-9457), [Streaming request payloads](../interfaces/http-api#streaming-request-payloads).
- **Migration (deployment):** `@effect/platform-node`, `platform-node-shared`, `opentelemetry` and `docgen` require Node ≥ 22.19.0 ([#10084](https://github.com/Effect-TS/effect/pull/10084)), and `@effect/platform-deno` requires Deno ≥ 2.9.3 ([#9702](https://github.com/Effect-TS/effect/pull/9702)).
  - Node WebSocket clients use the global `WebSocket`. `ws` moves to the new `NodeWS` module: replace `NodeSocket.NodeWS` and `layerWebSocketConstructorWS` with `NodeWS.WebSocket` and `NodeWS.layerWebSocketConstructor`, which also keeps backpressure and custom headers.
  - `NodeHttpServer` accepts HTTP/2 servers ([#9710](https://github.com/Effect-TS/effect/pull/9710)).
  - `BunHttpServer` disables Bun's 10 s `idleTimeout` unless set ([#9705](https://github.com/Effect-TS/effect/pull/9705)).
  - Node stream pulls are bounded by `chunkSize` chunks; use the new `readSize` for byte read sizes ([#9327](https://github.com/Effect-TS/effect/pull/9327)).

  See [Platform packages](../interfaces/platform-runtime-hosts#platform-packages), [Socket](../interfaces/platform-runtime-hosts#socket).

**Processes, file systems, terminals, and CLI**

- **Migration:** `ChildProcess.make` templates now parse as a command line ([#9752](https://github.com/Effect-TS/effect/pull/9752), [#9863](https://github.com/Effect-TS/effect/pull/9863)).
  - Quoted words stay together, and unquoted shell syntax (`|`, `$HOME`, `*`, `FOO+=x`) throws `CommandLineError`. Quote such text or interpolate it with `${}`.
  - With `shell`, build the script with `CommandLine.join`.
  - `ChildProcess.TemplateExpression*` moves to `CommandLine`.
  - Arguments and `env` accept `Redacted`.

  `exitCode`/`string`/`lines` drain unread pipes instead of hanging ([#9846](https://github.com/Effect-TS/effect/pull/9846)). See [ChildProcess](../interfaces/platform-runtime-hosts#childprocess), [CommandLine](../interfaces/platform-runtime-hosts#commandline).
- **Migration (custom implementations):** `FileSystem.make` inputs must provide `lstat` and `readDirectoryEntries`, and `glob` is now derived ([#6428](https://github.com/Effect-TS/effect/pull/6428), [#9438](https://github.com/Effect-TS/effect/pull/9438)). `Terminal.make` inputs must provide `size`, a resize queue ([#9639](https://github.com/Effect-TS/effect/pull/9639)). `FileSystem.glob` is experimental, uses `/` separators, and no longer expands Node extglobs. See [FileSystem](../interfaces/platform-runtime-hosts#filesystem), [Glob](../interfaces/platform-runtime-hosts#glob), [Terminal](../interfaces/platform-runtime-hosts#terminal).
- **Migration:** a single-valued CLI flag given twice now fails; use `Flag.atLeast`/`atMost`/`between` ([#9872](https://github.com/Effect-TS/effect/pull/9872)). `-num=3` lexes as short flags; use `--num=3` ([#9287](https://github.com/Effect-TS/effect/pull/9287)). New CLI APIs:
  - `Command.validate` ([#9655](https://github.com/Effect-TS/effect/pull/9655)) and `Flag.withNegation` ([#9650](https://github.com/Effect-TS/effect/pull/9650));
  - `CliOutput.Presenter` ([#6743](https://github.com/Effect-TS/effect/pull/6743)) and `TerminalCapabilities`, which honours `FORCE_COLOR`/`TERM=dumb` ([#8350](https://github.com/Effect-TS/effect/pull/8350));
  - `Completions.fromCommand` ([#9976](https://github.com/Effect-TS/effect/pull/9976)) and the `CliError.userMessage` annotation ([#8349](https://github.com/Effect-TS/effect/pull/8349)).

  Help shows an `INHERITED FLAGS` section, and custom formatters must read `HelpDoc.inheritedFlags` ([#9276](https://github.com/Effect-TS/effect/pull/9276)). See [CliOutput](../tooling/cli-framework#clioutput), [TerminalCapabilities](../tooling/cli-framework#terminalcapabilities).

**SQL, persistence, event log, cluster, and RPC**

- **Migration:** `sql.insert` and `sql.updateValues` require a non-empty array at the type level ([#9453](https://github.com/Effect-TS/effect/pull/9453)). The `updateValues` alias is escaped as an identifier, so pass it bare ([#9759](https://github.com/Effect-TS/effect/pull/9759)). `fromFileSystem` moves to `effect/sql/MigratorFileSystem`; adapter `*Migrator` modules still re-export it ([#9157](https://github.com/Effect-TS/effect/pull/9157)).
  - Migrations fail with a typed `MigrationError` ([#9598](https://github.com/Effect-TS/effect/pull/9598)).
  - Third-party drivers must set `SqlClient.make({ driver })` ([#9222](https://github.com/Effect-TS/effect/pull/9222)).
  - New: `SqlClient.afterCommit` and `BeginTransaction` ([#9289](https://github.com/Effect-TS/effect/pull/9289), [#9576](https://github.com/Effect-TS/effect/pull/9576)); `sql.in([])` now compiles to an always-false (`IN`) or always-true (`NOT IN`) predicate ([#9758](https://github.com/Effect-TS/effect/pull/9758)); PostgreSQL `acquireTimeout`, `onAcquire` and `poolStats` ([#9641](https://github.com/Effect-TS/effect/pull/9641), [#9738](https://github.com/Effect-TS/effect/pull/9738), [#9090](https://github.com/Effect-TS/effect/pull/9090)).

  See [MigratorFileSystem](../interfaces/sql#migratorfilesystem), [Transactions](../interfaces/sql#transactions).
- **Migration (persistence):** `Persistence` on `KeyValueStore` now keys entries `<storeId>:<key>`, so every existing `layerKvs` entry becomes unreachable, including `Chat.layerPersisted` histories. Redis is affected only for store ids containing `%` or `:` ([#9223](https://github.com/Effect-TS/effect/pull/9223)).
  - Custom `KeyValueStore.make` stores must implement `keys`, and `prefix(...)` scopes `size`/`isEmpty`/`clear` ([#9844](https://github.com/Effect-TS/effect/pull/9844)).
  - The Redis `PersistedQueue` lock format changed: drain old workers and let their locks expire before starting upgraded ones ([#9229](https://github.com/Effect-TS/effect/pull/9229)).
  - `Redis.make` requires `connect`, and `Redis.reserve` leases dedicated connections for blocking commands ([#9828](https://github.com/Effect-TS/effect/pull/9828)).

  See [Backing layers](../tooling/persistence#backing-layers), [Redis](../tooling/persistence#redis), [PersistedQueue](../tooling/persistence#persistedqueue).
- **Migration (wire):** event-log writes are now acknowledged instead of echoed, and encrypted replication batches entries ([#9477](https://github.com/Effect-TS/effect/pull/9477), [#9479](https://github.com/Effect-TS/effect/pull/9479)). Upgrade clients and servers together, and start encrypted servers on fresh storage. `EncryptedEntry` is now `EncryptedBatch`, and custom journals must add `entriesById`/`writeRemoteAcks`. SQL and IndexedDB journals migrate on first open ([#9482](https://github.com/Effect-TS/effect/pull/9482)). New: encrypted remote compaction ([#9571](https://github.com/Effect-TS/effect/pull/9571)), `EventRow` ([#9523](https://github.com/Effect-TS/effect/pull/9523)), `EventLog.writeMany` ([#9452](https://github.com/Effect-TS/effect/pull/9452)). See [EventLogRemote](../systems/event-log-event-sourcing#eventlogremote), [EventRow](../systems/event-log-event-sourcing#eventrow).
- In `calculateNextRunFromPrevious` mode, `ClusterCron` runs through one executor entity per job. Read the scheduled time from `ClusterCron.CurrentScheduledTime`, not `Entity.CurrentAddress`; a failing run now blocks later runs while it retries ([#9677](https://github.com/Effect-TS/effect/pull/9677)).
  - Frozen runners lose PostgreSQL/MySQL shard locks after `shardLockExpiration` ([#10037](https://github.com/Effect-TS/effect/pull/10037), [#10093](https://github.com/Effect-TS/effect/pull/10093)).
  - `ShardingConfig.runnerJoinDebounce` batches handoffs during surge deploys ([#10073](https://github.com/Effect-TS/effect/pull/10073)).
  - New `ClusterMetrics` series: `shardReleaseDuration`, `shardsReleasing`, `entityMailboxSize[Max]` ([#9256](https://github.com/Effect-TS/effect/pull/9256), [#9513](https://github.com/Effect-TS/effect/pull/9513), [#9578](https://github.com/Effect-TS/effect/pull/9578), [#9572](https://github.com/Effect-TS/effect/pull/9572)).
  - `SqlMessageStorage.makeEncodedStorage` skips migrations ([#9330](https://github.com/Effect-TS/effect/pull/9330)).

  See [ClusterCron](../systems/cluster-sharding#clustercron), [SqlRunnerStorage](../systems/cluster-sharding#sqlrunnerstorage).
- **Migration (wire):** RPC calls with `discard: true` complete when the server acknowledges them. The `SchemaBinary` envelope fingerprint changed, so upgrade those peers together ([#9182](https://github.com/Effect-TS/effect/pull/9182)). The RPC NDJSON content type is `application/x-ndjson`; existing RPC HTTP peers stay compatible ([#9562](https://github.com/Effect-TS/effect/pull/9562)). New: `RpcServer` `onDisconnect` ([#9688](https://github.com/Effect-TS/effect/pull/9688)) and opt-in HTTP request `batch`ing ([#9656](https://github.com/Effect-TS/effect/pull/9656)). With `disableFatalDefects`, a synchronous handler throw fails only its own request ([#9899](https://github.com/Effect-TS/effect/pull/9899)). See [RpcSerialization](../interfaces/rpc#rpcserialization).

**AI and MCP**

- **Migration:** `DecideOptions.images` is removed. Declare `Decision.Image` fields in the input schema; the new `Decision.locate` returns bounding boxes, and exhaustive switches need `Locate` cases ([#9177](https://github.com/Effect-TS/effect/pull/9177)). `DecisionModel.decideSettled` keeps valid answers alongside per-decision failures ([#9437](https://github.com/Effect-TS/effect/pull/9437)).
  - **Migration:** the new non-retryable `AiError.InvalidResponseError` needs a case in exhaustive `AiErrorReason` matches ([#9430](https://github.com/Effect-TS/effect/pull/9430)).
  - `NetworkError.cause` keeps the `HttpClientError` ([#9984](https://github.com/Effect-TS/effect/pull/9984)).
  - `Tool.make({ toModelOutput })` sends rich tool results ([#9861](https://github.com/Effect-TS/effect/pull/9861)).
  - `Response.AllParts` requires tool parameter schema services ([#9873](https://github.com/Effect-TS/effect/pull/9873)).

  See [Decision](../systems/ai-language-models#decision), [Tool](../systems/ai-language-models#tool).
- **Migration:** pass `McpServer` registration layers through the transport's `registrations` option, and capture construction-time services with `Layer.unwrap` ([#9154](https://github.com/Effect-TS/effect/pull/9154)). Unmet per-request services surface as `McpRequest<"Requires", S>` ([#9856](https://github.com/Effect-TS/effect/pull/9856)). New: `McpServer.visibility` ([#9661](https://github.com/Effect-TS/effect/pull/9661)), `cacheHints` ([#9939](https://github.com/Effect-TS/effect/pull/9939)), the in-memory `McpTest.makeClient` ([#9657](https://github.com/Effect-TS/effect/pull/9657)), and the experimental `McpClient` ([#8862](https://github.com/Effect-TS/effect/pull/8862)). See [McpServer](../systems/mcp#mcpserver), [McpClient](../systems/mcp#mcpclient).
- Provider changes ([#9509](https://github.com/Effect-TS/effect/pull/9509), [#9421](https://github.com/Effect-TS/effect/pull/9421), [#9263](https://github.com/Effect-TS/effect/pull/9263), [#9920](https://github.com/Effect-TS/effect/pull/9920)) See [Provider packages](../systems/ai-language-models#provider-packages).:
  - **Migration:** the regenerated Anthropic `Generated` bindings move Files and Skills to their GA shapes (`*Resource` types, `next_page` paging). Remove the dated `files-api`/`skills` beta tokens from `anthropic-beta`.
  - The OpenRouter provider name is `"openrouter"`.
  - OpenRouter defaults to strict schemas for OpenAI-family models.
  - Truncated responses report `finishReason: "length"`.

**Data, encoding, telemetry, and testing**

- **Migration:** drop explicit output type arguments from `Schema.TaggedUnion.match`/`matchOrElse` ([#10061](https://github.com/Effect-TS/effect/pull/10061)). `Schema.Record` rejects optional index-signature values; use `Schema.UndefinedOr` ([#9864](https://github.com/Effect-TS/effect/pull/9864)). Checks keep `httpApiStatus` annotations ([#9775](https://github.com/Effect-TS/effect/pull/9775)). New Schema APIs: crypto key schemas, `isAscii`, `DurationFromIsoString`, `DateTimeUtcFromHttpDate`, and the unstable `toCodecGoJson` ([#9245](https://github.com/Effect-TS/effect/pull/9245)). See [Schema unions and records](../data/schema#4-unions-literals-records-tuples).
- **Migration:** `Toml.parse` returns a `Result` with an `EncodingError` instead of throwing ([#9537](https://github.com/Effect-TS/effect/pull/9537)). `Base64Url.decode` rejects partial padding ([#10076](https://github.com/Effect-TS/effect/pull/10076)), and `Yaml.parse` supports `<<` merge keys ([#10051](https://github.com/Effect-TS/effect/pull/10051)). `NdjsonError` gains a `reason` ([#9575](https://github.com/Effect-TS/effect/pull/9575)). Libraries exporting generic `Data.taggedEnum`s now emit declarations that need `effect` ≥ 4.0.7 ([#9834](https://github.com/Effect-TS/effect/pull/9834)). See [Toml](../concurrency/streaming-channels#toml), [Yaml](../concurrency/streaming-channels#yaml).
- **Migration:** import `NodeSdk`/`WebSdk` from `@effect/opentelemetry/NodeSdk` and `/WebSdk`; the package root no longer re-exports them ([#9689](https://github.com/Effect-TS/effect/pull/9689)). Other telemetry changes:
  - `OTEL_RESOURCE_ATTRIBUTES` is percent-decoded and trimmed ([#9997](https://github.com/Effect-TS/effect/pull/9997)).
  - Calls on ended spans are ignored, so spans are not exported twice ([#9815](https://github.com/Effect-TS/effect/pull/9815)).
  - `traceparent`/`b3` parsing rejects uppercase hex and malformed flags ([#10086](https://github.com/Effect-TS/effect/pull/10086), [#10085](https://github.com/Effect-TS/effect/pull/10085)).
  - The new `OtlpProxy` forwards browser telemetry without exposing credentials ([#9829](https://github.com/Effect-TS/effect/pull/9829)).

  See [OtelNodeSdk](../operations/telemetry-export#otelnodesdk), [OtlpProxy](../operations/telemetry-export#otlpproxy).
- Atoms gain `skipInitialRun` for hydrated or seeded atoms ([#9522](https://github.com/Effect-TS/effect/pull/9522)) and opt-in typed `Reactivity.Keys` ([#9560](https://github.com/Effect-TS/effect/pull/9560)). `Atom.Serializable` encodes to `Schema.Json` ([#8763](https://github.com/Effect-TS/effect/pull/8763)). See [Hydration](../systems/reactivity-atom#hydration).
- `@effect/vitest` changes:
  - `beforeAll`/`beforeEach` run returned Effects with a scope ([#9675](https://github.com/Effect-TS/effect/pull/9675));
  - `layer(..., { buildPerTest })` rebuilds selected services for each test ([#9832](https://github.com/Effect-TS/effect/pull/9832));
  - **Migration:** `it.prop` rejects Effect/Promise returns; use `it.effect.prop` ([#9384](https://github.com/Effect-TS/effect/pull/9384)).

  `Arbitrary.checkEffect` accepts `concurrency` ([#9377](https://github.com/Effect-TS/effect/pull/9377)). See [@effect/vitest](../tooling/testing-dev-tooling#effect-vitest).

### Changes in the handbook

- Started the **4.1** edition. The 4.0 edition is frozen at `effect@4.0.5` (tag `effect-4.0.5/2026-10-22`) and stays published under `/4.0/`.
- Added a [Cryptography](../interfaces/cryptography) chapter covering every `effect/crypto` module, the host crypto layers, testing, and a migration table from `Crypto.*`. The site now has 66 pages: 53 concise pages and 13 deep-dive pages including their landing page.
- Added module sections for `Bytes`, `SemVer`, `SemVerRange`, `TextDiff`, `Glob`, `CommandLine`, `Csv`, `JsonArray`, `Tar`, `Xml`, `Zip`, `ProblemDetails`, `MigratorFileSystem`, `OtlpProxy`, `EventRow`, `CircuitBreaker`, `UserDirectories`, `TerminalCapabilities`, `McpClient`, `McpClientError`, and `McpTest`. Every public module in the root barrel and the 22 `effect/<area>` families now has a concise heading.
- Rewrote mixed-cause recovery across the foundations, the failure deep dive, troubleshooting, the decision guide, and review checklists to the defect-first rule. Corrected PersistedCache's handling of undecodable entries, `CliError.DuplicateOption`, Node's oversized-body response, `sql.in([])`, the claim that runtime aggregates include crypto, workflow compensation under `layerMemory`, and hydration ordering.
- Added persistence, wire, and deployment migration warnings for store key layouts, Redis queue locks, RPC `discard`, event-log replication, forwarded headers, and minimum Node/Deno versions. Added capability routes and retrieval cases for cryptography, circuit breaking, MCP clients, and streaming archive codecs.
- Repinned the validation workspace to 4.1.0 and `@effect/tsgo` 0.63.0. Updated the TOML probe to the `Result` contract, and turned the NodeSdk example into an isolated compile example.

## `effect@4.0.5` — audited 2026-10-22

Edition **4.0** (updated in place). Tag [`effect@4.0.5`](https://github.com/Effect-TS/effect/tree/effect%404.0.5), commit [`7f524e25`](https://github.com/Effect-TS/effect/commit/7f524e25cfb49a71ac39b0f44278d08d40dda5de), published 2026-10-15. Baseline: `effect@4.0.2` (published 2026-10-07). Range reviewed: all package changelogs, changesets, and 191 commits covering published 4.0.3, 4.0.4, and 4.0.5. npm omits `gitHead`; the package integrity, provenance, and published source were checked against the release tag.

### Changes in Effect that matter to readers

**New public surfaces and stability**

- Experimental [`effect/graphql`](../interfaces/graphql) adds seven modules for typed client operations, middleware, HTTP/SSE and WebSocket subscriptions, partial results, pagination, and batching ([#8979](https://github.com/Effect-TS/effect/pull/8979)). It is not a GraphQL server executor. [`@effect/graphql-generator`](../interfaces/graphql#graphql-generator) generates operations from documents and SDL/introspection schemas; 4.0.5 emits Struct schemas with named interfaces for ordinary object selections/inputs ([#9171](https://github.com/Effect-TS/effect/pull/9171)). HTTP endpoints can be resolved per request, with resolver batches partitioned by URL ([#9150](https://github.com/Effect-TS/effect/pull/9150)); identity-aware `batchKey`s are still required.
- Experimental [`Host`, `Dns`, and `AddressResolver`](../interfaces/platform-runtime-hosts#host) add host parsing, DNS queries, and endpoint resolution, with Node/Bun/Deno services ([#8880](https://github.com/Effect-TS/effect/pull/8880)). TLSA records and input constructors follow ([#8953](https://github.com/Effect-TS/effect/pull/8953), [#8970](https://github.com/Effect-TS/effect/pull/8970), [#8973](https://github.com/Effect-TS/effect/pull/8973)); host-file parsing and relative/FQDN conversion are available ([#8992](https://github.com/Effect-TS/effect/pull/8992)). [`DatagramSocket`](../interfaces/platform-runtime-hosts#datagramsocket) adds experimental UDP on those hosts ([#8409](https://github.com/Effect-TS/effect/pull/8409)). Experimental APIs may change in a patch release; see [Stability and support](../#stability-and-support).
- `TestCrypto.layer` (removed in 4.1.0; see [Deterministic crypto in tests](../tooling/testing-dev-tooling#deterministic-crypto-in-tests)) seeds random operations while delegating digests to the underlying platform `Crypto` ([#8487](https://github.com/Effect-TS/effect/pull/8487)). **Migration:** `Crypto.randomUUIDv4` and `randomUUIDv7` are now functions: call `()` for strings or `({ format: "bytes" })` for bytes ([#8935](https://github.com/Effect-TS/effect/pull/8935)).
- [`Effect.Transaction`](../concurrency/software-transactional-memory#inspecting-transaction-attempts) exposes attempt number, retry reason, and timing metadata from inside a transaction body ([#8166](https://github.com/Effect-TS/effect/pull/8166)).

**HTTP, platform boundaries, and SQL**

- HTTP spans, request inspection, and errors redact sensitive query values and URL credentials without changing the wire request. **Migration:** signed-URL names move from `Headers.CurrentRedactedNames` to `UrlParams.CurrentRedactedNames`; custom name lists replace defaults ([#9136](https://github.com/Effect-TS/effect/pull/9136)). `UrlParams` also accepts `Redacted` values, widening its public parameter and iterator types ([#9160](https://github.com/Effect-TS/effect/pull/9160)). See [HTTP Client](../interfaces/http-client).
- [`HttpClientRequest.compressBody`](../interfaces/http-client#httpclientrequest) supports gzip/deflate ([#9137](https://github.com/Effect-TS/effect/pull/9137)); [`HttpMiddleware.decompression`](../interfaces/http-server#httpmiddleware) bounds decompressed request bodies and rejects unsupported codings with `415` ([#9138](https://github.com/Effect-TS/effect/pull/9138)). `retryTransient` honors `Retry-After` ([#9053](https://github.com/Effect-TS/effect/pull/9053)); Node clients have typed Unix-socket/mTLS connection options ([#9158](https://github.com/Effect-TS/effect/pull/9158)).
- [`FileSystem.File.Info`](../interfaces/platform-runtime-hosts#filesystem) uses `bigint` for `dev` and `Option<bigint>` for `ino`, `rdev`, `nlink`, and `blocks`; account for this in serialization ([#9112](https://github.com/Effect-TS/effect/pull/9112)). File opens accept `noFollow` on supported POSIX hosts, and reads/writes accept explicit positions ([#8900](https://github.com/Effect-TS/effect/pull/8900)). [`Path.resolveWithin`](../interfaces/platform-runtime-hosts#path) rejects rooted paths and lexical traversal escapes; it does not prevent symlink escapes ([#9127](https://github.com/Effect-TS/effect/pull/9127)).
- WebSocket clients on Node/Bun accept handshake headers ([#8978](https://github.com/Effect-TS/effect/pull/8978)); TLS upgrades accept an explicit `servername` ([#9010](https://github.com/Effect-TS/effect/pull/9010)). See [Sockets](../interfaces/platform-runtime-hosts#socket). [`Stdio.stderrIsTerminal`](../interfaces/platform-runtime-hosts#stdio) detects stderr separately ([#8938](https://github.com/Effect-TS/effect/pull/8938)); Esc now cancels default Node/Bun/Deno terminal input unless `shouldQuit` overrides it ([#8934](https://github.com/Effect-TS/effect/pull/8934)).
- SQL COMMIT failures propagate as typed `SqlError` when cleanup succeeds; failed cleanup preserves both failures as defects ([#8892](https://github.com/Effect-TS/effect/pull/8892)). Single-connection clients exclude competing statements for the whole statement/stream lifetime ([#8927](https://github.com/Effect-TS/effect/pull/8927)). PostgreSQL adds TCP `keepAlive` ([#9120](https://github.com/Effect-TS/effect/pull/9120)). See [SQL](../interfaces/sql).
- RPC socket clients expose `onPingTimeout`, distinct from other disconnects ([#8976](https://github.com/Effect-TS/effect/pull/8976)); response-encoding failures reach `ErrorReporter` ([#8943](https://github.com/Effect-TS/effect/pull/8943)). See [RPC](../interfaces/rpc).

**MCP, AI, and durable execution**

- [`McpServer.layerHttpRequestScoped`](../systems/mcp#request-scoped-http-and-typed-requirements) owns all server work within each POST for serverless hosts. It accepts only stateless adapters and has no sessions, subscriptions, or session termination ([#9031](https://github.com/Effect-TS/effect/pull/9031)). Long-lived `layerHttp` gains `allowSubscriptions: false` ([#8924](https://github.com/Effect-TS/effect/pull/8924)). Resource-template and prompt-completion schema services now appear in Layer requirements, so previously incomplete compositions can fail type checking ([#9151](https://github.com/Effect-TS/effect/pull/9151), [#9135](https://github.com/Effect-TS/effect/pull/9135)).
- With manual tool resolution, [`toolCallValidation: "deferred"`](../systems/ai-language-models#tool-call-resolution-concurrency-and-manual-dispatch) returns model-generated calls with `unknown` parameters and possibly undeclared names. Strict validation remains the default; validate before authorizing or dispatching ([#9008](https://github.com/Effect-TS/effect/pull/9008)).
- [Decisions](../systems/ai-language-models#decision) accept structured descriptions and score legends. **Migration:** `Rate.criteria` entries are `{ label, description }` objects, not strings ([#9124](https://github.com/Effect-TS/effect/pull/9124)). OpenAI adds a Decisions provider; OpenAI-compatible response augmentation moves to the `openai-compat` metadata key ([#9140](https://github.com/Effect-TS/effect/pull/9140)). Regenerated OpenAI bindings also change public provider types ([#9067](https://github.com/Effect-TS/effect/pull/9067)); review the [provider migration notes](../systems/ai-language-models#provider-packages).
- OpenAI treats unknown model names as reasoning models by default; set `reasoningModel: false` for custom non-reasoning names ([#8980](https://github.com/Effect-TS/effect/pull/8980)). OpenAI-compatible configuration removes unsupported `store` and `conversation` fields ([#9011](https://github.com/Effect-TS/effect/pull/9011)); provider-specific tool-call fields survive replay ([#8916](https://github.com/Effect-TS/effect/pull/8916)). See [Provider packages](../systems/ai-language-models#provider-packages).
- [`Workflow.execute({ discard: true, detached: true })`](../systems/workflows-durable-execution#detached-children-and-failure-suspended-recovery) starts a child that neither wakes nor inherits interruption from its parent ([#9092](https://github.com/Effect-TS/effect/pull/9092)). Failure-suspended workflows require explicit resume before failed activities retry ([#9091](https://github.com/Effect-TS/effect/pull/9091)). [`PersistedQueue.offer({ delay })`](../tooling/persistence#persistedqueue) postpones first delivery, not retries ([#8907](https://github.com/Effect-TS/effect/pull/8907)).
- Cluster SQL storage separates owner-connection migrations from application storage Layers ([#8897](https://github.com/Effect-TS/effect/pull/8897)). `InterruptOnTermination` opts RPCs into early entity interruption ([#8963](https://github.com/Effect-TS/effect/pull/8963)); shutdown hands shards off individually with bounded waits ([#8941](https://github.com/Effect-TS/effect/pull/8941)). Transactional replies publish only after commit or clean rollback, with local replies recoverable from storage ([#8891](https://github.com/Effect-TS/effect/pull/8891), [#9176](https://github.com/Effect-TS/effect/pull/9176)). See [Cluster](../systems/cluster-sharding).

**Telemetry, data, time, and tooling**

- Cluster entity RPC spans now use only the entity type in their names; `entity.id` remains an attribute ([#9094](https://github.com/Effect-TS/effect/pull/9094)). Update name-based dashboards. See [ClusterMetrics](../systems/cluster-sharding#clustermetrics).
- Built-in OTLP exporters accept opt-in gzip configuration, including per-signal environment overrides ([#9139](https://github.com/Effect-TS/effect/pull/9139)). Subsequent delta histograms omit cumulative extrema ([#8987](https://github.com/Effect-TS/effect/pull/8987)); 64-bit trace IDs are padded to 128 bits ([#9117](https://github.com/Effect-TS/effect/pull/9117)). OTel log records carry the active Effect span context ([#9125](https://github.com/Effect-TS/effect/pull/9125)). See [Telemetry Export](../operations/telemetry-export).
- JSON Schema output for [`Schema.Int`](../data/schema-tooling#jsonschema) includes safe-integer bounds, and colliding bounds compact to the tighter one ([#8956](https://github.com/Effect-TS/effect/pull/8956), [#9081](https://github.com/Effect-TS/effect/pull/9081)). Refresh snapshots rather than removing those constraints. `SchemaError` serializes compactly ([#8895](https://github.com/Effect-TS/effect/pull/8895)); tagged unions reject duplicate discriminator keys at compile time ([#9103](https://github.com/Effect-TS/effect/pull/9103)). `StructWithRest` accepts optional fields ([#9020](https://github.com/Effect-TS/effect/pull/9020)); see [Schema unions and records](../data/schema#4-unions-literals-records-tuples).
- Zoned `DateTime.add`/`subtract` apply hours and smaller units as elapsed time across DST; calendar units remain wall-clock operations ([#9048](https://github.com/Effect-TS/effect/pull/9048)). Duration conversions handle very large milliseconds and nanosecond scaling without the earlier precision/overflow failures ([#9109](https://github.com/Effect-TS/effect/pull/9109), [#9161](https://github.com/Effect-TS/effect/pull/9161), [#8972](https://github.com/Effect-TS/effect/pull/8972)). See [Time](../concurrency/scheduling-time).
- [`TestClock.adjust`/`setTime`](../tooling/testing-dev-tooling#testclock) track woken fibers across yields and child joins, so newly registered sleeps within the target interval are not skipped ([#9172](https://github.com/Effect-TS/effect/pull/9172)). Establish initial readiness explicitly; virtual time is not a general startup barrier.
- [`Sse`](../concurrency/streaming-channels#sse) can dispatch empty named events for protocols such as GraphQL SSE ([#8979](https://github.com/Effect-TS/effect/pull/8979)); its encoder handles CR/CRLF data lines ([#9096](https://github.com/Effect-TS/effect/pull/9096)). Async-iterator stream timeouts stop even when `next()` never settles ([#9106](https://github.com/Effect-TS/effect/pull/9106)).
- [`Match`](../data/functional-toolkit#match) narrows only a matched array prefix and rejects unknown object-pattern keys ([#9088](https://github.com/Effect-TS/effect/pull/9088), [#9098](https://github.com/Effect-TS/effect/pull/9098)). Mutable `Array.match` callbacks retain mutable non-empty array types ([#9055](https://github.com/Effect-TS/effect/pull/9055)).
- The CLI gains [`Flag.withOptionalValue`](../tooling/cli-framework#gnu-style-optional-flag-values) for `--flag[=VALUE]` ([#9145](https://github.com/Effect-TS/effect/pull/9145)), PowerShell completions ([#8904](https://github.com/Effect-TS/effect/pull/8904)), and `CliOutput.displayWidth` ([#8982](https://github.com/Effect-TS/effect/pull/8982)). Prompts honor `NO_COLOR` and acquire stdin only when needed ([#8933](https://github.com/Effect-TS/effect/pull/8933), [#8932](https://github.com/Effect-TS/effect/pull/8932)).

### Changes in the handbook

- Added [GraphQL](../interfaces/graphql) as a concise chapter, and topic-sized sections for DNS/host resolution, UDP, TestCrypto, transaction metadata, request-scoped MCP, and new operational options. The site now has 65 pages: 52 concise pages and 13 deep-dive pages including their landing page.
- Removed redundant current-release numbers and audit dates from chapter prose. Chapters inherit the [edition audit target](../#version-and-validation-scope); exact versions remain in release metadata, generated headers, reproducible installs, source links, and migration boundaries. The refresh skill preserves this policy.
- Updated deep dives, the decision guide, cheat sheet, troubleshooting, review checklists, capability routes, and retrieval cases with the new selection boundaries. Experimental APIs are labelled separately from unstable ones.
- Corrected stale claims about TestClock wakeups, mixed-cause retry, `DecisionModel.Image.mediaType`, workflow finalizer lifetime, and OTLP JSON spelling; pinned current source links and recipe installs to 4.0.5.
- Corrected group-level Config defaults and secret-log safety, queue shutdown producer outcomes, semaphore fairness, stream batch timing, SQL commit-error routing, and ManagedRuntime cleanup ordering. Removed a transactional queue termination race and clarified Schema length bounds, codec widening, structural equality, and decimal rounding.
- Repinned the tracked validation workspace to 4.0.5, TypeScript 7.0.2, `@effect/tsgo` 0.56.0, and Vitest 5.0.5. Added semantic probes for multi-hop virtual time, path traversal boundaries, and query-redaction override behavior; updated integer-schema expectations to the published contract.

## `effect@4.0.2` — audited 2026-10-09

Edition **4.0** (updated in place). Tag [`effect@4.0.2`](https://github.com/Effect-TS/effect/tree/effect%404.0.2), commit `269a7c86`, published 2026-10-07. Baseline: `effect@4.0.0`. Range reviewed: every 4.0.1 and 4.0.2 changelog entry across all packages.

### Changes in Effect that matter to readers

**Stability**

- Every module and directly importable export now carries an explicit `@stability` tag ([#8770](https://github.com/Effect-TS/effect/pull/8770)). Nineteen modules the handbook had badged `stable` are tagged `unstable`: `FileSystem`, `Path`, `Terminal`, `Stdio`, `Crypto`, `PlatformError`, `ExecutionPlan`, `ErrorReporter`, `LayerMap`, `LayerRef`, `Graph`, `HashRing`, `ByteSize`, `Newtype`, `PartitionedSemaphore`, `TxChunk`, `ChannelSchema`, `TestConsole`, and `TestSchema` (that last badge was already wrong in the 4.0.0 edition). No API is tagged `experimental`. See [Stability and support](../#stability-and-support).

**Runtime, errors, and caching**

- `Effect.retry` no longer retries a cause that contains a defect or an interruption, even alongside a typed failure the policy would accept ([#8799](https://github.com/Effect-TS/effect/pull/8799)). See [Failure, Retry, Fallback, and Interruption](../deep-dives/failure-retry-fallback-and-interruption).
- When an uninterruptible region fails while an interruption is pending, recovery handlers are skipped and the typed failure is dropped; the fiber exits interrupted, keeping any defects ([#8652](https://github.com/Effect-TS/effect/pull/8652)). See [Fiber](../foundations/fibers-scopes-runtimes#fiber).
- `Config.orElse` recovers only a pure `ConfigError`; a cause that mixes it with a defect or interruption propagates ([#8808](https://github.com/Effect-TS/effect/pull/8808)). See [Configuration & Secrets](../foundations/configuration-secrets).
- `Effect.cached`, `cachedWithTTL`, `cachedInvalidateWithTTL`, and `Cache` treat interruption as abandonment: an interrupted computation is never cached, and it is interrupted only once every waiting caller has gone ([#8719](https://github.com/Effect-TS/effect/pull/8719)). `cachedInvalidateWithTTL` accepts a TTL computed from the `Exit` ([#8734](https://github.com/Effect-TS/effect/pull/8734)). See [Caching & Batching](../operations/caching-batching).

**Streams and STM**

- `Stream.scan` emits its seed for an empty stream ([#8704](https://github.com/Effect-TS/effect/pull/8704)). `groupedWithin`, `aggregateWithin`, and `aggregate` pause their schedule while idle ([#8718](https://github.com/Effect-TS/effect/pull/8718)). `groupBy` and `partition` substreams shut down their queue when the consumer stops early ([#8857](https://github.com/Effect-TS/effect/pull/8857)). See [Streaming & Channels](../concurrency/streaming-channels).
- Waiting on `TxSemaphore` and `TxReentrantLock` is interruptible ([#8805](https://github.com/Effect-TS/effect/pull/8805)); PubSub rejects `NaN` and fractional capacities ([#8790](https://github.com/Effect-TS/effect/pull/8790)).

**Telemetry names (update dashboards and alerts)**

- Interrupt-only spans end with status `Unset` and `effect.fiber.interrupted: true` instead of `Ok` ([#8864](https://github.com/Effect-TS/effect/pull/8864)).
- `OtlpMetrics` exports a summary as one OTLP `Summary` metric named by its id instead of `<id>_quantiles` / `_count` / `_sum` ([#8869](https://github.com/Effect-TS/effect/pull/8869)).
- With `@effect/opentelemetry`, a span without an Effect parent inherits the active OpenTelemetry span ([#8586](https://github.com/Effect-TS/effect/pull/8586)). See [Observability](../operations/observability).
- SQL statement spans are named by `db.namespace`, `server.address[:server.port]`, or `db.system.name` (falling back to `sql.execute`), record `effect.sql.method`, and transactions emit `effect.sql.transaction.*` events ([#8866](https://github.com/Effect-TS/effect/pull/8866)). See [SQL](../interfaces/sql).
- RPC spans are named by the method tag with no default prefix and record `rpc.system.name` and `rpc.method`; pass `spanPrefix` to keep the old names ([#8867](https://github.com/Effect-TS/effect/pull/8867)). See [RPC](../interfaces/rpc).
- HTTP server spans capture no request or response headers unless `HttpMiddleware.TracerHeaderFilter` opts them in ([#8873](https://github.com/Effect-TS/effect/pull/8873)). See [HTTP Server](../interfaces/http-server).
- GenAI telemetry follows the current OpenTelemetry conventions: `addGenAIAnnotations` takes `provider: { name }` (the `system` option is removed), and Anthropic usage includes cached tokens ([#8870](https://github.com/Effect-TS/effect/pull/8870)). See [AI & Language Models](../systems/ai-language-models).

**Interfaces and AI**

- HttpApi answers a response-encoding failure with `500` and reports it to `ErrorReporter`; request-decoding failures stay `400` and unreported ([#8834](https://github.com/Effect-TS/effect/pull/8834)). See [HttpApi](../interfaces/http-api).
- RPC socket clients accept `pingInterval` and `pingTimeout` ([#8825](https://github.com/Effect-TS/effect/pull/8825)).
- `McpServer.layerHttp` gains opt-in `allowSessionTermination` ([#8773](https://github.com/Effect-TS/effect/pull/8773)). See [Exposing an Effect Application over MCP](../deep-dives/exposing-an-effect-application-over-mcp).
- `DecisionModel.decide` accepts images for providers that opt in ([#8832](https://github.com/Effect-TS/effect/pull/8832)); Anthropic preserves multiple system instructions ([#8603](https://github.com/Effect-TS/effect/pull/8603)).
- PostgreSQL `SqlEventJournal` stores entry and remote ids as `BYTEA`; existing tables need a migration ([#8756](https://github.com/Effect-TS/effect/pull/8756)). See [Event Log & Event Sourcing](../systems/event-log-event-sourcing).
- `Schema.toTaggedUnion` and `Schema.TaggedUnion` expose the discriminator key as `.tag` ([#8748](https://github.com/Effect-TS/effect/pull/8748)). See [Schema](../data/schema).

**New public surfaces**

- `effect/Version` (unstable): the `effect` version reported in telemetry. See [Version](../foundations/fibers-scopes-runtimes#version).
- `@effect/ai-cloudflare`: a Cloudflare Workers AI `DecisionModel` provider. See [AI & Language Models](../systems/ai-language-models).

### Changes in the handbook

- Corrected every claim the delta made false (above), flipped the nineteen stability badges, and rewrote the stability tables in Orientation and Getting Started.
- Replaced the dead **Official Effect → Cookbooks** navigation link: the tagged source has no `cookbooks/` folder, and the only upstream cookbook is published as the official [v4 Schedule cookbook](https://effect.website/docs/v4/scheduling/cookbook).
- `pnpm docs:links` now also checks the navigation menu, the VitePress config and theme, the README, and the agent skills, and names where each failing URL is linked from.
- The recommended `tsconfig.json` targets `ES2025` (with a matching `lib`), and the validation project compiles every example with that target.
- Split the five largest pages: Schema into [Schema](../data/schema), [Schema in Depth](../data/schema-in-depth), and [Schema Tooling & Internals](../data/schema-tooling); [Fibers, Scopes & Runtimes](../foundations/fibers-scopes-runtimes) out of Core Runtime; [Generated-Code Anti-Patterns](../troubleshooting/anti-patterns) out of Troubleshooting; [MCP Servers](../systems/mcp) out of AI; and [Telemetry Export](../operations/telemetry-export) out of Observability. Old deep links to moved sections redirect to their new pages.
- Added six diagrams (fiber and Scope ownership, Layer build and teardown, Cause classification, stream demand and buffering, the durability ladder, and the HttpApi request lifecycle), each with alt text and a caption that carries its meaning in the Markdown twins.
- Added `effect-4-essentials.md`: a generated digest of every concise page and section (about a sixth of the full aggregate), now the default broad read in `llms.txt` and the agent guide.
- Examples are now executed, not only type-checked: 533 of 612 compile examples run to completion, pass under Vitest, or start as servers, and printed values with expected-output comments are asserted. This found and fixed three examples that failed when run: the `ExecutionPlan` example (it called `Effect.runSync` on a plan whose retry schedule is asynchronous), a `TestSchema` failure message, and a `verifyRoundTrip` example on `Schema.FiniteFromString` that fails for `-0`. New behavior probes back thirteen prose claims about caching, queues, scopes, Layers, fibers, races, retries, streams, and Config.
- [Telemetry Export](../operations/telemetry-export) now warns that importing from the `@effect/opentelemetry` root loads every module and needs every OpenTelemetry peer installed; import the one module you use by path otherwise.
- Ran an end-to-end evaluation with ten coding agents against the live site (`evals/agent-runs/2026-10-09/`): all reached a relevant page and five of nine wrote code that passes strict TypeScript and Effect diagnostics and runs. The failures came from Effect 3 names, so `llms.txt`, the essentials digest, and [Generated-Code Anti-Patterns](../troubleshooting/anti-patterns#effect-3-names-that-do-not-exist-in-effect-4) now list the Effect 3 names that do not exist in Effect 4.
- Added this Release History page; `pnpm docs:check` requires an entry for every audited release.
- Validation: 714 fences, all passing strict TypeScript 7 and strict Effect diagnostics; new runtime probes for `Stream.scan` on empty streams, `Effect.retry` with defect causes, and pending interruption over a failed uninterruptible region.

## `effect@4.0.0` — audited 2026-10-01

Edition **4.0** (first edition). Tag [`effect@4.0.0`](https://github.com/Effect-TS/effect/tree/effect%404.0.0), commit `67ba4e46`, published 2026-10-01: the first stable release of Effect 4 and the baseline for every later entry.

### Changes in the handbook

- Audited every page and example against the tagged source; Getting Started covers installation, compiler settings, and the `@stability` model ([PR #2](https://github.com/eugene1g/effect-handbook/pull/2)).
- Added the long-form [MCP deep dive](../deep-dives/exposing-an-effect-application-over-mcp), Markdown twins for every page, `llms.txt`, and the [agent reading protocol](agent-guide) ([PR #2](https://github.com/eugene1g/effect-handbook/pull/2)).
- Routed web-framework intents (Express, Hono, Fastify) to `ManagedRuntime` in the capability catalog ([PR #3](https://github.com/eugene1g/effect-handbook/pull/3)).
- Introduced editions: one handbook per Effect `major.minor`, served at `/<major.minor>/`, with an edition switcher and `versions.json` ([PR #4](https://github.com/eugene1g/effect-handbook/pull/4)).
