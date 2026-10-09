# Recipe: Schema to HttpApi to SQL

Use one domain Schema across the HTTP contract and SQL result decoder, while keeping transport decoding and database access at their respective boundaries.

## Contract

- **Classification:** Runnable example; complete `employees-api.ts`. It uses an in-process HttpApi client and an embedded PGlite database, so no port or external database is required.
- **Install:** `pnpm add effect@4.0.2 @effect/sql-pglite@4.0.2`
- **Run:** Node 26+: `node employees-api.ts`
- **Expected output:** `[{"id":1,"name":"Ada","email":"ada@example.com"}]`.
- **Core handler type:** after `EmployeeRepository` is supplied, the HttpApi handler Layer has no business-service requirement. `SqlSchema` retains `SchemaError | SqlError | NoSuchElementError`; this recipe treats those as invariant/infrastructure defects at the repository boundary, so endpoint handlers expose no declared domain error.
- **Runnable program type:** `Effect<ReadonlyArray<Employee>, SqlError, never>` because building the embedded database Layer can fail.
- **Required Layers:** PGlite supplies generic `SqlClient`; `EmployeeRepositoryLive` uses it; HttpApiTest additionally needs `Path`, `FileSystem`, `Etag.Generator`, and `HttpPlatform` test Layers.
- **Lifetime and interruption:** PGlite and the HttpApi test pipeline are scoped by their Layers. Interrupting the caller stops its Effect-side continuation; closing the scope closes the managed embedded database. A `SqlClient.withTransaction` region rolls back on failure or interruption.

## Complete file

**Runnable example.**

<!-- effect-example id=schema-httpapi-sql check=run runtime=schema-httpapi-sql -->
```ts
import { PgliteClient } from "@effect/sql-pglite"
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Etag, HttpPlatform } from "effect/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiTest
} from "effect/http-api"
import { SqlClient, SqlSchema } from "effect/sql"

class Employee extends Schema.Class<Employee>("Employee")({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String,
  email: Schema.String
}) {}

class EmployeesApi extends HttpApiGroup.make("employees")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Employee,
      success: Employee
    }),
    HttpApiEndpoint.get("list", "/", {
      success: Schema.Array(Employee)
    })
  )
  .prefix("/employees")
{}

class Api extends HttpApi.make("employee-api").add(EmployeesApi) {}

class EmployeeRepository extends Context.Service<EmployeeRepository, {
  readonly create: (employee: Employee) => Effect.Effect<Employee>
  readonly list: Effect.Effect<Array<Employee>>
}>()("app/EmployeeRepository") {}

const EmployeeRepositoryLive = Layer.effect(
  EmployeeRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const insert = SqlSchema.findOne({
      Request: Employee,
      Result: Employee,
      execute: (employee) => sql`
        insert into employees (id, name, email)
        values (${employee.id}, ${employee.name}, ${employee.email})
        returning id, name, email
      `
    })

    const selectAll = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Employee,
      execute: () => sql`select id, name, email from employees order by id`
    })

    return EmployeeRepository.of({
      // A malformed database row or SQL failure is not part of this tiny API's
      // declared domain contract. A production API may instead map selected
      // SQL errors to explicit Schema.TaggedError endpoint errors.
      create: (employee) => insert(employee).pipe(Effect.orDie),
      list: selectAll(undefined).pipe(Effect.orDie)
    })
  })
)

const EmployeesHandlers = HttpApiBuilder.group(
  Api,
  "employees",
  Effect.fn(function*(handlers) {
    const repository = yield* EmployeeRepository
    return handlers
      .handle("create", ({ payload }) => repository.create(payload))
      .handle("list", () => repository.list)
  })
).pipe(Layer.provide(EmployeeRepositoryLive))

const DatabaseLive = PgliteClient.layer()

const Migrations = Layer.effectDiscard(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      create table employees (
        id integer primary key,
        name text not null,
        email text not null unique
      )
    `
  })
)

// Both branches receive the same named database Layer value, so one managed
// client is shared within this build graph.
const ApplicationLive = Layer.merge(EmployeesHandlers, Migrations).pipe(
  Layer.provide(DatabaseLive)
)

const HttpTestServices = Layer.mergeAll(
  Path.layer,
  Etag.layerWeak,
  HttpPlatform.layer
).pipe(
  Layer.provideMerge(FileSystem.layerNoop({}))
)

const apiProgram = Effect.scoped(
  Effect.gen(function*() {
    const client = yield* HttpApiTest.groups(Api, ["employees"])
    yield* client.employees.create({
      payload: new Employee({
        id: 1,
        name: "Ada",
        email: "ada@example.com"
      })
    })
    return yield* client.employees.list()
  })
).pipe(Effect.orDie)

const runnable = apiProgram.pipe(
  Effect.provide(Layer.merge(ApplicationLive, HttpTestServices))
)

console.log(JSON.stringify(await Effect.runPromise(runnable)))
```

## Why these primitives?

`Employee` is the decoded domain value and the shared contract. HttpApi derives request decoding, response encoding, the typed client, routing, and OpenAPI shape from it. `SqlSchema` encodes requests before execution and decodes unknown driver rows back into `Employee`, preventing unchecked database objects from leaking inward. `SqlClient` remains an injected capability, so PGlite can be replaced by PostgreSQL without changing repository or handler code.

`HttpApiTest.groups` exercises real request encoding, routing, response encoding, and client decoding without opening a socket. It is stronger than directly invoking the handler and faster than an external integration server.

## Production variation: a repository error and a declared conflict

The complete file turns every storage failure into a defect, which is right for a demo and too blunt for a service: a duplicate email is an outcome the caller can act on. The middle path keeps three things separate — what the repository owns, what the endpoint publishes, and what stays a defect.

```ts
import { type Cause, Context, Data, Effect, Layer, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { SqlClient, type SqlError, SqlSchema } from "effect/sql"

class Employee extends Schema.Class<Employee>("Employee")({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.String,
  // The rule lives on the contract: HttpApi rejects a malformed email with 400 before the handler runs.
  email: Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/))
}) {}

// Public: declared on the endpoint, serialized to clients — a tag and a safe identifier only.
class EmployeeEmailTaken extends Schema.TaggedError<EmployeeEmailTaken>()(
  "EmployeeEmailTaken",
  { email: Schema.String },
  { httpApiStatus: 409 }
) {}

// Internal: one stable repository failure that keeps the diagnostic cause. Never declared on an endpoint.
class RepositoryError extends Data.TaggedError("RepositoryError")<{
  readonly operation: string
  readonly cause: SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError
}> {
  violates(constraint: string): boolean {
    return this.cause._tag === "SqlError" &&
      this.cause.reason._tag === "UniqueViolation" &&
      this.cause.reason.constraint === constraint
  }
}

class EmployeeRepository extends Context.Service<EmployeeRepository, {
  readonly create: (employee: Employee) => Effect.Effect<Employee, RepositoryError>
}>()("app/EmployeeRepository") {}

export const EmployeeRepositoryLive = Layer.effect(
  EmployeeRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const insert = SqlSchema.findOne({
      Request: Employee,
      Result: Employee,
      execute: (employee) =>
        sql`insert into employees (id, name, email)
            values (${employee.id}, ${employee.name}, ${employee.email})
            returning id, name, email`
    })
    return EmployeeRepository.of({
      // mapError touches only the typed channel; defects and interruption pass through untouched.
      create: (employee) =>
        insert(employee).pipe(
          Effect.mapError((cause) => new RepositoryError({ operation: "create", cause }))
        )
    })
  })
)

class Api extends HttpApi.make("employee-api").add(
  HttpApiGroup.make("employees").add(
    HttpApiEndpoint.post("create", "/employees", {
      payload: Employee,
      success: Employee,
      error: EmployeeEmailTaken
    })
  )
) {}

export const EmployeesHandlers = HttpApiBuilder.group(
  Api,
  "employees",
  Effect.fn(function*(handlers) {
    const repository = yield* EmployeeRepository
    return handlers.handle("create", ({ payload }) =>
      repository.create(payload).pipe(
        Effect.catchTag("RepositoryError", (error) =>
          error.violates("employees_email_key")
            ? Effect.fail(new EmployeeEmailTaken({ email: payload.email })) // an intentional 409
            : Effect.die(error)) // anything else: a sanitized 500, the full Cause in the server log
      ))
  })
)
```

Probed on PGlite with the table declared as `constraint employees_email_key unique (email)`: a second employee with the same email fails the typed client with `EmployeeEmailTaken`, while a duplicate *primary key* — also a `UniqueViolation` — stays a defect. Matching on the reason tag alone would have reported the wrong conflict; name your constraints and match on them.

- **Use `Effect.mapError`, not `Effect.catchCause`, at the repository seam.** `catchCause` also captures defects and interruption, so a programming bug would be reported as a routine storage failure and a shutdown could be swallowed.
- **Absence is a successful empty result.** Map `NoSuchElementError` to a declared `404` only for a lookup that ran and found nothing; a timeout or a lost connection is never "not found".
- **Decide what an unknown request field means.** By default HttpApi drops a property the payload schema does not declare, so a client's misspelled optional field is silently ignored. Annotating the API with `HttpApi.ParseOptions` `{ onExcessProperty: "error" }` turns it into the same `400` as any other decode failure, matching the `additionalProperties: false` the OpenAPI document already advertises ([HttpApi](../interfaces/http-api#httpapi)).
- **Split the schemas the moment they diverge.** One `Employee` for the endpoint and the row decoder is honest while the public shape and the table coincide. When the table gains an internal column, or a field is renamed, keep a row schema for `SqlSchema` and a DTO for the endpoint, and map between them in the repository — the public contract must not move because a column did.
- The status table behind these choices is in [HttpApi status mapping](../interfaces/http-api#status-mapping-is-part-of-the-contract); repository error normalization is in [SqlError](../interfaces/sql#sqlerror); making related writes atomic, and delivering side effects only after commit, is the [transactional write with outbox recipe](transactional-write-with-outbox).

## Proving the boundary

`HttpApiTest` proves codecs, routing, and status mapping, but its typed client cannot send malformed input — encoding fails locally first. To prove that validation lives on the contract, send a raw request through `HttpRouter.toWebHandler` and assert both the `400` and that a counting repository fake was never called; the full test is in [What each test ring proves](../interfaces/http-api#what-each-test-ring-proves).

## Common wrong alternative

Do not cast driver rows to `Employee`, manually parse JSON in handlers, interpolate untrusted SQL text with string concatenation, or define separate request/response/database interfaces that silently drift. Parameterize values with the `sql` tag, decode every untrusted boundary with Schema, and map only intentional database failures into declared endpoint errors; unexpected invariant failures should remain visible.
