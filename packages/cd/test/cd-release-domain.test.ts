import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
	ApproveCdPromotion,
	ApproverId,
	CampNotInWave,
	CampOutcomeAlreadyRecorded,
	CampRealizationFailed,
	CampTargetId,
	CdCampRealizer,
	CdDeliveryFlow,
	CdFanout,
	CdFanoutCampUpdated,
	CdFanoutCompleted,
	CdFanoutHalted,
	CdFanoutId,
	CdFanoutStarted,
	type CdFanoutStatusState,
	CdFanoutStatusView,
	CdPromotion,
	CdPromotionApproved,
	CdPromotionCompleted,
	CdPromotionFailed,
	CdPromotionId,
	CdPromotionRealized,
	CdPromotionRequested,
	CdPromotionRolledBack,
	type CdPromotionStatusState,
	CdPromotionStatusView,
	CdPromotionVerified,
	CdRelease,
	CdReleaseHandlers,
	CdVerificationGate,
	FreightDigest,
	NonEmptyReason,
	NonNegativeCount,
	PromotionNotPendingApproval,
	RealizationRef,
	RealizationRequiredBeforeVerify,
	RecordCdVerification,
	RecordFanoutCampOutcome,
	RequestCdPromotion,
	RollbackCdPromotion,
	RollbackRequiresRealization,
	StartCdFanout,
	UniqueCampWave,
} from "../src/domain/index.js";

const story = Story.make(CdRelease, {
	layer: CdReleaseHandlers,
	stub: [CdCampRealizer, CdVerificationGate, CdDeliveryFlow],
});

type CdCampRealizerService = Layer.Success<
	ReturnType<typeof CdCampRealizer.toLayer>
>;
type CdVerificationGateService = Layer.Success<
	ReturnType<typeof CdVerificationGate.toLayer>
>;

function runRealizerConformance(
	adapterName: string,
	layer: Layer.Layer<CdCampRealizerService>,
) {
	describe(`CdCampRealizer adapter conformance: ${adapterName}`, () => {
		it("realizes and rolls back a camp through the typed ExternalSystem contract", async () => {
			const promotionId = CdPromotionId.make("promo-conformance-1");
			const campId = CampTargetId.make("camp-conformance-1");
			const freightDigest = FreightDigest.make("sha256:conformance-v1");

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const realizer = yield* CdCampRealizer;
					const realized = yield* realizer.realizeCamp({
						promotionId,
						campId,
						freightDigest,
					});
					const rolledBack = yield* realizer.rollbackCamp({
						promotionId,
						campId,
						realizationRef: realized.realizationRef,
					});
					return { realized, rolledBack };
				}).pipe(Effect.provide(layer)),
			);

			expect(result.realized.realizationRef.length).toBeGreaterThan(0);
			expect(result.rolledBack.rolledBack).toBe(true);
		});
	});
}

function runVerificationGateConformance(
	adapterName: string,
	layer: Layer.Layer<CdVerificationGateService>,
) {
	describe(`CdVerificationGate adapter conformance: ${adapterName}`, () => {
		it("evaluates a realized camp through the typed ExternalSystem contract", async () => {
			const evaluated = await Effect.runPromise(
				Effect.gen(function* () {
					const gate = yield* CdVerificationGate;
					return yield* gate.evaluate({
						promotionId: CdPromotionId.make("promo-gate-1"),
						campId: CampTargetId.make("camp-gate-1"),
						realizationRef: RealizationRef.make("realize-gate-1"),
					});
				}).pipe(Effect.provide(layer)),
			);

			expect(evaluated.passed).toBe(true);
			expect(evaluated.summary.length).toBeGreaterThan(0);
		});
	});
}

describe("@hobo/cd/domain CdRelease Alchemy Domain model", () => {
	it("passes Domain.verify static model verification", () => {
		expect(Domain.verify(CdRelease)).toEqual([]);
	});

	it("enforces branded domain types and discriminated views at compile time and schema decode boundaries", () => {
		const checkCompileTimeConstraints = (
			promoView: CdPromotionStatusState,
			fanoutView: CdFanoutStatusState,
		) => {
			// @ts-expect-error raw string is not a branded CdPromotionId
			const badPromoId: CdPromotionId = "promo-raw";
			// @ts-expect-error raw string is not a branded FreightDigest
			const badDigest: FreightDigest = "sha256:raw";
			// @ts-expect-error raw number is not a branded NonNegativeCount
			const badCount: NonNegativeCount = 0;
			// @ts-expect-error realizationRef does not exist on unnarrowed CdPromotionStatusState union
			const unnarrowedRef = promoView.realizationRef;
			// @ts-expect-error haltReason does not exist on unnarrowed CdFanoutStatusState union
			const unnarrowedHalt = fanoutView.haltReason;
			return [badPromoId, badDigest, badCount, unnarrowedRef, unnarrowedHalt];
		};
		expect(checkCompileTimeConstraints).toBeTypeOf("function");

		const decodeDigest = Schema.decodeUnknownExit(FreightDigest);
		const decodeCount = Schema.decodeUnknownExit(NonNegativeCount);
		const decodeWave = Schema.decodeUnknownExit(UniqueCampWave);

		expect(Exit.isFailure(decodeDigest("md5:not-sha256"))).toBe(true);
		expect(Exit.isFailure(decodeCount(-1))).toBe(true);
		expect(Exit.isFailure(decodeWave([]))).toBe(true);
		expect(Exit.isFailure(decodeWave(["camp-a", "camp-a"]))).toBe(true);
		expect(Exit.isSuccess(decodeWave(["camp-a", "camp-b"]))).toBe(true);
	});

	it("executes approved promotion through camp realization, verification, and completion", async () => {
		const promoId = CdPromotionId.make("promo-prod-1");
		const campId = CampTargetId.make("camp-us-east");
		const digest = FreightDigest.make("sha256:freight-v1");
		const approver = ApproverId.make("operator-1");
		const realizationRef = RealizationRef.make("realize-ref-1");
		const summary = NonEmptyReason.make("all slo probes green");
		const promo = CdPromotion.ref(promoId);

		await Effect.runPromise(
			story(
				Story.when(
					promo,
					new RequestCdPromotion({
						campId,
						freightDigest: digest,
						requiresApproval: true,
					}),
				),
				Story.then(
					promo,
					new CdPromotionRequested({
						campId,
						freightDigest: digest,
						requiresApproval: true,
					}),
				),
				Story.when(
					promo,
					new RecordCdVerification({
						passed: true,
						summary,
					}),
				),
				Story.rejected(
					new RealizationRequiredBeforeVerify({ phase: "pending-approval" }),
				),
				Story.when(
					promo,
					new RollbackCdPromotion({
						reason: NonEmptyReason.make("premature-rollback"),
					}),
				),
				Story.rejected(
					new RollbackRequiresRealization({ phase: "pending-approval" }),
				),
				Story.when(promo, new ApproveCdPromotion({ approver })),
				Story.then(
					promo,
					new CdPromotionApproved({
						approver,
						campId,
						freightDigest: digest,
					}),
				),
				Story.call(CdCampRealizer.realizeCamp, {
					promotionId: promoId,
					campId,
					freightDigest: digest,
				}),
				Story.succeed(CdCampRealizer.realizeCamp, { realizationRef }),
				Story.then(promo, new CdPromotionRealized({ realizationRef })),
				Story.call(CdVerificationGate.evaluate, {
					promotionId: promoId,
					campId,
					realizationRef,
				}),
				Story.succeed(CdVerificationGate.evaluate, {
					passed: true,
					summary,
				}),
				Story.then(
					promo,
					new CdPromotionVerified({
						passed: true,
						summary,
					}),
					new CdPromotionCompleted({ realizationRef }),
				),
				Story.view(CdPromotionStatusView, promo, {
					_tag: "Completed",
					campId,
					freightDigest: digest,
					approver,
					realizationRef,
				}),
			),
		);
	});

	it("automatically rolls back realized camp when verification fails and rollback succeeds", async () => {
		const promoId = CdPromotionId.make("promo-prod-2");
		const campId = CampTargetId.make("camp-eu-west");
		const digest = FreightDigest.make("sha256:freight-v2");
		const realizationRef = RealizationRef.make("realize-ref-2");
		const reason = NonEmptyReason.make("error rate exceeded 2%");
		const promo = CdPromotion.ref(promoId);

		await Effect.runPromise(
			story(
				Story.when(
					promo,
					new RequestCdPromotion({
						campId,
						freightDigest: digest,
						requiresApproval: false,
					}),
				),
				Story.then(
					promo,
					new CdPromotionRequested({
						campId,
						freightDigest: digest,
						requiresApproval: false,
					}),
				),
				Story.when(
					promo,
					new ApproveCdPromotion({
						approver: ApproverId.make("late-approver"),
					}),
				),
				Story.rejected(new PromotionNotPendingApproval({ phase: "approved" })),
				Story.call(CdCampRealizer.realizeCamp, {
					promotionId: promoId,
					campId,
					freightDigest: digest,
				}),
				Story.succeed(CdCampRealizer.realizeCamp, { realizationRef }),
				Story.then(promo, new CdPromotionRealized({ realizationRef })),
				Story.call(CdVerificationGate.evaluate, {
					promotionId: promoId,
					campId,
					realizationRef,
				}),
				Story.succeed(CdVerificationGate.evaluate, {
					passed: false,
					summary: reason,
				}),
				Story.then(
					promo,
					new CdPromotionVerified({
						passed: false,
						summary: reason,
					}),
				),
				Story.call(CdCampRealizer.rollbackCamp, {
					promotionId: promoId,
					campId,
					realizationRef,
				}),
				Story.succeed(CdCampRealizer.rollbackCamp, { rolledBack: true }),
				Story.then(promo, new CdPromotionRolledBack({ reason })),
				Story.view(CdPromotionStatusView, promo, {
					_tag: "RolledBack",
					campId,
					freightDigest: digest,
					approver: null,
					realizationRef,
					reason,
				}),
			),
		);
	});

	it("fails closed into CdPromotionFailed when rollback compensation errors or returns unconfirmed", async () => {
		const promoErrId = CdPromotionId.make("promo-rollback-error");
		const promoUnconfirmedId = CdPromotionId.make("promo-rollback-unconfirmed");
		const campId = CampTargetId.make("camp-ap-south");
		const digest = FreightDigest.make("sha256:freight-v3");
		const refErr = RealizationRef.make("realize-ref-err");
		const refUnconfirmed = RealizationRef.make("realize-ref-unconfirmed");
		const verifyReason = NonEmptyReason.make("canary p99 breach");
		const rollbackErrorReason = NonEmptyReason.make("camp-api-unreachable");
		const promoErr = CdPromotion.ref(promoErrId);
		const promoUnconfirmed = CdPromotion.ref(promoUnconfirmedId);

		await Effect.runPromise(
			story(
				Story.when(
					promoErr,
					new RequestCdPromotion({
						campId,
						freightDigest: digest,
						requiresApproval: false,
					}),
				),
				Story.then(
					promoErr,
					new CdPromotionRequested({
						campId,
						freightDigest: digest,
						requiresApproval: false,
					}),
				),
				Story.call(CdCampRealizer.realizeCamp, {
					promotionId: promoErrId,
					campId,
					freightDigest: digest,
				}),
				Story.succeed(CdCampRealizer.realizeCamp, { realizationRef: refErr }),
				Story.then(
					promoErr,
					new CdPromotionRealized({ realizationRef: refErr }),
				),
				Story.call(CdVerificationGate.evaluate, {
					promotionId: promoErrId,
					campId,
					realizationRef: refErr,
				}),
				Story.succeed(CdVerificationGate.evaluate, {
					passed: false,
					summary: verifyReason,
				}),
				Story.then(
					promoErr,
					new CdPromotionVerified({
						passed: false,
						summary: verifyReason,
					}),
				),
				Story.call(CdCampRealizer.rollbackCamp, {
					promotionId: promoErrId,
					campId,
					realizationRef: refErr,
				}),
				Story.fail(
					CdCampRealizer.rollbackCamp,
					new CampRealizationFailed({
						campId,
						reason: rollbackErrorReason,
					}),
				),
				Story.then(
					promoErr,
					new CdPromotionFailed({
						reason: NonEmptyReason.make(
							`rollback-failed:${rollbackErrorReason}`,
						),
					}),
				),
				Story.view(CdPromotionStatusView, promoErr, {
					_tag: "Failed",
					campId,
					freightDigest: digest,
					realizationRef: refErr,
					reason: NonEmptyReason.make(`rollback-failed:${rollbackErrorReason}`),
				}),
				Story.when(
					promoUnconfirmed,
					new RequestCdPromotion({
						campId,
						freightDigest: digest,
						requiresApproval: false,
					}),
				),
				Story.then(
					promoUnconfirmed,
					new CdPromotionRequested({
						campId,
						freightDigest: digest,
						requiresApproval: false,
					}),
				),
				Story.call(CdCampRealizer.realizeCamp, {
					promotionId: promoUnconfirmedId,
					campId,
					freightDigest: digest,
				}),
				Story.succeed(CdCampRealizer.realizeCamp, {
					realizationRef: refUnconfirmed,
				}),
				Story.then(
					promoUnconfirmed,
					new CdPromotionRealized({ realizationRef: refUnconfirmed }),
				),
				Story.call(CdVerificationGate.evaluate, {
					promotionId: promoUnconfirmedId,
					campId,
					realizationRef: refUnconfirmed,
				}),
				Story.succeed(CdVerificationGate.evaluate, {
					passed: false,
					summary: verifyReason,
				}),
				Story.then(
					promoUnconfirmed,
					new CdPromotionVerified({
						passed: false,
						summary: verifyReason,
					}),
				),
				Story.call(CdCampRealizer.rollbackCamp, {
					promotionId: promoUnconfirmedId,
					campId,
					realizationRef: refUnconfirmed,
				}),
				Story.succeed(CdCampRealizer.rollbackCamp, { rolledBack: false }),
				Story.then(
					promoUnconfirmed,
					new CdPromotionFailed({
						reason: NonEmptyReason.make(`rollback-unconfirmed:${verifyReason}`),
					}),
				),
				Story.view(CdPromotionStatusView, promoUnconfirmed, {
					_tag: "Failed",
					reason: NonEmptyReason.make(`rollback-unconfirmed:${verifyReason}`),
				}),
			),
		);
	});

	it("rejects unknown or duplicate fanout camp outcomes, halts on budget breach, and completes healthy fanout", async () => {
		const fanoutHalted = CdFanout.ref(CdFanoutId.make("fanout-1"));
		const fanoutOk = CdFanout.ref(CdFanoutId.make("fanout-2"));
		const digest = FreightDigest.make("sha256:freight-wave");
		const campA = CampTargetId.make("camp-a");
		const campB = CampTargetId.make("camp-b");
		const campC = CampTargetId.make("camp-c");
		const unknownCamp = CampTargetId.make("camp-unknown");
		const waveAB = UniqueCampWave.make([campA, campB]);
		const waveC = UniqueCampWave.make([campC]);
		const zeroFailures = NonNegativeCount.make(0);
		const timeoutReason = NonEmptyReason.make("canary-timeout");

		await Effect.runPromise(
			story(
				Story.when(
					fanoutHalted,
					new StartCdFanout({
						freightDigest: digest,
						campIds: waveAB,
						maxFailures: zeroFailures,
					}),
				),
				Story.then(
					fanoutHalted,
					new CdFanoutStarted({
						freightDigest: digest,
						campIds: waveAB,
						maxFailures: zeroFailures,
					}),
				),
				Story.when(
					fanoutHalted,
					new RecordFanoutCampOutcome({
						campId: unknownCamp,
						succeeded: true,
						reason: null,
					}),
				),
				Story.rejected(new CampNotInWave({ campId: unknownCamp })),
				Story.when(
					fanoutHalted,
					new RecordFanoutCampOutcome({
						campId: campB,
						succeeded: true,
						reason: null,
					}),
				),
				Story.then(
					fanoutHalted,
					new CdFanoutCampUpdated({
						campId: campB,
						succeeded: true,
						reason: null,
					}),
				),
				Story.when(
					fanoutHalted,
					new RecordFanoutCampOutcome({
						campId: campB,
						succeeded: true,
						reason: null,
					}),
				),
				Story.rejected(new CampOutcomeAlreadyRecorded({ campId: campB })),
				Story.when(
					fanoutHalted,
					new RecordFanoutCampOutcome({
						campId: campA,
						succeeded: false,
						reason: timeoutReason,
					}),
				),
				Story.then(
					fanoutHalted,
					new CdFanoutCampUpdated({
						campId: campA,
						succeeded: false,
						reason: timeoutReason,
					}),
					new CdFanoutHalted({
						failedCount: NonNegativeCount.make(1),
						maxFailures: zeroFailures,
						reason: timeoutReason,
					}),
				),
				Story.view(CdFanoutStatusView, fanoutHalted, {
					_tag: "Halted",
					totalCamps: NonNegativeCount.make(2),
					succeededCount: NonNegativeCount.make(1),
					failedCount: NonNegativeCount.make(1),
					haltReason: timeoutReason,
				}),
				Story.when(
					fanoutOk,
					new StartCdFanout({
						freightDigest: digest,
						campIds: waveC,
						maxFailures: zeroFailures,
					}),
				),
				Story.then(
					fanoutOk,
					new CdFanoutStarted({
						freightDigest: digest,
						campIds: waveC,
						maxFailures: zeroFailures,
					}),
				),
				Story.when(
					fanoutOk,
					new RecordFanoutCampOutcome({
						campId: campC,
						succeeded: true,
						reason: null,
					}),
				),
				Story.then(
					fanoutOk,
					new CdFanoutCampUpdated({
						campId: campC,
						succeeded: true,
						reason: null,
					}),
					new CdFanoutCompleted({ succeededCount: NonNegativeCount.make(1) }),
				),
				Story.view(CdFanoutStatusView, fanoutOk, {
					_tag: "Completed",
					totalCamps: NonNegativeCount.make(1),
					succeededCount: NonNegativeCount.make(1),
					failedCount: NonNegativeCount.make(0),
				}),
			),
		);
	});

	runRealizerConformance(
		"stateless-stub",
		CdCampRealizer.toLayer(
			Effect.succeed({
				realizeCamp: ({ promotionId, campId }) =>
					Effect.succeed({
						realizationRef: RealizationRef.make(`${promotionId}:${campId}`),
					}),
				rollbackCamp: () => Effect.succeed({ rolledBack: true }),
			}),
		),
	);

	runRealizerConformance(
		"stateful-camp-tracker",
		CdCampRealizer.toLayer(
			Effect.sync(() => {
				const live = new Set<string>();
				return {
					realizeCamp: ({ promotionId, campId }) =>
						Effect.sync(() => {
							const ref = RealizationRef.make(`live:${promotionId}:${campId}`);
							live.add(ref);
							return { realizationRef: ref };
						}),
					rollbackCamp: ({ realizationRef }) =>
						Effect.sync(() => ({ rolledBack: live.delete(realizationRef) })),
				};
			}),
		),
	);

	runVerificationGateConformance(
		"passing-slo-gate",
		CdVerificationGate.toLayer(
			Effect.succeed({
				evaluate: () =>
					Effect.succeed({
						passed: true,
						summary: NonEmptyReason.make("slo probes passed"),
					}),
			}),
		),
	);

	it("fails closed with ExternalSystemSchemaError when CdCampRealizer returns schema-drifting data", async () => {
		const DriftedRealizer = CdCampRealizer.toLayer(
			Effect.succeed({
				realizeCamp: () =>
					Effect.sync(() => JSON.parse('{"realizationRef":""}')),
				rollbackCamp: () => Effect.succeed({ rolledBack: true }),
			}),
		);

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const realizer = yield* CdCampRealizer;
				return yield* realizer.realizeCamp({
					promotionId: CdPromotionId.make("promo-drift"),
					campId: CampTargetId.make("camp-drift"),
					freightDigest: FreightDigest.make("sha256:drift"),
				});
			}).pipe(Effect.provide(DriftedRealizer)),
		);

		expect(Exit.isFailure(exit)).toBe(true);
	});
});
