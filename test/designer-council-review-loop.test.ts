import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { pathToFileURL } from "node:url";
import { afterEach, describe, test } from "vitest";

import { type JsonValue } from "../scripts/lib/inspectable.ts";

function isJsonRecord(
	value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
	return (
		value !== null &&
		!Array.isArray(value) &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

function isJsonString(value: JsonValue): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

import {
	advanceInvestment,
	COUNCIL_PERSONAS,
	type CouncilPersona,
	type CouncilState,
} from "../.agents/skills/optimizexp/harness/lib/design-council.mts";
import { runConsensusCommand } from "../.agents/skills/optimizexp/workflows/cross-agent/consensus-loop.mts";

const REVIEW_LOOP = path.resolve(
	".agents/skills/optimizexp/workflows/cross-agent/review-loop.mts",
);
const roots: string[] = [];
const sha = (character: string) => character.repeat(64);
let reviewLoopImport = 0;
void reviewLoopImport;

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function seedRepo(): string {
	const root = mkdtempSync(path.join(tmpdir(), "council-review-loop-"));
	mkdirSync(path.join(root, ".git"));
	mkdirSync(path.join(root, ".optimizexp/bus/entries"), { recursive: true });
	roots.push(root);
	return root;
}

function proposal(
	root: string,
	overrides: {
		[key: string]: import("../scripts/lib/inspectable.ts").JsonValue;
	} = {},
): string {
	const file = path.join(root, "proposal.json");
	writeFileSync(
		file,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				subject: { kind: "surface", surface: "review-loop fixture" },
				changedPaths: ["src/internal/cache.ts"],
				normalizedDiffHash: sha("d"),
				acceptanceDigest: sha("a"),
				evidenceDigest: sha("e"),
				relevanceSignals: {
					categories: [],
					acceptanceTags: [],
					featureTags: [],
					keywords: [],
				},
				evidenceSignals: {
					evidenceTypes: [],
					currentHead: true,
					acceptanceMapped: true,
				},
				...overrides,
			},
			null,
			2,
		)}\n`,
	);
	return file;
}

function council(root: string, ...args: string[]) {
	const result = runConsensusCommand(["--root", root, ...args]);
	assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
	return result.output;
}

function initCouncil(
	root: string,
	proposalPath: string,
	baseSha = sha("a"),
	headSha = sha("b"),
): CouncilState {
	// SAFETY: assertion to `council( root, "--mode", "init", "--run", "run-1", "--review", "review-1", "--base-sha", baseSha, "--head-sha", headSha,` is required at this boundary.
	return council(
		root,
		"--mode",
		"init",
		"--run",
		"run-1",
		"--review",
		"review-1",
		"--base-sha",
		baseSha,
		"--head-sha",
		headSha,
		"--proposal",
		proposalPath,
	).state as CouncilState;
}

function appendPersona(
	root: string,
	state: CouncilState,
	persona: CouncilPersona,
	stage: "position" | "submitted",
	options: { blocker?: boolean; vote?: "yay" | "nay" } = {},
): CouncilState {
	const current = state.personas[persona];
	const consumesTurn = stage === "position";
	const decay = consumesTurn ? current.decayPerTurn : 0;
	const after = consumesTurn
		? advanceInvestment(current.currentInvestment, decay)
		: current.currentInvestment;
	const turn = state.turn + 1;
	const evidenceRef = "test/designer-council-review-loop.test.ts";
	const blocker = options.blocker
		? {
				id: `HB-${persona}-001`,
				claim: "Current-head acceptance evidence is missing.",
				rule: "required current-head acceptance evidence",
				evidenceRefs: [evidenceRef],
				requestedResolution: "Capture and attach current-head evidence.",
				status: "open",
			}
		: null;
	const entryPath = path.join(root, `${persona}-${stage}-${turn}.json`);
	writeFileSync(
		entryPath,
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
					relevance: current.relevance,
					evidenceStrength: current.evidenceStrength,
					before: current.currentInvestment,
					decay,
					after,
					submitted: stage === "submitted",
				},
				stance: stage === "submitted" ? (options.vote ?? "yay") : null,
				arguments: blocker
					? [
							{
								id: `A-${persona}-001`,
								claim: blocker.claim,
								kind: "hard-blocker",
								respondsTo: [],
								evidenceRefs: [evidenceRef],
								requestedChange: blocker.requestedResolution,
							},
						]
					: [],
				hardBlockers: blocker ? [blocker] : [],
				preferences: [],
				evidenceRefs: blocker ? [evidenceRef] : [],
				requestedChanges: blocker ? [blocker.requestedResolution] : [],
				blindSpotCheck:
					stage === "submitted"
						? "Repository evidence outranks this synthetic review lens."
						: undefined,
			},
			null,
			2,
		)}\n`,
	);
	// SAFETY: assertion to `council( root, "--mode", "append", "--run", state.runId, "--review", state.reviewId, "--entry", entryPath, ).state as Co` is required at this boundary.
	return council(
		root,
		"--mode",
		"append",
		"--run",
		state.runId,
		"--review",
		state.reviewId,
		"--entry",
		entryPath,
	).state as CouncilState;
}

function approve(
	root: string,
	proposalPath: string,
	baseSha = sha("a"),
	headSha = sha("b"),
): CouncilState {
	let state = initCouncil(root, proposalPath, baseSha, headSha);
	for (const persona of COUNCIL_PERSONAS) {
		state = appendPersona(root, state, persona, "submitted");
	}
	// SAFETY: assertion to `council( root, "--mode", "decide", "--run", state.runId, "--review", state.reviewId, ).state as CouncilState` is required at this boundary.
	return council(
		root,
		"--mode",
		"decide",
		"--run",
		state.runId,
		"--review",
		state.reviewId,
	).state as CouncilState;
}

function blockWithJony(
	root: string,
	proposalPath: string,
	options: { decide: boolean },
): CouncilState {
	let state = initCouncil(root, proposalPath);
	state = appendPersona(root, state, "steve-jobs", "submitted");
	state = appendPersona(root, state, "jony-ive", "position", {
		blocker: true,
	});
	for (const persona of COUNCIL_PERSONAS.slice(2)) {
		state = appendPersona(root, state, persona, "submitted");
	}
	state = appendPersona(root, state, "jony-ive", "submitted", {
		vote: "nay",
	});
	if (!options.decide) return state;
	// SAFETY: assertion to `council( root, "--mode", "decide", "--run", state.runId, "--review", state.reviewId, ).state as CouncilState` is required at this boundary.
	return council(
		root,
		"--mode",
		"decide",
		"--run",
		state.runId,
		"--review",
		state.reviewId,
	).state as CouncilState;
}

async function runReviewLoop(
	root: string,
	mode: "validate-bus" | "assert-complete",
) {
	const tail = ["--mode", mode];
	if (mode === "assert-complete") tail.push("--run", "run-1");
	return runReviewLoopCommand(root, tail);
}

async function runReviewLoopCommand(root: string, tail: string[]) {
	const priorArgv = process.argv;
	const priorExitCode = process.exitCode;
	const priorLog = console.log;
	const priorError = console.error;
	const stdout: string[] = [];
	const stderr: string[] = [];
	let output: import("../scripts/lib/inspectable.ts").JsonValue = {};
	try {
		process.argv = [process.execPath, REVIEW_LOOP, "--root", root, ...tail];
		process.exitCode = undefined;
		console.log = (...items: unknown[]) =>
			stdout.push(items.map(String).join(" "));
		console.error = (...items: unknown[]) =>
			stderr.push(items.map(String).join(" "));
		await import(
			`${pathToFileURL(REVIEW_LOOP).href}?designer-council-test=${reviewLoopImport++}`
		);
		try {
			output = JSON.parse(stdout.at(-1) ?? "{}");
		} catch {
			// Assertions include captured output when it is unexpectedly non-JSON.
		}
		return {
			code: Number.isInteger(process.exitCode) ? Number(process.exitCode) : 0,
			output,
			text: `${stdout.join("\n")}${stderr.length ? `\n${stderr.join("\n")}` : ""}`,
		};
	} finally {
		process.argv = priorArgv;
		process.exitCode = priorExitCode;
		console.log = priorLog;
		console.error = priorError;
	}
}

function configureRequiredCouncil(
	root: string,
	proposalPath: string,
	headSha = sha("b"),
	baseSha = sha("a"),
): void {
	const scopePath = path.join(root, ".optimizexp/runs/run-1/scope.json");
	const scope = JSON.parse(readFileSync(scopePath, "utf8"));
	scope.designerConsensus = {
		required: true,
		reviewId: "review-1",
		baseSha,
		headSha,
		proposalPath: path.relative(root, proposalPath),
	};
	writeFileSync(scopePath, `${JSON.stringify(scope, null, 2)}\n`);
}

function gitProcess(root: string, ...args: string[]) {
	const env = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_PREFIX",
	])
		delete env[key];
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		env,
	});
	assert.equal(result.status, 0, result.stderr);
	return result;
}

function git(root: string, ...args: string[]): string {
	const result = gitProcess(root, ...args);
	return result.stdout.trim();
}

function configureExemptCouncil(
	root: string,
	overrides: {
		[key: string]: import("../scripts/lib/inspectable.ts").JsonValue;
	} = {},
): void {
	const scopePath = path.join(root, ".optimizexp/runs/run-1/scope.json");
	const scope = JSON.parse(readFileSync(scopePath, "utf8"));
	scope.designerConsensusPolicy = "required-when-design-relevant";
	scope.designerConsensus = {
		required: false,
		changedPaths: ["src/internal/cache.ts"],
		acceptanceTags: [],
		explicitlyRequested: false,
		priorCouncilCycle: false,
		exemption: {
			code: "internal-no-public-behavior",
			justification:
				"Private cache rename; exported behavior and errors unchanged.",
		},
		...overrides,
	};
	writeFileSync(scopePath, `${JSON.stringify(scope, null, 2)}\n`);
}

async function initRun(root: string): Promise<void> {
	const result = await runReviewLoopCommand(root, [
		"--mode",
		"init",
		"--run",
		"run-1",
		"--experiences",
		"dx",
	]);
	assert.equal(result.code, 0, result.text);
}

function councilMissing(
	result: Awaited<ReturnType<typeof runReviewLoop>>,
): string[] {
	const output = result.output;
	if (!isJsonRecord(output)) return [];
	const missing = output.missing;
	if (!Array.isArray(missing)) return [];
	return missing.flatMap((item) => {
		if (!isJsonString(item)) return [];
		return /council|consensus|blocker|voter|stale|state-bus/.test(item)
			? [item]
			: [];
	});
}

/**
 * Sixty seconds, not the global ten.
 *
 * Every test here seeds a real git repository in a temp dir, and this suite
 * alone spawns 32 git subprocesses. Run alone that is about a second; run
 * inside the full pre-commit turbo matrix, competing with every package build
 * for CPU and disk, it crosses ten and the suite fails for want of a machine
 * rather than for a defect — which is the worst kind of red, because the fix
 * looks like "re-run it".
 *
 * The timeout is set here rather than raised globally on purpose: a genuinely
 * hung test elsewhere should still fail in ten seconds.
 */
describe("OptimizeXP review-loop designer council integration", () => {
	test("validate-bus accepts persisted council history and rejects malformed council entries", async () => {
		const validRoot = seedRepo();
		initCouncil(validRoot, proposal(validRoot));
		const valid = await runReviewLoop(validRoot, "validate-bus");
		assert.equal(valid.code, 0, valid.text);

		const invalidRoot = seedRepo();
		initCouncil(invalidRoot, proposal(invalidRoot));
		const busDir = path.join(invalidRoot, ".optimizexp/bus/entries");
		const openFile = readdirSync(busDir).find((file) =>
			file.includes("-open-"),
		);
		assert.ok(openFile);
		const openPath = path.join(busDir, openFile);
		const open = JSON.parse(readFileSync(openPath, "utf8"));
		open.council.push("unknown-seventh-designer");
		writeFileSync(openPath, `${JSON.stringify(open, null, 2)}\n`);
		const invalid = await runReviewLoop(invalidRoot, "validate-bus");
		assert.notEqual(invalid.code, 0, invalid.text);
		assert.match(
			invalid.text,
			/exact-six-membership|unknown persona|exactly 6/,
		);
	});

	test("assert-complete requires a configured council review", async () => {
		const root = seedRepo();
		const proposalPath = proposal(root);
		await initRun(root);
		configureRequiredCouncil(root, proposalPath);
		const result = await runReviewLoop(root, "assert-complete");
		assert.notEqual(result.code, 0, result.text);
		assert.match(councilMissing(result).join("\n"), /missing/);
	});

	test("assert-complete rejects exemptions after an explicit request or prior council cycle", async () => {
		const requestedRoot = seedRepo();
		await initRun(requestedRoot);
		configureExemptCouncil(requestedRoot, { explicitlyRequested: true });
		const requested = await runReviewLoop(requestedRoot, "assert-complete");
		assert.match(
			councilMissing(requested).join("\n"),
			/designer_consensus_exemption_rejected/,
		);

		const priorRoot = seedRepo();
		await initRun(priorRoot);
		initCouncil(priorRoot, proposal(priorRoot));
		configureExemptCouncil(priorRoot);
		const prior = await runReviewLoop(priorRoot, "assert-complete");
		assert.match(
			councilMissing(prior).join("\n"),
			/designer_consensus_exemption_rejected/,
		);
	});

	test("assert-complete rejects nay, missing-voter, and open-blocker reviews", async () => {
		const nayRoot = seedRepo();
		const nayProposal = proposal(nayRoot);
		await initRun(nayRoot);
		blockWithJony(nayRoot, nayProposal, { decide: true });
		configureRequiredCouncil(nayRoot, nayProposal);
		const nay = await runReviewLoop(nayRoot, "assert-complete");
		assert.notEqual(nay.code, 0, nay.text);
		assert.match(councilMissing(nay).join("\n"), /nay|unanimous|not-approved/);

		const missingRoot = seedRepo();
		const missingProposal = proposal(missingRoot);
		await initRun(missingRoot);
		let state = initCouncil(missingRoot, missingProposal);
		for (const persona of COUNCIL_PERSONAS.slice(0, 5)) {
			state = appendPersona(missingRoot, state, persona, "submitted");
		}
		configureRequiredCouncil(missingRoot, missingProposal);
		const missing = await runReviewLoop(missingRoot, "assert-complete");
		assert.notEqual(missing.code, 0, missing.text);
		assert.match(
			councilMissing(missing).join("\n"),
			/missing.*vot|not-approved/,
		);

		const blockerRoot = seedRepo();
		const blockerProposal = proposal(blockerRoot);
		await initRun(blockerRoot);
		blockWithJony(blockerRoot, blockerProposal, { decide: false });
		configureRequiredCouncil(blockerRoot, blockerProposal);
		const blocker = await runReviewLoop(blockerRoot, "assert-complete");
		assert.notEqual(blocker.code, 0, blocker.text);
		assert.match(
			councilMissing(blocker).join("\n"),
			/open.*blocker|not-approved/,
		);
	});

	test("assert-complete rejects stale approval and state-bus disagreement", async () => {
		const staleRoot = seedRepo();
		const staleProposal = proposal(staleRoot);
		await initRun(staleRoot);
		approve(staleRoot, staleProposal);
		configureRequiredCouncil(staleRoot, staleProposal, sha("c"));
		const stale = await runReviewLoop(staleRoot, "assert-complete");
		assert.notEqual(stale.code, 0, stale.text);
		assert.match(councilMissing(stale).join("\n"), /stale.*head/);

		const mismatchRoot = seedRepo();
		const mismatchProposal = proposal(mismatchRoot);
		await initRun(mismatchRoot);
		approve(mismatchRoot, mismatchProposal);
		configureRequiredCouncil(mismatchRoot, mismatchProposal);
		const statePath = path.join(
			mismatchRoot,
			".optimizexp/runs/run-1/consensus/review-1/state.json",
		);
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		state.blockedReason = "tampered after consensus";
		writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
		const mismatch = await runReviewLoop(mismatchRoot, "assert-complete");
		assert.notEqual(mismatch.code, 0, mismatch.text);
		assert.match(
			councilMissing(mismatch).join("\n"),
			/state-bus|digest.*mismatch/,
		);
	});

	test("assert-complete compares approval with the checkout's actual head", async () => {
		const root = seedRepo();
		git(root, "init");
		git(root, "config", "user.name", "Council Test");
		git(root, "config", "user.email", "council@example.invalid");
		writeFileSync(path.join(root, "base.txt"), "base\n");
		git(root, "add", "base.txt");
		git(root, "commit", "-m", "base");
		const baseSha = git(root, "rev-parse", "HEAD");
		writeFileSync(path.join(root, "feature.txt"), "feature\n");
		git(root, "add", "feature.txt");
		git(root, "commit", "-m", "feature");
		const approvedHead = git(root, "rev-parse", "HEAD");
		const proposalPath = proposal(root);
		await initRun(root);
		approve(root, proposalPath, baseSha, approvedHead);
		configureRequiredCouncil(root, proposalPath, approvedHead, baseSha);

		writeFileSync(path.join(root, "later.txt"), "later\n");
		git(root, "add", "later.txt");
		git(root, "commit", "-m", "later");
		const inheritedGitDir = process.env.GIT_DIR;
		process.env.GIT_DIR = path.resolve(".git");
		const stale = await runReviewLoop(root, "assert-complete").finally(() => {
			if (inheritedGitDir === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = inheritedGitDir;
		});
		assert.match(councilMissing(stale).join("\n"), /stale.*head/);
	});

	test("assert-complete binds exemptions and proposals to the effective Git diff", async () => {
		const root = seedRepo();
		git(root, "init");
		git(root, "config", "user.name", "Council Test");
		git(root, "config", "user.email", "council@example.invalid");
		writeFileSync(path.join(root, "base.txt"), "base\n");
		git(root, "add", "base.txt");
		git(root, "commit", "-m", "base");
		const baseSha = git(root, "rev-parse", "HEAD");
		git(root, "update-ref", "refs/remotes/origin/main", baseSha);
		mkdirSync(path.join(root, "packages/cli/src"), { recursive: true });
		writeFileSync(
			path.join(root, "packages/cli/src/help.ts"),
			"export const help = 'help';\n",
		);
		git(root, "add", "packages/cli/src/help.ts");
		git(root, "commit", "-m", "feature");
		const headSha = git(root, "rev-parse", "HEAD");
		await initRun(root);
		configureExemptCouncil(root, {
			baseSha,
			headSha,
			changedPaths: ["src/internal/cache.ts"],
		});
		const exempt = await runReviewLoop(root, "assert-complete");
		assert.match(councilMissing(exempt).join("\n"), /exemption_paths_mismatch/);

		const requiredRoot = seedRepo();
		git(requiredRoot, "init");
		git(requiredRoot, "config", "user.name", "Council Test");
		git(requiredRoot, "config", "user.email", "council@example.invalid");
		writeFileSync(path.join(requiredRoot, "base.txt"), "base\n");
		git(requiredRoot, "add", "base.txt");
		git(requiredRoot, "commit", "-m", "base");
		const requiredBaseSha = git(requiredRoot, "rev-parse", "HEAD");
		git(
			requiredRoot,
			"update-ref",
			"refs/remotes/origin/main",
			requiredBaseSha,
		);
		mkdirSync(path.join(requiredRoot, "src/internal"), { recursive: true });
		writeFileSync(
			path.join(requiredRoot, "src/internal/cache.ts"),
			"export const cache = true;\n",
		);
		git(requiredRoot, "add", "src/internal/cache.ts");
		git(requiredRoot, "commit", "-m", "feature");
		const requiredHeadSha = git(requiredRoot, "rev-parse", "HEAD");
		await initRun(requiredRoot);
		const diff = gitProcess(
			requiredRoot,
			"diff",
			"--no-ext-diff",
			"--binary",
			"--full-index",
			requiredBaseSha,
			requiredHeadSha,
			"--",
		).stdout.replaceAll("\r\n", "\n");
		const proposalPath = proposal(requiredRoot, {
			changedPaths: ["src/internal/cache.ts"],
			normalizedDiffHash: createHash("sha256")
				.update(`${diff}tampered`)
				.digest("hex"),
		});
		approve(requiredRoot, proposalPath, requiredBaseSha, requiredHeadSha);
		configureRequiredCouncil(
			requiredRoot,
			proposalPath,
			requiredHeadSha,
			requiredBaseSha,
		);
		const required = await runReviewLoop(requiredRoot, "assert-complete");
		assert.match(councilMissing(required).join("\n"), /proposal_diff_mismatch/);
	});

	test("current-subject exact-six unanimous yay clears council-specific blockers", async () => {
		const root = seedRepo();
		const proposalPath = proposal(root);
		await initRun(root);
		approve(root, proposalPath);
		configureRequiredCouncil(root, proposalPath);
		const result = await runReviewLoop(root, "assert-complete");
		assert.deepEqual(councilMissing(result), [], result.text);
	});
}, 60_000);
