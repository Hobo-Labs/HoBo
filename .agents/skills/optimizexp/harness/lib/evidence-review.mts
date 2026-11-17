import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

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

type OpenResult = { fd: number } | { problem: "missing" | "unsafe" | "unreadable" };

function openEvidenceFile(dir: string, file: unknown, root?: string): OpenResult {
	if (file === undefined || file === null || file === "") return { problem: "missing" };
	if (typeof file !== "string" || path.isAbsolute(file) || path.win32.parse(file).root ||
		file.includes("\\") || file.includes(":") || [...file].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
		file.split("/").some((part) => !part || part === "." || part === "..")) return { problem: "unsafe" };
	const scenario = path.resolve(dir);
	const marker = `${path.sep}.optimizexp${path.sep}`;
	const index = scenario.lastIndexOf(marker);
	const anchor = root ? path.resolve(root) : index >= 0
		? scenario.slice(0, index) || path.parse(scenario).root
		: path.dirname(scenario);
	const relativeScenario = path.relative(anchor, scenario);
	if (relativeScenario === ".." || relativeScenario.startsWith(`..${path.sep}`) || path.isAbsolute(relativeScenario)) return { problem: "unsafe" };
	let current = anchor;
	const directories = relativeScenario.split(path.sep).filter(Boolean);
	try {
		for (const component of directories) {
			current = path.join(current, component);
			const info = lstatSync(current);
			if (info.isSymbolicLink() || !info.isDirectory()) return { problem: "unsafe" };
		}
		const parts = file.split("/");
		for (const [index, component] of parts.entries()) {
			current = path.join(current, component);
			const info = lstatSync(current);
			if (info.isSymbolicLink()) return { problem: "unsafe" };
			if (index < parts.length - 1) {
				if (!info.isDirectory()) return { problem: "unsafe" };
			} else {
				if (!info.isFile() || info.nlink > 1) return { problem: "unsafe" };
				const fd = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				let opened: ReturnType<typeof fstatSync>;
				try {
					opened = fstatSync(fd);
				} catch (error) {
					closeSync(fd);
					throw error;
				}
				if (opened.isFile() && opened.nlink <= 1 && opened.dev === info.dev && opened.ino === info.ino) return { fd };
				closeSync(fd);
				return { problem: "unsafe" };
			}
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { problem: "missing" };
		return { problem: "unreadable" };
	}
	return { problem: "unsafe" };
}

function readJson<T>(dir: string, file: string, root?: string): T | null {
	const opened = openEvidenceFile(dir, file, root);
	if ("problem" in opened) return null;
	try {
		return JSON.parse(readFileSync(opened.fd, "utf8")) as T;
	} catch {
		return null;
	} finally {
		closeSync(opened.fd);
	}
}

function inspectArtifact(dir: string, root?: string): { meta: EvidenceMeta | null; problems: string[]; castEvents?: number } {
	const problems: string[] = [];
	const meta = readJson<EvidenceMeta>(dir, "meta.json", root);
	if (!meta) return { meta: null, problems: ["meta_json_missing_or_invalid"] };
	const primary = meta.primary;
	const manifest = readJson<{ primaryPath?: string; kind?: string }>(dir, "manifest.json", root);
	if (!manifest) problems.push("manifest_json_missing_or_invalid");
	else {
		if (manifest.primaryPath !== primary?.file) problems.push("manifest_primary_mismatch");
		if (manifest.kind !== primary?.kind) problems.push("manifest_kind_mismatch");
	}
	const opened = openEvidenceFile(dir, primary?.file, root);
	if ("problem" in opened) {
		problems.push(`primary_artifact_${opened.problem}`);
		return { meta, problems };
	}
	let castEvents = 0;
	let atLineStart = true;
	const countCast = meta.driver === "tui" && primary?.kind === "recording" && typeof primary.file === "string" && /\.cast$/i.test(primary.file);
	const decoder = new StringDecoder("utf8");
	const consumeCast = (text: string) => {
		for (const char of text) {
			if (char === "\n") atLineStart = true;
			else if (atLineStart && !/\s/u.test(char)) {
				if (char === "[") castEvents++;
				atLineStart = false;
			}
		}
	};
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	try {
		for (;;) {
			const size = readSync(opened.fd, buffer, 0, buffer.length, null);
			if (size === 0) break;
			const chunk = buffer.subarray(0, size);
			hash.update(chunk);
			if (countCast) consumeCast(decoder.write(chunk));
		}
		if (countCast) consumeCast(decoder.end());
		if (!primary?.sha256 || hash.digest("hex") !== primary.sha256) problems.push("primary_artifact_hash_mismatch");
	} catch {
		problems.push("primary_artifact_unreadable");
	} finally {
		closeSync(opened.fd);
	}
	return { meta, problems, ...(countCast ? { castEvents } : {}) };
}

export function validateEvidenceArtifact(dir: string, root?: string): string[] {
	return inspectArtifact(dir, root).problems;
}

export function validateEvidenceReview(dir: string, root?: string, proposedReview?: EvidenceReview): string[] {
	const { meta, problems, castEvents } = inspectArtifact(dir, root);
	if (!meta) return problems;
	const review = proposedReview ?? readJson<EvidenceReview>(dir, "review.json", root);
	if (!review) return [...problems, "evidence_review_missing_or_invalid"];
	const primary = meta.primary;
	const proposedRejection = proposedReview?.status === "rejected";
	if (!primary?.sha256 || primary.sha256 !== review.artifactSha256) {
		problems.push("review_artifact_hash_mismatch");
	}
	if (review.status !== "accepted" && !proposedRejection) problems.push("evidence_review_not_accepted");
	if (typeof review.reviewer !== "string" || !review.reviewer.trim()) problems.push("evidence_review_reviewer_missing");
	if (proposedRejection) {
		if (review.relevance !== "relevant" && review.relevance !== "irrelevant") problems.push("evidence_relevance_invalid");
		if (review.completeness !== "complete" && review.completeness !== "partial") problems.push("evidence_completeness_invalid");
		if (review.coverageMode !== (review.completeness === "complete" ? "full-journey" : "single-state")) problems.push("evidence_coverage_mode_invalid");
		if (review.relevance === "relevant" && review.completeness === "complete") problems.push("evidence_rejection_requires_reason");
	} else {
		if (review.relevance !== "relevant") problems.push("evidence_not_marked_relevant");
		if (review.completeness !== "complete" || review.coverageMode !== "full-journey") problems.push("evidence_not_marked_complete_full_journey");
	}
	if (typeof review.notes !== "string" || review.notes.trim().length < 20) {
		problems.push("evidence_review_notes_missing_or_too_short");
	}
	if (meta.degraded && !proposedRejection) problems.push("degraded_capture_not_acceptable_proof");
	const claims = Array.isArray(meta.claims) ? meta.claims : [];
	if (meta.claims !== undefined && !Array.isArray(meta.claims)) problems.push("evidence_claims_invalid");
	const coveredClaims = Array.isArray(review.coveredClaims) ? review.coveredClaims : [];
	if (review.coveredClaims !== undefined && (!Array.isArray(review.coveredClaims) || coveredClaims.some((claim) => typeof claim !== "string"))) problems.push("evidence_covered_claims_invalid");
	const covered = new Set(coveredClaims);
	for (const claim of claims) {
		if (!claim || typeof claim.id !== "string" || !claim.id) {
			problems.push("evidence_claims_invalid");
			continue;
		}
		if (!proposedRejection && !covered.has(claim.id)) problems.push(`evidence_claim_uncovered:${claim.id}`);
	}
	if (proposedReview) for (const claim of coveredClaims) {
		if (!claims.some((known) => known?.id === claim)) problems.push(`evidence_claim_unknown:${claim}`);
	}
	const driver = meta.driver ?? "";
	const kind = primary?.kind ?? "";
	// TUI claims need a real timed recording — a buffered transcript wearing a
	// .cast extension is how a frozen shell once got certified as replayable.
	if (!proposedRejection && driver === "tui" && kind !== "recording") {
		problems.push("tui_requires_replayable_recording");
	}
	if (!proposedRejection && castEvents !== undefined && castEvents < 2) problems.push("tui_recording_is_synthetic_single_event");
	// CLI one-shot evidence is honest as a transcript (exit code + full output).
	if (!proposedRejection && driver === "cli" && kind !== "transcript" && kind !== "recording") {
		problems.push("cli_requires_transcript_or_recording");
	}
	if (!proposedRejection && (driver === "web" || driver === "native") && claims.length > 1 && !["video", "gif"].includes(kind)) {
		problems.push(`${driver}_multi_step_scenario_requires_video_or_gif`);
	}
	return [...new Set(problems)];
}
