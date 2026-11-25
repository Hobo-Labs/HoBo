/**
 * Entity state machines driven only by projection snapshots.
 * UI never invents occupancy/rail/connection state.
 */

import type { YardProjectionSnapshot } from "@hobo/management";

import type { ZoneId } from "./layout.js";

export type BoAnimState =
	| "idle"
	| "walking"
	| "occupying"
	| "resolving"
	| "error";

export type RailVisualState =
	| "dark"
	| "draft"
	| "approved"
	| "active"
	| "retired";

export type ConnectionVisualState =
	| "closed"
	| "pending"
	| "authorized"
	| "revoked";

export type GuestVisualState = "offline" | "idle" | "working" | "error";

export type YardVisualState = Readonly<{
	bo: {
		state: BoAnimState;
		/** Stable animation id from assets_index — never a raw clip filename. */
		animationId: string;
		zone: ZoneId;
		facing: "east" | "west";
	};
	rails: readonly {
		id: string;
		contentHash: string;
		visual: RailVisualState;
	}[];
	connections: readonly {
		id: string;
		alias?: string;
		provider: string;
		visual: ConnectionVisualState;
	}[];
	guests: readonly {
		connectorKind: string;
		connectionId?: string;
		visual: GuestVisualState;
		animationId: string;
	}[];
	traffic: {
		rate: number;
		active: boolean;
	};
	costMeter: {
		fill: number;
		heat: number;
		quotaUsed: number;
		quotaLimit: number;
		spendCapUsd: number;
	};
	errorBunker: {
		active: boolean;
		hazards: readonly string[];
	};
	bootstrapDesk: {
		active: boolean;
	};
	seq: number;
	occupyMode: "idle" | "occupying";
}>;

const GUEST_ANIM: Record<GuestVisualState, string> = {
	offline: "guest.swe-claude.idle",
	idle: "guest.swe-claude.idle",
	working: "guest.swe-claude.work",
	error: "guest.swe-claude.error",
};

export function deriveYardVisualState(
	snap: YardProjectionSnapshot,
	opts?: { selectedZone?: ZoneId },
): YardVisualState {
	const selected = opts?.selectedZone;
	const boZone = pickBoZone(snap, selected);
	const boState = pickBoState(snap, boZone);
	const facing: "east" | "west" =
		boZone === "connectionBay" || boZone === "costBooth" ? "east" : "west";

	// Site sheets only: idle + walk E/W. Error/occupying still play idle art.
	const animationId =
		boState === "walking"
			? facing === "east"
				? "bo.walk.east"
				: "bo.walk.west"
			: "bo.idle";

	const rails = snap.rails.map((r) =>
		Object.freeze({
			id: r.id,
			contentHash: r.contentHash,
			visual: r.activationStatus as RailVisualState,
		}),
	);

	const connections = snap.connections.map((c) =>
		Object.freeze({
			id: c.id,
			...(c.alias !== undefined ? { alias: c.alias } : {}),
			provider: c.provider,
			visual: mapConnectionVisual(String(c.status)),
		}),
	);

	const guests = snap.activity.map((a) =>
		Object.freeze({
			connectorKind: a.connectorKind,
			...(a.connectionId !== undefined ? { connectionId: a.connectionId } : {}),
			visual: a.status,
			animationId: GUEST_ANIM[a.status] ?? GUEST_ANIM.idle,
		}),
	);

	const quotaLimit = snap.metering.quotaLimit || 1;
	const fill = Math.min(1, Math.max(0, snap.metering.quotaUsed / quotaLimit));
	const heat =
		snap.metering.spendCapUsd > 0
			? Math.min(
					1,
					Math.max(0, snap.metering.budgetUsd / snap.metering.spendCapUsd),
				)
			: fill;

	return Object.freeze({
		bo: Object.freeze({
			state: boState,
			animationId,
			zone: boZone,
			facing,
		}),
		rails: Object.freeze(rails),
		connections: Object.freeze(connections),
		guests: Object.freeze(guests),
		traffic: Object.freeze({
			rate: snap.metering.trafficRate,
			active:
				snap.metering.trafficRate > 0 &&
				Boolean(snap.occupancy.activeRailHash) &&
				snap.occupyMode === "occupying",
		}),
		costMeter: Object.freeze({
			fill,
			heat,
			quotaUsed: snap.metering.quotaUsed,
			quotaLimit: snap.metering.quotaLimit,
			spendCapUsd: snap.metering.spendCapUsd,
		}),
		errorBunker: Object.freeze({
			active: snap.doctor.hazards.length > 0,
			hazards: snap.doctor.hazards,
		}),
		bootstrapDesk: Object.freeze({
			active: snap.occupancy.bootstrapActive,
		}),
		seq: snap.seq,
		occupyMode: snap.occupyMode,
	});
}

function pickBoZone(snap: YardProjectionSnapshot, selected?: ZoneId): ZoneId {
	if (selected) return selected;
	if (snap.doctor.hazards.length > 2) return "errorBunker";
	if (snap.occupancy.bootstrapActive) return "bootstrapDesk";
	if (snap.occupyMode === "occupying" && snap.occupancy.activeRailHash) {
		return "activeRailTrack";
	}
	if (snap.connections.some((c) => c.status === "pending")) {
		return "connectionBay";
	}
	return "platformRest";
}

function pickBoState(snap: YardProjectionSnapshot, zone: ZoneId): BoAnimState {
	if (snap.doctor.hazards.some((h) => h.startsWith("connection-revoked"))) {
		return "error";
	}
	if (zone === "activeRailTrack" && snap.occupyMode === "occupying") {
		return "walking";
	}
	if (snap.occupyMode === "occupying") return "occupying";
	if (zone === "connectionBay") return "resolving";
	return "idle";
}

function mapConnectionVisual(status: string): ConnectionVisualState {
	switch (status) {
		case "pending":
		case "needs-reauth":
			return "pending";
		case "active":
			return "authorized";
		case "revoked":
		case "expired":
			return "revoked";
		default:
			return "closed";
	}
}

/** Frame-rate independent walk step toward zone anchor. */
export function stepToward(
	from: { x: number; y: number },
	to: { x: number; y: number },
	speedPxPerSec: number,
	dtSec: number,
): { x: number; y: number; arrived: boolean } {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const dist = Math.hypot(dx, dy);
	const step = speedPxPerSec * dtSec;
	if (dist <= step || dist === 0) {
		return { x: to.x, y: to.y, arrived: true };
	}
	const t = step / dist;
	return {
		x: from.x + dx * t,
		y: from.y + dy * t,
		arrived: false,
	};
}
