/**
 * Watching the mesh: who is in it, who can take work, and how much room
 * is left.
 *
 * Ranking only needs the board at the moment a job is queued. Operating a
 * mesh needs the changes: a node that joined, one that stopped advertising,
 * one that turned unhealthy, and the moment no node has a free slot. This
 * turns successive readings of the board into those facts.
 *
 * Every node can run it. To keep one fact from being reported once per node,
 * only the live node with the lowest id reports changes about others; if it
 * dies, the next one takes over on its following reading.
 */
import type { MeshBoard } from "./coordinator.js";
import type { MeshNode } from "./rendezvous.js";

export type MeshCapacity = Readonly<{
	/** Nodes with an advertisement that has not expired. */
	nodes: number;
	/** Of those, the ones that are healthy. */
	healthy: number;
	/** Healthy nodes with at least one free slot. */
	available: number;
	/** Runner slots across healthy nodes, when they advertise a total. */
	totalSlots: number;
	/** Free runner slots across healthy nodes. */
	freeSlots: number;
}>;

/** What the board says the mesh can do right now. */
export function meshCapacity(
	nodes: readonly MeshNode[],
	nowMs: number,
): MeshCapacity {
	const live = nodes.filter((node) => node.validUntilMs > nowMs);
	const healthy = live.filter((node) => node.healthy);
	return {
		nodes: live.length,
		healthy: healthy.length,
		available: healthy.filter((node) => node.freeSlots > 0).length,
		totalSlots: healthy.reduce(
			(sum, node) => sum + (node.totalSlots ?? node.freeSlots),
			0,
		),
		freeSlots: healthy.reduce((sum, node) => sum + node.freeSlots, 0),
	};
}

export type MeshMonitorEvent =
	| "hobo_ci_mesh_node_joined"
	| "hobo_ci_mesh_node_lost"
	| "hobo_ci_mesh_node_unhealthy"
	| "hobo_ci_mesh_node_recovered"
	| "hobo_ci_mesh_capacity_exhausted"
	| "hobo_ci_mesh_capacity_restored"
	| "hobo_ci_mesh_capacity";

export function createMeshMonitor(options: {
	/** This node's id: decides whether it is the one that reports. */
	selfId: string;
	board: MeshBoard;
	now?: () => number;
	/** How often the capacity summary is logged when nothing changed. */
	summaryEveryMs?: number;
	log: (
		event: MeshMonitorEvent,
		fields: Readonly<Record<string, string | number | boolean>>,
	) => void;
}) {
	const now = options.now ?? Date.now;
	const summaryEveryMs = options.summaryEveryMs ?? 60_000;
	let previous: ReadonlyMap<string, MeshNode> | undefined;
	let exhausted = false;
	let summarizedAt = Number.NEGATIVE_INFINITY;

	return {
		/**
		 * Reads the board and reports what changed since the last reading.
		 * Returns the capacity it saw, or `undefined` when the board could not
		 * be read (the coordinator reports that).
		 */
		async observe(): Promise<MeshCapacity | undefined> {
			let nodes: readonly MeshNode[];
			try {
				nodes = await options.board.nodes();
			} catch {
				return undefined;
			}
			const nowMs = now();
			const live = new Map(
				nodes
					.filter((node) => node.validUntilMs > nowMs)
					.map((node) => [node.id, node]),
			);
			const capacity = meshCapacity(nodes, nowMs);
			// One reporter: the lowest live id. A node always reports for itself
			// being alone, since then it is the lowest.
			const reporter = [...live.keys()].sort()[0] ?? options.selfId;
			const reports = reporter === options.selfId;
			let changed = previous === undefined;
			if (previous && reports) {
				for (const [id, node] of live) {
					const before = previous.get(id);
					if (!before) {
						changed = true;
						options.log("hobo_ci_mesh_node_joined", {
							nodeId: id,
							freeSlots: node.freeSlots,
							totalSlots: node.totalSlots ?? node.freeSlots,
							healthy: node.healthy,
						});
					} else if (before.healthy !== node.healthy) {
						changed = true;
						options.log(
							node.healthy
								? "hobo_ci_mesh_node_recovered"
								: "hobo_ci_mesh_node_unhealthy",
							{ nodeId: id },
						);
					}
				}
				for (const id of previous.keys())
					if (!live.has(id)) {
						changed = true;
						options.log("hobo_ci_mesh_node_lost", { nodeId: id });
					}
			}
			if (reports) {
				// "Exhausted" is the mesh having nodes and none with room: a job
				// queued now waits for a slot, not for a turn.
				const full = capacity.nodes > 0 && capacity.available === 0;
				if (full !== exhausted) {
					exhausted = full;
					changed = true;
					options.log(
						full
							? "hobo_ci_mesh_capacity_exhausted"
							: "hobo_ci_mesh_capacity_restored",
						{ ...capacity },
					);
				}
				if (changed || nowMs - summarizedAt >= summaryEveryMs) {
					summarizedAt = nowMs;
					options.log("hobo_ci_mesh_capacity", { ...capacity });
				}
			}
			previous = live;
			return capacity;
		},
	};
}

export type MeshMonitor = ReturnType<typeof createMeshMonitor>;
