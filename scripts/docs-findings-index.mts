import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FINDINGS_INDEX_START = "<!-- findings-index:start -->";
export const FINDINGS_INDEX_END = "<!-- findings-index:end -->";

const FINDING_FILE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u;
const FINDING_HEADING = /^# Finding (\d+): (.+)$/u;
const INDEX_ROW = /^- \[Finding (\d+): (.+)\]\((\.\/findings\/[^)]+)\)$/u;

type Finding = {
	number: number;
	paddedNumber: string;
	title: string;
	fileName: string;
};

type ReadFindingsResult = {
	findings: Finding[];
	errors: string[];
};

export type FindingsIndexReport = {
	errors: string[];
	notices: string[];
	indexed: number;
	total: number;
};

export function findingSlug(title: string): string {
	return title
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/gu, "")
		.toLowerCase()
		.replace(/['’]/gu, "")
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-|-$/gu, "");
}

function markerRange(
	document: string,
	errors: string[],
): [number, number] | undefined {
	const start = document.indexOf(FINDINGS_INDEX_START);
	const end = document.indexOf(FINDINGS_INDEX_END);
	if (
		start < 0 ||
		end < 0 ||
		end < start ||
		document.indexOf(FINDINGS_INDEX_START, start + 1) >= 0 ||
		document.indexOf(FINDINGS_INDEX_END, end + 1) >= 0
	) {
		errors.push(
			"docs/ci/performance.md must contain exactly one ordered findings-index marker pair",
		);
		return undefined;
	}
	return [start, end + FINDINGS_INDEX_END.length];
}

function readFindings(root: string): ReadFindingsResult {
	const findingsDirectory = path.join(root, "docs/ci/findings");
	const findings: Finding[] = [];
	const errors: string[] = [];
	const numbers = new Map<number, string>();
	let entries;
	try {
		entries = readdirSync(findingsDirectory, { withFileTypes: true });
	} catch {
		return {
			findings,
			errors: ["docs/ci/findings/ must exist and be readable"],
		};
	}

	for (const entry of entries) {
		if (
			!entry.isFile() ||
			!entry.name.endsWith(".md") ||
			entry.name === "index.md"
		)
			continue;
		const fileName = entry.name;
		const nameMatch = FINDING_FILE.exec(fileName);
		if (!nameMatch) {
			errors.push(
				`docs/ci/findings/${fileName}: expected NNNN-lowercase-ascii-slug.md`,
			);
			continue;
		}
		const [, paddedNumber = "", slug = ""] = nameMatch;
		const number = Number(paddedNumber);
		if (number === 0) {
			errors.push(
				`docs/ci/findings/${fileName}: finding numbers start at 0001`,
			);
			continue;
		}
		const previous = numbers.get(number);
		if (previous) {
			errors.push(
				`docs/ci/findings/${fileName}: finding ${paddedNumber} is also used by ${previous}`,
			);
			continue;
		}
		numbers.set(number, fileName);

		const document = readFileSync(
			path.join(findingsDirectory, fileName),
			"utf8",
		);
		const levelOneHeadings = document
			.split(/\r?\n/u)
			.filter((line) => line.startsWith("# "));
		const [levelOneHeading] = levelOneHeadings;
		if (levelOneHeadings.length !== 1 || !levelOneHeading) {
			errors.push(
				`docs/ci/findings/${fileName}: expected exactly one level-one heading`,
			);
			continue;
		}
		const heading = FINDING_HEADING.exec(levelOneHeading);
		if (!heading) {
			errors.push(
				`docs/ci/findings/${fileName}: expected '# Finding N: title'`,
			);
			continue;
		}
		const [, headingNumber = "", title = ""] = heading;
		if (headingNumber !== String(number)) {
			errors.push(
				`docs/ci/findings/${fileName}: heading number ${headingNumber} does not match file number ${number}`,
			);
		}
		if (findingSlug(title) !== slug) {
			errors.push(
				`docs/ci/findings/${fileName}: slug does not match heading title`,
			);
		}
		findings.push({ number, paddedNumber, title, fileName });
	}

	findings.sort((left, right) => left.number - right.number);
	return { findings, errors };
}

function indexRow(finding: Finding): string {
	return `- [Finding ${finding.number}: ${finding.title}](./findings/${finding.fileName})`;
}

export function updateFindingsIndex(
	root: string,
	check: boolean,
): FindingsIndexReport {
	const { findings, errors } = readFindings(root);
	const performancePath = path.join(root, "docs/ci/performance.md");
	const performance = readFileSync(performancePath, "utf8");
	const range = markerRange(performance, errors);
	const notices: string[] = [];
	let indexed = 0;

	if (range) {
		if (check) {
			const rows = performance
				.slice(
					performance.indexOf(FINDINGS_INDEX_START) +
						FINDINGS_INDEX_START.length,
					performance.indexOf(FINDINGS_INDEX_END),
				)
				.split(/\r?\n/u)
				.filter((line) => line.length > 0);
			const indexedNumbers = new Set<number>();
			let previousNumber = 0;
			for (const row of rows) {
				const match = INDEX_ROW.exec(row);
				if (!match) {
					errors.push(
						`docs/ci/performance.md: malformed generated index row: ${row}`,
					);
					continue;
				}
				const number = Number(match[1]);
				const finding = findings.find(
					(candidate) => candidate.number === number,
				);
				if (!finding) {
					errors.push(
						`docs/ci/performance.md: index link does not resolve to a finding: ${match[3]}`,
					);
					continue;
				}
				if (indexedNumbers.has(number)) {
					errors.push(
						`docs/ci/performance.md: duplicate index row for finding ${number}`,
					);
					continue;
				}
				indexedNumbers.add(number);
				indexed += 1;
				if (number <= previousNumber) {
					errors.push(
						"docs/ci/performance.md: generated index rows must be sorted",
					);
				}
				previousNumber = number;
				if (row !== indexRow(finding)) {
					errors.push(
						`docs/ci/performance.md: index row does not match docs/ci/findings/${finding.fileName}`,
					);
				}
			}
			for (const finding of findings) {
				if (!indexedNumbers.has(finding.number)) {
					notices.push(
						`Finding ${finding.paddedNumber} (${finding.fileName}) is not indexed yet; regenerate with pnpm run docs:findings when docs/ci/performance.md is next updated.`,
					);
				}
			}
		} else {
			const block = [
				FINDINGS_INDEX_START,
				...findings.map(indexRow),
				FINDINGS_INDEX_END,
			].join("\n");
			writeFileSync(
				performancePath,
				performance.slice(0, range[0]) + block + performance.slice(range[1]),
			);
			indexed = findings.length;
		}
	}

	return { errors, notices, indexed, total: findings.length };
}

function main() {
	const args = process.argv.slice(2).filter((argument) => argument !== "--");
	if (args.some((argument) => argument !== "--check")) {
		console.error("Usage: pnpm run docs:findings [-- --check]");
		process.exitCode = 1;
		return;
	}
	const check = args.includes("--check");
	const root = path.resolve(import.meta.dirname, "..");
	const report = updateFindingsIndex(root, check);
	for (const notice of report.notices) console.log(`NOTICE: ${notice}`);
	for (const error of report.errors) console.error(`ERROR: ${error}`);
	if (report.errors.length > 0) {
		process.exitCode = 1;
		return;
	}
	console.log(
		check
			? `Findings index check passed: ${report.indexed} indexed, ${report.total - report.indexed} unindexed (notice only).`
			: `Findings index updated: ${report.indexed} findings.`,
	);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main();
}
