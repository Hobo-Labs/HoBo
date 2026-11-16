/**
 * Yard layout — single source of truth for zone coordinates and depths.
 * Star-Office-UI `layout.js` pattern: no magic numbers in scene logic.
 */

export const YARD_WIDTH = 1280;
export const YARD_HEIGHT = 720;

export type ZoneId =
	| "platformRest"
	| "bootstrapDesk"
	| "activeRailTrack"
	| "connectionBay"
	| "policyBoard"
	| "costBooth"
	| "errorBunker";

export type ZoneLayout = Readonly<{
	id: ZoneId;
	label: string;
	x: number;
	y: number;
	width: number;
	height: number;
	depth: number;
	/** Anchor for Bo walk target (feet). */
	anchorX: number;
	anchorY: number;
}>;

export type Layout = Readonly<{
	width: number;
	height: number;
	groundY: number;
	zones: Readonly<Record<ZoneId, ZoneLayout>>;
	depths: Readonly<{
		background: number;
		track: number;
		bay: number;
		characters: number;
		particles: number;
		ui: number;
		overlay: number;
	}>;
	speechBubble: Readonly<{ offsetY: number; maxWidth: number }>;
	costMeter: Readonly<{ x: number; y: number; width: number; height: number }>;
	trafficEmitter: Readonly<{ x: number; y: number; width: number }>;
}>;

const ZONES: Record<ZoneId, ZoneLayout> = {
	platformRest: {
		id: "platformRest",
		label: "Platform Rest",
		x: 80,
		y: 480,
		width: 220,
		height: 160,
		depth: 10,
		anchorX: 190,
		anchorY: 600,
	},
	bootstrapDesk: {
		id: "bootstrapDesk",
		label: "Bootstrap Desk",
		x: 340,
		y: 420,
		width: 180,
		height: 140,
		depth: 11,
		anchorX: 430,
		anchorY: 540,
	},
	activeRailTrack: {
		id: "activeRailTrack",
		label: "Active Rail Track",
		x: 120,
		y: 300,
		width: 1040,
		height: 80,
		depth: 5,
		anchorX: 640,
		anchorY: 360,
	},
	connectionBay: {
		id: "connectionBay",
		label: "Connection Bay",
		x: 900,
		y: 420,
		width: 280,
		height: 200,
		depth: 12,
		anchorX: 1040,
		anchorY: 580,
	},
	policyBoard: {
		id: "policyBoard",
		label: "Policy Board",
		x: 560,
		y: 120,
		width: 320,
		height: 140,
		depth: 8,
		anchorX: 720,
		anchorY: 250,
	},
	costBooth: {
		id: "costBooth",
		label: "Cost Booth",
		x: 1000,
		y: 120,
		width: 200,
		height: 140,
		depth: 9,
		anchorX: 1100,
		anchorY: 250,
	},
	errorBunker: {
		id: "errorBunker",
		label: "Error Bunker",
		x: 40,
		y: 100,
		width: 200,
		height: 140,
		depth: 9,
		anchorX: 140,
		anchorY: 230,
	},
};

export const YARD_LAYOUT: Layout = Object.freeze({
	width: YARD_WIDTH,
	height: YARD_HEIGHT,
	groundY: 620,
	zones: Object.freeze({ ...ZONES }),
	depths: Object.freeze({
		background: 0,
		track: 5,
		bay: 12,
		characters: 20,
		particles: 25,
		ui: 40,
		overlay: 50,
	}),
	speechBubble: Object.freeze({ offsetY: -90, maxWidth: 220 }),
	costMeter: Object.freeze({ x: 1020, y: 150, width: 160, height: 18 }),
	trafficEmitter: Object.freeze({ x: 140, y: 330, width: 1000 }),
});

export function zoneAt(x: number, y: number): ZoneId | null {
	for (const zone of Object.values(YARD_LAYOUT.zones)) {
		if (
			x >= zone.x &&
			x <= zone.x + zone.width &&
			y >= zone.y &&
			y <= zone.y + zone.height
		) {
			return zone.id;
		}
	}
	return null;
}

export function zoneAnchor(id: ZoneId): { x: number; y: number } {
	const z = YARD_LAYOUT.zones[id];
	return { x: z.anchorX, y: z.anchorY };
}
