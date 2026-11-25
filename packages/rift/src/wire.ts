/**
 * The wire boundary: generated protobuf types in, parsed domain types out.
 *
 * `data-models/rift_workspace.proto` is the schema of record, and
 * `src/_generated/rift_workspace_pb.ts` is generated from it. The domain types
 * in `workspace.ts` are deliberately *not* those types — they are the parsed
 * form: a branded `WorkspaceName`, a string-literal tier, and overlay layers
 * present only for the tier that has them. Conversion happens here, once.
 *
 * Keeping the mapping in one typed place is what makes the schema load-bearing
 * rather than documentation: rename a field or drop an enum value in the proto
 * and this file stops compiling.
 */

import { CowTier as CowTierPb } from "./_generated/rift_workspace_pb.js";
import type { Capability, CowTier } from "./capability.js";
import type { WorkspaceRecord } from "./workspace.js";

interface CowTierToWire {
	readonly reflink: CowTierPb;
	readonly overlayfs: CowTierPb;
	readonly hardlink: CowTierPb;
	readonly copy: CowTierPb;
}

const TIER_TO_WIRE: CowTierToWire = {
	reflink: CowTierPb.REFLINK,
	overlayfs: CowTierPb.OVERLAYFS,
	hardlink: CowTierPb.HARDLINK,
	copy: CowTierPb.COPY,
};

export function tierToWire(tier: CowTier): CowTierPb {
	return TIER_TO_WIRE[tier];
}

/** Unknown/unspecified is not a tier we can act on, so it parses to null. */
export function tierFromWire(tier: CowTierPb): CowTier | null {
	if (tier === TIER_TO_WIRE.reflink) return "reflink";
	if (tier === TIER_TO_WIRE.overlayfs) return "overlayfs";
	if (tier === TIER_TO_WIRE.hardlink) return "hardlink";
	if (tier === TIER_TO_WIRE.copy) return "copy";
	return null;
}

/** Field-for-field wire form of a capability probe. */
interface CapabilityWire {
	tier: CowTierPb;
	available: CowTierPb[];
	reason: string;
	isolatesInPlaceWrites: boolean;
}

export function capabilityToWire(capability: Capability): CapabilityWire {
	return {
		tier: tierToWire(capability.tier),
		available: capability.available.map(tierToWire),
		reason: capability.reason,
		isolatesInPlaceWrites: capability.isolatesInPlaceWrites,
	};
}

/**
 * Wire form of a workspace. Absent overlay layers become empty strings because
 * proto3 has no optional scalar presence here — the domain type keeps the
 * distinction, the wire form does not need it.
 */
interface WorkspaceWire {
	name: string;
	path: string;
	tier: CowTierPb;
	source: string;
	upper: string;
	work: string;
	createdAt: string;
}

export function workspaceToWire(record: WorkspaceRecord): WorkspaceWire {
	return {
		name: record.name,
		path: record.path,
		tier: tierToWire(record.tier),
		source: record.source,
		upper: record.upper ?? "",
		work: record.work ?? "",
		createdAt: record.createdAt,
	};
}
