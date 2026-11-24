import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	PoolRole,
	RunnerPoolHealth,
	RunnerPoolId,
	RunnerTier,
	SlotId,
	StationId,
} from "./ids.js";
import { JobDispatch } from "./JobDispatch.aggregate.js";
import { StationFleet } from "./StationFleet.aggregate.js";

const PoolCapacitySnapshot = Schema.Struct({
	poolId: RunnerPoolId,
	tier: RunnerTier,
	role: PoolRole,
	runsOn: Schema.String,
	concurrency: Schema.Int,
	activeJobs: Schema.Int,
	dispatchedCount: Schema.Int,
	health: RunnerPoolHealth,
	enabled: Schema.Boolean,
});
type PoolCapacitySnapshot = typeof PoolCapacitySnapshot.Type;

export class FleetCapacityView extends Domain.View(
	"FleetCapacityView",
	{
		from: [StationFleet],
		key: StationFleet,
		state: Schema.Struct({
			ceilingMicros: Schema.NullOr(Schema.Int),
			exposureMicros: Schema.Int,
			pools: Schema.Array(PoolCapacitySnapshot),
		}),
		initial: {
			ceilingMicros: null,
			exposureMicros: 0,
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
					runsOn: event.spec.runsOn,
					concurrency: event.spec.concurrency,
					activeJobs: existing?.activeJobs ?? 0,
					dispatchedCount: existing?.dispatchedCount ?? 0,
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
				exposureMicros: view.exposureMicros + event.reservedMicros,
				pools: view.pools.map((pool) =>
					pool.poolId === event.poolId
						? {
								...pool,
								activeJobs: pool.activeJobs + 1,
								dispatchedCount: pool.dispatchedCount + 1,
							}
						: pool,
				),
			}),
			BalancedSlotReleased: (view, event) => ({
				...view,
				exposureMicros: Math.max(
					0,
					view.exposureMicros + event.settledMicros - event.reservedMicros,
				),
				pools: view.pools.map((pool) =>
					pool.poolId === event.poolId
						? { ...pool, activeJobs: Math.max(0, pool.activeJobs - 1) }
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

export class RoutingAuditView extends Domain.View(
	"RoutingAuditView",
	{
		from: [JobDispatch],
		key: JobDispatch,
		state: Schema.Struct({
			status: Schema.Literals([
				"unobserved",
				"queued",
				"bound",
				"completed",
				"failed",
				"expired",
			]),
			stationId: Schema.NullOr(StationId),
			poolId: Schema.NullOr(RunnerPoolId),
			tier: Schema.NullOr(RunnerTier),
			slotId: Schema.NullOr(SlotId),
			runsOn: Schema.NullOr(Schema.String),
			externalRunnerId: Schema.NullOr(Schema.String),
			attempts: Schema.Int,
			settledMicros: Schema.Int,
			reason: Schema.NullOr(Schema.String),
		}),
		initial: {
			status: "unobserved",
			stationId: null,
			poolId: null,
			tier: null,
			slotId: null,
			runsOn: null,
			externalRunnerId: null,
			attempts: 0,
			settledMicros: 0,
			reason: null,
		},
		evolve: {
			JobDispatchObserved: (view, event) => ({
				...view,
				status: "queued" as const,
				stationId: event.stationId,
			}),
			RunnerStartBound: (view, event) => ({
				...view,
				status: "bound" as const,
				stationId: event.stationId,
				poolId: event.poolId,
				tier: event.tier,
				slotId: event.slotId,
				runsOn: event.runsOn,
				externalRunnerId: event.externalRunnerId,
				attempts: event.attempts,
			}),
			JobDispatchCompleted: (view, event) => ({
				...view,
				status: "completed" as const,
				settledMicros: event.settledMicros,
			}),
			JobDispatchFailed: (view, event) => ({
				...view,
				status: "failed" as const,
				reason: event.reason,
			}),
			JobDispatchExpired: (view, event) => ({
				...view,
				status: "expired" as const,
				reason: event.reason,
			}),
		},
	},
	{
		description:
			"Per-job routing decision, chosen runner tier, attempts, and settlement audit.",
	},
) {}
