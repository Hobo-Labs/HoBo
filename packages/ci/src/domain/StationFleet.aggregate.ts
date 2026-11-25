import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	JobDispatchId,
	JobRequirements,
	NonEmptyReason,
	NonNegativeCount,
	NonNegativeMicros,
	PayerId,
	PoolRole,
	PositiveConcurrency,
	RunnerPoolHealth,
	RunnerPoolId,
	RunnerPoolSpec,
	RunnerTier,
	RunsOnLabel,
	SlotId,
	StationId,
} from "./ids.js";

export class NoEligibleRunnerPool extends Domain.Rejection(
	"NoEligibleRunnerPool",
	{
		reasons: Schema.Array(NonEmptyReason),
	},
) {}

export class BudgetCeilingExceeded extends Domain.Rejection(
	"BudgetCeilingExceeded",
	{
		exposureMicros: NonNegativeMicros,
		requestedMicros: NonNegativeMicros,
		ceilingMicros: NonNegativeMicros,
	},
) {}

export class BudgetCeilingBelowExposure extends Domain.Rejection(
	"BudgetCeilingBelowExposure",
	{
		exposureMicros: NonNegativeMicros,
		ceilingMicros: NonNegativeMicros,
	},
) {}

export class DuplicateJobReservation extends Domain.Rejection(
	"DuplicateJobReservation",
	{
		jobId: JobDispatchId,
		existingSlotId: SlotId,
	},
) {}

export class UnknownRunnerPool extends Domain.Rejection("UnknownRunnerPool", {
	poolId: RunnerPoolId,
}) {}

export class StationBudgetConfigured extends Domain.Event(
	"StationBudgetConfigured",
	{
		ceilingMicros: Schema.NullOr(NonNegativeMicros),
	},
) {}

export class RunnerPoolRegistered extends Domain.Event("RunnerPoolRegistered", {
	spec: RunnerPoolSpec,
}) {}

export class RunnerPoolHealthChanged extends Domain.Event(
	"RunnerPoolHealthChanged",
	{
		poolId: RunnerPoolId,
		health: RunnerPoolHealth,
		enabled: Schema.Boolean,
	},
) {}

export class BalancedSlotReserved extends Domain.Event("BalancedSlotReserved", {
	slotId: SlotId,
	jobId: JobDispatchId,
	poolId: RunnerPoolId,
	tier: RunnerTier,
	runsOn: RunsOnLabel,
	payer: PayerId,
	reservedMicros: NonNegativeMicros,
}) {}

export class BalancedSlotReleased extends Domain.Event("BalancedSlotReleased", {
	slotId: SlotId,
	jobId: JobDispatchId,
	poolId: RunnerPoolId,
	payer: PayerId,
	reservedMicros: NonNegativeMicros,
	settledMicros: NonNegativeMicros,
}) {}

export class BalancedSlotReleaseSkipped extends Domain.Event(
	"BalancedSlotReleaseSkipped",
	{
		slotId: SlotId,
		reason: NonEmptyReason,
	},
) {}

export class ConfigureStationBudget extends Domain.Command(
	"ConfigureStationBudget",
	{
		target: StationId,
		input: {
			ceilingMicros: Schema.NullOr(NonNegativeMicros),
		},
		events: [StationBudgetConfigured],
		rejects: [BudgetCeilingBelowExposure],
	},
	{ description: "Set or clear the hard spend ceiling for a CI station." },
) {}

export class RegisterRunnerPool extends Domain.Command(
	"RegisterRunnerPool",
	{
		target: StationId,
		input: {
			spec: RunnerPoolSpec,
		},
		events: [RunnerPoolRegistered],
		rejects: [],
	},
	{
		description:
			"Register a local, Hostinger, Agent37, or GitHub-hosted runner pool on a CI station.",
	},
) {}

export class SetRunnerPoolHealth extends Domain.Command(
	"SetRunnerPoolHealth",
	{
		target: StationId,
		input: {
			poolId: RunnerPoolId,
			health: RunnerPoolHealth,
			enabled: Schema.Boolean,
		},
		events: [RunnerPoolHealthChanged],
		rejects: [UnknownRunnerPool],
	},
	{ description: "Update health and enabled status of a runner pool." },
) {}

export class ReserveBalancedSlot extends Domain.Command(
	"ReserveBalancedSlot",
	{
		target: StationId,
		input: {
			jobId: JobDispatchId,
			requirements: JobRequirements,
			excludedPoolIds: Schema.Array(RunnerPoolId),
		},
		events: [BalancedSlotReserved],
		rejects: [
			NoEligibleRunnerPool,
			BudgetCeilingExceeded,
			DuplicateJobReservation,
		],
		reply: {
			slotId: SlotId,
			poolId: RunnerPoolId,
			tier: RunnerTier,
			runsOn: RunsOnLabel,
			reservedMicros: NonNegativeMicros,
		},
	},
	{
		description:
			"Atomically balance and reserve a runner slot across local, Hostinger, Agent37, and GitHub-hosted pools within budget.",
	},
) {}

export class ReleaseBalancedSlot extends Domain.Command(
	"ReleaseBalancedSlot",
	{
		target: StationId,
		input: {
			slotId: SlotId,
			settledMicros: NonNegativeMicros,
		},
		events: [BalancedSlotReleased, BalancedSlotReleaseSkipped],
		rejects: [],
	},
	{
		description:
			"Release a previously reserved runner slot and reconcile settled spend.",
	},
) {}

const PoolEntry = Schema.Struct({
	poolId: RunnerPoolId,
	tier: RunnerTier,
	role: PoolRole,
	runsOn: RunsOnLabel,
	concurrency: PositiveConcurrency,
	activeJobs: NonNegativeCount,
	costPerMinuteMicros: NonNegativeMicros,
	payer: PayerId,
	payerBudgetMicros: Schema.NullOr(NonNegativeMicros),
	isolated: Schema.Boolean,
	docker: Schema.Boolean,
	publicRepositories: Schema.Boolean,
	health: RunnerPoolHealth,
	enabled: Schema.Boolean,
});
type PoolEntry = typeof PoolEntry.Type;

const ActiveReservation = Schema.Struct({
	slotId: SlotId,
	jobId: JobDispatchId,
	poolId: RunnerPoolId,
	tier: RunnerTier,
	runsOn: RunsOnLabel,
	payer: PayerId,
	reservedMicros: NonNegativeMicros,
});

const PayerExposureEntry = Schema.Struct({
	payer: PayerId,
	exposureMicros: NonNegativeMicros,
});

export const StationFleetState = Schema.Struct({
	ceilingMicros: Schema.NullOr(NonNegativeMicros),
	exposureMicros: NonNegativeMicros,
	nextSlotSeq: NonNegativeCount,
	pools: Schema.Array(PoolEntry),
	payerExposure: Schema.Array(PayerExposureEntry),
	reservations: Schema.Array(ActiveReservation),
});
export type StationFleetState = typeof StationFleetState.Type;

const ZERO_MICROS = NonNegativeMicros.make(0);
const ZERO_COUNT = NonNegativeCount.make(0);

const ROLE_PRIORITY = {
	primary: 0,
	overflow: 1,
	"last-resort": 2,
} as const satisfies Record<PoolRole, number>;

const TIER_PRIORITY = {
	local: 0,
	hostinger: 1,
	agent37: 2,
	boat: 3,
	github: 4,
} as const satisfies Record<RunnerTier, number>;

function toNonNegativeMicros(value: number): NonNegativeMicros {
	return NonNegativeMicros.make(value <= 0 ? 0 : value);
}

function toNonNegativeCount(value: number): NonNegativeCount {
	return NonNegativeCount.make(value <= 0 ? 0 : value);
}

function payerExposureFor(
	state: StationFleetState,
	payer: PayerId,
): NonNegativeMicros {
	return (
		state.payerExposure.find((entry) => entry.payer === payer)
			?.exposureMicros ?? ZERO_MICROS
	);
}

function updatePayerExposure(
	entries: readonly {
		readonly payer: PayerId;
		readonly exposureMicros: NonNegativeMicros;
	}[],
	payer: PayerId,
	deltaMicros: number,
): Array<{ payer: PayerId; exposureMicros: NonNegativeMicros }> {
	const existing = entries.find((entry) => entry.payer === payer);
	if (!existing) {
		return [
			...entries.map((entry) => ({
				payer: entry.payer,
				exposureMicros: entry.exposureMicros,
			})),
			{ payer, exposureMicros: toNonNegativeMicros(deltaMicros) },
		];
	}
	return entries.map((entry) =>
		entry.payer === payer
			? {
					payer: entry.payer,
					exposureMicros: toNonNegativeMicros(
						entry.exposureMicros + deltaMicros,
					),
				}
			: { payer: entry.payer, exposureMicros: entry.exposureMicros },
	);
}

function utilizationRatio(pool: PoolEntry): number {
	return pool.activeJobs / pool.concurrency;
}

function compareCandidates(
	left: { readonly pool: PoolEntry; readonly costMicros: NonNegativeMicros },
	right: { readonly pool: PoolEntry; readonly costMicros: NonNegativeMicros },
): number {
	const roleDiff =
		ROLE_PRIORITY[left.pool.role] - ROLE_PRIORITY[right.pool.role];
	if (roleDiff !== 0) return roleDiff;
	const utilDiff = utilizationRatio(left.pool) - utilizationRatio(right.pool);
	if (utilDiff !== 0) return utilDiff;
	const costDiff = left.costMicros - right.costMicros;
	if (costDiff !== 0) return costDiff;
	const tierDiff =
		TIER_PRIORITY[left.pool.tier] - TIER_PRIORITY[right.pool.tier];
	if (tierDiff !== 0) return tierDiff;
	return left.pool.poolId.localeCompare(right.pool.poolId);
}

export class StationFleet extends Domain.Aggregate("StationFleet", {
	id: StationId,
	state: StationFleetState,
	initial: {
		ceilingMicros: null,
		exposureMicros: ZERO_MICROS,
		nextSlotSeq: ZERO_COUNT,
		pools: [],
		payerExposure: [],
		reservations: [],
	},
	commands: [
		ConfigureStationBudget,
		RegisterRunnerPool,
		SetRunnerPoolHealth,
		ReserveBalancedSlot,
		ReleaseBalancedSlot,
	],
	decide: {
		ConfigureStationBudget: (state, cmd) => {
			if (
				cmd.ceilingMicros !== null &&
				cmd.ceilingMicros < state.exposureMicros
			) {
				return new BudgetCeilingBelowExposure({
					exposureMicros: state.exposureMicros,
					ceilingMicros: cmd.ceilingMicros,
				});
			}
			return [
				new StationBudgetConfigured({ ceilingMicros: cmd.ceilingMicros }),
			];
		},
		RegisterRunnerPool: (_state, cmd) => [
			new RunnerPoolRegistered({ spec: cmd.spec }),
		],
		SetRunnerPoolHealth: (state, cmd) => {
			const exists = state.pools.some((pool) => pool.poolId === cmd.poolId);
			if (!exists) return new UnknownRunnerPool({ poolId: cmd.poolId });
			return [
				new RunnerPoolHealthChanged({
					poolId: cmd.poolId,
					health: cmd.health,
					enabled: cmd.enabled,
				}),
			];
		},
		ReserveBalancedSlot: (state, cmd) => {
			const duplicate = state.reservations.find(
				(item) => item.jobId === cmd.jobId,
			);
			if (duplicate) {
				return new DuplicateJobReservation({
					jobId: cmd.jobId,
					existingSlotId: duplicate.slotId,
				});
			}

			const excluded = new Set(cmd.excludedPoolIds);
			const reasons: NonEmptyReason[] = [];
			const eligible: Array<{
				pool: PoolEntry;
				costMicros: NonNegativeMicros;
			}> = [];
			let budgetBlocked:
				| {
						readonly requestedMicros: NonNegativeMicros;
						readonly ceilingMicros: NonNegativeMicros;
						readonly exposureMicros: NonNegativeMicros;
				  }
				| undefined;

			for (const pool of state.pools) {
				if (excluded.has(pool.poolId)) {
					reasons.push(NonEmptyReason.make(`${pool.poolId}:excluded`));
					continue;
				}
				if (!pool.enabled) {
					reasons.push(NonEmptyReason.make(`${pool.poolId}:disabled`));
					continue;
				}
				if (pool.health !== "healthy") {
					reasons.push(NonEmptyReason.make(`${pool.poolId}:${pool.health}`));
					continue;
				}
				if (pool.activeJobs >= pool.concurrency) {
					reasons.push(NonEmptyReason.make(`${pool.poolId}:saturated`));
					continue;
				}
				if (cmd.requirements.needsDocker && !pool.docker) {
					reasons.push(NonEmptyReason.make(`${pool.poolId}:no-docker`));
					continue;
				}
				if (cmd.requirements.isolationRequired && !pool.isolated) {
					reasons.push(NonEmptyReason.make(`${pool.poolId}:not-isolated`));
					continue;
				}
				if (cmd.requirements.publicRepository && !pool.publicRepositories) {
					reasons.push(NonEmptyReason.make(`${pool.poolId}:private-only`));
					continue;
				}

				const costMicros = NonNegativeMicros.make(
					cmd.requirements.minutes * pool.costPerMinuteMicros,
				);
				if (
					state.ceilingMicros !== null &&
					state.exposureMicros + costMicros > state.ceilingMicros
				) {
					budgetBlocked = {
						exposureMicros: state.exposureMicros,
						requestedMicros: costMicros,
						ceilingMicros: state.ceilingMicros,
					};
					reasons.push(NonEmptyReason.make(`${pool.poolId}:station-budget`));
					continue;
				}
				const currentPayerExposure = payerExposureFor(state, pool.payer);
				if (
					pool.payerBudgetMicros !== null &&
					currentPayerExposure + costMicros > pool.payerBudgetMicros
				) {
					budgetBlocked = {
						exposureMicros: currentPayerExposure,
						requestedMicros: costMicros,
						ceilingMicros: pool.payerBudgetMicros,
					};
					reasons.push(NonEmptyReason.make(`${pool.poolId}:payer-budget`));
					continue;
				}
				eligible.push({ pool, costMicros });
			}

			if (eligible.length === 0) {
				if (
					budgetBlocked !== undefined &&
					reasons.every((r) => r.endsWith("-budget") || r.endsWith(":excluded"))
				) {
					return new BudgetCeilingExceeded(budgetBlocked);
				}
				return new NoEligibleRunnerPool({ reasons });
			}

			eligible.sort(compareCandidates);
			const chosen = eligible[0];
			if (!chosen) return new NoEligibleRunnerPool({ reasons });

			const slotId = SlotId.make(
				`slot-${state.nextSlotSeq + 1}-${chosen.pool.poolId}`,
			);
			return [
				new BalancedSlotReserved({
					slotId,
					jobId: cmd.jobId,
					poolId: chosen.pool.poolId,
					tier: chosen.pool.tier,
					runsOn: chosen.pool.runsOn,
					payer: chosen.pool.payer,
					reservedMicros: chosen.costMicros,
				}),
			];
		},
		ReleaseBalancedSlot: (state, cmd) => {
			const reservation = state.reservations.find(
				(item) => item.slotId === cmd.slotId,
			);
			if (!reservation) {
				return [
					new BalancedSlotReleaseSkipped({
						slotId: cmd.slotId,
						reason: NonEmptyReason.make("slot-not-active"),
					}),
				];
			}
			return [
				new BalancedSlotReleased({
					slotId: reservation.slotId,
					jobId: reservation.jobId,
					poolId: reservation.poolId,
					payer: reservation.payer,
					reservedMicros: reservation.reservedMicros,
					settledMicros: cmd.settledMicros,
				}),
			];
		},
	},
	evolve: {
		StationBudgetConfigured: (state, event) => ({
			...state,
			ceilingMicros: event.ceilingMicros,
		}),
		RunnerPoolRegistered: (state, event) => {
			const existing = state.pools.find(
				(pool) => pool.poolId === event.spec.poolId,
			);
			const nextEntry: PoolEntry = {
				...event.spec,
				activeJobs: existing?.activeJobs ?? ZERO_COUNT,
				health: existing?.health ?? "healthy",
				enabled: existing?.enabled ?? true,
			};
			const pools = existing
				? state.pools.map((pool) =>
						pool.poolId === event.spec.poolId ? nextEntry : pool,
					)
				: [...state.pools, nextEntry];
			return { ...state, pools };
		},
		RunnerPoolHealthChanged: (state, event) => ({
			...state,
			pools: state.pools.map((pool) =>
				pool.poolId === event.poolId
					? { ...pool, health: event.health, enabled: event.enabled }
					: pool,
			),
		}),
		BalancedSlotReserved: (state, event) => ({
			...state,
			nextSlotSeq: NonNegativeCount.make(state.nextSlotSeq + 1),
			exposureMicros: NonNegativeMicros.make(
				state.exposureMicros + event.reservedMicros,
			),
			payerExposure: updatePayerExposure(
				state.payerExposure,
				event.payer,
				event.reservedMicros,
			),
			pools: state.pools.map((pool) =>
				pool.poolId === event.poolId
					? {
							...pool,
							activeJobs: NonNegativeCount.make(pool.activeJobs + 1),
						}
					: pool,
			),
			reservations: [
				...state.reservations,
				{
					slotId: event.slotId,
					jobId: event.jobId,
					poolId: event.poolId,
					tier: event.tier,
					runsOn: event.runsOn,
					payer: event.payer,
					reservedMicros: event.reservedMicros,
				},
			],
		}),
		BalancedSlotReleased: (state, event) => {
			const delta = event.settledMicros - event.reservedMicros;
			return {
				...state,
				exposureMicros: toNonNegativeMicros(state.exposureMicros + delta),
				payerExposure: updatePayerExposure(
					state.payerExposure,
					event.payer,
					delta,
				),
				pools: state.pools.map((pool) =>
					pool.poolId === event.poolId
						? { ...pool, activeJobs: toNonNegativeCount(pool.activeJobs - 1) }
						: pool,
				),
				reservations: state.reservations.filter(
					(item) => item.slotId !== event.slotId,
				),
			};
		},
		BalancedSlotReleaseSkipped: (state) => state,
	},
	reply: {
		ReserveBalancedSlot: (_state, events) => {
			const reserved = events.find(
				(event): event is BalancedSlotReserved =>
					event._tag === "BalancedSlotReserved",
			);
			return {
				slotId: reserved?.slotId ?? SlotId.make("slot-unassigned"),
				poolId: reserved?.poolId ?? RunnerPoolId.make("pool-unassigned"),
				tier: reserved?.tier ?? "github",
				runsOn: reserved?.runsOn ?? RunsOnLabel.make("ubuntu-24.04"),
				reservedMicros: reserved?.reservedMicros ?? ZERO_MICROS,
			};
		},
	},
}) {}
