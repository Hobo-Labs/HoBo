import { LOCAL_HOST_RUNNER_LABEL } from "../fleet-overflow.js";
import type { MeshBoard } from "./coordinator.js";
import { type MeshNode, meshAdvertRejected } from "./rendezvous.js";

export type MeshCapacity = Readonly<{
	nodes: number;
	healthy: number;
	available: number;
	totalSlots: number;
	freeSlots: number;
	freeMemoryMb: number;
	largestFreeMemoryMb: number;
	freeDiskMb: number;
}>;

export function isMeshFleetNode(node: MeshNode): boolean {
	return node.labels.some((label) => label !== LOCAL_HOST_RUNNER_LABEL);
}

export function meshCapacity(
	nodes: readonly MeshNode[],
	nowMs: number,
	options: { requireTrusted?: boolean | undefined } = {},
): MeshCapacity {
	const live = nodes.filter(
		(node) =>
			node.validUntilMs > nowMs &&
			!meshAdvertRejected(node, nowMs) &&
			(options.requireTrusted !== true || node.trust === "trusted") &&
			isMeshFleetNode(node),
	);
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
		freeMemoryMb: healthy.reduce(
			(sum, node) => sum + (node.free?.memoryMb ?? 0),
			0,
		),
		largestFreeMemoryMb: healthy.reduce(
			(most, node) => Math.max(most, node.free?.memoryMb ?? 0),
			0,
		),
		freeDiskMb: healthy.reduce(
			(sum, node) => sum + (node.free?.diskMb ?? 0),
			0,
		),
	};
}

export function meshLeaderId(
	nodes: readonly MeshNode[],
	nowMs: number,
	selfId: string,
): string {
	const live = nodes
		.filter(
			(node) => node.validUntilMs > nowMs && !meshAdvertRejected(node, nowMs),
		)
		.map((node) => node.id)
		.sort();
	return live[0] ?? selfId;
}

export type MeshMonitorEvent =
	| "hobo_ci_mesh_node_joined"
	| "hobo_ci_mesh_node_lost"
	| "hobo_ci_mesh_node_unhealthy"
	| "hobo_ci_mesh_node_recovered"
	| "hobo_ci_mesh_node_invalid"
	| "hobo_ci_mesh_capacity_exhausted"
	| "hobo_ci_mesh_capacity_restored"
	| "hobo_ci_mesh_capacity";

export function createMeshMonitor(options: {
	selfId: string;
	board: MeshBoard;
	now?: () => number;
	summaryEveryMs?: number;
	requireTrusted?: (() => boolean) | undefined;
	log: (
		event: MeshMonitorEvent,
		fields: Readonly<Record<string, string | number | boolean>>,
	) => void;
}) {
	const now = options.now ?? Date.now;
	const summaryEveryMs = options.summaryEveryMs ?? 60_000;
	let previous: ReadonlyMap<string, MeshNode> | undefined;
	let rejected: ReadonlySet<string> = new Set();
	let exhausted = false;
	let summarizedAt = Number.NEGATIVE_INFINITY;

	return {
		async observe(): Promise<MeshCapacity | undefined> {
			let nodes: readonly MeshNode[];
			try {
				nodes = await options.board.nodes();
			} catch {
				return undefined;
			}
			const nowMs = now();
			const current = nodes.filter((node) => node.validUntilMs > nowMs);
			const live = new Map(
				current
					.filter((node) => !meshAdvertRejected(node, nowMs))
					.map((node) => [node.id, node]),
			);
			const invalid = new Set(
				current
					.filter((node) => meshAdvertRejected(node, nowMs))
					.map((node) => node.id),
			);
			const capacity = meshCapacity(nodes, nowMs, {
				requireTrusted: options.requireTrusted?.() ?? false,
			});
			const reporter = meshLeaderId(nodes, nowMs, options.selfId);
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
							trust: node.trust ?? "unverified",
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
				for (const id of invalid)
					if (!rejected.has(id))
						options.log("hobo_ci_mesh_node_invalid", { nodeId: id });
				rejected = invalid;
			}
			if (reports) {
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
