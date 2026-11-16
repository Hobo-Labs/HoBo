import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { validateEvidenceReview } from "../lib/evidence-review.mts";

function seed(dir: string, review: Record<string, unknown>) {
	mkdirSync(dir, { recursive: true });
	// A TUI recording must be a real multi-event asciicast — a single buffered
	// frame is what the synthetic-cast guard rejects.
	writeFileSync(
		path.join(dir, "primary.cast"),
		[
			JSON.stringify({ version: 2, width: 80, height: 24 }),
			JSON.stringify([0.12, "o", "first frame"]),
			JSON.stringify([0.44, "o", "second frame"]),
			"",
		].join("\n"),
	);
	writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
		driver: "tui",
		degraded: false,
		claims: [{ id: "claim-1", text: "When I start the product" }],
		primary: { file: "primary.cast", kind: "recording", sha256: "abc", bytes: 4 },
	}));
	writeFileSync(path.join(dir, "review.json"), JSON.stringify(review));
}

describe("evidence review gate", () => {
	it("accepts reviewed, complete, hash-matched replay evidence", () => {
		const root = mkdtempSync(path.join(tmpdir(), "oxp-review-"));
		try {
			seed(root, {
				status: "accepted", reviewer: "qa", relevance: "relevant",
				completeness: "complete", coverageMode: "full-journey",
				coveredClaims: ["claim-1"], artifactSha256: "abc",
				notes: "Playback covers the complete command and visible outcome.",
			});
			assert.deepEqual(validateEvidenceReview(root), []);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects evidence that exists but is pending or incomplete", () => {
		const root = mkdtempSync(path.join(tmpdir(), "oxp-review-"));
		try {
			seed(root, {
				status: "pending", reviewer: "", relevance: "pending",
				completeness: "partial", coverageMode: "single-state",
				coveredClaims: [], artifactSha256: "wrong",
			});
			const problems = validateEvidenceReview(root);
			assert.ok(problems.includes("evidence_review_not_accepted"));
			assert.ok(problems.includes("evidence_not_marked_complete_full_journey"));
			assert.ok(problems.includes("review_artifact_hash_mismatch"));
			assert.ok(problems.includes("evidence_claim_uncovered:claim-1"));
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});

describe("synthetic recording guard", () => {
	it("rejects a one-event cast masquerading as a TUI recording", () => {
		const root = mkdtempSync(path.join(tmpdir(), "oxp-synthetic-"));
		try {
			mkdirSync(root, { recursive: true });
			writeFileSync(
				path.join(root, "primary.cast"),
				[
					JSON.stringify({ version: 2, width: 80, height: 24 }),
					JSON.stringify([0.9, "o", "everything at once"]),
					"",
				].join("\n"),
			);
			writeFileSync(
				path.join(root, "meta.json"),
				JSON.stringify({
					driver: "tui",
					degraded: false,
					claims: [],
					primary: {
						file: "primary.cast",
						kind: "recording",
						sha256: "abc",
						bytes: 4,
					},
				}),
			);
			writeFileSync(
				path.join(root, "review.json"),
				JSON.stringify({
					status: "accepted",
					reviewer: "qa",
					relevance: "relevant",
					completeness: "complete",
					coverageMode: "full-journey",
					coveredClaims: [],
					artifactSha256: "abc",
					notes: "playback shows the whole journey end to end",
				}),
			);
			assert.deepEqual(validateEvidenceReview(root), [
				"tui_recording_is_synthetic_single_event",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
