import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	ExternalRunnerId,
	JobConclusion,
	NonEmptyReason,
	NonNegativeCount,
	NonNegativeMicros,
	PoolRole,
	PositiveAttempts,
	PositiveConcurrency,
	RunnerLabel,
	RunnerPoolHealth,
	RunnerPoolId,
	RunnerTier,
	SlotId,
	StationId,
} from "./ids.js";
import { JobDispatch } from "./JobDispatch.aggregate.js";
import { StationFleet } from "./StationFleet.aggregate.js";

const ZERO_MICROS = NonNegativeMicros.make(0);
const ZERO_COUNT = NonNegativeCount.make(0);

function toNonNegativeMicros(value: number): NonNegativeMicros {
	return NonNegativeMicros.make(value <= 0 ? 0 : value);
}

function toNonNegativeCount(value: number): NonNegativeCount {
	return NonNegativeCount.make(value <= 0 ? 0 : value);
}

const PoolCapacitySnapshot = Schema.Struct({
	poolId: RunnerPoolId,
	tier: RunnerTier,
	role: PoolRole,
	runnerLabel: RunnerLabel,
	concurrency: PositiveConcurrency,
	activeJobs: NonNegativeCount,
	dispatchedCount: NonNegativeCount,
	health: RunnerPoolHealth,
	enabled: Schema.Boolean,
});
type PoolCapacitySnapshot = typeof PoolCapacitySnapshot.Type;

export const FleetCapacityState = Schema.Struct({
	ceilingMicros: Schema.NullOr(NonNegativeMicros),
	exposureMicros: NonNegativeMicros,
	pools: Schema.Array(PoolCapacitySnapshot),
});
export type FleetCapacityState = typeof FleetCapacityState.Type;

export class FleetCapacityView extends Domain.View(
	"FleetCapacityView",
	{
		from: [StationFleet],
		key: StationFleet,
		state: FleetCapacityState,
		initial: {
			ceilingMicros: null,
			exposureMicros: ZERO_MICROS,
			pools: [],
		},
		evolve: {
			StationBudgetConfigured: (view, event) => ({
				...view,
				ceilingMicros: event.ceilingMicros,
			}),
			RunnerPoolRegistered: (view, event) => {
				const existing = view.pools.find(
					(pool) => pool.poolId === event.spec.poolId,
				);
				const entry: PoolCapacitySnapshot = {
					poolId: event.spec.poolId,
					tier: event.spec.tier,
					role: event.spec.role,
					runnerLabel: event.spec.runnerLabel,
					concurrency: event.spec.concurrency,
					activeJobs: existing?.activeJobs ?? ZERO_COUNT,
					dispatchedCount: existing?.dispatchedCount ?? ZERO_COUNT,
					health: existing?.health ?? "healthy",
					enabled: existing?.enabled ?? true,
				};
				return {
					...view,
					pools: existing
						? view.pools.map((pool) =>
								pool.poolId === event.spec.poolId ? entry : pool,
							)
						: [...view.pools, entry],
				};
			},
			RunnerPoolHealthChanged: (view, event) => ({
				...view,
				pools: view.pools.map((pool) =>
					pool.poolId === event.poolId
						? { ...pool, health: event.health, enabled: event.enabled }
						: pool,
				),
			}),
			BalancedSlotReserved: (view, event) => ({
				...view,
				exposureMicros: NonNegativeMicros.make(
					view.exposureMicros + event.reservedMicros,
				),
				pools: view.pools.map((pool) =>
					pool.poolId === event.poolId
						? {
								...pool,
								activeJobs: NonNegativeCount.make(pool.activeJobs + 1),
								dispatchedCount: NonNegativeCount.make(
									pool.dispatchedCount + 1,
								),
							}
						: pool,
				),
			}),
			BalancedSlotReleased: (view, event) => ({
				...view,
				exposureMicros: toNonNegativeMicros(
					view.exposureMicros + event.settledMicros - event.reservedMicros,
				),
				pools: view.pools.map((pool) =>
					pool.poolId === event.poolId
						? { ...pool, activeJobs: toNonNegativeCount(pool.activeJobs - 1) }
						: pool,
				),
			}),
		},
	},
	{
		description:
			"Live runner pool capacity, dispatch distribution, and budget exposure per CI station.",
	},
) {}

export const RoutingAuditState = Schema.Union([
	Schema.TaggedStruct("Unobserved", {}),
	Schema.TaggedStruct("Queued", {
		stationId: StationId,
	}),
	Schema.TaggedStruct("Bound", {
		stationId: StationId,
		poolId: RunnerPoolId,
		tier: RunnerTier,
		slotId: SlotId,
		runnerLabel: RunnerLabel,
		externalRunnerId: ExternalRunnerId,
		attempts: PositiveAttempts,
	}),
	Schema.TaggedStruct("Completed", {
		stationId: StationId,
		poolId: RunnerPoolId,
		tier: RunnerTier,
		slotId: SlotId,
		runnerLabel: RunnerLabel,
		externalRunnerId: ExternalRunnerId,
		attempts: PositiveAttempts,
		settledMicros: NonNegativeMicros,
		conclusion: JobConclusion,
	}),
	Schema.TaggedStruct("Failed", {
		stationId: Schema.NullOr(StationId),
		reason: NonEmptyReason,
	}),
	Schema.TaggedStruct("Expired", {
		stationId: Schema.NullOr(StationId),
		reason: NonEmptyReason,
	}),
]);
export type RoutingAuditState = typeof RoutingAuditState.Type;

function stationIdOf(view: RoutingAuditState): StationId | null {
	switch (view._tag) {
		case "Unobserved":
			return null;
		case "Queued":
		case "Bound":
		case "Completed":
		case "Failed":
		case "Expired":
			return view.stationId;
	}
}

export class RoutingAuditView extends Domain.View(
	"RoutingAuditView",
	{
		from: [JobDispatch],
		key: JobDispatch,
		state: RoutingAuditState,
		initial: { _tag: "Unobserved" },
		evolve: {
			JobDispatchObserved: (_view, event) => ({
				_tag: "Queued" as const,
				stationId: event.stationId,
			}),
			RunnerStartBound: (_view, event) => ({
				_tag: "Bound" as const,
				stationId: event.stationId,
				poolId: event.poolId,
				tier: event.tier,
				slotId: event.slotId,
				runnerLabel: event.runnerLabel,
				externalRunnerId: event.externalRunnerId,
				attempts: event.attempts,
			}),
			JobDispatchCompleted: (view, event) =>
				view._tag === "Bound"
					? {
							_tag: "Completed" as const,
							stationId: event.stationId,
							poolId: view.poolId,
							tier: view.tier,
							slotId: event.slotId,
							runnerLabel: view.runnerLabel,
							externalRunnerId: view.externalRunnerId,
							attempts: view.attempts,
							settledMicros: event.settledMicros,
							conclusion: event.conclusion,
						}
					: view,
			JobDispatchFailed: (view, event) => ({
				_tag: "Failed" as const,
				stationId: stationIdOf(view),
				reason: event.reason,
			}),
			JobDispatchExpired: (view, event) => ({
				_tag: "Expired" as const,
				stationId: stationIdOf(view),
				reason: event.reason,
			}),
		},
	},
	{
		description:
			"Per-job routing decision, chosen runner tier, attempts, and settlement audit.",
	},
) {}
