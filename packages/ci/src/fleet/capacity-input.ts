/**
 * Fleet capacity the box publishes for workflow planning (main workspace shards).
 *
 * Workflows read `HOBO_CI_FLEET_CAPACITY` before queuing a shard matrix. The
 * planner caps parallel jobs at admitted parallel slots so a main push cannot
 * open dozens of shard jobs on a three-slot box.
 */

import { z } from "zod";
import { DEFAULT_GITHUB_MACHINE_TYPE } from "../fleet-overflow.js";

/** Repository variable the worker publishes capacity snapshots to. */
// public-contract: main-gate-plan reads parallel admission from this variable.
export const FLEET_CAPACITY_VARIABLE = "HOBO_CI_FLEET_CAPACITY";

export type FleetCapacityMember = Readonly<{
	freeSlots: number;
}>;

export type FleetCapacityPublished = Readonly<{
	version: 1;
	/** Parallel jobs at the standard memory class the fleet can admit now. */
	admittedParallel: number;
	hobo?: FleetCapacityMember;
	arc?: FleetCapacityMember;
	/** Whether the box can admit a 4096 MiB trunk-class job now (reserve 2048, volatility 1024). */
	trunkMemoryAdmit?: boolean;
	publishedAt?: string;
}>;

const MAX_PARALLEL_CAP = 8;

/** Conservative default when the variable is unset or unreadable. */
export const DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP = 4;

/** PublishedAt older than this is treated as no capacity (hold on trunk, no hosted overflow). */
export const FLEET_CAPACITY_MAX_AGE_MS = 5 * 60_000;

const MemberSchema = z
	.object({
		freeSlots: z.number().int().nonnegative(),
	})
	.strict();

const FleetCapacitySchema = z
	.object({
		version: z.literal(1),
		admittedParallel: z.number().int().nonnegative().max(MAX_PARALLEL_CAP),
		hobo: MemberSchema.optional(),
		arc: MemberSchema.optional(),
		trunkMemoryAdmit: z.boolean().optional(),
		publishedAt: z.string().min(1).optional(),
	})
	.strict();

export function fleetCapacitySnapshot(
	hoboFreeSlots: number,
	arcFreeSlots = 0,
	publishedAt?: string,
	trunkMemoryAdmit?: boolean,
): FleetCapacityPublished {
	const hobo = Math.max(0, Math.floor(hoboFreeSlots));
	const arc = Math.max(0, Math.floor(arcFreeSlots));
	const admittedParallel = Math.min(MAX_PARALLEL_CAP, hobo + arc);
	let snapshot: FleetCapacityPublished = {
		version: 1,
		admittedParallel,
		hobo: { freeSlots: hobo },
		arc: { freeSlots: arc },
	};
	if (trunkMemoryAdmit !== undefined) {
		snapshot = { ...snapshot, trunkMemoryAdmit };
	}
	if (publishedAt !== undefined) {
		snapshot = { ...snapshot, publishedAt };
	}
	return snapshot;
}

export type MainWorkspaceShardRunner =
	| "hobo-trunk"
	| typeof DEFAULT_GITHUB_MACHINE_TYPE;

export type MainWorkspaceShardMatrixEntry = Readonly<{
	shard: number;
	runner: MainWorkspaceShardRunner;
}>;

export function isFleetCapacityFresh(
	snapshot: FleetCapacityPublished | undefined,
	nowMs: number,
): boolean {
	if (!snapshot?.publishedAt) return false;
	const publishedMs = Date.parse(snapshot.publishedAt);
	if (!Number.isFinite(publishedMs)) return false;
	return nowMs - publishedMs <= FLEET_CAPACITY_MAX_AGE_MS;
}

/**
 * Per-shard runner labels: ARC/trunk first, GitHub-hosted machine type for overflow
 * (never bare `hobo`). Stale `publishedAt` → all `hobo-trunk` (hold, no overflow).
 */
export function resolveMainWorkspaceShardRunners(
	shardCount: number,
	snapshot: FleetCapacityPublished | undefined,
	nowMs: number,
): MainWorkspaceShardMatrixEntry[] {
	const count = Math.max(0, Math.floor(shardCount));
	const fallbackRunner: MainWorkspaceShardRunner = "hobo-trunk";
	if (count === 0) return [];
	if (!snapshot || !isFleetCapacityFresh(snapshot, nowMs)) {
		return Array.from({ length: count }, (_, shard) => ({
			shard,
			runner: fallbackRunner,
		}));
	}
	const arcFree = snapshot.arc?.freeSlots ?? 0;
	const trunkBlocked = snapshot.trunkMemoryAdmit === false;
	const hosted: MainWorkspaceShardRunner = DEFAULT_GITHUB_MACHINE_TYPE;
	return Array.from({ length: count }, (_, shard) => {
		if (!trunkBlocked) {
			return { shard, runner: fallbackRunner };
		}
		return {
			shard,
			runner: shard < arcFree ? fallbackRunner : hosted,
		};
	});
}

/** @deprecated Use resolveMainWorkspaceShardRunners; kept for single-label fallbacks. */
export function resolveMainWorkspaceShardRunner(
	snapshot: FleetCapacityPublished | undefined,
	fallback: MainWorkspaceShardRunner = "hobo-trunk",
): MainWorkspaceShardRunner {
	const matrix = resolveMainWorkspaceShardRunners(1, snapshot, Date.now());
	return matrix[0]?.runner ?? fallback;
}

export function fleetCapacityVariableValue(
	snapshot: FleetCapacityPublished,
): string {
	return JSON.stringify(snapshot);
}

/**
 * Parse a published capacity snapshot. Returns `undefined` when the payload
 * is missing or invalid.
 */
export function parseFleetCapacityPublished(
	text: string,
): FleetCapacityPublished | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	const result = FleetCapacitySchema.safeParse(parsed);
	if (result.success) {
		const data = result.data;
		const snapshot = fleetCapacitySnapshot(
			data.hobo?.freeSlots ?? 0,
			data.arc?.freeSlots ?? 0,
			data.publishedAt,
			data.trunkMemoryAdmit,
		);
		return { ...snapshot, admittedParallel: data.admittedParallel };
	}
	const loose = z
		.object({
			version: z.literal(1),
			admittedParallel: z.number().int().nonnegative().optional(),
			hobo: MemberSchema.optional(),
			arc: MemberSchema.optional(),
			trunkMemoryAdmit: z.boolean().optional(),
			publishedAt: z.string().min(1).optional(),
		})
		.safeParse(parsed);
	if (!loose.success) return undefined;
	const hobo = loose.data.hobo?.freeSlots ?? 0;
	const arc = loose.data.arc?.freeSlots ?? 0;
	const admitted =
		loose.data.admittedParallel ?? Math.min(MAX_PARALLEL_CAP, hobo + arc);
	if (admitted === 0 && hobo === 0 && arc === 0) return undefined;
	return fleetCapacitySnapshot(
		hobo,
		arc,
		loose.data.publishedAt,
		loose.data.trunkMemoryAdmit,
	);
}

/**
 * How many main workspace shard jobs may run in parallel for this snapshot.
 */
export function mainWorkspaceParallelCap(
	snapshot: FleetCapacityPublished | undefined,
	fallback = DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
): number {
	const raw = snapshot?.admittedParallel ?? fallback;
	if (!Number.isFinite(raw) || raw < 1) return fallback;
	return Math.min(MAX_PARALLEL_CAP, Math.max(1, Math.floor(raw)));
}
