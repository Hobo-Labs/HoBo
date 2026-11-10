/**
 * Coordinator-free claiming for a mesh of relay nodes.
 *
 * Every node that can run a job is a relay: it reads GitHub's queue itself
 * and starts its own runners. Nothing sits between the nodes, so nothing
 * central can fail. What they need is a way not to all start a runner for the
 * same job, without asking each other.
 *
 * They get it from arithmetic. For one job, every node computes the same
 * ordering of the nodes it knows about (weighted rendezvous hashing: a node
 * with twice the free capacity is first for twice as many jobs). The node
 * ranked first starts at once. The node ranked `r` waits `r` steps from the
 * moment GitHub queued the job, and starts only if the job is still queued. A
 * node that is down, full or partitioned costs the job one step; no node
 * waits on another's answer.
 *
 * What a node knows about the others is advice, never authority. A stale or
 * missing advertisement only removes that node from the ordering. A node that
 * knows of no one ranks itself first and starts immediately, which is what a
 * single box does today. Two nodes with different views can both start; GitHub
 * assigns the job to one runner and the other finds nothing and exits. The
 * cost of disagreement is an idle container, not a lost or doubled job.
 *
 * Pure functions: no clock, network or store.
 */
import { createHash } from "node:crypto";

/** One relay node as another node sees it. */
export type MeshNode = Readonly<{
	/** Stable across restarts; the hash input, so renaming a node reshuffles its jobs. */
	id: string;
	/** Free runner slots right now. Zero takes the node out of the ordering. */
	freeSlots: number;
	/** All runner slots the node has, busy or free; for capacity reporting only. */
	totalSlots?: number | undefined;
	/** False while the node is draining or its host is under pressure. */
	healthy: boolean;
	/** Runner labels the node starts runners for. */
	labels: readonly string[];
	/** When this view of the node stops being trusted (epoch ms). */
	validUntilMs: number;
}>;

export type MeshJob = Readonly<{
	/** GitHub's job id: unique across GitHub, so it needs no repository. */
	jobId: number;
	/** The label the job asked for in `runs-on`. */
	label: string;
	/** GitHub's `created_at` for the job (epoch ms): the clock every node shares. */
	queuedAtMs: number;
}>;

const TWO_48 = 2 ** 48;

/** A value strictly inside (0, 1), fixed for a job and a node. */
function unit(jobId: number, nodeId: string): number {
	const hash = createHash("sha256").update(`${jobId}\0${nodeId}`).digest();
	return (hash.readUIntBE(0, 6) + 1) / (TWO_48 + 2);
}

/**
 * The nodes that could take `job`, best first. Every node given the same
 * list computes the same order. Removing a node moves only the jobs it was
 * first for; the rest keep their order.
 */
export function rankNodes(
	job: MeshJob,
	nodes: readonly MeshNode[],
	nowMs: number,
): readonly MeshNode[] {
	const seen = new Set<string>();
	return nodes
		.filter((node) => {
			if (seen.has(node.id)) return false;
			seen.add(node.id);
			return (
				node.healthy &&
				node.freeSlots > 0 &&
				node.validUntilMs > nowMs &&
				node.labels.includes(job.label)
			);
		})
		.map((node) => ({
			node,
			// Weighted rendezvous: the largest -w / ln(u) wins, and a node's
			// share of first places is its share of the total weight.
			score: -node.freeSlots / Math.log(unit(job.jobId, node.id)),
		}))
		.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
		.map((entry) => entry.node);
}

export type ClaimTurn = Readonly<
	| { start: true; rank: number; reason: "first" | "turn-reached" | "alone" }
	| {
			start: false;
			rank: number;
			/** How long until this node's turn, if the job is still queued then. */
			waitMs: number;
			reason: "waiting-turn";
	  }
	| { start: false; rank: -1; waitMs: 0; reason: "not-eligible" }
>;

/**
 * Whether `self` should start a runner for `job` now.
 *
 * `self` is always ranked from its own state, whatever `peers` says about
 * it. `maxRank` bounds the wait: in a large mesh a node far down the order
 * still starts after `maxRank` steps, so a job whose first `maxRank` nodes
 * all failed is never left queued by arithmetic.
 */
export function claimTurn(input: {
	job: MeshJob;
	self: MeshNode;
	peers: readonly MeshNode[];
	nowMs: number;
	/** The wait per rank. Longer means fewer duplicate starts and slower failover. */
	stepMs: number;
	maxRank?: number;
}): ClaimTurn {
	const { job, self, nowMs } = input;
	const own = { ...self, validUntilMs: Number.POSITIVE_INFINITY };
	const order = rankNodes(
		job,
		[own, ...input.peers.filter((peer) => peer.id !== self.id)],
		nowMs,
	);
	const position = order.findIndex((node) => node.id === self.id);
	if (position < 0)
		return { start: false, rank: -1, waitMs: 0, reason: "not-eligible" };
	const rank = Math.min(position, input.maxRank ?? 4);
	if (order.length === 1) return { start: true, rank: 0, reason: "alone" };
	if (rank === 0) return { start: true, rank, reason: "first" };
	// A queue time in the future is a skewed clock, not a head start.
	const queuedAtMs = Math.min(job.queuedAtMs, nowMs);
	const waitMs = queuedAtMs + rank * input.stepMs - nowMs;
	return waitMs <= 0
		? { start: true, rank, reason: "turn-reached" }
		: { start: false, rank, waitMs, reason: "waiting-turn" };
}
