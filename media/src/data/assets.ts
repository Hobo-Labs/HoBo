/**
 * The art manifest.
 *
 * One record per asset, and the geometry that makes it playable — a sprite
 * sheet is useless as a flat image, so the catalogue animates from these
 * numbers rather than from a screenshot of the animation.
 *
 * The numbers are not decoration: they are copied from the consumers
 * (`site/src/components/BoIdle.astro`, `site/src/components/TrailStage.astro`)
 * and if they drift, the preview here stops matching what the site plays.
 */

export type Sheet = {
	key: string;
	title: string;
	file: string;
	/** Frame box in the sheet's own pixels. */
	frame: { w: number; h: number };
	/** Grid: columns x rows. A strip is `rows: 1`. */
	grid: { cols: number; rows: number };
	frames: number;
	/** Seconds per frame, as exported. */
	tick: number;
	note: string;
};

export const SPRITES: Sheet[] = [
	{
		key: "bo-walk",
		title: "Walk, east",
		file: "sprites/bo-walk.png",
		frame: { w: 160, h: 157 },
		grid: { cols: 6, rows: 6 },
		frames: 36,
		tick: 0.05,
		note: "Nine frames to a step, eighteen to a stride. The parallax band derives Bo's ground speed from this cadence, so it is not a free parameter.",
	},
	{
		key: "bo-walk-left",
		title: "Walk, west",
		file: "sprites/bo-walk-left.png",
		frame: { w: 160, h: 157 },
		grid: { cols: 6, rows: 6 },
		frames: 36,
		tick: 0.05,
		note: "A separate drawing, never a mirror of the east sheet. Bo is asymmetric: the bindle hangs from one specific arm, and flipping hands it to the other.",
	},
	{
		key: "bo-idle",
		title: "Idle — rest, hop, blink",
		file: "sprites/bo-idle.png",
		frame: { w: 207, h: 230 },
		grid: { cols: 12, rows: 1 },
		frames: 12,
		tick: 0.095,
		note: "Frame 0 rest, 1–10 a hop that lands back on rest, 11 blink. The three states are independent, so a clip can start or stop without a pop.",
	},
	{
		key: "bo-stand",
		title: "Stand — rest, breath, blink",
		file: "sprites/bo-stand.png",
		frame: { w: 207, h: 230 },
		grid: { cols: 12, rows: 1 },
		frames: 12,
		tick: 0.095,
		note: "Same contract as idle, different register: the cycle is a breath anchored at the feet, so he never leaves the ground. Rest and blink share identical alpha — 0 differing pixels.",
	},
];

/**
 * HoBit Bill's sheets, generated with the Spriterrific CLI.
 *
 * Kept apart from SPRITES on purpose: those are Bo's and the site ships them,
 * these are Bill's and ship nowhere. The grid is Spriterrific's own export
 * shape (256x256 cells) rather than the hand-packed strips Bo uses, which is
 * why the numbers look nothing alike.
 */
export const BILL_SPRITES: Sheet[] = [
	{
		key: "bill-walk",
		title: "Walk, west",
		file: "sprites/bill-walk.png",
		frame: { w: 256, h: 256 },
		grid: { cols: 5, rows: 2 },
		frames: 8,
		tick: 0.1,
		note: "Spriterrific, from Bill's own turnaround. Authored west (screen-left) with the bundle trailing behind him — generated that way, not flipped: --auto-orient is a mirror and was turned off, and the facing check returned ok/left at confidence 1.0.",
	},
];

/**
 * Bo's pixel reference sheets, built by `media/scripts/build-bo-pixel-reference.py`.
 *
 * Not generated art: every sprite is a deterministic downscale-and-quantize of
 * the shipped sheets in `site/public/parallax/`, so the identity — bindle arm,
 * eye spacing, fur silhouette — is inherited rather than re-drawn. 48px grid,
 * flat black and white on transparency. The one derived view (north) is the
 * front stand mirrored with enclosed whites inked out; front-to-back mirroring
 * keeps the bindle on the same anatomical shoulder, unlike the forbidden
 * east↔west mirror.
 */
export const BO_PIXEL_SHEETS: Reference[] = [
	{
		key: "bo-pixel-reference",
		title: "Pixel reference",
		file: "reference/bo-pixel-reference.png",
		wide: true,
		note: "Bo's model sheet on a 48px grid — a four-facing turnaround, six poses (sit, crouch, hop, wave, point, startled), seven expressions, and a scale-and-grounds ramp. Bodies come from the shipped sheets; poses are pixel surgery on those bases, so the pixel Bo cannot drift from the real one. A 1px dual rim (white against the fur, black against the bundle) keeps him readable on any ground.",
	},
	{
		key: "bo-pixel-sprites",
		title: "Pixel sprites, native scale",
		file: "reference/bo-pixel-sprites.png",
		note: "The same sprites at 1x in 56×56 cells, one section per row, feet on a shared baseline four pixels up. This is the file to build from; the labeled sheet above is for reading.",
	},
];

export type Plate = {
	key: string;
	title: string;
	file: string;
	speed: number;
	note: string;
};

/** Scenery, back to front. Speed is relative to the ground. */
export const PLATES: Plate[] = [
	{ key: "sky", title: "Sky", file: "plates/sky.png", speed: 0.12, note: "Furthest back. Clouds over a faint ridge, and mostly empty paper — the emptiness is the point." },
	{ key: "hills", title: "Hills", file: "plates/hills.png", speed: 0.4, note: "Distant horizon. Its flat base sits at scene unit 199, one unit above where the ground plane starts, so it reads as the horizon rather than floating." },
	{ key: "poles", title: "Telephone poles", file: "plates/poles.png", speed: 0.55, note: "Kept dark at night and given a rim instead of inverting — a creosote post is dark at noon and at midnight." },
	{ key: "trail", title: "Trail", file: "plates/trail.png", speed: 1, note: "The ground behind Bo." },
	{ key: "trail-front", title: "Trail, near bank", file: "plates/trail-front.png", speed: 1, note: "Passes in front of his feet." },
];

export type Reference = {
	key: string;
	title: string;
	file: string;
	note: string;
	wide?: boolean;
};

export const TURNAROUND: Reference[] = [
	{ key: "front", title: "Front", file: "reference/bill-turnaround-front.webp", note: "Bindle over one shoulder." },
	{ key: "quarter", title: "Three-quarter", file: "reference/bill-turnaround-quarter.webp", note: "Turned toward screen-right." },
	{ key: "side", title: "Side", file: "reference/bill-turnaround-side.webp", note: "The generator did not give a true profile here; treat it as a second front read." },
	{ key: "back", title: "Back", file: "reference/bill-turnaround-back.webp", note: "No eyes — silhouette only." },
];

export const SHEETS: Reference[] = [
	{
		key: "expressions",
		title: "Expressions",
		file: "reference/bill-expressions.webp",
		wide: true,
		note: "Sixteen faces on one identical body. Bill has no mouth and no nose, so the eyes and brow carry every reading — which is why this sheet exists at all.",
	},
	{
		key: "poses",
		title: "Poses",
		file: "reference/bill-poses.webp",
		wide: true,
		note: "Twelve whole-body poses at one scale. Reference for new sprite work: match the silhouette here before drawing frames.",
	},
	{
		key: "props",
		title: "Props",
		file: "reference/props.webp",
		wide: true,
		note: "The kit. Drawn as outline rather than solid fill, the same treatment the bindle bundle gets in the sprite sheets — props are objects, not soot.",
	},
];

/**
 * Two characters, and they are not the same one.
 *
 * `Bo` is the original: long-bodied, and the only one the site ships. Every
 * sheet in SPRITES is his.
 *
 * `HoBit Bill` came out of a turnaround generated from Bo's sheets — and came
 * out visibly *not Bo*: rounder, squatter, differently furred. That was a
 * failure of the generation, kept on purpose because the result was good, and
 * given his own name rather than being passed off as Bo or thrown away.
 * Everything under `reference/bill-*` and the 3D lift is Bill.
 *
 * They must not be mixed. A Bill pose is not a Bo reference, and generating
 * new Bo work from Bill's turnaround is how Bo stops being Bo.
 */
export const CHARACTERS = [
	{
		key: "bo",
		name: "Bo",
		tagline: "The bindlebug. Long-bodied, and the one the site ships.",
		note: "Every sprite sheet and scenery plate on hobo's site is Bo. His art is owned by site/public/parallax/.",
	},
	{
		key: "bill",
		name: "HoBit Bill",
		tagline: "Rounder, squatter, his own character.",
		note: "Born from a turnaround that drifted off Bo and landed somewhere better. Reference sheets and the 3D lift are his; he ships nowhere yet.",
	},
] as const;


/**
 * APPROVED scene props — owner-approved 2026-08-05, round 1.
 *
 * Generated from scratch in the ink register. They were once destined to
 * replace the five full-width scene illustrations on the homepage; those
 * panels have since been removed altogether, and these drawings stand on the
 * trail band instead, as the landmarks each homepage section arrives at.
 * `media/scripts/build-trail-art.py` cuts each one out of its paper into
 * `site/public/parallax/landmarks/`; these remain the originals.
 */
export const SCENE_PROPS: Reference[] = [
	{ key: "signpost", title: "Signpost", file: "reference/scene-props/signpost.webp", note: "→ landmark at the crossroads stop (“Two bad landlords, and the open road”)." },
	{ key: "train", title: "Locomotive", file: "reference/scene-props/train.webp", note: "→ landmark at the main-line stop (“Deployment is not a destination”)." },
	{ key: "depot", title: "Depot", file: "reference/scene-props/depot.webp", note: "→ landmark at the depot stop (“Four words for traveling light”)." },
	{ key: "blimp", title: "Blimp", file: "reference/scene-props/blimp.webp", note: "→ landmark at the airfield stop (the agents section). Floats at half ground speed and bobs." },
	{ key: "steamboat", title: "Steamboat", file: "reference/scene-props/steamboat.webp", note: "→ landmark at the river stop (the landscape table). Sits behind the path and rocks; the lettered “toot” is erased at build." },
];

/**
 * The cast: the hobits who are not Bo.
 *
 * Generated for the site's troupe (Higgsfield CLI, GPT Image 2.6, native
 * transparency), reviewed, and normalized by
 * `media/scripts/build-trail-art.py` to one contract — a 6×2 grid of 256px
 * cells with the same pose in the same cell on every sheet. These are **pose
 * sheets, not cycles**: the catalogue steps through all twelve cells so each
 * can be inspected, but the site plays them as poses with motion between.
 * Cells 1–3 (look left, look right, blink) are derived from cell 0 by moving
 * colour only, so the four share one silhouette exactly.
 */
const castSheet = (key: string, title: string, note: string): Sheet => ({
	key: `cast-${key}`,
	title,
	file: `cast/${key}.png`,
	frame: { w: 256, h: 256 },
	grid: { cols: 6, rows: 2 },
	frames: 12,
	tick: 0.7,
	note,
});

export const CAST_SHEETS: Sheet[] = [
	castSheet("tuck", "Tuck", "Stout, in a patched bowler. About Bo's size. His first board drifted — scalloped fur, hollow legs in the side views — and was regenerated with the fur and limbs locked."),
	castSheet("pip", "Pip", "The small one, all striped scarf and one curled tuft. Side views only ever face right; the scarf is why she is never mirrored."),
	castSheet("mags", "Mags", "Tall and narrow under a newsboy cap, polka-dot neckerchief at the throat."),
	castSheet("cog", "Cog", "The wind-up one: riveted tin, a visor for a face, a key in the back. Agents travel this road too. White tin, so he reads on a night page without a rim."),
];

/** The reviewed boards the cast sheets are cut from — stored as their two-ink reduction. */
export const CAST_BOARDS: Reference[] = ["tuck", "pip", "mags", "cog"].flatMap(
	(name): Reference[] => [
		{ key: `${name}-turnaround`, title: `${name[0]?.toUpperCase()}${name.slice(1)} — turnaround`, file: `reference/cast/${name}-turnaround.png`, note: "The design: front and right-facing side, one image so the two views agree. The pose board is generated from this." },
		{ key: `${name}-board`, title: `${name[0]?.toUpperCase()}${name.slice(1)} — pose board`, file: `reference/cast/${name}-board.png`, wide: true, note: "Eight poses in one image: stand, wave, startled, doze; walk ×3 and a run, heading right. One image keeps the character consistent across them." },
	],
);

/** Prop boards for the trail: one image per six props, cut apart at build. */
export const TRAIL_PROP_BOARDS: Reference[] = [
	{ key: "props-a", title: "Trail props A", file: "reference/trail-props/props-a.png", wide: true, note: "Mile marker and bindle, company-town gatehouse, fixer-upper shack, trunk and crates, tent and campfire, water tower." },
	{ key: "props-b", title: "Trail props B", file: "reference/trail-props/props-b.png", wide: true, note: "Switch stand, handcar, boom barrier and booth, radio mast and telegraph hut, lighthouse, cottage." },
	{ key: "props-c", title: "Trail props C", file: "reference/trail-props/props-c.png", wide: true, note: "Toolbox, drafting table, padlocked gate post, telephone switchboard, a row of rooftops, a timber arch." },
];
