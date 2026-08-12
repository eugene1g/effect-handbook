// deep-dives/streaming-ingestion-without-accidental-buffering.md:78-97
import { Schema } from "effect"

export const EmployeeId = Schema.String.pipe(Schema.brand("EmployeeId"))

export class EmployeeRow extends Schema.Class<EmployeeRow>("EmployeeRow")({
  employeeId: EmployeeId,
  cycleId: Schema.String,
  salary: Schema.Finite.check(Schema.isGreaterThan(0)),
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))
}) {}

export class ImportSourceError extends Schema.TaggedError<ImportSourceError>()(
  "ImportSourceError",
  { message: Schema.String }
) {}

export class ImportStoreError extends Schema.TaggedError<ImportStoreError>()(
  "ImportStoreError",
  { message: Schema.String }
) {}
