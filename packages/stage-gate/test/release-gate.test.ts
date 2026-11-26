/**
 * The release gate end to end through real processes (ADR-0172):
 * runStageGate(defineReleaseGate()) spawns `node --import tsx
 * scripts/check-acceptance.mts <step>`, which spawns HOBO_AI_BDD_CMD in
 * HOBO_AI_BDD_PROJECT. Here that command is test/helpers/fake-ai-bdd.mts,
 * which plays back the exit codes and files of the pact's interactions and
 * writes the committed report fixtures as a run's report. The real ai-bdd is
 * the env-gated lane in acceptance-real.test.ts. This suite holds how each of
 * ai-bdd's exit codes lands in the record; release-freshness.test.ts holds
 * which run a report belongs to, and release-bounds.test.ts what the gate
 * does with a hung, loud or unstartable command.
 */
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { defineReleaseGate } from "../src/definition.js";
import {
	parseStageGateRecord,
	serializeStageGateRecord,
} from "../src/parse.js";
import {
	ALL_PASS,
	checkOf,
	FAILED_WITH_AGENT,
	FAKE_COMMAND,
	failedReplayReport,
	newDir,
	PASSED,
	removeTempDirs,
	runGate,
	runIdOf,
	sha256Of,
	stalePassedReport,
	TIMEOUT,
} from "./helpers/release-gate.js";

afterEach(removeTempDirs);

describe("defineReleaseGate", () => {
	it("defineReleaseGate lists the three checks in order", () => {
		const gate = defineReleaseGate();
		expect(gate.gateId).toBe("release");
		expect(
			gate.checks.map((c) => [
				c.checkId,
				c.kind,
				c.command.at(-1),
				c.requires ?? [],
				c.notRunExitCodes,
			]),
		).toEqual([
			["acceptance-plans-fresh", "acceptance", "plans-fresh", [], [3]],
			[
				"acceptance-replay",
				"acceptance",
				"replay",
				["acceptance-plans-fresh"],
				[3],
			],
			[
				"acceptance-evidence-intact",
				"acceptance",
				"evidence-intact",
				["acceptance-replay"],
				[3],
			],
		]);
	});
});

describe("the release gate through real processes", () => {
	it(
		"a passing run records the report digest in evidence",
		async () => {
			const run = await runGate(ALL_PASS);
			expect(run.result.exitCode).toBe(0);
			expect(run.result.record.status).toBe("passed");
			const replay = checkOf(run, "acceptance-replay");
			const reportPath = join(run.project, ".ai-bdd", "report", "report.json");
			// The digest is of the file ai-bdd wrote: `sha256sum report.json` prints the same.
			expect(replay.evidence.report_digest).toBe(sha256Of(reportPath));
			const runId = runIdOf(reportPath);
			expect(runId).not.toBe("01a132d2-fe9a-7d3a-a7d8-157d681d6417");
			expect(replay.evidence).toMatchObject({
				run_id: runId,
				scenarios_total: "5",
				scenarios_passed: "5",
				model_calls: "0",
				frozen: "true",
				no_agent: "true",
				report_exit_code: "0",
			});
			expect(checkOf(run, "acceptance-evidence-intact").evidence).toMatchObject(
				{ report_digest: sha256Of(reportPath), run_id: runId, exit_code: "0" },
			);
			expect(run.calls).toEqual([
				'["compile","--check"]',
				'["run","--frozen","--no-agent","--reporter","json,junit"]',
				`["verify-run",${JSON.stringify(join(run.project, ".ai-bdd", "runs", runId))}]`,
			]);
			const reparsed = parseStageGateRecord(
				serializeStageGateRecord(run.result.record),
			);
			expect(reparsed.gateId).toBe("release");
			expect(reparsed.status).toBe("passed");
		},
		TIMEOUT,
	);

	it(
		"a stale plan (exit 4) fails the record with the evidence tail kept",
		async () => {
			const run = await runGate({ ...ALL_PASS, compileCheck: 4 });
			expect(run.result.exitCode).toBe(1);
			expect(run.result.record.status).toBe("failed");
			const plans = checkOf(run, "acceptance-plans-fresh");
			expect(plans.status).toBe("failed");
			expect(plans.exitCode).toBe(4);
			expect(plans.evidence.output_tail).toContain("PLAN_STALE");
			for (const id of ["acceptance-replay", "acceptance-evidence-intact"]) {
				expect(checkOf(run, id)).toMatchObject({
					status: "skipped",
					exitCode: -1,
				});
			}
			// Nothing after the stale plan was started.
			expect(run.calls).toEqual(['["compile","--check"]']);
		},
		TIMEOUT,
	);

	it.each([2, 4])(
		"the gate never reads report.json after run exits %i",
		async (exit) => {
			const project = newDir();
			stalePassedReport(project);
			const run = await runGate(
				{ ...ALL_PASS, run: { exit } },
				FAKE_COMMAND,
				project,
			);
			const replay = checkOf(run, "acceptance-replay");
			expect(replay).toMatchObject({ status: "failed", exitCode: exit });
			expect(replay.evidence.report).toBe("not read");
			expect(replay.evidence.report_digest).toBeUndefined();
			expect(checkOf(run, "acceptance-evidence-intact").status).toBe("skipped");
			expect(run.result.record.status).toBe("failed");
		},
		TIMEOUT,
	);

	it(
		"exit 3 (infrastructure) records the check as not run, never failed or passed",
		async () => {
			// ai-bdd writes a report on exit 3; the gate does not read it either.
			const run = await runGate({
				...ALL_PASS,
				run: { exit: 3, report: PASSED },
			});
			const replay = checkOf(run, "acceptance-replay");
			expect(replay).toMatchObject({ status: "not_run", exitCode: 3 });
			expect(replay.evidence.report_digest).toBeUndefined();
			expect(run.result.record.status).toBe("not_run");
			expect(run.result.exitCode).toBe(3);
			expect(
				parseStageGateRecord(serializeStageGateRecord(run.result.record))
					.status,
			).toBe("not_run");
		},
		TIMEOUT,
	);

	it(
		"a command that cannot be started is not run, not failed",
		async () => {
			const run = await runGate(ALL_PASS, [join(newDir(), "no-such-ai-bdd")]);
			const plans = checkOf(run, "acceptance-plans-fresh");
			expect(plans).toMatchObject({ status: "not_run", exitCode: 3 });
			expect(plans.evidence.reason).toMatch(/did not run: .*ENOENT/u);
			expect(run.result.record.status).toBe("not_run");
		},
		TIMEOUT,
	);

	it(
		"a failed scenario (exit 1) fails the record with the counts kept",
		async () => {
			const report = failedReplayReport();
			const run = await runGate({ ...ALL_PASS, run: { exit: 1, report } });
			const replay = checkOf(run, "acceptance-replay");
			expect(replay).toMatchObject({ status: "failed", exitCode: 1 });
			expect(replay.evidence).toMatchObject({
				scenarios_failed: "1",
				scenarios_passed: "4",
				report_digest: sha256Of(
					join(run.project, ".ai-bdd", "report", "report.json"),
				),
				report_exit_code: "1",
			});
			expect(checkOf(run, "acceptance-evidence-intact").status).toBe("skipped");
		},
		TIMEOUT,
	);

	it(
		"a report that used the agent is refused although ai-bdd exited 0",
		async () => {
			const run = await runGate({
				...ALL_PASS,
				run: { exit: 0, report: FAILED_WITH_AGENT },
			});
			const replay = checkOf(run, "acceptance-replay");
			expect(replay).toMatchObject({ status: "failed", exitCode: 1 });
			expect(replay.evidence.reason).toContain("options.noAgent is false");
		},
		TIMEOUT,
	);

	it(
		"a report whose exit code disagrees with the process is refused",
		async () => {
			const run = await runGate({
				...ALL_PASS,
				run: { exit: 0, report: failedReplayReport() },
			});
			expect(checkOf(run, "acceptance-replay").evidence.reason).toBe(
				"report.json says exit 1 but ai-bdd exited 0",
			);
		},
		TIMEOUT,
	);

	it(
		"evidence-intact fails when the run directory holds another report",
		async () => {
			const run = await runGate({
				...ALL_PASS,
				run: { exit: 0, report: PASSED, runCopy: "different" },
			});
			const intact = checkOf(run, "acceptance-evidence-intact");
			expect(intact.status).toBe("failed");
			expect(intact.evidence.reason).toContain(
				"is not the report acceptance-replay judged",
			);
			expect(run.calls).not.toContainEqual(
				expect.stringContaining("verify-run"),
			);
		},
		TIMEOUT,
	);

	it(
		"verify-run finding a modified artifact fails the record",
		async () => {
			const run = await runGate({ ...ALL_PASS, verifyRun: 1 });
			const intact = checkOf(run, "acceptance-evidence-intact");
			expect(intact).toMatchObject({ status: "failed", exitCode: 1 });
			expect(intact.evidence.output_tail).toContain("modified");
			expect(run.result.record.status).toBe("failed");
		},
		TIMEOUT,
	);

	it(
		"a gate with no project configured fails with exit 2",
		async () => {
			const run = await runGate(ALL_PASS, FAKE_COMMAND, "");
			const plans = checkOf(run, "acceptance-plans-fresh");
			expect(plans).toMatchObject({ status: "failed", exitCode: 2 });
			expect(plans.evidence.reason).toContain("HOBO_AI_BDD_PROJECT");
		},
		TIMEOUT,
	);
});
