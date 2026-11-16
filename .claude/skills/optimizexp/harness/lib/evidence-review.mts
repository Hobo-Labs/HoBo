import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type EvidenceClaim = { id: string; text: string };

export type EvidenceReview = {
	status?: "pending" | "accepted" | "rejected";
	reviewer?: string;
	relevance?: "relevant" | "irrelevant";
	completeness?: "complete" | "partial";
	coverageMode?: "full-journey" | "single-state";
	coveredClaims?: string[];
	artifactSha256?: string;
	reviewedAt?: string;
	notes?: string;
};

type EvidenceMeta = {
	driver?: string;
	degraded?: boolean;
	claims?: EvidenceClaim[];
	primary?: { file?: string; kind?: string; sha256?: string; bytes?: number };
};

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

export function validateEvidenceReview(dir: string): string[] {
	const problems: string[] = [];
	const meta = readJson<EvidenceMeta>(path.join(dir, "meta.json"));
	if (!meta) return ["meta_json_missing_or_invalid"];
	const review = readJson<EvidenceReview>(path.join(dir, "review.json"));
	if (!review) return ["evidence_review_missing_or_invalid"];
	const primary = meta.primary;
	if (!primary?.file || !existsSync(path.join(dir, primary.file))) {
		problems.push("primary_artifact_missing");
	}
	if (!primary?.sha256 || primary.sha256 !== review.artifactSha256) {
		problems.push("review_artifact_hash_mismatch");
	}
	if (review.status !== "accepted") problems.push("evidence_review_not_accepted");
	if (!review.reviewer?.trim()) problems.push("evidence_review_reviewer_missing");
	if (review.relevance !== "relevant") problems.push("evidence_not_marked_relevant");
	if (review.completeness !== "complete" || review.coverageMode !== "full-journey") {
		problems.push("evidence_not_marked_complete_full_journey");
	}
	if (!review.notes?.trim() || review.notes.trim().length < 20) {
		problems.push("evidence_review_notes_missing_or_too_short");
	}
	if (meta.degraded) problems.push("degraded_capture_not_acceptable_proof");
	const claims = meta.claims ?? [];
	const covered = new Set(review.coveredClaims ?? []);
	for (const claim of claims) {
		if (!covered.has(claim.id)) problems.push(`evidence_claim_uncovered:${claim.id}`);
	}
	const driver = meta.driver ?? "";
	const kind = primary?.kind ?? "";
	// TUI claims need a real timed recording — a buffered transcript wearing a
	// .cast extension is how a frozen shell once got certified as replayable.
	if (driver === "tui" && kind !== "recording") {
		problems.push("tui_requires_replayable_recording");
	}
	if (driver === "tui" && kind === "recording" && primary?.file === "primary.cast") {
		// A one-event cast is a synthetic buffer, not a recording.
		const castPath = path.join(dir, primary.file);
		if (existsSync(castPath)) {
			const events = readFileSync(castPath, "utf8")
				.split("\n")
				.filter((l) => l.trim().startsWith("[")).length;
			if (events < 2) problems.push("tui_recording_is_synthetic_single_event");
		}
	}
	// CLI one-shot evidence is honest as a transcript (exit code + full output).
	if (driver === "cli" && kind !== "transcript" && kind !== "recording") {
		problems.push("cli_requires_transcript_or_recording");
	}
	if ((driver === "web" || driver === "native") && claims.length > 1 && !["video", "gif"].includes(kind)) {
		problems.push(`${driver}_multi_step_scenario_requires_video_or_gif`);
	}
	return [...new Set(problems)];
}
