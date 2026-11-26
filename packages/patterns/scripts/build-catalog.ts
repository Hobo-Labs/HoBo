import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPatternCatalog } from "../src/catalog.js";
import { canonicalJson } from "../src/parse.js";
import { validatePatternCatalog } from "../src/validate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = loadPatternCatalog({ root: join(root, "patterns") });
const report = validatePatternCatalog({ catalog });
if (!report.ok) {
	throw new Error(`catalog invalid:\n${report.issues.join("\n")}`);
}
const outDir = join(root, "dist", "assets");
mkdirSync(outDir, { recursive: true });
writeFileSync(
	join(outDir, "catalog.json"),
	canonicalJson({
		digest: catalog.digest,
		count: catalog.patterns.length,
		ids: catalog.patterns.map((item) => item.id),
	}),
);
process.stdout.write(`catalog ${catalog.patterns.length} ${catalog.digest}\n`);
