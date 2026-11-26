import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	advanceInvestment,
	COUNCIL_PERSONAS,
	type CouncilState,
	stateDigest,
} from "../.agents/skills/optimizexp/harness/lib/design-council.mts";
import { runConsensusCommand } from "../.agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts";

const sha = (character: string) => character.repeat(64);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function seedRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "council-adversarial-"));
	mkdirSync(path.join(root, ".git"));
	mkdirSync(path.join(root, ".optimizexp/bus/entries"), { recursive: true });
	roots.push(root);
	return root;
}

function proposal(
	root: string,
	evidenceDigest = sha("e"),
	relevant = false,
	allRelevant = false,
	strongEvidence = false,
): string {
	const file = path.join(root, `proposal-${evidenceDigest.slice(0, 1)}.json`);
	writeFileSync(
		file,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				subject: {
					kind: "surface",
					surface: "designer council adversarial fixture",
				},
				changedPaths: ["src/internal/cache.ts"],
				normalizedDiffHash: sha("c"),
				acceptanceDigest: sha("d"),
				evidenceDigest,
				relevanceSignals: {
					categories: relevant ? ["api-naming"] : [],
					acceptanceTags: allRelevant ? ["design"] : [],
					featureTags: [],
					keywords: [],
				},
				evidenceSignals: {
					evidenceTypes: strongEvidence
						? ["executable-test", "screenshot"]
						: [],
					currentHead: true,
					acceptanceMapped: true,
				},
			},
			null,
			2,
		)}\n`,
	);
	return file;
}

function run(root: string, ...args: string[]) {
	const result = runConsensusCommand(["--root", root, ...args]);
	return { ...result, text: JSON.stringify(result.output) };
}

function init(
	root: string,
	options: { maxTurns?: number; proposal?: string } = {},
): CouncilState {
	const args = [
		"--mode",
		"init",
		"--run",
		"run-1",
		"--review",
		"review-1",
		"--base-sha",
		sha("a"),
		"--head-sha",
		sha("b"),
		"--proposal",
		options.proposal ?? proposal(root),
	];
	if (options.maxTurns) args.push("--max-turns", String(options.maxTurns));
	const result = run(root, ...args);
	assert.equal(result.exitCode, 0, result.text);
	// SAFETY: assertion to `result.output.state as CouncilState` is required at this boundary.
	return result.output.state as CouncilState;
}

function append(
	root: string,
	state: CouncilState,
	persona: (typeof COUNCIL_PERSONAS)[number],
	stage: "position" | "reply" | "vote" | "submitted",
	overrides: {
		[key: string]: import("../scripts/lib/inspectable.ts").JsonValue;
	} = {},
) {
	const before = state.personas[persona].currentInvestment;
	const consumes = stage === "position" || stage === "reply";
	const decay = consumes ? state.personas[persona].decayPerTurn : 0;
	const after = consumes ? advanceInvestment(before, decay) : before;
	const turn = state.turn + 1;
	const file = path.join(root, `${persona}-${stage}-${turn}.json`);
	writeFileSync(
		file,
		`${JSON.stringify(
			{
				kind: "council",
				schemaVersion: 1,
				id: `${persona}-${stage}-${turn}`,
				runId: state.runId,
				reviewId: state.reviewId,
				cycle: state.cycle,
				turn,
				stage,
				subject: {
					headSha: state.subject.headSha,
					proposalDigest: state.subject.proposalDigest,
				},
				createdAt: `2026-08-01T12:00:${String(turn).padStart(2, "0")}.000Z`,
				persona,
				respondsTo: [],
				investment: {
					relevance: state.personas[persona].relevance,
					evidenceStrength: state.personas[persona].evidenceStrength,
					before,
					decay,
					after,
					submitted: stage === "submitted",
				},
				stance: stage === "vote" || stage === "submitted" ? "yay" : null,
				arguments: [],
				hardBlockers: [],
				preferences: [],
				evidenceRefs: [],
				requestedChanges: [],
				blindSpotCheck:
					stage === "vote" || stage === "submitted"
						? "This lens may overreach; current repository evidence remains authoritative."
						: undefined,
				...overrides,
			},
			null,
			2,
		)}\n`,
	);
	return run(
		root,
		"--mode",
		"append",
		"--run",
		state.runId,
		"--review",
		state.reviewId,
		"--entry",
		file,
	);
}

function approve(root: string, initial: CouncilState): CouncilState {
	let state = initial;
	for (const persona of COUNCIL_PERSONAS) {
		const appended = append(root, state, persona, "submitted");
		assert.equal(appended.exitCode, 0, appended.text);
		// SAFETY: assertion to `appended.output.state as CouncilState` is required at this boundary.
		state = appended.output.state as CouncilState;
	}
	const decided = run(
		root,
		"--mode",
		"decide",
		"--run",
		state.runId,
		"--review",
		state.reviewId,
	);
	assert.equal(decided.exitCode, 0, decided.text);
	// SAFETY: assertion to `decided.output.state as CouncilState` is required at this boundary.
	return decided.output.state as CouncilState;
}

function openAllPositions(root: string, initial: CouncilState): CouncilState {
	let state = initial;
	for (const persona of COUNCIL_PERSONAS) {
		const opened = append(root, state, persona, "position");
		assert.equal(opened.exitCode, 0, opened.text);
		// SAFETY: assertion to `opened.output.state as CouncilState` is required at this boundary.
		state = opened.output.state as CouncilState;
	}
	return state;
}

describe("designer council adversarial protocol", () => {
	test("zero investment cannot inject preferences or reply to an unknown target", () => {
		const root = seedRepo();
		const state = init(root);
		assert.equal(state.personas["steve-jobs"].currentInvestment, 0);

		const preference = append(root, state, "steve-jobs", "position", {
			arguments: [
				{
					id: "P-jony-1",
					claim: "The name feels inelegant.",
					kind: "preference",
					respondsTo: [],
					evidenceRefs: [],
					requestedChange: "Rename it.",
				},
			],
		});
		assert.notEqual(preference.exitCode, 0);
		assert.match(preference.text, /zero-investment-preference/);

		const discussionRoot = seedRepo();
		const discussion = openAllPositions(
			discussionRoot,
			init(discussionRoot, {
				proposal: proposal(discussionRoot, sha("e"), false, true),
			}),
		);
		const reply = append(discussionRoot, discussion, "jony-ive", "reply", {
			respondsTo: ["missing-entry"],
		});
		assert.notEqual(reply.exitCode, 0);
		assert.match(reply.text, /reply-target/);
	});

	test("zero investment must submit and cannot forge approval by voting from open", () => {
		const root = seedRepo();
		const state = init(root);
		const directVote = append(root, state, "steve-jobs", "vote");
		assert.notEqual(directVote.exitCode, 0);
		assert.match(directVote.text, /opening-round|submitted|zero-investment/);
	});

	test("opening substantive positions follow deterministic council order", () => {
		const root = seedRepo();
		const state = init(root, {
			proposal: proposal(root, sha("e"), false, true),
		});
		assert.ok(state.personas["steve-jobs"].currentInvestment > 0);
		assert.ok(state.personas["jony-ive"].currentInvestment > 0);
		const outOfOrder = append(root, state, "jony-ive", "position");
		assert.notEqual(outOfOrder.exitCode, 0);
		assert.match(outOfOrder.text, /speaking-order/);
	});

	test("a second final vote requires explicit supersession", () => {
		const root = seedRepo();
		let state = openAllPositions(
			root,
			init(root, { proposal: proposal(root, sha("e"), false, true, true) }),
		);
		const first = append(root, state, "jony-ive", "vote");
		assert.equal(first.exitCode, 0, first.text);
		// SAFETY: assertion to `first.output.state as CouncilState` is required at this boundary.
		state = first.output.state as CouncilState;
		const duplicate = append(root, state, "jony-ive", "vote");
		assert.notEqual(duplicate.exitCode, 0);
		assert.match(duplicate.text, /duplicate-vote/);
	});

	test("diagnostic maximum turns blocks instead of approving", () => {
		const root = seedRepo();
		let state = init(root, { maxTurns: 1 });
		const first = append(root, state, "steve-jobs", "position");
		assert.equal(first.exitCode, 0, first.text);
		// SAFETY: assertion to `first.output.state as CouncilState` is required at this boundary.
		state = first.output.state as CouncilState;
		const capped = append(root, state, "jony-ive", "position");
		assert.notEqual(capped.exitCode, 0);
		assert.equal(capped.output.blocked, true);
		// SAFETY: assertion to `capped.output.state as CouncilState` is required at this boundary.
		assert.equal((capped.output.state as CouncilState).status, "blocked");
		assert.match(capped.text, /max-turns-blocked/);

		const assertion = run(
			root,
			"--mode",
			"assert-yay",
			"--run",
			state.runId,
			"--review",
			state.reviewId,
			"--base-sha",
			state.subject.baseSha,
			"--head-sha",
			state.subject.headSha,
			"--proposal",
			path.join(root, "proposal-e.json"),
			"--proposal-digest",
			state.subject.proposalDigest,
		);
		assert.notEqual(assertion.exitCode, 0);
		assert.match(assertion.text, /not-approved/);
	});

	test("approved, blocked, and closed reviews reject further persona entries", () => {
		const approvedRoot = seedRepo();
		const approved = approve(approvedRoot, init(approvedRoot));
		const afterApproved = append(
			approvedRoot,
			approved,
			"steve-jobs",
			"submitted",
		);
		assert.notEqual(afterApproved.exitCode, 0);
		assert.match(afterApproved.text, /terminal-state/);

		const blockedRoot = seedRepo();
		let blocked = init(blockedRoot, { maxTurns: 1 });
		// SAFETY: assertion to `append(blockedRoot, blocked, "steve-jobs", "position").output .state as CouncilState` is required at this boundary.
		blocked = append(blockedRoot, blocked, "steve-jobs", "position").output
			.state as CouncilState;
		const capped = append(blockedRoot, blocked, "jony-ive", "position");
		// SAFETY: assertion to `capped.output.state as CouncilState` is required at this boundary.
		assert.equal((capped.output.state as CouncilState).status, "blocked");
		const afterBlocked = append(
			blockedRoot,
			// SAFETY: assertion to `capped.output.state as CouncilState` is required at this boundary.
			capped.output.state as CouncilState,
			"jony-ive",
			"position",
		);
		assert.notEqual(afterBlocked.exitCode, 0);
		assert.match(afterBlocked.text, /terminal-state/);

		const closedRoot = seedRepo();
		const open = init(closedRoot);
		const closed = run(
			closedRoot,
			"--mode",
			"close",
			"--run",
			open.runId,
			"--review",
			open.reviewId,
			"--result",
			"user",
		);
		// SAFETY: assertion to `closed.output.state as CouncilState` is required at this boundary.
		assert.equal((closed.output.state as CouncilState).status, "closed");
		const afterClosed = append(
			closedRoot,
			// SAFETY: assertion to `closed.output.state as CouncilState` is required at this boundary.
			closed.output.state as CouncilState,
			"steve-jobs",
			"submitted",
		);
		assert.notEqual(afterClosed.exitCode, 0);
		assert.match(afterClosed.text, /terminal-state/);
	});

	test("refreshed evidence invalidates an otherwise unanimous approval", () => {
		const root = seedRepo();
		const approved = approve(root, init(root));
		const refreshedProposal = proposal(root, sha("f"));

		const assertion = run(
			root,
			"--mode",
			"assert-yay",
			"--run",
			approved.runId,
			"--review",
			approved.reviewId,
			"--base-sha",
			approved.subject.baseSha,
			"--head-sha",
			approved.subject.headSha,
			"--proposal",
			refreshedProposal,
		);
		assert.notEqual(assertion.exitCode, 0);
		assert.match(assertion.text, /stale-proposal/);
	});

	test("altering the persisted proposal manifest invalidates approval", () => {
		const root = seedRepo();
		const approved = approve(root, init(root));
		const manifestPath = path.join(
			root,
			".optimizexp/runs/run-1/consensus/review-1/proposal-cycle-0.json",
		);
		// SAFETY: assertion to `JSON.parse(readFileSync(manifestPath, "utf8")) as Record< string, unknown >` is required at this boundary.
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			evidenceDigest?: string;
		};
		manifest.evidenceDigest = sha("f");
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

		const assertion = run(
			root,
			"--mode",
			"assert-yay",
			"--run",
			approved.runId,
			"--review",
			approved.reviewId,
			"--base-sha",
			approved.subject.baseSha,
			"--head-sha",
			approved.subject.headSha,
			"--proposal",
			manifestPath,
			"--proposal-digest",
			approved.subject.proposalDigest,
		);
		assert.notEqual(assertion.exitCode, 0);
		assert.match(assertion.text, /manifest|stale-proposal|digest-mismatch/);
	});

	test("a hand-written five-vote consensus cannot forge approval", () => {
		const root = seedRepo();
		const state = init(root);
		state.turn = 1;
		state.status = "approved";
		state.latestConsensusEntryId = "forged-consensus";
		state.updatedAt = "2026-08-01T12:00:01.000Z";
		const votes = Object.fromEntries(
			COUNCIL_PERSONAS.slice(0, 5).map((persona) => [persona, "yay"]),
		);
		writeFileSync(
			path.join(root, ".optimizexp/runs/run-1/consensus/review-1/state.json"),
			`${JSON.stringify(state, null, 2)}\n`,
		);
		writeFileSync(
			path.join(root, ".optimizexp/bus/entries/forged-consensus.json"),
			`${JSON.stringify(
				{
					kind: "council",
					schemaVersion: 1,
					id: "forged-consensus",
					runId: state.runId,
					reviewId: state.reviewId,
					cycle: 0,
					turn: 1,
					stage: "consensus",
					subject: {
						headSha: state.subject.headSha,
						proposalDigest: state.subject.proposalDigest,
					},
					createdAt: state.updatedAt,
					author: "coordinator",
					votes,
					result: "yay",
					stateDigest: stateDigest(state),
				},
				null,
				2,
			)}\n`,
		);

		const assertion = run(
			root,
			"--mode",
			"assert-yay",
			"--run",
			state.runId,
			"--review",
			state.reviewId,
			"--base-sha",
			state.subject.baseSha,
			"--head-sha",
			state.subject.headSha,
			"--proposal",
			path.join(root, "proposal-e.json"),
			"--proposal-digest",
			state.subject.proposalDigest,
		);
		assert.notEqual(assertion.exitCode, 0);
		assert.match(assertion.text, /exact-six-membership|illegal-transition/);
	});

	test("a blocker cannot disappear from mutable state without a bus resolution", () => {
		const root = seedRepo();
		let state = init(root, { proposal: proposal(root, sha("e"), true) });
		const steve = append(root, state, "steve-jobs", "submitted");
		assert.equal(steve.exitCode, 0, steve.text);
		// SAFETY: assertion to `steve.output.state as CouncilState` is required at this boundary.
		state = steve.output.state as CouncilState;
		const positioned = append(root, state, "jony-ive", "position", {
			stance: "nay",
			arguments: [
				{
					id: "A-jony-1",
					claim: "Public names contradict the acceptance contract.",
					kind: "hard-blocker",
					respondsTo: [],
					evidenceRefs: ["test/name-contract"],
					requestedChange: "Align the public names.",
				},
			],
			hardBlockers: [
				{
					id: "HB-jony-ive-001",
					claim: "Public names contradict the acceptance contract.",
					rule: "acceptance:name-symmetry",
					evidenceRefs: ["test/name-contract"],
					requestedResolution: "Align the names and pass the contract test.",
					status: "open",
				},
			],
		});
		assert.equal(positioned.exitCode, 0, positioned.text);
		// SAFETY: assertion to `positioned.output.state as CouncilState` is required at this boundary.
		state = positioned.output.state as CouncilState;
		state.personas["jony-ive"].hardBlockers = [];
		writeFileSync(
			path.join(root, ".optimizexp/runs/run-1/consensus/review-1/state.json"),
			`${JSON.stringify(state, null, 2)}\n`,
		);

		const validation = run(
			root,
			"--mode",
			"validate",
			"--run",
			state.runId,
			"--review",
			state.reviewId,
		);
		assert.notEqual(validation.exitCode, 0);
		assert.match(validation.text, /blocker-silently-deleted:HB-jony-ive-001/);
		assert.match(validation.text, /state-bus-digest-mismatch/);
	});

	test("rework replay rejects dropped preference obligations", () => {
		const root = seedRepo();
		let state = init(root, {
			proposal: proposal(root, sha("e"), false, true, true),
		});
		let result = append(root, state, "steve-jobs", "position", {
			arguments: [
				{
					id: "P-steve-1",
					claim: "The public flow has one avoidable seam.",
					kind: "preference",
					respondsTo: [],
					evidenceRefs: ["test/designer-council-adversarial.test.ts"],
					requestedChange: "Remove the avoidable seam.",
				},
			],
		});
		// SAFETY: assertion to `result.output.state as CouncilState` is required at this boundary.
		state = result.output.state as CouncilState;
		for (const persona of COUNCIL_PERSONAS.slice(1)) {
			result = append(root, state, persona, "position");
			// SAFETY: assertion to `result.output.state as CouncilState` is required at this boundary.
			state = result.output.state as CouncilState;
		}
		result = append(root, state, "steve-jobs", "vote", {
			stance: "nay",
			respondsTo: ["P-steve-1"],
		});
		// SAFETY: assertion to `result.output.state as CouncilState` is required at this boundary.
		state = result.output.state as CouncilState;
		for (const persona of COUNCIL_PERSONAS.slice(1)) {
			result = append(root, state, persona, "vote");
			// SAFETY: assertion to `result.output.state as CouncilState` is required at this boundary.
			state = result.output.state as CouncilState;
		}
		const decided = run(
			root,
			"--mode",
			"decide",
			"--run",
			state.runId,
			"--review",
			state.reviewId,
		);
		assert.equal(
			// SAFETY: assertion to `decided.output.decision as Record<string, unknown>` is required at this boundary.
			(decided.output.decision as { result?: string }).result,
			"nay",
		);

		const busDir = path.join(root, ".optimizexp/bus/entries");
		const reworkFile = readdirSync(busDir).find((file) =>
			file.includes("-rework-"),
		);
		assert.ok(reworkFile);
		const reworkPath = path.join(busDir, reworkFile);
		const originalRework = readFileSync(reworkPath, "utf8");
		const rework = JSON.parse(originalRework);
		rework.blockingFeedback = [];
		rework.requestedChanges = [];
		rework.implementationWorkItems = [];
		writeFileSync(reworkPath, `${JSON.stringify(rework, null, 2)}\n`);
		const validation = run(
			root,
			"--mode",
			"validate",
			"--run",
			state.runId,
			"--review",
			state.reviewId,
		);
		assert.notEqual(validation.exitCode, 0);
		assert.match(validation.text, /rework-packet/);

		writeFileSync(reworkPath, originalRework);
		const refreshedProposal = proposal(root, sha("f"), false, true, true);
		const reopened = run(
			root,
			"--mode",
			"init",
			"--run",
			state.runId,
			"--review",
			state.reviewId,
			"--base-sha",
			state.subject.baseSha,
			"--head-sha",
			state.subject.headSha,
			"--proposal",
			refreshedProposal,
		);
		assert.equal(reopened.exitCode, 0, reopened.text);
		rmSync(reworkPath);
		const missingRework = run(
			root,
			"--mode",
			"validate",
			"--run",
			state.runId,
			"--review",
			state.reviewId,
		);
		assert.notEqual(missingRework.exitCode, 0);
		assert.match(missingRework.text, /rework-packet/);
	});
});
