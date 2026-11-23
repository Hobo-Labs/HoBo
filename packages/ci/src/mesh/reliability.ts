export type MeshOutcome = "delivered" | "dropped";

export type MeshReliability = Readonly<{
	delivered: number;
	dropped: number;
	atMs: number;
}>;

export type MeshReliabilityOptions = Readonly<{
	halfLifeMs: number;
	priorWeight: number;
}>;

export const MESH_RELIABILITY_DEFAULTS: MeshReliabilityOptions = {
	halfLifeMs: 30 * 60_000,
	priorWeight: 4,
};

export const MESH_MIN_RELIABILITY = 0.05;

export function newMeshReliability(nowMs: number): MeshReliability {
	return { delivered: 0, dropped: 0, atMs: nowMs };
}

export function decayMeshReliability(
	state: MeshReliability,
	nowMs: number,
	options: MeshReliabilityOptions = MESH_RELIABILITY_DEFAULTS,
): MeshReliability {
	const elapsedMs = nowMs - state.atMs;
	if (!(elapsedMs > 0) || !(options.halfLifeMs > 0)) return state;
	const keep = 0.5 ** (elapsedMs / options.halfLifeMs);
	return {
		delivered: state.delivered * keep,
		dropped: state.dropped * keep,
		atMs: nowMs,
	};
}

export function recordMeshOutcome(
	state: MeshReliability,
	outcome: MeshOutcome,
	nowMs: number,
	options: MeshReliabilityOptions = MESH_RELIABILITY_DEFAULTS,
): MeshReliability {
	const current = decayMeshReliability(state, nowMs, options);
	return outcome === "delivered"
		? { ...current, delivered: current.delivered + 1 }
		: { ...current, dropped: current.dropped + 1 };
}

export function retractMeshDelivery(
	state: MeshReliability,
	deliveredAtMs: number,
	nowMs: number,
	options: MeshReliabilityOptions = MESH_RELIABILITY_DEFAULTS,
): MeshReliability {
	const current = decayMeshReliability(state, nowMs, options);
	const elapsedMs = Math.max(0, nowMs - deliveredAtMs);
	const remaining =
		options.halfLifeMs > 0 ? 0.5 ** (elapsedMs / options.halfLifeMs) : 0;
	return {
		...current,
		delivered: Math.max(0, current.delivered - remaining),
		dropped: current.dropped + 1,
	};
}

export function meshReliabilityScore(
	state: MeshReliability,
	nowMs: number,
	options: MeshReliabilityOptions = MESH_RELIABILITY_DEFAULTS,
): number {
	const current = decayMeshReliability(state, nowMs, options);
	const prior = Math.max(0, options.priorWeight);
	const total = current.delivered + current.dropped + prior;
	if (!(total > 0)) return 1;
	return (current.delivered + prior) / total;
}

export function meshReliabilityWeight(score: number | undefined): number {
	if (score === undefined || !Number.isFinite(score)) return 1;
	return Math.min(1, Math.max(MESH_MIN_RELIABILITY, score));
}
