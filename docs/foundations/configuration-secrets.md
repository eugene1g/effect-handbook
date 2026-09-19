# Configuration & Secrets

`Config` is an `Effect`, validated by `Schema`, read from a swappable provider. Three-part model: **Config** describes what you need and its shape. **ConfigProvider** decides where values come from. **Redacted**/**Redactable** prevent sensitive values from appearing in logs.

> **Official guides:** [Configuration](https://effect.website/docs/v4/configuration). These track Effect's `main` branch rather than the pinned `rc.116` release, so where they differ, this page and the tagged source win.

## Config

`effect/Config` — stable

`Config<T>` extends `Effect<T, ConfigError>` — read config by `yield*`-ing inside `Effect.gen`; missing/invalid values become a typed `ConfigError`. Convenience constructors (`Config.String`, `Config.Number`, `Config.Finite`, `Config.NonEmptyString`, `Config.Boolean`, `Config.Redacted`, `Config.LogLevel`, and the rest of the [built-in table](#built-in-constructors)) read a single key. Combinators (`Config.all`, `Config.nested`, `Config.withDefault`, `Config.map`, `Config.mapEffect`, `Config.option`) build structured config. `Config.schema(schema, path)` derives loading from the schema's encoded `StringTree`; opaque `Any`, `Unknown`, or JSON-shaped schemas must first be given a concrete string-tree boundary such as `Schema.fromJsonString(Schema.Json)`.

Absence is structural, not merely falsy. A missing representation is decoded as `undefined` before `withDefault` or `option` decides what to do; a successfully decoded `undefined` or explicit empty structure is still a present value. A completely absent `Config.all` group may use an outer default/option, but a partially supplied group is an error. For schema unions, `Config.schema` materializes each encoded `StringTree` member independently rather than guessing one mixed shape.

```ts
import { Config, Effect } from "effect"

// CompService reads three keys: HRIS_URL, MERIT_CYCLE, and a redacted PAYROLL_API_KEY.
// Config.all combines them; Config.nested("COMP") scopes them under a "COMP" prefix,
// so the provider is expected to supply { COMP: { HRIS_URL, MERIT_CYCLE, PAYROLL_API_KEY } }.
const CompServiceConfig = Config.all({
  hrisUrl: Config.String("HRIS_URL"),
  meritCycle: Config.NonEmptyString("MERIT_CYCLE").pipe(Config.withDefault("2025-Q4")),
  payrollApiKey: Config.Redacted("PAYROLL_API_KEY")   // arrives as Redacted<string>
}).pipe(Config.nested("COMP"))

const program = Effect.gen(function*() {
  const cfg = yield* CompServiceConfig   // a Config IS an Effect — just yield* it
  yield* Effect.log(`Connecting to HRIS at ${cfg.hrisUrl}, cycle ${cfg.meritCycle}`)
  // cfg.payrollApiKey is Redacted<string> — safe to pass around, never logs plaintext
})
```

Use for anything sourced from the environment — API endpoints, feature flags, credentials. Define once as a `Config` for validation and testability.

### Built-in constructors

Every constructor takes an optional key name and is a shortcut for `Config.schema(someSchema, name)`. **Prefer these over hand-written parsers**: each setting then carries its unit and its bounds in the config definition. The accept/reject column was probed on `rc.116`.

| Constructor | Yields | Accepts / rejects |
| --- | --- | --- |
| `Config.String`, `Config.NonEmptyString` | `string` | Any text. Blank values are already treated as missing by the built-in providers. |
| `Config.Number` | `number` | Also accepts `NaN` and `Infinity` — **use `Config.Finite` for numeric settings**. |
| `Config.Finite` | finite `number` | `1.5`, `1e3`; rejects `NaN`, `Infinity`. |
| `Config.Int` | integer | `8`, `-3`; rejects `1.5`. Add a range with `Config.schema(Schema.Int.check(...), name)`. |
| `Config.Port` | integer 1–65535 | Rejects `0`, `65536`, `80.5`. |
| `Config.Boolean` | `boolean` | Exactly `true` `false` `yes` `no` `on` `off` `1` `0` `y` `n`, **case-sensitive** — `TRUE` fails. |
| `Config.Duration` | `Duration` | Whatever `Duration.fromInput` parses from text: `"5 seconds"`, `"250 millis"`, `"Infinity"`. Rejects `"5s"` and a bare `"1500"`; **accepts negative spans**, so bound it with a check. |
| `Config.ByteSize` | [`ByteSize`](../data/functional-toolkit#bytesize) | `"10 MiB"` (powers of 1,024), `"10MB"` (powers of 1,000), `"1.5 GiB"`; rejects a bare `"512"`. |
| `Config.URL` | `URL` | Absolute URLs only; `hris.example.com` fails. |
| `Config.Date` | `Date` | Rejects text that produces an invalid `Date`. |
| `Config.LogLevel` | `LogLevel` | `All` `Fatal` `Error` `Warn` `Info` `Debug` `Trace` `None`, case-sensitive. |
| `Config.Literal(value, name?)`, `Config.Literals(values, name?)` | the literal union | The constructor for an explicit mode switch such as `"live" \| "sandbox"`. |
| `Config.Redacted` | `Redacted<string>` | See [Redacted](#redacted). |
| `Config.Array(schema, name?, options?)`, `Config.Record(key, value, name?, options?)` | array / record | See below. |

**Parse an untrusted duration once, at startup, into a `Duration`.** A raw `5` does not say seconds, milliseconds, or attempts; `Config.Duration("HRIS_TIMEOUT")` (or `Schema.DurationFromString` inside a larger schema) makes malformed text a startup `ConfigError`, and the rest of the program passes a `Duration` around. Convert back to a number only where a foreign API demands one (`Duration.toMillis`). See [Duration](../concurrency/scheduling-time#duration).

### Lists and maps from flat values

Environment variables are flat strings, so lists and maps usually arrive delimiter-separated. `Config.Array` and `Config.Record` accept **either** one separated string **or** a structural value, so the same definition works against environment variables and against a test object — and every element is validated by the schema, which a `Config.String` + `split` inside `Config.map` would bypass.

```ts
import { Config, ConfigProvider, Effect, Schema } from "effect"

const PayrollRegions = Config.Array(Schema.Literals(["us", "eu", "apac"]), "PAYROLL_REGIONS")
const BandOwners = Config.Record(Schema.String, Schema.String, "BAND_OWNERS")

const fromEnv = ConfigProvider.fromEnv({
  env: { PAYROLL_REGIONS: "us,eu", BAND_OWNERS: "L4=comp-eng,L5=comp-staff" }
})
const fromObject = ConfigProvider.fromUnknown({
  PAYROLL_REGIONS: ["apac"],
  BAND_OWNERS: { L4: "comp-eng" }
})

const regionsFromEnv = Effect.runSync(PayrollRegions.parse(fromEnv)) // ["us", "eu"]
const regionsFromObject = Effect.runSync(PayrollRegions.parse(fromObject)) // ["apac"]
const owners = Effect.runSync(BandOwners.parse(fromEnv)) // { L4: "comp-eng", L5: "comp-staff" }
```

Both overloads take the path second (`Config.Array(schema, "NAME", { separator: ";" })`) or omit it and pass options directly; `Config.Record` adds `keyValueSeparator` (default `"="`). A bad element fails with its index in the path: `PAYROLL_REGIONS=us,mars` reports `["PAYROLL_REGIONS"][1]`.

> **Note:** Environment-backed providers can also *discover* containers: `ADMINS_0`, `ADMINS_1` form an array and `TLS_CERT`, `TLS_KEY` form a record for `Config.schema(Schema.Struct(...), "TLS")`. Discovery walks variable names split on `_`, so a container's own path segments must not contain `_` — write `Config.schema(schema, ["PAYROLL", "REGIONS"])` or `Config.nested("PAYROLL")`, not `"PAYROLL_REGIONS"`. Leaf lookups join segments with `_` and are unaffected. Only unpadded decimal indices count as array positions (`ADMINS_1`, not `ADMINS_01`).

### Validating more than syntax

Keep every rule inside the `Config` value so the error path (`at ["COMP"]["WORKERS"]`) and the `parse(provider)` boundary survive:

- **Field constraints** — add a check to the schema: `Config.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })), "WORKERS")`.
- **Parsed-value rules** — test the decoded value, never a string prefix: check `url.protocol === "https:"` on the `URL`, not `startsWith("https")` on the text.
- **Cross-field rules** — decode a struct and check it as a whole (certificate and key together, a mode that requires an endpoint).
- **Effectful or fallible transformation** — `Config.mapEffect(f)`, where `f` fails with a `ConfigError`. `Config.map` is for total functions: **a `throw` inside `Config.map` is a defect**, not a `ConfigError`.

```ts
import { Config, Schema } from "effect"

const HttpsUrl = Schema.URL.check(
  Schema.makeFilter((url) => url.protocol === "https:" ? undefined : "expected an https: URL")
)

const Tls = Schema.Struct({
  CERT: Schema.optionalKey(Schema.String),
  KEY: Schema.optionalKey(Schema.String)
}).check(
  Schema.makeFilter((tls) =>
    (tls.CERT === undefined) === (tls.KEY === undefined)
      ? undefined
      : "CERT and KEY must be supplied together"
  )
)

const HrisUrl = Config.schema(HttpsUrl, "HRIS_URL")
// TLS_CERT without TLS_KEY fails with: CERT and KEY must be supplied together at ["TLS"]
const TlsConfig = Config.schema(Tls, "TLS").pipe(Config.withDefault({}))
```

### Absence is not malformed input

A setting has four possible states, and only one of them may fall back:

| State | Policy |
| --- | --- |
| Present and valid | Use it. |
| Absent | Apply the declared default or `Option.none()`, or fail if the key is required. |
| **Present but malformed** | **Fail. Never fall back** — a typo in production must not silently become the default. |
| Source unreadable (`SourceError`) | Fail, unless an explicit outage policy exists. |

The three fallback tools differ in exactly this respect:

| Tool | Falls back when | `PORT=eighty` |
| --- | --- | --- |
| `Config.withDefault(value)`, `Config.option` | The value is absent. Validation errors and partially supplied groups still fail. | `ConfigError` |
| `ConfigProvider.orElse(primary, fallback)` | The primary provider has no value at that path. A `SourceError` from the primary propagates, and a decoding error is never rescued. | `ConfigError` |
| `Config.orElse(() => other)` | **Any** `ConfigError`, including a malformed value or an unreadable source. | the fallback |

```ts
import { Config } from "effect"

// PORT=eighty fails at startup; an unset or blank PORT becomes 3000.
const port = Config.Port("PORT").pipe(Config.withDefault(3000))

// Reserve Config.orElse for a deliberate alternative source, such as a renamed key.
// It still masks a malformed PORT whenever HTTP_PORT is set, so remove it once the rename is done.
const portWithLegacyKey = Config.Port("PORT").pipe(
  Config.orElse(() => Config.Port("HTTP_PORT")),
  Config.withDefault(3000)
)
```

`Config.orElse(() => Config.succeed(3000))` would turn `PORT=eighty` into `3000` and hide a broken deployment. Blank is absent, but whitespace is not: `PORT=" "` is a present, malformed value. An explicit `false` or `0` is a present value too and survives `withDefault`.

## ConfigProvider

`effect/ConfigProvider` — stable

The source a `Config` reads from. Default: process environment. It is a `Context.Reference` you can replace with an in-memory object for tests, a directory of files via `ConfigProvider.fromDir`, or chained providers via `ConfigProvider.orElse`.

Key constructors: `ConfigProvider.fromUnknown(obj)` — synchronous provider from any JSON-compatible object (ideal for tests). `ConfigProvider.fromEnv()` — reads `process.env` (runtime default). `ConfigProvider.fromDir()` — reads a directory tree (k8s secrets), requires `Path` and `FileSystem` in context. `ConfigProvider.layer(provider)` — inject a provider as a `Layer`. `ConfigProvider.orElse(primary, fallback)` — chain two providers.

All built-in providers treat a literal empty string as missing by default, so `Config.option` and `Config.withDefault` work for blank environment variables. Pass `{ preserveEmptyStrings: true }` to `fromEnv`, `fromEnvRecord`, `fromUnknown`, `fromDotEnv`, or `fromDir` when blank is a meaningful value. `fromEnvRecord(record)` is the deterministic environment-style provider for restricted runtimes where reading global `process.env` is unavailable or undesirable. It captures discoverable keys and array lengths when constructed, while reads of those already-known keys observe later value changes; keys added afterward do not appear in parent discovery.

```ts
import { Config, ConfigProvider, Effect } from "effect"

const CompServiceConfig = Config.all({
  hrisUrl: Config.String("HRIS_URL"),
  meritCycle: Config.NonEmptyString("MERIT_CYCLE").pipe(Config.withDefault("2025-Q4")),
  payrollApiKey: Config.Redacted("PAYROLL_API_KEY")
}).pipe(Config.nested("COMP"))

// In tests, supply values explicitly as a nested object — no environment, no mocking.
// ConfigProvider.fromUnknown is synchronous and takes any JSON-compatible object.
const testProvider = ConfigProvider.fromUnknown({
  COMP: {
    HRIS_URL: "http://hris.test",
    MERIT_CYCLE: "2025-Q4",
    PAYROLL_API_KEY: "test-tok-abc123"
  }
})

// Provide the layer so CompServiceConfig reads from testProvider instead of env.
const tested = program.pipe(Effect.provide(ConfigProvider.layer(testProvider)))
```

Note: `ConfigProvider.fromDotEnv()` returns an `Effect<ConfigProvider, PlatformError, FileSystem>` — it is an effectful constructor, not a plain value — because it performs file I/O. Pass it to `ConfigProvider.layer(effect)` to use as a layer.

Use when config must come from somewhere other than env vars, or to inject a fixed in-memory provider in tests.

Also available: `ConfigProvider.fromDotEnvContents(text, { expandVariables? })` parses `.env` text that is already in memory (no `FileSystem`; `${VAR}` expansion is off unless requested, and `rc.116` preserves replacement-pattern tokens such as `$&` inside expanded values). Without an `{ env }` option, `fromEnv()` merges `process.env` with `import.meta.env` when the bundler defines it.

### Resolving one Config against an explicit provider

Every `Config` has `.parse(provider)`, returning `Effect<T, ConfigError>`. It resolves that one definition against the given provider **without installing the provider for anything else** — the lightest way to unit-test a config definition or to read a bootstrap value from a specific source. `ConfigProvider.layer` is the other tool: it changes the provider for everything built or run beneath it.

```ts
import { Config, ConfigProvider, Effect } from "effect"

const ServerConfig = Config.all({
  host: Config.NonEmptyString("HOST"),
  port: Config.Port("PORT")
})

const provider = ConfigProvider.fromUnknown({ HOST: "localhost", PORT: 8080 })

// { host: "localhost", port: 8080 }
const server = Effect.runSync(ServerConfig.parse(provider))

// Failure as data: the ConfigError names the path and the expectation.
const invalid = Effect.runSync(
  Effect.result(ServerConfig.parse(ConfigProvider.fromUnknown({ HOST: "localhost", PORT: 0 })))
)
```

### Precedence and composition

**Write precedence down, highest to lowest, next to the code that composes it** — for example: explicit overrides, then environment, then a mounted secrets directory, then a local `.env`, then `Config`-level defaults. It is a deployment decision (some platforms want mounted secrets above the environment), so it should be reviewable in one place. Never implement it by merging JavaScript objects or by reading `process.env` in application code.

```ts
import { ConfigProvider } from "effect"

declare const cliOverrides: Record<string, unknown>

// Highest to lowest: CLI overrides > environment > checked-in defaults.
const provider = ConfigProvider.fromUnknown(cliOverrides).pipe(
  ConfigProvider.orElse(ConfigProvider.fromEnv()),
  ConfigProvider.orElse(ConfigProvider.fromUnknown({ COMP: { PORT: 8080, WORKERS: 2 } }))
)

// Replace the active provider for everything beneath this Layer.
export const ConfigLive = ConfigProvider.layer(provider)

// Or keep whatever is installed (the environment by default) and stack around it:
export const DefaultsBehind = ConfigProvider.layerAdd(
  ConfigProvider.fromUnknown({ COMP: { PORT: 8080 } })
)
export const OverridesInFront = ConfigProvider.layerAdd(
  ConfigProvider.fromUnknown(cliOverrides),
  { asPrimary: true }
)
```

| API | Effect |
| --- | --- |
| `ConfigProvider.orElse(primary, fallback)` | Consults `fallback` only for paths where `primary` has no value. |
| `ConfigProvider.layer(provider)` | **Replaces** the active provider. Accepts a provider or an `Effect` that produces one (evaluated once, when the layer is built). |
| `ConfigProvider.layerAdd(provider)` | Keeps the active provider as primary and adds `provider` as its fallback. |
| `ConfigProvider.layerAdd(provider, { asPrimary: true })` | Puts `provider` in front; the previously active provider becomes the fallback. |
| `ConfigProvider.nested(prefix)` | Prefixes every lookup: `["HOST"]` resolves `APP_HOST` for prefix `"APP"`. |
| `ConfigProvider.constantCase` | Lets code ask for `databaseHost` while the environment holds `DATABASE_HOST`. |
| `ConfigProvider.mapInput(f)` | The general path transform behind the two above. Transforms compose in application order, and on an `orElse` chain they apply to every operand. |
| `ConfigProvider.make(get)` | A provider over a custom store. Return `undefined` for a missing path, build values with `makeValue(string)`, and fail with `SourceError` **only** when the source cannot be read — a source failure must not look like absence. |

- **Keep key mapping in one place** (`constantCase`, `nested`, `mapInput` on the provider) so an operator can predict the external name of every setting.
- **A provider fallback and a `Config` default are different decisions.** The first is a lower-priority *source*; the second is a semantic default in the typed contract. Do not fold them into one expression.
- **A provider Layer reaches only what is built or run beneath it.** `Layer.mergeAll(Hris.layer, ConfigLive)` compiles, yet `Hris.layer` still reads the default environment provider, because `ConfigProvider` is a reference and never appears in `R`. Wire it as `Hris.layer.pipe(Layer.provide(ConfigLive))`, or provide `ConfigLive` last (outermost) at the program edge.

## Designing the startup contract

**One `Config` value defines what a valid deployment looks like** — required keys, defaults, numeric bounds, duration syntax, and which values are secrets. A second hand-written parser, or scattered `process.env` reads, creates two definitions of "valid" that drift.

```ts
import { ByteSize, Config, Context, Duration, Effect, Layer, Schema } from "effect"

const Workers = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))

const PollInterval = Schema.DurationFromString.check(
  Schema.makeFilter((interval) =>
    Duration.between(interval, { minimum: Duration.seconds(1), maximum: Duration.minutes(10) })
      ? undefined
      : "expected a duration between 1 second and 10 minutes"
  )
)

export const MeritCycleConfig = Config.all({
  mode: Config.Literals(["live", "sandbox"], "MODE"), // explicit, required
  hrisUrl: Config.URL("HRIS_URL"),
  port: Config.Port("PORT").pipe(Config.withDefault(8080)),
  pollInterval: Config.schema(PollInterval, "POLL_INTERVAL"),
  workers: Config.schema(Workers, "WORKERS"),
  maxUpload: Config.ByteSize("MAX_UPLOAD").pipe(Config.withDefault(ByteSize.mebibytes(10))),
  auditEnabled: Config.Boolean("AUDIT_ENABLED").pipe(Config.withDefault(true)),
  payrollApiKey: Config.Redacted("PAYROLL_API_KEY"), // secret, required, no default
  slackWebhook: Config.option(Config.Redacted("SLACK_WEBHOOK")) // optional: both branches handled
}).pipe(Config.nested("COMP"))

// The typed result becomes a service, decoded once when the graph is built.
export class AppConfig extends Context.Service<AppConfig, Config.Success<typeof MeritCycleConfig>>()(
  "hr/AppConfig"
) {
  static readonly layer = Layer.effect(AppConfig, MeritCycleConfig)
}

interface HrisPool {
  readonly close: Effect.Effect<void>
}
declare const openHrisPool: (url: URL, size: number) => Effect.Effect<HrisPool>

export class HrisConnections extends Context.Service<HrisConnections, HrisPool>()("hr/HrisConnections") {
  // Depends on AppConfig, so no pool is opened until the whole contract has decoded.
  static readonly layer = Layer.effect(HrisConnections, Effect.gen(function*() {
    const config = yield* AppConfig
    return yield* Effect.acquireRelease(
      openHrisPool(config.hrisUrl, config.workers),
      (pool) => pool.close
    )
  })).pipe(Layer.provide(AppConfig.layer))
}
```

### Deciding required, optional, and defaulted

Inventory each setting: external name, type and constraints, required or not, who owns the default, secret or not, reloadable or not. Then:

| Make it | When |
| --- | --- |
| **Required** | The promised capability cannot run safely without it. |
| **Optional** (`Config.option`) | Absence has a domain meaning and the code handles both branches. |
| **Defaulted** (`Config.withDefault`) | One safe value is valid in every environment, or a local/test profile owns it explicitly. |

- **Some settings must never have a silent default**: credentials, public bind addresses and exposure, production origins and CORS lists, destructive modes, durability switches, authentication, and telemetry destinations. Never ship placeholder credentials.
- **Select live versus fake infrastructure from an explicit mode** (`Config.Literals(["live", "sandbox"], "MODE")`), not from whether a token happens to be present.
- **Decode every supplied field, even in a disabled branch.** A disabled feature with a malformed endpoint is a deployment error, not something to skip.
- **Do not treat `""`, whitespace, `"false"`, `0`, and absence as equivalent.** The built-in providers make only the empty string mean "missing"; everything else is a present value.

### Install configuration before anything that depends on it

Order the startup: providers, then precedence and key mapping, then the typed application config and its cross-field checks, then configured clients, pools, and servers, then readiness.

- **A configuration failure must cause zero resource acquisitions**, a non-zero exit, no readiness signal, and a diagnostic that names the path and the expected form. Layers merged side by side build concurrently, so a pool that does *not* depend on the typed config can open before a sibling's config error arrives (probed). Make resource Layers depend on the typed config service, as `HrisConnections` does above, and the ordering is structural.
- **Keep validation lazy.** Decode inside the Layer that builds the app and validate options inside Effect-returning constructors; throwing at module load runs before any provider is installed and cannot be tested through a provider.
- **Do not re-read static config per request, and do not wrap individual consumers in their own provider Layers** — that repeats decoding and blurs precedence. Decode once; hand each adapter the typed subset it owns rather than one giant object.
- **`ConfigError` text is safe to print.** `Config` parses without `reportInput`, so the rendered error carries the path and the expectation (`Expected a value between 1 and 64 at ["COMP"]["WORKERS"]`), not the offending input.
- **Reloadable settings are a stateful service, not a second read.** They need an owner (a watcher or poller with a scope), validate-then-atomically-publish, an explicit last-known-good or fail-closed choice, and tests. [`Resource`](services-context-layers#resource) and [`LayerRef`](services-context-layers#layerref) are the building blocks.

### Testing the contract

Give each test its own in-memory provider through `config.parse(provider)` or `ConfigProvider.layer(ConfigProvider.fromUnknown({...}))`. **Never mutate `process.env` or inherit the developer's shell**; use a temporary directory for `fromDotEnv` / `fromDir` adapters.

| Case | Expected |
| --- | --- |
| Required key missing | `ConfigError` naming the path |
| Malformed value (`PORT=eighty`), with and without a default | `ConfigError` — never the default |
| Zero, negative, above the upper bound | `ConfigError` from the check |
| Fractional where an integer is required (`WORKERS=1.5`) | `ConfigError` |
| Explicit `false` and explicit `0` against a `withDefault` | The explicit value survives |
| Primary source valid / absent / malformed / unreadable, fallback valid | primary / fallback / decode failure / source failure |
| Every pair of sources that operations can make collide | The documented precedence wins |
| Nested and `constantCase` key mapping, empty strings, URLs, literals | The documented external names resolve |

At acceptance level, start the packaged build once per configuration case (complete, absent, unparseable, and conflicting values) and assert readiness, exit code, and that no secret canary appears in the output (see [Redacted](#redacted)). Test-layer mechanics live in [Testing & Dev Tooling](../tooling/testing-dev-tooling) and [Testing an Effect Application](../deep-dives/testing-an-effect-application).

## Redacted

`effect/Redacted` — stable

`Redacted<string>` holds a secret value; stringifying, logging, or inspecting it prints `<redacted>`. The real value is only accessible via `Redacted.value`.

```ts
import { Redacted } from "effect"

// Wrap the payroll API token the moment it enters the service.
const payrollToken = Redacted.make("payroll-sk-9f3a...")

console.log(`${payrollToken}`)            // "<redacted>"
console.log(JSON.stringify(payrollToken)) // "<redacted>"

// Only unwrap at the call site that actually needs the raw bytes.
const rawToken = Redacted.value(payrollToken) // "payroll-sk-9f3a..."
```

Use for any sensitive value — API keys, tokens, passwords. Pair with `Config.Redacted` so secrets are wrapped on entry, never stored as plain strings.

> **Warning:** `Redacted` is accidental-disclosure hygiene, not secrecy. It keeps a value out of `String(...)`, template literals, `JSON.stringify`, inspection, and loggers. It does not encrypt memory, files, or the environment, and it does not validate scope or expiry. The result of `Redacted.value` is an ordinary string that can be logged, serialized, or captured in an error `cause` like any other — and so can anything *derived* from it.

- **Call `Redacted.value` only as the argument of the narrow adapter that needs the raw value** (the client constructor, the `Authorization` header builder). Do not store the result in a field, close over it, return it, interpolate it, or put it in an error payload, log annotation, or span attribute.
- **Never log the whole config at startup.** Log the non-secret settings you chose to expose.
- **Test with a canary.** Inject a unique marker as every secret, run startup and one failing request, and scan rendered `ConfigError`s, pretty-printed `Cause`s, captured logs, stdout/stderr, snapshots, and serialized payloads for it. `String(redacted) === "<redacted>"` alone proves nothing about the code around it. Also assert that the adapter *did* receive the raw value.

### Labels, comparison, and wiping

```ts
import { Equal, Equivalence, Redacted } from "effect"

const token = Redacted.make("bootstrap-abc", { label: "BOOTSTRAP_TOKEN" })
const rendered = String(token) // "<redacted:BOOTSTRAP_TOKEN>"

// Compare secrets without unwrapping them at the call site.
const sameToken = Redacted.makeEquivalence(Equivalence.strictEqual<string>())
const matches = sameToken(token, Redacted.make("bootstrap-abc")) // true
const alsoMatches = Equal.equals(token, Redacted.make("bootstrap-abc")) // true: Equal compares the hidden values

// Shorten a credential's lifetime after the one call that needs it.
const wiped = Redacted.wipeUnsafe(token) // true; Redacted.value(token) now throws
```

`Redacted.wipeUnsafe` removes the hidden value from the internal registry; a later `Redacted.value` throws `Unable to get redacted value` (with the label appended when there is one). Use it after exchanging a bootstrap token, and only when no other holder of the same `Redacted` instance still needs it.

### Secrets that arrive through a schema

A secret in a decoded payload — a login body, a webhook signing key, a stored credential — should never exist as a plain domain field.

| Schema | Input | Encodes back to |
| --- | --- | --- |
| `Schema.RedactedFromValue(inner, options?)` | The raw value; decodes it with `inner`, then wraps it. | **The plaintext**, unless `{ disallowEncode: true }`. |
| `Schema.Redacted(inner, options?)` | A value that is already `Redacted`; decodes its contents with `inner` and rewraps the result. | A `Redacted` of the `inner`-encoded contents — but its JSON codec (`Schema.toCodecJson`) writes **the plaintext**, unless `{ disallowJsonEncode: true }`. |

The two option names really are different. Both schemas also accept `label`. Since `rc.116`, `Schema.Redacted` keeps what `inner` transforms: `Schema.Redacted(Schema.NumberFromString)` decodes `Redacted.make("42")` to a `Redacted<number>` holding `42` and encodes it back to a `Redacted<string>`, preserving the label (earlier releases validated the contents but returned the original `Redacted` unchanged).

```ts
import { Config, Redacted, Schema } from "effect"

const Login = Schema.Struct({
  user: Schema.String,
  password: Schema.RedactedFromValue(Schema.NonEmptyString, { disallowEncode: true })
})

const login = Schema.decodeUnknownSync(Login)({ user: "ada", password: "correct-horse" })
const safeToLog = JSON.stringify(login) // {"user":"ada","password":"<redacted>"}
const raw = Redacted.value(login.password) // unwrap only at the call that verifies it

// Schema.encodeSync(Login)(login) now fails with "Cannot encode Redacted" instead of
// writing the password into a response, a queue message, or a database row.

// Non-string secrets: decode, then seal.
const BadgePin = Config.schema(Schema.RedactedFromValue(Schema.FiniteFromString), "BADGE_PIN")
```

> **Warning:** Without `disallowEncode` / `disallowJsonEncode`, any response, persistence, or RPC codec derived from the same schema writes the secret back out in clear text. Set the option on every schema whose encoded side leaves the process, or keep secrets out of encodable models entirely.

Official guides: [Redacted](https://effect.website/docs/v4/data-types/redacted) (its headings say `unsafeWipe` and `getEquivalence`; the `rc.116` names are `Redacted.wipeUnsafe` and `Redacted.makeEquivalence`), [Effect Data Types](https://effect.website/docs/v4/schema/effect-data-types) (Schema; see its Redacted section, which does not mention that `RedactedFromValue` spells the option `disallowEncode`).

## Redactable

`effect/Redactable` — stable

The protocol behind `Redacted`. Implement `Redactable` on your own types to control how they appear when logged, traced, or inspected. The implementing method receives the current fiber's `Context` and returns the replacement value used for logging and inspection. `Redacted` is the built-in implementer.

The symbol to implement is `Redactable.symbolRedactable` (exported as a named constant, not as `Redactable.symbol`). The method receives a `Context.Context<never>`.

```ts
import { Context, Redactable, Redacted } from "effect"

// A domain type that hides its token whenever it is rendered.
// Use Redactable.symbolRedactable (not Redactable.symbol) as the method key.
class PayrollCredential {
  readonly serviceId: string
  private readonly token: string

  constructor(serviceId: string, token: string) {
    this.serviceId = serviceId
    this.token = token
  }

  [Redactable.symbolRedactable](_ctx: Context.Context<never>) {
    // Safe representation: keep the service identifier, mask the secret.
    return { serviceId: this.serviceId, token: Redacted.make(this.token) }
  }
}

// Logging a PayrollCredential shows serviceId but "<redacted>" for the token.
const cred = new PayrollCredential("payroll-svc", "sk-live-abc...")
```

Use when your own domain types carry secrets and you want them inherently log-safe, rather than relying on call-site discipline.

> **Tip:** The combo to internalize: read secrets with `Config.Redacted("PAYROLL_API_KEY")` → they arrive as `Redacted<string>` → they stay sealed through your whole program → you only `Redacted.value` them at the exact moment you hand them to `PayrollClient`. The key never touches a log line by accident.
