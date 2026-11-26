import fs from "node:fs";

// ==========================================================================
// Supplied artwork. Anything dropped into public/parallax/plates/ becomes a
// layer of the trail band: the file is tiled along x and scrolled at the
// speed named here, at its own aspect ratio, so nothing is squashed.
//
// The slot name is the file name. `plates/clouds.png` fills the cloud layer,
// `plates/sky.png` the distant one, and so on. An empty slot renders nothing,
// so the band is whatever artwork is present.
//
// A plate must repeat cleanly left-to-right; the band tiles it, it does not
// mirror or blend the join. The whole image height maps onto the band height,
// so a plate is composed on a full-height canvas with its content at the
// scene position it belongs at, rather than cropped to its own content.
// ==========================================================================

/**
 * How a plate becomes its night self. The band is achromatic, so this is the
 * whole of theming — but it is per-slot, because one rule does not fit
 * everything the scene is made of:
 *
 * - `invert` — ink and paper swap. Right for line art that reads as drawing:
 *   the ground is black on white by day and white on black by night.
 * - `keep` — untouched. Right for anything whose colour is the subject
 *   rather than its ink. A cloud is white because clouds are white; invert it
 *   and it becomes a hole in the sky.
 * - `rim` — kept dark and given a light outline, the same treatment Bo gets.
 *   Right for solid silhouettes that should stay solid: a telephone pole is a
 *   creosote post at noon and at midnight, picked out against the dark.
 */
export type Night = "invert" | "keep" | "rim";

/**
 * How bright a layer is after dark, 0 to 1. This is aerial perspective: by day
 * the paper is behind everything and distance reads as detail falling away, but
 * at night distance reads as light falling away, so the far layers have to be
 * knocked back or the scene flattens into one sheet of white. It tracks the
 * parallax speed, because that is what depth *is* here — the slower a layer
 * goes past, the further away it is, and the dimmer it should be.
 */
export type Tone = number;

/**
 * Every slot, back to front. `order` is depth; `front` marks the ones that go
 * on Bo's side of the sprite, so the nearest grass passes in front of his feet.
 */
export const PLATE_SLOTS = [
	{ key: "sky", speed: 0.12, opacity: 0.55, order: 10, front: false, night: "invert", tone: 0.42 },
	{ key: "hills", speed: 0.4, opacity: 0.7, order: 30, front: false, night: "invert", tone: 0.62 },
	{ key: "poles", speed: 0.55, opacity: 1, order: 40, front: false, night: "rim", tone: 0.74 },
	{ key: "trail", speed: 1, opacity: 1, order: 60, front: false, night: "invert", tone: 0.94 },
	{ key: "trail-front", speed: 1, opacity: 1, order: 80, front: true, night: "invert", tone: 1 },
] as const satisfies ReadonlyArray<{
	key: string;
	speed: number;
	opacity: number;
	order: number;
	front: boolean;
	night: Night;
	tone: Tone;
}>;

export type PlateSlot = (typeof PLATE_SLOTS)[number]["key"];

const DIR = new URL("../../public/parallax/plates/", import.meta.url);
const EXTENSIONS = ["png", "webp", "avif", "jpg", "jpeg", "gif", "svg"];

/** Intrinsic size, straight out of the file header — no decoding needed. */
function measure(file: URL, ext: string): { w: number; h: number } | null {
	const bytes = fs.readFileSync(file);
	if (ext === "png" && bytes.length > 24) {
		return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
	}
	if (ext === "gif" && bytes.length > 10) {
		return { w: bytes.readUInt16LE(6), h: bytes.readUInt16LE(8) };
	}
	if (ext === "jpg" || ext === "jpeg") {
		// Walk the segment chain to the frame header that carries the size.
		let i = 2;
		while (i + 9 < bytes.length && bytes[i] === 0xff) {
			const marker = bytes[i + 1];
			const length = bytes.readUInt16BE(i + 2);
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
				return { w: bytes.readUInt16BE(i + 7), h: bytes.readUInt16BE(i + 5) };
			}
			i += 2 + length;
		}
		return null;
	}
	if (ext === "svg" || ext === "webp" || ext === "avif") {
		const head = bytes.subarray(0, 2048).toString("utf8");
		const box = /viewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/.exec(head);
		if (box) return { w: Number(box[1]), h: Number(box[2]) };
		return null;
	}
	return null;
}

export type Plate = {
	key: string;
	speed: number;
	opacity: number;
	order: number;
	front: boolean;
	night: Night;
	tone: Tone;
	file: string;
	/** Tile width as a multiple of the band height, so the aspect holds. */
	aspect: number;
};

/**
 * Every plate actually present, in back-to-front order. Absent slots simply
 * do not render — the band is whatever artwork is there plus what it draws.
 */
export function plates(): Plate[] {
	if (!fs.existsSync(DIR)) return [];
	const found: Plate[] = [];
	for (const slot of PLATE_SLOTS) {
		for (const ext of EXTENSIONS) {
			const file = new URL(`${slot.key}.${ext}`, DIR);
			if (!fs.existsSync(file)) continue;
			const size = measure(file, ext);
			found.push({
				...slot,
				file: `${slot.key}.${ext}`,
				// A plate whose size cannot be read is assumed 4:1, the shape the
				// tile geometry itself uses.
				aspect: size && size.h > 0 ? size.w / size.h : 4,
			});
			break;
		}
	}
	return found;
}

/** Slots a plate could fill but nothing has been dropped into yet. */
export function emptySlots(): string[] {
	const filled = new Set(plates().map((p) => p.key));
	return PLATE_SLOTS.map((s) => s.key).filter((k) => !filled.has(k));
}
