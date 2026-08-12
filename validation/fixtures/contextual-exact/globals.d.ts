interface Employee {
  readonly id: string
  readonly level: string
}

interface Manager {
  readonly id: number
}

interface EmployeeNotFound {
  readonly _tag: "EmployeeNotFound"
}

declare const CompService: {
  readonly layer: import("effect").Layer.Layer<never>
}
declare const ReviewService: {
  readonly layer: import("effect").Layer.Layer<never>
}
declare class Hris extends import("effect").Context.Tag("fixture/Hris")<Hris, {}>() {
  static readonly layer: import("effect").Layer.Layer<Hris>
  static readonly layerSandbox: import("effect").Layer.Layer<Hris>
}
declare const CompPlanningServer: import("effect").Layer.Layer<never>

declare const CompBandLayer: import("effect").Layer.Layer<{ readonly CompData: unique symbol }, never, { readonly DeptConfig: unique symbol }>
declare const configForDepartment: (departmentId: string) => import("effect").Layer.Layer<{ readonly DeptConfig: unique symbol }>
declare const lookupEmployee: (
  employeeId: string
) => import("effect").Effect.Effect<{ readonly employeeId: string; readonly salary: number }>
declare const validateAgainstBand: (
  employee: { readonly employeeId: string; readonly salary: number }
) => import("effect").Effect.Effect<boolean>

interface CompBand {
  readonly max: number
}
interface HrisUnavailable {
  readonly _tag: "HrisUnavailable"
}
declare const fetchCompBandsFromHris: import("effect").Effect.Effect<
  ReadonlyMap<number, CompBand>,
  HrisUnavailable
>
declare const hris: {
  readonly getEmployee: (
    id: string
  ) => import("effect").Effect.Effect<{ readonly level: number; readonly baseSalary: number }>
}
declare class BandViolation {
  readonly _tag: "BandViolation"
  constructor(fields: { readonly employeeId: string; readonly proposedSalary: number })
}

declare const program: import("effect").Effect.Effect<unknown, unknown, unknown>
declare const firstResult: import("effect").Ordering.Ordering
declare const secondResult: import("effect").Ordering.Ordering
declare const org: { readonly departments: ReadonlyArray<{ readonly headcount: number }> }
declare const employee: { readonly managerId?: string }
declare const someBytes: Uint8Array<ArrayBuffer>
declare const someStr: string

declare const runMeritBatch: import("effect").Effect.Effect<void>
declare const calculateAllRaises: import("effect").Effect.Effect<void>
declare const fetchCompBand: (
  employeeId: string
) => import("effect").Effect.Effect<{ readonly max: number }>
declare const fetchPerformanceRating: (
  employeeId: string,
  cycleId: string
) => import("effect").Effect.Effect<string>
declare const computeRaise: (
  band: { readonly max: number },
  rating: string
) => import("effect").Effect.Effect<number>
declare const runPayrollExport: import("effect").Effect.Effect<void>
declare const webhookHeaders: {
  readonly "x-trace-id": string
  readonly "x-span-id": string
}
declare const processHrisEvent: import("effect").Effect.Effect<void>
declare const mainEffect: import("effect").Effect.Effect<void>
declare const Main: import("effect").Layer.Layer<never>

declare const Department: {
  readonly client: import("effect").Effect.Effect<(
    departmentId: string
  ) => {
    readonly RecordRaise: (request: {
      readonly employeeId: string
      readonly amount: import("effect").BigDecimal.BigDecimal
    }) => import("effect").Effect.Effect<import("effect").BigDecimal.BigDecimal>
  }>
}
