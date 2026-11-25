import fs from "node:fs";

export type Night = "invert" | "keep" | "rim";

export type Tone = number;

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

function measure(file: URL, ext: string): { w: number; h: number } | null {
	const bytes = fs.readFileSync(file);
	if (ext === "png" && bytes.length > 24) {
		return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
	}
	if (ext === "gif" && bytes.length > 10) {
		return { w: bytes.readUInt16LE(6), h: bytes.readUInt16LE(8) };
	}
	if (ext === "jpg" || ext === "jpeg") {
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
	aspect: number;
};

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
				aspect: size && size.h > 0 ? size.w / size.h : 4,
			});
			break;
		}
	}
	return found;
}

export function emptySlots(): string[] {
	const filled = new Set(plates().map((p) => p.key));
	return PLATE_SLOTS.map((s) => s.key).filter((k) => !filled.has(k));
}
