import fs from "node:fs";

import type { Night, Tone } from "./trail-plates";
import type { TrailStop } from "./trail-stops";

// ==========================================================================
// What stands beside the trail, and which part of the page it belongs to.
//
// A plate loops forever; a landmark is somewhere. Each one is tied to a stop
// (see ./trail-stops.ts) and placed relative to that stop's mark — the spot
// where Bo is standing when the section's heading reaches the reading line —
// so the props for a section are composed as a group and arrive together.
//
// Like every other piece of scenery these are supplied artwork, cut out and
// normalized by `media/scripts/build-trail-art.py` into
// `public/parallax/landmarks/`. Nothing here is drawn. A landmark whose file
// is missing simply does not render, the same rule the plate slots follow.
//
// All measurements are in tile units of the band's 300-unit scene:
//
//   along  how far through its section it stands, 0 to 1: 0 is beside Bo as
//          the section's heading reaches the reading line, 1 is where the
//          next section begins. A fraction rather than a distance, because a
//          section is a different length on every screen and its props
//          should be spread through it on all of them
//   h      drawn height; width follows the artwork's own aspect
//   base   the scene row its bottom edge rests on. The path runs 210-257 and
//          Bo's feet land on 268, so 250-260 is "beside the path, behind him"
//   speed  parallax speed, ground = 1. Anything not standing on the ground
//          plane goes slower, exactly as the plates do
//   order  depth, on the same scale as the plates: hills 30, poles 40,
//          wires 50, the path 60, Bo above that, the near bank 80
// ==========================================================================

export type Landmark = {
	key: string;
	stop: TrailStop;
	along: number;
	h: number;
	base: number;
	speed: number;
	order: number;
	night: Night;
	tone: Tone;
	/** How it idles: a prop that floats bobs, one that is planted does not. */
	idle?: "bob" | "sway" | "puff";
};

// Three depths. Roadside props stand on the near side of the path, just
// behind Bo. Background props sit across the path at the foot of the hills,
// smaller and slower, so a section can hold a building without it crowding
// him. One thing flies.
const ROAD = { base: 258, speed: 1, order: 65, night: "invert", tone: 0.96 } as const;
const BACK = { base: 214, speed: 0.78, order: 45, night: "invert", tone: 0.8 } as const;

// Placed in the order the page reads, each section's props spread through
// its own stretch of trail.
const PLACED: Landmark[] = [
	// "Pack your bindle and hitch a ride" — where the road starts.
	{ key: "milestone", stop: "trailhead", along: 0.14, h: 78, ...ROAD },
	{ key: "arch", stop: "trailhead", along: 0.62, h: 150, ...ROAD },

	// "Two bad landlords, and the open road" — the company town, the
	// fixer-upper, and the way out.
	{ key: "company-gate", stop: "crossroads", along: 0.08, h: 118, ...BACK },
	{ key: "shack", stop: "crossroads", along: 0.42, h: 132, ...ROAD },
	{ key: "signpost", stop: "crossroads", along: 0.78, h: 150, ...ROAD },

	// "Deployment is not a destination" — pack, settle, ride.
	{ key: "trunk", stop: "rails", along: 0.08, h: 84, ...ROAD },
	{ key: "tent", stop: "rails", along: 0.36, h: 104, ...ROAD },
	{ key: "train", stop: "rails", along: 0.68, h: 124, ...ROAD, idle: "puff" },
	{ key: "water-tower", stop: "rails", along: 0.9, h: 132, ...BACK },

	// "Four words for traveling light" — yard, junction, station.
	{ key: "handcar", stop: "depot", along: 0.1, h: 96, ...ROAD },
	{ key: "switch-stand", stop: "depot", along: 0.4, h: 116, ...ROAD },
	{ key: "depot", stop: "depot", along: 0.72, h: 158, ...ROAD },

	// "Who writes what" — the developer's tools, the platform engineer's
	// plans, and the gate policy is enforced at.
	{ key: "toolbox", stop: "crew", along: 0.06, h: 74, ...ROAD },
	{ key: "drafting-table", stop: "crew", along: 0.32, h: 108, ...ROAD },
	{ key: "barrier", stop: "crew", along: 0.6, h: 120, ...ROAD },
	{ key: "padlock-post", stop: "crew", along: 0.86, h: 112, ...ROAD },

	// "Built for humans, and the agents that work for them" — the wires
	// agents talk over, and the airship overhead.
	{ key: "switchboard", stop: "airfield", along: 0.1, h: 118, ...ROAD },
	{ key: "blimp", stop: "airfield", along: 0.4, h: 96, base: 118, speed: 0.5, order: 25, night: "invert", tone: 0.7, idle: "bob" },
	{ key: "radio-mast", stop: "airfield", along: 0.7, h: 150, ...ROAD },

	// "Other roofs over your head" — everyone else's.
	{ key: "rooftops", stop: "river", along: 0.1, h: 92, ...BACK },
	{ key: "steamboat", stop: "river", along: 0.45, h: 112, base: 216, speed: 0.8, order: 55, night: "invert", tone: 0.86, idle: "sway" },
	{ key: "lighthouse", stop: "river", along: 0.8, h: 128, ...BACK },

	// "Ready to hit the rails?" — home.
	{ key: "cottage", stop: "home", along: 0.35, h: 136, ...ROAD },
];

const DIR = new URL("../../public/parallax/landmarks/", import.meta.url);

/** Intrinsic size out of the PNG header — no decoding needed. */
function pngSize(file: URL): { w: number; h: number } | null {
	const bytes = fs.readFileSync(file);
	if (bytes.length < 24) return null;
	return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

export type PlacedLandmark = Landmark & {
	file: string;
	/** Drawn width, from the artwork's own aspect so it is never squashed. */
	w: number;
};

/** Every placed landmark whose artwork is actually present, back to front. */
export function landmarks(): PlacedLandmark[] {
	if (!fs.existsSync(DIR)) return [];
	const found: PlacedLandmark[] = [];
	for (const spot of PLACED) {
		const file = new URL(`${spot.key}.png`, DIR);
		if (!fs.existsSync(file)) continue;
		const size = pngSize(file);
		const aspect = size && size.h > 0 ? size.w / size.h : 1;
		found.push({ ...spot, file: `${spot.key}.png`, w: Math.round(spot.h * aspect * 100) / 100 });
	}
	return found.sort((a, b) => a.order - b.order);
}
