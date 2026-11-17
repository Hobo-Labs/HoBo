import { createHash } from "node:crypto";
import { meshReliabilityWeight } from "./reliability.js";
import type { MeshIdentityProof, MeshTrust } from "./trust.js";

export type MeshNode = Readonly<{
	id: string;
	freeSlots: number;
	totalSlots?: number | undefined;
	healthy: boolean;
	labels: readonly string[];
	validUntilMs: number;
	free?: MeshFree | undefined;
	platform?: MeshPlatform | undefined;
	reliability?: number | undefined;
	samples?: MeshReliabilitySamples | undefined;
	sinceMs?: number | undefined;
	identity?: MeshIdentityProof | undefined;
	trust?: MeshTrust | undefined;
	seenAtMs?: number | undefined;
	repository?: string | undefined;
}>;

export const MESH_MAX_ADVERT_TTL_MS = 5 * 60_000;
export const MESH_MAX_CLOCK_SKEW_MS = 60_000;

export function meshAdvertRejected(node: MeshNode, nowMs: number): boolean {
	return (
		node.trust === "invalid" ||
		!(
			node.validUntilMs <=
			nowMs + MESH_MAX_ADVERT_TTL_MS + MESH_MAX_CLOCK_SKEW_MS
		)
	);
}

export type MeshReliabilitySamples = Readonly<{
	delivered: number;
	dropped: number;
}>;

export type MeshRankPolicy = Readonly<{
	requireTrusted?: boolean | undefined;
}>;

export type MeshFree = Readonly<{
	memoryMb?: number | undefined;
	diskMb?: number | undefined;
}>;

export type MeshPlatform = Readonly<{ os: string; arch: string }>;

export type MeshNeeds = Readonly<{
	memoryMb?: number | undefined;
	diskMb?: number | undefined;
	os?: string | undefined;
	arch?: string | undefined;
}>;

export type MeshJob = Readonly<{
	jobId: number;
	label: string;
	queuedAtMs: number;
	needs?: MeshNeeds | undefined;
}>;

export type MeshLack =
	| "stale"
	| "trust"
	| "unhealthy"
	| "label"
	| "platform"
	| "slots"
	| "memory"
	| "disk";

export type MeshFit = Readonly<
	| { copies: number; limitedBy: "slots" | "memory" | "disk" }
	| { copies: 0; lacking: MeshLack }
>;

function copiesWithin(
	free: number | undefined,
	need: number | undefined,
): number {
	if (free === undefined || need === undefined || need <= 0)
		return Number.POSITIVE_INFINITY;
	return Math.floor(Math.max(0, free) / need);
}

export function fitJob(
	job: MeshJob,
	node: MeshNode,
	nowMs: number,
	policy: MeshRankPolicy = {},
): MeshFit {
	if (node.validUntilMs <= nowMs) return { copies: 0, lacking: "stale" };
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

function unit(jobId: number, nodeId: string): number {
	const hash = createHash("sha256").update(`${jobId}\0${nodeId}`).digest();
	return (hash.readUIntBE(0, 6) + 1) / (TWO_48 + 2);
}

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
			waitMs: number;
			reason: "waiting-turn";
	  }
	| {
			start: false;
			rank: -1;
			waitMs: 0;
			reason: "not-eligible";
			lacking: MeshLack;
	  }
>;

export function claimTurn(input: {
	job: MeshJob;
	self: MeshNode;
	peers: readonly MeshNode[];
	nowMs: number;
	stepMs: number;
	maxRank?: number;
	requireTrusted?: boolean | undefined;
}): ClaimTurn {
	const { job, self, nowMs } = input;
	const policy: MeshRankPolicy = { requireTrusted: input.requireTrusted };
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
			lacking: "lacking" in fit ? fit.lacking : "slots",
		};
	}
	const rank = Math.min(position, input.maxRank ?? 4);
	if (order.length === 1) return { start: true, rank: 0, reason: "alone" };
	if (rank === 0) return { start: true, rank, reason: "first" };
	const queuedAtMs = Math.min(job.queuedAtMs, nowMs);
	const waitMs = queuedAtMs + rank * input.stepMs - nowMs;
	return waitMs <= 0
		? { start: true, rank, reason: "turn-reached" }
		: { start: false, rank, waitMs, reason: "waiting-turn" };
}
