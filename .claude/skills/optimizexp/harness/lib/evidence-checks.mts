/**
 * Programmatic evaluation of scorecard evidence: cited evidenceRefs must exist
 * and every evidenceChecks rubric entry is executed against the captured
 * evidence artifact (meta.json + primary transcript). Fail-closed: any missing
 * artifact, unreadable meta, or failing assertion is a validation problem.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { EvidenceCheck, MetricScorecard } from "./scorecard.mts";

function resolveRef(root: string, ref: string): string {
	return path.isAbsolute(ref) ? ref : path.join(root, ref);
}

type EvidenceMeta = {
	exitCode?: number | null;
	primary?: { file?: string };
	timing?: {
		durationMs?: number;
		timeToFirstOutputMs?: number | null;
	};
	frameStats?: {
		maxSilentGapMs?: number | null;
		totalOutputBytes?: number;
	};
};

function evaluateEvidenceCheck(
	check: EvidenceCheck,
	root: string,
	prefix: string,
): string[] {
	const dir = resolveRef(root, check.evidence);
	if (!existsSync(dir)) {
		return [`${prefix}: evidence_missing:${check.evidence}`];
	}
	const metaPath = path.join(dir, "meta.json");
	if (!existsSync(metaPath)) {
		return [`${prefix}: meta_json_missing:${check.evidence}`];
	}
	let meta: EvidenceMeta;
	try {
		meta = JSON.parse(readFileSync(metaPath, "utf8")) as EvidenceMeta;
	} catch {
		return [`${prefix}: meta_json_invalid:${check.evidence}`];
	}
	const problems: string[] = [];
	if (check.exitCodeEquals !== undefined && meta.exitCode !== check.exitCodeEquals) {
		problems.push(
			`${prefix}: exitCode ${String(meta.exitCode)} must equal ${check.exitCodeEquals}`,
		);
	}
	if (
		check.exitCodeNotEquals !== undefined &&
		meta.exitCode === check.exitCodeNotEquals
	) {
		problems.push(`${prefix}: exitCode must not equal ${check.exitCodeNotEquals}`);
	}
	// Perceptual budgets: falsifiable "feel" — timings captured by the drivers.
	if (check.durationUnderMs !== undefined) {
		const v = meta.timing?.durationMs;
		if (typeof v !== "number") {
			problems.push(`${prefix}: timing.durationMs missing (re-capture with current drivers)`);
		} else if (v >= check.durationUnderMs) {
			problems.push(`${prefix}: durationMs ${v} must be < ${check.durationUnderMs}`);
		}
	}
	if (check.firstOutputUnderMs !== undefined) {
		const v = meta.timing?.timeToFirstOutputMs;
		if (typeof v !== "number") {
			problems.push(`${prefix}: timing.timeToFirstOutputMs missing — no first output observed`);
		} else if (v >= check.firstOutputUnderMs) {
			problems.push(`${prefix}: timeToFirstOutputMs ${v} must be < ${check.firstOutputUnderMs}`);
		}
	}
	if (check.maxSilentGapUnderMs !== undefined) {
		const v = meta.frameStats?.maxSilentGapMs;
		if (typeof v !== "number") {
			problems.push(`${prefix}: frameStats.maxSilentGapMs missing — needs a real TUI recording`);
		} else if (v >= check.maxSilentGapUnderMs) {
			problems.push(`${prefix}: maxSilentGapMs ${v} must be < ${check.maxSilentGapUnderMs}`);
		}
	}
	if (check.totalOutputBytesUnder !== undefined) {
		const v = meta.frameStats?.totalOutputBytes;
		if (typeof v !== "number") {
			problems.push(`${prefix}: frameStats.totalOutputBytes missing — needs a real TUI recording`);
		} else if (v >= check.totalOutputBytesUnder) {
			problems.push(`${prefix}: totalOutputBytes ${v} must be < ${check.totalOutputBytesUnder}`);
		}
	}
	for (const [field, negate] of [
		["transcriptContains", false],
		["transcriptNotContains", true],
	] as const) {
		const pattern = check[field];
		if (pattern === undefined) continue;
		const primaryFile = meta.primary?.file;
		if (!primaryFile) {
			problems.push(`${prefix}: no primary transcript for ${field}`);
			continue;
		}
		let content: string;
		try {
			content = readFileSync(path.join(dir, primaryFile), "utf8");
		} catch {
			problems.push(`${prefix}: transcript_unreadable:${primaryFile}`);
			continue;
		}
		let re: RegExp;
		try {
			re = new RegExp(pattern);
		} catch {
			problems.push(`${prefix}: invalid regex: ${pattern}`);
			continue;
		}
		const found = re.test(content);
		if (!negate && !found) {
			problems.push(`${prefix}: transcript missing pattern /${pattern}/`);
		}
		if (negate && found) {
			problems.push(`${prefix}: transcript unexpectedly matches /${pattern}/`);
		}
	}
	return problems;
}

/**
 * Filesystem-backed evidence validation for a scorecard. `root` is the repo
 * root used to resolve relative refs. Returns [] when the card declares no
 * evidence fields or is missing.
 */
export function evaluateScorecardEvidence(
	card: unknown,
	root: string,
): string[] {
	if (!card || typeof card !== "object") return [];
	const s = card as Partial<MetricScorecard>;
	const problems: string[] = [];
	if (Array.isArray(s.evidenceRefs)) {
		for (const ref of s.evidenceRefs) {
			if (typeof ref !== "string" || ref.length === 0) {
				problems.push("evidenceRefs entries must be non-empty strings");
				continue;
			}
			if (!existsSync(resolveRef(root, ref))) {
				problems.push(`evidence_missing:${ref}`);
			}
		}
	}
	if (Array.isArray(s.evidenceChecks)) {
		s.evidenceChecks.forEach((check, i) => {
			if (!check || typeof check !== "object" || !check.evidence) return;
			problems.push(
				...evaluateEvidenceCheck(check, root, `evidenceChecks[${i}]`),
			);
		});
	}
	return problems;
}
