import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const traceabilityPath = path.join(root, "docs", "design", "traceability.md");
const adrIndexPath = path.join(root, "docs", "design", "adr", "index.md");
const designIndexPath = path.join(root, "docs", "design", "index.md");

function read(relativeOrAbsolutePath: string) {
	return fs.readFileSync(relativeOrAbsolutePath, "utf8");
}

function fail(message: string) {
	console.error(message);
	process.exitCode = 1;
}

if (!fs.existsSync(traceabilityPath)) {
	fail("docs/design/traceability.md is missing");
	process.exit();
}

const traceability = read(traceabilityPath);
const adrIndex = read(adrIndexPath);
const designIndex = read(designIndexPath);

const adrIds = [...adrIndex.matchAll(/\|\s*(\d{4})\s*\|/g)].map(
	(match) => `ADR-${match[1]}`,
);
const uniqueAdrIds = [...new Set(adrIds)];
const adrNumbers = uniqueAdrIds.map((adrId) =>
	Number(adrId.slice("ADR-".length)),
);

for (const adrId of uniqueAdrIds) {
	if (!traceability.includes(adrId)) {
		fail(`${adrId} missing from traceability report`);
	}
}

const maxAdrNumber = Math.max(...adrNumbers);
const adrNumberSet = new Set(adrNumbers);
const missingAdrIds = [];

for (let adrNumber = 1; adrNumber <= maxAdrNumber; adrNumber += 1) {
	if (!adrNumberSet.has(adrNumber)) {
		missingAdrIds.push(`ADR-${String(adrNumber).padStart(4, "0")}`);
	}
}

for (const missingAdrId of missingAdrIds) {
	if (!traceability.includes(missingAdrId)) {
		fail(`${missingAdrId} numbering gap is not documented`);
	}
}

if (!traceability.includes("Accepted / current")) {
	fail("ADR status audit is missing the accepted/current status statement");
}

const planIds = [...designIndex.matchAll(/#plan-(\d{2})/g)].map(
	(match) => `PLAN-${match[1]}`,
);
const uniquePlanIds = [...new Set(planIds)];

for (const planId of uniquePlanIds) {
	if (!traceability.includes(planId)) {
		fail(`${planId} missing from traceability report`);
	}
}

const hoboRefs = traceability.match(/HOBO-\d+/g) ?? [];
if (hoboRefs.length < 50) {
	fail(
		`traceability report has too few Linear issue references (${hoboRefs.length})`,
	);
}

const relativeLinks = [
	...traceability.matchAll(
		/\]\((?!https?:\/\/|mailto:|#)([^)#]+\.md)(#[^)]+)?\)/g,
	),
].map((match) => match[1]!);

for (const link of relativeLinks) {
	const targetPath = path.resolve(path.dirname(traceabilityPath), link);
	if (!fs.existsSync(targetPath)) {
		fail(`broken traceability link: ${link}`);
	}
}

if (!process.exitCode) {
	console.log(
		`traceability ok: ${uniqueAdrIds.length} ADRs, ${missingAdrIds.length} documented gaps, ${uniquePlanIds.length} plans, ${hoboRefs.length} issue references`,
	);
}
