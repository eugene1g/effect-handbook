import { Schema } from "effect"

export const EmployeeId = Schema.Int

export class Employee extends Schema.Class<Employee>("Employee")({
  id: EmployeeId,
  name: Schema.String,
  level: Schema.Int,
  baseSalary: Schema.Finite
}) {}

export class RaiseInput extends Schema.Class<RaiseInput>("RaiseInput")({
  amount: Schema.Finite
}) {}

export class GrantInput extends Schema.Class<GrantInput>("GrantInput")({
  employeeId: EmployeeId,
  shares: Schema.Natural
}) {}

export class CompRecord extends Schema.Class<CompRecord>("CompRecord")({
  employeeId: EmployeeId,
  level: Schema.Int,
  baseSalary: Schema.Finite
}) {}

export class EmployeeNotFound extends Schema.TaggedError<EmployeeNotFound>()(
  "EmployeeNotFound",
  {},
  { httpApiStatus: 404 }
) {}

export class BandViolation extends Schema.TaggedError<BandViolation>()(
  "BandViolation",
  { message: Schema.String },
  { httpApiStatus: 422 }
) {}
