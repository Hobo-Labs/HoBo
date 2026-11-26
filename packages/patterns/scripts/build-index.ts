import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPatternCatalog } from "../src/catalog.js";
import { buildPatternIndex } from "../src/sqlite-index.js";
import { buildHoboVocabulary } from "../src/vocabulary.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = loadPatternCatalog({ root: join(root, "patterns") });
const vocabulary = buildHoboVocabulary({
	aliasPath: join(root, "vocabulary", "aliases.json"),
});
const out = join(root, "dist", "assets", "patterns.sqlite");
mkdirSync(dirname(out), { recursive: true });
const receipt = buildPatternIndex({ catalog, vocabulary, path: out });
process.stdout.write(
	`index ${receipt.patternCount} patterns fts=${receipt.ftsAvailable} → ${out}\n`,
);
