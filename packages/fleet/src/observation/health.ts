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

function copiesWithin(
	free: number | undefined,
	need: number | undefined,
): number {
	if (free === undefined || need === undefined || need <= 0)
		return Number.POSITIVE_INFINITY;
	return Math.floor(Math.max(0, free) / need);
}

function differs(wanted: string | undefined, has: string | undefined): boolean {
	return (
		wanted !== undefined &&
		wanted !== "" &&
		has !== undefined &&
		has !== "" &&
		wanted !== has
	);
}

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
	if (
		needs.minSandbox !== SandboxTier.UNSPECIFIED &&
		!observation.sandboxTiers.some((tier) => tier >= needs.minSandbox)
	)
		return { fits: false, lacking: "sandbox" };
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

export function failing(observation: Observation, ms: number): boolean {
	return (
		observation.health !== Health.REACHABLE && observation.failingForMs >= ms
	);
}

function healthToken(health: Health): string {
	return (Health[health] ?? "UNKNOWN").toLowerCase().replaceAll("_", "-");
}

function span(ms: number): string {
	return ms < 120_000
		? `${Math.round(ms / 1000)}s`
		: `${Math.round(ms / 60_000)}m`;
}

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
