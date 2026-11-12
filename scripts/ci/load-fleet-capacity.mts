/**
 * Reads `HOBO_CI_FLEET_CAPACITY` for main-gate-plan (no workspace install).
 * Node builtins only — must not import packages or other deps.
 */

import {
	isNonNegativeInt,
	isObject,
	isString,
	type Json,
	parseUnknownJson,
} from "../lib/pins-json.ts";

const tagOf = Object.prototype.toString;

function isJsonBoolean(value: Json | undefined): value is boolean {
	return tagOf.call(value) === "[object Boolean]";
}

/** Repository variable the worker publishes capacity snapshots to. */
export const FLEET_CAPACITY_VARIABLE = "HOBO_CI_FLEET_CAPACITY";

const MAX_PARALLEL_CAP = 8;

/** GitHub-hosted machine type for plan-time overflow (not bare `hobo`). */
const GITHUB_HOSTED_MACHINE_TYPE = "ubuntu-24.04";

export const FLEET_CAPACITY_MAX_AGE_MS = 5 * 60_000;

/** Conservative default when the variable is unset or unreadable. */
export const DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP = 4;

export type FleetCapacityMember = Readonly<{
	freeSlots: number;
}>;

export type FleetCapacityPublished = Readonly<{
	version: 1;
	admittedParallel: number;
	hobo?: FleetCapacityMember;
	arc?: FleetCapacityMember;
	trunkMemoryAdmit?: boolean;
	publishedAt?: string;
}>;

export type MainWorkspaceShardRunner =
	| "hobo-trunk"
	| typeof GITHUB_HOSTED_MACHINE_TYPE;

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
	const ageMs = nowMs - publishedMs;
	if (ageMs < 0) return false;
	return ageMs <= FLEET_CAPACITY_MAX_AGE_MS;
}

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
	return Array.from({ length: count }, (_, shard) => {
		if (!trunkBlocked) {
			return { shard, runner: fallbackRunner };
		}
		// SAFETY: overflow runner is the closed GitHub-hosted machine type constant.
		const hostedRunner = GITHUB_HOSTED_MACHINE_TYPE as MainWorkspaceShardRunner;
		return {
			shard,
			runner: shard < arcFree ? fallbackRunner : hostedRunner,
		};
	});
}

export type LoadFleetCapacityOptions = Readonly<{
	repository?: string;
	token?: string;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	variable?: string;
}>;

function parseMember(value: Json | undefined): FleetCapacityMember | undefined {
	if (!isObject(value)) return undefined;
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== "freeSlots") return undefined;
	const freeSlots = value.freeSlots;
	if (!isNonNegativeInt(freeSlots)) return undefined;
	return { freeSlots };
}

function fleetCapacitySnapshot(
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

/**
 * Parse a published capacity snapshot. Returns `undefined` when the payload
 * is missing or invalid.
 */
export function parseFleetCapacityPublished(
	text: string,
): FleetCapacityPublished | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	let parsed: Json | undefined;
	try {
		parsed = parseUnknownJson(JSON.parse(trimmed));
	} catch {
		return undefined;
	}
	if (!isObject(parsed)) return undefined;
	if (parsed.version !== 1) return undefined;

	const admittedRaw = parsed.admittedParallel;
	const hobo = parseMember(parsed.hobo);
	const arc = parseMember(parsed.arc);
	if (parsed.hobo !== undefined && hobo === undefined) return undefined;
	if (parsed.arc !== undefined && arc === undefined) return undefined;
	const publishedAt = parsed.publishedAt;
	if (publishedAt !== undefined && !isString(publishedAt)) {
		return undefined;
	}
	const trunkMemoryAdmit = parsed.trunkMemoryAdmit;
	if (trunkMemoryAdmit !== undefined && !isJsonBoolean(trunkMemoryAdmit)) {
		return undefined;
	}
	const extraKeys = Object.keys(parsed).filter(
		(key) =>
			key !== "version" &&
			key !== "admittedParallel" &&
			key !== "hobo" &&
			key !== "arc" &&
			key !== "trunkMemoryAdmit" &&
			key !== "publishedAt",
	);
	if (extraKeys.length > 0) return undefined;

	if (admittedRaw !== undefined) {
		if (!isNonNegativeInt(admittedRaw) || admittedRaw > MAX_PARALLEL_CAP)
			return undefined;
		const snapshot = fleetCapacitySnapshot(
			hobo?.freeSlots ?? 0,
			arc?.freeSlots ?? 0,
			publishedAt,
			trunkMemoryAdmit,
		);
		return { ...snapshot, admittedParallel: admittedRaw };
	}

	const hoboSlots = hobo?.freeSlots ?? 0;
	const arcSlots = arc?.freeSlots ?? 0;
	const admitted = Math.min(MAX_PARALLEL_CAP, hoboSlots + arcSlots);
	if (admitted === 0 && hoboSlots === 0 && arcSlots === 0) return undefined;
	return fleetCapacitySnapshot(
		hoboSlots,
		arcSlots,
		publishedAt,
		trunkMemoryAdmit,
	);
}

export function resolveMainWorkspaceShardRunner(
	snapshot: FleetCapacityPublished | undefined,
	fallback: MainWorkspaceShardRunner = "hobo-trunk",
): MainWorkspaceShardRunner {
	const matrix = resolveMainWorkspaceShardRunners(1, snapshot, Date.now());
	return matrix[0]?.runner ?? fallback;
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

function readGithubVariableValue(body: Json | undefined): string | undefined {
	if (!isObject(body)) return undefined;
	const value = body.value;
	if (!isString(value) || value.length === 0) return undefined;
	return value;
}

export async function fetchFleetCapacityVariable(
	options: LoadFleetCapacityOptions,
): Promise<FleetCapacityPublished | undefined> {
	const inline = process.env.HOBO_CI_FLEET_CAPACITY_JSON?.trim();
	if (inline) return parseFleetCapacityPublished(inline);
	const repository = options.repository?.trim();
	const token = options.token?.trim();
	if (!repository || !token) return undefined;
	const variable = options.variable ?? FLEET_CAPACITY_VARIABLE;
	const [owner, repo] = repository.split("/");
	if (!owner || !repo) return undefined;
	const url = `https://api.github.com/repos/${owner}/${repo}/actions/variables/${variable}`;
	const fetchFn = options.fetch ?? globalThis.fetch;
	const response = await fetchFn(url, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (response.status === 404) return undefined;
	if (!response.ok) {
		console.error(
			`load-fleet-capacity: variables/${variable} returned ${response.status}`,
		);
		return undefined;
	}
	const body = parseUnknownJson(await response.json());
	const value = readGithubVariableValue(body);
	if (value === undefined) return undefined;
	return parseFleetCapacityPublished(value);
}

export async function resolveMainWorkspaceParallelCap(
	options: LoadFleetCapacityOptions = {},
): Promise<number> {
	const override = Number(process.env.MAIN_WORKSPACE_PARALLEL_CAP ?? "");
	if (
		Number.isInteger(override) &&
		override >= 1 &&
		override <= 8 &&
		process.env.MAIN_WORKSPACE_PARALLEL_CAP !== undefined
	)
		return override;
	const published = await fetchFleetCapacityVariable(options);
	const nowMs = Date.now();
	if (!published || !isFleetCapacityFresh(published, nowMs)) {
		return DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP;
	}
	return mainWorkspaceParallelCap(
		published,
		DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
	);
}

/** Contiguous shard indexes `[0, …, n-1]` from plan output; `-1` when malformed. */
export function mainGateShardCountFromIndexesJson(raw: string): number {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return -1;
	if (trimmed === "[]") return 0;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!Array.isArray(parsed)) return -1;
		for (let index = 0; index < parsed.length; index += 1) {
			const value = parsed[index];
			if (value !== index) return -1;
		}
		return parsed.length;
	} catch {
		return -1;
	}
}
