/**
 * What the mesh looks like to someone asking: one report per node saying
 * whether it is there, what it could take, and how far its word is trusted.
 *
 * Ranking reads the board for one job and forgets. A report is for a person
 * or an agent: it names the node's state (`live`, `unhealthy`, `lost`) and
 * since when, and it keeps a node that stopped advertising on the list as
 * `lost` for a while, so "it is gone" is something the list says and not
 * something a reader has to notice is missing.
 *
 * Every surface that shows the mesh (the relay's HTTP route, its MCP tool
 * and resource, `hobo ci status`) is built from `meshNodeReport` and
 * `createMeshNodeTracker`, so they cannot disagree.
 */
import { type MeshCapacity, meshCapacity } from "./monitor.js";
import {
	type MeshNode,
	type MeshPlatform,
	meshAdvertRejected,
} from "./rendezvous.js";
import type { MeshTrust } from "./trust.js";

/** `live`: advertising and healthy. `unhealthy`: advertising, draining or under pressure. `lost`: its last advertisement expired. */
export type MeshNodeState = "live" | "unhealthy" | "lost";

/** One node as a reader reports it. */
export type MeshNodeReport = Readonly<{
	id: string;
	state: MeshNodeState;
	/**
	 * Since when the node has been in `state` (epoch ms). For `lost`, when its
	 * last advertisement expired. Absent when the node does not say.
	 */
	sinceMs?: number | undefined;
	healthy: boolean;
	/** When the board last received an advertisement from it, when the board says. */
	lastSeenMs?: number | undefined;
	/** Until when its last advertisement asked to be believed. */
	validUntilMs: number;
	totalSlots: number;
	freeSlots: number;
	freeMemoryMb?: number | undefined;
	freeDiskMb?: number | undefined;
	platform?: MeshPlatform | undefined;
	labels: readonly string[];
	/** What this reader made of the node's signature and key. */
	trust: MeshTrust;
	/** The key the advertisement was signed with, when it was signed. */
	publicKey?: string | undefined;
	/** The share of its recent jobs the node says it delivered, in (0, 1]. */
	reliability?: number | undefined;
	/** The decayed counts behind that share. */
	delivered?: number | undefined;
	dropped?: number | undefined;
	/** For a machine running jobs for one repository, that repository. */
	repository?: string | undefined;
}>;

/** The report for one advertisement as of `nowMs`. */
export function meshNodeReport(node: MeshNode, nowMs: number): MeshNodeReport {
	const lost = node.validUntilMs <= nowMs;
	return {
		id: node.id,
		state: lost ? "lost" : node.healthy ? "live" : "unhealthy",
		sinceMs: lost ? node.validUntilMs : node.sinceMs,
		healthy: node.healthy,
		lastSeenMs: node.seenAtMs,
		validUntilMs: node.validUntilMs,
		totalSlots: Math.max(0, Math.floor(node.totalSlots ?? node.freeSlots)),
		freeSlots: Math.max(0, Math.floor(node.freeSlots)),
		freeMemoryMb: node.free?.memoryMb,
		freeDiskMb: node.free?.diskMb,
		platform: node.platform,
		labels: [...node.labels],
		// A rejected advertisement is reported as invalid whatever its key
		// (`meshAdvertRejected`); one nobody checked is no better than an
		// unknown key.
		trust: meshAdvertRejected(node, nowMs)
			? "invalid"
			: (node.trust ?? "unverified"),
		publicKey: node.identity?.publicKey,
		reliability: node.reliability,
		delivered: node.samples?.delivered,
		dropped: node.samples?.dropped,
		repository: node.repository,
	};
}

/** What a set of advertisements adds up to. */
export type MeshNodesView = Readonly<{
	nodes: readonly MeshNodeReport[];
	capacity: MeshCapacity;
}>;

/**
 * Turns successive readings of the board into reports, remembering nodes
 * that have gone. A node whose advertisement expired, or that is no longer
 * on the board at all, stays on the list as `lost` for `retainLostMs`.
 */
export function createMeshNodeTracker(options?: {
	/** How long a lost node stays on the list. An hour when omitted. */
	retainLostMs?: number | undefined;
	/** Whether this mesh ranks only trusted nodes, for the capacity summary. */
	requireTrusted?: (() => boolean) | undefined;
}) {
	const retainLostMs = options?.retainLostMs ?? 60 * 60_000;
	const known = new Map<string, MeshNode>();

	return {
		/** The reports for `nodes` as read at `nowMs`, and for the nodes lost since. */
		observe(nodes: readonly MeshNode[], nowMs: number): MeshNodesView {
			for (const node of nodes) known.set(node.id, node);
			const present = new Set(nodes.map((node) => node.id));
			const reports: MeshNodeReport[] = [];
			for (const [id, node] of known) {
				// Gone from the board before its advertisement ran out (the board
				// was cleared, or its own expiry is shorter): lost as of now.
				const last =
					present.has(id) || node.validUntilMs <= nowMs
						? node
						: { ...node, validUntilMs: nowMs };
				if (last !== node) known.set(id, last);
				if (last.validUntilMs <= nowMs - retainLostMs) {
					known.delete(id);
					continue;
				}
				reports.push(meshNodeReport(last, nowMs));
			}
			return {
				nodes: reports.sort((a, b) => a.id.localeCompare(b.id)),
				capacity: meshCapacity(nodes, nowMs, {
					requireTrusted: options?.requireTrusted?.() ?? false,
				}),
			};
		},
	};
}

export type MeshNodeTracker = ReturnType<typeof createMeshNodeTracker>;

/** What the mesh offers one runner label right now. */
export type MeshLabelState = Readonly<{
	/** Live, healthy nodes serving the label. */
	nodes: number;
	/** Of those, the ones whose key the reader trusts. */
	trustedNodes: number;
	/** Free runner slots across those nodes. */
	freeSlots: number;
}>;

/**
 * Per label in `labels`, and only those, the nodes that would pick up a job
 * asking for it, and their free slots. A node counts when its advertisement
 * has not expired, it is healthy, and the reader does not reject it
 * (`meshAdvertRejected`).
 *
 * Trust is counted (`trustedNodes`) but does not filter. `requireTrusted`
 * decides which peers a worker defers to when ranking; it does not stop an
 * unlisted worker from taking a job GitHub hands it. So for "will a job on
 * this label start", an unlisted node is as real as a listed one.
 *
 * Every label in `labels` is present, with zeros when no node serves it, so
 * "nobody serves this" is said and not left out. A label not in `labels` is
 * never reported, whatever nodes advertise it.
 */
export function meshLabelStates(
	nodes: readonly MeshNode[],
	nowMs: number,
	options: { labels: readonly string[] },
): ReadonlyMap<string, MeshLabelState> {
	const states = new Map<string, MeshLabelState>(
		options.labels.map((label) => [
			label,
			{ nodes: 0, trustedNodes: 0, freeSlots: 0 },
		]),
	);
	const seen = new Set<string>();
	for (const node of nodes) {
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		if (
			node.validUntilMs <= nowMs ||
			!node.healthy ||
			meshAdvertRejected(node, nowMs)
		)
			continue;
		for (const label of new Set(node.labels)) {
			const state = states.get(label);
			if (!state) continue;
			states.set(label, {
				nodes: state.nodes + 1,
				trustedNodes: state.trustedNodes + (node.trust === "trusted" ? 1 : 0),
				freeSlots: state.freeSlots + Math.max(0, Math.floor(node.freeSlots)),
			});
		}
	}
	return states;
}
