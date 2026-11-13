import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	DEFAULT_REUSE_MERGE_QUEUE,
	decideMergeQueueReuse,
	fetchMergeGroupRuns,
	MERGE_GROUP_RUN_LOOKUPS,
	type MergeGroupRun,
	type ReuseInput,
	reuseMergeQueueSetting,
} from "../ci/merge-queue-reuse.mts";

const HEAD = "f0b586a1a8bb83c39ed13ba11753ef8b2dc66f29";
const TREE = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";

function run(overrides: Partial<MergeGroupRun> = {}): MergeGroupRun {
	return {
		id: 43271000454,
		event: "merge_group",
		status: "completed",
		conclusion: "success",
		path: ".github/workflows/hobo-ci.yml",
		head_sha: HEAD,
		head_branch:
			"gh-readonly-queue/main/pr-1955-accb405bb83dc3c9f9cdf2b496171e7f03a92105",
		head_commit: { tree_id: TREE },
		repository: { full_name: "Hobo-Labs/HoBo" },
		head_repository: { full_name: "Hobo-Labs/HoBo" },
		...overrides,
	};
}

function input(overrides: Partial<ReuseInput> = {}): ReuseInput {
	return {
		eventName: "push",
		ref: "refs/heads/main",
		enabled: true,
		repository: "Hobo-Labs/HoBo",
		workflowBasename: "hobo-ci.yml",
		headSha: HEAD,
		headTree: TREE,
		runs: [run()],
		...overrides,
	};
}

describe("merge-queue reuse on main", () => {
	it("reuses a successful merge-queue run of the pushed commit", () => {
		const decision = decideMergeQueueReuse(input());
		assert.equal(decision.reuse, true);
		assert.equal(decision.runId, 43271000454);
		assert.match(decision.reason, /this commit/u);
	});

	it("reuses a successful merge-queue run of the same tree on another commit", () => {
		const decision = decideMergeQueueReuse(
			input({ runs: [run({ head_sha: OTHER })] }),
		);
		assert.equal(decision.reuse, true);
		assert.match(decision.reason, /this tree on another commit/u);
	});

	it("matches the commit when the push payload carries no tree", () => {
		assert.equal(decideMergeQueueReuse(input({ headTree: "" })).reuse, true);
		assert.equal(
			decideMergeQueueReuse(
				input({ headTree: "", runs: [run({ head_sha: OTHER })] }),
			).reuse,
			false,
		);
	});

	it("is off when committed runnerRouting.mainGate.reuseMergeQueue is false", () => {
		const decision = decideMergeQueueReuse(input({ enabled: false }));
		assert.equal(decision.reuse, false);
		assert.match(
			decision.reason,
			/runnerRouting\.mainGate\.reuseMergeQueue is false/u,
		);
	});

	it("reads the setting from .hobo/ci.json, never from the environment", () => {
		const committed = readFileSync(
			new URL("../../.hobo/ci.json", import.meta.url),
			"utf8",
		);
		// The committed value is the default an unset variable had: on.
		assert.equal(DEFAULT_REUSE_MERGE_QUEUE, true);
		assert.equal(reuseMergeQueueSetting(committed), true);
		const project = JSON.parse(committed);
		project.runnerRouting.mainGate.reuseMergeQueue = false;
		assert.equal(reuseMergeQueueSetting(JSON.stringify(project)), false);
		// No valid policy, or no file: the default.
		assert.equal(reuseMergeQueueSetting(undefined), true);
		assert.equal(reuseMergeQueueSetting("{}"), true);
		const script = readFileSync(
			new URL("../ci/merge-queue-reuse.mts", import.meta.url),
			"utf8",
		);
		assert.doesNotMatch(script, /HOBO_CI_MAIN_REUSE_MERGE_QUEUE/u);
	});

	it("applies only to a push to main", () => {
		for (const overrides of [
			{ eventName: "schedule" },
			{ eventName: "workflow_dispatch" },
			{ eventName: "merge_group" },
			{ ref: "refs/heads/release" },
		])
			assert.equal(decideMergeQueueReuse(input(overrides)).reuse, false);
	});

	it("never reuses a run that is not a green merge-queue run of this workflow here", () => {
		const refused: Partial<MergeGroupRun>[] = [
			{ conclusion: "failure" },
			{ conclusion: "cancelled" },
			{ conclusion: null, status: "in_progress" },
			{ event: "pull_request" },
			{ event: "push" },
			{ path: ".github/workflows/pricing-ci.yml" },
			{ head_branch: "main" },
			{ head_branch: "feature/gh-readonly-queue/main/pr-1" },
			{ head_branch: null },
			{ repository: { full_name: "someone/fork" } },
			{ head_repository: { full_name: "someone/fork" } },
			{ head_sha: OTHER, head_commit: { tree_id: OTHER } },
			{ head_sha: OTHER, head_commit: null },
		];
		for (const overrides of refused) {
			const decision = decideMergeQueueReuse(input({ runs: [run(overrides)] }));
			assert.equal(decision.reuse, false, JSON.stringify(overrides));
		}
	});

	it("says a red merge-queue run for the tree is not a pass", () => {
		const decision = decideMergeQueueReuse(
			input({ runs: [run({ conclusion: "failure" })] }),
		);
		assert.match(decision.reason, /did not succeed/u);
	});

	it("takes a later green run of the tree over an earlier red one", () => {
		const decision = decideMergeQueueReuse(
			input({ runs: [run({ id: 1, conclusion: "failure" }), run({ id: 2 })] }),
		);
		assert.equal(decision.reuse, true);
		assert.equal(decision.runId, 2);
	});

	it("refuses a direct push that never went through the queue", () => {
		const decision = decideMergeQueueReuse(input({ runs: [] }));
		assert.equal(decision.reuse, false);
		assert.match(decision.reason, /no merge-queue run/u);
	});

	it("refuses an unknown pushed commit", () => {
		assert.equal(decideMergeQueueReuse(input({ headSha: "" })).reuse, false);
		assert.equal(
			decideMergeQueueReuse(input({ headSha: "not-a-sha" })).reuse,
			false,
		);
	});
});

describe("merge-queue run lookup", () => {
	it("reads successful merge_group runs of this workflow only", async () => {
		const seen: string[] = [];
		const runs = await fetchMergeGroupRuns({
			repository: "Hobo-Labs/HoBo",
			token: "t",
			workflowBasename: "hobo-ci.yml",
			fetch: async (url) => {
				seen.push(url);
				return {
					ok: true,
					status: 200,
					json: async () => ({ workflow_runs: [run()] }),
				};
			},
		});
		assert.equal(runs?.length, 1);
		assert.equal(
			seen[0],
			`https://api.github.com/repos/Hobo-Labs/HoBo/actions/workflows/hobo-ci.yml/runs?event=merge_group&status=success&per_page=${MERGE_GROUP_RUN_LOOKUPS}`,
		);
	});

	it("answers undefined, never throws, when GitHub refuses or the read dies", async () => {
		const base = {
			repository: "Hobo-Labs/HoBo",
			token: "t",
			workflowBasename: "hobo-ci.yml",
		};
		assert.equal(
			await fetchMergeGroupRuns({
				...base,
				fetch: async () => ({ ok: false, status: 403, json: async () => ({}) }),
			}),
			undefined,
		);
		assert.equal(
			await fetchMergeGroupRuns({
				...base,
				fetch: async () => {
					throw new Error("network");
				},
			}),
			undefined,
		);
		assert.equal(
			await fetchMergeGroupRuns({
				...base,
				token: "",
				fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
			}),
			undefined,
		);
	});
});
