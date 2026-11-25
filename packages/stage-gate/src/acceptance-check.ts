/**
 * The release gate's three ai-bdd commands, one step at a time (ADR-0172).
 * `scripts/check-acceptance.mts` is the entry the gate's checks run.
 *
 * - `plans-fresh`: `ai-bdd compile --check` (exit 4 when a plan is stale; no
 *   model call).
 * - `replay`: `ai-bdd run --frozen --no-agent --reporter json,junit`. The exit
 *   code is read first. ai-bdd writes `report.json` after 0 and 1, after 3
 *   when the run reached its scenarios, and not after 2 or 4 (an earlier run's
 *   report may still be on disk then); only
 *   after 0 or 1 is it opened, and only if it is this run's (its run directory
 *   is new, it started no earlier than the spawn, and it is the run ai-bdd
 *   named in its `Run: <dir>` line; replay-run.ts), then parsed into
 *   `AcceptanceEvidence` and held to the process's own exit code. The report
 *   exit 3 writes describes a run that could not be carried out: never read.
 * - `evidence-intact`: `ai-bdd verify-run <runsDir>/<runId>` for the run the
 *   replay judged, named by the replay's own evidence, after checking that its
 *   directory's report has the digest the replay recorded.
 *
 * An exit code of 3, a command that cannot be started, one ended by a signal,
 * one that outlives HOBO_AI_BDD_TIMEOUT_MS, and one whose process group the
 * check could not confirm stopped (kill refused, or still running after
 * SIGKILL: ai-bdd-process.ts) are `not_run` (this process exits 3): never
 * `failed`, never `passed`. Configuration that cannot be used
 * (acceptance-config.ts) is a failure with exit 2, like ai-bdd's own usage
 * errors.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	type AcceptanceEvidence,
	isAiBddRunId,
	isReportDigest,
	reportDigestOf,
} from "./acceptance.js";
import {
	type AcceptanceConfig,
	acceptanceConfigOf,
} from "./acceptance-config.js";
import {
	AI_BDD_GRACE_MS,
	type AiBddRun,
	runAiBdd as spawnAiBdd,
} from "./ai-bdd-process.js";
import { REQUIRED_EVIDENCE_ENV } from "./gate-status.js";
import { isJsonObject, isJsonString, parseJsonText } from "./json.js";
import {
	readReport,
	runDirectoryProblem,
	runIds,
	shown,
	staleBecause,
} from "./replay-run.js";
import type { CheckEvidence } from "./types.js";

export const ACCEPTANCE_STEPS = [
	"plans-fresh",
	"replay",
	"evidence-intact",
] as const;
export type AcceptanceStep = (typeof ACCEPTANCE_STEPS)[number];
export type AcceptanceOutcome = "passed" | "failed" | "not_run";

export interface AcceptanceResult {
	readonly outcome: AcceptanceOutcome;
	/** 0 passed; ai-bdd's own code (1, 2, 4) or 1 for a refused report when failed; 3 not run. */
	readonly exitCode: number;
	/** One flat JSON object: the line the stage-gate runner keeps as the check's evidence. */
	readonly evidence: CheckEvidence;
}

/** Where ai-bdd's own output goes, as it comes (bounded, see ai-bdd-process.ts). */
export type OutputSink = (chunk: Buffer) => void;

function runAiBdd(
	config: AcceptanceConfig,
	relay: OutputSink,
	args: readonly string[],
): Promise<AiBddRun> {
	return spawnAiBdd(
		{
			command: config.command,
			cwd: config.project,
			env: config.env,
			timeoutMs: config.timeoutMs,
			relay,
		},
		args,
	);
}

const NOT_RUN = 3;
const USAGE = 2;

function result(
	outcome: AcceptanceOutcome,
	exitCode: number,
	evidence: CheckEvidence,
): AcceptanceResult {
	return { outcome, exitCode, evidence: { outcome, ...evidence } };
}

/** How one ai-bdd command ended, when its exit code is all there is to read. */
function commandResult(
	step: AcceptanceStep,
	run: AiBddRun,
	extra: CheckEvidence,
	timeoutMs: number,
): AcceptanceResult {
	const command = `ai-bdd ${run.args.join(" ")}`;
	const base = { step, command, ...extra };
	if (run.stop.kind === "unconfirmed") {
		const reason = `${command}: the check could not confirm its process group stopped: ${run.stop.reason}`;
		return result("not_run", NOT_RUN, {
			...base,
			reason,
			output_tail: run.tail,
		});
	}
	if (run.timedOut) {
		const reason = `${command} did not finish within ${timeoutMs} ms (HOBO_AI_BDD_TIMEOUT_MS): its process group was sent SIGTERM, and SIGKILL after ${AI_BDD_GRACE_MS / 1000} s`;
		return result("not_run", NOT_RUN, {
			...base,
			reason,
			output_tail: run.tail,
		});
	}
	if (run.unstartable !== "" || run.status === null) {
		const reason = `${command} did not run: ${run.unstartable}`;
		return result("not_run", NOT_RUN, { ...base, reason });
	}
	if (run.status === 0) {
		return result("passed", 0, { ...base, exit_code: "0" });
	}
	const evidence = {
		...base,
		exit_code: String(run.status),
		output_tail: run.tail,
	};
	if (run.status === NOT_RUN) {
		const reason = `${command} exited 3: infrastructure`;
		return result("not_run", NOT_RUN, { ...evidence, reason });
	}
	return result("failed", run.status, evidence);
}

function evidenceFields(evidence: AcceptanceEvidence): CheckEvidence {
	return {
		run_id: evidence.runId,
		report_digest: evidence.reportDigest,
		scenarios_total: String(evidence.scenariosTotal),
		scenarios_passed: String(evidence.passed),
		scenarios_healed: String(evidence.healed),
		scenarios_failed: String(evidence.failed),
		scenarios_inconclusive: String(evidence.inconclusive),
		scenarios_blocked: String(evidence.blocked),
		scenarios_error: String(evidence.error),
		scenarios_skipped: String(evidence.skipped),
		fuzzy_steps: String(evidence.fuzzySteps),
		model_calls: String(evidence.modelCalls),
		frozen: String(evidence.frozen),
		no_agent: String(evidence.noAgent),
		report_exit_code: String(evidence.exitCode),
		report_started_at: evidence.startedAt,
	};
}

async function plansFresh(
	config: AcceptanceConfig,
	relay: OutputSink,
): Promise<AcceptanceResult> {
	const run = await runAiBdd(config, relay, ["compile", "--check"]);
	return commandResult("plans-fresh", run, {}, config.timeoutMs);
}

async function replay(
	config: AcceptanceConfig,
	relay: OutputSink,
): Promise<AcceptanceResult> {
	const before = runIds(config);
	const spawnedAt = Date.now();
	const run = await runAiBdd(config, relay, [
		"run",
		"--frozen",
		"--no-agent",
		"--reporter",
		"json,junit",
	]);
	if (
		run.stop.kind === "unconfirmed" ||
		run.unstartable !== "" ||
		(run.status !== 0 && run.status !== 1)
	) {
		// Exit 2 and 4 write no report; exit 3 writes one that says nothing about the product. None is read,
		// nor one of a run whose process group the check could not confirm stopped.
		return commandResult(
			"replay",
			run,
			{ report: "not read" },
			config.timeoutMs,
		);
	}
	const step = { step: "replay", exit_code: String(run.status) };
	const read = readReport(config);
	if ("refused" in read) {
		return result("failed", 1, { ...step, reason: read.refused });
	}
	const stale = staleBecause(
		config,
		read.evidence,
		before,
		spawnedAt,
		run.printedRunDir,
	);
	if (stale !== undefined) {
		// Nothing of an earlier run goes into this run's evidence.
		return result("failed", 1, { ...step, reason: stale });
	}
	const fields = { ...step, ...evidenceFields(read.evidence) };
	if (read.evidence.exitCode !== run.status) {
		const reason = `report.json says exit ${read.evidence.exitCode} but ai-bdd exited ${run.status}`;
		return result("failed", 1, { ...fields, reason });
	}
	if (run.status === 0) return result("passed", 0, fields);
	return result("failed", 1, { ...fields, output_tail: run.tail });
}

/** What one step is handed: the evidence of the steps before it, by check id. */
type Handed = ReadonlyMap<string, CheckEvidence>;

interface JudgedRun {
	readonly runId: string;
	readonly reportDigest: string;
}

function judgedRunOf(
	evidence: CheckEvidence | undefined,
): JudgedRun | undefined {
	const runId = evidence?.run_id ?? "";
	const reportDigest = evidence?.report_digest ?? "";
	return isAiBddRunId(runId) && isReportDigest(reportDigest)
		? { runId, reportDigest }
		: undefined;
}

/**
 * verify-run on the run acceptance-replay judged, named by the replay's own
 * evidence (run id and report digest), not by whatever report.json says now:
 * another run in the project may have replaced it between the two checks.
 */
async function evidenceIntact(
	config: AcceptanceConfig,
	relay: OutputSink,
	handed: Handed,
): Promise<AcceptanceResult> {
	const step = { step: "evidence-intact" };
	const judged = judgedRunOf(handed.get("acceptance-replay"));
	if (judged === undefined) {
		const reason = `evidence-intact needs the evidence of acceptance-replay (its run_id and report_digest): run it as the release gate's check, which hands it over in ${REQUIRED_EVIDENCE_ENV}, or with \`all\``;
		return result("failed", USAGE, { ...step, reason });
	}
	const runDir = join(config.runsDir, judged.runId);
	const copyPath = join(runDir, "report.json");
	const fields = {
		...step,
		run_id: judged.runId,
		report_digest: judged.reportDigest,
	};
	const problem = runDirectoryProblem(config, judged.runId);
	if (problem !== undefined) {
		return result("failed", 1, { ...fields, reason: problem });
	}
	let copy: Buffer;
	try {
		copy = readFileSync(copyPath);
	} catch {
		const reason = `${shown(config, copyPath)} is missing`;
		return result("failed", 1, { ...fields, reason });
	}
	const digest = reportDigestOf(copy);
	if (digest !== judged.reportDigest) {
		const reason = `${shown(config, copyPath)} is not the report acceptance-replay judged (${digest}, not ${judged.reportDigest})`;
		return result("failed", 1, { ...fields, reason });
	}
	const run = await runAiBdd(config, relay, ["verify-run", runDir]);
	return commandResult("evidence-intact", run, fields, config.timeoutMs);
}

const STEPS = {
	"plans-fresh": plansFresh,
	replay,
	"evidence-intact": evidenceIntact,
} satisfies Record<
	AcceptanceStep,
	(
		config: AcceptanceConfig,
		relay: OutputSink,
		handed: Handed,
	) => Promise<AcceptanceResult>
>;

/** The evidence the stage-gate runner hands a check that requires others (gate-status.ts). */
function handedOf(env: NodeJS.ProcessEnv): Map<string, CheckEvidence> {
	const handed = new Map<string, CheckEvidence>();
	const parsed = parseJsonText(env[REQUIRED_EVIDENCE_ENV] ?? "");
	if (!isJsonObject(parsed)) return handed;
	for (const [checkId, evidence] of Object.entries(parsed)) {
		if (!isJsonObject(evidence)) continue;
		const strings: Record<string, string> = {};
		for (const [key, value] of Object.entries(evidence)) {
			if (isJsonString(value)) strings[key] = value;
		}
		handed.set(checkId, strings);
	}
	return handed;
}

function stepsOf(
	argv: readonly string[],
): readonly AcceptanceStep[] | undefined {
	const [name, ...rest] = argv;
	if (rest.length > 0) return undefined;
	if (name === undefined || name === "all") return ACCEPTANCE_STEPS;
	const step = ACCEPTANCE_STEPS.find((entry) => entry === name);
	return step === undefined ? undefined : [step];
}

/**
 * Run one step, or all three in order (stopping at the first that does not
 * pass, since the next one's input then does not exist).
 */
export async function checkAcceptance(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
	relay: OutputSink = (chunk) => process.stderr.write(chunk),
): Promise<AcceptanceResult> {
	const steps = stepsOf(argv);
	if (steps === undefined) {
		const reason = `usage: check-acceptance [${ACCEPTANCE_STEPS.join("|")}|all]`;
		return result("failed", USAGE, { reason });
	}
	const config = acceptanceConfigOf(env, cwd);
	if (isJsonString(config)) {
		return result("failed", USAGE, { reason: config });
	}
	const handed = handedOf(env);
	let evidence: CheckEvidence = {};
	let last = result("failed", USAGE, { reason: "no step ran" });
	for (const step of steps) {
		last = await STEPS[step](config, relay, handed);
		// `all` hands each step's evidence to the next in process, as the runner does across processes.
		handed.set(`acceptance-${step}`, last.evidence);
		evidence = { ...evidence, ...last.evidence };
		if (last.outcome !== "passed") break;
	}
	return { ...last, evidence };
}
