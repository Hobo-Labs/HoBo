/**
 * Which run a report belongs to (ADR-0172): the release gate records a
 * report only when it names a run this invocation of ai-bdd made, and
 * evidence-intact verifies the run the replay judged, not whatever
 * report.json holds by then. Through real processes, with
 * test/helpers/fake-ai-bdd.mts as HOBO_AI_BDD_CMD.
 */
import { readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { checkAcceptance } from "../src/acceptance-check.js";
import {
	ALL_PASS,
	checkOf,
	earlierRun,
	FAKE_COMMAND,
	newDir,
	PASSED,
	removeTempDirs,
	runGate,
	runIdOf,
	TIMEOUT,
} from "./helpers/release-gate.js";

afterEach(removeTempDirs);

describe("the release gate records only this run's report", () => {
	it(
		"the reviewer's repro: a no-op command and an earlier run's report and run directory fail the record",
		async () => {
			const project = newDir();
			const runId = earlierRun(project);
			const run = await runGate(ALL_PASS, ["/bin/true"], project);
			const replay = checkOf(run, "acceptance-replay");
			expect(replay).toMatchObject({ status: "failed", exitCode: 1 });
			expect(replay.evidence.reason).toBe(
				`report.json names run ${runId}, which was already in .ai-bdd/runs before this run started: it is not this run's report`,
			);
			// Nothing of the earlier run is recorded as if this run had produced it.
			expect(replay.evidence.report_digest).toBeUndefined();
			expect(replay.evidence.scenarios_total).toBeUndefined();
			expect(checkOf(run, "acceptance-evidence-intact").status).toBe("skipped");
			expect(run.result.record.status).toBe("failed");
		},
		TIMEOUT,
	);

	it(
		"a report that started before the run was spawned is refused",
		async () => {
			const run = await runGate({
				...ALL_PASS,
				run: { exit: 0, report: PASSED, startedAt: "2026-10-13T01:14:10.915Z" },
			});
			const replay = checkOf(run, "acceptance-replay");
			expect(replay).toMatchObject({ status: "failed", exitCode: 1 });
			expect(replay.evidence.reason).toMatch(
				/^report\.json for run [0-9a-f-]+ started at 2026-10-13T01:14:10\.915Z, before this run was started at .* \(5 s of clock skew allowed\): it is not this run's report$/u,
			);
		},
		TIMEOUT,
	);

	it(
		"a project that moved runsDir passes with HOBO_AI_BDD_RUNS_DIR, and fails on a stale default report without it",
		async () => {
			const moved = {
				...ALL_PASS,
				run: { exit: 0, report: PASSED, runsDir: "out/runs" },
			};
			const named = await runGate(moved, FAKE_COMMAND, newDir(), {
				HOBO_AI_BDD_RUNS_DIR: "out/runs",
			});
			expect(named.result.record.status).toBe("passed");
			const project = newDir();
			earlierRun(project);
			const unnamed = await runGate(moved, FAKE_COMMAND, project);
			expect(checkOf(unnamed, "acceptance-replay").evidence.reason).toContain(
				"which was already in .ai-bdd/runs before this run started",
			);
			expect(unnamed.result.record.status).toBe("failed");
		},
		TIMEOUT,
	);

	it(
		"a report whose run directory is not there after the run is refused",
		async () => {
			const run = await runGate({
				...ALL_PASS,
				run: { exit: 0, report: PASSED, runCopy: "no-directory" },
			});
			expect(checkOf(run, "acceptance-replay").evidence.reason).toMatch(
				/^report\.json names run [0-9a-f-]{36}, which \.ai-bdd\/runs does not hold: it is not this run's report$/u,
			);
		},
		TIMEOUT,
	);

	it(
		"a report whose run directory is a symbolic link is refused (ai-bdd creates a directory)",
		async () => {
			const run = await runGate({
				...ALL_PASS,
				run: { exit: 0, report: PASSED, runCopy: "linked" },
			});
			expect(checkOf(run, "acceptance-replay").evidence.reason).toMatch(
				/^report\.json names run ([0-9a-f-]{36}), but \.ai-bdd\/runs\/\1 is a symbolic link, not the directory ai-bdd creates: it is not this run's report$/u,
			);
		},
		TIMEOUT,
	);

	const PRINTED: readonly (readonly [string, "other" | "none", RegExp])[] = [
		[
			"another new run's directory (a concurrent run wrote the latest report)",
			"other",
			/^report\.json names run [0-9a-f-]{36}, but this ai-bdd printed "Run: \.ai-bdd\/runs\/[0-9a-f-]{36}": it is not this run's report$/u,
		],
		[
			"no Run: line",
			"none",
			/^report\.json names run [0-9a-f-]{36}, but this ai-bdd printed no "Run: <dir>" line to tie it to this run$/u,
		],
	];
	it.each(PRINTED)(
		"a report is refused when ai-bdd printed %s",
		async (_label, printedRun, reason) => {
			const run = await runGate({
				...ALL_PASS,
				run: { exit: 0, report: PASSED, printedRun },
			});
			const replay = checkOf(run, "acceptance-replay");
			expect(replay).toMatchObject({ status: "failed", exitCode: 1 });
			expect(replay.evidence.reason).toMatch(reason);
			expect(replay.evidence.report_digest).toBeUndefined();
		},
		TIMEOUT,
	);

	it("a run that fails to load (exit 1, no report) fails on freshness, not on the old run's data", async () => {
		const project = newDir();
		const runId = earlierRun(project);
		// Node exits 1 when the CLI's entry cannot be loaded, before ai-bdd writes anything.
		const result = await checkAcceptance(
			["replay"],
			{
				...process.env,
				HOBO_AI_BDD_CMD: JSON.stringify([
					process.execPath,
					join(newDir(), "missing-bin.js"),
				]),
				HOBO_AI_BDD_PROJECT: project,
			},
			project,
		);
		expect(result).toMatchObject({ outcome: "failed", exitCode: 1 });
		expect(result.evidence.reason).toBe(
			`report.json names run ${runId}, which was already in .ai-bdd/runs before this run started: it is not this run's report`,
		);
		expect(result.evidence.run_id).toBeUndefined();
		expect(result.evidence.report_digest).toBeUndefined();
		expect(result.evidence.scenarios_total).toBeUndefined();
	});

	it("evidence-intact verifies the run the replay judged, though report.json was replaced in between", async () => {
		const project = newDir();
		const log = join(newDir(), "calls.log");
		const env = {
			...process.env,
			HOBO_AI_BDD_CMD: JSON.stringify(FAKE_COMMAND),
			HOBO_AI_BDD_PROJECT: project,
			FAKE_AI_BDD: JSON.stringify(ALL_PASS),
			FAKE_AI_BDD_LOG: log,
		};
		const replay = await checkAcceptance(["replay"], env, project);
		expect(replay.outcome).toBe("passed");
		// Another run in the same project replaces the latest report.
		earlierRun(project);
		const intact = await checkAcceptance(
			["evidence-intact"],
			{
				...env,
				HOBO_STAGE_GATE_REQUIRED_EVIDENCE: JSON.stringify({
					"acceptance-replay": replay.evidence,
				}),
			},
			project,
		);
		expect(intact.outcome).toBe("passed");
		expect(intact.evidence).toMatchObject({
			run_id: replay.evidence.run_id,
			report_digest: replay.evidence.report_digest,
		});
		const calls = readFileSync(log, "utf8").trim().split("\n");
		expect(calls.at(-1)).toBe(
			JSON.stringify([
				"verify-run",
				join(project, ".ai-bdd", "runs", replay.evidence.run_id ?? ""),
			]),
		);
	});

	it("evidence-intact refuses a run directory whose report is not the one the replay judged", async () => {
		const project = newDir();
		const env = {
			...process.env,
			HOBO_AI_BDD_CMD: JSON.stringify(FAKE_COMMAND),
			HOBO_AI_BDD_PROJECT: project,
			FAKE_AI_BDD: JSON.stringify(ALL_PASS),
			FAKE_AI_BDD_LOG: join(newDir(), "calls.log"),
		};
		const replay = await checkAcceptance(["replay"], env, project);
		const copy = join(
			project,
			".ai-bdd",
			"runs",
			replay.evidence.run_id ?? "",
			"report.json",
		);
		writeFileSync(copy, `${readFileSync(copy, "utf8")} `);
		const intact = await checkAcceptance(
			["evidence-intact"],
			{
				...env,
				HOBO_STAGE_GATE_REQUIRED_EVIDENCE: JSON.stringify({
					"acceptance-replay": replay.evidence,
				}),
			},
			project,
		);
		expect(intact).toMatchObject({ outcome: "failed", exitCode: 1 });
		expect(intact.evidence.reason).toContain(
			"is not the report acceptance-replay judged",
		);
	});

	it("evidence-intact refuses the judged run once its directory is a symbolic link", async () => {
		const project = newDir();
		const env = {
			...process.env,
			HOBO_AI_BDD_CMD: JSON.stringify(FAKE_COMMAND),
			HOBO_AI_BDD_PROJECT: project,
			FAKE_AI_BDD: JSON.stringify(ALL_PASS),
			FAKE_AI_BDD_LOG: join(newDir(), "calls.log"),
		};
		const replay = await checkAcceptance(["replay"], env, project);
		const runId = replay.evidence.run_id ?? "";
		const runDir = join(project, ".ai-bdd", "runs", runId);
		// The same bytes, moved elsewhere and linked back.
		const elsewhere = join(newDir(), runId);
		renameSync(runDir, elsewhere);
		symlinkSync(elsewhere, runDir, "dir");
		const intact = await checkAcceptance(
			["evidence-intact"],
			{
				...env,
				HOBO_STAGE_GATE_REQUIRED_EVIDENCE: JSON.stringify({
					"acceptance-replay": replay.evidence,
				}),
			},
			project,
		);
		expect(intact).toMatchObject({ outcome: "failed", exitCode: 1 });
		expect(intact.evidence.reason).toBe(
			`.ai-bdd/runs/${runId} is a symbolic link, not the directory ai-bdd creates`,
		);
	});

	it("evidence-intact alone, without the replay's evidence, is a usage error", async () => {
		const project = newDir();
		const result = await checkAcceptance(
			["evidence-intact"],
			{
				...process.env,
				HOBO_AI_BDD_CMD: JSON.stringify(FAKE_COMMAND),
				HOBO_AI_BDD_PROJECT: project,
			},
			project,
		);
		expect(result).toMatchObject({ outcome: "failed", exitCode: 2 });
		expect(result.evidence.reason).toContain(
			"needs the evidence of acceptance-replay",
		);
	});

	it("all hands the replay's run to the verify step in process", async () => {
		const project = newDir();
		const result = await checkAcceptance(
			["all"],
			{
				...process.env,
				HOBO_AI_BDD_CMD: JSON.stringify(FAKE_COMMAND),
				HOBO_AI_BDD_PROJECT: project,
				FAKE_AI_BDD: JSON.stringify(ALL_PASS),
				FAKE_AI_BDD_LOG: join(newDir(), "calls.log"),
			},
			project,
		);
		expect(result).toMatchObject({ outcome: "passed", exitCode: 0 });
		expect(result.evidence.run_id).toBe(
			runIdOf(join(project, ".ai-bdd", "report", "report.json")),
		);
	});
});
