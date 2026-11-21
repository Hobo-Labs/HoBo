import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { COUNCIL_PERSONAS, stateDigest, type CouncilState } from "../lib/design-council.mts";
import { inspectGitReviewSubject, runConsensusCommand } from "../../workflows/cross-agent/consensus-loop.mts";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../..");
const CLI = path.join(REPO, ".agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts");
if (!CLI.endsWith("consensus-loop.mts")) throw new Error(CLI);
const sha = (character: string) => character.repeat(64);

function seedRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "design-council-"));
	mkdirSync(path.join(root, ".optimizexp", "bus", "entries"), { recursive: true });
	mkdirSync(path.join(root, ".git"));
	return root;
}

function proposal(root: string, overrides: Record<string, unknown> = {}): string {
	const file = path.join(root, "proposal.json");
	writeFileSync(file, `${JSON.stringify({
		schemaVersion: 1,
		subject: { kind: "surface", surface: "designer council test" },
		changedPaths: ["src/internal/cache.ts"],
		normalizedDiffHash: sha("c"),
		acceptanceDigest: sha("d"),
		evidenceDigest: sha("e"),
		relevanceSignals: { categories: [], acceptanceTags: [], featureTags: [], keywords: [] },
		evidenceSignals: { evidenceTypes: [], currentHead: true, acceptanceMapped: true },
		...overrides,
	}, null, 2)}\n`);
	return file;
}

function run(root: string, args: string[]) {
	const result = runConsensusCommand(["--root", root, ...args]);
	return { code: result.exitCode, json: result.output, output: JSON.stringify(result.output) };
}

function init(root: string, file = proposal(root)) {
	const result = run(root, [
		"--mode", "init", "--run", "run-1", "--review", "review-1",
		"--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", file,
	]);
	assert.equal(result.code, 0, result.output);
	if (!result.json.state) throw new Error(`${CLI} ${JSON.stringify(result)}`);
	return result.json.state as CouncilState;
}

function append(root: string, state: CouncilState, persona: string, stage: "submitted" | "position" | "vote", body: Record<string, unknown> = {}) {
	const personaState = state.personas[persona as keyof typeof state.personas];
	const consumes = stage === "position";
	const decay = consumes ? personaState.decayPerTurn : 0;
	const after = consumes ? Math.round(Math.max(0, personaState.currentInvestment - decay) * 10_000) / 10_000 : personaState.currentInvestment;
	const file = path.join(root, `${persona}-${stage}-${state.turn + 1}.json`);
	writeFileSync(file, `${JSON.stringify({
		kind: "council", schemaVersion: 1, id: `${persona}-${stage}-${state.turn + 1}`,
		runId: state.runId, reviewId: state.reviewId, cycle: state.cycle, turn: state.turn + 1,
		stage, subject: { headSha: state.subject.headSha, proposalDigest: state.subject.proposalDigest },
		createdAt: `2026-08-01T12:00:${String(state.turn + 1).padStart(2, "0")}.000Z`,
		persona, respondsTo: [],
		investment: {
			relevance: personaState.relevance, evidenceStrength: personaState.evidenceStrength,
			before: personaState.currentInvestment, decay, after,
			submitted: stage === "submitted",
		},
		stance: stage === "submitted" || stage === "vote" ? "yay" : null,
		blindSpotCheck: stage === "submitted" || stage === "vote" ? "This lens may overreach; repository evidence remains authoritative." : undefined,
		arguments: [], hardBlockers: [], preferences: [], evidenceRefs: [], requestedChanges: [],
		...body,
	}, null, 2)}\n`);
	return run(root, ["--mode", "append", "--run", state.runId, "--review", state.reviewId, "--entry", file]);
}

function resolveBlocker(root: string, state: CouncilState, body: Record<string, unknown>) {
	const file = path.join(root, `resolution-${state.turn + 1}.json`);
	writeFileSync(file, `${JSON.stringify({
		kind: "council", schemaVersion: 1, id: `resolution-${state.turn + 1}`, runId: state.runId, reviewId: state.reviewId,
		cycle: state.cycle, turn: state.turn + 1, stage: "blocker-resolution",
		subject: { headSha: state.subject.headSha, proposalDigest: state.subject.proposalDigest },
		createdAt: `2026-08-01T13:00:${String(state.turn + 1).padStart(2, "0")}.000Z`,
		...body,
	}, null, 2)}\n`);
	return run(root, ["--mode", "append", "--run", state.runId, "--review", state.reviewId, "--entry", file]);
}

function supersessionFixture() {
	const root = mkdtempSync(path.join(tmpdir(), "design-council-supersession-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q");
	writeFileSync(path.join(root, "file.txt"), "base\n");
	git("add", "file.txt");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
	const base = git("rev-parse", "HEAD");
	git("update-ref", "refs/remotes/origin/main", base);
	writeFileSync(path.join(root, "file.txt"), "old\n");
	git("add", "file.txt");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "old");
	const oldHead = git("rev-parse", "HEAD");
	const oldDiff = inspectGitReviewSubject(root, base, oldHead);
	const oldProposal = proposal(root, { subject: { kind: "pull-request", number: 123 }, changedPaths: oldDiff.changedPaths, normalizedDiffHash: oldDiff.normalizedDiffHash, relevanceSignals: { categories: ["design"], acceptanceTags: [], featureTags: [], keywords: [] }, evidenceSignals: { evidenceTypes: ["executable-test"], currentHead: true, acceptanceMapped: true } });
	const old = run(root, ["--mode", "init", "--run", "old-run", "--review", "old-review", "--base-sha", base, "--head-sha", oldHead, "--proposal", oldProposal]);
	assert.equal(old.code, 0, old.output);
	writeFileSync(path.join(root, "file.txt"), "new\n");
	git("add", "file.txt");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "new");
	const head = git("rev-parse", "HEAD");
	const diff = inspectGitReviewSubject(root, base, head);
	const currentProposal = proposal(root, { subject: { kind: "pull-request", number: 123 }, changedPaths: diff.changedPaths, normalizedDiffHash: diff.normalizedDiffHash, relevanceSignals: { categories: ["design"], acceptanceTags: [], featureTags: [], keywords: [] }, evidenceSignals: { evidenceTypes: ["executable-test"], currentHead: true, acceptanceMapped: true } });
	const replacement = run(root, ["--mode", "init", "--run", "new-run", "--review", "new-review", "--base-sha", base, "--head-sha", head, "--proposal", currentProposal]);
	assert.equal(replacement.code, 0, replacement.output);
	const close = (replacementRun = "new-run", replacementReview = "new-review") => run(root, ["--mode", "close", "--run", "old-run", "--review", "old-review", "--result", "superseded", "--replacement-run", replacementRun, "--replacement-review", replacementReview]);
	return { root, git, base, oldHead, head, old: old.json.state as CouncilState, replacement: replacement.json.state as CouncilState, close };
}

describe("designer consensus CLI", () => {
	it("records a replay-verified replacement without approving the superseded review", () => {
		const fixture = supersessionFixture();
		try {
			const closed = fixture.close();
			assert.equal(closed.code, 0, closed.output);
			const state = closed.json.state as CouncilState;
			assert.equal(state.status, "closed");
			assert.equal(state.closedResult, "superseded");
			assert.equal(state.supersededBy?.headSha, fixture.head);
			assert.equal(state.supersededBy?.reviewId, "new-review");
			fixture.git("checkout", "-q", "--detach", fixture.oldHead);
			const oldProposal = path.join(fixture.root, ".optimizexp", "runs", "old-run", "consensus", "old-review", "proposal-cycle-0.json");
			const unapproved = run(fixture.root, ["--mode", "assert-yay", "--run", "old-run", "--review", "old-review", "--base-sha", fixture.base, "--head-sha", fixture.oldHead, "--proposal", oldProposal]);
			assert.notEqual(unapproved.code, 0);
			assert.match(unapproved.output, /not-approved/);
			fixture.git("checkout", "-q", "--detach", fixture.head);
			const advanced = append(fixture.root, fixture.replacement, "steve-jobs", "position");
			assert.equal(advanced.code, 0, advanced.output);
			writeFileSync(path.join(fixture.root, "file.txt"), "later\n");
			fixture.git("add", "file.txt");
			fixture.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "later");
			const valid = run(fixture.root, ["--mode", "validate", "--run", "old-run", "--review", "old-review"]);
			assert.equal(valid.code, 0, valid.output);
			const stateFile = path.join(fixture.root, ".optimizexp", "runs", "old-run", "consensus", "old-review", "state.json");
			const originalState = readFileSync(stateFile, "utf8");
			const modifiedState = JSON.parse(originalState);
			modifiedState.supersededBy.reviewId = "other";
			writeFileSync(stateFile, JSON.stringify(modifiedState));
			assert.notEqual(run(fixture.root, ["--mode", "validate", "--run", "old-run", "--review", "old-review"]).code, 0);
			writeFileSync(stateFile, originalState);
			const bus = path.join(fixture.root, ".optimizexp", "bus", "entries");
			const opening = readdirSync(bus).map((name) => path.join(bus, name)).find((file) => {
				const entry = JSON.parse(readFileSync(file, "utf8"));
				return entry.runId === "new-run" && entry.stage === "open";
			});
			if (!opening) throw new Error("Replacement opening not found.");
			const entry = JSON.parse(readFileSync(opening, "utf8"));
			entry.subject.headSha = fixture.oldHead;
			writeFileSync(opening, JSON.stringify(entry));
			const tampered = run(fixture.root, ["--mode", "validate", "--run", "old-run", "--review", "old-review"]);
			assert.notEqual(tampered.code, 0);
		} finally { rmSync(fixture.root, { recursive: true, force: true }); }
	});

	it("rejects a replacement whose append-only history repeats an entry id", () => {
		const fixture = supersessionFixture();
		try {
			const bus = path.join(fixture.root, ".optimizexp", "bus", "entries");
			const opening = readdirSync(bus).map((name) => path.join(bus, name)).find((file) => {
				const entry = JSON.parse(readFileSync(file, "utf8"));
				return entry.runId === "new-run" && entry.stage === "open";
			});
			if (!opening) throw new Error("Replacement opening not found.");
			writeFileSync(path.join(bus, "duplicate-opening.json"), readFileSync(opening));
			assert.match(fixture.close().output, /duplicate-entry-id/);
		} finally { rmSync(fixture.root, { recursive: true, force: true }); }
	});

	it("does not accept a replacement link from a persona entry", () => {
		const fixture = supersessionFixture();
		try {
			const forged = append(fixture.root, fixture.old, "steve-jobs", "position", { supersededBy: { reviewId: "new-review" } });
			assert.match(forged.output, /coordinator-only-field/);
			assert.equal(fixture.close().code, 0);
		} finally { rmSync(fixture.root, { recursive: true, force: true }); }
	});

	it("supersession rejects missing, unrelated, same-head, and stale replacement reviews", () => {
		const fixture = supersessionFixture();
		try {
			assert.notEqual(fixture.close("missing", "review").code, 0);
			assert.notEqual(fixture.close("old-run", "old-review").code, 0);
			const different = proposal(fixture.root, { subject: { kind: "pull-request", number: 124 } });
			const unrelated = run(fixture.root, ["--mode", "init", "--run", "other", "--review", "review", "--base-sha", fixture.base, "--head-sha", fixture.head, "--proposal", different]);
			assert.equal(unrelated.code, 0, unrelated.output);
			assert.match(fixture.close("other", "review").output, /supersession-subject/);
			const same = proposal(fixture.root, { subject: { kind: "pull-request", number: 123 } });
			const sameHead = run(fixture.root, ["--mode", "init", "--run", "same", "--review", "review", "--base-sha", fixture.base, "--head-sha", fixture.oldHead, "--proposal", same]);
			assert.equal(sameHead.code, 0, sameHead.output);
			assert.match(fixture.close("same", "review").output, /supersession-subject/);
			writeFileSync(path.join(fixture.root, "file.txt"), "later\n");
			fixture.git("add", "file.txt");
			fixture.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "later");
			assert.match(fixture.close().output, /supersession-git/);
		} finally { rmSync(fixture.root, { recursive: true, force: true }); }
	});

	it("does not use supersession to discard an unresolved blocker", () => {
		const fixture = supersessionFixture();
		try {
			const blocked = append(fixture.root, fixture.old, "steve-jobs", "position", {
				arguments: [{ id: "A-old", claim: "The old behavior violates the acceptance contract.", kind: "hard-blocker", respondsTo: [], evidenceRefs: ["test/old"], requestedChange: "Resolve the failure." }],
				hardBlockers: [{ id: "HB-old", claim: "The old behavior violates the acceptance contract.", rule: "acceptance:old", evidenceRefs: ["test/old"], requestedResolution: "Resolve the failure.", status: "open" }],
			});
			assert.equal(blocked.code, 0, blocked.output);
			assert.match(fixture.close().output, /supersession-blockers/);
		} finally { rmSync(fixture.root, { recursive: true, force: true }); }
	});

	it("does not use supersession to discard a nay or accept a blocked replacement", () => {
		const fixture = supersessionFixture();
		try {
			let state = fixture.old;
			let result = append(fixture.root, state, "steve-jobs", "position", {
				arguments: [{ id: "A-preference", claim: "The documented interaction needs clearer feedback.", kind: "preference", respondsTo: [], evidenceRefs: ["test/feedback"], requestedChange: "Clarify the feedback." }],
			});
			assert.equal(result.code, 0, result.output);
			state = result.json.state as CouncilState;
			for (const persona of COUNCIL_PERSONAS.slice(1)) {
				result = append(fixture.root, state, persona, "position");
				assert.equal(result.code, 0, result.output);
				state = result.json.state as CouncilState;
			}
			result = append(fixture.root, state, "steve-jobs", "vote", { stance: "nay", respondsTo: ["A-preference"] });
			assert.equal(result.code, 0, result.output);
			assert.match(fixture.close().output, /supersession-blockers/);
		} finally { rmSync(fixture.root, { recursive: true, force: true }); }
		const second = supersessionFixture();
		try {
			const blocked = append(second.root, second.replacement, "steve-jobs", "position", {
				arguments: [{ id: "A-new", claim: "The replacement violates acceptance.", kind: "hard-blocker", respondsTo: [], evidenceRefs: ["test/new"], requestedChange: "Resolve the failure." }],
				hardBlockers: [{ id: "HB-new", claim: "The replacement violates acceptance.", rule: "acceptance:new", evidenceRefs: ["test/new"], requestedResolution: "Resolve the failure.", status: "open" }],
			});
			assert.equal(blocked.code, 0, blocked.output);
			assert.match(second.close().output, /supersession-replacement/);
		} finally { rmSync(second.root, { recursive: true, force: true }); }
	});

	it("does not supersede when the replacement is locked or its Git diff does not match", () => {
		const fixture = supersessionFixture();
		try {
			const lock = path.join(fixture.root, ".optimizexp", "runs", "new-run", "consensus", "new-review", ".lock");
			writeFileSync(lock, "occupied");
			assert.match(fixture.close().output, /concurrent-writer/);
			rmSync(lock);
			const mismatch = proposal(fixture.root, { subject: { kind: "pull-request", number: 123 }, normalizedDiffHash: sha("8") });
			const opened = run(fixture.root, ["--mode", "init", "--run", "mismatch", "--review", "review", "--base-sha", fixture.base, "--head-sha", fixture.head, "--proposal", mismatch]);
			assert.equal(opened.code, 0, opened.output);
			assert.match(fixture.close("mismatch", "review").output, /supersession-git/);
			assert.equal((run(fixture.root, ["--mode", "status", "--run", "old-run", "--review", "old-review"]).json.state as CouncilState).status, "open");
		} finally { rmSync(fixture.root, { recursive: true, force: true }); }
	});

	it("rejects an abbreviated alias of the same commit as a replacement", () => {
		const fixture = supersessionFixture();
		try {
			const alias = proposal(fixture.root, { subject: { kind: "pull-request", number: 123 } });
			const opened = run(fixture.root, ["--mode", "init", "--run", "alias", "--review", "review", "--base-sha", fixture.base, "--head-sha", fixture.head.slice(0, 7), "--proposal", alias]);
			assert.equal(opened.code, 0, opened.output);
			const result = run(fixture.root, ["--mode", "close", "--run", "alias", "--review", "review", "--result", "superseded", "--replacement-run", "new-run", "--replacement-review", "new-review"]);
			assert.match(result.output, /supersession-subject/);
		} finally { rmSync(fixture.root, { recursive: true, force: true }); }
	});

	it("cannot supersede user or safety termination or use a terminated replacement", () => {
		for (const termination of ["user", "safety"] as const) {
			const fixture = supersessionFixture();
			try {
				const ended = run(fixture.root, ["--mode", "close", "--run", "old-run", "--review", "old-review", "--result", termination]);
				assert.equal(ended.code, 0, ended.output);
				assert.match(fixture.close().output, /illegal-transition/);
			} finally { rmSync(fixture.root, { recursive: true, force: true }); }
			const second = supersessionFixture();
			try {
				const ended = run(second.root, ["--mode", "close", "--run", "new-run", "--review", "new-review", "--result", termination]);
				assert.equal(ended.code, 0, ended.output);
				assert.match(second.close().output, /supersession-replacement/);
			} finally { rmSync(second.root, { recursive: true, force: true }); }
		}
	});

	it("rejects Git process errors even when the process reports zero status", () => {
		const root = seedRepo();
		try {
			writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
			const error = new Error("synthetic process failure");
			const failedHead = inspectGitReviewSubject(root, sha("a"), sha("b"), "origin/main", () => ({ status: 0, stdout: `${sha("b")}\n`, error }));
			assert.deepEqual(failedHead.problems, ["git_unavailable"]);
			const failedDiff = inspectGitReviewSubject(root, sha("a"), sha("b"), "origin/main", (...args) => {
				if (args[0] === "rev-parse" && args[1] === "HEAD") return { status: 0, stdout: `${sha("b")}\n` };
				if (args[0] === "rev-parse" || args[0] === "merge-base") return { status: 0, stdout: `${sha("a")}\n` };
				if (args.includes("--name-only")) return { status: 0, stdout: "file.txt\n" };
				return { status: 0, stdout: "incomplete diff", error };
			});
			assert.deepEqual(failedDiff.problems, ["git_unavailable"]);
			assert.equal(failedDiff.normalizedDiffHash, null);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("inspects a 16 MiB high-entropy binary evidence diff", () => {
		const root = mkdtempSync(path.join(tmpdir(), "design-council-binary-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
		try {
			git("init", "-q");
			writeFileSync(path.join(root, "baseline.txt"), "baseline\n");
			git("add", "baseline.txt");
			git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
			const base = git("rev-parse", "HEAD");
			writeFileSync(path.join(root, "evidence.bin"), randomBytes(16 * 1024 * 1024));
			git("add", "evidence.bin");
			git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "evidence");
			const head = git("rev-parse", "HEAD");
			const inspected = inspectGitReviewSubject(root, base, head, base);
			assert.deepEqual(inspected.problems, []);
			assert.ok(inspected.normalizedDiffHash);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("opens, records exact-six zero-investment submissions, decides, and asserts current approval", () => {
		const root = seedRepo();
		try {
			const manifest = proposal(root);
			let state = init(root, manifest);
			assert.equal(state.status, "open");
			assert.deepEqual(state.council, COUNCIL_PERSONAS);
			for (const persona of COUNCIL_PERSONAS) {
				assert.equal(state.personas[persona].currentInvestment, 0);
				const result = append(root, state, persona, "submitted");
				assert.equal(result.code, 0, result.output);
				state = result.json.state as CouncilState;
			}
			const decided = run(root, ["--mode", "decide", "--run", "run-1", "--review", "review-1"]);
			assert.equal(decided.code, 0, decided.output);
			assert.equal((decided.json.decision as Record<string, unknown>).result, "yay");
			const approved = decided.json.state as CouncilState;
			assert.equal(approved.status, "approved");
			const asserted = run(root, [
				"--mode", "assert-yay", "--run", "run-1", "--review", "review-1",
				"--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", manifest,
			]);
			assert.equal(asserted.code, 0, asserted.output);
			assert.equal(asserted.json.ok, true);
			const closed = run(root, [
				"--mode", "close", "--run", "run-1", "--review", "review-1", "--result", "approved",
				"--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", manifest,
			]);
			assert.equal(closed.code, 0, closed.output);
			assert.equal(closed.json.result, "yay");
			assert.equal((closed.json.state as CouncilState).status, "closed");
			assert.equal((closed.json.state as CouncilState).closedResult, "yay");
			const assertedAfterClose = run(root, [
				"--mode", "assert-yay", "--run", "run-1", "--review", "review-1",
				"--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", manifest,
			]);
			assert.equal(assertedAfterClose.code, 0, assertedAfterClose.output);
			assert.equal(assertedAfterClose.json.result, "yay");
			assert.equal(typeof assertedAfterClose.json.closedEntryId, "string");
			const staleBase = run(root, [
				"--mode", "assert-yay", "--run", "run-1", "--review", "review-1",
				"--base-sha", sha("6"), "--head-sha", sha("b"), "--proposal", manifest,
			]);
			assert.notEqual(staleBase.code, 0);
			assert.match(staleBase.output, /stale-base/);
			proposal(root, { subject: { kind: "surface", surface: "aliased subject" } });
			const alteredSubject = run(root, [
				"--mode", "assert-yay", "--run", "run-1", "--review", "review-1",
				"--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", manifest,
			]);
			assert.notEqual(alteredSubject.code, 0);
			assert.match(alteredSubject.output, /stale-proposal/);
			proposal(root, { relevanceSignals: { categories: ["api-naming"], acceptanceTags: [], featureTags: [], keywords: [] } });
			const alteredSignals = run(root, [
				"--mode", "assert-yay", "--run", "run-1", "--review", "review-1",
				"--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", manifest,
			]);
			assert.notEqual(alteredSignals.code, 0);
			assert.match(alteredSignals.output, /stale-proposal/);
			proposal(root, { evidenceDigest: sha("9") });
			const alteredEvidence = run(root, [
				"--mode", "assert-yay", "--run", "run-1", "--review", "review-1",
				"--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", manifest,
			]);
			assert.notEqual(alteredEvidence.code, 0);
			assert.match(alteredEvidence.output, /stale-proposal/);
			const stale = run(root, [
				"--mode", "assert-yay", "--run", "run-1", "--review", "review-1",
				"--base-sha", sha("a"), "--head-sha", sha("f"), "--proposal", manifest,
			]);
			assert.notEqual(stale.code, 0);
			assert.match(stale.output, /stale-head/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("hard-blocker nay emits rework and carries investment without recharge", () => {
		const root = seedRepo();
		try {
			const file = proposal(root, {
				relevanceSignals: { categories: ["api-naming"], acceptanceTags: [], featureTags: [], keywords: [] },
				evidenceSignals: { evidenceTypes: ["executable-test"], currentHead: true, acceptanceMapped: true },
			});
			let state = init(root, file);
			const jony = state.personas["jony-ive"];
			assert.ok(jony.currentInvestment > 0);
			let result = append(root, state, "steve-jobs", "submitted");
			assert.equal(result.code, 0, result.output);
			state = result.json.state as CouncilState;
			result = append(root, state, "jony-ive", "position", {
				stance: "nay",
				arguments: [{ id: "A-jony-1", claim: "The public type and CLI names contradict.", kind: "hard-blocker", respondsTo: [], evidenceRefs: ["test/name-contract"], requestedChange: "Use one public name." }],
				hardBlockers: [{ id: "HB-jony-ive-001", claim: "Public names contradict the acceptance contract.", rule: "acceptance:name-symmetry", evidenceRefs: ["test/name-contract"], requestedResolution: "Align the names and pass the contract test.", status: "open" }],
			});
			assert.equal(result.code, 0, result.output);
			state = result.json.state as CouncilState;
			for (const persona of COUNCIL_PERSONAS.filter((id) => id !== "steve-jobs" && id !== "jony-ive")) {
				result = append(root, state, persona, "submitted");
				assert.equal(result.code, 0, result.output);
				state = result.json.state as CouncilState;
			}
			result = append(root, state, "jony-ive", "vote", { stance: "nay", respondsTo: ["A-jony-1"] });
			assert.equal(result.code, 0, result.output);
			state = result.json.state as CouncilState;
			const decided = run(root, ["--mode", "decide", "--run", "run-1", "--review", "review-1"]);
			assert.equal(decided.code, 0, decided.output);
			assert.equal((decided.json.decision as Record<string, unknown>).result, "nay");
			state = decided.json.state as CouncilState;
			assert.equal(state.status, "rework-required");
			const oldInvestment = state.personas["jony-ive"].currentInvestment;
			const staleRework = proposal(root, {
				relevanceSignals: { categories: ["api-naming"], acceptanceTags: [], featureTags: [], keywords: [] },
				evidenceSignals: { evidenceTypes: ["executable-test"], currentHead: true, acceptanceMapped: true },
			});
			const rejected = run(root, [
				"--mode", "init", "--run", "run-1", "--review", "review-1",
				"--base-sha", sha("6"), "--head-sha", sha("b"), "--proposal", staleRework,
			]);
			assert.notEqual(rejected.code, 0);
			assert.match(rejected.output, /rework-evidence-stale/);

			const refreshed = proposal(root, {
				normalizedDiffHash: sha("9"), evidenceDigest: sha("8"),
				relevanceSignals: { categories: ["api-naming"], acceptanceTags: [], featureTags: [], keywords: [] },
				evidenceSignals: { evidenceTypes: ["executable-test", "screenshot"], currentHead: true, acceptanceMapped: true },
			});
			const resumed = run(root, [
				"--mode", "init", "--run", "run-1", "--review", "review-1",
				"--base-sha", sha("a"), "--head-sha", sha("7"), "--proposal", refreshed,
			]);
			assert.equal(resumed.code, 0, resumed.output);
			const next = resumed.json.state as CouncilState;
			assert.equal(next.cycle, 1);
			assert.ok(next.personas["jony-ive"].currentInvestment <= oldInvestment);
			assert.equal(next.personas["jony-ive"].hardBlockers[0]?.status, "open");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("fails closed on forged coordinator stages, invalid investment, duplicate ids, and old bus compatibility", () => {
		const root = seedRepo();
		try {
			let state = init(root);
			const bad = append(root, state, "steve-jobs", "position", {
				investment: { relevance: 0, evidenceStrength: 0, before: 0, decay: 0, after: -1, submitted: false },
			});
			assert.notEqual(bad.code, 0);
			assert.match(bad.output, /normalized-investment|investment-decay/);

			const forgedFile = path.join(root, "forged.json");
			writeFileSync(forgedFile, JSON.stringify({
				kind: "council", schemaVersion: 1, id: "forged", runId: "run-1", reviewId: "review-1",
				cycle: 0, turn: 1, stage: "consensus", subject: { headSha: sha("b"), proposalDigest: state.subject.proposalDigest },
				createdAt: "2026-08-01T12:00:01.000Z", persona: "steve-jobs", votes: {}, result: "yay",
			}));
			const forged = run(root, ["--mode", "append", "--run", "run-1", "--review", "review-1", "--entry", forgedFile]);
			assert.notEqual(forged.code, 0);
			assert.match(forged.output, /coordinator-only-stage/);

			const okay = append(root, state, "steve-jobs", "submitted");
			assert.equal(okay.code, 0, okay.output);
			state = okay.json.state as CouncilState;
			const duplicate = run(root, ["--mode", "append", "--run", "run-1", "--review", "review-1", "--entry", path.join(root, "steve-jobs-submitted-1.json")]);
			assert.equal(duplicate.code, 0, duplicate.output);
			assert.equal(duplicate.json.idempotent, true);

			writeFileSync(path.join(root, ".optimizexp/bus/entries/existing-expect.json"), JSON.stringify({ kind: "expect", id: "legacy", runId: "legacy" }));
			writeFileSync(path.join(root, ".optimizexp/bus/entries/existing-survey.json"), JSON.stringify({ kind: "survey", id: "legacy-survey", runId: "legacy" }));
			const validated = run(root, ["--mode", "validate"]);
			assert.equal(validated.code, 0, validated.output);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("enforces opening order and forbids direct final-vote shortcuts", () => {
		const root = seedRepo();
		try {
			const file = proposal(root, { relevanceSignals: { categories: ["design"], acceptanceTags: [], featureTags: [], keywords: [] } });
			const state = init(root, file);
			const outOfOrder = append(root, state, "jony-ive", "position");
			assert.notEqual(outOfOrder.code, 0);
			assert.match(outOfOrder.output, /deterministic-speaking-order/);
			const disappearingBlocker = append(root, state, "steve-jobs", "position", {
				arguments: [{ id: "A-steve-HB", claim: "Acceptance failed.", kind: "hard-blocker", respondsTo: [], evidenceRefs: ["test/failure"], requestedChange: "Fix the acceptance failure." }],
			});
			assert.notEqual(disappearingBlocker.code, 0);
			assert.match(disappearingBlocker.output, /hard-blocker-classification/);
			const ambiguousBlockers = append(root, state, "steve-jobs", "position", {
				arguments: ["one", "two"].map((suffix) => ({ id: `A-steve-${suffix}`, claim: `Acceptance ${suffix} failed.`, kind: "hard-blocker", respondsTo: [], evidenceRefs: ["test/shared"], requestedChange: `Fix ${suffix}.` })),
				hardBlockers: ["one", "two"].map((suffix) => ({ id: `HB-steve-${suffix}`, claim: `Blocker ${suffix}.`, rule: `acceptance:${suffix}`, evidenceRefs: ["test/shared"], requestedResolution: `Resolve ${suffix}.`, status: "open" })),
			});
			assert.notEqual(ambiguousBlockers.code, 0);
			assert.match(ambiguousBlockers.output, /hard-blocker-classification/);
			const directVote = append(root, state, "steve-jobs", "vote");
			assert.notEqual(directVote.code, 0);
			assert.match(directVote.output, /opening-round-incomplete|opening-position-required/);
			const directSubmit = append(root, state, "steve-jobs", "submitted");
			assert.notEqual(directSubmit.code, 0);
			assert.match(directSubmit.output, /submitted-transition/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("relevance mode returns a machine-readable internal exemption", () => {
		const root = seedRepo();
		try {
			const file = path.join(root, "relevance.json");
			writeFileSync(file, JSON.stringify({
				changedPaths: ["src/internal/cache.ts"],
				exemption: { code: "internal-no-public-behavior", justification: "Private cache rename; exported behavior and errors unchanged." },
			}));
			const result = run(root, ["--mode", "relevance", "--input", file]);
			assert.equal(result.code, 0, result.output);
			assert.equal(result.json.required, false);
			assert.equal(result.json.exemptionAccepted, true);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("derives nonzero council relevance from a public boundary path", () => {
		const root = seedRepo();
		try {
			const file = proposal(root, { changedPaths: ["packages/contracts/data-models/boundary.proto"] });
			const state = init(root, file);
			for (const persona of COUNCIL_PERSONAS) assert.ok(state.personas[persona].currentInvestment > 0, persona);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects an approved snapshot with no persona-authored final votes", () => {
		const root = seedRepo();
		try {
			const file = proposal(root);
			const state = init(root, file);
			state.status = "approved";
			state.turn = 1;
			state.latestConsensusEntryId = "forged-consensus";
			const votes = Object.fromEntries(COUNCIL_PERSONAS.map((persona) => [persona, "yay"]));
			const forged = {
				kind: "council", schemaVersion: 1, id: "forged-consensus", runId: state.runId, reviewId: state.reviewId,
				cycle: 0, turn: 1, stage: "consensus", subject: { headSha: state.subject.headSha, proposalDigest: state.subject.proposalDigest },
				createdAt: "2026-08-01T12:00:01.000Z", votes, result: "yay", openHardBlockers: [], author: "coordinator", stateDigest: stateDigest(state),
			};
			writeFileSync(path.join(root, ".optimizexp", "runs", "run-1", "consensus", "review-1", "state.json"), `${JSON.stringify(state, null, 2)}\n`);
			writeFileSync(path.join(root, ".optimizexp", "bus", "entries", "forged-consensus.json"), `${JSON.stringify(forged, null, 2)}\n`);
			const assertion = run(root, ["--mode", "assert-yay", "--run", "run-1", "--review", "review-1", "--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", file]);
			assert.notEqual(assertion.code, 0);
			assert.match(assertion.output, /exact-six-membership|vote-proof|illegal-transition|history-replay/);
			const validation = run(root, ["--mode", "validate", "--run", "run-1", "--review", "review-1"]);
			assert.notEqual(validation.code, 0);
			assert.match(validation.output, /exact-six-membership|vote-proof|illegal-transition|history-replay/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects six hand-written votes that bypass positions and legal investment transitions", () => {
		const root = seedRepo();
		try {
			const file = proposal(root, {
				relevanceSignals: { categories: ["design"], acceptanceTags: [], featureTags: [], keywords: [] },
				evidenceSignals: { evidenceTypes: ["executable-test"], currentHead: true, acceptanceMapped: true },
			});
			const initial = init(root, file);
			const forged = structuredClone(initial);
			const bus = path.join(root, ".optimizexp", "bus", "entries");
			for (const [index, persona] of COUNCIL_PERSONAS.entries()) {
				const turn = index + 1;
				const current = forged.personas[persona];
				forged.turn = turn;
				forged.status = "voting";
				current.stance = "yay";
				current.lastEntryId = `forged-${persona}-vote`;
				const entry = {
					kind: "council", schemaVersion: 1, id: current.lastEntryId, runId: forged.runId, reviewId: forged.reviewId,
					cycle: 0, turn, stage: "vote", subject: { headSha: forged.subject.headSha, proposalDigest: forged.subject.proposalDigest },
					createdAt: `2026-08-01T14:00:${String(turn).padStart(2, "0")}.000Z`, persona, respondsTo: [],
					investment: { relevance: current.relevance, evidenceStrength: current.evidenceStrength, before: current.currentInvestment, decay: 0, after: current.currentInvestment, submitted: false },
					stance: "yay", blindSpotCheck: "Repository evidence remains authoritative.", arguments: [], hardBlockers: [], preferences: [], evidenceRefs: [], requestedChanges: [],
					stateDigest: stateDigest(forged),
				};
				writeFileSync(path.join(bus, `forged-${String(turn).padStart(2, "0")}.json`), `${JSON.stringify(entry, null, 2)}\n`);
			}
			forged.turn = 7;
			forged.status = "approved";
			forged.latestConsensusEntryId = "forged-six-vote-consensus";
			const votes = Object.fromEntries(COUNCIL_PERSONAS.map((persona) => [persona, "yay"]));
			writeFileSync(path.join(bus, "forged-07-consensus.json"), `${JSON.stringify({
				kind: "council", schemaVersion: 1, id: forged.latestConsensusEntryId, runId: forged.runId, reviewId: forged.reviewId,
				cycle: 0, turn: 7, stage: "consensus", subject: { headSha: forged.subject.headSha, proposalDigest: forged.subject.proposalDigest },
				createdAt: "2026-08-01T14:00:07.000Z", votes, result: "yay", openHardBlockers: [], author: "coordinator", stateDigest: stateDigest(forged),
			}, null, 2)}\n`);
			writeFileSync(path.join(root, ".optimizexp", "runs", "run-1", "consensus", "review-1", "state.json"), `${JSON.stringify(forged, null, 2)}\n`);
			const validation = run(root, ["--mode", "validate", "--run", "run-1", "--review", "review-1"]);
			assert.notEqual(validation.code, 0);
			assert.match(validation.output, /opening-round-incomplete|opening-position-required|investment-decay/);
			const assertion = run(root, ["--mode", "assert-yay", "--run", "run-1", "--review", "review-1", "--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", file]);
			assert.notEqual(assertion.code, 0);
			assert.match(assertion.output, /opening-round-incomplete|opening-position-required|investment-decay/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects a forged zero-investment opening that disagrees with its proposal snapshot", () => {
		const root = seedRepo();
		try {
			const file = proposal(root, {
				relevanceSignals: { categories: ["design"], acceptanceTags: [], featureTags: [], keywords: [] },
				evidenceSignals: { evidenceTypes: ["executable-test"], currentHead: true, acceptanceMapped: true },
			});
			let state = init(root, file);
			for (const persona of COUNCIL_PERSONAS) {
				const current = state.personas[persona];
				current.relevance = 0;
				current.evidenceStrength = 0;
				current.initialInvestment = 0;
				current.currentInvestment = 0;
				current.decayPerTurn = 0.34;
			}
			const bus = path.join(root, ".optimizexp", "bus", "entries");
			const openFile = readdirSync(bus).find((entry) => entry.includes("-open-"));
			assert.ok(openFile);
			const openPath = path.join(bus, openFile);
			const open = JSON.parse(readFileSync(openPath, "utf8"));
			open.initialState = structuredClone(state);
			open.initialPersonas = structuredClone(state.personas);
			open.stateDigest = stateDigest(state);
			writeFileSync(openPath, `${JSON.stringify(open, null, 2)}\n`);
			writeFileSync(path.join(root, ".optimizexp", "runs", "run-1", "consensus", "review-1", "state.json"), `${JSON.stringify(state, null, 2)}\n`);
			const blockedAppend = append(root, state, "steve-jobs", "submitted");
			assert.notEqual(blockedAppend.code, 0);
			assert.match(blockedAppend.output, /deterministic proposal seed/);
			const validation = run(root, ["--mode", "validate", "--run", "run-1", "--review", "review-1"]);
			assert.notEqual(validation.code, 0);
			assert.match(validation.output, /deterministic proposal seed/);
			const assertion = run(root, ["--mode", "assert-yay", "--run", "run-1", "--review", "review-1", "--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", file]);
			assert.notEqual(assertion.code, 0);
			assert.match(assertion.output, /deterministic proposal seed/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("binds persisted state identity to its requested run and review path", () => {
		const root = seedRepo();
		try {
			const state = init(root);
			const aliasDir = path.join(root, ".optimizexp", "runs", "run-1", "consensus", "review-alias");
			mkdirSync(aliasDir, { recursive: true });
			writeFileSync(path.join(aliasDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
			const status = run(root, ["--mode", "status", "--run", "run-1", "--review", "review-alias"]);
			assert.notEqual(status.code, 0);
			assert.match(status.output, /review-binding/);
			const validation = run(root, ["--mode", "validate", "--run", "run-1", "--review", "review-alias"]);
			assert.notEqual(validation.code, 0);
			assert.match(validation.output, /review-binding/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("validates auditable blocker resolutions within and across replayed review cycles", () => {
		const root = seedRepo();
		try {
			const file = proposal(root, { relevanceSignals: { categories: ["design"], acceptanceTags: [], featureTags: [], keywords: [] } });
			let state = init(root, file);
			const positioned = append(root, state, "steve-jobs", "position", {
				arguments: [
					{ id: "A-fixed", claim: "Acceptance path fails.", kind: "hard-blocker", respondsTo: [], evidenceRefs: ["test/fixed"], requestedChange: "Fix it." },
					{ id: "A-withdrawn", claim: "The evidence was mismatched.", kind: "hard-blocker", respondsTo: [], evidenceRefs: ["test/withdrawn"], requestedChange: "Recheck it." },
				],
				hardBlockers: [
					{ id: "HB-fixed", claim: "Acceptance path fails.", rule: "acceptance:path", evidenceRefs: ["test/fixed"], requestedResolution: "Pass the acceptance test.", status: "open" },
					{ id: "HB-withdrawn", claim: "The evidence was mismatched.", rule: "evidence:binding", evidenceRefs: ["test/withdrawn"], requestedResolution: "Correct the evidence binding.", status: "open" },
				],
			});
			assert.equal(positioned.code, 0, positioned.output);
			state = positioned.json.state as CouncilState;
			const badWithdrawal = resolveBlocker(root, state, {
				blockerId: "HB-withdrawn", originatingPersona: "steve-jobs", resolutionType: "withdrawn",
				implementationEvidenceRefs: ["test/recheck"], resolver: "coordinator", originAcknowledged: false, resultingStatus: "withdrawn",
			});
			assert.notEqual(badWithdrawal.code, 0);
			assert.match(badWithdrawal.output, /withdrawal must be acknowledged/);
			const badOverride = resolveBlocker(root, state, {
				blockerId: "HB-fixed", originatingPersona: "steve-jobs", resolutionType: "policy-override",
				implementationEvidenceRefs: ["policy/decision"], resolver: "coordinator", originAcknowledged: true, resultingStatus: "overridden",
			});
			assert.notEqual(badOverride.code, 0);
			assert.match(badOverride.output, /authorizationRef/);
			for (const persona of COUNCIL_PERSONAS.filter((item) => item !== "steve-jobs")) {
				const stage = state.personas[persona].currentInvestment === 0 ? "submitted" : "position";
				const result = append(root, state, persona, stage);
				assert.equal(result.code, 0, result.output);
				state = result.json.state as CouncilState;
			}
			for (const persona of COUNCIL_PERSONAS) {
				if (state.personas[persona].submitted) continue;
				const stage = state.personas[persona].currentInvestment === 0 ? "submitted" : "vote";
				const result = append(root, state, persona, stage, { stance: persona === "steve-jobs" ? "nay" : "yay" });
				assert.equal(result.code, 0, result.output);
				state = result.json.state as CouncilState;
			}
			const decided = run(root, ["--mode", "decide", "--run", "run-1", "--review", "review-1"]);
			assert.equal(decided.code, 0, decided.output);
			state = decided.json.state as CouncilState;
			assert.equal(state.status, "rework-required");
			const fixed = resolveBlocker(root, state, {
				blockerId: "HB-fixed", originatingPersona: "steve-jobs", resolutionType: "fixed",
				implementationEvidenceRefs: ["test/passing"], resolver: "implementer", originAcknowledged: false, resultingStatus: "resolved",
			});
			assert.equal(fixed.code, 0, fixed.output);
			state = fixed.json.state as CouncilState;
			const withdrawn = resolveBlocker(root, state, {
				blockerId: "HB-withdrawn", originatingPersona: "steve-jobs", resolutionType: "withdrawn",
				implementationEvidenceRefs: ["test/corrected-classification"], resolver: "steve-jobs", originAcknowledged: true, resultingStatus: "withdrawn",
			});
			assert.equal(withdrawn.code, 0, withdrawn.output);
			state = withdrawn.json.state as CouncilState;
			const validate = () => run(root, ["--mode", "validate", "--run", "run-1", "--review", "review-1"]);
			assert.equal(validate().code, 0);
			const stateFile = path.join(root, ".optimizexp", "runs", "run-1", "consensus", "review-1", "state.json");
			const missing = structuredClone(state);
			missing.personas["steve-jobs"].hardBlockers = [];
			writeFileSync(stateFile, JSON.stringify(missing));
			const currentCycleMissing = validate();
			assert.notEqual(currentCycleMissing.code, 0);
			assert.match(currentCycleMissing.output, /blocker-resolution-state-mismatch:HB-fixed/);
			writeFileSync(stateFile, JSON.stringify(state));
			const refreshed = proposal(root, {
				normalizedDiffHash: sha("9"), evidenceDigest: sha("8"),
				relevanceSignals: { categories: ["design"], acceptanceTags: [], featureTags: [], keywords: [] },
			});
			const resumed = run(root, ["--mode", "init", "--run", "run-1", "--review", "review-1", "--base-sha", sha("a"), "--head-sha", sha("7"), "--proposal", refreshed]);
			assert.equal(resumed.code, 0, resumed.output);
			state = resumed.json.state as CouncilState;
			assert.equal(state.cycle, 1);
			assert.deepEqual(state.personas["steve-jobs"].hardBlockers, []);
			const historical = validate();
			assert.equal(historical.code, 0, historical.output);
			const bus = path.join(root, ".optimizexp", "bus", "entries");
			const resolutionFile = readdirSync(bus).map((name) => path.join(bus, name)).find((name) => JSON.parse(readFileSync(name, "utf8")).blockerId === "HB-fixed");
			assert.ok(resolutionFile);
			const forged = JSON.parse(readFileSync(resolutionFile, "utf8"));
			forged.resolver = "";
			writeFileSync(resolutionFile, JSON.stringify(forged));
			const invalidHistory = validate();
			assert.notEqual(invalidHistory.code, 0);
			assert.match(invalidHistory.output, /resolver/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("records an evidence-backed blocked transition before blocked close", () => {
		const root = seedRepo();
		try {
			const file = proposal(root, { relevanceSignals: { categories: ["design"], acceptanceTags: [], featureTags: [], keywords: [] } });
			let state = init(root, file);
			const positioned = append(root, state, "steve-jobs", "position", {
				arguments: [{ id: "A-external", claim: "Required external evidence is unavailable.", kind: "hard-blocker", respondsTo: [], evidenceRefs: ["evidence/external-block"], requestedChange: "Restore the external authority." }],
				hardBlockers: [{ id: "HB-external", claim: "Required external evidence is unavailable.", rule: "evidence:current-head", evidenceRefs: ["evidence/external-block"], requestedResolution: "Restore the external authority.", status: "open" }],
			});
			assert.equal(positioned.code, 0, positioned.output);
			state = positioned.json.state as CouncilState;
			const blocked = run(root, ["--mode", "block", "--run", "run-1", "--review", "review-1", "--reason", "External evidence authority is unavailable under current credentials."]);
			assert.equal(blocked.code, 0, blocked.output);
			assert.equal((blocked.json.state as CouncilState).status, "blocked");
			const closed = run(root, ["--mode", "close", "--run", "run-1", "--review", "review-1", "--result", "blocked"]);
			assert.equal(closed.code, 0, closed.output);
			const assertion = run(root, ["--mode", "assert-yay", "--run", "run-1", "--review", "review-1", "--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", file]);
			assert.notEqual(assertion.code, 0);
			assert.match(assertion.output, /not-approved/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("diagnostic maximum turns blocks and never approves", () => {
		const root = seedRepo();
		try {
			const file = proposal(root);
			const opened = run(root, [
				"--mode", "init", "--run", "run-1", "--review", "review-1", "--base-sha", sha("a"),
				"--head-sha", sha("b"), "--proposal", file, "--max-turns", "1",
			]);
			let state = opened.json.state as CouncilState;
			let result = append(root, state, "steve-jobs", "submitted");
			assert.equal(result.code, 0, result.output);
			state = result.json.state as CouncilState;
			result = append(root, state, "jony-ive", "submitted");
			assert.equal(result.code, 1, result.output);
			assert.equal(result.json.blocked, true);
			assert.equal((result.json.state as CouncilState).status, "blocked");
			const bus = path.join(root, ".optimizexp", "bus", "entries");
			const diagnostic = readdirSync(bus).map((name) => path.join(bus, name)).find((entryFile) => {
				const entry = JSON.parse(readFileSync(entryFile, "utf8"));
				return entry.id === "review-1-cycle-0-max-turns-blocked";
			});
			if (!diagnostic) throw new Error("Diagnostic blocked entry not found.");
			const original = readFileSync(diagnostic, "utf8");
			const entry = JSON.parse(original);
			entry.supersededBy = { runId: "unverified", reviewId: "replacement" };
			writeFileSync(diagnostic, JSON.stringify(entry));
			const tampered = run(root, ["--mode", "validate", "--run", "run-1", "--review", "review-1"]);
			assert.notEqual(tampered.code, 0, tampered.output);
			assert.match(tampered.output, /unexpected replacement/);
			writeFileSync(diagnostic, original);
			const valid = run(root, ["--mode", "validate", "--run", "run-1", "--review", "review-1"]);
			assert.equal(valid.code, 0, valid.output);
			const closed = run(root, ["--mode", "close", "--run", "run-1", "--review", "review-1", "--result", "blocked", "--reason", "Diagnostic turn ceiling with unresolved discussion."]);
			assert.equal(closed.code, 0, closed.output);
			assert.equal(closed.json.result, "blocked");
			assert.equal((closed.json.state as CouncilState).status, "closed");
			assert.notEqual((closed.json.entry as Record<string, unknown>).result, "yay");
			const assertion = run(root, ["--mode", "assert-yay", "--run", "run-1", "--review", "review-1", "--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", file]);
			assert.notEqual(assertion.code, 0);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects an illegal open to approved or blocked close", () => {
		const root = seedRepo();
		try {
			const file = proposal(root);
			init(root, file);
			const approved = run(root, ["--mode", "close", "--run", "run-1", "--review", "review-1", "--result", "approved", "--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", file]);
			assert.notEqual(approved.code, 0);
			assert.match(approved.output, /not-approved/);
			const blocked = run(root, ["--mode", "close", "--run", "run-1", "--review", "review-1", "--result", "blocked"]);
			assert.notEqual(blocked.code, 0);
			assert.match(blocked.output, /illegal-transition/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("never proves yay for user or safety closed reviews", () => {
		for (const result of ["user", "safety"] as const) {
			const root = seedRepo();
			try {
				const file = proposal(root);
				init(root, file);
				const closed = run(root, ["--mode", "close", "--run", "run-1", "--review", "review-1", "--result", result, "--reason", `${result} termination.`]);
				assert.equal(closed.code, 0, closed.output);
				assert.equal(closed.json.result, result);
				const assertion = run(root, ["--mode", "assert-yay", "--run", "run-1", "--review", "review-1", "--base-sha", sha("a"), "--head-sha", sha("b"), "--proposal", file]);
				assert.notEqual(assertion.code, 0);
				assert.match(assertion.output, /not-approved/);
			} finally { rmSync(root, { recursive: true, force: true }); }
		}
	});
});
