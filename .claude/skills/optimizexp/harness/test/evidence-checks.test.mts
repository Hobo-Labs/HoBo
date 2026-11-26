/**
 * Unit tests: evidence-backed scoring validation (rubric checks + ref existence).
 * Run: node --import tsx --test .agents/skills/optimizexp/harness/test/evidence-checks.test.mts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { evaluateScorecardEvidence } from "../lib/evidence-checks.mts";
import {
	makeScorecard,
	validateScorecard,
} from "../lib/scorecard.mts";

function seedEvidence(root: string, name: string, exitCode: number, transcript: string) {
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "primary.txt"), transcript);
	writeFileSync(
		path.join(dir, "meta.json"),
		JSON.stringify({
			primary: { file: "primary.txt" },
			repro: { via: "capture-evidence" },
			exitCode,
		}),
	);
	return name;
}

describe("scorecard evidenceChecks shape", () => {
	it("accepts a well-formed rubric", () => {
		const card = makeScorecard({
			phase: "outcome",
			persona: "dev",
			surface: "cli",
			harms: 0,
			friction: 0,
			uncertainty: 0,
			evidenceRefs: ["ev"],
		});
		card.evidenceChecks = [{ evidence: "ev", exitCodeEquals: 0 }];
		assert.deepEqual(validateScorecard(card, "outcome"), []);
	});

	it("rejects checks without assertions, evidence path, or with bad types", () => {
		const card = makeScorecard({
			phase: "outcome",
			persona: "dev",
			surface: "cli",
			harms: 0,
			friction: 0,
			uncertainty: 0,
			evidenceRefs: ["ev"],
		});
		card.evidenceChecks = [
			{ evidence: "ev" },
			{ exitCodeEquals: 0 } as never,
			{ evidence: "ev", exitCodeEquals: 0.5 },
			{ evidence: "ev", transcriptContains: 42 as never },
		];
		const problems = validateScorecard(card, "outcome");
		assert.ok(problems.some((p) => p.includes("at least one assertion")));
		assert.ok(problems.some((p) => p.includes("[1].evidence required")));
		assert.ok(problems.some((p) => p.includes("exitCodeEquals must be an integer")));
		assert.ok(problems.some((p) => p.includes("transcriptContains must be a string")));
	});

	it("rejects non-array evidenceChecks and non-string justification", () => {
		const card = makeScorecard({
			phase: "expect",
			persona: "dev",
			surface: "cli",
			harms: 0,
			friction: 0,
			uncertainty: 0,
		});
		const raw = {
			...card,
			evidenceChecks: "nope",
			justification: 7,
		} as unknown;
		const problems = validateScorecard(raw, "expect");
		assert.ok(problems.some((p) => p.includes("evidenceChecks must be an array")));
		assert.ok(problems.some((p) => p.includes("justification must be a string")));
	});
});

describe("evaluateScorecardEvidence", () => {
	it("passes when refs exist and all rubric checks hold", () => {
		const root = mkdtempSync(path.join(tmpdir(), "oxp-ev-"));
		try {
			seedEvidence(root, "ev", 0, "all good\nno errors\n");
			const problems = evaluateScorecardEvidence(
				{
					evidenceRefs: ["ev/meta.json"],
					evidenceChecks: [
						{
							evidence: "ev",
							exitCodeEquals: 0,
							transcriptContains: "all good",
							transcriptNotContains: "stack trace",
						},
					],
				},
				root,
			);
			assert.deepEqual(problems, []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails when a cited evidenceRef does not exist", () => {
		const root = mkdtempSync(path.join(tmpdir(), "oxp-ev-"));
		try {
			const problems = evaluateScorecardEvidence(
				{ evidenceRefs: ["missing/dir"] },
				root,
			);
			assert.deepEqual(problems, ["evidence_missing:missing/dir"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails on missing meta.json, exitCode mismatch, and transcript assertion failures", () => {
		const root = mkdtempSync(path.join(tmpdir(), "oxp-ev-"));
		try {
			seedEvidence(root, "ev", 1, "boom happened\n");
			mkdirSync(path.join(root, "bare"), { recursive: true });
			const problems = evaluateScorecardEvidence(
				{
					evidenceChecks: [
						{ evidence: "bare", exitCodeEquals: 0 },
						{ evidence: "ev", exitCodeEquals: 0 },
						{ evidence: "ev", exitCodeNotEquals: 1 },
						{ evidence: "ev", transcriptContains: "all good" },
						{ evidence: "ev", transcriptNotContains: "boom" },
						{ evidence: "nope", exitCodeEquals: 0 },
					],
				},
				root,
			);
			assert.ok(problems.some((p) => p.includes("meta_json_missing:bare")));
			assert.ok(problems.some((p) => p.includes("exitCode 1 must equal 0")));
			assert.ok(problems.some((p) => p.includes("exitCode must not equal 1")));
			assert.ok(problems.some((p) => p.includes("transcript missing pattern /all good/")));
			assert.ok(problems.some((p) => p.includes("transcript unexpectedly matches /boom/")));
			assert.ok(problems.some((p) => p.includes("evidence_missing:nope")));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports invalid regex and missing card gracefully", () => {
		const root = mkdtempSync(path.join(tmpdir(), "oxp-ev-"));
		try {
			seedEvidence(root, "ev", 0, "x\n");
			const problems = evaluateScorecardEvidence(
				{ evidenceChecks: [{ evidence: "ev", transcriptContains: "([" }] },
				root,
			);
			assert.ok(problems.some((p) => p.includes("invalid regex")));
			assert.deepEqual(evaluateScorecardEvidence(undefined, root), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
