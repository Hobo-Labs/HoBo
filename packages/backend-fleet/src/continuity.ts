/**
 * From a declared continuity policy to the fleet's operating plan.
 *
 * A Bindle declares continuity with the `continuity` trait (`@hobo/bindles`):
 * how much a failure may lose, how fast to move, how many copies, and whether
 * to keep migrating to cheaper backends. This module is the one place that
 * turns that intent into numbers the fleet runs on, so every engine (the
 * PostgreSQL fleet, the cache fleet, a host's tick) reads the same answer:
 *
 * - `fleet`: the `FleetPolicy` `decideFleet` decides with. Its RPO is the
 *   declared recovery point; its failover delay is the declared one. A
 *   `continuous` policy keeps the default cost signals (switch before a hard
 *   allowance runs out, with hysteresis and a dwell); `on-failure` never makes
 *   a planned switch.
 * - `standbys`: what placement asks for beside the writer.
 * - `copyEveryMs`: how often the writer is copied to the standbys. A snapshot
 *   standby is as stale as the time since its last copy plus the copy itself,
 *   so copying every half recovery point keeps lag inside it; copying more
 *   often than that only spends reads and writes. `rebuildable` state is not
 *   copied at all: a move starts the next backend cold.
 * - `budget`: a `FleetBudgetCheck` holding the fleet to its declared ceiling.
 *
 * Interruption is not a separate mode. Every fleet step is resumable: a copy
 * is one transaction (an interrupted copy leaves the standby as it was), and a
 * move is a sealed entry in the assignment register that the next tick
 * completes or undoes. `continuityShortfalls` says where the running fleet
 * cannot keep the promise (too few standbys, a tick slower than the copy
 * cadence) so a degraded fleet is reported rather than silently trusted.
 */
import { BackendFleetError } from "./errors.js";
import {
	DEFAULT_FLEET_POLICY,
	type FleetBudgetCheck,
	type FleetPolicy,
	parseFleetPolicy,
} from "./policy.js";

/**
 * The declared policy, structurally: `ContinuityPolicy` from `@hobo/bindles`
 * (data-models/bindles.proto) without depending on the Bindle model.
 */
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
	/** `snapshot`: standbys are copied; `cold`: a move starts the next backend empty. */
	copy: "snapshot" | "cold";
	/** How often to copy the writer to every standby; 0 with `cold`. */
	copyEveryMs: number;
	backups: Readonly<{ everyMs: number; kept: number }>;
	monthlyBudgetMicros: number | undefined;
}>;

/** No standby is copied more often than this, whatever the recovery point. */
export const MIN_COPY_INTERVAL_MS = 15_000;

/** Turn a declared continuity policy into the fleet's operating plan. */
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
		// A rebuildable fleet promises nothing about loss: any reachable member
		// may take over, empty.
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

/**
 * Hold a fleet to its declared monthly ceiling, after the host's own budget
 * engine (if any) has agreed. Without a ceiling the host's check decides.
 */
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

/** Where the running fleet cannot keep the declared promise. */
export function continuityShortfalls(
	plan: ContinuityFleetPlan,
	running: Readonly<{
		/** Standbys the placement found. */
		standbys: number;
		/** How often the host actually runs the fleet's tick. */
		tickEveryMs: number;
		/** Verified distinct vendors across writer and standbys, if known. */
		vendors?: number;
		/** Register-only members (`reconcileFleet({ witnesses })`). */
		witnesses?: number;
		/** A member the plan's scheduled backups are kept on. */
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
