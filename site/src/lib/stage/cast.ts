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
//   - one PNG per character in public/cast/, a 6x2 grid of 192x192 cells;
//   - the same pose in the same cell on every sheet (POSE, below);
//   - feet on one baseline and the body centred on one column in every cell,
//     so a pose swap cannot make anyone bob or slide.
//
// A character is listed here only once its sheet has been reviewed and
// promoted (AGENTS.md, "Generated-art rules"). An empty list is a valid
// state: the troupe simply has nobody to send.
// ==========================================================================

import type { Sheet } from "./sprite";

/** Which cell holds which pose — identical on every cast sheet. */
export const POSE = {
	stand: 0,
	lookLeft: 1,
	lookRight: 2,
	blink: 3,
	wave: 4,
	startled: 5,
	doze: 6,
	walkA: 7,
	walkPass: 8,
	walkB: 9,
	run: 10,
	runB: 11,
} as const;

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

/** The geometry every cast sheet is normalized to. */
const sheet = (name: string): Sheet => ({
	src: `/cast/${name}.png`,
	cols: 6,
	rows: 2,
	frameW: 192,
	frameH: 192,
	feet: 0.94,
	cx: 0.5,
	body: 0.62,
});

const member = (name: string, stature: number, peek: number, stride = 0.2): Member => ({
	name,
	sheet: sheet(name),
	stature,
	peek,
	stride,
});

export const CAST: readonly Member[] = [];

// `member` is how a promoted sheet joins the cast; kept exported so adding
// one is a single line above and the helper is not dead code while it waits.
export { member };
