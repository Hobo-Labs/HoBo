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
	readonly exitCode: number;
	readonly evidence: CheckEvidence;
}

export type OutputSink = (chunk: Buffer) => void;

function runConfiguredAiBdd(
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

const NOT_RUN_EXIT_CODE = 3;
const USAGE_EXIT_CODE = 2;

function acceptanceResult(
	outcome: AcceptanceOutcome,
	exitCode: number,
	evidence: CheckEvidence,
): AcceptanceResult {
	return { outcome, exitCode, evidence: { outcome, ...evidence } };
}

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
		return acceptanceResult("not_run", NOT_RUN_EXIT_CODE, {
			...base,
			reason,
			output_tail: run.tail,
		});
	}
	if (run.timedOut) {
		const reason = `${command} did not finish within ${timeoutMs} ms (HOBO_AI_BDD_TIMEOUT_MS): its process group was sent SIGTERM, and SIGKILL after ${AI_BDD_GRACE_MS / 1000} s`;
		return acceptanceResult("not_run", NOT_RUN_EXIT_CODE, {
			...base,
			reason,
			output_tail: run.tail,
		});
	}
	if (run.unstartable !== "" || run.status === null) {
		const reason = `${command} did not run: ${run.unstartable}`;
		return acceptanceResult("not_run", NOT_RUN_EXIT_CODE, { ...base, reason });
	}
	if (run.status === 0) {
		return acceptanceResult("passed", 0, { ...base, exit_code: "0" });
	}
	const evidence = {
		...base,
		exit_code: String(run.status),
		output_tail: run.tail,
	};
	if (run.status === NOT_RUN_EXIT_CODE) {
		const reason = `${command} exited 3: infrastructure`;
		return acceptanceResult("not_run", NOT_RUN_EXIT_CODE, {
			...evidence,
			reason,
		});
	}
	return acceptanceResult("failed", run.status, evidence);
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
	const run = await runConfiguredAiBdd(config, relay, ["compile", "--check"]);
	return commandResult("plans-fresh", run, {}, config.timeoutMs);
}

async function replay(
	config: AcceptanceConfig,
	relay: OutputSink,
): Promise<AcceptanceResult> {
	const before = runIds(config);
	const spawnedAt = Date.now();
	const run = await runConfiguredAiBdd(config, relay, [
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
		return acceptanceResult("failed", 1, { ...step, reason: read.refused });
	}
	const stale = staleBecause(
		config,
		read.evidence,
		before,
		spawnedAt,
		run.printedRunDir,
	);
	if (stale !== undefined) {
		return acceptanceResult("failed", 1, { ...step, reason: stale });
	}
	const fields = { ...step, ...evidenceFields(read.evidence) };
	if (read.evidence.exitCode !== run.status) {
		const reason = `report.json says exit ${read.evidence.exitCode} but ai-bdd exited ${run.status}`;
		return acceptanceResult("failed", 1, { ...fields, reason });
	}
	if (run.status === 0) return acceptanceResult("passed", 0, fields);
	return acceptanceResult("failed", 1, { ...fields, output_tail: run.tail });
}

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

async function evidenceIntact(
	config: AcceptanceConfig,
	relay: OutputSink,
	handed: Handed,
): Promise<AcceptanceResult> {
	const step = { step: "evidence-intact" };
	const judged = judgedRunOf(handed.get("acceptance-replay"));
	if (judged === undefined) {
		const reason = `evidence-intact needs the evidence of acceptance-replay (its run_id and report_digest): run it as the release gate's check, which hands it over in ${REQUIRED_EVIDENCE_ENV}, or with \`all\``;
		return acceptanceResult("failed", USAGE_EXIT_CODE, { ...step, reason });
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
		return acceptanceResult("failed", 1, { ...fields, reason: problem });
	}
	let copy: Buffer;
	try {
		copy = readFileSync(copyPath);
	} catch {
		const reason = `${shown(config, copyPath)} is missing`;
		return acceptanceResult("failed", 1, { ...fields, reason });
	}
	const digest = reportDigestOf(copy);
	if (digest !== judged.reportDigest) {
		const reason = `${shown(config, copyPath)} is not the report acceptance-replay judged (${digest}, not ${judged.reportDigest})`;
		return acceptanceResult("failed", 1, { ...fields, reason });
	}
	const run = await runConfiguredAiBdd(config, relay, ["verify-run", runDir]);
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

export async function checkAcceptance(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
	relay: OutputSink = (chunk) => process.stderr.write(chunk),
): Promise<AcceptanceResult> {
	const steps = stepsOf(argv);
	if (steps === undefined) {
		const reason = `usage: check-acceptance [${ACCEPTANCE_STEPS.join("|")}|all]`;
		return acceptanceResult("failed", USAGE_EXIT_CODE, { reason });
	}
	const config = acceptanceConfigOf(env, cwd);
	if (isJsonString(config)) {
		return acceptanceResult("failed", USAGE_EXIT_CODE, { reason: config });
	}
	const handed = handedOf(env);
	let evidence: CheckEvidence = {};
	let last = acceptanceResult("failed", USAGE_EXIT_CODE, {
		reason: "no step ran",
	});
	for (const step of steps) {
		last = await STEPS[step](config, relay, handed);
		handed.set(`acceptance-${step}`, last.evidence);
		evidence = { ...evidence, ...last.evidence };
		if (last.outcome !== "passed") break;
	}
	return { ...last, evidence };
}
