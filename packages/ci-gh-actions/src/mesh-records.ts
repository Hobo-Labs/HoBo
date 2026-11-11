/**
 * The relay mesh's records at their boundaries: protobuf JSON on the wire
 * and in storage (`data-models/mesh.proto`), the `@hobo/ci/mesh` types
 * inside. Each `parse*` either returns a value the rest of the code can use
 * without checking again, or nothing.
 */
import { createHash } from "node:crypto";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import type {
	MeshCapacity,
	MeshLabelState,
	MeshNode,
	MeshNodeReport as MeshNodeReportView,
	MeshNodesView,
	MeshReliability,
	MeshTrustPolicy,
} from "@hobo/ci/mesh";
import {
	type MeshAdvert,
	MeshAdvertSchema,
	MeshFleetStateSchema,
	type MeshNodeReports,
	MeshNodeReportsSchema,
	MeshReliabilityRecordSchema,
	MeshTrustConfigSchema,
} from "./_generated/mesh_pb.js";

/** Node ids are bucket keys and hash inputs: a short, plain token. */
export const MESH_NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]{1,100}$/;

const within = (value: number, max: number) =>
	Number.isSafeInteger(value) && value >= 0 && value <= max;
const optionalWithin = (value: number | undefined, max: number) =>
	value === undefined || within(value, max);
const count = (value: number | undefined) =>
	value === undefined || (Number.isFinite(value) && value >= 0);

/**
 * The checks a board applies to an advertisement, written or read. A
 * signature is not judged here: an advertisement with a bad one is kept, so
 * the reader can report it as invalid.
 */
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

/**
 * An advertisement as it is written to the board. Throws when the node's own
 * state does not fit the record, so a worker never publishes what no reader
 * would accept. What only a reader computes (`trust`, `seenAtMs`) is not a
 * field of the record and is never written.
 */
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
			// An absent figure is left unset: unknown is not zero.
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
		// A node on an older version reads `freeSlots: 0` and `healthy: false`,
		// not their absence.
		{ alwaysEmitImplicit: true },
	);
}

/**
 * The node an advertisement on the board describes, or nothing when this
 * version cannot read it. Fields it does not know are ignored, so a newer
 * node's advertisement is still read; fields it knows and finds missing (an
 * older node's) leave the node as that older version described it.
 */
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

/** The mesh's trust settings as stored under `trust` in the config bucket. */
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

/**
 * The stored trust settings, or nothing when they cannot be read. Unreadable
 * settings are not half-applied: the reader falls back to trusting only itself.
 */
export function parseMeshTrustConfig(
	text: string,
): MeshTrustPolicy | undefined {
	try {
		// A field a newer version added is ignored: the keys this version
		// understands still apply.
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

/** A node's reliability record as its journal keeps it. */
export type StoredMeshReliability = Readonly<{
	record: MeshReliability;
	/** The reset value last applied; empty when none was. */
	resetToken: string;
}>;

/** A node's reliability record as it is kept in its journal. */
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

/** The stored record, or nothing when it is missing a count or cannot be read. */
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

/** Epoch milliseconds as RFC 3339, or empty when there is no time to give. */
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
		// Unknown stays unset: a report never turns "does not say" into zero.
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

/** How a host stands to a mesh; see `MeshNodeReports.mesh`. */
export type MeshReading = "configured" | "not-configured" | "unreachable";

/**
 * The most nodes one answer lists. Nodes that are there come before nodes
 * that are lost; the capacity summary always covers every node read.
 */
export const MESH_REPORT_MAX_NODES = 256;

/** The one answer every surface gives: the reports, the summary, and how the host stands to a mesh. */
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
		// A host with no mesh and no node of its own read nothing, at no time.
		readAt: input.view === undefined ? "" : instant(input.nowMs),
		requireTrusted: input.requireTrusted === true,
	});
}

/** The label a machine running jobs for one repository serves. */
const LOCAL_HOST_LABEL = "hobo-local-host";

/**
 * The answer as one account may see it. Fleet nodes and relay hosts belong
 * to the relay and are shown to every account. A machine running jobs for
 * one repository is somebody's own computer: its id (derived from its host
 * name), platform and key are shown only to the account that owns that
 * repository. For anyone else, and for such a machine that does not say
 * which repository it serves, it is listed under a stable opaque id with
 * its state, capacity and trust only.
 */
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

/** The answer as JSON, zeros and empty lists written out. */
export function meshNodeReportsJson(reports: MeshNodeReports): string {
	return toJsonString(MeshNodeReportsSchema, reports, {
		alwaysEmitImplicit: true,
	});
}

/** An answer read back from a relay; throws when it is not one. */
export function parseMeshNodeReports(text: string): MeshNodeReports {
	return fromJsonString(MeshNodeReportsSchema, text, {
		ignoreUnknownFields: true,
	});
}

/** The value of the `HOBO_CI_FLEET_STATE` repository variable. */
export function meshFleetStateJson(
	labels: ReadonlyMap<string, MeshLabelState>,
	nowMs: number,
): string {
	return toJsonString(
		MeshFleetStateSchema,
		create(MeshFleetStateSchema, {
			publishedAt: instant(nowMs),
			labels: Object.fromEntries(
				[...labels]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([label, state]) => [label, { ...state }]),
			),
		}),
		{ alwaysEmitImplicit: true },
	);
}
