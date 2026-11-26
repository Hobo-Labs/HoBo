/**
 * Phaser-free Yard engine: projection → visual state + particle pool + cost meter.
 * Phaser scenes (optional browser host) consume this engine; tests never need canvas.
 */

import type { YardProjectionSnapshot } from "@hobo/management";
import {
	deriveYardVisualState,
	stepToward,
	type YardVisualState,
} from "./entity-state.js";
import { YARD_LAYOUT, type ZoneId, zoneAnchor } from "./layout.js";
import {
	type GenerativeSheet,
	sheetForConnectionAuthorize,
	sheetForConnectionCreate,
	sheetForCostBooth,
	sheetForDoctor,
	sheetForRailLifecycle,
} from "./openui/sheets.js";

export type Particle = {
	x: number;
	y: number;
	vx: number;
	alive: boolean;
};

export type YardEngine = {
	visual: YardVisualState | null;
	selectedZone: ZoneId | null;
	openSheet: GenerativeSheet | null;
	boPos: { x: number; y: number };
	particles: Particle[];
	applySnapshot(snap: YardProjectionSnapshot): YardVisualState;
	selectZone(zone: ZoneId | null): GenerativeSheet | null;
	tick(dtSec: number): void;
	dismissSheet(): void;
};

const PARTICLE_POOL = 48;
const BO_SPEED = 180;

export function createYardEngine(): YardEngine {
	const particles: Particle[] = Array.from({ length: PARTICLE_POOL }, () => ({
		x: 0,
		y: 0,
		vx: 0,
		alive: false,
	}));

	const engine: YardEngine = {
		visual: null,
		selectedZone: null,
		openSheet: null,
		boPos: {
			x: YARD_LAYOUT.zones.platformRest.anchorX,
			y: YARD_LAYOUT.zones.platformRest.anchorY,
		},
		particles,
		applySnapshot(snap) {
			const visual = deriveYardVisualState(snap, {
				...(engine.selectedZone ? { selectedZone: engine.selectedZone } : {}),
			});
			engine.visual = visual;
			return visual;
		},
		selectZone(zone) {
			engine.selectedZone = zone;
			if (!zone || !engine.visual) {
				engine.openSheet = null;
				return null;
			}
			// Rebuild visual with selection; caller re-applies full snap when available.
			const sheet = sheetForZone(zone, null);
			engine.openSheet = sheet;
			return sheet;
		},
		tick(dtSec) {
			const visual = engine.visual;
			if (!visual) return;
			const target = zoneAnchor(visual.bo.zone);
			const next = stepToward(engine.boPos, target, BO_SPEED, dtSec);
			engine.boPos = { x: next.x, y: next.y };

			// Traffic particle pool — rate ∝ metering.trafficRate
			const rate = visual.traffic.active ? visual.traffic.rate : 0;
			const emitBudget = rate * 8 * dtSec;
			let toEmit = emitBudget;
			const emitter = YARD_LAYOUT.trafficEmitter;
			for (const p of particles) {
				if (p.alive) {
					p.x += p.vx * dtSec;
					if (p.x > emitter.x + emitter.width) p.alive = false;
				} else if (toEmit >= 1) {
					p.alive = true;
					p.x = emitter.x;
					p.y = emitter.y + (Math.random() * 40 - 20);
					p.vx = 80 + rate * 120;
					toEmit -= 1;
				}
			}
		},
		dismissSheet() {
			engine.openSheet = null;
			engine.selectedZone = null;
		},
	};
	return engine;
}

export function sheetForZone(
	zone: ZoneId,
	snap: YardProjectionSnapshot | null,
): GenerativeSheet | null {
	switch (zone) {
		case "connectionBay": {
			const pending = snap?.connections.find((c) => c.status === "pending");
			if (pending) {
				return sheetForConnectionAuthorize(
					pending.alias ?? pending.id,
					snap ?? undefined,
				);
			}
			return sheetForConnectionCreate(snap ?? undefined);
		}
		case "policyBoard":
			return sheetForRailLifecycle(snap ?? undefined);
		case "costBooth":
			return sheetForCostBooth(snap ?? undefined);
		case "errorBunker":
			return sheetForDoctor(snap ?? undefined);
		default:
			return null;
	}
}

/** Select zone with full snapshot so sheets get current projection fields. */
export function selectZoneWithSnapshot(
	engine: YardEngine,
	zone: ZoneId,
	snap: YardProjectionSnapshot,
): GenerativeSheet | null {
	engine.selectedZone = zone;
	engine.applySnapshot(snap);
	const sheet = sheetForZone(zone, snap);
	engine.openSheet = sheet;
	return sheet;
}
