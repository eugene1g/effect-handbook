// deep-dives/testing-an-effect-application.md:18-63
import { Context, Effect, Layer, Schema } from "effect"

export interface Approval {
  readonly employeeId: string
  readonly cycleId: string
  readonly amount: number
}

export class ApprovalConflict extends Schema.TaggedError<ApprovalConflict>()(
  "ApprovalConflict",
  { employeeId: Schema.String, cycleId: Schema.String }
) {}

export class NotificationUnavailable extends Schema.TaggedError<NotificationUnavailable>()(
  "NotificationUnavailable",
  {}
) {}

export class ApprovalRepo extends Context.Service<ApprovalRepo, {
  readonly save: (approval: Approval) => Effect.Effect<void, ApprovalConflict>
}>()("app/ApprovalRepo") {}

export class ApprovalNotifier extends Context.Service<ApprovalNotifier, {
  readonly send: (approval: Approval) => Effect.Effect<void, NotificationUnavailable>
}>()("app/ApprovalNotifier") {}

export class ApprovalService extends Context.Service<ApprovalService, {
  readonly approve: (
    approval: Approval
  ) => Effect.Effect<void, ApprovalConflict | NotificationUnavailable>
}>()("app/ApprovalService") {
  static readonly layer = Layer.effect(
    ApprovalService,
    Effect.gen(function*() {
      const repo = yield* ApprovalRepo
      const notifier = yield* ApprovalNotifier

      return ApprovalService.of({
        approve: Effect.fn("ApprovalService.approve")(function*(approval) {
          yield* repo.save(approval)
          yield* notifier.send(approval)
        })
      })
    })
  )
}
