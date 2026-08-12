# Configuration & Secrets

`Config` is an `Effect`, validated by `Schema`, read from a swappable provider. Three-part model: **Config** describes what you need and its shape. **ConfigProvider** decides where values come from. **Redacted**/**Redactable** prevent sensitive values from appearing in logs.

## Config

`effect/Config` — stable

`Config<T>` extends `Effect<T, ConfigError>` — read config by `yield*`-ing inside `Effect.gen`; missing/invalid values become a typed `ConfigError`. Convenience constructors (`Config.string`, `Config.number`, `Config.finite`, `Config.nonEmptyString`, `Config.boolean`, `Config.redacted`, `Config.logLevel`) read a single key. Combinators (`Config.all`, `Config.nested`, `Config.withDefault`, `Config.map`, `Config.option`) build structured config. `Config.schema(schema, path)` derives loading from the schema's encoded `StringTree`; opaque `Any`, `Unknown`, or JSON-shaped schemas must first be given a concrete string-tree boundary such as `Schema.fromJsonString(Schema.Json)`.

Absence is structural, not merely falsy. A missing representation is decoded as `undefined` before `withDefault` or `option` decides what to do; a successfully decoded `undefined` or explicit empty structure is still a present value. A completely absent `Config.all` group may use an outer default/option, but a partially supplied group is an error. For schema unions, `Config.schema` materializes each encoded `StringTree` member independently rather than guessing one mixed shape.

```ts
import { Config, Effect } from "effect"

// CompService reads three keys: HRIS_URL, MERIT_CYCLE, and a redacted PAYROLL_API_KEY.
// Config.all combines them; Config.nested("COMP") scopes them under a "COMP" prefix,
// so the provider is expected to supply { COMP: { HRIS_URL, MERIT_CYCLE, PAYROLL_API_KEY } }.
const CompServiceConfig = Config.all({
  hrisUrl: Config.string("HRIS_URL"),
  meritCycle: Config.nonEmptyString("MERIT_CYCLE").pipe(Config.withDefault("2025-Q4")),
  payrollApiKey: Config.redacted("PAYROLL_API_KEY")   // arrives as Redacted<string>
}).pipe(Config.nested("COMP"))

const program = Effect.gen(function*() {
  const cfg = yield* CompServiceConfig   // a Config IS an Effect — just yield* it
  yield* Effect.log(`Connecting to HRIS at ${cfg.hrisUrl}, cycle ${cfg.meritCycle}`)
  // cfg.payrollApiKey is Redacted<string> — safe to pass around, never logs plaintext
})
```

Use for anything sourced from the environment — API endpoints, feature flags, credentials. Define once as a `Config` for validation and testability.

## ConfigProvider

`effect/ConfigProvider` — stable

The source a `Config` reads from. Default: process environment. It is a `Context.Reference` you can replace with an in-memory object for tests, a directory of files via `ConfigProvider.fromDir`, or chained providers via `ConfigProvider.orElse`.

Key constructors: `ConfigProvider.fromUnknown(obj)` — synchronous provider from any JSON-compatible object (ideal for tests). `ConfigProvider.fromEnv()` — reads `process.env` (runtime default). `ConfigProvider.fromDir()` — reads a directory tree (k8s secrets), requires `Path` and `FileSystem` in context. `ConfigProvider.layer(provider)` — inject a provider as a `Layer`. `ConfigProvider.orElse(primary, fallback)` — chain two providers.

All built-in providers treat a literal empty string as missing by default, so `Config.option` and `Config.withDefault` work for blank environment variables. Pass `{ preserveEmptyStrings: true }` to `fromEnv`, `fromEnvRecord`, `fromUnknown`, `fromDotEnv`, or `fromDir` when blank is a meaningful value. `fromEnvRecord(record)` is the deterministic environment-style provider for restricted runtimes where reading global `process.env` is unavailable or undesirable. It captures discoverable keys and array lengths when constructed, while reads of those already-known keys observe later value changes; keys added afterward do not appear in parent discovery.

```ts
import { Config, ConfigProvider, Effect } from "effect"

const CompServiceConfig = Config.all({
  hrisUrl: Config.string("HRIS_URL"),
  meritCycle: Config.nonEmptyString("MERIT_CYCLE").pipe(Config.withDefault("2025-Q4")),
  payrollApiKey: Config.redacted("PAYROLL_API_KEY")
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

Use for any sensitive value — API keys, tokens, passwords. Pair with `Config.redacted` so secrets are wrapped on entry, never stored as plain strings.

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

> **Tip:** The combo to internalize: read secrets with `Config.redacted("PAYROLL_API_KEY")` → they arrive as `Redacted<string>` → they stay sealed through your whole program → you only `Redacted.value` them at the exact moment you hand them to `PayrollClient`. The key never touches a log line by accident.
