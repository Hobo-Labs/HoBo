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
 * that could start twice as many copies of this job is first for twice as many
 * jobs, and a node that has been dropping the jobs it takes is first for
 * fewer). Capacity is judged against the job, not counted in the abstract: a
 * node with a free slot but too little free memory for this job is not a
 * candidate for it, and is still a candidate for a smaller one. The node
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
import { meshReliabilityWeight } from "./reliability.js";
import type { MeshIdentityProof, MeshTrust } from "./trust.js";

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
	/**
	 * What the node has free besides slots. A field that is absent is unknown
	 * and constrains nothing, so a node that does not report it is ranked by
	 * slots alone, as every node was before these fields existed.
	 */
	free?: MeshFree | undefined;
	/** What the node runs on. Absent means it does not say. */
	platform?: MeshPlatform | undefined;
	/**
	 * The share of its recent jobs the node delivered, in (0, 1]; see
	 * `./reliability.ts`. Absent means it does not say, and is full trust.
	 */
	reliability?: number | undefined;
	/**
	 * The decayed counts the score was computed from, so a reader can tell a
	 * score of 1 over no jobs from one over forty.
	 */
	samples?: MeshReliabilitySamples | undefined;
	/**
	 * Since when the node has been in its current health state (epoch ms): the
	 * moment it started, drained or recovered. Absent means it does not say.
	 */
	sinceMs?: number | undefined;
	/**
	 * The node's identity key and its signature over this advertisement; see
	 * `./trust.ts`. Absent on a node that does not sign (an older version).
	 */
	identity?: MeshIdentityProof | undefined;
	/**
	 * What the reader made of the signature. Never sent: each reader computes
	 * it from its own trusted-key set, and a value a node sends about itself
	 * is discarded. Absent means nobody has checked.
	 */
	trust?: MeshTrust | undefined;
	/**
	 * When the board last received this advertisement (epoch ms), by the
	 * board's clock. Set by the board on a read; never sent by the node.
	 */
	seenAtMs?: number | undefined;
	/**
	 * The one repository a machine running jobs for one repository serves
	 * (`owner/name`). Box workers serve many and leave it out.
	 */
	repository?: string | undefined;
}>;

/**
 * The longest an advertisement may ask to be believed. Nodes advertise for
 * 45 seconds and the board forgets an entry after 60; anything asking for
 * more than this is not a node's own advertisement.
 */
export const MESH_MAX_ADVERT_TTL_MS = 5 * 60_000;
/** How far a node's clock may run ahead of a reader's. */
export const MESH_MAX_CLOCK_SKEW_MS = 60_000;

/**
 * Whether a reader must disregard an advertisement whatever it says: its
 * signature failed, or it asks to be believed further ahead than any node
 * advertises (a replay kept alive, or a clock gone wrong). Such a node is
 * never ranked, never counted as capacity, and is reported as `invalid`.
 */
export function meshAdvertRejected(node: MeshNode, nowMs: number): boolean {
	return (
		node.trust === "invalid" ||
		!(
			node.validUntilMs <=
			nowMs + MESH_MAX_ADVERT_TTL_MS + MESH_MAX_CLOCK_SKEW_MS
		)
	);
}

/** What became of the jobs a node took, decayed; see `./reliability.ts`. */
export type MeshReliabilitySamples = Readonly<{
	delivered: number;
	dropped: number;
}>;

/** Whose advertisements a node ranks by. */
export type MeshRankPolicy = Readonly<{
	/**
	 * Rank only nodes whose key is in the trusted set. Off, a node whose
	 * signature is absent or unknown is still ranked, as every node was before
	 * signatures existed. An advertisement whose signature fails is never ranked.
	 */
	requireTrusted?: boolean | undefined;
}>;

/** Free capacity a job can be sized against. */
export type MeshFree = Readonly<{
	/** Memory the node could give to new jobs right now. */
	memoryMb?: number | undefined;
	/** Disk the node could give to new jobs right now. */
	diskMb?: number | undefined;
}>;

export type MeshPlatform = Readonly<{ os: string; arch: string }>;

/** What one job needs from the node that runs it. Absent fields ask nothing. */
export type MeshNeeds = Readonly<{
	memoryMb?: number | undefined;
	diskMb?: number | undefined;
	os?: string | undefined;
	arch?: string | undefined;
}>;

export type MeshJob = Readonly<{
	/** GitHub's job id: unique across GitHub, so it needs no repository. */
	jobId: number;
	/** The label the job asked for in `runs-on`. */
	label: string;
	/** GitHub's `created_at` for the job (epoch ms): the clock every node shares. */
	queuedAtMs: number;
	/** What this job needs; without it the job fits any node with a free slot. */
	needs?: MeshNeeds | undefined;
}>;

/** Why a node cannot take a job, most basic reason first. */
export type MeshLack =
	| "stale"
	| "trust"
	| "unhealthy"
	| "label"
	| "platform"
	| "slots"
	| "memory"
	| "disk";

/**
 * How many copies of `job` the node could start right now, and what bounds
 * that number; or why it could start none.
 */
export type MeshFit = Readonly<
	| { copies: number; limitedBy: "slots" | "memory" | "disk" }
	| { copies: 0; lacking: MeshLack }
>;

function copiesWithin(
	free: number | undefined,
	need: number | undefined,
): number {
	// Unknown on either side constrains nothing.
	if (free === undefined || need === undefined || need <= 0)
		return Number.POSITIVE_INFINITY;
	return Math.floor(Math.max(0, free) / need);
}

/**
 * Fit a job to a node. The checks are ordered so the reason names the first
 * thing that would have to change: a node that is the wrong platform is not
 * reported as short of memory.
 */
export function fitJob(
	job: MeshJob,
	node: MeshNode,
	nowMs: number,
	policy: MeshRankPolicy = {},
): MeshFit {
	if (node.validUntilMs <= nowMs) return { copies: 0, lacking: "stale" };
	// A forged, altered or overlong advertisement says nothing about any node,
	// so it is never deferred to; an unknown key is, unless the mesh requires
	// trust.
	if (
		meshAdvertRejected(node, nowMs) ||
		(policy.requireTrusted === true && node.trust !== "trusted")
	)
		return { copies: 0, lacking: "trust" };
	if (!node.healthy) return { copies: 0, lacking: "unhealthy" };
	if (!node.labels.includes(job.label)) return { copies: 0, lacking: "label" };
	const needs = job.needs;
	const platform = node.platform;
	if (
		platform &&
		((needs?.os !== undefined && needs.os !== platform.os) ||
			(needs?.arch !== undefined && needs.arch !== platform.arch))
	)
		return { copies: 0, lacking: "platform" };
	const slots = Math.max(0, Math.floor(node.freeSlots));
	if (slots === 0) return { copies: 0, lacking: "slots" };
	const byMemory = copiesWithin(node.free?.memoryMb, needs?.memoryMb);
	if (byMemory === 0) return { copies: 0, lacking: "memory" };
	const byDisk = copiesWithin(node.free?.diskMb, needs?.diskMb);
	if (byDisk === 0) return { copies: 0, lacking: "disk" };
	const copies = Math.min(slots, byMemory, byDisk);
	return {
		copies,
		limitedBy:
			copies === slots ? "slots" : copies === byMemory ? "memory" : "disk",
	};
}

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
	policy: MeshRankPolicy = {},
): readonly MeshNode[] {
	const seen = new Set<string>();
	return nodes
		.filter((node) => {
			if (seen.has(node.id)) return false;
			seen.add(node.id);
			return true;
		})
		.map((node) => ({ node, copies: fitJob(job, node, nowMs, policy).copies }))
		.filter((entry) => entry.copies > 0)
		.map(({ node, copies }) => ({
			node,
			// Weighted rendezvous: the largest -w / ln(u) wins, and a node's
			// share of first places is its share of the total weight. The weight
			// is how many copies of this job the node could start, so a node
			// with eight slots and memory for one of these counts as one; and
			// that is scaled by the share of its recent jobs it delivered, so a
			// node that drops half of what it takes is first for half as many.
			score:
				-(copies * meshReliabilityWeight(node.reliability)) /
				Math.log(unit(job.jobId, node.id)),
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
	| {
			start: false;
			rank: -1;
			waitMs: 0;
			reason: "not-eligible";
			/** What this node lacks for this job. */
			lacking: MeshLack;
	  }
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
	/** Rank only peers whose key this node trusts; see `MeshRankPolicy`. */
	requireTrusted?: boolean | undefined;
}): ClaimTurn {
	const { job, self, nowMs } = input;
	const policy: MeshRankPolicy = { requireTrusted: input.requireTrusted };
	// A node needs nobody's signature to believe its own state, and its own
	// state is current now, whatever expiry it advertises.
	const own: MeshNode = {
		...self,
		validUntilMs: nowMs + 1,
		trust: "trusted",
	};
	const order = rankNodes(
		job,
		[own, ...input.peers.filter((peer) => peer.id !== self.id)],
		nowMs,
		policy,
	);
	const position = order.findIndex((node) => node.id === self.id);
	if (position < 0) {
		const fit = fitJob(job, own, nowMs, policy);
		return {
			start: false,
			rank: -1,
			waitMs: 0,
			reason: "not-eligible",
			// `own` is current and trusted, so a node absent from its own order
			// always lacks something nameable.
			lacking: "lacking" in fit ? fit.lacking : "slots",
		};
	}
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
