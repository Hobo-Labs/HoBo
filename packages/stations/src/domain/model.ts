import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
	CloudBackendTarget,
	decodeEpochMs,
	decodeNonNegativeCount,
	decodeProgressiveRampPlan,
	decodeRampWeightPercent,
	decodeTtlSeconds,
	NonEmptyReason,
	NonNegativeCount,
	RampWeightPercent,
	TtlSeconds,
} from "./ids.js";
import {
	ExecuteProgressiveCutover,
	ExecuteProgressiveCutoverLive,
} from "./ProgressiveCutover.saga.js";
import {
	BudgetMigrationProposed,
	TrafficRoute,
} from "./TrafficRoute.aggregate.js";

const DEFAULT_RAMP_PLAN = decodeProgressiveRampPlan([
	decodeRampWeightPercent(10),
	decodeRampWeightPercent(50),
	decodeRampWeightPercent(100),
]);
const DEFAULT_LOW_TTL = decodeTtlSeconds(30);
const ZERO_SWAPS = decodeNonNegativeCount(0);
const ZERO_WEIGHT = decodeRampWeightPercent(0);

export class StartCutoverPolicy extends Domain.Policy("StartCutoverPolicy", {
	from: TrafficRoute,
	on: [BudgetMigrationProposed],
}) {}

export const StartCutoverPolicyLive = StartCutoverPolicy.toLayer(
	Effect.gen(function* () {
		const runCutover = yield* ExecuteProgressiveCutover;
		return Effect.fn(function* ({ source, event }) {
			yield* runCutover.start(source, {
				to: event.to,
				rampPlan: DEFAULT_RAMP_PLAN,
				lowTtlSeconds: DEFAULT_LOW_TTL,
				previousTtlSeconds: event.previousTtlSeconds,
				completedAtMs: decodeEpochMs(event.proposedAtMs + 4_000),
			});
		});
	}),
);

export const UnregisteredRouteView = Schema.TaggedStruct("Unregistered", {});

export const SteadyRouteView = Schema.TaggedStruct("Steady", {
	incumbent: CloudBackendTarget,
	ttlSeconds: TtlSeconds,
	swapsCompleted: NonNegativeCount,
});

export const TtlLoweringRouteView = Schema.TaggedStruct("TtlLowering", {
	incumbent: CloudBackendTarget,
	challenger: CloudBackendTarget,
	ttlSeconds: TtlSeconds,
	swapsCompleted: NonNegativeCount,
});

export const RampingRouteView = Schema.TaggedStruct("Ramping", {
	incumbent: CloudBackendTarget,
	challenger: CloudBackendTarget,
	targetWeightPercent: RampWeightPercent,
	ttlSeconds: TtlSeconds,
	swapsCompleted: NonNegativeCount,
});

export const RolledBackRouteView = Schema.TaggedStruct("RolledBack", {
	incumbent: CloudBackendTarget,
	ttlSeconds: TtlSeconds,
	swapsCompleted: NonNegativeCount,
	reason: NonEmptyReason,
});

export const ReconciliationRequiredRouteView = Schema.TaggedStruct(
	"ReconciliationRequired",
	{
		incumbent: Schema.NullOr(CloudBackendTarget),
		swapsCompleted: NonNegativeCount,
		reason: NonEmptyReason,
	},
);

export const TrafficRoutingViewState = Schema.Union([
	UnregisteredRouteView,
	SteadyRouteView,
	TtlLoweringRouteView,
	RampingRouteView,
	RolledBackRouteView,
	ReconciliationRequiredRouteView,
]);
export type TrafficRoutingViewState = typeof TrafficRoutingViewState.Type;

const INITIAL_VIEW_STATE: TrafficRoutingViewState = {
	_tag: "Unregistered",
};

export class TrafficRoutingView extends Domain.View("TrafficRoutingView", {
	from: [TrafficRoute],
	key: TrafficRoute,
	state: TrafficRoutingViewState,
	initial: INITIAL_VIEW_STATE,
	evolve: {
		TrafficIncumbentRegistered: (state, event) => ({
			_tag: "Steady" as const,
			incumbent: event.incumbent,
			ttlSeconds: event.ttlSeconds,
			swapsCompleted:
				state._tag === "Unregistered" ? ZERO_SWAPS : state.swapsCompleted,
		}),
		BudgetMigrationProposed: (state, event) => {
			if (state._tag !== "Steady" && state._tag !== "RolledBack") {
				return state;
			}
			return {
				_tag: "TtlLowering" as const,
				incumbent: state.incumbent,
				challenger: event.to,
				ttlSeconds: state.ttlSeconds,
				swapsCompleted: state.swapsCompleted,
			};
		},
		CutoverTtlLowered: (state, event) => {
			if (state._tag !== "TtlLowering" && state._tag !== "Ramping") {
				return state;
			}
			return {
				_tag: "Ramping" as const,
				incumbent: state.incumbent,
				challenger: state.challenger,
				targetWeightPercent:
					state._tag === "Ramping" ? state.targetWeightPercent : ZERO_WEIGHT,
				ttlSeconds: event.ttlSeconds,
				swapsCompleted: state.swapsCompleted,
			};
		},
		CutoverRampAdvanced: (state, event) => {
			if (state._tag !== "TtlLowering" && state._tag !== "Ramping") {
				return state;
			}
			return {
				_tag: "Ramping" as const,
				incumbent: state.incumbent,
				challenger: state.challenger,
				targetWeightPercent: event.targetWeightPercent,
				ttlSeconds: state.ttlSeconds,
				swapsCompleted: state.swapsCompleted,
			};
		},
		CutoverCompleted: (state, event) => {
			if (state._tag !== "Ramping") {
				return state;
			}
			return {
				_tag: "Steady" as const,
				incumbent: event.incumbent,
				ttlSeconds: state.ttlSeconds,
				swapsCompleted: event.swapsInWindow,
			};
		},
		CutoverRolledBack: (state, event) => {
			if (state._tag !== "TtlLowering" && state._tag !== "Ramping") {
				return state;
			}
			return {
				_tag: "RolledBack" as const,
				incumbent: event.restored,
				ttlSeconds: event.restoredTtlSeconds,
				swapsCompleted: state.swapsCompleted,
				reason: event.reason,
			};
		},
		CutoverReconciliationRequired: (state, event) => ({
			_tag: "ReconciliationRequired" as const,
			incumbent: state._tag === "Unregistered" ? null : state.incumbent,
			swapsCompleted:
				state._tag === "Unregistered" ? ZERO_SWAPS : state.swapsCompleted,
			reason: event.reason,
		}),
		CutoverReconciliationResolved: (state, event) => ({
			_tag: "Steady" as const,
			incumbent: event.incumbent,
			ttlSeconds: event.ttlSeconds,
			swapsCompleted:
				state._tag === "ReconciliationRequired"
					? state.swapsCompleted
					: ZERO_SWAPS,
		}),
	},
}) {}

export class StationRouting extends Domain.Model(
	"StationRouting",
	{
		aggregates: [TrafficRoute],
		views: [TrafficRoutingView],
		policies: [StartCutoverPolicy],
		sagas: [ExecuteProgressiveCutover],
	},
	{
		description:
			"Budget-driven progressive traffic routing and multi-cloud cutover between Vercel, Cloudflare, Hostinger, and Local backends.",
	},
) {}

export class StationRoutingApi extends Domain.Api(
	"StationRoutingApi",
	{
		model: StationRouting,
		commands: [
			"RegisterTrafficIncumbent",
			"ProposeBudgetMigration",
			"FlagCutoverReconciliation",
			"ResolveTrafficCutoverReconciliation",
		],
		views: ["TrafficRoutingView"],
	},
	{
		description:
			"Control API for Station progressive traffic routing and cutover.",
	},
) {}

export const StationRoutingHandlers = Layer.mergeAll(
	StartCutoverPolicyLive,
	ExecuteProgressiveCutoverLive,
);
