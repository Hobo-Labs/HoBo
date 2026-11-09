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
//   at     where its centre sits relative to the stop's mark; positive is
//          further along the trail (screen-right)
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
	at: number;
	h: number;
	base: number;
	speed: number;
	order: number;
	night: Night;
	tone: Tone;
	/** How it idles: a prop that floats bobs, one that is planted does not. */
	idle?: "bob" | "sway" | "puff";
};

const PLACED: Landmark[] = [
	{ key: "signpost", stop: "crossroads", at: 150, h: 150, base: 258, speed: 1, order: 65, night: "invert", tone: 0.96 },
	{ key: "train", stop: "rails", at: 190, h: 124, base: 258, speed: 1, order: 65, night: "invert", tone: 0.96, idle: "puff" },
	{ key: "depot", stop: "depot", at: 170, h: 158, base: 258, speed: 1, order: 65, night: "invert", tone: 0.96 },
	{ key: "blimp", stop: "airfield", at: 120, h: 96, base: 118, speed: 0.5, order: 25, night: "invert", tone: 0.7, idle: "bob" },
	{ key: "steamboat", stop: "river", at: 200, h: 112, base: 216, speed: 0.8, order: 55, night: "invert", tone: 0.86, idle: "sway" },
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
