import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPatternCatalog } from "../src/catalog.js";
import { evaluatePatternRetrieval, parseEvalCases } from "../src/validate.js";
import { buildHoboVocabulary } from "../src/vocabulary.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = parseEvalCases(
	readFileSync(join(root, "evals", "cases.jsonl"), "utf8"),
);
const expected = JSON.parse(
	readFileSync(join(root, "evals", "expected-metrics.json"), "utf8"),
) as {
	recallAt1: number;
	recallAt3: number;
	abstainPrecision: number;
};
const catalog = loadPatternCatalog({ root: join(root, "patterns") });
const vocabulary = buildHoboVocabulary({
	aliasPath: join(root, "vocabulary", "aliases.json"),
});
const report = evaluatePatternRetrieval({ catalog, vocabulary, cases });
process.stdout.write(`${JSON.stringify(report, null, "\t")}\n`);
const failed =
	report.recallAt1 < expected.recallAt1 ||
	report.recallAt3 < expected.recallAt3 ||
	report.abstainPrecision < expected.abstainPrecision;
if (failed) {
	process.stderr.write(
		`eval below threshold: recallAt1=${report.recallAt1} (need ${expected.recallAt1}) recallAt3=${report.recallAt3} (need ${expected.recallAt3}) abstainPrecision=${report.abstainPrecision} (need ${expected.abstainPrecision})\n`,
	);
	process.exit(1);
}
