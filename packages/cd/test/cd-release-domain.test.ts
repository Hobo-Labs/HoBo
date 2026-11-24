import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	ApproveCdPromotion,
	CampTargetId,
	CdCampRealizer,
	CdFanout,
	CdFanoutCampUpdated,
	CdFanoutCompleted,
	CdFanoutHalted,
	CdFanoutId,
	CdFanoutStarted,
	CdFanoutStatusView,
	CdPromotion,
	CdPromotionApproved,
	CdPromotionCompleted,
	CdPromotionId,
	CdPromotionRealized,
	CdPromotionRequested,
	CdPromotionRolledBack,
	CdPromotionStatusView,
	CdPromotionVerified,
	CdRelease,
	CdReleaseHandlers,
	CdVerificationGate,
	FreightDigest,
	RecordFanoutCampOutcome,
	RequestCdPromotion,
	StartCdFanout,
} from "../src/domain/index.js";

const story = Story.make(CdRelease, {
	layer: CdReleaseHandlers,
	stub: [CdCampRealizer, CdVerificationGate],
});

describe("@hobo/cd/domain CdRelease Alchemy Domain model", () => {
	it("passes Domain.verify static model verification", () => {
		expect(Domain.verify(CdRelease)).toEqual([]);
	});

	it("executes approved promotion through camp realization, verification, and completion", async () => {
		const promoId = CdPromotionId.make("promo-prod-1");
		const campId = CampTargetId.make("camp-us-east");
		const digest = FreightDigest.make("sha256:freight-v1");
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
				Story.when(promo, new ApproveCdPromotion({ approver: "operator-1" })),
				Story.then(
					promo,
					new CdPromotionApproved({
						approver: "operator-1",
						campId,
						freightDigest: digest,
					}),
				),
				Story.call(CdCampRealizer.realizeCamp, {
					promotionId: promoId,
					campId,
					freightDigest: digest,
				}),
				Story.succeed(CdCampRealizer.realizeCamp, {
					realizationRef: "realize-ref-1",
				}),
				Story.then(
					promo,
					new CdPromotionRealized({ realizationRef: "realize-ref-1" }),
				),
				Story.call(CdVerificationGate.evaluate, {
					promotionId: promoId,
					campId,
					realizationRef: "realize-ref-1",
				}),
				Story.succeed(CdVerificationGate.evaluate, {
					passed: true,
					summary: "all slo probes green",
				}),
				Story.then(
					promo,
					new CdPromotionVerified({
						passed: true,
						summary: "all slo probes green",
					}),
					new CdPromotionCompleted({ realizationRef: "realize-ref-1" }),
				),
				Story.view(CdPromotionStatusView, promo, {
					phase: "completed",
					approver: "operator-1",
					verificationPassed: true,
				}),
			),
		);
	});

	it("automatically rolls back realized camp when verification fails", async () => {
		const promoId = CdPromotionId.make("promo-prod-2");
		const campId = CampTargetId.make("camp-eu-west");
		const digest = FreightDigest.make("sha256:freight-v2");
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
				Story.call(CdCampRealizer.realizeCamp, {
					promotionId: promoId,
					campId,
					freightDigest: digest,
				}),
				Story.succeed(CdCampRealizer.realizeCamp, {
					realizationRef: "realize-ref-2",
				}),
				Story.then(
					promo,
					new CdPromotionRealized({ realizationRef: "realize-ref-2" }),
				),
				Story.call(CdVerificationGate.evaluate, {
					promotionId: promoId,
					campId,
					realizationRef: "realize-ref-2",
				}),
				Story.succeed(CdVerificationGate.evaluate, {
					passed: false,
					summary: "error rate exceeded 2%",
				}),
				Story.then(
					promo,
					new CdPromotionVerified({
						passed: false,
						summary: "error rate exceeded 2%",
					}),
				),
				Story.call(CdCampRealizer.rollbackCamp, {
					promotionId: promoId,
					campId,
					realizationRef: "realize-ref-2",
				}),
				Story.succeed(CdCampRealizer.rollbackCamp, { rolledBack: true }),
				Story.then(
					promo,
					new CdPromotionRolledBack({ reason: "error rate exceeded 2%" }),
				),
				Story.view(CdPromotionStatusView, promo, {
					phase: "rolled-back",
					failureReason: "error rate exceeded 2%",
				}),
			),
		);
	});

	it("halts multi-camp fanout when failure budget is exceeded and completes healthy fanout", async () => {
		const fanoutHalted = CdFanout.ref(CdFanoutId.make("fanout-1"));
		const fanoutOk = CdFanout.ref(CdFanoutId.make("fanout-2"));
		const digest = FreightDigest.make("sha256:freight-wave");
		const campA = CampTargetId.make("camp-a");
		const campB = CampTargetId.make("camp-b");
		const campC = CampTargetId.make("camp-c");

		await Effect.runPromise(
			story(
				Story.when(
					fanoutHalted,
					new StartCdFanout({
						freightDigest: digest,
						campIds: [campA, campB],
						maxFailures: 0,
					}),
				),
				Story.then(
					fanoutHalted,
					new CdFanoutStarted({
						freightDigest: digest,
						campIds: [campA, campB],
						maxFailures: 0,
					}),
				),
				Story.when(
					fanoutHalted,
					new RecordFanoutCampOutcome({
						campId: campA,
						succeeded: false,
						reason: "canary-timeout",
					}),
				),
				Story.then(
					fanoutHalted,
					new CdFanoutCampUpdated({
						campId: campA,
						succeeded: false,
						reason: "canary-timeout",
					}),
					new CdFanoutHalted({
						failedCount: 1,
						maxFailures: 0,
						reason: "canary-timeout",
					}),
				),
				Story.view(CdFanoutStatusView, fanoutHalted, {
					phase: "halted",
					failedCount: 1,
				}),
				Story.when(
					fanoutOk,
					new StartCdFanout({
						freightDigest: digest,
						campIds: [campC],
						maxFailures: 0,
					}),
				),
				Story.then(
					fanoutOk,
					new CdFanoutStarted({
						freightDigest: digest,
						campIds: [campC],
						maxFailures: 0,
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
					new CdFanoutCompleted({ succeededCount: 1 }),
				),
				Story.view(CdFanoutStatusView, fanoutOk, {
					phase: "completed",
					succeededCount: 1,
				}),
			),
		);
	});
});
