import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

export class CompRecord extends Schema.Class<CompRecord>("CompRecord")({ employeeId: Schema.Int }) {}
const getComp = HttpApiEndpoint.get("getComp", "/employees/:id", { params: { id: Schema.FiniteFromString }, success: CompRecord })
class CompGroup extends HttpApiGroup.make("comp").add(getComp) {}
export class Api extends HttpApi.make("fixture-test-api").add(CompGroup) {}
