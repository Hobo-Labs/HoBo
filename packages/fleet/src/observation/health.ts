/**
 * The shared health functions of design §6.8: pure, used by `MANY_ACTIVE`
 * ranking, by the assignment register's callers and by
 * `@hobo/backend-routing`. An absent figure is unknown, never zero.
 */
import {
	Health,
	type Observation,
	SandboxTier,
	type WorkNeeds,
} from "../_generated/fleet_pb.js";
import type { EligibleMember, NamedObservation } from "../ports.js";

export type WorkFit = Readonly<
	| { fits: true; copies: number }
	| {
			fits: false;
			lacking:
				| "slot"
				| "memory"
				| "disk"
				| "platform"
				| "label"
				| "sandbox"
				| "docker";
	  }
>;

/** How many copies fit in `free` when each needs `need`; unknown on either side constrains nothing. */
function copiesWithin(
	free: number | undefined,
	need: number | undefined,
): number {
	if (free === undefined || need === undefined || need <= 0)
		return Number.POSITIVE_INFINITY;
	return Math.floor(Math.max(0, free) / need);
}

/** A platform field the work names and the device reports, and they differ. */
function differs(wanted: string | undefined, has: string | undefined): boolean {
	return (
		wanted !== undefined &&
		wanted !== "" &&
		has !== undefined &&
		has !== "" &&
		wanted !== has
	);
}

/**
 * Fit work to a device. The checks are ordered so the reason names the first
 * thing that would have to change. A device that is not `REACHABLE` (draining,
 * pressured, failing) has no slot to give.
 */
export function fitObservation(
	observation: Observation,
	needs: WorkNeeds,
): WorkFit {
	if (observation.health !== Health.REACHABLE)
		return { fits: false, lacking: "slot" };
	if (!needs.labels.every((label) => observation.labels.includes(label)))
		return { fits: false, lacking: "label" };
	if (
		differs(needs.platform?.os, observation.platform?.os) ||
		differs(needs.platform?.arch, observation.platform?.arch)
	)
		return { fits: false, lacking: "platform" };
	// Tiers are ordered S1 < S2 < S3; a stronger tier satisfies a weaker minimum.
	if (
		needs.minSandbox !== SandboxTier.UNSPECIFIED &&
		!observation.sandboxTiers.some((tier) => tier >= needs.minSandbox)
	)
		return { fits: false, lacking: "sandbox" };
	// Only a micro-VM has its own Docker daemon inside (§6.11).
	if (
		needs.docker &&
		!observation.sandboxTiers.includes(SandboxTier.S3_MICROVM)
	)
		return { fits: false, lacking: "docker" };
	const slots = Math.max(0, Math.floor(observation.capacity?.freeSlots ?? 0));
	if (slots === 0) return { fits: false, lacking: "slot" };
	const byMemory = copiesWithin(
		observation.capacity?.freeMemoryMb,
		needs.memoryMb,
	);
	if (byMemory === 0) return { fits: false, lacking: "memory" };
	const byDisk = copiesWithin(observation.capacity?.freeDiskMb, needs.diskMb);
	if (byDisk === 0) return { fits: false, lacking: "disk" };
	return { fits: true, copies: Math.min(slots, byMemory, byDisk) };
}

/**
 * Failing for at least `ms`: today's failover threshold, which holds while
 * `failingForMs < failoverAfterMs` (`decideFleet`, `routeFleetByBudget`).
 */
export function failing(observation: Observation, ms: number): boolean {
	return (
		observation.health !== Health.REACHABLE && observation.failingForMs >= ms
	);
}

/** `QUOTA_EXHAUSTED` → `quota-exhausted`: today's failure-class strings. */
function healthToken(health: Health): string {
	return (Health[health] ?? "UNKNOWN").toLowerCase().replaceAll("_", "-");
}

/** Today's duration format in reasons (`policy.ts` `span`). */
function span(ms: number): string {
	return ms < 120_000
		? `${Math.round(ms / 1000)}s`
		: `${Math.round(ms / 60_000)}m`;
}

/**
 * Whether each observed member could be made active now on health grounds
 * alone, with today's reasons (`decideFleet`, `policy.ts:398-407`): health
 * must be `REACHABLE`; `ready` must not be `false` (absent means ready, as
 * cache backends report neither readiness nor lag); in `failover` mode with a
 * recovery point set, no `lag_ms` is `never-copied` and more lag than the
 * recovery point is refused. Otherwise lag is not considered.
 */
export function eligibility(
	observations: readonly NamedObservation[],
	mode: "failover" | "switch",
	recoveryPointMs: number | undefined,
): readonly EligibleMember[] {
	return observations.map(({ name, observation }) => {
		const reasons: string[] = [];
		if (observation.health !== Health.REACHABLE)
			reasons.push(healthToken(observation.health));
		if (observation.ready === false) reasons.push("not-ready");
		if (mode === "failover" && recoveryPointMs !== undefined) {
			if (observation.lagMs === undefined) reasons.push("never-copied");
			else if (observation.lagMs > recoveryPointMs)
				reasons.push(
					`lag ${span(observation.lagMs)} exceeds rpo ${span(recoveryPointMs)}`,
				);
		}
		return { name, eligible: reasons.length === 0, reasons };
	});
}
