/**
 * playwright-testing seam: readiness + serializable state + commands.
 * Never expose raw engine objects.
 */
import type { YardProjectionSnapshot } from "@hobo/management";
import type { YardVisualState } from "./entity-state.js";
import type { ZoneId } from "./layout.js";

export type YardTestState = Readonly<{
	scene: string;
	ready: boolean;
	seed: number | null;
	frameCount: number;
	zone: ZoneId | null;
	bo: { x: number; y: number; animationId: string; facing: string };
	occupyMode: string | null;
	connCount: number;
	trafficRate: number;
	bootstrapActive: boolean;
	sheetOpen: boolean;
	sheetKind: string | null;
	seq: number | null;
	hazards: readonly string[];
}>;

export type YardTestCommands = Readonly<{
	reset: () => void;
	seed: (n: number) => void;
	selectZone: (zone: ZoneId) => void;
	dismissSheet: () => void;
	runAction: (action: string) => Promise<void>;
	advanceFrame: (dtMs?: number) => void;
}>;

export type YardTestSeam = {
	ready: boolean;
	seed: number | null;
	sceneKey: string;
	frameCount: number;
	state: () => YardTestState;
	commands: YardTestCommands;
};

export type YardTestHost = {
	getBo: () => { x: number; y: number; animationId: string; facing: string };
	getZone: () => ZoneId | null;
	getSnap: () => YardProjectionSnapshot | null;
	getVisual: () => YardVisualState | null;
	isSheetOpen: () => boolean;
	sheetKind: () => string | null;
	selectZone: (zone: ZoneId) => void;
	dismissSheet: () => void;
	runAction: (action: string) => Promise<void>;
	reset: () => void;
	advanceFrame: (dtMs: number) => void;
	setSeed: (n: number) => void;
};

export function createTestSeam(host: YardTestHost): YardTestSeam {
	const seam: YardTestSeam = {
		ready: false,
		seed: null,
		sceneKey: "Yard",
		frameCount: 0,
		state: () => {
			const snap = host.getSnap();
			const bo = host.getBo();
			return Object.freeze({
				scene: seam.sceneKey,
				ready: seam.ready,
				seed: seam.seed,
				frameCount: seam.frameCount,
				zone: host.getZone(),
				bo: Object.freeze({ ...bo }),
				occupyMode: snap?.occupyMode ?? null,
				connCount: snap?.connections.length ?? 0,
				trafficRate: snap?.metering.trafficRate ?? 0,
				bootstrapActive: snap?.occupancy.bootstrapActive ?? false,
				sheetOpen: host.isSheetOpen(),
				sheetKind: host.sheetKind(),
				seq: snap?.seq ?? null,
				hazards: Object.freeze([...(snap?.doctor.hazards ?? [])]),
			});
		},
		commands: {
			reset: () => host.reset(),
			seed: (n: number) => {
				host.setSeed(n);
				seam.seed = n;
			},
			selectZone: (zone) => host.selectZone(zone),
			dismissSheet: () => host.dismissSheet(),
			runAction: (action) => host.runAction(action),
			advanceFrame: (dtMs = 16.67) => {
				host.advanceFrame(dtMs);
				seam.frameCount += 1;
			},
		},
	};
	return seam;
}

/** Mulberry32 seeded RNG for deterministic particle placement. */
export function seededRandom(seed: number): () => number {
	let t = seed >>> 0;
	return () => {
		t += 0x6d2b79f5;
		let r = Math.imul(t ^ (t >>> 15), 1 | t);
		r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

export function isTestMode(search = ""): {
	testMode: boolean;
	seed: number;
} {
	const params = new URLSearchParams(
		search.startsWith("?") ? search.slice(1) : search,
	);
	const testMode = params.has("test") || params.get("test") === "1";
	const seed = Number(params.get("seed") || "42");
	return { testMode, seed: Number.isFinite(seed) ? seed : 42 };
}
