import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReplayCorpus } from "./replay.js";

/**
 * Regeneration entrypoint for the committed replay corpus (S1-16):
 *   pnpm --filter @hobo/conformance run build-corpus
 *
 * Deterministic (seeded Clock + ULID), so re-running produces byte-identical
 * files. The corpus at `packages/conformance/corpus/replay/` is committed and
 * is the golden the replay conformance lane asserts against.
 */

export const CORPUS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../corpus/replay",
);

export function recordCorpus(targetDir = CORPUS_DIR): string[] {
	mkdirSync(targetDir, { recursive: true });
	const written: string[] = [];
	for (const corpus of buildReplayCorpus()) {
		const file = join(targetDir, `${corpus.id}.json`);
		writeFileSync(file, `${JSON.stringify(corpus, null, "\t")}\n`, "utf8");
		written.push(file);
	}
	return written;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	for (const file of recordCorpus()) {
		console.log(`wrote ${file}`);
	}
}
