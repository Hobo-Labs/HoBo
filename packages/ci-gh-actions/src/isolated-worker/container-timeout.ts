// public-contract: docker label written on every isolated job container at create time.
export const ISOLATED_TIMEOUT_LABEL = "hobo.ci/timeout-ms";

/** Tyler per-job rule: isolated containers cannot advertise more than 20 minutes. */
// public-contract: worker writes capped label at create; reconciler enforces it.
export const MAX_ISOLATED_JOB_TIMEOUT_MS = 20 * 60_000;

/** Release headroom when the fleet mesh already holds the reserved job. */
export const ISOLATED_JIT_FOREIGN_MESH_IDLE_MS = 3 * 60_000;

/** Stop a listener that never received a job assignment from GitHub. */
export const ISOLATED_JIT_UNASSIGNED_IDLE_MS = 10 * 60_000;

/** Bound reserved job still queued while the runner never left `queued`. */
export const ISOLATED_JIT_QUEUED_BOUND_GRACE_MS = 3 * 60_000;

/** Hard grace after the job budget so idle runners cannot hold memory forever. */
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
