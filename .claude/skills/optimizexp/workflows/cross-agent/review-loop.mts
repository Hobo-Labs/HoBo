#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import {
	validateComparison,
	validateScorecard,
	type MetricScorecard,
	type PrimaryScores,
} from "../../harness/lib/scorecard.mts";
import { evaluateScorecardEvidence } from "../../harness/lib/evidence-checks.mts";
import { validateEvidenceReview } from "../../harness/lib/evidence-review.mts";
import { listProjects } from "../../harness/lib/projects.mts";
import { evaluateDesignRelevance } from "../../harness/lib/design-council.mts";
import { inspectGitReviewSubject, runConsensusCommand } from "./consensus-loop.mts";

const INVOCATION_STOP_REASONS = new Set([
	"pareto-equilibrium",
	"inverted-u-peak",
	"delight-ceiling",
	"delight-passes-cap",
	"passes-cap",
	"harm-only-floor",
	"blocked",
	"user",
	"safety",
]);

const FORBIDDEN_STOP_REASONS = new Set([
	"plateau",
	"metrics-zero",
	"irreducible",
	"tests-pass",
	"wired",
	"product-green",
	"",
]);

type ScoreCell = {
	persona: string;
	surface: string;
	harms: number;
	friction: number;
	uncertainty: number;
};

type ScoresFile = {
	iteration: number;
	cells: ScoreCell[];
	metric_total: number;
	metric_max: number;
};

function repoRoot(explicit?: string): string {
	if (explicit && explicit.length > 0) {
		return path.resolve(explicit);
	}
	let dir = process.cwd();
	for (;;) {
		if (existsSync(path.join(dir, ".optimizexp"))) return dir;
		if (existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return process.cwd();
		dir = parent;
	}
}

function parseArgs(argv: string[]) {
	const out: Record<string, string | boolean> = { mode: "help" };
	const names: Record<string, string> = {
		"--mode": "mode", "--root": "root", "--run": "run", "--run-id": "run",
		"--persona": "persona", "--feature": "feature", "--scores": "scores",
		"--prev-scores": "prevScores", "--limit": "limit",
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--help" || arg === "-h") out.mode = "help";
		else if (arg === "--mismatches-only") out.mismatchesOnly = true;
		else if (names[arg]) out[names[arg]!] = argv[++i] ?? "";
		else if (!arg.startsWith("-") && out.mode === "help") out.mode = arg;
	}
	return out;
}

function help() {
	console.log(`Inspect historical OptimizeXP records:
  review-loop.mts --mode validate-bus [--root <path>]
  review-loop.mts --mode read-bus [--run <id>] [--limit N] [--mismatches-only]
  review-loop.mts --mode status --run <id>

For new work, follow the OptimizeXP skill and implement improvements directly.`);
}

function runDirOf(root: string, runId: string): string {
	return path.join(root, ".optimizexp", "runs", runId);
}

function readScope(
	root: string,
	runId: string,
): Record<string, unknown> | null {
	const p = path.join(runDirOf(root, runId), "scope.json");
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

type BusEntry = {
	kind?: string;
	id?: string;
	runId?: string;
	persona?: string;
	featureId?: string;
	expects?: string;
	actId?: string;
	correctedFrom?: string;
	lessons?: string[];
	scores?: MetricScorecard;
	comparison?: {
		matchedExpectation?: boolean;
		deltaFromExpect?: {
			harms?: number;
			friction?: number;
			uncertainty?: number;
			total?: number;
			max?: number;
		};
	};
	feelings?: { summary?: string };
	file?: string;
};

function modeReadBus(args: Record<string, string | boolean>, root: string) {
	const dir = path.join(root, ".optimizexp", "bus", "entries");
	if (!existsSync(dir)) {
		console.log(
			JSON.stringify({ ok: true, entries: 0, mismatches: 0, lessons: [] }, null, 2),
		);
		return;
	}
	const runId = String(args.run || "");
	const persona = String(args.persona || "");
	const feature = String(args.feature || "");
	const limit = Math.max(1, Number(args.limit || 20));
	const mismatchesOnly = args.mismatchesOnly === "1" || args.mismatchesOnly === true;

	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort();
	const entries: BusEntry[] = [];
	for (const f of files) {
		try {
			const body = JSON.parse(
				readFileSync(path.join(dir, f), "utf8"),
			) as BusEntry;
			body.file = f;
			entries.push(body);
		} catch {
		}
	}

	let filtered = entries;
	if (runId) filtered = filtered.filter((e) => e.runId === runId);
	if (persona) filtered = filtered.filter((e) => e.persona === persona);
	if (feature) filtered = filtered.filter((e) => e.featureId === feature);

	const outcomes = filtered.filter((e) => e.kind === "outcome");
	const lessons: unknown[] = [];
	let mismatchCount = 0;
	for (const o of outcomes) {
		const delta = o.comparison?.deltaFromExpect;
		const matched = o.comparison?.matchedExpectation;
		const isMismatch =
			matched === false ||
			(typeof delta?.total === "number" && delta.total > 0);
		if (isMismatch) mismatchCount++;
		if (mismatchesOnly && !isMismatch) continue;
		const judged = o.scores?.primary;
		lessons.push({
			outcomeId: o.id,
			expectId: o.expects,
			actId: o.actId,
			persona: o.persona,
			featureId: o.featureId,
			runId: o.runId,
			file: o.file,
			matchedExpectation: matched ?? null,
			deltaFromExpect: delta ?? null,
			judged: judged
				? {
						harms: judged.harms,
						friction: judged.friction,
						uncertainty: judged.uncertainty,
						total: judged.total,
						max: judged.max,
					}
				: null,
			feelingsSummary: o.feelings?.summary ?? null,
			suggestedPredict: judged
				? {
						harms: judged.harms,
						friction: judged.friction,
						uncertainty: judged.uncertainty,
					}
				: null,
		});
	}

	const sliced = lessons.slice(-limit);
	const correctedExpects = filtered.filter(
		(e) => e.kind === "expect" && e.correctedFrom,
	).length;

	console.log(
		JSON.stringify(
			{
				ok: true,
				entries: filtered.length,
				outcomes: outcomes.length,
				mismatches: mismatchCount,
				correctedExpects,
				filters: {
					runId: runId || null,
					persona: persona || null,
					feature: feature || null,
					mismatchesOnly,
					limit,
				},
				lessons: sliced,
				guidance: "Historical records only; implement new improvements directly.",
			},
			null,
			2,
		),
	);
}

function aggregate(cells: ScoreCell[]): ScoresFile {
	let metric_total = 0;
	let metric_max = 0;
	for (const c of cells) {
		for (const k of ["harms", "friction", "uncertainty"] as const) {
			const v = c[k];
			if (!Number.isInteger(v) || v < 0 || v > 5) {
				throw new Error(
					`invalid score ${k}=${v} for ${c.persona}/${c.surface}`,
				);
			}
			metric_total += v;
			metric_max = Math.max(metric_max, v);
		}
	}
	return { iteration: 0, cells, metric_total, metric_max };
}

function modeScore(scoresPath: string) {
	const raw = JSON.parse(readFileSync(scoresPath, "utf8")) as {
		iteration?: number;
		cells: ScoreCell[];
	};
	const result = aggregate(raw.cells ?? []);
	result.iteration = raw.iteration ?? 0;
	console.log(JSON.stringify(result, null, 2));
}

function modePlateau(currPath: string, prevPath: string) {
	const curr = JSON.parse(readFileSync(currPath, "utf8")) as ScoresFile;
	const prev = JSON.parse(readFileSync(prevPath, "utf8")) as ScoresFile;
	const plateau =
		curr.metric_total >= prev.metric_total &&
		curr.metric_max >= prev.metric_max;
	console.log(
		JSON.stringify(
			{
				plateau,
				prev: {
					metric_total: prev.metric_total,
					metric_max: prev.metric_max,
				},
				curr: {
					metric_total: curr.metric_total,
					metric_max: curr.metric_max,
				},
			},
			null,
			2,
		),
	);
	process.exitCode = plateau ? 0 : 1;
}

type BusBody = {
	kind?: string;
	id?: string;
	expects?: string;
	actId?: string;
	runId?: string;
	scores?: MetricScorecard;
	comparison?: unknown;
	persona?: string;
	correctedFrom?: string;
	lessons?: string[];
	surface?: { name?: string } | string;
};

type ExperimentCertificate = {
	runId?: string;
	iteration?: number;
	id?: string;
	regime?: string;
	reportOnly?: boolean;
	mutationKind?: string;
	affectedPaths?: string[];
	before?: { path?: string; sha256?: string; evidenceId?: string };
	after?: { path?: string; sha256?: string; evidenceId?: string };
	beforeOutcomeId?: string;
	afterOutcomeId?: string;
	result?: string;
	verifiedAt?: string;
};

function sha256File(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function validateExperimentCertificates(root: string, runId: string, reportOnly: boolean): string[] {
	if (reportOnly) return [];
	const runDir = runDirOf(root, runId);
	const experimentRoot = path.join(runDir, "iterations");
	if (!existsSync(experimentRoot)) return ["verified_experiment_missing"];
	const files: string[] = [];
	for (const iter of readdirSync(experimentRoot, { withFileTypes: true })) {
		if (!iter.isDirectory()) continue;
		const dir = path.join(experimentRoot, iter.name, "experiments");
		if (existsSync(dir)) {
			files.push(...readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f)));
		}
	}
	if (files.length === 0) return ["verified_experiment_missing"];
	const problems: string[] = [];
	let verified = 0;
	const outcomeIds = new Set<string>();
	const busDir = path.join(root, ".optimizexp", "bus", "entries");
	if (existsSync(busDir)) {
		for (const f of readdirSync(busDir).filter((x) => x.endsWith(".json"))) {
			try {
				const b = JSON.parse(readFileSync(path.join(busDir, f), "utf8")) as BusBody;
				if (b.runId === runId && b.kind === "outcome" && b.id) outcomeIds.add(b.id);
			} catch {   }
		}
	}
	for (const file of files) {
		const beforeProblems = problems.length;
		let cert: ExperimentCertificate;
		try { cert = JSON.parse(readFileSync(file, "utf8")) as ExperimentCertificate; }
		catch { problems.push(`${path.relative(runDir, file)}: invalid_json`); continue; }
		const label = path.relative(runDir, file);
		if (cert.runId !== runId) problems.push(`${label}: runId_mismatch`);
		if (!cert.id || !cert.mutationKind || !cert.verifiedAt) problems.push(`${label}: certificate_metadata_missing`);
		if (cert.reportOnly === true) problems.push(`${label}: report_only_certificate`);
		if (!cert.before?.path || !cert.after?.path || !cert.before.sha256 || !cert.after.sha256) {
			problems.push(`${label}: before_after_digest_missing`);
		} else {
			for (const [name, state] of [["before", cert.before], ["after", cert.after]] as const) {
				const target = path.isAbsolute(state.path!) ? state.path! : path.join(root, state.path!);
				if (!existsSync(target)) problems.push(`${label}: ${name}_evidence_missing`);
				else if (sha256File(target) !== state.sha256) problems.push(`${label}: ${name}_digest_mismatch`);
			}
			if (cert.before.sha256 === cert.after.sha256) problems.push(`${label}: no_observable_change`);
		}
		if (!cert.afterOutcomeId || !outcomeIds.has(cert.afterOutcomeId)) problems.push(`${label}: post_change_outcome_missing`);
		if (!["improved", "no-improve", "regressed", "rejected"].includes(cert.result ?? "")) problems.push(`${label}: invalid_result`);
		if (problems.length === beforeProblems) verified++;
	}
	if (verified === 0) problems.push("verified_experiment_missing");
	return [...new Set(problems)];
}

function modeValidateBus(root: string) {
	const dir = path.join(root, ".optimizexp", "bus", "entries");
	if (!existsSync(dir)) {
		console.log(JSON.stringify({ ok: true, entries: 0, problems: [] }));
		return;
	}
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort();
	const problems: string[] = [];
	const expects = new Map<string, BusBody>();
	const acts = new Map<string, BusBody>();
	const outcomes: BusBody[] = [];
	const parsed = new Map<string, BusBody>();
	for (const f of files) {
		const p = path.join(dir, f);
		let body: BusBody;
		try {
			const value: unknown = JSON.parse(readFileSync(p, "utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				problems.push(`${f}: expected a JSON object`);
				continue;
			}
			body = value as BusBody;
		} catch {
			problems.push(`${f}: invalid JSON`);
			continue;
		}
		parsed.set(f, body);
		if (!body.id) problems.push(`${f}: missing id`);
		const kind = body.kind;
		if (kind === "council") continue;
		if (kind === "survey") {
			if (!body.runId) problems.push(`${f}: survey missing runId`);
			continue;
		}
		if (kind !== "expect" && kind !== "act" && kind !== "outcome") {
			problems.push(`${f}: kind must be expect|act|outcome|survey`);
			continue;
		}
		problems.push(
			...validateScorecard(body.scores, kind).map((msg) => `${f}: ${msg}`),
		);
		problems.push(
			...evaluateScorecardEvidence(body.scores, root).map(
				(msg) => `${f}: ${msg}`,
			),
		);
		if (kind === "expect") {
			if (body.id) expects.set(body.id, body);
		} else if (kind === "act") {
			if (!body.expects) problems.push(`${f}: act missing expects`);
			if (body.id) acts.set(body.id, body);
		} else {
			outcomes.push(body);
			if (!body.expects) problems.push(`${f}: outcome missing expects`);
		}
	}
	const comparisonProblems: string[] = [];
	for (const [f, body] of parsed) {
		if (body.kind !== "outcome") continue;
		const expectPrimary = body.expects
			? (expects.get(body.expects)?.scores?.primary as PrimaryScores | undefined)
			: undefined;
		const actPrimary = body.actId
			? (acts.get(body.actId)?.scores?.primary as PrimaryScores | undefined)
			: undefined;
		if (body.expects && !expects.has(body.expects)) {
			comparisonProblems.push(
				`${f}: outcome expects unknown ${body.expects}`,
			);
		}
		if (body.actId && !acts.has(body.actId)) {
			comparisonProblems.push(`${f}: outcome actId unknown ${body.actId}`);
		}
		comparisonProblems.push(
			...validateComparison(
				body.comparison,
				expectPrimary,
				actPrimary,
				body.scores?.primary as PrimaryScores | undefined,
			).map((msg) => `${f}: ${msg}`),
		);
	}
	const council = runConsensusCommand(["--mode", "validate", "--root", root]);
	const councilProblems = Array.isArray(council.output.problems)
		? council.output.problems.map((problem) => `council: ${String(problem)}`)
		: council.exitCode === 0 ? [] : [`council: ${String(council.output.error ?? "validation failed")}`];
	const allProblems = [...problems, ...comparisonProblems, ...councilProblems];

	for (const [id, act] of acts) {
		if (act.expects && !expects.has(act.expects)) {
			allProblems.push(`act ${id} expects unknown ${act.expects}`);
		}
	}

	const matched = new Set(
		outcomes.map((o) => o.expects).filter(Boolean) as string[],
	);
	const open = [...expects.keys()].filter((id) => !matched.has(id));
	const ok = allProblems.length === 0;
	console.log(
		JSON.stringify(
			{
				ok,
				entries: files.length,
				councilStates: council.output.states ?? 0,
				councilEntries: council.output.councilEntries ?? 0,
				expects: expects.size,
				acts: acts.size,
				outcomes: outcomes.length,
				openExpects: open,
				problems: allProblems,
			},
			null,
			2,
		),
	);
	if (!ok) process.exitCode = 1;
}

function listIterationDirs(runDir: string): string[] {
	const iterRoot = path.join(runDir, "iterations");
	if (!existsSync(iterRoot)) return [];
	return readdirSync(iterRoot, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
}

function scoresEquivalent(
	a: ScoresFile & { justification?: string },
	b: ScoresFile & { justification?: string },
): boolean {
	if (a.metric_total !== b.metric_total || a.metric_max !== b.metric_max) {
		return false;
	}
	const ac = Array.isArray(a.cells) ? a.cells : [];
	const bc = Array.isArray(b.cells) ? b.cells : [];
	if (ac.length !== bc.length) return false;
	const key = (c: ScoreCell) =>
		`${c.persona}|${c.surface}|${c.harms}|${c.friction}|${c.uncertainty}`;
	const as = ac.map(key).sort();
	const bs = bc.map(key).sort();
	return as.every((k, i) => k === bs[i]);
}

function lintCopiedScores(root: string, runId: string): string[] {
	const runDir = runDirOf(root, runId);
	const baselinePath = path.join(runDir, "baseline.json");
	if (!existsSync(baselinePath)) return [];
	const baselineRaw = readFileSync(baselinePath, "utf8");
	let baseline: ScoresFile & { justification?: string };
	try {
		baseline = JSON.parse(baselineRaw) as typeof baseline;
	} catch {
		return [];
	}
	const problems: string[] = [];
	for (const iter of listIterationDirs(runDir)) {
		const scoresPath = path.join(runDir, "iterations", iter, "scores.json");
		if (!existsSync(scoresPath)) continue;
		const raw = readFileSync(scoresPath, "utf8");
		let card: ScoresFile & { justification?: string };
		try {
			card = JSON.parse(raw) as typeof card;
		} catch {
			continue;
		}
		const justification =
			typeof card.justification === "string" ? card.justification.trim() : "";
		if (justification) continue;
		if (raw === baselineRaw || scoresEquivalent(baseline, card)) {
			problems.push(
				`copied_scores_without_justification:iterations/${iter}/scores.json`,
			);
		}
	}
	return problems;
}

function countBusTriples(root: string, runId: string): {
	expects: number;
	acts: number;
	outcomes: number;
	completeTriples: number;
} {
	const dir = path.join(root, ".optimizexp", "bus", "entries");
	if (!existsSync(dir)) {
		return { expects: 0, acts: 0, outcomes: 0, completeTriples: 0 };
	}
	const expects = new Set<string>();
	const actsByExpect = new Map<string, string>();
	const outcomesByAct = new Set<string>();
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
		let body: BusBody;
		try {
			body = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as BusBody;
		} catch {
			continue;
		}
		if (body.runId !== runId) continue;
		if (body.kind === "expect" && body.id) expects.add(body.id);
		if (body.kind === "act" && body.expects && body.id) {
			actsByExpect.set(body.expects, body.id);
		}
		if (body.kind === "outcome" && body.actId) {
			outcomesByAct.add(body.actId);
		}
	}
	let completeTriples = 0;
	for (const expId of expects) {
		const actId = actsByExpect.get(expId);
		if (actId && outcomesByAct.has(actId)) completeTriples++;
	}
	return {
		expects: expects.size,
		acts: actsByExpect.size,
		outcomes: outcomesByAct.size,
		completeTriples,
	};
}

function validateBusForRun(root: string, runId: string): string[] {
	const dir = path.join(root, ".optimizexp", "bus", "entries");
	if (!existsSync(dir)) return ["bus_missing"];
	const problems: string[] = [];
	const expects = new Map<string, BusBody>();
	const acts = new Map<string, BusBody>();
	const outcomes: BusBody[] = [];
	const pendingMismatches = new Map<string, string>();
	const cellKey = (body: BusBody) => `${body.persona ?? ""}|${typeof body.surface === "string" ? body.surface : body.surface?.name ?? ""}`;
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
		let body: BusBody;
		try { body = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as BusBody; }
		catch { problems.push(`${f}: invalid_json`); continue; }
		if (body.runId !== runId) continue;
		if (!body.id) problems.push(`${f}: missing_id`);
		if (body.kind === "survey") continue;
		if (body.kind === "council") continue;
		if (body.kind !== "expect" && body.kind !== "act" && body.kind !== "outcome") {
			problems.push(`${f}: invalid_kind`);
			continue;
		}
		problems.push(...validateScorecard(body.scores, body.kind).map((m) => `${f}: ${m}`));
		problems.push(...evaluateScorecardEvidence(body.scores, root).map((m) => `${f}: ${m}`));
		if (body.kind === "expect" && body.id) expects.set(body.id, body);
		if (body.kind === "expect") {
			const pending = pendingMismatches.get(cellKey(body));
			if (pending && body.correctedFrom !== pending && !(body.lessons && body.lessons.length > 0)) {
				problems.push(`${f}: mismatch_not_corrected:${pending}`);
			}
			if (body.correctedFrom === pending || (body.lessons && body.lessons.length > 0)) pendingMismatches.delete(cellKey(body));
		}
		if (body.kind === "act") {
			if (!body.expects) problems.push(`${f}: act_missing_expects`);
			if (body.id) acts.set(body.id, body);
		}
		if (body.kind === "outcome") {
			if (!body.expects) problems.push(`${f}: outcome_missing_expects`);
			outcomes.push(body);
			const mismatch = body.comparison && typeof body.comparison === "object" &&
				((body.comparison as { matchedExpectation?: boolean }).matchedExpectation === false ||
					Number((body.comparison as { deltaFromExpect?: { total?: number } }).deltaFromExpect?.total ?? 0) > 0);
			if (mismatch && body.id) pendingMismatches.set(cellKey(body), body.id);
		}
	}
	const matched = new Set<string>();
	for (const outcome of outcomes) {
		if (outcome.expects) matched.add(outcome.expects);
		if (!outcome.expects || !expects.has(outcome.expects)) problems.push("outcome_unknown_expect");
		if (outcome.actId && !acts.has(outcome.actId)) problems.push("outcome_unknown_act");
		const exp = outcome.expects ? expects.get(outcome.expects)?.scores?.primary : undefined;
		const act = outcome.actId ? acts.get(outcome.actId)?.scores?.primary : undefined;
		problems.push(...validateComparison(outcome.comparison, exp, act, outcome.scores?.primary).map((m) => `outcome: ${m}`));
	}
	for (const [id, act] of acts) if (act.expects && !expects.has(act.expects)) problems.push(`act ${id}: unknown_expect`);
	for (const id of expects.keys()) if (!matched.has(id)) problems.push(`open_expect:${id}`);
	return [...new Set(problems)];
}

function validateRequiredDesignerConsensus(
	root: string,
	runId: string,
	scope: Record<string, unknown>,
): string[] {
	const policyAware = scope.designerConsensusPolicy === "required-when-design-relevant" ||
		(scope.sdlcDesignReview !== null && typeof scope.sdlcDesignReview === "object");
	const raw = scope.designerConsensus;
	if (raw === undefined) return policyAware ? ["designer_consensus_decision_missing"] : [];
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return ["designer_consensus_config_invalid"];
	const config = raw as Record<string, unknown>;
	const configuredBaseRef = config.baseRef;
	if (configuredBaseRef !== undefined && (typeof configuredBaseRef !== "string" || configuredBaseRef.trim() === "")) return ["designer_consensus_base_ref_invalid"];
	const baseRef = typeof configuredBaseRef === "string" ? configuredBaseRef.trim() : "origin/main";
	if (config.required === false) {
		const changedPaths = Array.isArray(config.changedPaths) && config.changedPaths.every((item) => typeof item === "string") ? config.changedPaths as string[] : null;
		const acceptanceTags = config.acceptanceTags === undefined
			? []
			: Array.isArray(config.acceptanceTags) && config.acceptanceTags.every((item) => typeof item === "string") ? config.acceptanceTags as string[] : null;
		const explicitlyRequested = config.explicitlyRequested ?? false;
		const configuredPriorCycle = config.priorCouncilCycle ?? false;
		const exemption = config.exemption;
		if (!changedPaths || !acceptanceTags || typeof explicitlyRequested !== "boolean" || typeof configuredPriorCycle !== "boolean" || exemption === null || typeof exemption !== "object" || Array.isArray(exemption)) return ["designer_consensus_exemption_invalid"];
		const consensusDir = path.join(root, ".optimizexp", "runs", runId, "consensus");
		const priorCouncilCycle = configuredPriorCycle || (existsSync(consensusDir) && readdirSync(consensusDir, { withFileTypes: true }).some((entry) => entry.isDirectory() && existsSync(path.join(consensusDir, entry.name, "state.json"))));
		const decision = evaluateDesignRelevance({
			changedPaths,
			acceptanceTags,
			explicitlyRequested,
			priorCouncilCycle,
			exemption: exemption as { code: "internal-no-public-behavior"; justification: string },
		});
		if (decision.required || !decision.exemptionAccepted) return ["designer_consensus_exemption_rejected"];
		const baseSha = typeof config.baseSha === "string" ? config.baseSha.trim() : "";
		const headSha = typeof config.headSha === "string" ? config.headSha.trim() : "";
		if (!baseSha || !headSha) return ["designer_consensus_exemption_subject_missing"];
		const gitSubject = inspectGitReviewSubject(root, baseSha, headSha, baseRef);
		if (gitSubject.problems.length) return gitSubject.problems.map((problem) => `designer_consensus_${problem}`);
		if (gitSubject.available && JSON.stringify(gitSubject.changedPaths) !== JSON.stringify([...new Set(changedPaths)].sort())) return ["designer_consensus_exemption_paths_mismatch"];
		return [];
	}
	if (config.required !== true) return ["designer_consensus_required_invalid"];
	const reviewId = typeof config.reviewId === "string" ? config.reviewId.trim() : "";
	const baseSha = typeof config.baseSha === "string" ? config.baseSha.trim() : "";
	const headSha = typeof config.headSha === "string" ? config.headSha.trim() : "";
	const proposalPath = typeof config.proposalPath === "string" ? config.proposalPath.trim() : "";
	const missing = [!reviewId && "reviewId", !baseSha && "baseSha", !headSha && "headSha", !proposalPath && "proposalPath"].filter(Boolean);
	if (missing.length > 0) return missing.map((field) => `designer_consensus_${field}_missing`);
	const proposal = path.isAbsolute(proposalPath) ? proposalPath : path.join(root, proposalPath);
	if (!existsSync(proposal)) return ["designer_consensus_proposal_missing"];
	const validation = runConsensusCommand(["--mode", "validate", "--root", root, "--run", runId, "--review", reviewId]);
	if (validation.exitCode !== 0) {
		const problems = Array.isArray(validation.output.problems) ? validation.output.problems : [validation.output.invariant ?? validation.output.error ?? "invalid"];
		return problems.map((problem) => `designer_consensus_validation:${String(problem)}`);
	}
	const assertion = runConsensusCommand([
		"--mode", "assert-yay", "--root", root, "--run", runId, "--review", reviewId,
		"--base-sha", baseSha, "--head-sha", headSha, "--proposal", proposal, "--base-ref", baseRef,
	]);
	if (assertion.exitCode !== 0) return [`designer_consensus_assert:${String(assertion.output.invariant ?? assertion.output.error ?? "not-approved")}`];
	return [];
}

function modeStatus(args: Record<string, string | boolean>, root: string) {
	const runId = String(args.run || "");
	if (!runId) {
		console.error("--run required for status");
		process.exit(2);
	}
	const runDir = runDirOf(root, runId);
	const scope = readScope(root, runId);
	if (!scope) {
		console.log(
			JSON.stringify(
				{
					ok: false,
					runId,
					status: "missing",
					missing: ["scope.json"],
					guidance: "No historical record exists for this run.",
				},
				null,
				2,
			),
		);
		process.exitCode = 1;
		return;
	}
	const iters = listIterationDirs(runDir);
	const bus = countBusTriples(root, runId);
	const hasSummary = existsSync(path.join(runDir, "summary.md"));
	const incomplete = existsSync(path.join(runDir, "INCOMPLETE.md"));
	const out = {
		ok: true,
		runId,
		status: scope.status ?? "running",
		regime: scope.regime ?? "harm_reduce",
		regimesEntered: scope.regimesEntered ?? [],
		stopPolicy: scope.stopPolicy,
		stopReason: scope.stopReason ?? null,
		noDelight: Boolean(scope.noDelight),
		noSurvey: Boolean(scope.noSurvey),
		iterations: iters,
		bus,
		hasSummary,
		incompleteMarker: incomplete,
		lastShouldStop: scope.lastShouldStop ?? null,
		lastEquilibrium: scope.lastEquilibrium ?? null,
		guidance: "Historical records only; implement new improvements directly.",
	};
	console.log(JSON.stringify(out, null, 2));
	process.exitCode = scope.status === "complete" ? 0 : 1;
}

function modeAssertComplete(
	args: Record<string, string | boolean>,
	root: string,
) {
	const runId = String(args.run || "");
	if (!runId) {
		console.error("--run required for assert-complete");
		process.exit(2);
	}
	const runDir = runDirOf(root, runId);
	const missing: string[] = [];
	const scope = readScope(root, runId);
	if (!scope) {
		console.log(
			JSON.stringify(
				{
					ok: false,
					runId,
					status: "missing",
					missing: ["scope.json"],
					guidance: "No historical record exists for this run.",
				},
				null,
				2,
			),
		);
		process.exitCode = 1;
		return;
	}

	const noDelight = Boolean(scope.noDelight);
	const noSurvey = Boolean(scope.noSurvey);
	const stopPolicy = String(scope.stopPolicy || "");
	const status = String(scope.status || "running");
	const regimesEntered = Array.isArray(scope.regimesEntered)
		? (scope.regimesEntered as string[])
		: [];

	if (
		!stopPolicy.includes("pareto") &&
		!stopPolicy.includes("harm-floor") &&
		!stopPolicy.includes("finite")
	) {
		missing.push("stopPolicy_not_recognized");
	}
	if (stopPolicy === "infinite-until-zero-or-irreducible") {
		missing.push("stale_stopPolicy_metrics_zero_terminal");
	}

	const iters = listIterationDirs(runDir);
	if (iters.length === 0) missing.push("no_iterations");
	else {
		const last = iters[iters.length - 1]!;
		const scores = path.join(runDir, "iterations", last, "scores.json");
		const findings = path.join(runDir, "iterations", last, "findings.md");
		if (!existsSync(scores)) missing.push(`iterations/${last}/scores.json`);
		if (!existsSync(findings)) missing.push(`iterations/${last}/findings.md`);
	}

	const bus = countBusTriples(root, runId);
	if (bus.completeTriples < 1) {
		missing.push("bus_complete_triples_lt_1");
	}
	missing.push(...lintCopiedScores(root, runId));
	const busValidation = validateBusForRun(root, runId);
	missing.push(...busValidation);
	missing.push(...validateRequiredDesignerConsensus(root, runId, scope));
	missing.push(...validateExperimentCertificates(root, runId, Boolean(scope.reportOnly)));

	if (!scope.lastShouldStop) {
		missing.push("lastShouldStop_missing");
	}

	if (!noDelight) {
		if (!regimesEntered.includes("delight_maximize")) {
			missing.push("delight_regime_never_entered");
		}
		const lastEq = scope.lastEquilibrium as
			| { stop?: boolean; reason?: string }
			| null
			| undefined;
		const candidate = String(
			scope.candidateStopReason || scope.stopReason || "",
		);
		if (!lastEq?.stop && !scope.equilibrium) {
			missing.push("no_equilibrium_stop");
		} else if (
			candidate &&
			FORBIDDEN_STOP_REASONS.has(candidate)
		) {
			missing.push(`forbidden_stopReason:${candidate}`);
		} else if (
			candidate &&
			!INVOCATION_STOP_REASONS.has(candidate) &&
			lastEq?.reason &&
			!INVOCATION_STOP_REASONS.has(String(lastEq.reason))
		) {
			missing.push(`invalid_stopReason:${candidate || lastEq?.reason}`);
		}
	} else {
		const lastSs = scope.lastShouldStop as
			| { plateau?: boolean; reason?: string }
			| null
			| undefined;
		if (!lastSs?.plateau && String(scope.stopReason) !== "harm-only-floor") {
			missing.push("harm_only_floor_not_reached");
		}
	}

	if (!noSurvey) {
		const surveyDir = path.join(runDir, "survey");
		const runBacklog = path.join(runDir, "backlog.json");
		const globalBacklog = path.join(
			root,
			".optimizexp",
			"backlog",
			"experiments.json",
		);
		const hasSurvey =
			existsSync(surveyDir) &&
			readdirSync(surveyDir).some((f) => f.endsWith(".json") || f.endsWith(".md"));
		if (!hasSurvey && !scope.surveyCompleted) {
			missing.push("survey_missing");
		}
		if (!existsSync(runBacklog) && !existsSync(globalBacklog)) {
			missing.push("backlog_missing");
		}
	}

	const summaryPath = path.join(runDir, "summary.md");
	if (!existsSync(summaryPath)) {
		missing.push("summary_md");
	} else {
		const summary = readFileSync(summaryPath, "utf8");
		const reason =
			String(scope.stopReason || scope.candidateStopReason || "") ||
			(scope.lastEquilibrium as { reason?: string } | null)?.reason ||
			"";
		if (noDelight) {
			if (
				!/harm-only-floor|stopReason|stop reason/i.test(summary) &&
				reason !== "harm-only-floor"
			) {
				if (!scope.stopReason) missing.push("summary_or_scope_stopReason");
			}
		} else {
			const okReason =
				(reason && INVOCATION_STOP_REASONS.has(reason)) ||
				/pareto-equilibrium|inverted-u-peak|delight-ceiling/i.test(summary);
			if (!okReason) missing.push("summary_missing_valid_stopReason");
		}
		if (/tests pass|feature wired|product green/i.test(summary) &&
			!/pareto|equilibrium|harm-only-floor|assert-complete/i.test(summary)
		) {
			missing.push("summary_looks_like_product_only_completion");
		}
	}

	const featureIds = Array.isArray(scope.features)
		? (scope.features as string[])
		: [];
	const projectIds = Array.isArray(scope.projects)
		? (scope.projects as string[])
		: [];

	const projectPaths = new Map(listProjects(root).map((project) => [project.id, project.path]));
	for (const pid of projectIds) {
		if (pid === "root" || pid === "global") continue;
		const projectPath = projectPaths.get(pid);
		if (projectPath === undefined || !existsSync(path.join(root, projectPath, ".optimizexp", "surface-map.json"))) {
			missing.push(`surface_map_missing:${pid}`);
		}
	}

	const coveragePath = path.join(runDir, "feature-coverage.json");
	const coverageRequired = !Boolean(scope.reportOnly) || featureIds.length > 0;
	if (!existsSync(coveragePath) && coverageRequired) {
		missing.push("feature_coverage_missing");
	} else if (existsSync(coveragePath)) {
		try {
			const cov = JSON.parse(readFileSync(coveragePath, "utf8")) as {
				runId?: string;
				ok?: boolean;
				requiredP0Uncovered?: string[];
				quality?: {
					featuresWithoutRubberduck?: string[];
					featuresWithTemplateOnlySteps?: string[];
				};
			};
			if (cov.runId !== runId) missing.push("feature_coverage_runId_mismatch");
			if (cov.ok === false) missing.push("feature_coverage_not_clean");
			for (const g of cov.requiredP0Uncovered ?? []) {
				missing.push(`p0_uncovered:${g}`);
			}
			for (const g of cov.quality?.featuresWithoutRubberduck ?? []) {
				missing.push(`rubberduck_missing:${g}`);
			}
			for (const g of cov.quality?.featuresWithTemplateOnlySteps ?? []) {
				missing.push(`template_only_feature:${g}`);
			}
		} catch {
			missing.push("feature_coverage_invalid_json");
		}
	}

	const busDir = path.join(root, ".optimizexp", "bus", "entries");
	if (existsSync(busDir) && featureIds.length > 0) {
		const outcomes = readdirSync(busDir).filter(
			(f) => f.includes(runId) && f.endsWith("-outcome.json"),
		);
		let stamped = 0;
		for (const f of outcomes) {
			try {
				const body = JSON.parse(
					readFileSync(path.join(busDir, f), "utf8"),
				) as {
					evidence?: { path?: string; primary?: string };
				};
				const evPath = body.evidence?.path;
				if (!evPath) continue;
				const abs = path.isAbsolute(evPath)
					? evPath
					: path.join(root, evPath);
				const primary = body.evidence?.primary
					? path.join(abs, body.evidence.primary)
					: path.join(abs, "primary.txt");
				if (!existsSync(primary) && !existsSync(path.join(abs, "primary.cast"))) {
					missing.push(`evidence_missing:${path.relative(root, abs)}`);
					continue;
				}
				missing.push(
					...validateEvidenceReview(abs).map(
						(p) => `evidence_review:${path.relative(root, abs)}:${p}`,
					),
				);
				const metaP = path.join(abs, "meta.json");
				if (existsSync(metaP)) {
					const meta = JSON.parse(readFileSync(metaP, "utf8")) as {
						repro?: { via?: string };
					};
					if (meta.repro?.via === "capture-evidence") stamped += 1;
				}
			} catch {
			}
		}
		if (outcomes.length > 0 && stamped === 0) {
			missing.push("evidence_not_from_harness");
		}
	}

	const ready = missing.length === 0;
	const result = {
		ok: ready,
		runId,
		status,
		readyToMarkComplete: ready,
		stopPolicy,
		regime: scope.regime,
		regimesEntered,
		candidateStopReason:
			scope.stopReason ||
			scope.candidateStopReason ||
			(scope.lastEquilibrium as { reason?: string } | null)?.reason ||
			null,
		bus,
		iterations: iters,
		missing,
		guidance: "Historical records only; implement new improvements directly.",
	};
	console.log(JSON.stringify(result, null, 2));
	process.exitCode = ready ? 0 : 1;
}

function modeAggregateBus(root: string, runId: string) {
	const dir = path.join(root, ".optimizexp", "bus", "entries");
	if (!existsSync(dir)) {
		console.log(JSON.stringify({ ok: true, cells: [], metric_total: 0, metric_max: 0 }));
		return;
	}
	const cells: ScoreCell[] = [];
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
		const body = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as BusBody;
		if (body.kind !== "outcome") continue;
		if (runId && body.runId && body.runId !== runId) continue;
		const primary = body.scores?.primary;
		if (!primary) continue;
		const surface =
			typeof body.surface === "string"
				? body.surface
				: body.surface?.name || body.scores?.surface || "unknown";
		cells.push({
			persona: body.persona || body.scores?.persona || "unknown",
			surface,
			harms: primary.harms,
			friction: primary.friction,
			uncertainty: primary.uncertainty,
		});
	}
	const result = aggregate(cells);
	console.log(JSON.stringify({ ok: true, runId: runId || null, ...result }, null, 2));
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const root = repoRoot(
		typeof args.root === "string" ? args.root : undefined,
	);
	const mode = String(args.mode ?? "help");
	if (mode === "help") {
		help();
		return;
	}
	if (mode === "validate-bus") {
		modeValidateBus(root);
		return;
	}
	if (mode === "read-bus") {
		modeReadBus(args as Record<string, string | boolean>, root);
		return;
	}
	if (mode === "status") {
		modeStatus(args as Record<string, string | boolean>, root);
		return;
	}
	if (mode === "assert-complete") {
		modeAssertComplete(args as Record<string, string | boolean>, root);
		return;
	}
	if (mode === "aggregate-bus") {
		modeAggregateBus(root, String(args.run || ""));
		return;
	}
	if (mode === "score") {
		const scores = String(args.scores || "");
		if (!scores) {
			console.error("--scores required");
			process.exit(2);
		}
		modeScore(scores);
		return;
	}
	if (mode === "plateau") {
		const scores = String(args.scores || "");
		const prev = String(args.prevScores || "");
		if (!scores || !prev) {
			console.error("--scores and --prev-scores required");
			process.exit(2);
		}
		modePlateau(scores, prev);
		return;
	}
	console.error(`unknown mode: ${mode}`);
	help();
	process.exit(2);
}

main();
