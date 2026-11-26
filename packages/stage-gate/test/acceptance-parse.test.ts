/**
 * parseAiBddRunReport: the one boundary an ai-bdd report crosses (ADR-0172).
 *
 * The two fixtures are reports ai-bdd wrote in real runs; every other input
 * here is one of them with a single named edit, so a refusal is always
 * attributable to the field the test changed.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	AcceptanceReportError,
	parseAiBddRunReport,
} from "../src/acceptance.js";
import {
	bytesOf,
	docAt,
	fixtureBytes,
	fixtureDoc,
	type ReportDoc,
	scenarioAt,
	stepAt,
} from "./helpers/ai-bdd-report.js";

function issuesOf(bytes: Uint8Array): readonly string[] {
	try {
		parseAiBddRunReport(bytes);
	} catch (error) {
		if (error instanceof AcceptanceReportError) return error.issues;
		throw error;
	}
	throw new Error("expected the report to be refused");
}

function recordFailedScenario(doc: ReportDoc, exitCode: number): ReportDoc {
	scenarioAt(doc, 0).status = "failed";
	doc.totals = { ...docAt(doc, "totals"), passed: 4, failed: 1 };
	doc.exitCode = exitCode;
	return doc;
}

describe("parseAiBddRunReport", () => {
	it("accepts a frozen no-agent report with zero model calls", () => {
		const bytes = fixtureBytes("report.v1.passed.json");
		const evidence = parseAiBddRunReport(bytes);
		expect(evidence).toEqual({
			runId: "01a132d2-fe9a-7d3a-a7d8-157d681d6417",
			startedAt: "2026-10-13T01:14:10.915Z",
			reportDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
			scenariosTotal: 5,
			passed: 5,
			healed: 0,
			failed: 0,
			inconclusive: 0,
			blocked: 0,
			error: 0,
			skipped: 0,
			fuzzySteps: 1,
			modelCalls: 0,
			frozen: true,
			noAgent: true,
			exitCode: 0,
		});
		// The digest is of the bytes as read, so it is what `sha256sum report.json` prints.
		expect(evidence.reportDigest).toBe(
			"sha256:39b3124e109795fcb285de613fb0eee1bf60322a017c0d1b6c54639e7bdebbb1",
		);
		expect(Object.isFrozen(evidence)).toBe(true);
	});

	it("refuses a report that used the agent", () => {
		// The real failed fixture: a frozen run without --no-agent that healed through the agent.
		const issues = issuesOf(fixtureBytes("report.v1.failed.json"));
		expect(issues).toContain(
			"options.noAgent is false: a step could have fallen back to the agent",
		);
		expect(issues).toContain(
			"usage.modelCalls is 11: a replay-only run makes no model call",
		);
		expect(issues).toContain(
			"usage.byPurpose.act.modelCalls is 8: a replay-only run makes no act call",
		);
	});

	it("refuses schemaVersion 2", () => {
		const doc = fixtureDoc("passed");
		doc.schemaVersion = 2;
		expect(issuesOf(bytesOf(doc))).toEqual([
			"schemaVersion is 2: this gate reads RunReport version 1 only",
		]);
	});

	it("a failed scenario with exit 0 is contradictory and refused", () => {
		const issues = issuesOf(
			bytesOf(recordFailedScenario(fixtureDoc("passed"), 0)),
		);
		expect(issues).toEqual([
			"exitCode is 0 but 1 scenario(s) failed, were inconclusive, blocked or ended in error: the report contradicts itself",
		]);
	});

	it("unknown status is refused", () => {
		const doc = fixtureDoc("passed");
		scenarioAt(doc, 2).status = "flaky";
		const issues = issuesOf(bytesOf(doc));
		expect(issues).toContain(
			"scenarios[2].status: expected passed|failed|healed|blocked|skipped|inconclusive|error",
		);
	});

	it("a judge call means the verdict cache was cold, and is refused", () => {
		// `--no-agent` stops the agent, not the judge: with an empty .ai-bdd/cache/
		// a frozen replay still asks the judge, so zero model calls needs the cache.
		const doc = fixtureDoc("passed");
		doc.usage = {
			...docAt(doc, "usage"),
			modelCalls: 1,
			byPurpose: {
				...docAt(docAt(doc, "usage"), "byPurpose"),
				judge: { modelCalls: 1, inputTokens: 700, outputTokens: 40 },
			},
		};
		const issues = issuesOf(bytesOf(doc));
		expect(issues).toContain(
			"usage.modelCalls is 1: a replay-only run makes no model call",
		);
		expect(issues.join("\n")).toMatch(
			/usage\.byPurpose\.judge\.modelCalls is 1: .*verdict cache \(\.ai-bdd\/cache\/\)/u,
		);
	});

	it("refuses a run that compiled instead of replaying, or rewrote recordings", () => {
		const doc = fixtureDoc("passed");
		doc.options = {
			...docAt(doc, "options"),
			frozen: false,
			updateRecordings: true,
		};
		expect(issuesOf(bytesOf(doc))).toEqual([
			"options.frozen is false: the run did not replay the committed plans as they are",
			"options.updateRecordings is true: the run rewrote recordings instead of replaying them",
		]);
	});

	it.each([5, 130, -1, 1.5, "0"])("refuses exit code %j", (exitCode) => {
		const doc = fixtureDoc("passed");
		doc.exitCode = exitCode;
		expect(issuesOf(bytesOf(doc))).toEqual([
			"exitCode: expected 0, 1, 2, 3 or 4",
		]);
	});

	it("refuses totals that disagree with the scenarios", () => {
		const doc = fixtureDoc("passed");
		doc.totals = { ...docAt(doc, "totals"), passed: 6 };
		expect(issuesOf(bytesOf(doc))).toEqual([
			"totals.passed is 6 but 5 scenario(s) have status passed",
		]);
	});

	it.each([
		"../../etc",
		"a/b",
		".hidden",
		"",
		"x\\y",
	])("refuses run id %j, which is not one directory name", (runId) => {
		const doc = fixtureDoc("passed");
		doc.runId = runId;
		expect(issuesOf(bytesOf(doc))).toEqual([
			"runId: expected one directory name (letters, digits, . _ -)",
		]);
	});

	it("a replay that failed a scenario is evidence of the failure", () => {
		const evidence = parseAiBddRunReport(
			bytesOf(recordFailedScenario(fixtureDoc("passed"), 1)),
		);
		expect(evidence).toMatchObject({ failed: 1, passed: 4, exitCode: 1 });
	});

	it("refuses exit 0 for a run with no scenario at all", () => {
		// ai-bdd exits 0 for an empty run (no plans, or every scenario rejected):
		// nothing replayed, so it is not evidence that the documented scenarios do.
		const doc = fixtureDoc("passed");
		doc.scenarios = [];
		doc.totals = { ...docAt(doc, "totals"), passed: 0 };
		expect(issuesOf(bytesOf(doc))).toEqual([
			"exitCode is 0 but the run has no scenario: nothing was replayed",
		]);
	});

	it("refuses exit 0 when every scenario was skipped", () => {
		const doc = fixtureDoc("passed");
		for (const index of [0, 1, 2, 3, 4])
			scenarioAt(doc, index).status = "skipped";
		doc.totals = { ...docAt(doc, "totals"), passed: 0, skipped: 5 };
		expect(issuesOf(bytesOf(doc))).toEqual([
			"exitCode is 0 but no scenario passed or healed (5 skipped): nothing was replayed",
		]);
	});

	it("accepts exit 0 with some scenarios skipped beside one that passed", () => {
		const doc = fixtureDoc("passed");
		for (const index of [1, 2, 3, 4]) scenarioAt(doc, index).status = "skipped";
		doc.totals = { ...docAt(doc, "totals"), passed: 1, skipped: 4 };
		expect(parseAiBddRunReport(bytesOf(doc))).toMatchObject({
			passed: 1,
			skipped: 4,
		});
	});

	it("refuses a field RunReport v1 does not define, at any level it reads", () => {
		const doc = fixtureDoc("passed");
		doc.extraTop = true;
		doc.options = { ...docAt(doc, "options"), extra: 1 };
		const usage = docAt(doc, "usage");
		usage.byPurpose = {
			...docAt(usage, "byPurpose"),
			heal: { modelCalls: 5, inputTokens: 0, outputTokens: 0 },
		};
		const issues = issuesOf(bytesOf(doc));
		expect(issues).toContain("extraTop: not a field of RunReport v1");
		expect(issues).toContain("options.extra: not a field of RunReport v1");
		expect(issues).toContain(
			"usage.byPurpose.heal: not a field of RunReport v1",
		);
	});

	it.each([
		"coverage",
		"warnings",
		"startedAt",
	])("refuses a report without %s, a field the gate does not interpret", (field) => {
		const doc = fixtureDoc("passed");
		delete doc[field];
		expect(issuesOf(bytesOf(doc))).toContain(
			`${field}: required by RunReport v1`,
		);
	});

	it("refuses a key repeated in one object (the last one would win)", () => {
		const text = fixtureBytes("report.v1.passed.json")
			.toString("utf8")
			.replace('"frozen": true', '"frozen": false, "frozen": true');
		expect(issuesOf(Buffer.from(text))).toEqual([
			'report.json repeats the key "frozen" in one object',
		]);
	});

	it("refuses step or scenario usage that contradicts the zero usage of the run", () => {
		const doc = fixtureDoc("passed");
		docAt(scenarioAt(doc, 0), "usage").inputTokens = 10;
		stepAt(doc, 0, 0).usage = {
			modelCalls: 2,
			inputTokens: 0,
			outputTokens: 0,
		};
		const issues = issuesOf(bytesOf(doc));
		expect(issues).toContain(
			"scenarios[0].steps[0].usage.modelCalls is 2: a replay-only run spends none, and usage.modelCalls says so",
		);
		expect(issues).toContain(
			"scenarios[0].usage.inputTokens is 10: a replay-only run spends none, and usage.inputTokens says so",
		);
	});

	it.each([
		"2026-10-13T01:14:10Z",
		"2026-10-13T01:14:10.915+00:00",
		"2026-10-13 01:14:10.915Z",
		// The form, but no date: month 13, hour 25.
		"2026-13-45T25:61:61.000Z",
	])("refuses startedAt %j, which is not the toISOString form v1 pins", (startedAt) => {
		const doc = fixtureDoc("passed");
		doc.startedAt = startedAt;
		expect(issuesOf(bytesOf(doc))).toEqual([
			"startedAt: expected an ISO 8601 timestamp in toISOString form (YYYY-MM-DDTHH:MM:SS.sssZ)",
		]);
	});

	it("refuses run-level and per-purpose tokens, and a cost above zero", () => {
		const doc = fixtureDoc("passed");
		const usage = docAt(doc, "usage");
		usage.inputTokens = 5;
		usage.estimatedCostUsd = 0.01;
		docAt(docAt(usage, "byPurpose"), "judge").outputTokens = 3;
		expect(issuesOf(bytesOf(doc))).toEqual([
			"usage.inputTokens is 5: a replay-only run spends no tokens",
			"usage.estimatedCostUsd is 0.01: a replay-only run costs nothing",
			"usage.byPurpose.judge.outputTokens is 3: a replay-only run spends no tokens",
		]);
	});

	it("refuses a negative duration, which v1 bounds at 0", () => {
		const doc = fixtureDoc("passed");
		scenarioAt(doc, 1).durationMs = -1;
		stepAt(doc, 0, 2).durationMs = -0.5;
		expect(issuesOf(bytesOf(doc))).toEqual([
			"scenarios[0].steps[2].durationMs: expected a non-negative number",
			"scenarios[1].durationMs: expected a non-negative number",
		]);
	});

	it("refuses bytes that are not a JSON object", () => {
		expect(issuesOf(Buffer.from("[]"))).toEqual([
			"report.json is not a JSON object",
		]);
		expect(issuesOf(Buffer.from("not json"))).toEqual([
			"report.json is not a JSON object",
		]);
		expect(issuesOf(Uint8Array.from([0x7b, 0xff, 0x7d]))).toEqual([
			"report.json is not UTF-8 text",
		]);
	});
});
