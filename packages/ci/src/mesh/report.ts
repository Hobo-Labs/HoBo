import { type MeshCapacity, meshCapacity } from "./monitor.js";
import {
	type MeshNode,
	type MeshPlatform,
	meshAdvertRejected,
} from "./rendezvous.js";
import type { MeshTrust } from "./trust.js";

export type MeshNodeState = "live" | "unhealthy" | "lost";

export type MeshNodeReport = Readonly<{
	id: string;
	state: MeshNodeState;
	sinceMs?: number | undefined;
	healthy: boolean;
	lastSeenMs?: number | undefined;
	validUntilMs: number;
	totalSlots: number;
	freeSlots: number;
	freeMemoryMb?: number | undefined;
	freeDiskMb?: number | undefined;
	platform?: MeshPlatform | undefined;
	labels: readonly string[];
	trust: MeshTrust;
	publicKey?: string | undefined;
	reliability?: number | undefined;
	delivered?: number | undefined;
	dropped?: number | undefined;
	repository?: string | undefined;
}>;

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

export type MeshNodesView = Readonly<{
	nodes: readonly MeshNodeReport[];
	capacity: MeshCapacity;
}>;

export function createMeshNodeTracker(options?: {
	retainLostMs?: number | undefined;
	requireTrusted?: (() => boolean) | undefined;
}) {
	const retainLostMs = options?.retainLostMs ?? 60 * 60_000;
	const known = new Map<string, MeshNode>();

	return {
		observe(nodes: readonly MeshNode[], nowMs: number): MeshNodesView {
			for (const node of nodes) known.set(node.id, node);
			const present = new Set(nodes.map((node) => node.id));
			const reports: MeshNodeReport[] = [];
			for (const [id, node] of known) {
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

export type MeshLabelState = Readonly<{
	nodes: number;
	trustedNodes: number;
	freeSlots: number;
}>;

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
