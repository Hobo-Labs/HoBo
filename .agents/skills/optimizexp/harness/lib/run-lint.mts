/**
 * Run-claim verification: a run that claims completion (pareto-equilibrium /
 * plateau) must be backed by a committed minimal evidence bundle, or it is an
 * unauditable story. The bundle is deliberately minimal — scores chain +
 * sha-matched artifacts — not the regenerable narrative files.
 *
 * Minimal bundle for a completed run:
 *   - summary.md            (the claim)
 *   - baseline.json         (starting numbers)
 *   - iterations/N/scores.json  (≥1 — the numbers the claim rests on)
 *   - experiments/*.json before/after sha256s must match the committed files
 *   - evidence dirs cited in summary.md must pass evidence review integrity
 *
 * A run may be explicitly retired with `superseded.json`
 * ({ supersededBy, reason, at }) — reported as superseded, never verified.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { evaluateScorecardEvidence } from "./evidence-checks.mts";
import { validateEvidenceReview } from "./evidence-review.mts";

export type RunLintStatus =
	| "verified"
	| "superseded"
	| "failed"
	| "not-claiming";

export type RunLintResult = {
	runId: string;
	status: RunLintStatus;
	stopReason: string | null;
	problems: string[];
};

const COMPLETION_REASONS = new Set([
	"pareto-equilibrium",
	"plateau",
	"complete",
	"harm-floor",
]);

function sha256File(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

function stopReasonOf(summary: string): string | null {
	const m = summary.match(/stop reason:\s*`?([a-z][a-z-]*)`?/i);
	return m?.[1]?.toLowerCase() ?? null;
}

/** Evidence dirs cited in the summary (paths containing /evidence/<slug>). */
function citedEvidenceDirs(summary: string, repoRoot: string): string[] {
	const dirs = new Set<string>();
	const re = /[\w.@/-]*\.optimizexp\/features\/[\w-]+\/evidence\/[\w-]+/g;
	for (const match of summary.match(re) ?? []) {
		const abs = path.join(repoRoot, match);
		if (existsSync(abs) && statSync(abs).isDirectory()) dirs.add(abs);
		else if (existsSync(path.dirname(abs))) dirs.add(path.dirname(abs));
	}
	return [...dirs];
}

export interface LintRunOptions {
	readonly runDir: string;
	readonly repoRoot: string;
	/** Repo-relative tracked paths; when provided, bundle files must be committed. */
	readonly trackedFiles?: ReadonlySet<string>;
}

export function lintRun(options: LintRunOptions): RunLintResult {
	const { runDir, repoRoot, trackedFiles } = options;
	const runId = path.basename(runDir);
	const problems: string[] = [];

	const isTracked = (abs: string): boolean => {
		if (!trackedFiles) return existsSync(abs);
		return trackedFiles.has(path.relative(repoRoot, abs));
	};
	const requireBundleFile = (abs: string, label: string): boolean => {
		if (!existsSync(abs)) {
			problems.push(`${label} missing (${path.relative(repoRoot, abs)})`);
			return false;
		}
		if (!isTracked(abs)) {
			problems.push(
				`${label} not committed (${path.relative(repoRoot, abs)}) — claims must be auditable from a fresh clone`,
			);
			return false;
		}
		return true;
	};

	const superseded = readJson<{
		supersededBy?: string;
		reason?: string;
		at?: string;
	}>(path.join(runDir, "superseded.json"));
	if (superseded) {
		if (!superseded.supersededBy || !superseded.reason) {
			problems.push("superseded.json requires supersededBy and reason");
			return { runId, status: "failed", stopReason: null, problems };
		}
		return { runId, status: "superseded", stopReason: null, problems: [] };
	}

	const iterationsDir = path.join(runDir, "iterations");
	const scoreFiles: string[] = [];
	if (existsSync(iterationsDir)) {
		for (const iter of readdirSync(iterationsDir).sort()) {
			const scores = path.join(iterationsDir, iter, "scores.json");
			if (existsSync(scores)) scoreFiles.push(scores);
		}
	}

	// A falsifiability rubric is binding wherever it is written — a run that
	// declares evidenceChecks must have them re-execute green even if it makes
	// no completion claim. Otherwise "I didn't claim anything" would be a way
	// to publish budgets nobody ever checks.
	for (const scores of scoreFiles) {
		const card = readJson<Record<string, unknown>>(scores);
		if (!card) continue;
		for (const problem of evaluateScorecardEvidence(card, repoRoot)) {
			problems.push(`${path.relative(runDir, scores)}: ${problem}`);
		}
	}

	const summaryPath = path.join(runDir, "summary.md");
	if (!existsSync(summaryPath)) {
		return {
			runId,
			status: problems.length === 0 ? "not-claiming" : "failed",
			stopReason: null,
			problems,
		};
	}
	const summary = readFileSync(summaryPath, "utf8");
	const stopReason = stopReasonOf(summary);
	if (!stopReason || !COMPLETION_REASONS.has(stopReason)) {
		return {
			runId,
			status: problems.length === 0 ? "not-claiming" : "failed",
			stopReason,
			problems,
		};
	}

	// Numbers the claim rests on must be committed.
	requireBundleFile(path.join(runDir, "baseline.json"), "baseline.json");
	if (scoreFiles.length === 0) {
		problems.push(
			`no iterations/*/scores.json — "${stopReason}" is unauditable without the scored measurements`,
		);
	}
	for (const scores of scoreFiles) {
		requireBundleFile(scores, path.relative(runDir, scores));
	}

	// 2. Experiment chain: cited before/after artifacts must match by sha256.
	if (existsSync(iterationsDir)) {
		for (const iter of readdirSync(iterationsDir).sort()) {
			const expDir = path.join(iterationsDir, iter, "experiments");
			if (!existsSync(expDir)) continue;
			for (const file of readdirSync(expDir).filter((f) => f.endsWith(".json"))) {
				const experiment = readJson<{
					before?: { path?: string; sha256?: string };
					after?: { path?: string; sha256?: string };
				}>(path.join(expDir, file));
				for (const side of ["before", "after"] as const) {
					const cite = experiment?.[side];
					if (!cite?.path || !cite.sha256) continue;
					const abs = path.join(repoRoot, cite.path);
					if (!requireBundleFile(abs, `${file} ${side} scores`)) continue;
					const actual = sha256File(abs);
					if (actual !== cite.sha256) {
						problems.push(
							`${file}: ${side} sha256 mismatch for ${cite.path} (cited ${cite.sha256.slice(0, 8)}…, actual ${actual.slice(0, 8)}…)`,
						);
					}
				}
			}
		}
	}

	// 3. Baseline-copy detection: final scores identical to baseline without
	//    justification means the "flat" claim was never re-measured.
	const baseline = readJson<Record<string, unknown>>(
		path.join(runDir, "baseline.json"),
	);
	const final = scoreFiles.length
		? readJson<Record<string, unknown>>(scoreFiles[scoreFiles.length - 1]!)
		: null;
	if (baseline && final) {
		const strip = (o: Record<string, unknown>) => {
			const { scoredAt, iteration, vsBaseline, justification, ...rest } = o;
			return JSON.stringify(rest);
		};
		if (
			strip(baseline) === strip(final) &&
			typeof final.justification !== "string"
		) {
			problems.push(
				"final scores.json is byte-identical to baseline.json without a justification",
			);
		}
	}

	// 4. Cited evidence must hold together (sha-matched, reviewed, replayable).
	for (const dir of citedEvidenceDirs(summary, repoRoot)) {
		const evidenceProblems = validateEvidenceReview(dir);
		for (const p of evidenceProblems) {
			problems.push(`${path.relative(repoRoot, dir)}: ${p}`);
		}
	}

	return {
		runId,
		status: problems.length === 0 ? "verified" : "failed",
		stopReason,
		problems,
	};
}

export function lintAllRuns(options: {
	readonly runsRoot: string;
	readonly repoRoot: string;
	readonly trackedFiles?: ReadonlySet<string>;
}): RunLintResult[] {
	const { runsRoot, repoRoot, trackedFiles } = options;
	if (!existsSync(runsRoot)) return [];
	const results: RunLintResult[] = [];
	for (const entry of readdirSync(runsRoot).sort()) {
		const dir = path.join(runsRoot, entry);
		if (!statSync(dir).isDirectory()) continue;
		results.push(
			lintRun({
				runDir: dir,
				repoRoot,
				...(trackedFiles !== undefined ? { trackedFiles } : {}),
			}),
		);
	}
	return results;
}
