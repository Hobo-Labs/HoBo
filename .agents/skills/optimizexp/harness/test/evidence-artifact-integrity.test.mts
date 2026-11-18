import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { validateEvidenceArtifact, validateEvidenceReview } from "../lib/evidence-review.mts";

const digest = (body: string) => createHash("sha256").update(body).digest("hex");

function fixture(run: (input: { dir: string; outside: string; meta: Record<string, unknown>; review: Record<string, unknown>; manifest: Record<string, unknown>; write: () => void }) => void): void {
	const root = mkdtempSync(path.join(tmpdir(), "hobo-evidence-integrity-"));
	const dir = path.join(root, ".optimizexp/features/demo/evidence/scenario");
	const outside = path.join(root, "outside.txt");
	mkdirSync(dir, { recursive: true });
	writeFileSync(outside, "unrelated file\n");
	const transcript = "command exited 1: expected failure\n";
	writeFileSync(path.join(dir, "primary.txt"), transcript);
	const meta = { driver: "cli", degraded: false, exitCode: 1, claims: [], primary: { file: "primary.txt", kind: "transcript", sha256: digest(transcript) } };
	const review = { status: "accepted", reviewer: "qa", relevance: "relevant", completeness: "complete", coverageMode: "full-journey", coveredClaims: [], artifactSha256: digest(transcript), notes: "The full expected failure is visible in the transcript." };
	const manifest = { primaryPath: "primary.txt", kind: "transcript" };
	const write = () => {
		writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
		writeFileSync(path.join(dir, "review.json"), JSON.stringify(review));
		writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
	};
	try { write(); run({ dir, outside, meta, review, manifest, write }); }
	finally { rmSync(root, { recursive: true, force: true }); }
}

describe("reviewed evidence artifact integrity", () => {
	it("accepts reviewed failure transcripts and allows pending artifacts to be shared", () => {
		fixture(({ dir, review, write }) => {
			assert.deepEqual(validateEvidenceArtifact(dir), []);
			assert.deepEqual(validateEvidenceReview(dir), []);
			review.status = "pending";
			write();
			assert.deepEqual(validateEvidenceArtifact(dir), []);
			assert.ok(validateEvidenceReview(dir).includes("evidence_review_not_accepted"));
			rmSync(path.join(dir, "review.json"));
			assert.deepEqual(validateEvidenceArtifact(dir), []);
			assert.ok(validateEvidenceReview(dir).includes("evidence_review_missing_or_invalid"));
		});
	});

	it("rejects modified bytes even when the stored metadata and review hashes still match", () => {
		fixture(({ dir }) => {
			writeFileSync(path.join(dir, "primary.txt"), "changed after review\n");
			assert.ok(validateEvidenceArtifact(dir).includes("primary_artifact_hash_mismatch"));
			assert.ok(validateEvidenceReview(dir).includes("primary_artifact_hash_mismatch"));
		});
	});

	it("verifies large artifacts and the review's separate digest", () => {
		fixture(({ dir, meta, review, write }) => {
			const body = "long reviewed transcript\n".repeat(10_000);
			writeFileSync(path.join(dir, "primary.txt"), body);
			(meta.primary as { sha256: string }).sha256 = digest(body);
			review.artifactSha256 = digest(body);
			write();
			assert.deepEqual(validateEvidenceReview(dir), []);
			review.artifactSha256 = digest("another review");
			write();
			assert.ok(validateEvidenceReview(dir).includes("review_artifact_hash_mismatch"));
		});
	});

	it("reports malformed claim and review fields without throwing", () => {
		fixture(({ dir, meta, review, write }) => {
			meta.claims = [null];
			review.reviewer = 42;
			review.notes = {};
			review.coveredClaims = {};
			write();
			const problems = validateEvidenceReview(dir);
			for (const problem of ["evidence_claims_invalid", "evidence_covered_claims_invalid", "evidence_review_reviewer_missing", "evidence_review_notes_missing_or_too_short"]) {
				assert.ok(problems.includes(problem), problem);
			}
		});
	});

	it("requires the posting manifest to name the reviewed primary and kind", () => {
		fixture(({ dir, manifest, write }) => {
			writeFileSync(path.join(dir, "alternate.txt"), "unreviewed\n");
			manifest.primaryPath = "alternate.txt";
			write();
			assert.ok(validateEvidenceArtifact(dir).includes("manifest_primary_mismatch"));
			assert.ok(validateEvidenceReview(dir).includes("manifest_primary_mismatch"));
			manifest.primaryPath = "primary.txt";
			manifest.kind = "image";
			write();
			assert.ok(validateEvidenceArtifact(dir).includes("manifest_kind_mismatch"));
		});
	});

	it("does not follow a symlinked scenario directory or metadata file", () => {
		fixture(({ dir, outside }) => {
			const alias = path.join(path.dirname(dir), "alias");
			symlinkSync(dir, alias, "dir");
			assert.ok(validateEvidenceArtifact(alias).includes("meta_json_missing_or_invalid"));
			rmSync(path.join(dir, "meta.json"));
			symlinkSync(outside, path.join(dir, "meta.json"));
			assert.ok(validateEvidenceArtifact(dir).includes("meta_json_missing_or_invalid"));
		});
	});

	it("rejects a scenario symlink even when its target has a Git marker", () => {
		fixture(({ dir, outside }) => {
			const target = `${outside}-directory`;
			mkdirSync(path.join(target, ".git"), { recursive: true });
			writeFileSync(path.join(target, "meta.json"), JSON.stringify({ primary: { file: "unrelated", kind: "transcript" } }));
			const alias = path.join(path.dirname(dir), "nested-marker");
			symlinkSync(target, alias, "dir");
			const root = path.resolve(dir, "../../../../..");
			assert.ok(validateEvidenceArtifact(alias).includes("meta_json_missing_or_invalid"));
			assert.ok(validateEvidenceArtifact(alias, root).includes("meta_json_missing_or_invalid"));
		});
	});

	it("refuses paths outside an explicitly trusted repository root", () => {
		fixture(({ dir, outside }) => {
			const otherRoot = `${outside}-root`;
			mkdirSync(otherRoot);
			assert.ok(validateEvidenceArtifact(dir, otherRoot).includes("meta_json_missing_or_invalid"));
		});
	});

	it("rejects invalid, escaping, symlinked and non-regular primary paths", () => {
		fixture(({ dir, outside, meta, manifest, write }) => {
			const primary = meta.primary as { file: string };
			for (const value of ["../outside.txt", "/tmp/outside.txt", "C:\\outside.txt", "nested/../primary.txt", "nested//primary.txt", "nested/\u0001file", "."]) {
				primary.file = value;
				manifest.primaryPath = value;
				write();
				assert.ok(validateEvidenceArtifact(dir).includes("primary_artifact_unsafe"), value);
			}
			for (const type of ["symlink", "hardlink", "directory"] as const) {
				const target = path.join(dir, "unsafe");
				if (type === "symlink") symlinkSync(outside, target);
				else if (type === "hardlink") linkSync(outside, target);
				else mkdirSync(target);
				primary.file = "unsafe";
				manifest.primaryPath = "unsafe";
				write();
				assert.ok(validateEvidenceArtifact(dir).includes("primary_artifact_unsafe"), type);
				rmSync(target, { recursive: type === "directory" });
			}
			symlinkSync(path.dirname(outside), path.join(dir, "linked"), "dir");
			primary.file = "linked/outside.txt";
			manifest.primaryPath = "linked/outside.txt";
			write();
			assert.ok(validateEvidenceReview(dir).includes("primary_artifact_unsafe"));
		});
	});

	it("only reads a safe cast and retains the single-event guard", () => {
		fixture(({ dir, meta, review, manifest, write }) => {
			const cast = '{"version":2}\n[0.1,"o","frame"]\n';
			writeFileSync(path.join(dir, "primary.cast"), cast);
			meta.driver = "tui";
			meta.primary = { file: "primary.cast", kind: "recording", sha256: digest(cast) };
			review.artifactSha256 = digest(cast);
			manifest.primaryPath = "primary.cast";
			manifest.kind = "recording";
			write();
			assert.deepEqual(validateEvidenceArtifact(dir), []);
			assert.deepEqual(validateEvidenceReview(dir), ["tui_recording_is_synthetic_single_event"]);
		});
	});

	it("counts cast events across long unterminated lines", () => {
		fixture(({ dir, meta, review, manifest, write }) => {
			const cast = `${" ".repeat(150_000)}[0.1,"o","first"]\n${" ".repeat(150_000)}[0.2,"o","second"]`;
			writeFileSync(path.join(dir, "primary.cast"), cast);
			meta.driver = "tui";
			meta.primary = { file: "primary.cast", kind: "recording", sha256: digest(cast) };
			review.artifactSha256 = digest(cast);
			manifest.primaryPath = "primary.cast";
			manifest.kind = "recording";
			write();
			assert.deepEqual(validateEvidenceReview(dir), []);
		});
	});
});
