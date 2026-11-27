import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity, DurableDeferred } from "effect/workflow";
import {
	CdDeliveryFlow,
	ConvergenceObservation,
	DeliveryFlowFailed,
	PublishRevisionOutcome,
	PullRequestObservation,
	UnsupportedDeliveryFlow,
} from "./CdDeliveryFlow.external.js";
import {
	CdDeliveryRun,
	CompleteDeliveryRun,
	DeliveryRunAlreadyFinal,
	DeliveryRunInvalidTransition,
	FailDeliveryRun,
	RecordDeliveryConvergence,
	RecordDeliveryPullRequestMerged,
	RecordDeliveryPullRequestOpened,
	RecordDeliveryRevisionCommitted,
	RecordDeliveryVerification,
	RollbackDeliveryRun,
} from "./CdDeliveryRun.aggregate.js";
import {
	CdFreight,
	RecordFreightQualification,
} from "./CdFreight.aggregate.js";
import {
	CdStage,
	CompleteStagePromotion,
	FailStagePromotion,
	MarkStageVerifying,
} from "./CdStage.aggregate.js";
import {
	CdVerificationGate,
	VerificationGateFailed,
} from "./ExecuteCdPromotion.saga.js";
import {
	CampTargetId,
	CdPromotionId,
	DeliveryFlowKind,
	DeliveryFlowTarget,
	DeliveryRunId,
	EpochMs,
	FreightDigest,
	NonEmptyReason,
	NonNegativeCount,
	RealizationRef,
	RevisionRef,
	StageId,
} from "./ids.js";

export const PullRequestResolvedSignal = DurableDeferred.make(
	"PullRequestResolved",
	{
		success: PullRequestObservation,
	},
);

export const ConvergenceObservedSignal = DurableDeferred.make(
	"ConvergenceObserved",
	{
		success: ConvergenceObservation,
	},
);

const FlowErrorSchema = Schema.Union([
	DeliveryFlowFailed,
	UnsupportedDeliveryFlow,
]);

const PublishSuccessSchema = Schema.Struct({
	outcome: PublishRevisionOutcome,
});

const PullRequestSuccessSchema = Schema.Struct({
	observation: PullRequestObservation,
});

const ConvergenceSuccessSchema = Schema.Struct({
	observation: ConvergenceObservation,
});

const RollbackFlowSuccessSchema = Schema.Struct({
	rolledBack: Schema.Boolean,
	rollbackRevision: Schema.NullOr(RevisionRef),
	summary: NonEmptyReason,
});

const VerificationGateSuccessSchema = Schema.Struct({
	passed: Schema.Boolean,
	summary: NonEmptyReason,
});

const RunTransitionErrorSchema = Schema.Union([
	DeliveryRunInvalidTransition,
	DeliveryRunAlreadyFinal,
]);

function flowFailureReason(
	failure: typeof FlowErrorSchema.Type,
): NonEmptyReason {
	if (failure._tag === "UnsupportedDeliveryFlow") {
		return NonEmptyReason.make(
			`unsupported-delivery-flow:${failure.flowKind}:${failure.flowTarget}`,
		);
	}
	return failure.reason;
}

export class ExecuteCdDeliveryFlow extends Domain.Saga(
	"ExecuteCdDeliveryFlow",
	{
		key: DeliveryRunId,
		input: {
			stageId: StageId,
			campId: CampTargetId,
			freightDigest: FreightDigest,
			previousRevision: Schema.NullOr(RevisionRef),
			flowKind: DeliveryFlowKind,
			flowTarget: DeliveryFlowTarget,
			implicitHealthVerification: Schema.Boolean,
			triggerPullSync: Schema.Boolean,
			requestedAtMs: EpochMs,
		},
		rejects: [DeliveryRunInvalidTransition, DeliveryRunAlreadyFinal],
	},
	{
		description:
			"Execute a pluggable pull-based or direct CD flow across revision publication, pull-request merge, pull-engine convergence, verification, qualification, and fail-closed rollback.",
	},
) {}

export const ExecuteCdDeliveryFlowLive = ExecuteCdDeliveryFlow.toLayer(
	Effect.gen(function* () {
		const runs = yield* CdDeliveryRun;
		const stages = yield* CdStage;
		const freight = yield* CdFreight;
		const flow = yield* CdDeliveryFlow;
		const gate = yield* CdVerificationGate;

		return Effect.fn(function* ({
			key,
			stageId,
			campId,
			freightDigest,
			previousRevision,
			flowKind,
			flowTarget,
			implicitHealthVerification,
			triggerPullSync,
			requestedAtMs,
		}) {
			const failStageAndRun = (reason: NonEmptyReason) =>
				Effect.gen(function* () {
					yield* Activity.make({
						name: "record-delivery-failure",
						execute: runs
							.send(key, new FailDeliveryRun({ reason }))
							.pipe(Effect.asVoid),
					});
					yield* Activity.make({
						name: "notify-stage-delivery-failure",
						execute: stages
							.send(
								stageId,
								new FailStagePromotion({ deliveryRunId: key, reason }),
							)
							.pipe(Effect.result, Effect.asVoid),
					});
				});

			const rollbackAndNotifyStage = (
				targetRevision: RevisionRef,
				reason: NonEmptyReason,
			) =>
				Effect.gen(function* () {
					const rollback = yield* Activity.make({
						name: "compensate-rollback-revision",
						success: RollbackFlowSuccessSchema,
						error: FlowErrorSchema,
						execute: flow.rollbackRevision({
							deliveryRunId: key,
							stageId,
							campId,
							flowKind,
							flowTarget,
							targetRevision,
							previousRevision,
							reason,
						}),
					}).pipe(Effect.result);

					if (rollback._tag === "Failure") {
						yield* failStageAndRun(
							NonEmptyReason.make(
								`rollback-failed:${flowFailureReason(rollback.failure)}`,
							),
						);
						return;
					}
					if (!rollback.success.rolledBack) {
						yield* failStageAndRun(
							NonEmptyReason.make(
								`rollback-unconfirmed:${rollback.success.summary}`,
							),
						);
						return;
					}
					yield* Activity.make({
						name: "record-delivery-rollback",
						error: RunTransitionErrorSchema,
						execute: runs
							.send(
								key,
								new RollbackDeliveryRun({
									rollbackRevision: rollback.success.rollbackRevision,
									reason,
								}),
							)
							.pipe(Effect.asVoid),
					});
					yield* Activity.make({
						name: "notify-stage-delivery-rollback",
						execute: stages
							.send(
								stageId,
								new FailStagePromotion({ deliveryRunId: key, reason }),
							)
							.pipe(Effect.result, Effect.asVoid),
					});
				});

			const published = yield* Activity.make({
				name: "publish-delivery-revision",
				success: PublishSuccessSchema,
				error: FlowErrorSchema,
				execute: flow.publishRevision({
					deliveryRunId: key,
					stageId,
					campId,
					freightDigest,
					flowKind,
					flowTarget,
					previousRevision,
				}),
			}).pipe(Effect.result);

			if (published._tag === "Failure") {
				yield* failStageAndRun(flowFailureReason(published.failure));
				return;
			}

			let targetRevision: RevisionRef;
			const outcome = published.success.outcome;
			if (outcome._tag === "Committed") {
				targetRevision = outcome.revision;
				yield* Activity.make({
					name: "record-revision-committed",
					error: RunTransitionErrorSchema,
					execute: runs
						.send(
							key,
							new RecordDeliveryRevisionCommitted({
								revision: outcome.revision,
								targetRef: outcome.targetRef,
							}),
						)
						.pipe(Effect.asVoid),
				});
			} else {
				yield* Activity.make({
					name: "record-pull-request-opened",
					error: RunTransitionErrorSchema,
					execute: runs
						.send(
							key,
							new RecordDeliveryPullRequestOpened({
								revision: outcome.revision,
								prId: outcome.prId,
								prUrl: outcome.prUrl,
								headBranch: outcome.headBranch,
								targetRef: outcome.targetRef,
							}),
						)
						.pipe(Effect.asVoid),
				});

				const initialPr = yield* Activity.make({
					name: "observe-pull-request-initial",
					success: PullRequestSuccessSchema,
					error: FlowErrorSchema,
					execute: flow.observePullRequest({
						deliveryRunId: key,
						flowKind,
						flowTarget,
						prId: outcome.prId,
						targetRef: outcome.targetRef,
					}),
				}).pipe(Effect.result);

				if (initialPr._tag === "Failure") {
					yield* failStageAndRun(flowFailureReason(initialPr.failure));
					return;
				}

				const resolvedPr =
					initialPr.success.observation._tag === "Open"
						? yield* DurableDeferred.await(PullRequestResolvedSignal)
						: initialPr.success.observation;

				if (resolvedPr._tag !== "Merged") {
					yield* failStageAndRun(
						NonEmptyReason.make(
							`pull-request-not-merged:${resolvedPr.summary}`,
						),
					);
					return;
				}

				targetRevision = resolvedPr.mergeRevision;
				yield* Activity.make({
					name: "record-pull-request-merged",
					error: RunTransitionErrorSchema,
					execute: runs
						.send(
							key,
							new RecordDeliveryPullRequestMerged({
								prId: outcome.prId,
								mergeRevision: resolvedPr.mergeRevision,
								summary: resolvedPr.summary,
							}),
						)
						.pipe(Effect.asVoid),
				});
			}

			const initialConvergence = yield* Activity.make({
				name: "observe-pull-convergence-initial",
				success: ConvergenceSuccessSchema,
				error: FlowErrorSchema,
				execute: flow.observeConvergence({
					deliveryRunId: key,
					stageId,
					campId,
					flowKind,
					flowTarget,
					targetRevision,
					triggerSync: triggerPullSync,
				}),
			}).pipe(Effect.result);

			if (initialConvergence._tag === "Failure") {
				yield* rollbackAndNotifyStage(
					targetRevision,
					flowFailureReason(initialConvergence.failure),
				);
				return;
			}

			const finalConvergence =
				initialConvergence.success.observation._tag === "Converging"
					? yield* DurableDeferred.await(ConvergenceObservedSignal)
					: initialConvergence.success.observation;

			if (finalConvergence._tag !== "Converged") {
				yield* rollbackAndNotifyStage(
					targetRevision,
					NonEmptyReason.make(
						`pull-convergence-degraded:${finalConvergence.summary}`,
					),
				);
				return;
			}

			yield* Activity.make({
				name: "record-pull-convergence",
				error: RunTransitionErrorSchema,
				execute: runs
					.send(
						key,
						new RecordDeliveryConvergence({
							appliedRevision: finalConvergence.appliedRevision,
							outOfSyncCount: NonNegativeCount.make(0),
							summary: finalConvergence.summary,
						}),
					)
					.pipe(Effect.asVoid),
			});

			yield* Activity.make({
				name: "mark-stage-verifying",
				execute: stages
					.send(stageId, new MarkStageVerifying({ deliveryRunId: key }))
					.pipe(Effect.result, Effect.asVoid),
			});

			const nowMs = requestedAtMs;

			let verificationSummary: NonEmptyReason;
			if (implicitHealthVerification) {
				verificationSummary = finalConvergence.summary;
				yield* Activity.make({
					name: "record-implicit-verification",
					error: RunTransitionErrorSchema,
					execute: runs
						.send(
							key,
							new RecordDeliveryVerification({
								passed: true,
								implicit: true,
								summary: verificationSummary,
								verifiedAtMs: nowMs,
							}),
						)
						.pipe(Effect.asVoid),
				});
			} else {
				const evaluated = yield* Activity.make({
					name: "evaluate-delivery-verification",
					success: VerificationGateSuccessSchema,
					error: VerificationGateFailed,
					execute: gate.evaluate({
						promotionId: CdPromotionId.make(key),
						campId,
						realizationRef: RealizationRef.make(
							finalConvergence.appliedRevision,
						),
					}),
				}).pipe(Effect.result);

				if (evaluated._tag === "Failure" || !evaluated.success.passed) {
					const reason =
						evaluated._tag === "Failure"
							? evaluated.failure.summary
							: evaluated.success.summary;
					yield* Activity.make({
						name: "record-delivery-verification-failure",
						error: RunTransitionErrorSchema,
						execute: runs
							.send(
								key,
								new RecordDeliveryVerification({
									passed: false,
									implicit: false,
									summary: reason,
									verifiedAtMs: nowMs,
								}),
							)
							.pipe(Effect.asVoid),
					});
					yield* rollbackAndNotifyStage(targetRevision, reason);
					return;
				}

				verificationSummary = evaluated.success.summary;
				yield* Activity.make({
					name: "record-delivery-verification-success",
					error: RunTransitionErrorSchema,
					execute: runs
						.send(
							key,
							new RecordDeliveryVerification({
								passed: true,
								implicit: false,
								summary: verificationSummary,
								verifiedAtMs: nowMs,
							}),
						)
						.pipe(Effect.asVoid),
				});
			}

			yield* Activity.make({
				name: "complete-delivery-run",
				error: RunTransitionErrorSchema,
				execute: runs
					.send(key, new CompleteDeliveryRun({ qualifiedAtMs: nowMs }))
					.pipe(Effect.asVoid),
			});

			yield* Activity.make({
				name: "qualify-freight-in-stage",
				execute: freight
					.send(
						freightDigest,
						new RecordFreightQualification({
							stageId,
							deliveryRunId: key,
							qualifiedAtMs: nowMs,
							summary: verificationSummary,
						}),
					)
					.pipe(Effect.result, Effect.asVoid),
			});

			yield* Activity.make({
				name: "complete-stage-promotion",
				execute: stages
					.send(
						stageId,
						new CompleteStagePromotion({
							deliveryRunId: key,
							qualifiedAtMs: nowMs,
							summary: verificationSummary,
						}),
					)
					.pipe(Effect.result, Effect.asVoid),
			});
		});
	}),
);
