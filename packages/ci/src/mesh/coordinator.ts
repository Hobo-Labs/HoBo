/**
 * A node's side of the relay mesh: tell the others what this node can take,
 * and decide whether to start a runner for a queued job.
 *
 * Two ports carry what the mesh shares. The board holds advertisements; the
 * claims hold "this node has that job". Both are optional help. With them a
 * job is started by exactly one node. Without them (the store is down, the
 * network is split, nothing is configured) each node falls back to the
 * ranking in `rendezvous.ts` over the last view it had, which still starts
 * every job and at worst starts a runner twice.
 */
import { claimTurn, type MeshJob, type MeshNode } from "./rendezvous.js";

/** Where nodes leave advertisements for each other. */
export interface MeshBoard {
	advertise(node: MeshNode): Promise<void>;
	/** Every advertisement the board holds, expired or not. */
	nodes(): Promise<readonly MeshNode[]>;
}

/** Who has taken which job. An entry outlives its claimant by the store's TTL. */
export interface MeshClaims {
	/**
	 * `claimed` when `nodeId` now holds the job, or already did. `held` when
	 * another node does. Rejects when the store cannot be reached.
	 */
	tryClaim(jobId: number, nodeId: string): Promise<"claimed" | "held">;
}

/** The two things a mesh shares, however they are stored. */
export type MeshPorts = Readonly<{ board: MeshBoard; claims: MeshClaims }>;

export type MeshDecision = Readonly<
	| {
			start: true;
			reason:
				| "claimed"
				/** The claim store did not answer; this node's turn came by ranking alone. */
				| "claims-unreachable";
			rank: number;
	  }
	| {
			start: false;
			reason: "waiting-turn" | "claimed-elsewhere" | "not-eligible";
			rank: number;
			waitMs: number;
	  }
>;

export type MeshEvent =
	| "hobo_ci_mesh_board_unreachable"
	| "hobo_ci_mesh_board_recovered"
	| "hobo_ci_mesh_claims_unreachable"
	| "hobo_ci_mesh_claims_recovered";

export function createMeshCoordinator(options: {
	/** This node as it is right now: free slots and health change between calls. */
	self: () => MeshNode;
	board: MeshBoard;
	claims: MeshClaims;
	/** The wait per rank; see `claimTurn`. */
	stepMs?: number;
	maxRank?: number;
	/** How long a view of the board is reused before it is read again. */
	viewMaxAgeMs?: number;
	/** How long the claim store is left alone after it fails. */
	claimsRetryMs?: number;
	now?: () => number;
	log?: (
		event: MeshEvent,
		fields: Readonly<Record<string, string | number | boolean>>,
	) => void;
}) {
	const now = options.now ?? Date.now;
	const stepMs = options.stepMs ?? 20_000;
	const viewMaxAgeMs = options.viewMaxAgeMs ?? 5_000;
	let view: readonly MeshNode[] = [];
	let viewAt = Number.NEGATIVE_INFINITY;
	let boardDown = false;
	let claimsDown = false;
	// A store that just failed is not asked again for a while: one timeout,
	// not one per queued job.
	let claimsRetryAt = Number.NEGATIVE_INFINITY;
	const claimsRetryMs = options.claimsRetryMs ?? 10_000;
	// Jobs this node already holds: a second poll must not ask again.
	const held = new Map<number, number>();

	function reportBoard(down: boolean, message: string): void {
		if (down === boardDown) return;
		boardDown = down;
		options.log?.(
			down ? "hobo_ci_mesh_board_unreachable" : "hobo_ci_mesh_board_recovered",
			{ message },
		);
	}

	function reportClaims(down: boolean, message: string): void {
		if (down === claimsDown) return;
		claimsDown = down;
		options.log?.(
			down
				? "hobo_ci_mesh_claims_unreachable"
				: "hobo_ci_mesh_claims_recovered",
			{ message },
		);
	}

	async function peers(): Promise<readonly MeshNode[]> {
		if (now() - viewAt < viewMaxAgeMs) return view;
		try {
			view = await options.board.nodes();
			viewAt = now();
			reportBoard(false, "");
		} catch (error) {
			// Keep the last view: its entries expire on their own, and when they
			// have this node ranks alone.
			viewAt = now();
			reportBoard(true, error instanceof Error ? error.message : "unknown");
		}
		return view;
	}

	return {
		/** Publish this node's current state. Failing to is not an error: others just rank without it. */
		async advertise(): Promise<boolean> {
			try {
				await options.board.advertise(options.self());
				reportBoard(false, "");
				return true;
			} catch (error) {
				reportBoard(true, error instanceof Error ? error.message : "unknown");
				return false;
			}
		},

		/** Whether this node should start a runner for `job` now. */
		async shouldStart(job: MeshJob): Promise<MeshDecision> {
			const nowMs = now();
			for (const [jobId, until] of held) if (until <= nowMs) held.delete(jobId);
			if (held.has(job.jobId))
				return { start: true, reason: "claimed", rank: 0 };
			const self = options.self();
			const turn = claimTurn({
				job,
				self,
				peers: await peers(),
				nowMs,
				stepMs,
				maxRank: options.maxRank ?? 4,
			});
			if (!turn.start)
				return {
					start: false,
					reason: turn.reason,
					rank: turn.rank,
					waitMs: turn.waitMs,
				};
			if (nowMs < claimsRetryAt)
				return { start: true, reason: "claims-unreachable", rank: turn.rank };
			try {
				const outcome = await options.claims.tryClaim(job.jobId, self.id);
				reportClaims(false, "");
				if (outcome === "held")
					return {
						start: false,
						reason: "claimed-elsewhere",
						rank: turn.rank,
						waitMs: 0,
					};
				// Long enough to cover a slow launch; the store's own TTL is what
				// frees the job for another node if this one dies.
				held.set(job.jobId, nowMs + 10 * 60_000);
				return { start: true, reason: "claimed", rank: turn.rank };
			} catch (error) {
				claimsRetryAt = nowMs + claimsRetryMs;
				reportClaims(true, error instanceof Error ? error.message : "unknown");
				return { start: true, reason: "claims-unreachable", rank: turn.rank };
			}
		},
	};
}

export type MeshCoordinator = ReturnType<typeof createMeshCoordinator>;

/**
 * A board and claims held in this process. One node on its own needs nothing
 * else, and several coordinators sharing one instance behave as a mesh, which
 * is what tests and the local demo use.
 */
export function createMemoryMesh(options?: {
	now?: () => number;
	/** How long a claim blocks other nodes. */
	claimTtlMs?: number;
}): MeshPorts {
	const now = options?.now ?? Date.now;
	const claimTtlMs = options?.claimTtlMs ?? 120_000;
	const adverts = new Map<string, MeshNode>();
	const claimed = new Map<number, { nodeId: string; until: number }>();
	return {
		board: {
			async advertise(node) {
				adverts.set(node.id, node);
			},
			async nodes() {
				return [...adverts.values()];
			},
		},
		claims: {
			async tryClaim(jobId, nodeId) {
				const existing = claimed.get(jobId);
				if (existing && existing.until > now() && existing.nodeId !== nodeId)
					return "held";
				if (!existing || existing.until <= now())
					claimed.set(jobId, { nodeId, until: now() + claimTtlMs });
				return "claimed";
			},
		},
	};
}
