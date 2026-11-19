import { createHash } from "node:crypto";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import type {
	MeshCapacity,
	MeshNode,
	MeshNodeReport as MeshNodeReportView,
	MeshNodesView,
	MeshReliability,
	MeshTrustPolicy,
} from "@hobo/ci/mesh";
import {
	type MeshAdvert,
	MeshAdvertSchema,
	type MeshNodeReports,
	MeshNodeReportsSchema,
	MeshReliabilityRecordSchema,
	MeshTrustConfigSchema,
} from "./_generated/mesh_pb.js";

export const MESH_NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]{1,100}$/;

const within = (value: number, max: number) =>
	Number.isSafeInteger(value) && value >= 0 && value <= max;
const optionalWithin = (value: number | undefined, max: number) =>
	value === undefined || within(value, max);
const count = (value: number | undefined) =>
	value === undefined || (Number.isFinite(value) && value >= 0);

function advertProblem(node: MeshNode): string | undefined {
	if (!MESH_NODE_ID.test(node.id)) return "node id";
	if (!within(node.freeSlots, 4096)) return "free slots";
	if (!optionalWithin(node.totalSlots, 4096)) return "total slots";
	if (
		node.labels.length > 32 ||
		node.labels.some((label) => label.length < 1 || label.length > 80)
	)
		return "labels";
	if (!within(node.validUntilMs, Number.MAX_SAFE_INTEGER)) return "expiry";
	if (!optionalWithin(node.free?.memoryMb, 16_777_216)) return "free memory";
	if (!optionalWithin(node.free?.diskMb, 1_073_741_824)) return "free disk";
	const platform = node.platform;
	if (
		platform &&
		[platform.os, platform.arch].some(
			(value) => value.length < 1 || value.length > 32,
		)
	)
		return "platform";
	const reliability = node.reliability;
	if (
		reliability !== undefined &&
		!(Number.isFinite(reliability) && reliability >= 0 && reliability <= 1)
	)
		return "reliability";
	if (!count(node.samples?.delivered) || !count(node.samples?.dropped))
		return "reliability samples";
	if (!optionalWithin(node.sinceMs, Number.MAX_SAFE_INTEGER)) return "since";
	const identity = node.identity;
	if (
		identity &&
		(identity.publicKey.length > 128 || identity.signature.length > 256)
	)
		return "identity";
	if (node.repository !== undefined && !REPOSITORY.test(node.repository))
		return "repository";
	return undefined;
}

export function meshAdvertJson(node: MeshNode): string {
	const problem = advertProblem(node);
	if (problem !== undefined) throw new Error(`invalid mesh ${problem}`);
	return toJsonString(
		MeshAdvertSchema,
		create(MeshAdvertSchema, {
			id: node.id,
			freeSlots: node.freeSlots,
			healthy: node.healthy,
			labels: [...node.labels],
			validUntilMs: node.validUntilMs,
			totalSlots: node.totalSlots,
			free: node.free && {
				memoryMb: node.free.memoryMb,
				diskMb: node.free.diskMb,
			},
			platform: node.platform,
			reliability: node.reliability,
			samples: node.samples,
			sinceMs: node.sinceMs,
			identity: node.identity,
			repository: node.repository,
		}),
		{ alwaysEmitImplicit: true },
	);
}

export function parseMeshAdvert(text: string): MeshNode | undefined {
	let advert: MeshAdvert;
	try {
		advert = fromJsonString(MeshAdvertSchema, text, {
			ignoreUnknownFields: true,
		});
	} catch {
		return undefined;
	}
	const node: MeshNode = {
		id: advert.id,
		freeSlots: advert.freeSlots,
		totalSlots: advert.totalSlots,
		healthy: advert.healthy,
		labels: advert.labels,
		validUntilMs: advert.validUntilMs,
		free: advert.free && {
			memoryMb: advert.free.memoryMb,
			diskMb: advert.free.diskMb,
		},
		platform: advert.platform && {
			os: advert.platform.os,
			arch: advert.platform.arch,
		},
		reliability: advert.reliability,
		samples: advert.samples && {
			delivered: advert.samples.delivered,
			dropped: advert.samples.dropped,
		},
		sinceMs: advert.sinceMs,
		identity: advert.identity && {
			publicKey: advert.identity.publicKey,
			signature: advert.identity.signature,
		},
		repository: advert.repository,
	};
	return advertProblem(node) === undefined ? node : undefined;
}

export function meshTrustConfigJson(policy: MeshTrustPolicy): string {
	for (const entry of policy.trustedKeys) {
		if (!PUBLIC_KEY.test(entry.publicKey))
			throw new Error("invalid mesh public key");
		if (entry.nodeId !== undefined && !MESH_NODE_ID.test(entry.nodeId))
			throw new Error("invalid mesh node id");
	}
	if (policy.trustedKeys.length > 256)
		throw new Error("too many trusted mesh keys");
	return toJsonString(
		MeshTrustConfigSchema,
		create(MeshTrustConfigSchema, {
			trustedKeys: policy.trustedKeys.map((entry) => ({
				publicKey: entry.publicKey,
				nodeId: entry.nodeId ?? "",
			})),
			requireTrusted: policy.requireTrusted,
		}),
	);
}

export function parseMeshTrustConfig(
	text: string,
): MeshTrustPolicy | undefined {
	try {
		const config = fromJsonString(MeshTrustConfigSchema, text, {
			ignoreUnknownFields: true,
		});
		if (
			config.trustedKeys.length > 256 ||
			config.trustedKeys.some(
				(entry) =>
					!PUBLIC_KEY.test(entry.publicKey) ||
					(entry.nodeId !== "" && !MESH_NODE_ID.test(entry.nodeId)),
			)
		)
			return undefined;
		return {
			trustedKeys: config.trustedKeys.map((entry) =>
				entry.nodeId === ""
					? { publicKey: entry.publicKey }
					: { publicKey: entry.publicKey, nodeId: entry.nodeId },
			),
			requireTrusted: config.requireTrusted,
		};
	} catch {
		return undefined;
	}
}

export type StoredMeshReliability = Readonly<{
	record: MeshReliability;
	resetToken: string;
}>;

export function meshReliabilityRecordJson(
	record: MeshReliability,
	resetToken = "",
): string {
	return toJsonString(
		MeshReliabilityRecordSchema,
		create(MeshReliabilityRecordSchema, {
			delivered: record.delivered,
			dropped: record.dropped,
			atMs: record.atMs,
			resetToken,
		}),
		{ alwaysEmitImplicit: true },
	);
}

export function parseMeshReliabilityRecord(
	text: string,
): StoredMeshReliability | undefined {
	try {
		const stored = fromJsonString(MeshReliabilityRecordSchema, text, {
			ignoreUnknownFields: true,
		});
		const usable = [stored.delivered, stored.dropped, stored.atMs].every(
			(value) => Number.isFinite(value) && value >= 0,
		);
		return usable
			? {
					record: {
						delivered: stored.delivered,
						dropped: stored.dropped,
						atMs: stored.atMs,
					},
					resetToken: stored.resetToken,
				}
			: undefined;
	} catch {
		return undefined;
	}
}

function instant(ms: number | undefined): string {
	return ms === undefined || !Number.isFinite(ms)
		? ""
		: new Date(Math.min(ms, 8.64e15)).toISOString();
}

const whole = (value: number) => Math.max(0, Math.round(value));

function reportMessage(report: MeshNodeReportView) {
	return {
		id: report.id,
		state: report.state,
		since: instant(report.sinceMs),
		healthy: report.healthy,
		lastSeenAt: instant(report.lastSeenMs),
		validUntil: instant(report.validUntilMs),
		totalSlots: report.totalSlots,
		freeSlots: report.freeSlots,
		freeMemoryMb: report.freeMemoryMb,
		freeDiskMb: report.freeDiskMb,
		platform: report.platform,
		labels: [...report.labels],
		trust: report.trust,
		publicKey: report.publicKey ?? "",
		reliability: report.reliability,
		delivered: report.delivered,
		dropped: report.dropped,
		repository: report.repository ?? "",
	};
}

function capacityMessage(capacity: MeshCapacity) {
	return {
		nodes: capacity.nodes,
		healthy: capacity.healthy,
		available: capacity.available,
		totalSlots: whole(capacity.totalSlots),
		freeSlots: whole(capacity.freeSlots),
		freeMemoryMb: whole(capacity.freeMemoryMb),
		largestFreeMemoryMb: whole(capacity.largestFreeMemoryMb),
		freeDiskMb: whole(capacity.freeDiskMb),
	};
}

export type MeshReading = "configured" | "not-configured" | "unreachable";

export const MESH_REPORT_MAX_NODES = 256;

export function meshNodeReportsMessage(input: {
	mesh: MeshReading;
	view?: MeshNodesView | undefined;
	nowMs: number;
	requireTrusted?: boolean | undefined;
}): MeshNodeReports {
	const all = input.view?.nodes ?? [];
	const listed =
		all.length <= MESH_REPORT_MAX_NODES
			? all
			: [
					...all.filter((node) => node.state !== "lost"),
					...all.filter((node) => node.state === "lost"),
				]
					.slice(0, MESH_REPORT_MAX_NODES)
					.sort((a, b) => a.id.localeCompare(b.id));
	return create(MeshNodeReportsSchema, {
		mesh: input.mesh,
		nodes: listed.map(reportMessage),
		truncated: listed.length < all.length,
		capacity: input.view && capacityMessage(input.view.capacity),
		readAt: input.view === undefined ? "" : instant(input.nowMs),
		requireTrusted: input.requireTrusted === true,
	});
}

const LOCAL_HOST_LABEL = "hobo-local-host";

export function meshNodeReportsForAccount(
	reports: MeshNodeReports,
	ownRepositories: ReadonlySet<string>,
): MeshNodeReports {
	const owned = new Set(
		[...ownRepositories].map((repository) => repository.toLowerCase()),
	);
	return create(MeshNodeReportsSchema, {
		...reports,
		nodes: reports.nodes.map((node) => {
			const local =
				node.repository !== "" || node.labels.includes(LOCAL_HOST_LABEL);
			if (!local || owned.has(node.repository.toLowerCase())) return node;
			return {
				...node,
				id: `local-${createHash("sha256").update(node.id).digest("hex").slice(0, 16)}`,
				platform: undefined,
				publicKey: "",
				repository: "",
			};
		}),
	});
}

export function meshNodeReportsJson(reports: MeshNodeReports): string {
	return toJsonString(MeshNodeReportsSchema, reports, {
		alwaysEmitImplicit: true,
	});
}

export function parseMeshNodeReports(text: string): MeshNodeReports {
	return fromJsonString(MeshNodeReportsSchema, text, {
		ignoreUnknownFields: true,
	});
}
