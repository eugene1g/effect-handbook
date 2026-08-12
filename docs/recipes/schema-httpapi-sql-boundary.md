# Recipe: Schema to HttpApi to SQL

Use one domain Schema across the HTTP contract and SQL result decoder, while keeping transport decoding and database access at their respective boundaries.

## Contract

- **Classification:** Runnable example; complete `employees-api.ts`. It uses an in-process HttpApi client and an embedded PGlite database, so no port or external database is required.
- **Install:** `pnpm add effect@4.0.0-rc.108 @effect/sql-pglite@4.0.0-rc.108`
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
import { Etag, HttpPlatform } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiTest
} from "effect/unstable/httpapi"
import { SqlClient, SqlSchema } from "effect/unstable/sql"

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

## Common wrong alternative

Do not cast driver rows to `Employee`, manually parse JSON in handlers, interpolate untrusted SQL text with string concatenation, or define separate request/response/database interfaces that silently drift. Parameterize values with the `sql` tag, decode every untrusted boundary with Schema, and map only intentional database failures into declared endpoint errors; unexpected invariant failures should remain visible.
