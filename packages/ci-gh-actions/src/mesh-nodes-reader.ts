import {
	createMeshNodeTracker,
	type MeshBoard,
	type MeshNode,
	type MeshTrust,
} from "@hobo/ci/mesh";
import type { MeshNodeReports } from "./_generated/mesh_pb.js";
import { meshNodeReportsMessage } from "./mesh-records.js";

export type MeshNodesReader = () => Promise<MeshNodeReports>;

export function createMeshNodesReader(
	options: {
		board?: Pick<MeshBoard, "nodes"> | undefined;
		self?: (() => MeshNode) | undefined;
		assess?: ((node: MeshNode) => MeshTrust) | undefined;
		requireTrusted?: (() => boolean) | undefined;
		retainLostMs?: number | undefined;
		now?: () => number;
	} = {},
): MeshNodesReader {
	const now = options.now ?? Date.now;
	const tracker = createMeshNodeTracker({
		retainLostMs: options.retainLostMs,
		requireTrusted: options.requireTrusted,
	});
	let last: readonly MeshNode[] = [];
	const withSelf = (nodes: readonly MeshNode[]): readonly MeshNode[] => {
		const self = options.self?.();
		return self === undefined || nodes.some((node) => node.id === self.id)
			? nodes
			: [
					...nodes,
					{
						...self,
						trust: options.assess?.(self) ?? "trusted",
						seenAtMs: now(),
					},
				];
	};
	return async () => {
		const requireTrusted = options.requireTrusted?.() ?? false;
		if (!options.board)
			return meshNodeReportsMessage({
				mesh: "not-configured",
				view: options.self ? tracker.observe(withSelf([]), now()) : undefined,
				nowMs: now(),
				requireTrusted,
			});
		let reachable = true;
		try {
			last = await options.board.nodes();
		} catch {
			reachable = false;
		}
		return meshNodeReportsMessage({
			mesh: reachable ? "configured" : "unreachable",
			view: tracker.observe(withSelf(last), now()),
			nowMs: now(),
			requireTrusted,
		});
	};
}
