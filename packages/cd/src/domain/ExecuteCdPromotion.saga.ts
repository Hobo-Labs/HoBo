import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import {
	ApprovalRequiredBeforeRealize,
	CdPromotion,
	CompleteCdPromotion,
	FailCdPromotion,
	PromotionAlreadyFinal,
	RealizationRequiredBeforeVerify,
	RecordCdRealization,
	RecordCdVerification,
	RollbackCdPromotion,
	RollbackRequiresRealization,
	VerificationRequiredBeforeComplete,
} from "./CdPromotion.aggregate.js";
import {
	CampTargetId,
	CdPromotionId,
	FreightDigest,
	NonEmptyReason,
	RealizationRef,
} from "./ids.js";

export class CampRealizationFailed extends Domain.Rejection(
	"CampRealizationFailed",
	{
		campId: CampTargetId,
		reason: NonEmptyReason,
	},
) {}

export class VerificationGateFailed extends Domain.Rejection(
	"VerificationGateFailed",
	{
		summary: NonEmptyReason,
	},
) {}

export class CdCampRealizer extends Domain.ExternalSystem("CdCampRealizer", {
	realizeCamp: {
		args: {
			promotionId: CdPromotionId,
			campId: CampTargetId,
			freightDigest: FreightDigest,
		},
		success: {
			realizationRef: RealizationRef,
		},
		error: [CampRealizationFailed],
	},
	rollbackCamp: {
		args: {
			promotionId: CdPromotionId,
			campId: CampTargetId,
			realizationRef: RealizationRef,
		},
		success: {
			rolledBack: Schema.Boolean,
		},
		error: [CampRealizationFailed],
	},
}) {}

export class CdVerificationGate extends Domain.ExternalSystem(
	"CdVerificationGate",
	{
		evaluate: {
			args: {
				promotionId: CdPromotionId,
				campId: CampTargetId,
				realizationRef: RealizationRef,
			},
			success: {
				passed: Schema.Boolean,
				summary: NonEmptyReason,
			},
			error: [VerificationGateFailed],
		},
	},
) {}

const RealizationResultSchema = Schema.Struct({
	realizationRef: RealizationRef,
});

const VerificationResultSchema = Schema.Struct({
	passed: Schema.Boolean,
	summary: NonEmptyReason,
});

const RollbackResultSchema = Schema.Struct({
	rolledBack: Schema.Boolean,
});

export class ExecuteCdPromotion extends Domain.Saga(
	"ExecuteCdPromotion",
	{
		key: CdPromotionId,
		input: {
			campId: CampTargetId,
			freightDigest: FreightDigest,
		},
		rejects: [
			ApprovalRequiredBeforeRealize,
			RealizationRequiredBeforeVerify,
			RollbackRequiresRealization,
			PromotionAlreadyFinal,
			VerificationRequiredBeforeComplete,
		],
	},
	{
		description:
			"Realize a camp deployment, evaluate verification gates, and fail closed when rollback compensation fails.",
	},
) {}

export const ExecuteCdPromotionLive = ExecuteCdPromotion.toLayer(
	Effect.gen(function* () {
		const promotions = yield* CdPromotion;
		const realizer = yield* CdCampRealizer;
		const gate = yield* CdVerificationGate;

		return Effect.fn(function* ({ key, campId, freightDigest }) {
			const realized = yield* Activity.make({
				name: "realize-camp",
				success: RealizationResultSchema,
				error: CampRealizationFailed,
				execute: realizer.realizeCamp({
					promotionId: key,
					campId,
					freightDigest,
				}),
			}).pipe(Effect.result);

			if (realized._tag === "Failure") {
				yield* Activity.make({
					name: "record-realization-failure",
					execute: promotions
						.send(key, new FailCdPromotion({ reason: realized.failure.reason }))
						.pipe(Effect.asVoid),
				});
				return;
			}

			const realizationRef = realized.success.realizationRef;

			yield* Activity.make({
				name: "record-realization",
				error: Schema.Union([
					ApprovalRequiredBeforeRealize,
					PromotionAlreadyFinal,
				]),
				execute: promotions
					.send(key, new RecordCdRealization({ realizationRef }))
					.pipe(Effect.asVoid),
			});

			const evaluated = yield* Activity.make({
				name: "evaluate-verification-gate",
				success: VerificationResultSchema,
				error: VerificationGateFailed,
				execute: gate.evaluate({
					promotionId: key,
					campId,
					realizationRef,
				}),
			}).pipe(Effect.result);

			if (evaluated._tag === "Failure" || !evaluated.success.passed) {
				const reason =
					evaluated._tag === "Failure"
						? evaluated.failure.summary
						: evaluated.success.summary;
				yield* Activity.make({
					name: "record-verification-failure",
					error: Schema.Union([
						RealizationRequiredBeforeVerify,
						PromotionAlreadyFinal,
					]),
					execute: promotions
						.send(
							key,
							new RecordCdVerification({ passed: false, summary: reason }),
						)
						.pipe(Effect.asVoid),
				});
				const rolledBack = yield* Activity.make({
					name: "compensate-rollback-camp",
					success: RollbackResultSchema,
					error: CampRealizationFailed,
					execute: realizer.rollbackCamp({
						promotionId: key,
						campId,
						realizationRef,
					}),
				}).pipe(Effect.result);

				if (rolledBack._tag === "Failure") {
					yield* Activity.make({
						name: "record-rollback-failure",
						execute: promotions
							.send(
								key,
								new FailCdPromotion({
									reason: NonEmptyReason.make(
										`rollback-failed:${rolledBack.failure.reason}`,
									),
								}),
							)
							.pipe(Effect.asVoid),
					});
					return;
				}
				if (!rolledBack.success.rolledBack) {
					yield* Activity.make({
						name: "record-rollback-unconfirmed",
						execute: promotions
							.send(
								key,
								new FailCdPromotion({
									reason: NonEmptyReason.make(`rollback-unconfirmed:${reason}`),
								}),
							)
							.pipe(Effect.asVoid),
					});
					return;
				}
				yield* Activity.make({
					name: "record-rollback",
					error: Schema.Union([
						RollbackRequiresRealization,
						PromotionAlreadyFinal,
					]),
					execute: promotions
						.send(key, new RollbackCdPromotion({ reason }))
						.pipe(Effect.asVoid),
				});
				return;
			}

			yield* Activity.make({
				name: "record-verification-success",
				error: Schema.Union([
					RealizationRequiredBeforeVerify,
					PromotionAlreadyFinal,
				]),
				execute: promotions
					.send(
						key,
						new RecordCdVerification({
							passed: true,
							summary: evaluated.success.summary,
						}),
					)
					.pipe(Effect.asVoid),
			});

			yield* Activity.make({
				name: "complete-promotion",
				error: Schema.Union([
					VerificationRequiredBeforeComplete,
					PromotionAlreadyFinal,
				]),
				execute: promotions
					.send(key, new CompleteCdPromotion({}))
					.pipe(Effect.asVoid),
			});
		});
	}),
);
