import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	DEFAULT_REUSE_PR_FABRIC,
	decidePrFabricReuse,
	type FetchJson,
	fetchPrFabricEvidence,
	MERGE_QUEUE_ENTRY_PATTERN,
	PR_FABRIC_RUN_LOOKUPS,
	type PrFabricReuseInput,
	parseMergeQueueEntry,
	prFabricGateJobsSucceeded,
	reusePrFabricSetting,
} from "../ci/pr-fabric-reuse.mts";
import type { JsonValue } from "../ci/runner-routing.mts";

const HEAD = "ca91473da26278a7c73a4f0dd48390904ba69ffe";
const TREE = "1111111111111111111111111111111111111111";
const OTHER_TREE = "2222222222222222222222222222222222222222";
const PR_HEAD = "4c461726af014f417fd1f6e524c019900b28e251";
const BASE = "e4693b4793c9f136793c12cbe26cb8ca1125b465";
const BRANCH = `gh-readonly-queue/main/pr-2016-${BASE}`;

function evidence(overrides: Partial<PrFabricReuseInput> = {}) {
	return {
		mergeTree: TREE,
		prHeadTree: TREE,
		baseAncestor: true,
		...overrides,
	};
}

function input(overrides: Partial<PrFabricReuseInput> = {}) {
	return {
		eventName: "merge_group",
		headBranch: BRANCH,
		enabled: true,
		eventBase: BASE,
		...overrides,
	};
}

describe("the merge-queue entry branch name", () => {
	it("names the pull number, target base ref and base tip", () => {
		assert.deepEqual(parseMergeQueueEntry(BRANCH), {
			pr: 2016,
			baseRef: "main",
			base: BASE,
		});
	});

	it("is nothing else: main, forks of the pattern, other refs, truncations", () => {
		for (const branch of [
			"main",
			"gh-readonly-queue/main/pr-2016",
			`gh-readonly-queue/main/pr-2016-${BASE.slice(0, 39)}`,
			`feature/gh-readonly-queue/main/pr-2016-${BASE}`,
			`gh-readonly-queue/release/pr-2016-${BASE}`,
			`gh-readonly-queue/main/pr-zero-${BASE}`,
			undefined,
			null,
		])
			assert.equal(parseMergeQueueEntry(branch), undefined, String(branch));
	});

	it("accepts an event that spells the base tip in uppercase", () => {
		const decision = decidePrFabricReuse({
			...input({ eventBase: BASE.toUpperCase() }),
			...evidence({ runId: 44766571780 }),
		});
		assert.equal(decision.reuse, true);
	});
});

describe("pr-fabric reuse on a merge group", () => {
	it("reuses a green PR Fabric run that tested the same tree at the same base", () => {
		const decision = decidePrFabricReuse({
			...input({}),
			...evidence({ runId: 44766571780 }),
		});
		assert.equal(decision.reuse, true);
		assert.equal(decision.pr, 2016);
		assert.equal(decision.runId, 44766571780);
		assert.match(decision.reason, /green PR Fabric run/u);
	});

	it("refuses reuse without a valid PR Fabric run ID", () => {
		for (const runId of [
			undefined,
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			const decision = decidePrFabricReuse({
				...input({}),
				...evidence({ runId }),
			});
			assert.equal(decision.reuse, false, String(runId));
			assert.equal(decision.runId, undefined, String(runId));
		}
	});

	it("is off when committed runnerRouting.mergeGroup.reusePrFabric is false", () => {
		const decision = decidePrFabricReuse({
			...input({}),
			...evidence(),
			enabled: false,
		});
		assert.equal(decision.reuse, false);
		assert.match(
			decision.reason,
			/runnerRouting\.mergeGroup\.reusePrFabric is false/u,
		);
	});

	it("reads only valid committed policy and fails closed on unreadable or invalid config", () => {
		const committed = readFileSync(
			new URL("../../.hobo/ci.json", import.meta.url),
			"utf8",
		);
		assert.equal(DEFAULT_REUSE_PR_FABRIC, false);
		assert.equal(typeof reusePrFabricSetting(committed), "boolean");
		const project = JSON.parse(committed);
		project.runnerRouting.mergeGroup.reusePrFabric = false;
		assert.equal(reusePrFabricSetting(JSON.stringify(project)), false);
		for (const invalid of [undefined, "", "{", "{}"])
			assert.equal(reusePrFabricSetting(invalid), false, String(invalid));
		project.runnerRouting.mergeGroup.reusePrFabric = "true";
		assert.equal(reusePrFabricSetting(JSON.stringify(project)), false);
	});

	it("applies only to a merge group", () => {
		for (const eventName of ["push", "pull_request", "schedule"])
			assert.equal(
				decidePrFabricReuse({
					...input({}),
					...evidence(),
					eventName,
				}).reuse,
				false,
			);
	});

	it("refuses a branch the entry pattern does not name a PR and base for", () => {
		for (const headBranch of ["main", "", undefined])
			assert.equal(decidePrFabricReuse(input({ headBranch })).reuse, false);
	});

	it("refuses a base tip the event's merge_group.base_sha does not confirm", () => {
		const decision = decidePrFabricReuse({
			...input({ eventBase: BASE.replace(/^e/u, "f") }),
			...evidence(),
		});
		assert.equal(decision.reuse, false);
		assert.match(decision.reason, /merge_group\.base_sha/u);
	});

	it("asks for evidence before any is fetched", () => {
		const decision = decidePrFabricReuse(input({}));
		assert.equal(decision.reuse, false);
		assert.match(decision.reason, /no green PR Fabric run verified/u);
	});

	it("refuses a PR run that tested another tree", () => {
		const decision = decidePrFabricReuse({
			...input({}),
			...evidence({ prHeadTree: OTHER_TREE }),
		});
		assert.equal(decision.reuse, false);
		assert.match(decision.reason, /another tree/u);
	});

	it("refuses a PR head that does not contain the base tip", () => {
		const decision = decidePrFabricReuse({
			...input({}),
			...evidence({ baseAncestor: false }),
		});
		assert.equal(decision.reuse, false);
		assert.match(decision.reason, /not contained in the PR head/u);
	});

	it("refuses an unfetched ancestry or a tree the API did not confirm", () => {
		for (const overrides of [
			{ baseAncestor: undefined },
			{ prHeadTree: undefined },
			{ mergeTree: "" },
			{ prHeadTree: "not-a-sha" },
		])
			assert.equal(
				decidePrFabricReuse({ ...input({}), ...evidence(), ...overrides })
					.reuse,
				false,
				JSON.stringify(overrides),
			);
	});
});

function api(
	routes: Record<string, JsonValue>,
	seen: string[] = [],
): FetchJson {
	return async (url) => {
		seen.push(url);
		const path = url.replace("https://api.github.com/repos/Hobo-Labs/HoBo", "");
		const route = routes[path];
		if (route === undefined)
			return { ok: false, status: 404, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => route };
	};
}

const greenRun = {
	id: 44766571780,
	event: "pull_request",
	status: "completed",
	conclusion: "success",
	path: ".github/workflows/hobo-ci.yml",
	head_sha: PR_HEAD,
	repository: { full_name: "Hobo-Labs/HoBo" },
	head_repository: { full_name: "Hobo-Labs/HoBo" },
	pull_requests: [{ number: 2016, base: { ref: "main", sha: BASE } }],
};

const routes = {
	"/git/commits/ca91473da26278a7c73a4f0dd48390904ba69ffe": {
		tree: { sha: TREE },
		parents: [{ sha: BASE }],
	},
	"/pulls/2016": {
		head: {
			ref: "cursor/merge-queue-tree-reuse",
			repo: { full_name: "Hobo-Labs/HoBo" },
		},
	},
	[`/actions/workflows/hobo-ci.yml/runs?event=pull_request&status=success&branch=cursor%2Fmerge-queue-tree-reuse&per_page=${PR_FABRIC_RUN_LOOKUPS}`]:
		{ workflow_runs: [greenRun] },
	[`/git/commits/${PR_HEAD}`]: { tree: { sha: TREE } },
	[`/compare/${BASE}...${PR_HEAD}`]: { merge_base_commit: { sha: BASE } },
	"/actions/runs/44766571780/jobs?per_page=100&filter=latest": {
		jobs: [
			{ name: "PR impact validation", conclusion: "success" },
			{ name: "Scripts tests", conclusion: "success" },
			{ name: "Workspace test shard 0", conclusion: "success" },
			{ name: "Workspace test shard 1", conclusion: "success" },
		],
	},
};

describe("the evidence fetch", () => {
	it("reads the merge head, the pull, the green runs, the PR head and the compare", async () => {
		const seen: string[] = [];
		const fetched = await fetchPrFabricEvidence({
			fetch: api(routes, seen),
			repository: "Hobo-Labs/HoBo",
			workflowBasename: "hobo-ci.yml",
			token: "t",
			pr: 2016,
			baseRef: "main",
			base: BASE,
			mergeHeadSha: HEAD,
		});
		assert.deepEqual(fetched, {
			mergeTree: TREE,
			prHeadTree: TREE,
			baseAncestor: true,
			runId: 44766571780,
		});
		assert.equal(seen.length, 6);
	});

	it("refuses a green run when any fabric gate job did not succeed", async () => {
		const runsRoute = `/actions/workflows/hobo-ci.yml/runs?event=pull_request&status=success&branch=cursor%2Fmerge-queue-tree-reuse&per_page=${PR_FABRIC_RUN_LOOKUPS}`;
		const jobsRoute =
			"/actions/runs/44766571780/jobs?per_page=100&filter=latest";
		const okJobs = routes[jobsRoute];
		for (const jobs of [
			{ jobs: [{ name: "PR impact validation", conclusion: "skipped" }] },
			{
				jobs: [
					{ name: "PR impact validation", conclusion: "success" },
					{ name: "Scripts tests", conclusion: "skipped" },
				],
			},
			{
				jobs: [
					{ name: "PR impact validation", conclusion: "success" },
					{ name: "Scripts tests", conclusion: "success" },
				],
			},
		]) {
			const fetched = await fetchPrFabricEvidence({
				fetch: api({
					...routes,
					[runsRoute]: { workflow_runs: [greenRun] },
					[jobsRoute]: jobs,
				}),
				repository: "Hobo-Labs/HoBo",
				workflowBasename: "hobo-ci.yml",
				token: "t",
				pr: 2016,
				baseRef: "main",
				base: BASE,
				mergeHeadSha: HEAD,
			});
			assert.equal(fetched, undefined, JSON.stringify(jobs));
		}
		assert.equal(prFabricGateJobsSucceeded(okJobs), true);
	});

	it("skips runs that are not green same-repo runs of this workflow bound to the merge entry", async () => {
		const runsRoute = `/actions/workflows/hobo-ci.yml/runs?event=pull_request&status=success&branch=cursor%2Fmerge-queue-tree-reuse&per_page=${PR_FABRIC_RUN_LOOKUPS}`;
		for (const overrides of [
			{ conclusion: "failure" },
			{ status: "in_progress", conclusion: null },
			{ event: "merge_group" },
			{ path: ".github/workflows/pricing-ci.yml" },
			{ path: ".github/workflows/elsewhere/hobo-ci.yml" },
			{ repository: { full_name: "someone/fork" } },
			{ head_repository: { full_name: "someone/fork" } },
			{ head_repository: null },
			{ head_sha: "not-a-sha" },
			{ pull_requests: null },
			{ pull_requests: [] },
			{
				pull_requests: [{ number: 2919, base: { ref: "main", sha: BASE } }],
			},
			{
				pull_requests: [{ number: 2016, base: { ref: "release", sha: BASE } }],
			},
			{
				pull_requests: [{ number: 2016, base: { ref: "main", sha: HEAD } }],
			},
		]) {
			const fetched = await fetchPrFabricEvidence({
				fetch: api({
					...routes,
					[runsRoute]: { workflow_runs: [{ ...greenRun, ...overrides }] },
				}),
				repository: "Hobo-Labs/HoBo",
				workflowBasename: "hobo-ci.yml",
				token: "t",
				pr: 2016,
				baseRef: "main",
				base: BASE,
				mergeHeadSha: HEAD,
			});
			assert.equal(fetched, undefined, JSON.stringify(overrides));
		}
	});

	it("scans past green runs that fail the tree or ancestry checks", async () => {
		const staleHead = "3333333333333333333333333333333333333333";
		const divergedHead = "4444444444444444444444444444444444444444";
		const withStaleRuns = {
			...routes,
			[`/actions/workflows/hobo-ci.yml/runs?event=pull_request&status=success&branch=cursor%2Fmerge-queue-tree-reuse&per_page=${PR_FABRIC_RUN_LOOKUPS}`]:
				{
					workflow_runs: [
						{ ...greenRun, head_repository: { full_name: "someone/fork" } },
						{ ...greenRun, id: 1, head_sha: staleHead },
						{ ...greenRun, id: 2, head_sha: divergedHead },
						greenRun,
					],
				},
			[`/git/commits/${staleHead}`]: { tree: { sha: OTHER_TREE } },
			[`/git/commits/${divergedHead}`]: { tree: { sha: TREE } },
			[`/compare/${BASE}...${divergedHead}`]: {
				merge_base_commit: { sha: staleHead },
			},
		};
		const fetched = await fetchPrFabricEvidence({
			fetch: api(withStaleRuns),
			repository: "Hobo-Labs/HoBo",
			workflowBasename: "hobo-ci.yml",
			token: "t",
			pr: 2016,
			baseRef: "main",
			base: BASE,
			mergeHeadSha: HEAD,
		});
		assert.equal(fetched?.runId, 44766571780);
	});

	it("answers undefined, never throws, when any read fails or is refused", async () => {
		const cases: (Record<string, JsonValue> | null)[] = [
			null,
			{
				"/git/commits/ca91473da26278a7c73a4f0dd48390904ba69ffe": {
					tree: { sha: TREE },
					parents: [{ sha: "0000000000000000000000000000000000000000" }],
				},
			},
			{ "/pulls/2016": { head: {} } },
			{
				[`/actions/workflows/hobo-ci.yml/runs?event=pull_request&status=success&branch=cursor%2Fmerge-queue-tree-reuse&per_page=${PR_FABRIC_RUN_LOOKUPS}`]:
					{ workflow_runs: [] },
			},
			{
				[`/git/commits/${PR_HEAD}`]: { tree: {} },
			},
		];
		for (const overridden of cases) {
			const fetched = await fetchPrFabricEvidence({
				fetch: api(overridden === null ? {} : { ...routes, ...overridden }),
				repository: "Hobo-Labs/HoBo",
				workflowBasename: "hobo-ci.yml",
				token: "t",
				pr: 2016,
				baseRef: "main",
				base: BASE,
				mergeHeadSha: HEAD,
			});
			assert.equal(fetched, undefined, JSON.stringify(overridden));
		}
		const failing: FetchJson = async () => {
			throw new Error("network");
		};
		assert.equal(
			await fetchPrFabricEvidence({
				fetch: failing,
				repository: "Hobo-Labs/HoBo",
				workflowBasename: "hobo-ci.yml",
				token: "t",
				pr: 2016,
				baseRef: "main",
				base: BASE,
				mergeHeadSha: HEAD,
			}),
			undefined,
		);
		assert.equal(
			await fetchPrFabricEvidence({
				fetch: api(routes),
				repository: "Hobo-Labs/HoBo",
				workflowBasename: "hobo-ci.yml",
				token: "",
				pr: 2016,
				baseRef: "main",
				base: BASE,
				mergeHeadSha: HEAD,
			}),
			undefined,
		);
	});

	it("keeps the entry pattern anchored to the whole branch name", () => {
		assert.equal(MERGE_QUEUE_ENTRY_PATTERN.test(`x${BRANCH}`), false);
		assert.equal(MERGE_QUEUE_ENTRY_PATTERN.test(`${BRANCH}x`), false);
	});
});
