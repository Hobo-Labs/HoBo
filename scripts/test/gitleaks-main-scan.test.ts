import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	FULL_WAIT_SECONDS,
	gitFetchBlobArgs,
	gitleaksArgs,
	planMainGitleaksScan,
	pollScanWait,
	RANGE_WAIT_SECONDS,
	writeExitFile,
	ZERO_SHA,
} from "../ci/gitleaks-main-scan.mts";

const banner = "    ○\n    │╲\n    │ ○\n    ○ ░\n    ░    gitleaks\n";
const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github/workflows/hobo-ci.yml"),
	"utf8",
);
const mainGate = workflow.slice(
	workflow.indexOf("\n  main-gate:"),
	workflow.indexOf("\n  main_workspace_tests:"),
);
const mainGateFinish = workflow.slice(
	workflow.indexOf("\n  main_gate_finish:"),
	workflow.indexOf("\n  artifact-trust:"),
);
const mainGatePlan = workflow.slice(
	workflow.indexOf("\n  main-gate-plan:"),
	workflow.indexOf("\n  main-gate:"),
);

describe("planMainGitleaksScan", () => {
	it("bounds a main push to the landed range without fetching every blob", () => {
		const plan = planMainGitleaksScan({
			eventName: "push",
			pushBefore: "aaa",
			sha: "bbb",
			commitExists: () => true,
		});
		assert.deepEqual(plan, {
			mode: "range",
			logOpts: "aaa..bbb",
			fetchBlobs: false,
			timeoutSeconds: 90,
			waitSeconds: RANGE_WAIT_SECONDS,
		});
		assert.ok(gitleaksArgs(plan).includes("--log-opts"));
		assert.ok(gitleaksArgs(plan).includes("aaa..bbb"));
	});

	it("keeps a regular full-history path that backfills blobs first", () => {
		for (const eventName of ["schedule", "workflow_dispatch"]) {
			const plan = planMainGitleaksScan({
				eventName,
				pushBefore: undefined,
				sha: "bbb",
				commitExists: () => false,
			});
			assert.equal(plan.mode, "full", eventName);
			assert.equal(plan.fetchBlobs, true, eventName);
			assert.ok(!gitleaksArgs(plan).includes("--log-opts"), eventName);
		}
		assert.deepEqual(gitFetchBlobArgs(), ["fetch", "--refetch", "--no-filter"]);
	});

	it("bounds workflow_dispatch to baseline..HEAD when baseline is an ancestor", () => {
		const baseline = "a".repeat(40);
		const head = "b".repeat(40);
		const plan = planMainGitleaksScan({
			eventName: "workflow_dispatch",
			pushBefore: undefined,
			sha: head,
			baselineSha: baseline,
			commitExists: (rev) => rev === baseline || rev === head,
			isAncestor: () => true,
		});
		assert.deepEqual(plan, {
			mode: "range",
			logOpts: `${baseline}..${head}`,
			fetchBlobs: false,
			timeoutSeconds: 90,
			waitSeconds: RANGE_WAIT_SECONDS,
		});
	});

	it("starts from the last green main commit when pushes in between were dropped", () => {
		const plan = planMainGitleaksScan({
			eventName: "push",
			pushBefore: "ccc",
			sha: "ddd",
			lastGreenSha: "aaa",
			commitExists: () => true,
			isAncestor: (ancestor, commit) => ancestor === "aaa" && commit === "ccc",
		});
		assert.equal(plan.logOpts, "aaa..ddd");
		assert.equal(plan.fetchBlobs, false);
	});

	it("keeps the push range when the last green commit is not behind it", () => {
		const plan = planMainGitleaksScan({
			eventName: "push",
			pushBefore: "ccc",
			sha: "ddd",
			lastGreenSha: "zzz",
			commitExists: () => true,
			isAncestor: () => false,
		});
		assert.equal(plan.logOpts, "ccc..ddd");
	});

	it("treats a forced push (zero before) as full history", () => {
		const plan = planMainGitleaksScan({
			eventName: "push",
			pushBefore: ZERO_SHA,
			sha: "bbb",
			commitExists: () => true,
		});
		assert.equal(plan.mode, "full");
		assert.equal(plan.fetchBlobs, true);
	});
});

describe("pollScanWait hang pattern from job 127207503432", () => {
	it("fails immediately when the scanner dies after writing only a banner", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitleaks-hang-"));
		writeFileSync(join(dir, "log"), banner);
		writeFileSync(join(dir, "pid"), "4242\n");
		assert.equal(
			pollScanWait({
				exitPath: join(dir, "exit"),
				logPath: join(dir, "log"),
				pidPath: join(dir, "pid"),
				elapsedSeconds: 5,
				budgetSeconds: 300,
				pidAlive: () => false,
			}),
			"died-without-exit",
		);
	});

	it("times out the 300s wait budget when no exit file is written", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitleaks-budget-"));
		writeFileSync(join(dir, "log"), banner);
		writeFileSync(join(dir, "pid"), "4242\n");
		assert.equal(
			pollScanWait({
				exitPath: join(dir, "exit"),
				logPath: join(dir, "log"),
				pidPath: join(dir, "pid"),
				elapsedSeconds: 300,
				budgetSeconds: 300,
				pidAlive: () => true,
			}),
			"timeout",
		);
	});

	it("returns ok when the exit file exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitleaks-ok-"));
		writeFileSync(join(dir, "log"), "no leaks found\n");
		writeFileSync(join(dir, "exit"), "0\n");
		assert.equal(
			pollScanWait({
				exitPath: join(dir, "exit"),
				logPath: join(dir, "log"),
				pidPath: join(dir, "pid"),
				elapsedSeconds: 12,
				budgetSeconds: 90,
				pidAlive: () => false,
			}),
			"ok",
		);
	});

	it("always writes the exit file the wait step reads", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitleaks-exit-"));
		writeExitFile(dir, 1);
		assert.equal(readFileSync(join(dir, "exit"), "utf8"), "1\n");
	});
});

describe("main-gate wiring", () => {
	it("runs gitleaks through gitleaks-main-scan in the plan job, not inside S0 or finish", () => {
		// The merge queue does not scan, and Main full gate is skipped when the
		// merge queue passed the tree, so the scan lives in the job every main
		// run has: Main workspace plan (finding 144).
		for (const block of [mainGate, mainGateFinish]) {
			assert.equal(block.includes("scripts/ci/gitleaks-main-scan.mts"), false);
			assert.equal(block.includes("gitleaks git"), false);
		}
		assert.ok(
			mainGatePlan.includes("scripts/ci/gitleaks-main-scan.mts --background"),
		);
		assert.ok(
			mainGatePlan.includes(
				'scripts/ci/gitleaks-main-scan.mts --wait --dir "$dir"',
			),
		);
		assert.equal(
			/nohup bash -c '\s*gitleaks git --config \.gitleaks\.toml --redact --exit-code 1 >/u.test(
				mainGatePlan,
			),
			false,
		);
		assert.ok(FULL_WAIT_SECONDS <= 720);
		assert.ok(RANGE_WAIT_SECONDS <= 105);
		// The job outlasts the longest scan it waits for.
		const timeout = Number(
			/^ {4}timeout-minutes: (\d+)$/mu.exec(mainGatePlan)?.[1],
		);
		assert.ok(timeout * 60 > FULL_WAIT_SECONDS + 300, String(timeout));
	});

	it("scans a full-history checkout, after preflight, as the last and unconditional step", () => {
		const checkout = mainGatePlan.indexOf("          fetch-depth: 0");
		const preflight = mainGatePlan.indexOf(
			"./.github/actions/ci-runner-preflight",
		);
		const plan = mainGatePlan.indexOf("name: Plan workspace shards");
		const scan = mainGatePlan.indexOf("name: Secret scan (full history)");
		assert.ok(checkout > -1);
		assert.ok(preflight > checkout);
		assert.ok(plan > preflight);
		assert.ok(scan > plan);
		// A reused merge-queue result skips the plan's work, never the scan.
		const step = mainGatePlan.slice(scan);
		assert.equal(/^\s+if:/mu.test(step), false, step);
		assert.equal(step.includes("continue-on-error"), false, step);
		// Last: nothing else touches the clone while a full scan backfills blobs.
		assert.equal(step.includes("\n      - "), false, step);
		assert.ok(
			step.indexOf("--background") < step.indexOf("--wait"),
			"the scan starts before it is waited for",
		);
	});
});
