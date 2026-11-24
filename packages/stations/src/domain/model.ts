import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
	CloudBackendId,
	CloudProviderKind,
	CutoverPhase,
} from "./ids.js";
import {
	ExecuteProgressiveCutover,
	ExecuteProgressiveCutoverLive,
} from "./ProgressiveCutover.saga.js";
import {
	BudgetMigrationProposed,
	TrafficRoute,
} from "./TrafficRoute.aggregate.js";

export class StartCutoverPolicy extends Domain.Policy("StartCutoverPolicy", {
	from: TrafficRoute,
	on: [BudgetMigrationProposed],
}) {}

export const StartCutoverPolicyLive = StartCutoverPolicy.toLayer(
	Effect.gen(function* () {
		const runCutover = yield* ExecuteProgressiveCutover;
		return Effect.fn(function* ({ source, event }) {
			yield* runCutover.start(source, {
				toProvider: event.toProvider,
				toBackendId: event.toBackendId,
				rampSteps: [10, 50, 100],
				lowTtlSeconds: 30,
				completedAtMs: event.proposedAtMs + 4_000,
			});
		});
	}),
);

const TrafficRoutingViewState = Schema.Struct({
	phase: CutoverPhase,
	activeProvider: Schema.NullOr(CloudProviderKind),
	activeBackendId: Schema.NullOr(CloudBackendId),
	challengerProvider: Schema.NullOr(CloudProviderKind),
	targetWeightPercent: Schema.Int,
	ttlSeconds: Schema.Int,
	swapsCompleted: Schema.Int,
	reconciliationReason: Schema.NullOr(Schema.String),
});

export class TrafficRoutingView extends Domain.View("TrafficRoutingView", {
	from: [TrafficRoute],
	key: TrafficRoute,
	state: TrafficRoutingViewState,
	initial: {
		phase: "unregistered" as const,
		activeProvider: null,
		activeBackendId: null,
		challengerProvider: null,
		targetWeightPercent: 0,
		ttlSeconds: 300,
		swapsCompleted: 0,
		reconciliationReason: null,
	},
	evolve: {
		TrafficIncumbentRegistered: (state, event) => ({
			...state,
			phase: "steady" as const,
			activeProvider: event.provider,
			activeBackendId: event.backendId,
			ttlSeconds: event.ttlSeconds,
		}),
		BudgetMigrationProposed: (state, event) => ({
			...state,
			phase: "ttl-lowering" as const,
			challengerProvider: event.toProvider,
			targetWeightPercent: 0,
		}),
		CutoverTtlLowered: (state, event) => ({
			...state,
			phase: "ramping" as const,
			ttlSeconds: event.ttlSeconds,
		}),
		CutoverRampAdvanced: (state, event) => ({
			...state,
			phase: "ramping" as const,
			targetWeightPercent: event.targetWeightPercent,
		}),
		CutoverCompleted: (state, event) => ({
			...state,
			phase: "steady" as const,
			activeProvider: event.activeProvider,
			activeBackendId: event.activeBackendId,
			challengerProvider: null,
			targetWeightPercent: 100,
			swapsCompleted: state.swapsCompleted + 1,
		}),
		CutoverRolledBack: (state) => ({
			...state,
			phase: "rolled-back" as const,
			challengerProvider: null,
			targetWeightPercent: 0,
		}),
		CutoverReconciliationRequired: (state, event) => ({
			...state,
			phase: "reconciliation-required" as const,
			reconciliationReason: event.reason,
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
		],
		views: ["TrafficRoutingView"],
	},
	{
		description: "Control API for Station progressive traffic routing and cutover.",
	},
) {}

export const StationRoutingHandlers = Layer.mergeAll(
	StartCutoverPolicyLive,
	ExecuteProgressiveCutoverLive,
);
