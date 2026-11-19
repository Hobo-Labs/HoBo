import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineReleaseGate } from "../../src/definition.js";
import { isJsonObject, isJsonString, parseJsonText } from "../../src/json.js";
import { runStageGate } from "../../src/runner.js";
import type {
	CheckResult,
	RunStageGateResult,
	StageGateDefinition,
} from "../../src/types.js";
import {
	bytesOf,
	docAt,
	FIXTURE_DIR,
	fixtureDoc,
	scenarioAt,
} from "./ai-bdd-report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const FAKE = join(HERE, "fake-ai-bdd.mts");
export const FAKE_COMMAND: readonly string[] = [
	process.execPath,
	"--experimental-strip-types",
	"--no-warnings",
	FAKE,
];
export const PASSED = join(FIXTURE_DIR, "report.v1.passed.json");
export const FAILED_WITH_AGENT = join(FIXTURE_DIR, "report.v1.failed.json");
export const TIMEOUT = 60_000;

const dirs: string[] = [];

export function removeTempDirs(): void {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

export interface FakePlan {
	readonly compileCheck: number;
	readonly run: {
		readonly exit: number;
		readonly report?: string;
		readonly runCopy?:
			| "same"
			| "different"
			| "none"
			| "no-directory"
			| "linked";
		readonly startedAt?: string;
		readonly runsDir?: string;
		readonly sleepMs?: number;
		readonly pidFile?: string;
		readonly detachedPidFile?: string;
		readonly pauseAfterBrowserMs?: number;
		readonly outputBytes?: number;
		readonly printedRun?: "other" | "none";
	};
	readonly verifyRun: number;
}

export interface GateRun {
	readonly result: RunStageGateResult;
	readonly project: string;
	readonly calls: readonly string[];
}

export function newDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-release-gate-"));
	dirs.push(dir);
	return dir;
}

export function checkOf(run: GateRun, checkId: string): CheckResult {
	const found = run.result.record.checks.find((c) => c.checkId === checkId);
	if (found === undefined) throw new Error(`no check ${checkId}`);
	return found;
}

function releaseGate(
	replayBackstopMs: number | undefined,
): StageGateDefinition {
	const gate = defineReleaseGate();
	if (replayBackstopMs === undefined) return gate;
	return {
		...gate,
		checks: gate.checks.map((check) =>
			check.checkId === "acceptance-replay"
				? { ...check, timeoutMs: replayBackstopMs }
				: check,
		),
	};
}

export async function runGate(
	plan: FakePlan,
	command: readonly string[] = FAKE_COMMAND,
	project = newDir(),
	extraEnv: Readonly<Record<string, string>> = {},
	replayBackstopMs?: number,
): Promise<GateRun> {
	const log = join(newDir(), "calls.log");
	writeFileSync(log, "");
	const result = await runStageGate(releaseGate(replayBackstopMs), {
		cwd: REPO_ROOT,
		env: {
			HOBO_AI_BDD_CMD: JSON.stringify(command),
			HOBO_AI_BDD_PROJECT: project,
			FAKE_AI_BDD: JSON.stringify(plan),
			FAKE_AI_BDD_LOG: log,
			...extraEnv,
		},
	});
	const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
	return { result, project, calls };
}

export function runIdOf(reportPath: string): string {
	const runId = parseJsonText(readFileSync(reportPath, "utf8"));
	const id = isJsonObject(runId) ? runId.runId : undefined;
	if (!isJsonString(id)) throw new Error(`${reportPath} has no runId`);
	return id;
}

export function earlierRun(project: string): string {
	const runId = "01a132d2-fe9a-7d3a-a7d8-157d681d6417";
	for (const dir of [
		join(project, ".ai-bdd", "report"),
		join(project, ".ai-bdd", "runs", runId),
	]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "report.json"), readFileSync(PASSED));
	}
	return runId;
}

export async function gone(pid: number, attempts = 100): Promise<boolean> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		if (isZombie(pid)) return true;
		await new Promise((done) => setTimeout(done, 100));
	}
	return false;
}

function isZombie(pid: number): boolean {
	if (process.platform !== "linux") return false;
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		return /^State:\s+Z/mu.test(status) && /^Threads:\s+1$/mu.test(status);
	} catch {
		return false;
	}
}

export function killQuietly(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
	}
}

export function sha256Of(path: string): string {
	const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
	return `sha256:${digest}`;
}

export function failedReplayReport(): string {
	const doc = fixtureDoc("passed");
	scenarioAt(doc, 0).status = "failed";
	doc.totals = { ...docAt(doc, "totals"), passed: 4, failed: 1 };
	doc.exitCode = 1;
	const path = join(newDir(), "failed-replay.json");
	writeFileSync(path, bytesOf(doc));
	return path;
}

export function stalePassedReport(project: string): void {
	mkdirSync(join(project, ".ai-bdd", "report"), { recursive: true });
	writeFileSync(
		join(project, ".ai-bdd", "report", "report.json"),
		readFileSync(PASSED),
	);
}

export const ALL_PASS: FakePlan = {
	compileCheck: 0,
	run: { exit: 0, report: PASSED },
	verifyRun: 0,
};
