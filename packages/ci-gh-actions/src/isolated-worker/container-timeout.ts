// public-contract: docker label written on every isolated job container at create time.
export const ISOLATED_TIMEOUT_LABEL = "hobo.ci/timeout-ms";

// public-contract: worker writes capped label at create; reconciler enforces it.
export const MAX_ISOLATED_JOB_TIMEOUT_MS = 20 * 60_000;

export const ISOLATED_JIT_FOREIGN_MESH_IDLE_MS = 3 * 60_000;

export const ISOLATED_JIT_UNASSIGNED_IDLE_MS = 10 * 60_000;

export const ISOLATED_JIT_QUEUED_BOUND_GRACE_MS = 3 * 60_000;

// public-contract: lease reconciler stops containers after budget plus this grace.
export const DEFAULT_ISOLATED_TIMEOUT_HARD_GRACE_MS = 5 * 60_000;

export function capIsolatedContainerTimeoutMs(timeoutMs: number): number {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000)
		throw new Error("invalid isolated container timeout");
	return Math.min(timeoutMs, MAX_ISOLATED_JOB_TIMEOUT_MS);
}

export function parseContainerTimeoutMs(
	labels: Readonly<Record<string, string>> | undefined,
): number | undefined {
	const raw = labels?.[ISOLATED_TIMEOUT_LABEL];
	if (raw === undefined) return undefined;
	const timeoutMs = Number(raw);
	if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000) return undefined;
	return timeoutMs;
}

export function parseDockerCreatedAtMs(createdAt: string | undefined): number {
	if (!createdAt) return Number.NaN;
	const parsed = Date.parse(createdAt.replace(/ UTC$/u, " Z"));
	return parsed;
}

export function containerPastHardTimeout(
	createdAtMs: number,
	timeoutMs: number,
	nowMs: number,
	hardGraceMs = DEFAULT_ISOLATED_TIMEOUT_HARD_GRACE_MS,
): boolean {
	if (!Number.isFinite(createdAtMs) || !Number.isInteger(timeoutMs))
		return false;
	return nowMs >= createdAtMs + timeoutMs + hardGraceMs;
}
