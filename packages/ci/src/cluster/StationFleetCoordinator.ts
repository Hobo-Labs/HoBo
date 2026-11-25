import * as ClusterCron from "effect/cluster/ClusterCron";
import * as ClusterSchema from "effect/cluster/ClusterSchema";
import * as Entity from "effect/cluster/Entity";
import * as Singleton from "effect/cluster/Singleton";
import * as Cron from "effect/Cron";
import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import {
	JobRequirements,
	PoolRole,
	RunnerPoolHealth,
	RunnerTier,
} from "../domain/ids.js";

export const ClusterRunnerPoolSpec = Schema.Struct({
	poolId: Schema.String,
	tier: RunnerTier,
	role: PoolRole,
	runnerLabel: Schema.String,
	concurrency: Schema.Int,
	costPerMinuteMicros: Schema.Int,
	payer: Schema.String,
	payerBudgetMicros: Schema.NullOr(Schema.Int),
	isolated: Schema.Boolean,
	docker: Schema.Boolean,
	publicRepositories: Schema.Boolean,
});
export type ClusterRunnerPoolSpec = typeof ClusterRunnerPoolSpec.Type;

export class FleetNoCapacityError extends Schema.TaggedError<
	FleetNoCapacityError,
	{ readonly brand: unique symbol }
>()("FleetNoCapacityError", {
	reasons: Schema.Array(Schema.String),
}) {}

export class FleetBudgetExceededError extends Schema.TaggedError<
	FleetBudgetExceededError,
	{ readonly brand: unique symbol }
>()("FleetBudgetExceededError", {
	exposureMicros: Schema.Int,
	requestedMicros: Schema.Int,
	ceilingMicros: Schema.Int,
}) {}

export const DispatchedLeaseSchema = Schema.Struct({
	slotId: Schema.String,
	jobId: Schema.String,
	poolId: Schema.String,
	tier: RunnerTier,
	runnerLabel: Schema.String,
	reservedMicros: Schema.Int,
	expiresAtMs: Schema.Int,
});
export type DispatchedLease = typeof DispatchedLeaseSchema.Type;

export const PoolUtilizationSchema = Schema.Struct({
	poolId: Schema.String,
	tier: RunnerTier,
	role: PoolRole,
	activeJobs: Schema.Int,
	concurrency: Schema.Int,
	health: RunnerPoolHealth,
	enabled: Schema.Boolean,
});

export const FleetSnapshotSchema = Schema.Struct({
	stationId: Schema.String,
	ceilingMicros: Schema.NullOr(Schema.Int),
	exposureMicros: Schema.Int,
	activeLeases: Schema.Int,
	pools: Schema.Array(PoolUtilizationSchema),
});
export type FleetSnapshot = typeof FleetSnapshotSchema.Type;

export const ConfigureStationBudgetRpc = Rpc.make("ConfigureBudget", {
	payload: {
		ceilingMicros: Schema.NullOr(Schema.Int),
	},
	success: Schema.Struct({ ceilingMicros: Schema.NullOr(Schema.Int) }),
}).annotate(ClusterSchema.Persisted, true);

export const RegisterPoolRpc = Rpc.make("RegisterPool", {
	payload: {
		spec: ClusterRunnerPoolSpec,
	},
	success: Schema.Struct({ poolId: Schema.String }),
}).annotate(ClusterSchema.Persisted, true);

export const DispatchJobRpc = Rpc.make("DispatchJob", {
	payload: {
		jobId: Schema.String,
		requirements: JobRequirements,
		leaseTtlMs: Schema.Int,
		nowMs: Schema.Int,
	},
	success: DispatchedLeaseSchema,
	error: Schema.Union([FleetNoCapacityError, FleetBudgetExceededError]),
	primaryKey: ({ jobId }) => jobId,
}).annotate(ClusterSchema.Persisted, true);

export const CompleteJobRpc = Rpc.make("CompleteJob", {
	payload: {
		slotId: Schema.String,
		settledMicros: Schema.Int,
	},
	success: Schema.Struct({ released: Schema.Boolean }),
}).annotate(ClusterSchema.Persisted, true);

export const ReapExpiredLeasesRpc = Rpc.make("ReapExpiredLeases", {
	payload: {
		nowMs: Schema.Int,
	},
	success: Schema.Struct({
		reapedSlotIds: Schema.Array(Schema.String),
	}),
}).annotate(ClusterSchema.Persisted, true);

export const FleetSnapshotRpc = Rpc.make("FleetSnapshot", {
	success: FleetSnapshotSchema,
});

export const StationFleetCoordinator = Entity.make("StationFleetCoordinator", [
	ConfigureStationBudgetRpc,
	RegisterPoolRpc,
	DispatchJobRpc,
	CompleteJobRpc,
	ReapExpiredLeasesRpc,
	FleetSnapshotRpc,
]);

interface InternalPoolState {
	readonly spec: ClusterRunnerPoolSpec;
	activeJobs: number;
	health: "healthy" | "degraded" | "unhealthy";
	enabled: boolean;
}

interface InternalLeaseState {
	readonly slotId: string;
	readonly jobId: string;
	readonly poolId: string;
	readonly tier: RunnerTier;
	readonly runnerLabel: string;
	readonly payer: string;
	readonly reservedMicros: number;
	readonly expiresAtMs: number;
}

const ROLE_ORDER = {
	primary: 0,
	overflow: 1,
	"last-resort": 2,
} as const satisfies Record<PoolRole, number>;

const TIER_ORDER = {
	local: 0,
	hostinger: 1,
	agent37: 2,
	boat: 3,
	hosted: 4,
} as const satisfies Record<RunnerTier, number>;

export const StationFleetCoordinatorLive = StationFleetCoordinator.toLayer(
	Effect.gen(function* () {
		const address = yield* Entity.CurrentAddress;
		let ceilingMicros: number | null = null;
		let exposureMicros = 0;
		let nextSeq = 0;
		const pools = new Map<string, InternalPoolState>();
		const payerExposure = new Map<string, number>();
		const leasesBySlot = new Map<string, InternalLeaseState>();
		const leasesByJob = new Map<string, InternalLeaseState>();

		const adjustPayerExposure = (payer: string, delta: number) => {
			const current = payerExposure.get(payer) ?? 0;
			payerExposure.set(payer, Math.max(0, current + delta));
		};

		return {
			ConfigureBudget: (envelope) =>
				Effect.sync(() => {
					ceilingMicros = envelope.payload.ceilingMicros;
					return { ceilingMicros };
				}),
			RegisterPool: (envelope) =>
				Effect.sync(() => {
					const spec = envelope.payload.spec;
					const existing = pools.get(spec.poolId);
					pools.set(spec.poolId, {
						spec,
						activeJobs: existing?.activeJobs ?? 0,
						health: existing?.health ?? "healthy",
						enabled: existing?.enabled ?? true,
					});
					return { poolId: spec.poolId };
				}),
			DispatchJob: (envelope) =>
				Effect.suspend<
					DispatchedLease,
					FleetNoCapacityError | FleetBudgetExceededError,
					never
				>(() => {
					const { jobId, requirements, leaseTtlMs, nowMs } = envelope.payload;
					const existing = leasesByJob.get(jobId);
					if (existing !== undefined) {
						return Effect.succeed({
							slotId: existing.slotId,
							jobId: existing.jobId,
							poolId: existing.poolId,
							tier: existing.tier,
							runnerLabel: existing.runnerLabel,
							reservedMicros: existing.reservedMicros,
							expiresAtMs: existing.expiresAtMs,
						});
					}

					const reasons: string[] = [];
					const eligible: Array<{
						readonly pool: InternalPoolState;
						readonly costMicros: number;
					}> = [];
					let budgetBlocked:
						| {
								readonly exposureMicros: number;
								readonly requestedMicros: number;
								readonly ceilingMicros: number;
						  }
						| undefined;

					for (const pool of pools.values()) {
						if (!pool.enabled) {
							reasons.push(`${pool.spec.poolId}:disabled`);
							continue;
						}
						if (pool.health !== "healthy") {
							reasons.push(`${pool.spec.poolId}:${pool.health}`);
							continue;
						}
						if (pool.activeJobs >= pool.spec.concurrency) {
							reasons.push(`${pool.spec.poolId}:saturated`);
							continue;
						}
						if (requirements.needsDocker && !pool.spec.docker) {
							reasons.push(`${pool.spec.poolId}:no-docker`);
							continue;
						}
						if (requirements.isolationRequired && !pool.spec.isolated) {
							reasons.push(`${pool.spec.poolId}:not-isolated`);
							continue;
						}
						if (requirements.publicRepository && !pool.spec.publicRepositories) {
							reasons.push(`${pool.spec.poolId}:private-only`);
							continue;
						}

						const costMicros = Math.max(
							0,
							requirements.minutes * pool.spec.costPerMinuteMicros,
						);
						if (
							ceilingMicros !== null &&
							exposureMicros + costMicros > ceilingMicros
						) {
							budgetBlocked = {
								exposureMicros,
								requestedMicros: costMicros,
								ceilingMicros,
							};
							reasons.push(`${pool.spec.poolId}:station-budget`);
							continue;
						}
						const currentPayer = payerExposure.get(pool.spec.payer) ?? 0;
						if (
							pool.spec.payerBudgetMicros !== null &&
							currentPayer + costMicros > pool.spec.payerBudgetMicros
						) {
							budgetBlocked = {
								exposureMicros: currentPayer,
								requestedMicros: costMicros,
								ceilingMicros: pool.spec.payerBudgetMicros,
							};
							reasons.push(`${pool.spec.poolId}:payer-budget`);
							continue;
						}
						eligible.push({ pool, costMicros });
					}

					if (eligible.length === 0) {
						if (
							budgetBlocked !== undefined &&
							reasons.every((r) => r.endsWith("-budget"))
						) {
							return Effect.fail(new FleetBudgetExceededError(budgetBlocked));
						}
						return Effect.fail(new FleetNoCapacityError({ reasons }));
					}

					eligible.sort((left, right) => {
						const roleDiff =
							ROLE_ORDER[left.pool.spec.role] -
							ROLE_ORDER[right.pool.spec.role];
						if (roleDiff !== 0) return roleDiff;
						const leftUtil =
							left.pool.spec.concurrency > 0
								? left.pool.activeJobs / left.pool.spec.concurrency
								: 1;
						const rightUtil =
							right.pool.spec.concurrency > 0
								? right.pool.activeJobs / right.pool.spec.concurrency
								: 1;
						if (leftUtil !== rightUtil) return leftUtil - rightUtil;
						if (left.costMicros !== right.costMicros) {
							return left.costMicros - right.costMicros;
						}
						const tierDiff =
							TIER_ORDER[left.pool.spec.tier] -
							TIER_ORDER[right.pool.spec.tier];
						if (tierDiff !== 0) return tierDiff;
						return left.pool.spec.poolId.localeCompare(right.pool.spec.poolId);
					});

					const chosen = eligible[0];
					if (chosen === undefined) {
						return Effect.fail(new FleetNoCapacityError({ reasons }));
					}

					nextSeq += 1;
					const slotId = `cluster-slot-${nextSeq}-${chosen.pool.spec.poolId}`;
					const lease: InternalLeaseState = {
						slotId,
						jobId,
						poolId: chosen.pool.spec.poolId,
						tier: chosen.pool.spec.tier,
						runnerLabel: chosen.pool.spec.runnerLabel,
						payer: chosen.pool.spec.payer,
						reservedMicros: chosen.costMicros,
						expiresAtMs: nowMs + Math.max(1_000, leaseTtlMs),
					};
					chosen.pool.activeJobs += 1;
					exposureMicros += lease.reservedMicros;
					adjustPayerExposure(lease.payer, lease.reservedMicros);
					leasesBySlot.set(slotId, lease);
					leasesByJob.set(jobId, lease);
					return Effect.succeed({
						slotId: lease.slotId,
						jobId: lease.jobId,
						poolId: lease.poolId,
						tier: lease.tier,
						runnerLabel: lease.runnerLabel,
						reservedMicros: lease.reservedMicros,
						expiresAtMs: lease.expiresAtMs,
					});
				}),
			CompleteJob: (envelope) =>
				Effect.sync(() => {
					const lease = leasesBySlot.get(envelope.payload.slotId);
					if (lease === undefined) {
						return { released: false };
					}
					leasesBySlot.delete(lease.slotId);
					leasesByJob.delete(lease.jobId);
					const pool = pools.get(lease.poolId);
					if (pool !== undefined) {
						pool.activeJobs = Math.max(0, pool.activeJobs - 1);
					}
					const settled = Math.max(0, envelope.payload.settledMicros);
					const delta = settled - lease.reservedMicros;
					exposureMicros = Math.max(0, exposureMicros + delta);
					adjustPayerExposure(lease.payer, delta);
					return { released: true };
				}),
			ReapExpiredLeases: (envelope) =>
				Effect.sync(() => {
					const reapedSlotIds: string[] = [];
					for (const lease of leasesBySlot.values()) {
						if (lease.expiresAtMs <= envelope.payload.nowMs) {
							leasesBySlot.delete(lease.slotId);
							leasesByJob.delete(lease.jobId);
							const pool = pools.get(lease.poolId);
							if (pool !== undefined) {
								pool.activeJobs = Math.max(0, pool.activeJobs - 1);
							}
							exposureMicros = Math.max(
								0,
								exposureMicros - lease.reservedMicros,
							);
							adjustPayerExposure(lease.payer, -lease.reservedMicros);
							reapedSlotIds.push(lease.slotId);
						}
					}
					return { reapedSlotIds };
				}),
			FleetSnapshot: () =>
				Effect.sync(() => ({
					stationId: String(address.entityId),
					ceilingMicros,
					exposureMicros,
					activeLeases: leasesBySlot.size,
					pools: [...pools.values()].map((pool) => ({
						poolId: pool.spec.poolId,
						tier: pool.spec.tier,
						role: pool.spec.role,
						activeJobs: pool.activeJobs,
						concurrency: pool.spec.concurrency,
						health: pool.health,
						enabled: pool.enabled,
					})),
				})),
		};
	}),
	{ concurrency: 1 },
);

export function createFleetLeaseReaperSingleton(options: {
	readonly stationIds: readonly string[];
	readonly nowMs: () => number;
	readonly onReaped?: (stationId: string, reapedSlotIds: readonly string[]) => void;
}) {
	return Singleton.make(
		"hobo-ci-fleet-lease-reaper",
		Effect.gen(function* () {
			const makeClient = yield* StationFleetCoordinator.client;
			for (const stationId of options.stationIds) {
				const result = yield* makeClient(stationId).ReapExpiredLeases({
					nowMs: options.nowMs(),
				});
				options.onReaped?.(stationId, result.reapedSlotIds);
			}
		}),
	);
}

export function createFleetHealthSweepCron(options: {
	readonly stationIds: readonly string[];
	readonly cronExpression?: string;
	readonly nowMs: () => number;
	readonly onSweep?: (stationId: string, reapedSlotIds: readonly string[]) => void;
}) {
	const cron = Cron.parseUnsafe(options.cronExpression ?? "*/5 * * * *");
	return ClusterCron.make({
		name: "hobo-ci-fleet-health-sweep",
		cron,
		calculateNextRunFromPrevious: true,
		execute: Effect.gen(function* () {
			const makeClient = yield* StationFleetCoordinator.client;
			for (const stationId of options.stationIds) {
				const result = yield* makeClient(stationId).ReapExpiredLeases({
					nowMs: options.nowMs(),
				});
				options.onSweep?.(stationId, result.reapedSlotIds);
			}
		}),
	});
}
