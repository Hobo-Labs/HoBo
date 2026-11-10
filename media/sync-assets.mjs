#!/usr/bin/env node
/**
 * Copy the shipped art in from site/ before every build.
 *
 * This used to be a one-off manual copy, and it went stale immediately: the
 * catalogue kept showing the old sky, poles and trail for a whole round of
 * fixes while claiming to be the place you look at the art. A catalogue that
 * can disagree with the product is worse than no catalogue.
 *
 * site/ stays the owner — it is what the live site loads. This only mirrors.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "site", "public", "parallax");
const DEST = join(HERE, "public");

const jobs = [
	{ from: join(SRC, "plates"), to: join(DEST, "plates"), pick: (f) => f.endsWith(".png") },
	{ from: join(SRC, "clouds"), to: join(DEST, "clouds"), pick: (f) => f.endsWith(".png") },
	{ from: SRC, to: join(DEST, "sprites"), pick: (f) => /^bo-.*\.png$/.test(f) },
	// What stands beside the trail, and the hobits who are not Bo.
	{ from: join(SRC, "landmarks"), to: join(DEST, "landmarks"), pick: (f) => f.endsWith(".png") },
	{ from: join(SRC, "..", "cast"), to: join(DEST, "cast"), pick: (f) => f.endsWith(".png") },
];

let n = 0;
for (const j of jobs) {
	rmSync(j.to, { recursive: true, force: true });
	mkdirSync(j.to, { recursive: true });
	for (const f of readdirSync(j.from)) {
		const p = join(j.from, f);
		if (!statSync(p).isFile() || !j.pick(f)) continue;
		cpSync(p, join(j.to, f));
		n++;
	}
}
console.log(`synced ${n} shipped assets from site/public/parallax`);
