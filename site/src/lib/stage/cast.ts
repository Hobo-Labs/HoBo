// ==========================================================================
// The cast: the hobits who are not Bo.
//
// Bo walks the trail; these are the travelers who turn up around him — on
// the trail when the page has been still a while, and poking out from behind
// the page's own boxes. Each is its own character with its own sheet, drawn
// for this and normalized by `media/scripts/build-trail-art.py` to one
// contract, so the machinery in ./troupe.ts never has to know who it is
// animating:
//
//   - one PNG per character in public/cast/, a grid of square cells;
//   - the same pose in the same cell on every sheet;
//   - feet on one baseline and the body on one centre column in every cell,
//     so a pose swap cannot make anyone bob or slide.
//
// The numbers are not written here. The build that packs the sheets also
// writes `public/cast/cast.json`, and this file reads it, so the geometry the
// page plays and the geometry on disk cannot drift apart. What *is* written
// here is casting: who is in the troupe, and how big each stands beside Bo.
//
// A character is listed only once its sheet has been reviewed and promoted
// (AGENTS.md, "Generated-art rules").
// ==========================================================================

import contract from "../../../public/cast/cast.json";
import type { Sheet } from "./sprite";

const POSE_NAMES = [
	"stand",
	"lookLeft",
	"lookRight",
	"blink",
	"wave",
	"startled",
	"doze",
	"walkA",
	"walkPass",
	"walkB",
	"run",
	"runB",
] as const;

type PoseName = (typeof POSE_NAMES)[number];

const cellOf = (name: PoseName): number => {
	const at = contract.poses.indexOf(name);
	if (at < 0) throw new Error(`cast: the sheets have no '${name}' pose`);
	return at;
};

/** Which cell holds which pose — identical on every cast sheet. */
export const POSE = {
	stand: cellOf("stand"),
	lookLeft: cellOf("lookLeft"),
	lookRight: cellOf("lookRight"),
	blink: cellOf("blink"),
	wave: cellOf("wave"),
	startled: cellOf("startled"),
	doze: cellOf("doze"),
	walkA: cellOf("walkA"),
	walkPass: cellOf("walkPass"),
	walkB: cellOf("walkB"),
	run: cellOf("run"),
	runB: cellOf("runB"),
} satisfies Record<PoseName, number>;

export type Member = {
	name: string;
	sheet: Sheet;
	/** Standing height relative to Bo's, so the troupe is not a row of clones. */
	stature: number;
	/**
	 * How far down the cell a peek reveals, from the top: far enough to clear
	 * the eyes. A cell is mostly air above the head, so this is well past half.
	 */
	peek: number;
	/** Ground covered per walk pose, as a fraction of standing height. */
	stride: number;
};

type Built = keyof typeof contract.members;

const member = (name: Built, stature: number, stride = 0.2): Member => ({
	name,
	sheet: {
		src: `/cast/${name}.png`,
		cols: contract.cols,
		rows: contract.rows,
		frameW: contract.cell,
		frameH: contract.cell,
		feet: contract.feet,
		cx: 0.5,
		body: contract.members[name].body,
	},
	stature,
	peek: contract.members[name].peek,
	stride,
});

export const CAST: readonly Member[] = [
	// Tuck: stout, in a patched bowler. About Bo's size.
	member("tuck", 0.96),
	// Pip: the small one, all scarf.
	member("pip", 0.76, 0.22),
	// Mags: tall and narrow under a newsboy cap.
	member("mags", 1.1, 0.18),
	// Cog: the wind-up one. Agents travel this road too.
	member("cog", 0.9),
];
