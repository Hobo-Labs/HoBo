import { BackendFleetError } from "./errors.js";
import {
	DEFAULT_FLEET_POLICY,
	type FleetBudgetCheck,
	type FleetPolicy,
	parseFleetPolicy,
} from "./policy.js";

export type ContinuityRequest = Readonly<{
	tier: string;
	onLoss: "rebuild" | "restore";
	recoveryPointMs: number;
	failoverAfterMs: number;
	standbys: number;
	migration: "continuous" | "on-failure";
	backupEveryMs: number;
	backupsKept: number;
	monthlyBudgetMicros?: number;
}>;

export type ContinuityFleetPlan = Readonly<{
	tier: string;
	fleet: FleetPolicy;
	standbys: number;
	copy: "snapshot" | "cold";
	copyEveryMs: number;
	backups: Readonly<{ everyMs: number; kept: number }>;
	monthlyBudgetMicros: number | undefined;
}>;

export const MIN_COPY_INTERVAL_MS = 15_000;

export function continuityFleetPlan(
	request: ContinuityRequest,
): ContinuityFleetPlan {
	const rebuild = request.onLoss === "rebuild";
	if (!rebuild && request.standbys > 0 && request.recoveryPointMs < 1_000)
		throw new BackendFleetError(
			"FLEET_CONFIGURATION_INVALID",
			"a copied standby needs a recovery point of at least 1000 ms",
			{ detail: { field: "recoveryPointMs" } },
		);
	const continuous = request.migration === "continuous";
	const fleet = parseFleetPolicy({
		rpoMs: rebuild ? Number.MAX_SAFE_INTEGER : request.recoveryPointMs,
		failoverAfterMs: request.failoverAfterMs,
		exhaustionHorizonMs: DEFAULT_FLEET_POLICY.exhaustionHorizonMs,
		hysteresisFactor: DEFAULT_FLEET_POLICY.hysteresisFactor,
		minDwellMs: continuous
			? DEFAULT_FLEET_POLICY.minDwellMs
			: Number.MAX_SAFE_INTEGER,
	});
	const copy = rebuild || request.standbys === 0 ? "cold" : "snapshot";
	return Object.freeze({
		tier: request.tier,
		fleet,
		standbys: request.standbys,
		copy,
		copyEveryMs:
			copy === "cold"
				? 0
				: Math.max(
						MIN_COPY_INTERVAL_MS,
						Math.floor(request.recoveryPointMs / 2),
					),
		backups: Object.freeze({
			everyMs: request.backupEveryMs,
			kept: request.backupsKept,
		}),
		monthlyBudgetMicros: request.monthlyBudgetMicros,
	});
}

export function continuityBudgetCheck(
	plan: ContinuityFleetPlan,
	host?: FleetBudgetCheck,
): FleetBudgetCheck {
	return (request) => {
		const ceiling = plan.monthlyBudgetMicros;
		if (ceiling !== undefined && request.costBoundMicros > ceiling)
			return {
				ok: false,
				code: "continuity-budget-exceeded",
				reason: `${request.backend} would cost ${request.costBoundMicros} micro-USD this period, over the declared ${ceiling}`,
			};
		return (
			host?.(request) ?? {
				ok: true,
				code: "continuity-budget-ok",
				reason:
					ceiling === undefined ? "no declared ceiling" : "within ceiling",
			}
		);
	};
}

export type ContinuityShortfall = Readonly<{
	code:
		| "continuity-standbys-short"
		| "continuity-copy-too-slow"
		| "continuity-no-quorum"
		| "continuity-no-vendor-diversity"
		| "continuity-vendor-diversity-unknown"
		| "continuity-backups-unplaced";
	message: string;
}>;

export function continuityShortfalls(
	plan: ContinuityFleetPlan,
	running: Readonly<{
		standbys: number;
		tickEveryMs: number;
		vendors?: number;
		witnesses?: number;
		backupsPlaced?: boolean;
	}>,
): readonly ContinuityShortfall[] {
	const shortfalls: ContinuityShortfall[] = [];
	if (running.standbys < plan.standbys)
		shortfalls.push({
			code: "continuity-standbys-short",
			message: `${plan.tier} asks for ${plan.standbys} standby(s); ${running.standbys} configured backend(s) can serve as one. Configure another backend so one outage is a failover.`,
		});
	if (plan.copy === "snapshot" && running.tickEveryMs > plan.copyEveryMs)
		shortfalls.push({
			code: "continuity-copy-too-slow",
			message: `standbys are copied every ${running.tickEveryMs} ms but the recovery point needs a copy every ${plan.copyEveryMs} ms.`,
		});
	const voters = 1 + running.standbys + (running.witnesses ?? 0);
	if (plan.standbys > 0 && running.standbys > 0 && voters < 3)
		shortfalls.push({
			code: "continuity-no-quorum",
			message: `${voters} members cannot keep a majority when one fails, so a failover waits for the operator. Add a witness (a few rows on any third backend) or another standby.`,
		});
	if (
		plan.standbys > 0 &&
		running.standbys > 0 &&
		running.vendors === undefined
	)
		shortfalls.push({
			code: "continuity-vendor-diversity-unknown",
			message:
				"backend failure-domain diversity is unverified; distinct member names do not establish independent vendors.",
		});
	else if (
		plan.standbys > 0 &&
		running.standbys > 0 &&
		(running.vendors ?? 0) < 2
	)
		shortfalls.push({
			code: "continuity-no-vendor-diversity",
			message:
				"every member is on one vendor, so that vendor's outage stops the data. Configure a backend on another vendor.",
		});
	if (plan.backups.everyMs > 0 && running.backupsPlaced === false)
		shortfalls.push({
			code: "continuity-backups-unplaced",
			message: `${plan.tier} keeps a backup every ${plan.backups.everyMs} ms, and the fleet has nowhere to keep them. Add a witness (or a backup database) on another failure domain.`,
		});
	return Object.freeze(shortfalls);
}
