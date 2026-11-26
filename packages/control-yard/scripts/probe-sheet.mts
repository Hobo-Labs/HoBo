/**
 * Sheet probe — print measured PNG size and implied frame grid.
 * Usage: node --import tsx scripts/probe-sheet.mts [path]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ?? join(ROOT, "assets/bo/bo-walk.png");

const buf = readFileSync(target);
const width = buf.readUInt32BE(16);
const height = buf.readUInt32BE(20);
console.log(JSON.stringify({ path: target, width, height }, null, 2));

// Common grids for Bo
for (const [cols, rows] of [
	[6, 6],
	[12, 1],
	[8, 1],
] as const) {
	if (width % cols === 0 && height % rows === 0) {
		console.log(
			`grid ${cols}x${rows} → frame ${width / cols}x${height / rows}`,
		);
	}
}
