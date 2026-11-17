import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	CASES_FILE,
	type CaseResult,
	caseRows,
	coverageProblems,
	FEATURES_DIR,
	featureScenarios,
	type ParityCatalog,
	parseCatalog,
	renderScorecard,
	scenarioResults,
	unrunProblems,
} from "../ci/parity-scorecard.mts";

const ROOT = join(import.meta.dirname, "..", "..");

function catalog(): ParityCatalog {
	return parseCatalog(
		JSON.stringify({
			relayRunnerCommit: "43b7c4c",
			sitePrefix: "apps/site/src/content/docs/docs/",
			cases: [
				{
					id: "R02",
					area: "Routing",
					claim: "First that fits",
					source: "docs/architecture/pick-runner.md",
					bar: "Same",
					tiers: ["t1"],
					packages: [],
					today: { state: "pass", note: "" },
				},
				{
					id: "R04",
					area: "Routing",
					claim: "Fails with the reason",
					source: "site/concepts/routing.md",
					bar: "Annotation",
					tiers: ["t2", "t3"],
					packages: ["11", "12"],
					today: { state: "partial", note: "the reason exists" },
				},
				{
					id: "R16",
					area: "Routing",
					better: true,
					claim: "n/a",
					source: "",
					bar: "A second node answers",
					tiers: ["t2"],
					packages: ["12"],
					today: { state: "not-built", note: "" },
				},
				{
					id: "S08",
					area: "Surfaces",
					claim: "Roles",
					source: "site/dashboard/workspaces.md",
					bar: "Scoped tokens",
					tiers: [],
					packages: [],
					today: { state: "met-differently", note: "no human roles" },
				},
			],
		}),
	);
}

const FEATURE = `Feature: Routing parity

  @parity @R02 @t1
  Scenario: R02 first that fits
    Given something

  @parity @R04 @t2 @t3 @pending
  Scenario: R04 fails with the reason
    Given something

  @parity @R16 @t2
  @pending
  Scenario Outline: R16 second node
    Given something

  @parity @S08 @met-differently
  Scenario: S08 roles
    Given something

  Scenario: not a parity case
    Given something
`;

function cucumberJson(
	elements: readonly Readonly<{
		tags: readonly string[];
		statuses: readonly string[];
	}>[],
): string {
	return JSON.stringify([
		{
			uri: "features/hobo-ci-parity/routing.feature",
			elements: elements.map((element) => ({
				type: "scenario",
				tags: element.tags.map((name) => ({ name })),
				before: [{ result: { status: "passed" } }],
				steps: element.statuses.map((status) => ({ result: { status } })),
			})),
		},
	]);
}

describe("parity catalog", () => {
	it("rejects a case with an unknown state or tier", () => {
		const bad = (today: string, tier: string) =>
			JSON.stringify({
				relayRunnerCommit: "43b7c4c",
				sitePrefix: "x/",
				cases: [
					{
						id: "R02",
						area: "Routing",
						claim: "c",
						source: "",
						bar: "b",
						tiers: [tier],
						packages: [],
						today: { state: today, note: "" },
					},
				],
			});
		assert.throws(() => parseCatalog(bad("done", "t1")));
		assert.throws(() => parseCatalog(bad("pass", "t4")));
		assert.equal(parseCatalog(bad("pass", "t1")).cases.length, 1);
	});

	it("rejects the same case id twice", () => {
		const text = JSON.stringify({
			...JSON.parse(JSON.stringify(catalog())),
			cases: [...catalog().cases, catalog().cases[0]],
		});
		assert.throws(() => parseCatalog(text), /R02/);
	});
});

describe("featureScenarios", () => {
	it("reads the parity tags of each scenario, across tag lines", () => {
		const found = featureScenarios(FEATURE, "routing.feature", catalog());
		assert.deepEqual(
			found.map((scenario) => [
				scenario.id,
				scenario.tiers.join(","),
				scenario.pending,
				scenario.metDifferently,
			]),
			[
				["R02", "t1", false, false],
				["R04", "t2,t3", true, false],
				["R16", "t2", true, false],
				["S08", "", false, true],
			],
		);
		assert.equal(found[0]?.line, 4);
	});

	it("names a parity scenario whose id is not a case", () => {
		const found = featureScenarios(
			"Feature: x\n  @parity @Z99 @t2\n  Scenario: z\n",
			"x.feature",
			catalog(),
		);
		assert.equal(found[0]?.id, "");
	});
});

describe("coverageProblems", () => {
	it("is empty when every case has one scenario with its tiers", () => {
		const scenarios = featureScenarios(FEATURE, "routing.feature", catalog());
		assert.deepEqual(coverageProblems(catalog(), scenarios), []);
	});

	it("names a missing case, a duplicate, an unknown id and a tier mismatch", () => {
		const text = `Feature: x
  @parity @R02 @t2
  Scenario: a
  @parity @R02 @t1
  Scenario: b
  @parity @Z99 @t2
  Scenario: c
  @parity @S08 @met-differently
  Scenario: d
`;
		const problems = coverageProblems(
			catalog(),
			featureScenarios(text, "x.feature", catalog()),
		);
		assert.ok(problems.some((p) => p.includes("R04 has no scenario")));
		assert.ok(problems.some((p) => p.includes("R16 has no scenario")));
		assert.ok(problems.some((p) => p.includes("R02 has 2 scenarios")));
		assert.ok(
			problems.some((p) => p.includes("x.feature:7") && p.includes("no case")),
		);
		assert.ok(
			problems.some((p) => p.includes("x.feature:3") && p.includes("t1")),
		);
	});

	it("requires the met-differently tag exactly where the catalog says so", () => {
		const text = `Feature: x
  @parity @R02 @t1 @met-differently
  Scenario: a
  @parity @R04 @t2 @t3 @pending
  Scenario: b
  @parity @R16 @t2 @pending
  Scenario: c
  @parity @S08
  Scenario: d
`;
		const problems = coverageProblems(
			catalog(),
			featureScenarios(text, "x.feature", catalog()),
		);
		assert.ok(
			problems.some((p) => p.includes("R02") && p.includes("met-differently")),
		);
		assert.ok(
			problems.some((p) => p.includes("S08") && p.includes("met-differently")),
		);
	});
});

describe("scenarioResults", () => {
	it("passes a scenario only when every hook and step passed", () => {
		const results = scenarioResults(
			cucumberJson([
				{ tags: ["@parity", "@R02", "@t1"], statuses: ["passed", "passed"] },
				{ tags: ["@parity", "@R04", "@t2"], statuses: ["passed", "failed"] },
				{ tags: ["@parity", "@R16", "@t2"], statuses: ["passed", "undefined"] },
				{ tags: ["@other"], statuses: ["passed"] },
			]),
			catalog(),
		);
		assert.deepEqual(
			[...results.entries()],
			[
				["R02", "passed"],
				["R04", "failed"],
				["R16", "failed"],
			],
		);
	});

	it("fails a case when any of its runs failed", () => {
		const results = scenarioResults(
			cucumberJson([
				{ tags: ["@parity", "@R02", "@t1"], statuses: ["passed"] },
				{ tags: ["@parity", "@R02", "@t1"], statuses: ["failed"] },
			]),
			catalog(),
		);
		assert.equal(results.get("R02"), "failed");
	});
});

describe("caseRows", () => {
	const scenarios = featureScenarios(FEATURE, "routing.feature", catalog());

	function states(results: ReadonlyMap<string, CaseResult>, cases = catalog()) {
		return caseRows(cases, scenarios, results).map((row) => [
			row.id,
			row.state,
			row.note,
		]);
	}

	it("takes today's state for a pending case, and passes a passing T1 case", () => {
		assert.deepEqual(states(new Map([["R02", "passed"]])), [
			["R02", "pass", ""],
			["R04", "partial", "the reason exists"],
			["R16", "not-built", ""],
			["S08", "met-differently", "no human roles"],
		]);
	});

	it("keeps a case built-not-proven while its T3 run is owed, and passes it once linked", () => {
		const t2 = `Feature: x
  @parity @R02 @t1
  Scenario: a
  @parity @R04 @t2 @t3
  Scenario: b
  @parity @R16 @t2
  Scenario: c
  @parity @S08 @met-differently
  Scenario: d
`;
		const ran = featureScenarios(t2, "x.feature", catalog());
		const results = new Map<string, CaseResult>([
			["R02", "passed"],
			["R04", "passed"],
			["R16", "failed"],
		]);
		const before = caseRows(catalog(), ran, results);
		assert.deepEqual(
			before.map((row) => [row.id, row.state]),
			[
				["R02", "pass"],
				["R04", "built-not-proven"],
				["R16", "partial"],
				["S08", "met-differently"],
			],
		);
		assert.match(before[1]?.note ?? "", /T3/);
		assert.match(before[2]?.note ?? "", /failed/);
		const linked = parseCatalog(
			JSON.stringify({
				...catalog(),
				cases: catalog().cases.map((entry) =>
					entry.id === "R04"
						? {
								...entry,
								t3Run: "https://github.com/Hobo-Labs/HoBo/actions/runs/1",
							}
						: entry,
				),
			}),
		);
		const after = caseRows(linked, ran, results);
		assert.equal(after[1]?.state, "pass");
	});
});

describe("unrunProblems", () => {
	it("names a scenario that should have run but has no result", () => {
		const scenarios = featureScenarios(FEATURE, "routing.feature", catalog());
		assert.deepEqual(unrunProblems(scenarios, new Map()), [
			"routing.feature:4: R02 is not pending but did not run",
		]);
		assert.deepEqual(
			unrunProblems(scenarios, new Map([["R02", "passed"]])),
			[],
		);
	});
});

describe("renderScorecard", () => {
	it("is deterministic, counts every state and marks the B cases", () => {
		const scenarios = featureScenarios(FEATURE, "routing.feature", catalog());
		const rows = caseRows(catalog(), scenarios, new Map([["R02", "passed"]]));
		const page = renderScorecard(catalog(), rows);
		assert.equal(page, renderScorecard(catalog(), rows));
		assert.match(page, /^# /);
		assert.match(page, /Do not edit/);
		assert.match(page, /\| pass \| 1 \|/);
		assert.match(page, /\| met-differently \| 1 \|/);
		assert.match(page, /\| Total \| 4 \|/);
		assert.match(page, /R16 \*\*B\*\*/);
		assert.match(
			page,
			/\[site\/concepts\/routing\.md\]\(https:\/\/github\.com\/relayrunner\/relayrunner\/blob\/43b7c4c\/apps\/site\/src\/content\/docs\/docs\/concepts\/routing\.md\)/,
		);
		assert.match(page, /## Routing/);
		assert.match(page, /## Surfaces/);
		assert.ok(page.endsWith("\n") && !page.endsWith("\n\n"));
	});
});

describe("the committed gauntlet", () => {
	const cases = parseCatalog(readFileSync(join(ROOT, CASES_FILE), "utf8"));
	const scenarios = readdirSync(join(ROOT, FEATURES_DIR))
		.filter((name) => name.endsWith(".feature"))
		.sort()
		.flatMap((name) =>
			featureScenarios(
				readFileSync(join(ROOT, FEATURES_DIR, name), "utf8"),
				`${FEATURES_DIR}/${name}`,
				cases,
			),
		);

	it("holds 58 cases, each with exactly one scenario", () => {
		assert.equal(cases.cases.length, 58);
		assert.deepEqual(coverageProblems(cases, scenarios), []);
	});

	it("runs every case that passes today", () => {
		const live = new Set(
			scenarios.filter((s) => !s.pending && !s.metDifferently).map((s) => s.id),
		);
		for (const entry of cases.cases)
			if (entry.today.state === "pass")
				assert.ok(
					live.has(entry.id),
					`${entry.id} passes today but is pending`,
				);
	});
});
