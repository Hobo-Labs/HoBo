/**
 * The one function that answers "what does the mesh look like?", for every
 * surface that shows it: the relay's `GET /v1/mesh/nodes`, its
 * `list_mesh_nodes` tool and `hobo-ci://mesh/nodes` resource, and
 * `hobo ci status`.
 *
 * It reads a board and nothing else: no file, no key, no clock but the one
 * it is given. That keeps it loadable by every host of the relay, including
 * one with no filesystem.
 */
import {
	createMeshNodeTracker,
	type MeshBoard,
	type MeshNode,
	type MeshTrust,
} from "@hobo/ci/mesh";
import type { MeshNodeReports } from "./_generated/mesh_pb.js";
import { meshNodeReportsMessage } from "./mesh-records.js";

/** Asks what the mesh looks like. Never rejects. */
export type MeshNodesReader = () => Promise<MeshNodeReports>;

/**
 * With no board the host has no mesh, and says so: `mesh: "not-configured"`
 * is an answer, with the host's own report when it is a node. With a board
 * that cannot be read it answers `unreachable` with its last reading. Nodes
 * that stopped advertising stay listed as `lost` for `retainLostMs`.
 */
export function createMeshNodesReader(
	options: {
		board?: Pick<MeshBoard, "nodes"> | undefined;
		/** This host's own node, listed even before its first advertisement lands. */
		self?: (() => MeshNode) | undefined;
		/**
		 * How far this host trusts an advertisement, for its own node while it
		 * is not on the board: the same judgement the board applies to the rest.
		 * Left out, a host takes its own word about itself.
		 */
		assess?: ((node: MeshNode) => MeshTrust) | undefined;
		requireTrusted?: (() => boolean) | undefined;
		retainLostMs?: number | undefined;
		now?: () => number;
	} = {},
): MeshNodesReader {
	const now = options.now ?? Date.now;
	const tracker = createMeshNodeTracker(
		options.retainLostMs === undefined
			? undefined
			: { retainLostMs: options.retainLostMs },
	);
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
