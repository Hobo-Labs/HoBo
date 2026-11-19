import {
	claimTurn,
	type MeshJob,
	type MeshLack,
	type MeshNode,
} from "./rendezvous.js";

export interface MeshBoard {
	advertise(node: MeshNode): Promise<void>;
	nodes(): Promise<readonly MeshNode[]>;
}

export interface MeshClaims {
	tryClaim(jobId: number, nodeId: string): Promise<"claimed" | "held">;
}

export type MeshPorts = Readonly<{ board: MeshBoard; claims: MeshClaims }>;

export interface MeshConfigStore {
	read(): Promise<{ value: string; revision: number } | undefined>;
	publish(
		value: string,
		expectedRevision?: number,
	): Promise<{ revision: number } | "conflict">;
}

export function createMemoryMeshConfig(): MeshConfigStore {
	let current: { value: string; revision: number } | undefined;
	return {
		async read() {
			return current;
		},
		async publish(value, expectedRevision) {
			if ((current?.revision ?? undefined) !== expectedRevision)
				return current?.value === value
					? { revision: current.revision }
					: "conflict";
			current = { value, revision: (current?.revision ?? 0) + 1 };
			return { revision: current.revision };
		},
	};
}

export type MeshDecision = Readonly<
	| {
			start: true;
			reason:
				| "claimed"
				| "claims-unreachable";
			rank: number;
	  }
	| {
			start: false;
			reason: "waiting-turn" | "claimed-elsewhere";
			rank: number;
			waitMs: number;
	  }
	| {
			start: false;
			reason: "not-eligible";
			rank: number;
			waitMs: number;
			lacking: MeshLack;
	  }
>;

export type MeshEvent =
	| "hobo_ci_mesh_board_unreachable"
	| "hobo_ci_mesh_board_recovered"
	| "hobo_ci_mesh_claims_unreachable"
	| "hobo_ci_mesh_claims_recovered";

export function createMeshCoordinator(options: {
	self: () => MeshNode;
	board: MeshBoard;
	claims: MeshClaims;
	stepMs?: number;
	maxRank?: number;
	viewMaxAgeMs?: number;
	claimsRetryMs?: number;
	requireTrusted?: (() => boolean) | undefined;
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
	let claimsRetryAt = Number.NEGATIVE_INFINITY;
	const claimsRetryMs = options.claimsRetryMs ?? 10_000;
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
			viewAt = now();
			reportBoard(true, error instanceof Error ? error.message : "unknown");
		}
		return view;
	}

	return {
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
				requireTrusted: options.requireTrusted?.() ?? false,
			});
			if (!turn.start)
				return turn.reason === "not-eligible"
					? {
							start: false,
							reason: turn.reason,
							rank: turn.rank,
							waitMs: turn.waitMs,
							lacking: turn.lacking,
						}
					: {
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

export function createMemoryMesh(options?: {
	now?: () => number;
	claimTtlMs?: number;
}): MeshPorts {
	const now = options?.now ?? Date.now;
	const claimTtlMs = options?.claimTtlMs ?? 120_000;
	const adverts = new Map<string, MeshNode>();
	const claimed = new Map<number, { nodeId: string; until: number }>();
	return {
		board: {
			async advertise(node) {
				const { trust: _trust, seenAtMs: _seenAtMs, ...sent } = node;
				adverts.set(node.id, sent);
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
