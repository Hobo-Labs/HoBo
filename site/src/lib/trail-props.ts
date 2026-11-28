import fs from "node:fs";

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
	{ key: "handcar", units: 122, say: "SQUEAK" },
] as const;

export type PropKey = (typeof PROP_SPECS)[number]["key"];

export type Prop = {
	key: PropKey;
	units: number;
	say: string;
	file: string;
	aspect: number;
};

const DIR = new URL("../../public/parallax/landmarks/", import.meta.url);

function pngAspect(file: URL): number {
	const bytes = fs.readFileSync(file);
	if (bytes.length < 24) return 1;
	const h = bytes.readUInt32BE(20);
	return h > 0 ? bytes.readUInt32BE(16) / h : 1;
}

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
