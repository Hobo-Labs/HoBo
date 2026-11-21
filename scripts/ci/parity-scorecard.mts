#!/usr/bin/env node
/**
 * The HoBo CI parity scorecard: one row per gauntlet case, generated from the
 * case catalog, the tags of the parity scenarios and the last run's results
 * (ADR-0183, `features/hobo-ci-parity/README.md`).
 *
 *   node --import tsx scripts/ci/parity-scorecard.mts            run the suite, write the page
 *   node --import tsx scripts/ci/parity-scorecard.mts --check    run the suite, fail if the page is stale
 *   ... --results <cucumber.json>                                use a finished run instead of running
 *
 * A case's state comes from its scenario: a pending one keeps the state the
 * catalog records for today; a passing one is `pass`, or `built-not-proven`
 * while a T3 run is owed; a failing one is `partial`. `--check` also fails
 * when a case has no scenario, has two, or a scenario's tier tags disagree
 * with the catalog.
 */
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const FEATURES_DIR = "features/hobo-ci-parity";
export const CASES_FILE = `${FEATURES_DIR}/cases.json`;
export const CUCUMBER_CONFIG = `${FEATURES_DIR}/cucumber.yaml`;
// The same path `PARITY_SCORECARD_PATH` in @hobo/ci names.
export const SCORECARD_FILE = "docs/ci/parity-scorecard.md";

export const CASE_STATES = [
	"pass",
	"built-not-proven",
	"partial",
	"not-built",
	"met-differently",
] as const;
export type CaseState = (typeof CASE_STATES)[number];

export const TIERS = ["t1", "t2", "t3"] as const;
export type Tier = (typeof TIERS)[number];

const AREAS = [
	"Routing",
	"Machines",
	"Providers",
	"Checks",
	"Insights",
	"Surfaces",
	"Security",
] as const;

const CaseSchema = z
	.object({
		id: z.string().regex(/^[A-Z]\d{2}b?$/u),
		area: z.enum(AREAS),
		better: z.boolean().optional(),
		claim: z.string().min(1),
		source: z.string(),
		bar: z.string().min(1),
		tiers: z.array(z.enum(TIERS)),
		packages: z.array(z.string().regex(/^\d{2}$/u)),
		today: z.object({ state: z.enum(CASE_STATES), note: z.string() }).strict(),
		/** A production run that shows the T3 part of the case. */
		t3Run: z.string().url().optional(),
	})
	.strict();

const CatalogSchema = z
	.object({
		relayRunnerCommit: z.string().regex(/^[0-9a-f]{7,40}$/u),
		/** What a source starting `site/` stands for in RelayRunner's tree. */
		sitePrefix: z.string(),
		cases: z.array(CaseSchema),
	})
	.strict();

export type ParityCase = z.infer<typeof CaseSchema>;
export type ParityCatalog = z.infer<typeof CatalogSchema>;

export function parseCatalog(text: string): ParityCatalog {
	const catalog = CatalogSchema.parse(JSON.parse(text));
	const seen = new Set<string>();
	for (const entry of catalog.cases) {
		if (seen.has(entry.id))
			throw new Error(`${CASES_FILE}: case ${entry.id} is listed twice`);
		seen.add(entry.id);
	}
	return catalog;
}

/** One parity scenario as its tags describe it. `id` is empty when no tag names a case. */
export type ParityScenario = Readonly<{
	id: string;
	file: string;
	line: number;
	tiers: readonly Tier[];
	pending: boolean;
	metDifferently: boolean;
}>;

const SCENARIO = /^\s*Scenario( Outline)?:/u;

/** The parity scenarios of one feature file: those tagged `@parity`. */
export function featureScenarios(
	text: string,
	file: string,
	catalog: ParityCatalog,
): readonly ParityScenario[] {
	const ids = new Set(catalog.cases.map((entry) => entry.id));
	const found: ParityScenario[] = [];
	let tags: string[] = [];
	for (const [index, raw] of text.split("\n").entries()) {
		const line = raw.trim();
		if (line.startsWith("@")) {
			tags.push(...line.split(/\s+/u));
			continue;
		}
		if (SCENARIO.test(raw) && tags.includes("@parity"))
			found.push({
				id: tags.map((tag) => tag.slice(1)).find((tag) => ids.has(tag)) ?? "",
				file,
				line: index + 1,
				tiers: TIERS.filter((tier) => tags.includes(`@${tier}`)),
				pending: tags.includes("@pending"),
				metDifferently: tags.includes("@met-differently"),
			});
		if (line !== "" && !line.startsWith("#")) tags = [];
	}
	return found;
}

/** What is wrong with how the scenarios cover the catalog; empty when nothing is. */
export function coverageProblems(
	catalog: ParityCatalog,
	scenarios: readonly ParityScenario[],
): readonly string[] {
	const problems: string[] = [];
	for (const scenario of scenarios)
		if (scenario.id === "")
			problems.push(
				`${scenario.file}:${scenario.line}: a @parity scenario names no case in ${CASES_FILE}`,
			);
	for (const entry of catalog.cases) {
		const mine = scenarios.filter((scenario) => scenario.id === entry.id);
		if (mine.length === 0) {
			problems.push(`${entry.id} has no scenario under ${FEATURES_DIR}`);
			continue;
		}
		if (mine.length > 1)
			problems.push(
				`${entry.id} has ${mine.length} scenarios: ${mine.map((s) => `${s.file}:${s.line}`).join(", ")}`,
			);
		const metDifferently = entry.today.state === "met-differently";
		for (const scenario of mine) {
			const where = `${scenario.file}:${scenario.line}`;
			if (scenario.tiers.join(",") !== entry.tiers.join(","))
				problems.push(
					`${where}: ${entry.id} is tagged @${scenario.tiers.join(" @") || "(no tier)"}, the catalog says ${entry.tiers.join(", ") || "no tier"}`,
				);
			if (scenario.metDifferently !== metDifferently)
				problems.push(
					metDifferently
						? `${where}: ${entry.id} is met differently and needs the @met-differently tag`
						: `${where}: ${entry.id} is not met differently but is tagged @met-differently`,
				);
		}
	}
	return problems;
}

export type CaseResult = "passed" | "failed";

const StepResultSchema = z.object({
	result: z.object({ status: z.string() }),
});
const CucumberJsonSchema = z.array(
	z.object({
		elements: z
			.array(
				z.object({
					tags: z.array(z.object({ name: z.string() })).default([]),
					before: z.array(StepResultSchema).default([]),
					steps: z.array(StepResultSchema).default([]),
					after: z.array(StepResultSchema).default([]),
				}),
			)
			.default([]),
	}),
);

/**
 * Each case's result in a cucumber JSON report. A case passes only when every
 * hook and step of every run of it passed; undefined, pending, skipped or
 * failed anywhere fails it.
 */
export function scenarioResults(
	cucumberJson: string,
	catalog: ParityCatalog,
): ReadonlyMap<string, CaseResult> {
	const ids = new Set(catalog.cases.map((entry) => entry.id));
	const results = new Map<string, CaseResult>();
	for (const feature of CucumberJsonSchema.parse(JSON.parse(cucumberJson)))
		for (const element of feature.elements) {
			const id = element.tags
				.map((tag) => tag.name.slice(1))
				.find((tag) => ids.has(tag));
			if (id === undefined) continue;
			const passed =
				element.steps.length > 0 &&
				[...element.before, ...element.steps, ...element.after].every(
					(step) => step.result.status === "passed",
				);
			if (results.get(id) !== "failed")
				results.set(id, passed ? "passed" : "failed");
		}
	return results;
}

/** Scenarios that should have run (not pending, not met differently) but have no result. */
export function unrunProblems(
	scenarios: readonly ParityScenario[],
	results: ReadonlyMap<string, CaseResult>,
): readonly string[] {
	return scenarios
		.filter(
			(scenario) =>
				scenario.id !== "" &&
				!scenario.pending &&
				!scenario.metDifferently &&
				!results.has(scenario.id),
		)
		.map(
			(scenario) =>
				`${scenario.file}:${scenario.line}: ${scenario.id} is not pending but did not run`,
		);
}

export type CaseRow = Readonly<{ id: string; state: CaseState; note: string }>;

function caseRow(
	entry: ParityCase,
	scenario: ParityScenario | undefined,
	result: CaseResult | undefined,
): CaseRow {
	const today = { id: entry.id, ...entry.today };
	if (entry.today.state === "met-differently") return today;
	if (!scenario || scenario.pending || result === undefined) return today;
	if (result === "failed")
		return {
			id: entry.id,
			state: "partial",
			note: "its scenario failed in the last run",
		};
	if (entry.tiers.includes("t3") && entry.t3Run === undefined)
		return {
			id: entry.id,
			state: "built-not-proven",
			note: "T3 owed: no production run is linked yet",
		};
	return {
		id: entry.id,
		state: "pass",
		note: entry.t3Run === undefined ? "" : `[T3 run](${entry.t3Run})`,
	};
}

/** One row per case, in catalog order. */
export function caseRows(
	catalog: ParityCatalog,
	scenarios: readonly ParityScenario[],
	results: ReadonlyMap<string, CaseResult>,
): readonly CaseRow[] {
	return catalog.cases.map((entry) =>
		caseRow(
			entry,
			scenarios.find((scenario) => scenario.id === entry.id),
			results.get(entry.id),
		),
	);
}

function sourceCell(catalog: ParityCatalog, source: string): string {
	if (source === "") return "";
	const path = source.startsWith("site/")
		? `${catalog.sitePrefix}${source.slice("site/".length)}`
		: source;
	return ` ([${source}](https://github.com/relayrunner/relayrunner/blob/${catalog.relayRunnerCommit}/${path}))`;
}

function tierCell(tiers: readonly Tier[]): string {
	return tiers.length === 0
		? "n/a"
		: tiers.map((t) => t.toUpperCase()).join(", ");
}

function stateCell(row: CaseRow): string {
	return row.note === "" ? row.state : `${row.state}: ${row.note}`;
}

/** The scorecard page. It holds no date, so the same inputs give the same bytes. */
export function renderScorecard(
	catalog: ParityCatalog,
	rows: readonly CaseRow[],
): string {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const lines = [
		"# HoBo CI parity scorecard",
		"",
		"<!-- Generated by scripts/ci/parity-scorecard.mts. Do not edit by hand. -->",
		"",
		`Each row is one thing RelayRunner says it does, read at commit \`${catalog.relayRunnerCommit}\`, with the bar HoBo has to meet (ADR-0183, [runner order](../design/adr/runner-order.md)). A **B** case sets a bar above parity. The scenarios are under [\`${FEATURES_DIR}\`](../../${FEATURES_DIR}/README.md); this page is generated from their tags and their last run with \`node --import tsx scripts/ci/parity-scorecard.mts\`, and \`--check\` fails when it is stale.`,
		"",
		"| State | Meaning |",
		"| --- | --- |",
		"| pass | Its scenario passes at its tier, and any T3 part has a linked production run |",
		"| built-not-proven | Its scenario passes; the production run (T3) is still owed |",
		"| partial | Part is built, or its scenario failed in the last run |",
		"| not-built | Nothing that meets the bar exists yet |",
		"| met-differently | HoBo meets the need another way, for the reason given |",
		"",
		"## Summary",
		"",
		"| State | Cases |",
		"| --- | --- |",
		...CASE_STATES.map(
			(state) =>
				`| ${state} | ${rows.filter((row) => row.state === state).length} |`,
		),
		`| Total | ${rows.length} |`,
	];
	for (const area of AREAS) {
		const cases = catalog.cases.filter((entry) => entry.area === area);
		if (cases.length === 0) continue;
		lines.push(
			"",
			`## ${area}`,
			"",
			"| Case | RelayRunner's claim | HoBo's bar | Tier | State | Package |",
			"| --- | --- | --- | --- | --- | --- |",
			...cases.map((entry) => {
				const row = byId.get(entry.id);
				return `| ${entry.id}${entry.better ? " **B**" : ""} | ${entry.claim}${sourceCell(catalog, entry.source)} | ${entry.bar} | ${tierCell(entry.tiers)} | ${row ? stateCell(row) : ""} | ${entry.packages.join(", ") || "done"} |`;
			}),
		);
	}
	lines.push(
		"",
		`A source starting \`site/\` is under \`${catalog.sitePrefix}\` in RelayRunner's repository.`,
	);
	return `${lines.join("\n")}\n`;
}

/** Every parity scenario under the features directory, files in name order. */
export function readScenarios(
	root: string,
	catalog: ParityCatalog,
): readonly ParityScenario[] {
	return readdirSync(join(root, FEATURES_DIR))
		.filter((name) => name.endsWith(".feature"))
		.sort()
		.flatMap((name) =>
			featureScenarios(
				readFileSync(join(root, FEATURES_DIR, name), "utf8"),
				`${FEATURES_DIR}/${name}`,
				catalog,
			),
		);
}

type SuiteOutcome = Readonly<{ report: string; failure?: string }>;

/** Run the parity suite and retain both its report and process outcome. */
function runSuite(root: string): SuiteOutcome {
	const dir = mkdtempSync(join(tmpdir(), "hobo-parity-"));
	const report = join(dir, "cucumber.json");
	try {
		const run = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"node_modules/@cucumber/cucumber/bin/cucumber.js",
				"--config",
				CUCUMBER_CONFIG,
				"--format",
				`json:${report}`,
			],
			{ cwd: root, stdio: ["ignore", "inherit", "inherit"] },
		);
		if (run.error) throw run.error;
		const text = readFileSync(report, "utf8");
		if (run.status === 0) return { report: text };
		const reason = run.signal
			? `signal ${run.signal}`
			: `exit ${String(run.status)}`;
		return { report: text, failure: `parity suite failed (${reason})` };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function option(argv: readonly string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
}

export function main(argv: readonly string[], root: string): number {
	const catalog = parseCatalog(readFileSync(join(root, CASES_FILE), "utf8"));
	const scenarios = readScenarios(root, catalog);
	const resultsFile = option(argv, "--results");
	const run: SuiteOutcome =
		resultsFile === undefined
			? runSuite(root)
			: { report: readFileSync(resultsFile, "utf8") };
	const results = scenarioResults(run.report, catalog);
	const problems = [
		...coverageProblems(catalog, scenarios),
		...unrunProblems(scenarios, results),
		...(run.failure === undefined ? [] : [run.failure]),
	];
	const page = renderScorecard(catalog, caseRows(catalog, scenarios, results));
	const target = join(root, SCORECARD_FILE);
	if (argv.includes("--check")) {
		let committed = "";
		try {
			committed = readFileSync(target, "utf8");
		} catch {
			committed = "";
		}
		if (committed !== page)
			problems.push(
				`${SCORECARD_FILE} is stale: run node --import tsx scripts/ci/parity-scorecard.mts`,
			);
	} else {
		writeFileSync(target, page);
		console.log(`wrote ${SCORECARD_FILE}`);
	}
	for (const problem of problems) console.error(`parity-scorecard: ${problem}`);
	return problems.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	process.exitCode = main(
		process.argv.slice(2),
		join(import.meta.dirname, "..", ".."),
	);
