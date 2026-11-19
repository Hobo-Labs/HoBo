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

describe("designer consensus CLI", () => {
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

	it("relevance mode accepts a justified nonvisual technical contract", () => {
		const root = seedRepo();
		try {
			const file = path.join(root, "relevance.json");
			writeFileSync(file, JSON.stringify({
				changedPaths: ["packages/testing/README.md", "packages/testing/data-models/test_harness.cue"],
				exemption: { code: "no-visual-design-change", justification: "The package contract and documentation add no visual interface." },
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
