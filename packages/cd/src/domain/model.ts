import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CdFanout } from "./CdFanout.aggregate.js";
import {
	CdPromotion,
	CdPromotionApproved,
	CdPromotionRequested,
} from "./CdPromotion.aggregate.js";
import {
	ExecuteCdPromotion,
	ExecuteCdPromotionLive,
} from "./ExecuteCdPromotion.saga.js";
import {
	ApproverId,
	CampTargetId,
	FreightDigest,
	NonEmptyReason,
	NonNegativeCount,
	RealizationRef,
} from "./ids.js";

export class StartCdPromotionPolicy extends Domain.Policy(
	"StartCdPromotionPolicy",
	{
		from: CdPromotion,
		on: [CdPromotionRequested, CdPromotionApproved],
	},
) {}

export const StartCdPromotionPolicyLive = StartCdPromotionPolicy.toLayer(
	Effect.gen(function* () {
		const runPromotion = yield* ExecuteCdPromotion;

		return Effect.fn(function* ({ source, event }) {
			if (event._tag === "CdPromotionRequested") {
				if (event.requiresApproval) return;
				yield* runPromotion.start(source, {
					campId: event.campId,
					freightDigest: event.freightDigest,
				});
				return;
			}
			yield* runPromotion.start(source, {
				campId: event.campId,
				freightDigest: event.freightDigest,
			});
		});
	}),
);

export const CdPromotionStatusState = Schema.Union([
	Schema.TaggedStruct("Idle", {}),
	Schema.TaggedStruct("PendingApproval", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
	}),
	Schema.TaggedStruct("Approved", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
	}),
	Schema.TaggedStruct("Realized", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
		realizationRef: RealizationRef,
	}),
	Schema.TaggedStruct("Verified", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
		realizationRef: RealizationRef,
		summary: NonEmptyReason,
	}),
	Schema.TaggedStruct("Completed", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
		realizationRef: RealizationRef,
	}),
	Schema.TaggedStruct("RolledBack", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
		realizationRef: RealizationRef,
		reason: NonEmptyReason,
	}),
	Schema.TaggedStruct("Failed", {
		campId: Schema.NullOr(CampTargetId),
		freightDigest: Schema.NullOr(FreightDigest),
		approver: Schema.NullOr(ApproverId),
		realizationRef: Schema.NullOr(RealizationRef),
		reason: NonEmptyReason,
	}),
]);
export type CdPromotionStatusState = typeof CdPromotionStatusState.Type;

export class CdPromotionStatusView extends Domain.View(
	"CdPromotionStatusView",
	{
		from: [CdPromotion],
		key: CdPromotion,
		state: CdPromotionStatusState,
		initial: { _tag: "Idle" },
		evolve: {
			CdPromotionRequested: (_state, event) =>
				event.requiresApproval
					? {
							_tag: "PendingApproval" as const,
							campId: event.campId,
							freightDigest: event.freightDigest,
						}
					: {
							_tag: "Approved" as const,
							campId: event.campId,
							freightDigest: event.freightDigest,
							approver: null,
						},
			CdPromotionApproved: (_state, event) => ({
				_tag: "Approved" as const,
				campId: event.campId,
				freightDigest: event.freightDigest,
				approver: event.approver,
			}),
			CdPromotionRealized: (state, event) =>
				state._tag === "Approved"
					? {
							_tag: "Realized" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: state.approver,
							realizationRef: event.realizationRef,
						}
					: state,
			CdPromotionVerified: (state, event) =>
				state._tag === "Realized" && event.passed
					? {
							_tag: "Verified" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: state.approver,
							realizationRef: state.realizationRef,
							summary: event.summary,
						}
					: state,
			CdPromotionCompleted: (state, event) =>
				state._tag === "Verified"
					? {
							_tag: "Completed" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: state.approver,
							realizationRef: event.realizationRef,
						}
					: state,
			CdPromotionRolledBack: (state, event) =>
				state._tag === "Realized" || state._tag === "Verified"
					? {
							_tag: "RolledBack" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: state.approver,
							realizationRef: state.realizationRef,
							reason: event.reason,
						}
					: state,
			CdPromotionFailed: (state, event) => {
				switch (state._tag) {
					case "Idle":
						return {
							_tag: "Failed" as const,
							campId: null,
							freightDigest: null,
							approver: null,
							realizationRef: null,
							reason: event.reason,
						};
					case "PendingApproval":
						return {
							_tag: "Failed" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: null,
							realizationRef: null,
							reason: event.reason,
						};
					case "Approved":
						return {
							_tag: "Failed" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: state.approver,
							realizationRef: null,
							reason: event.reason,
						};
					case "Realized":
					case "Verified":
					case "Completed":
					case "RolledBack":
					case "Failed":
						return {
							_tag: "Failed" as const,
							campId: state.campId,
							freightDigest: state.freightDigest,
							approver: state.approver,
							realizationRef: state.realizationRef,
							reason: event.reason,
						};
				}
			},
		},
	},
) {}

export const CdFanoutStatusState = Schema.Union([
	Schema.TaggedStruct("Idle", {}),
	Schema.TaggedStruct("Running", {
		totalCamps: NonNegativeCount,
		succeededCount: NonNegativeCount,
		failedCount: NonNegativeCount,
	}),
	Schema.TaggedStruct("Completed", {
		totalCamps: NonNegativeCount,
		succeededCount: NonNegativeCount,
		failedCount: NonNegativeCount,
	}),
	Schema.TaggedStruct("Halted", {
		totalCamps: NonNegativeCount,
		succeededCount: NonNegativeCount,
		failedCount: NonNegativeCount,
		haltReason: NonEmptyReason,
	}),
]);
export type CdFanoutStatusState = typeof CdFanoutStatusState.Type;

export class CdFanoutStatusView extends Domain.View("CdFanoutStatusView", {
	from: [CdFanout],
	key: CdFanout,
	state: CdFanoutStatusState,
	initial: { _tag: "Idle" },
	evolve: {
		CdFanoutStarted: (_state, event) => ({
			_tag: "Running" as const,
			totalCamps: NonNegativeCount.make(event.campIds.length),
			succeededCount: NonNegativeCount.make(0),
			failedCount: NonNegativeCount.make(0),
		}),
		CdFanoutCampUpdated: (state, event) =>
			state._tag === "Running"
				? {
						...state,
						succeededCount: NonNegativeCount.make(
							event.succeeded ? state.succeededCount + 1 : state.succeededCount,
						),
						failedCount: NonNegativeCount.make(
							event.succeeded ? state.failedCount : state.failedCount + 1,
						),
					}
				: state,
		CdFanoutHalted: (state, event) =>
			state._tag === "Running"
				? {
						_tag: "Halted" as const,
						totalCamps: state.totalCamps,
						succeededCount: state.succeededCount,
						failedCount: state.failedCount,
						haltReason: event.reason,
					}
				: state,
		CdFanoutCompleted: (state) =>
			state._tag === "Running"
				? {
						_tag: "Completed" as const,
						totalCamps: state.totalCamps,
						succeededCount: state.succeededCount,
						failedCount: state.failedCount,
					}
				: state,
	},
}) {}

export class CdRelease extends Domain.Model(
	"CdRelease",
	{
		aggregates: [CdPromotion, CdFanout],
		views: [CdPromotionStatusView, CdFanoutStatusView],
		policies: [StartCdPromotionPolicy],
		sagas: [ExecuteCdPromotion],
	},
	{
		description:
			"Continuous delivery promotion, verification, fail-closed rollback compensation, and wave fanout model.",
	},
) {}

export class CdReleaseApi extends Domain.Api(
	"CdReleaseApi",
	{
		model: CdRelease,
		commands: [
			"RequestCdPromotion",
			"ApproveCdPromotion",
			"StartCdFanout",
			"RecordFanoutCampOutcome",
		],
		views: ["CdPromotionStatusView", "CdFanoutStatusView"],
	},
	{
		description:
			"Control API for HoBo CD promotions and multi-camp wave fanout.",
	},
) {}

export const CdReleaseHandlers = Layer.mergeAll(
	StartCdPromotionPolicyLive,
	ExecuteCdPromotionLive,
);
