/**
 * Asset index ↔ disk coverage + measured frame dimension check.
 * STOP rule: measure PNG before trusting load.spritesheet config.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets");
const INDEX_PATH = join(ASSETS, "assets_index.json");

type Sheet = {
	id: string;
	path: string;
	frameWidth: number;
	frameHeight: number;
	columns: number;
	rows: number;
	margin: number;
	spacing: number;
	neverMirrorFrom?: string;
	animations: Record<string, { frames: number[] | "all"; id: string }>;
};

function readPngSize(path: string): { width: number; height: number } {
	const buf = readFileSync(path);
	// PNG IHDR: signature 8 + len 4 + "IHDR" 4 + width/height big-endian
	assert.equal(buf.toString("ascii", 1, 4), "PNG");
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	return { width, height };
}

const index = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as {
	meta?: { root?: string };
	spritesheets: Record<string, Sheet>;
	images?: Record<string, { path: string; width?: number; height?: number }>;
	backgrounds?: Record<string, { path: string }>;
	animationIds: Record<string, { sheet: string; animation: string }>;
};

let errors = 0;
function fail(msg: string) {
	console.error(`FAIL: ${msg}`);
	errors += 1;
}

for (const [id, sheet] of Object.entries(index.spritesheets)) {
	const abs = join(ASSETS, sheet.path);
	if (!existsSync(abs)) {
		fail(`sheet ${id} missing file ${sheet.path}`);
		continue;
	}
	const { width, height } = readPngSize(abs);
	const expectedW =
		sheet.columns * sheet.frameWidth +
		sheet.margin * 2 +
		sheet.spacing * Math.max(0, sheet.columns - 1);
	const expectedH =
		sheet.rows * sheet.frameHeight +
		sheet.margin * 2 +
		sheet.spacing * Math.max(0, sheet.rows - 1);
	if (width !== expectedW || height !== expectedH) {
		fail(
			`sheet ${id} measured ${width}x${height} != expected ${expectedW}x${expectedH} from grid ${sheet.columns}x${sheet.rows} @ ${sheet.frameWidth}x${sheet.frameHeight}`,
		);
	} else {
		console.log(
			`OK  sheet ${id}: ${width}x${height} = ${sheet.columns}x${sheet.rows} @ ${sheet.frameWidth}x${sheet.frameHeight}`,
		);
	}
	const frameN = sheet.columns * sheet.rows;
	for (const anim of Object.values(sheet.animations)) {
		if (anim.frames === "all") continue;
		for (const f of anim.frames) {
			if (f < 0 || f >= frameN) {
				fail(`sheet ${id} anim ${anim.id} frame ${f} OOB 0..${frameN - 1}`);
			}
		}
	}
}

// West sheet must not be a mirror of east — both files must exist distinctly.
const east = index.spritesheets["bo-walk-east"];
const west = index.spritesheets["bo-walk-west"];
if (east && west) {
	if (west.neverMirrorFrom !== "bo-walk-east") {
		fail("bo-walk-west must declare neverMirrorFrom: bo-walk-east");
	}
	const eastBuf = readFileSync(join(ASSETS, east.path));
	const westBuf = readFileSync(join(ASSETS, west.path));
	if (eastBuf.equals(westBuf)) {
		fail("west walk sheet is byte-identical to east — forbidden mirror");
	} else {
		console.log("OK  west walk sheet is not a byte-mirror of east");
	}
}

for (const [id, img] of Object.entries(index.images ?? {})) {
	const abs = join(ASSETS, img.path);
	if (!existsSync(abs)) fail(`image ${id} missing ${img.path}`);
	else console.log(`OK  image ${id}`);
}
for (const [id, img] of Object.entries(index.backgrounds ?? {})) {
	const abs = join(ASSETS, img.path);
	if (!existsSync(abs)) fail(`background ${id} missing ${img.path}`);
	else console.log(`OK  background ${id}`);
}

for (const [animId, ref] of Object.entries(index.animationIds)) {
	const sheet = index.spritesheets[ref.sheet];
	if (!sheet) fail(`animationIds ${animId} unknown sheet ${ref.sheet}`);
	else if (!sheet.animations[ref.animation]) {
		fail(
			`animationIds ${animId} missing anim ${ref.animation} on ${ref.sheet}`,
		);
	}
}

if (errors > 0) {
	console.error(`\n${errors} asset validation error(s)`);
	process.exit(1);
}
console.log("\nassets:validate passed");
