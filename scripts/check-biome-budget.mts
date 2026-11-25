/**
 * Lint ratchet: the repo's biome findings may fall, never rise.
 *
 * The repo carries a standing backlog of biome findings — the kind that
 * accumulate when a lint gate is package-scoped and nobody looks at the whole
 * tree. Clearing all of them in one sweep would bury every reviewable diff
 * underneath it, and several need reading one at a time (biome's fix for
 * `noNonNullAssertion` rewrites `x!.y` to `x?.y`, which swallows a throw rather
 * than preserving it — a mechanical apply would be a silent behaviour change).
 *
 * So instead of a cliff, a ratchet. This records the current count as a budget
 * and fails when a change pushes it up. New code cannot add findings; existing
 * findings get paid down whenever someone is in the file anyway, and the budget
 * follows them down.
 *
 * The budget only moves in one direction. `--update` lowers it and refuses to
 * raise it, because a ratchet you can loosen by rerunning it with a flag is not
 * a ratchet — that is the whole mechanism, and it is deliberately not
 * overridable from the command line.
 *
 * Usage:
 *   node --experimental-strip-types scripts/check-biome-budget.mts
 *   node --experimental-strip-types scripts/check-biome-budget.mts --update
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BUDGET_PATH = resolve(process.cwd(), "scripts/biome-budget.json");
const SCAN_ROOTS = ["packages/", "src/", "scripts/", "site/", "test/"];

interface Budget {
	readonly errors: number;
	readonly warnings: number;
	readonly note: string;
}

interface Counts {
	readonly errors: number;
	readonly warnings: number;
}

/**
 * Counts findings by running biome's own summary reporter and reading its
 * totals, rather than counting diagnostic lines. Line counting drifts the
 * moment biome changes its output shape, and a miscount here either blocks
 * clean work or lets a regression through.
 */
function countFindings(): Counts {
	const result = spawnSync(
		"npx",
		[
			"biome",
			"check",
			"--max-diagnostics=20000",
			"--reporter=summary",
			...SCAN_ROOTS,
		],
		{ encoding: "utf8", cwd: process.cwd(), env: { ...process.env } },
	);

	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const errors = readTotal(output, "error");
	const warnings = readTotal(output, "warning");
	if (errors === undefined || warnings === undefined) {
		throw new Error(
			[
				"could not read finding totals from biome's summary output.",
				"This guard reads the 'Found N errors.' / 'Found N warnings.' lines;",
				"if biome changed that wording, update readTotal() rather than",
				"deleting the guard.",
				"",
				output.slice(-2000),
			].join("\n"),
		);
	}
	return { errors, warnings };
}

/** Biome omits the line entirely at zero, which is a count of zero, not a parse failure. */
function readTotal(output: string, noun: string): number | undefined {
	const match = output.match(new RegExp(`Found (\\d+) ${noun}s?\\.`, "u"))?.[1];
	if (match !== undefined) return Number.parseInt(match, 10);
	return output.includes("Checked ") ? 0 : undefined;
}

function readBudget(): Budget {
	return JSON.parse(readFileSync(BUDGET_PATH, "utf8")) as Budget;
}

function writeBudget(budget: Budget): void {
	writeFileSync(BUDGET_PATH, `${JSON.stringify(budget, null, "\t")}\n`);
}

const update = process.argv.includes("--update");
const counts = countFindings();
const budget = readBudget();

if (update) {
	const rose =
		counts.errors > budget.errors || counts.warnings > budget.warnings;
	if (rose) {
		console.error(
			[
				"refusing to raise the lint budget.",
				`  errors:   ${budget.errors} -> ${counts.errors}`,
				`  warnings: ${budget.warnings} -> ${counts.warnings}`,
				"",
				"The budget is a ratchet: --update lowers it after findings are fixed,",
				"and cannot raise it to accommodate new ones. Fix the findings the",
				"change introduced.",
			].join("\n"),
		);
		process.exit(1);
	}
	writeBudget({ ...budget, errors: counts.errors, warnings: counts.warnings });
	console.log(
		`biome budget lowered to ${counts.errors} error(s), ${counts.warnings} warning(s).`,
	);
	process.exit(0);
}

const overspend: string[] = [];
if (counts.errors > budget.errors) {
	overspend.push(
		`  errors:   ${counts.errors} (budget ${budget.errors}, +${counts.errors - budget.errors})`,
	);
}
if (counts.warnings > budget.warnings) {
	overspend.push(
		`  warnings: ${counts.warnings} (budget ${budget.warnings}, +${counts.warnings - budget.warnings})`,
	);
}

if (overspend.length > 0) {
	console.error(
		[
			"biome findings went up:",
			...overspend,
			"",
			"Run `npx biome check --write <paths>` on the files you touched, then",
			"`biome check` them to see what is left. The backlog is not yours to",
			"clear, but the additions are.",
		].join("\n"),
	);
	process.exit(1);
}

const slack =
	budget.errors - counts.errors + (budget.warnings - counts.warnings);
console.log(
	slack > 0
		? `biome budget OK: ${counts.errors} error(s), ${counts.warnings} warning(s) — ${slack} under budget. Run with --update to bank it.`
		: `biome budget OK: ${counts.errors} error(s), ${counts.warnings} warning(s).`,
);
