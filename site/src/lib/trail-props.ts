import fs from "node:fs";

// ==========================================================================
// The props that stand on the trail: one under each card of the landing page.
//
// A section of the landing page is a stop on the trail (see
// ../components/TrailStage.astro), and each of its cards names the prop that
// stands for it with `data-prop="<key>"`. On a desktop the prop stands in the
// band under its card; on a phone it stands beside the card's sign. Clicking
// one makes it say its word.
//
// Supplied artwork, cut out and normalized by `media/scripts/build-trail-art.py`
// into `public/parallax/landmarks/`. Nothing here is drawn. A prop whose file is
// missing simply does not render.
//
// `units` is the drawn height in tile units of the band's 300-unit scene, the
// unit Bo is measured in (he stands 128 tall). Props are scaled against him so
// a cottage is a cottage and a toolbox is a toolbox: big things stand big, and
// nothing is shrunk to fit a box.
// ==========================================================================

/** Every prop the page can use, with how tall it stands and what it says. */
const PROP_SPECS = [
	{ key: "company-gate", units: 300, say: "CLANG!" },
	{ key: "shack", units: 290, say: "CRASH" },
	{ key: "signpost", units: 200, say: "THIS WAY" },
	{ key: "trunk", units: 112, say: "THUD" },
	{ key: "tent", units: 180, say: "ZZZIP" },
	{ key: "train", units: 235, say: "TOOT TOOT" },
	{ key: "milestone", units: 100, say: "MILE 0" },
	{ key: "switch-stand", units: 150, say: "KA-CHUNK" },
	{ key: "depot", units: 300, say: "DING" },
	{ key: "drafting-table", units: 150, say: "SCRIBBLE" },
	{ key: "toolbox", units: 86, say: "CLANK" },
	{ key: "barrier", units: 215, say: "CLUNK" },
	{ key: "padlock-post", units: 150, say: "CLICK" },
	{ key: "switchboard", units: 180, say: "RING" },
	{ key: "radio-mast", units: 340, say: "BZZT" },
	{ key: "rooftops", units: 210, say: "KNOCK" },
	{ key: "cottage", units: 320, say: "HOME!" },
	// Cog's ride: not under a card, he rolls off on it.
	{ key: "handcar", units: 122, say: "SQUEAK" },
] as const;

export type PropKey = (typeof PROP_SPECS)[number]["key"];

export type Prop = {
	key: PropKey;
	units: number;
	say: string;
	file: string;
	/** Width over height, from the artwork itself, so a prop is never squashed. */
	aspect: number;
};

const DIR = new URL("../../public/parallax/landmarks/", import.meta.url);

/** Intrinsic size out of the PNG header, with no decoding. */
function pngAspect(file: URL): number {
	const bytes = fs.readFileSync(file);
	if (bytes.length < 24) return 1;
	const h = bytes.readUInt32BE(20);
	return h > 0 ? bytes.readUInt32BE(16) / h : 1;
}

/** Every prop whose artwork is present. */
export function props(): Prop[] {
	if (!fs.existsSync(DIR)) return [];
	const found: Prop[] = [];
	for (const spec of PROP_SPECS) {
		const file = new URL(`${spec.key}.png`, DIR);
		if (!fs.existsSync(file)) continue;
		found.push({ ...spec, file: `${spec.key}.png`, aspect: Math.round(pngAspect(file) * 1e4) / 1e4 });
	}
	return found;
}
