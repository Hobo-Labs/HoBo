/**
 * How far a mesh node can be trusted with a job, from what happened to the
 * jobs it took.
 *
 * A node that takes a job and loses it (the runner never starts, the
 * container is killed for memory, the runner disappears mid-job) has dropped
 * it. A node that gets a runner to the job and keeps it until the job ends
 * has delivered it, whatever the job's own result was: a failing test is the
 * job's business, not the node's.
 *
 * The score is the share of recent jobs delivered. "Recent" is an exponential
 * decay: every half-life, what a past job counts for is halved. That is what
 * lets a score recover. A disk that filled an hour ago dropped real jobs, and
 * for a while the node deserves less work; once the disk is fixed those drops
 * fade on their own, and every job delivered since pulls the score up faster.
 * Nothing has to be reset by hand, and nothing is held against a node forever.
 *
 * A node with no history is trusted: the score starts at 1 and a few
 * imaginary deliveries (`priorWeight`) stand behind it, so one early drop
 * does not halve a new node's share.
 *
 * Pure functions: no clock, network or store.
 */

export type MeshOutcome = "delivered" | "dropped";

/** Decayed counts of what happened to the jobs a node took. */
export type MeshReliability = Readonly<{
	delivered: number;
	dropped: number;
	/** When the counts were last brought up to date (epoch ms). */
	atMs: number;
}>;

export type MeshReliabilityOptions = Readonly<{
	/** How long until a past job counts for half as much. */
	halfLifeMs: number;
	/** Imaginary deliveries standing behind a node with no history. */
	priorWeight: number;
}>;

export const MESH_RELIABILITY_DEFAULTS: MeshReliabilityOptions = {
	halfLifeMs: 30 * 60_000,
	priorWeight: 4,
};

/**
 * The smallest share of its capacity a node is ranked with, however poor its
 * record. A node that got no work at all could never deliver a job, so its
 * score could only recover by waiting; a small share keeps real evidence
 * coming in.
 */
export const MESH_MIN_RELIABILITY = 0.05;

export function newMeshReliability(nowMs: number): MeshReliability {
	return { delivered: 0, dropped: 0, atMs: nowMs };
}

/** The same record as of `nowMs`: both counts faded by the time that passed. */
export function decayMeshReliability(
	state: MeshReliability,
	nowMs: number,
	options: MeshReliabilityOptions = MESH_RELIABILITY_DEFAULTS,
): MeshReliability {
	const elapsedMs = nowMs - state.atMs;
	// A clock that stepped backwards changes nothing.
	if (!(elapsedMs > 0) || !(options.halfLifeMs > 0)) return state;
	const keep = 0.5 ** (elapsedMs / options.halfLifeMs);
	return {
		delivered: state.delivered * keep,
		dropped: state.dropped * keep,
		atMs: nowMs,
	};
}

/** The record after one more job ended one way or the other. */
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

/**
 * The record after a job that was counted as delivered at `deliveredAtMs`
 * turned out to be dropped: what is left of that delivery is taken back and a
 * drop is counted now. A node is credited when its runner picks a job up, and
 * a runner can still be lost after that.
 */
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

/**
 * The share of recent jobs delivered, in (0, 1]. 1 for a node with no
 * history or no recent drops.
 */
export function meshReliabilityScore(
	state: MeshReliability,
	nowMs: number,
	options: MeshReliabilityOptions = MESH_RELIABILITY_DEFAULTS,
): number {
	const current = decayMeshReliability(state, nowMs, options);
	const prior = Math.max(0, options.priorWeight);
	const total = current.delivered + current.dropped + prior;
	// No history and no prior: nothing is known, so nothing is held against it.
	if (!(total > 0)) return 1;
	return (current.delivered + prior) / total;
}

/**
 * The factor a node's capacity is multiplied by when it is ranked. An absent
 * or unusable score is full trust, as every node had before scores existed.
 */
export function meshReliabilityWeight(score: number | undefined): number {
	if (score === undefined || !Number.isFinite(score)) return 1;
	return Math.min(1, Math.max(MESH_MIN_RELIABILITY, score));
}
