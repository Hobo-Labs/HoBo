/**
 * The record side of the release gate (ADR-0172): what a `release` record
 * must hold to claim `passed`, the `not_run` status, and how the runner turns
 * check exit codes into statuses when a check `requires` another or lists
 * `notRunExitCodes`. Checks here run `node -e`, so nothing depends on ai-bdd.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	checkStatusOf,
	recordStatusOf,
	runnerExitCodeOf,
} from "../src/gate-status.js";
import { parseStageGateRecord } from "../src/parse.js";
import { runStageGate } from "../src/runner.js";
import type {
	CheckResult,
	CheckStatus,
	StageGateCheck,
	StageGateRecordJson,
} from "../src/types.js";
import { StageGateParseError } from "../src/types.js";

const DIGEST = `sha256:${"e".repeat(64)}`;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function check(
	checkId: string,
	status: CheckStatus = "passed",
	evidence: Readonly<Record<string, string>> = {},
): StageGateRecordJson["checks"][number] {
	return {
		check_id: checkId,
		command: ["node"],
		exit_code: status === "passed" ? 0 : 1,
		status,
		evidence,
	};
}

/** What acceptance-replay records for a replay-only run that passed. */
const REPLAY_EVIDENCE = {
	run_id: "01a132d3-0000-7000-8000-000000000001",
	report_digest: DIGEST,
	model_calls: "0",
	frozen: "true",
	no_agent: "true",
	report_exit_code: "0",
	scenarios_total: "5",
	scenarios_passed: "5",
	scenarios_healed: "0",
};

const RELEASE_CHECKS = [
	check("acceptance-plans-fresh"),
	check("acceptance-replay", "passed", REPLAY_EVIDENCE),
	check("acceptance-evidence-intact", "passed", {
		run_id: REPLAY_EVIDENCE.run_id,
		report_digest: DIGEST,
	}),
];

/** A passed release record as the runner writes it: no signature, a zero artifact. */
function releaseRecord(
	overrides: Partial<StageGateRecordJson> = {},
): StageGateRecordJson {
	return {
		gate_id: "release",
		status: "passed",
		repo_commit: "abc",
		ci_run_url: "",
		started_at: "2026-10-17T00:00:00.000Z",
		finished_at: "2026-10-17T00:01:00.000Z",
		checks: RELEASE_CHECKS,
		artifact: {
			digest_sha256: `sha256:${"0".repeat(64)}`,
			byte_length: 0,
			media_type: "application/octet-stream",
		},
		signature: {
			verified: false,
			signer_identity: "",
			provenance_tier: "",
			conformance_report_digest: "",
		},
		...overrides,
	};
}

/** A passed release record whose replay evidence is `evidence`. */
function withReplayEvidence(
	evidence: Readonly<Record<string, string>>,
): StageGateRecordJson {
	return releaseRecord({
		checks: [
			RELEASE_CHECKS[0] ?? check("acceptance-plans-fresh"),
			check("acceptance-replay", "passed", evidence),
			RELEASE_CHECKS[2] ?? check("acceptance-evidence-intact"),
		],
	});
}

function issuesOf(record: StageGateRecordJson): readonly string[] {
	try {
		parseStageGateRecord(record);
	} catch (error) {
		if (error instanceof StageGateParseError) return error.issues;
		throw error;
	}
	throw new Error("expected the record to be refused");
}

describe("a passed release record", () => {
	it("needs no signature or artifact, only its three checks and the report digest", () => {
		const record = parseStageGateRecord(releaseRecord());
		expect(record.gateId).toBe("release");
		expect(record.status).toBe("passed");
		expect(record.signature.verified).toBe(false);
	});

	it.each([
		["one missing", RELEASE_CHECKS.slice(0, 2)],
		["reordered", [RELEASE_CHECKS[1], RELEASE_CHECKS[0], RELEASE_CHECKS[2]]],
		["none at all", []],
	])("is refused with its checks %s", (_label, checks) => {
		const issues = issuesOf(
			releaseRecord({ checks: checks.filter((c) => c !== undefined) }),
		);
		expect(issues.join("\n")).toContain(
			"passed release record requires exactly the checks acceptance-plans-fresh, acceptance-replay, acceptance-evidence-intact in that order",
		);
	});

	it("is refused without the replay's report digest", () => {
		const issues = issuesOf(
			releaseRecord({
				checks: [
					check("acceptance-plans-fresh"),
					check("acceptance-replay"),
					check("acceptance-evidence-intact"),
				],
			}),
		);
		expect(issues).toContain(
			"passed release record requires acceptance-replay evidence report_digest",
		);
	});

	it.each([
		[
			"another report digest",
			{
				run_id: REPLAY_EVIDENCE.run_id,
				report_digest: `sha256:${"b".repeat(64)}`,
			},
		],
		["another run id", { run_id: "other", report_digest: DIGEST }],
		["no evidence", {}],
	])("is refused when evidence-intact names %s than the replay judged", (_label, evidence) => {
		const issues = issuesOf(
			releaseRecord({
				checks: [
					...RELEASE_CHECKS.slice(0, 2),
					check("acceptance-evidence-intact", "passed", evidence),
				],
			}),
		);
		expect(issues).toEqual([
			"passed release record requires acceptance-evidence-intact to name the replay's run_id and report_digest",
		]);
	});

	it.each([
		["model_calls", "3"],
		["frozen", "false"],
		["no_agent", "false"],
		["report_exit_code", "1"],
	])("is refused when the replay evidence says %s %s", (key, value) => {
		const issues = issuesOf(
			withReplayEvidence({ ...REPLAY_EVIDENCE, [key]: value }),
		);
		expect(issues).toContain(
			`passed release record requires acceptance-replay evidence ${key} "${{ model_calls: "0", frozen: "true", no_agent: "true", report_exit_code: "0" }[key]}"`,
		);
	});

	it.each([
		["nothing replayed", { scenarios_total: "0", scenarios_passed: "0" }],
		[
			"every scenario skipped",
			{ scenarios_passed: "0", scenarios_healed: "0" },
		],
	])("is refused when the replay evidence shows %s", (_label, counts) => {
		const issues = issuesOf(
			withReplayEvidence({ ...REPLAY_EVIDENCE, ...counts }),
		);
		expect(issues).toContain(
			"passed release record requires acceptance-replay evidence that a scenario replayed (scenarios_total above 0, scenarios_passed + scenarios_healed above 0)",
		);
	});

	// The CUE reads each count with strconv.Atoi: decimal digits within int64.
	const NOT_COUNTS =
		"passed release record requires acceptance-replay evidence scenarios_total, scenarios_passed and scenarios_healed as decimal counts the CUE's strconv.Atoi reads (digits, at most 2^63 - 1)";
	it.each([
		[
			'scenarios_passed "-1"',
			{ scenarios_passed: "-1", scenarios_healed: "5" },
		],
		[
			'scenarios_passed "abc"',
			{ scenarios_passed: "abc", scenarios_healed: "5" },
		],
		["scenarios_total 2^63", { scenarios_total: "9223372036854775808" }],
	])("is refused when the replay evidence has %s", (_label, counts) => {
		const issues = issuesOf(
			withReplayEvidence({ ...REPLAY_EVIDENCE, ...counts }),
		);
		expect(issues).toContain(NOT_COUNTS);
	});

	it("is refused when the replay evidence has no scenarios_healed", () => {
		const { scenarios_healed: _absent, ...evidence } = REPLAY_EVIDENCE;
		expect(issuesOf(withReplayEvidence(evidence))).toContain(NOT_COUNTS);
	});

	it("is refused with a check that was not run", () => {
		const issues = issuesOf(
			releaseRecord({
				checks: [
					check("acceptance-plans-fresh", "not_run"),
					...RELEASE_CHECKS.slice(1),
				],
			}),
		);
		expect(issues).toContain(
			"passed record requires every check passed (acceptance-plans-fresh)",
		);
	});
});

describe("the not_run status", () => {
	it("parses on a record and on a check", () => {
		const record = parseStageGateRecord(
			releaseRecord({
				status: "not_run",
				checks: [
					check("acceptance-plans-fresh", "not_run"),
					check("acceptance-replay", "skipped"),
					check("acceptance-evidence-intact", "skipped"),
				],
			}),
		);
		expect(record.status).toBe("not_run");
		expect(record.checks.map((c) => c.status)).toEqual([
			"not_run",
			"skipped",
			"skipped",
		]);
	});

	it("is a check status only where the definition lists the exit code", () => {
		const s0: StageGateCheck = { checkId: "a", kind: "lint", command: [] };
		const acceptance: StageGateCheck = { ...s0, notRunExitCodes: [3] };
		expect(checkStatusOf(s0, 3)).toBe("failed");
		expect(checkStatusOf(acceptance, 3)).toBe("not_run");
		expect(checkStatusOf(acceptance, 4)).toBe("failed");
		expect(checkStatusOf(acceptance, 0)).toBe("passed");
	});

	it("makes the record not_run only when nothing failed", () => {
		const of = (...statuses: CheckStatus[]): CheckResult[] =>
			statuses.map((status, index) => ({
				checkId: String(index),
				command: [],
				exitCode: 0,
				status,
				evidence: {},
			}));
		expect(recordStatusOf(of("passed", "not_run", "skipped"))).toBe("not_run");
		expect(recordStatusOf(of("not_run", "failed"))).toBe("failed");
		expect(recordStatusOf(of("passed", "passed"))).toBe("passed");
		// A skipped check beside no failure cannot make a pass.
		expect(recordStatusOf(of("passed", "skipped"))).toBe("failed");
		expect(recordStatusOf([])).toBe("passed");
		expect(runnerExitCodeOf("not_run")).toBe(3);
		expect(runnerExitCodeOf("failed")).toBe(1);
		expect(runnerExitCodeOf("passed")).toBe(0);
	});
});

describe("runStageGate with requires and notRunExitCodes", () => {
	function nodeCheck(
		checkId: string,
		script: string,
		extra: Partial<StageGateCheck> = {},
	): StageGateCheck {
		return {
			checkId,
			kind: "acceptance",
			command: [process.execPath, "-e", script],
			...extra,
		};
	}

	it("records a check that outlives its timeoutMs as not run", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hobo-release-record-"));
		dirs.push(cwd);
		const result = await runStageGate(
			{
				gateId: "release",
				checks: [
					nodeCheck("slow", "setTimeout(() => {}, 8000)", { timeoutMs: 500 }),
				],
			},
			{ cwd },
		);
		expect(result.record.checks[0]).toMatchObject({
			status: "not_run",
			exitCode: 3,
		});
		expect(result.record.checks[0]?.evidence.error).toContain(
			"did not finish within 500 ms",
		);
		expect(result.exitCode).toBe(3);
	}, 20_000);

	it("hands a check the evidence of the checks it requires", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hobo-release-record-"));
		dirs.push(cwd);
		const result = await runStageGate(
			{
				gateId: "release",
				checks: [
					nodeCheck(
						"first",
						'console.log(JSON.stringify({ run_id: "r1", report_digest: "d1" }))',
					),
					nodeCheck(
						"second",
						"console.log(JSON.stringify({ got: process.env.HOBO_STAGE_GATE_REQUIRED_EVIDENCE ?? 'none' }))",
						{ requires: ["first"] },
					),
					nodeCheck(
						"third",
						"console.log(JSON.stringify({ got: process.env.HOBO_STAGE_GATE_REQUIRED_EVIDENCE ?? 'none' }))",
					),
				],
			},
			{ cwd },
		);
		expect(JSON.parse(result.record.checks[1]?.evidence.got ?? "")).toEqual({
			first: { run_id: "r1", report_digest: "d1" },
		});
		// A check that requires nothing is handed nothing.
		expect(result.record.checks[2]?.evidence.got).toBe("none");
	});

	it("does not start a check whose requirement did not pass, and exits 3 when infrastructure stopped the run", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hobo-release-record-"));
		dirs.push(cwd);
		const marker = join(cwd, "second-ran");
		const result = await runStageGate(
			{
				gateId: "release",
				checks: [
					nodeCheck("first", "process.exit(3)", { notRunExitCodes: [3] }),
					nodeCheck(
						"second",
						`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
						{ requires: ["first"] },
					),
				],
			},
			{ cwd },
		);
		expect(result.record.checks.map((c) => [c.status, c.exitCode])).toEqual([
			["not_run", 3],
			["skipped", -1],
		]);
		expect(result.record.checks[1]?.evidence.skipped_because).toBe(
			"first did not pass",
		);
		expect(result.record.status).toBe("not_run");
		expect(result.exitCode).toBe(3);
		expect(existsSync(marker)).toBe(false);
	});
});
