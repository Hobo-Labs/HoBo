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
	CampTargetId,
	CdFanoutPhase,
	CdPromotionPhase,
	FreightDigest,
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

const PromotionStatusState = Schema.Struct({
	phase: CdPromotionPhase,
	campId: Schema.NullOr(CampTargetId),
	freightDigest: Schema.NullOr(FreightDigest),
	approver: Schema.NullOr(Schema.String),
	realizationRef: Schema.NullOr(Schema.String),
	verificationPassed: Schema.Boolean,
	failureReason: Schema.NullOr(Schema.String),
});

export class CdPromotionStatusView extends Domain.View(
	"CdPromotionStatusView",
	{
		from: [CdPromotion],
		key: CdPromotion,
		state: PromotionStatusState,
		initial: {
			phase: "idle" as const,
			campId: null,
			freightDigest: null,
			approver: null,
			realizationRef: null,
			verificationPassed: false,
			failureReason: null,
		},
		evolve: {
			CdPromotionRequested: (state, event) => ({
				...state,
				phase: event.requiresApproval
					? ("pending-approval" as const)
					: ("approved" as const),
				campId: event.campId,
				freightDigest: event.freightDigest,
			}),
			CdPromotionApproved: (state, event) => ({
				...state,
				phase: "approved" as const,
				approver: event.approver,
			}),
			CdPromotionRealized: (state, event) => ({
				...state,
				phase: "realized" as const,
				realizationRef: event.realizationRef,
			}),
			CdPromotionVerified: (state, event) => ({
				...state,
				phase: event.passed ? ("verified" as const) : state.phase,
				verificationPassed: event.passed,
			}),
			CdPromotionCompleted: (state) => ({
				...state,
				phase: "completed" as const,
			}),
			CdPromotionRolledBack: (state, event) => ({
				...state,
				phase: "rolled-back" as const,
				failureReason: event.reason,
			}),
			CdPromotionFailed: (state, event) => ({
				...state,
				phase: "failed" as const,
				failureReason: event.reason,
			}),
		},
	},
) {}

const FanoutStatusState = Schema.Struct({
	phase: CdFanoutPhase,
	totalCamps: Schema.Int,
	succeededCount: Schema.Int,
	failedCount: Schema.Int,
	haltReason: Schema.NullOr(Schema.String),
});

export class CdFanoutStatusView extends Domain.View("CdFanoutStatusView", {
	from: [CdFanout],
	key: CdFanout,
	state: FanoutStatusState,
	initial: {
		phase: "idle" as const,
		totalCamps: 0,
		succeededCount: 0,
		failedCount: 0,
		haltReason: null,
	},
	evolve: {
		CdFanoutStarted: (state, event) => ({
			...state,
			phase: "running" as const,
			totalCamps: event.campIds.length,
		}),
		CdFanoutCampUpdated: (state, event) => ({
			...state,
			succeededCount: event.succeeded
				? state.succeededCount + 1
				: state.succeededCount,
			failedCount: event.succeeded ? state.failedCount : state.failedCount + 1,
		}),
		CdFanoutHalted: (state, event) => ({
			...state,
			phase: "halted" as const,
			haltReason: event.reason,
		}),
		CdFanoutCompleted: (state) => ({
			...state,
			phase: "completed" as const,
		}),
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
			"Continuous delivery promotion, verification, rollback compensation, and wave fanout model.",
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
		description: "Control API for HoBo CD promotions and multi-camp wave fanout.",
	},
) {}

export const CdReleaseHandlers = Layer.mergeAll(
	StartCdPromotionPolicyLive,
	ExecuteCdPromotionLive,
);
