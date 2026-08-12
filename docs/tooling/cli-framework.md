# CLI Framework

The CLI modules define parsers, help, completions, prompts, and command handlers as typed values that compose with ordinary Effects and Layers. Import the barrel with `import { Argument, Command, Flag, Prompt } from "effect/unstable/cli"`, or use the module paths shown in each section.

> **Warning:** The framework lives under `effect/unstable/cli`; pin the Effect version because this surface can change between minor releases. The release-matched [`ai-docs` CLI example](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.108/ai-docs/src/70_cli) provides a compact runnable companion.

## CliConfig

`effect/unstable/cli/CliConfig` — unstable

A fiber-scoped `Context.Reference` controlling runner-wide CLI behavior. Its service contains the ordered list of built-in global flags installed by `Command.run`; the default is `GlobalFlag.BuiltIns`. Earlier action flags have precedence.

```ts
import { Effect } from "effect"
import { CliConfig, Command, GlobalFlag } from "effect/unstable/cli"

const app = Command.make("comp", {}, () => Effect.void)

// Keep help, version, and completions, but do not accept --log-level.
const withoutLogLevel = CliConfig.layer({
  builtIns: GlobalFlag.BuiltIns.filter((flag) => flag !== GlobalFlag.LogLevel)
})

const program = Command.run(app, { version: "1.0.0" }).pipe(
  Effect.provide(withoutLogLevel)
)
```

`CliConfig.make(options)` returns a value merged over the defaults; `CliConfig.layer(options)` provides it for parsing, help generation, and command execution. This only controls built-ins — application-specific global flags still attach with `Command.withGlobalFlags`.

**Reach for it when** embedding a CLI, constraining its global surface, or removing a built-in flag that conflicts with your application.

## Command

`effect/unstable/cli/Command` — unstable

A `Command<Name, Input, ContextInput, E, R>` is both a typed description of how to parse a command's flags and arguments and an Effect that yields its parsed input when run. Subcommands can `yield* parentCommand` inside their handlers to read the parent's typed config without prop-drilling.

Mental model: a command declares what it needs from the CLI (config shape), what it returns (handler Effect), and how it composes with siblings (subcommands) and ancestors (shared flags). `Command.make(name, config, handler)` is the constructor; all other methods decorate it.

Flags declared with `Command.withSharedFlags` are visible to every subcommand handler; a subcommand reads them via `const root = yield* comp`.

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"

// Reusable flag — share it across commands
const outputFormat = Flag.choice("format", ["table", "json", "csv"]).pipe(
  Flag.withAlias("f"),
  Flag.withDescription("Output format for results"),
  Flag.withDefault("table" as const)
)

// Root command: declares shared flags visible to all subcommands
const comp = Command.make("comp").pipe(
  Command.withSharedFlags({
    format: outputFormat,
    verbose: Flag.boolean("verbose").pipe(
      Flag.withAlias("v"),
      Flag.withDescription("Print diagnostic output")
    )
  }),
  Command.withDescription("Compensation administration CLI")
)

// Subcommand: grant equity to an employee
const grant = Command.make(
  "grant",
  {
    employee: Flag.string("employee").pipe(
      Flag.withAlias("e"),
      Flag.withDescription("Employee ID (e.g. e-42)")
    ),
    shares: Flag.integer("shares").pipe(
      Flag.withDescription("Number of RSU shares to grant")
    ),
    cliff: Flag.string("cliff").pipe(
      Flag.withDescription("Cliff period, e.g. 12mo"),
      Flag.withDefault("12mo")
    )
  },
  Effect.fn(function*({ employee, shares, cliff }) {
    // Access parent's shared flags by yielding the parent command
    const root = yield* comp
    if (root.verbose) {
      yield* Console.log(`format=${root.format} action=grant`)
    }
    yield* Console.log(
      `Granted ${shares} RSUs to ${employee} with ${cliff} cliff`
    )
  })
).pipe(
  Command.withDescription("Grant equity (RSUs) to an employee"),
  Command.withExamples([
    {
      command: "comp grant --employee e-42 --shares 1000 --cliff 12mo",
      description: "Grant 1 000 RSUs to employee e-42 with a 12-month cliff"
    }
  ])
)

// Subcommand: start a merit review cycle
const reviewStart = Command.make(
  "start",
  {
    cycle: Flag.string("cycle").pipe(
      Flag.withDescription("Merit cycle ID, e.g. 2025-Q1"),
      Flag.withDefault("current")
    ),
    budget: Flag.integer("budget").pipe(
      Flag.withDescription("Approved merit budget in USD")
    )
  },
  Effect.fn(function*({ cycle, budget }) {
    const root = yield* comp
    if (root.verbose) {
      yield* Console.log(`format=${root.format} action=review/start`)
    }
    yield* Console.log(`Merit review cycle "${cycle}" started — budget $${budget}`)
  })
).pipe(
  Command.withDescription("Start a new merit review cycle"),
  Command.withAlias("s")   // comp review s --budget 500000
)

// Group review actions under a "review" parent subcommand
const review = Command.make("review").pipe(
  Command.withDescription("Manage merit review cycles"),
  Command.withSubcommands([reviewStart])
)

// Wire subcommands and run
comp.pipe(
  Command.withSubcommands([grant, review]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
```

> **Tip:** Use `Command.withSharedFlags` for typed values that child handlers read by yielding their parent command. Use `Command.withGlobalFlags` for runner-wide actions or settings rather than ordinary parsed command input.

### Key combinators

| Combinator | Purpose |
| --- | --- |
| `Command.make(name, config, handler)` | Constructor — name + typed config + optional inline handler |
| `Command.withHandler(fn)` | Attach or replace the handler after construction |
| `Command.withSubcommands([...])` | Register child commands (union of their errors/requirements flows up) |
| `Command.withSharedFlags({...})` | Parent flags visible inside all subcommand handlers |
| `Command.withGlobalFlags([...])` | Attach `GlobalFlag` instances (settings, not shared input) |
| `Command.withDescription(s)` | Long description shown in `--help` |
| `Command.withShortDescription(s)` | One-liner shown in parent's subcommand list |
| `Command.withAlias(s)` | Alternate invocation name (`review start` → `review s`) |
| `Command.unlisted` | Keep a command invocable but omit it from normal listings/help |
| `Command.withExamples([...])` | Curated examples shown at the bottom of `--help` |
| `Command.provide(layer)` | Provide a Layer to the handler (static or derived from parsed input) |
| `Command.provideEffect(effect)` | Run an effect before the handler and provide its result as a service |
| `Command.run({ version })` | Convert to a runnable `Effect` (reads argv from `Stdio`) |
| `Command.runWith(cmd, cfg)(args)` | Run with an explicit `string[]` — great for testing |

> **Testing:** `Command.runWith(rootCmd, { version: "1.0.0" })(["grant", "--employee", "e-42", "--shares", "1000"])` runs against explicit `argv`; provide `NodeServices.layer` when the command needs host services.

Use when you need a type-safe CLI application with subcommands, help generation, and shell completions.

## Flag

`effect/unstable/cli/Flag` — unstable

A `Flag<A>` is a typed parser for named CLI options (`--verbose`, `--shares 1000`). Flags are composable: chain `Flag.withDefault` to make optional, `Flag.optional` to get `Option<A>`, `Flag.withFallbackConfig` to satisfy from an environment variable when absent. Boolean flags: `--dry-run` alone means `true`; `--no-dry-run` negates it.

```ts
import { Config } from "effect"
import { Flag, Prompt } from "effect/unstable/cli"

// Boolean: --dry-run / --no-dry-run
const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("Simulate without writing changes")
)

// Integer: number of RSU shares
const shares = Flag.integer("shares").pipe(
  Flag.withAlias("s"),
  Flag.withDescription("Number of RSU shares"),
  Flag.withDefault(500)
)

// Constrained enum: target merit cycle
const cycleKind = Flag.choice("kind", ["rsu", "option", "bonus"]).pipe(
  Flag.withDescription("Grant type"),
  Flag.withDefault("rsu" as const)
)

// Fall back to an env-var when the flag is absent
const hrisToken = Flag.string("hris-token").pipe(
  Flag.withFallbackConfig(Config.string("HRIS_API_TOKEN"))
)

// Redacted string — value is masked in help and logs
const apiSecret = Flag.redacted("api-secret")

// Optional — yields Option<string>, None when omitted
const note = Flag.string("note").pipe(Flag.optional)

// Key-value map: --label team=eng --label region=us -> Record<string, string>
const labels = Flag.keyValuePair("label").pipe(
  Flag.withDescription("Attach metadata labels to the grant")
)

// Fall back to an interactive prompt when the flag is absent.
// Pass the Prompt directly — no callback wrapper needed.
const employeeId = Flag.string("employee").pipe(
  Flag.withFallbackPrompt(
    Prompt.text({ message: "Employee ID: " })
  )
)
```

### Flag constructors at a glance

Key APIs: Flag.string, Flag.boolean, Flag.integer, Flag.float, Flag.date, Flag.choice, Flag.choiceWithValue, Flag.path, Flag.file, Flag.directory, Flag.redacted, Flag.fileText, Flag.fileParse, Flag.fileSchema, Flag.keyValuePair

Use when you need named `--` options for type-safe command configuration.

## Argument

`effect/unstable/cli/Argument` — unstable

Positional command-line arguments — values without a `--name` prefix. `Argument<A>` is structurally identical to `Flag<A>` with nearly the same constructor surface; the distinction is named vs positional.

Arguments resolve in declaration order. `Argument.variadic` collects all remaining positionals into an array. Only one variadic argument is allowed per command, and it must be last.

```ts
import { Argument } from "effect/unstable/cli"

// Required positional: the employee ID to look up
const employeeArg = Argument.string("employee-id").pipe(
  Argument.withDescription("Employee ID (e.g. e-42)")
)

// Optional positional: an output file path
const outFile = Argument.string("output-file").pipe(
  Argument.optional   // yields Option<string>
)

// Variadic — collect 1+ employee IDs for a bulk operation
const employeeIds = Argument.string("employee-ids").pipe(
  Argument.variadic,
  Argument.withDescription("One or more employee IDs to process")
)

// Read a comp-plan JSON file directly from a positional path
const planFile = Argument.fileText("plan-path").pipe(
  Argument.withDescription("Path to the comp plan JSON file")
)

// Parse positional as a chosen enum value
const reviewAction = Argument.choice("action", ["start", "close", "reopen"])
```

> **Tip:** Options can appear before or after positional arguments: both `comp grant e-42 --shares 1000` and `comp grant --shares 1000 e-42` are accepted.

Use when the natural invocation uses positional subjects (file paths, resource IDs) rather than `--name <value>` flags.

## Param

`effect/unstable/cli/Param` — unstable

The shared machinery powering both `Flag` and `Argument`. A `Param<Kind, A>` carries a `Kind` type tag (`"flag"` or `"argument"`) determining tokenisation. All combinators (`withDefault`, `optional`, `map`, `mapEffect`, `filter`, `withFallbackConfig`, `withFallbackPrompt`, `withSchema`) are implemented once in `Param` and re-exported by both `Flag` and `Argument` (`variadic` is on `Argument` only).

Rarely imported directly in application code — use `Flag` and `Argument` instead. Relevant when building custom param combinators or reading the parsing internals.

- **Param.Single** — Leaf param backed by one `Primitive` value parser. Has a name, optional aliases, optional metavar for help text.

- **Param.Map / Transform** — Wraps a param with a pure or effectful transformation; implements `Flag.map`, `Flag.mapEffect`, `Flag.filter`.

- **Param.Optional** — Wraps a param, changing its result from `A` to `Option<A>`. Succeeds with `None` when the token is absent.

- **Param.Variadic** — Allows a param to appear 0–N (or min–max) times, collecting results into `ReadonlyArray<A>`.

Use when building abstractions over the CLI library — custom combinators that work for both flags and arguments, or inspecting param structure for documentation generation.

## Primitive

`effect/unstable/cli/Primitive` — unstable

Leaf-level value parsers converting raw CLI strings into typed TypeScript values. Each `Flag.*` and `Argument.*` constructor wraps a `Primitive`. A `Primitive<A>` is essentially `(rawString: string) => Effect<A>` with a display name; the framework derives shell completion types from `_tag`.

- **Primitive.string** — Identity: accepts any string.

- **Primitive.boolean** — Accepts `true/false/yes/no/on/off/1/0`. Recognises `--no-<flag>` canonical negation.

- **Primitive.integer / float** — Schema-validated numeric parsers. Produces a structured `InvalidValue` error on bad input.

- **Primitive.date** — Parses ISO-8601 date strings into `Date`.

- **Primitive.choice** — Restricts value to a fixed string set; drives completion script's value list.

- **Primitive.path / file / directory** — Validates existence and type (`file | directory | either`) against the real filesystem at parse time.

- **Primitive.redacted** — Returns `Redacted<string>`; masked in help output and Effect logging.

- **Primitive.fileText / fileParse / fileSchema** — Reads a file at the given path and returns its text, parsed INI/JSON/TOML/YAML, or Schema-decoded value. `fileParse()` infers from `.ini`, `.json`, `.toml`, `.yaml`, or `.yml`; `{ format }` overrides detection.

- **Primitive.keyValuePair** — Parses `KEY=VALUE` pairs; multiple appearances merge into `Record<string, string>`.

Use when inspecting what type a flag or argument represents (e.g. documentation generation or custom completion logic) — `_tag` is the canonical discriminant.

## Prompt

`effect/unstable/cli/Prompt` — unstable

Interactive terminal prompts. A `Prompt<A>` is an Effect that runs a TUI render loop and yields a typed value on confirmation. Prompts compose with `Effect.gen`, chain with `Prompt.flatMap`, and collect with `Prompt.all`.

Each prompt has three phases: render (write ANSI), process (receive keypress, return next state or final value), clear (erase frame). The CLI connection is `Flag.withFallbackPrompt`: when a required flag is absent, the prompt runs automatically. Pass the `Prompt` or an `Effect` yielding one directly.

```ts
import { Effect } from "effect"
import { Flag, Prompt } from "effect/unstable/cli"

// Text input — for capturing an employee's new title on promotion
const titlePrompt = Prompt.text({ message: "New job title: " })

// Password — masked input for the HRIS API token
const hrisTokenPrompt = Prompt.password({ message: "HRIS API token: " })

// Yes/No confirm — guard a raise that exceeds the pay band
const confirmAboveBand = Prompt.confirm({
  message: "Salary exceeds band midpoint by > 20%. Proceed anyway?",
  initial: false
})

// Select from a list — choose a performance rating
const ratingPrompt = Prompt.select({
  message: "Performance rating",
  choices: [
    { title: "Exceeds expectations", value: "exceeds" },
    { title: "Meets expectations",   value: "meets" },
    { title: "Below expectations",   value: "below" }
  ]
})

// Toggle — approve or reject a raise recommendation
const approvalToggle = Prompt.toggle({
  message: "Approve raise recommendation?",
  active: "approve",
  inactive: "reject",
  initial: true
})

// Multi-select — pick which comp components to adjust
const componentsPrompt = Prompt.multiSelect({
  message: "Adjust compensation components",
  choices: [
    { title: "Base salary",  value: "base" },
    { title: "Bonus target", value: "bonus" },
    { title: "RSU grant",    value: "equity" }
  ]
})

// Chain prompts: an interactive raise-approval wizard
const raiseWizard = Effect.gen(function*() {
  const rating   = yield* ratingPrompt
  const approved = yield* approvalToggle
  if (approved) {
    const aboveBand = yield* confirmAboveBand
    return { rating, approved, aboveBand }
  }
  return { rating, approved, aboveBand: false }
})

// Fallback prompt on a flag: if --employee is omitted, the prompt fires.
// Pass the Prompt directly — no callback wrapper.
const employeeFlag = Flag.string("employee").pipe(
  Flag.withFallbackPrompt(Prompt.text({ message: "Employee ID: " }))
)
```

### Built-in prompt types

Key APIs: Prompt.text, Prompt.password, Prompt.hidden, Prompt.confirm, Prompt.select, Prompt.autoComplete, Prompt.multiSelect, Prompt.toggle, Prompt.integer, Prompt.float, Prompt.date, Prompt.list, Prompt.file, Prompt.custom

> **Example:** The `employeeFlag` above accepts `--employee e-42`; when the flag is omitted, it asks for the employee id interactively.

Use when you want wizard-style interactive CLIs or need to prompt for a required value absent from the environment.

## HelpDoc

`effect/unstable/cli/HelpDoc` — unstable

The intermediate data structure for a command's help page. Captures description, usage line, flag/argument docs, global flag docs, subcommand listing, and examples — before any string formatting. Rendering is delegated to `CliOutput.Formatter`.

`HelpDoc` is to `--help` output what `Schema` is to JSON serialization: a structured description renderable multiple ways (plain text, ANSI, Markdown, JSON). The CLI framework builds it automatically from the command tree; inspect or transform it for custom tooling.

```ts
import { Context, Option as O } from "effect"
import type { HelpDoc } from "effect/unstable/cli"

// HelpDoc is plain data — construct it manually for testing or tooling.
// Note: subcommands is ReadonlyArray<HelpDoc.SubcommandGroupDoc>, not a flat list.
const grantCommandHelp: HelpDoc.HelpDoc = {
  description: "Grant RSUs or options to an employee",
  usage: "comp grant [options]",
  annotations: Context.empty(),
  flags: [
    {
      name: "employee",
      aliases: ["-e"],
      type: "string",
      description: O.some("Employee ID (e.g. e-42)"),
      required: true
    },
    {
      name: "shares",
      aliases: ["-s"],
      type: "integer",
      description: O.some("Number of RSU shares to grant"),
      required: true
    },
    {
      name: "cliff",
      aliases: [],
      type: "string",
      description: O.some("Cliff period, e.g. 12mo"),
      required: false
    }
  ],
  args: [],
  globalFlags: [],
  subcommands: [],   // ReadonlyArray<SubcommandGroupDoc>
  examples: [
    {
      command: "comp grant --employee e-42 --shares 1000 --cliff 12mo",
      description: "Grant 1 000 RSUs with a 12-month cliff"
    }
  ]
}
```

Use when implementing a custom `CliOutput.Formatter`, generating Markdown documentation from the CLI tree, or building tooling requiring structured access to the help model.

## Completions

`effect/unstable/cli/Completions` — unstable

Shell completion script generator. Given a `CommandDescriptor`, `Completions.generate` returns a static completion script string for Bash, Zsh, or Fish.

Rarely called directly. `GlobalFlag.Completions` wires it automatically: `comp --completions bash` prints a script users can source. Completion-aware types (`choice`, `path`, `file`, `directory`) produce richer tab-completion suggestions automatically.

```bash
# Install completions for the comp-admin CLI (once)
comp --completions bash >> ~/.bash_completion
comp --completions zsh  >> ~/.zshrc
comp --completions fish > ~/.config/fish/completions/comp.fish
```

To generate completions programmatically (e.g. in a build script or test):

```ts
import { Completions } from "effect/unstable/cli"

const descriptor: Completions.CommandDescriptor = {
  name: "comp",
  description: "Compensation administration CLI",
  flags: [
    {
      name: "format",
      aliases: ["-f"],
      description: "Output format",
      type: { _tag: "Choice", values: ["table", "json", "csv"] }
    }
  ],
  arguments: [],
  subcommands: [
    {
      name: "grant",
      description: "Grant equity to an employee",
      flags: [
        {
          name: "employee",
          aliases: ["-e"],
          description: "Employee ID",
          type: { _tag: "String" }
        },
        {
          name: "shares",
          aliases: ["-s"],
          description: "Number of RSU shares",
          type: { _tag: "Integer" }
        },
        {
          name: "cliff",
          aliases: [],
          description: "Cliff period",
          type: { _tag: "String" }
        }
      ],
      arguments: [],
      subcommands: []
    },
    {
      name: "review",
      description: "Manage merit review cycles",
      flags: [],
      arguments: [],
      subcommands: [
        {
          name: "start",
          description: "Start a new merit review cycle",
          flags: [
            {
              name: "budget",
              aliases: [],
              description: "Approved merit budget in USD",
              type: { _tag: "Integer" }
            }
          ],
          arguments: [],
          subcommands: []
        }
      ]
    }
  ]
}

const bashScript = Completions.generate("comp", "bash", descriptor)
const zshScript  = Completions.generate("comp", "zsh",  descriptor)
const fishScript = Completions.generate("comp", "fish", descriptor)
```

Use when you need programmatic completion script access. For normal CLIs, `GlobalFlag.Completions` handles it automatically.

## GlobalFlag

`effect/unstable/cli/GlobalFlag` — unstable

Built-in and user-defined flags that intercept parsing before the normal handler runs. A global flag is either an `Action` (runs a side-effect and exits) or a `Setting` (provides a context service to the handler). Built-ins: `Help`, `Version`, `Wizard`, `Completions`, `LogLevel`.

Global flags have higher precedence than all other parsing. `Action` globals exit; `Setting` globals inject a context value (e.g. `LogLevel` sets the minimum log level for the handler's Effect runtime).

Constructors: `GlobalFlag.action({ flag, run })` for action flags; curried `GlobalFlag.setting(id)({ flag })` for setting flags. A setting is a `Context.Service` the handler can `yield*` to read the parsed value.

```ts
import { Effect } from "effect"
import { Command, Flag, GlobalFlag } from "effect/unstable/cli"

// --- Custom action flag: print the license and exit ---
const licenseFlag = GlobalFlag.action({
  flag: Flag.boolean("license").pipe(
    Flag.withDescription("Print license information")
  ),
  run: (_value, _ctx) => Effect.log("MIT License — Copyright 2025 CompAdmin Authors")
})

// --- Custom setting flag: dry-run mode as a context service ---
// GlobalFlag.setting is curried: setting(id)({ flag })
const dryRunSetting = GlobalFlag.setting("dry-run")({
  flag: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Simulate writes without committing changes")
  )
})

// Access a setting value inside a handler by yielding the setting object:
const grantCmd = Command.make(
  "grant",
  { shares: Flag.integer("shares") },
  Effect.fn(function*({ shares }) {
    // dryRunSetting is a Context.Service — yield it to get the boolean
    const isDryRun = yield* dryRunSetting
    if (isDryRun) {
      yield* Effect.log(`[dry-run] Would grant ${shares} shares`)
    } else {
      yield* Effect.log(`Granting ${shares} shares`)
    }
  })
)

// Attach the custom globals to the command
const grantWithGlobals = grantCmd.pipe(
  Command.withGlobalFlags([licenseFlag, dryRunSetting])
)
```

### Built-in globals

| Flag | Type | Effect |
| --- | --- | --- |
| `--help / -h` | Action | Renders help doc and exits |
| `--version / -v` | Action | Prints `name version` and exits |
| `--wizard` | Action | Runs the interactive wizard for the selected command |
| `--completions <shell>` | Action | Prints completion script and exits |
| `--log-level <level>` | Setting | Sets runtime minimum log level |

> **Note:** `GlobalFlag.BuiltIns` is ordered `Help`, `Version`, `Wizard`, `Completions`, `LogLevel`; the first present action wins. `Command.withGlobalFlags` attaches application-specific actions or settings to a command and its descendants.

Use when you need a flag that short-circuits command dispatch or provides context-level configuration to every handler in the tree.

## CliError

`effect/unstable/cli/CliError` — unstable

The typed error union for the CLI parser. `CliError.CliError` is what `Command.run` may fail with — a discriminated union covering every parser and runner failure mode. `NodeRuntime.runMain` handles these automatically (formats, prints, exits 1); match on `_tag` when embedding a CLI in a larger Effect application or writing integration tests.

| Error class | When it fires |
| --- | --- |
| `UnrecognizedOption` | A `--flag` was passed that no command recognises. Includes Levenshtein suggestions. |
| `DuplicateOption` | A non-variadic flag appeared more than once. |
| `MissingOption` | A required flag was absent and had no default or fallback. |
| `MissingArgument` | A required positional argument was absent. |
| `UnexpectedArgument` | Extra positional arguments remained after parsing. |
| `InvalidValue` | A value failed Primitive parsing (e.g. "abc" for an integer flag). |
| `UnknownSubcommand` | The first token didn't match any known subcommand. Includes suggestions. |
| `UserError` | A handler or parameter transform explicitly wrapped a failure for safe CLI rendering; carries `cause` and an optional `userMessage`. |
| `ShowHelp` | Requests help rendering, either for explicit `--help` (no errors, exit 0) or parse/validation failures (errors attached, exit 1). |

```ts
import { Effect } from "effect"
import { CliError, Command, Flag } from "effect/unstable/cli"
import { NodeServices } from "@effect/platform-node"

const grant = Command.make(
  "grant",
  {
    employee: Flag.string("employee"),
    shares: Flag.integer("shares")
  },
  ({ employee, shares }) => Effect.log(`Granted ${shares} shares to ${employee}`)
)

const program = grant.pipe(
  Command.run({ version: "1.0.0" }),
  Effect.catchTags({
    InvalidValue: (e) =>
      Effect.log(`Bad value for "${e.option}": ${e.value} — expected ${e.expected}`),
    MissingOption: (e) =>
      Effect.log(`Required flag missing: --${e.option}`)
  }),
  // Command.run renders ShowHelp before re-failing it; catch it only if this
  // embedding must recover instead of letting NodeRuntime choose the exit code.
  Effect.provide(NodeServices.layer)
)
```

Use when embedding a CLI runner in a larger Effect program and needing to distinguish parse errors, user errors, and help requests, or when asserting on specific error conditions in tests.

## CliOutput

`effect/unstable/cli/CliOutput` — unstable

The formatting service for CLI output — help pages, error messages, version strings. `CliOutput.Formatter` is a `Context.Reference` service with a `defaultFormatter`; override with `CliOutput.layer(myFormatter)` to customise all CLI output.

`HelpDoc` is the data; `CliOutput.Formatter` is the renderer. Swap the formatter for colourless output in CI, Markdown in a doc generator, or JSON for machine-readable help.

```ts
import { Effect } from "effect"
import { CliOutput } from "effect/unstable/cli"

// Build a plain-text (no-colour) formatter — useful in CI pipelines
const plainFormatter = CliOutput.defaultFormatter({ colors: false })

const program = Effect.gen(function*() {
  const fmt = yield* CliOutput.Formatter
  // Manually format a version string
  console.log(fmt.formatVersion("comp", "1.0.0"))
}).pipe(
  Effect.provide(CliOutput.layer(plainFormatter))
)

// Custom formatter — emit JSON for machine-readable help tooling
const jsonFormatter: CliOutput.Formatter = {
  formatHelpDoc:  (doc)           => JSON.stringify(doc, null, 2),
  formatCliError: (err)           => JSON.stringify({ error: err._tag, message: err.message }),
  formatError:    (err)           => JSON.stringify({ error: err._tag, message: err.message }),
  formatVersion:  (name, version) => JSON.stringify({ name, version }),
  formatErrors:   (errs)          => JSON.stringify(errs.map((e) => ({ tag: e._tag, message: e.message })))
}
```

Use when you need colourless CI output, machine-readable help (JSON/Markdown), or programmatic CLI metadata formatting — override the default formatter rather than post-processing printed strings.
