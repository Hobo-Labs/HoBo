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

export function tierFromWire(tier: CowTierPb): CowTier | null {
	if (tier === TIER_TO_WIRE.reflink) return "reflink";
	if (tier === TIER_TO_WIRE.overlayfs) return "overlayfs";
	if (tier === TIER_TO_WIRE.hardlink) return "hardlink";
	if (tier === TIER_TO_WIRE.copy) return "copy";
	return null;
}

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
