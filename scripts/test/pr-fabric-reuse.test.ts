import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SHADOW_WORKFLOW_BLOB } from "../ci/attestation.mts";
import {
	decidePrFabricReuse,
	enrichPullRequestRuns,
	fetchPullRequestFabricRuns,
	PR_FABRIC_COVERED_JOBS,
	PR_FABRIC_ENRICHED_RUNS,
	PR_FABRIC_RUN_LOOKUPS,
	type PrFabricReuseInput,
	type PullRequestRecord,
	type PullRequestRun,
} from "../ci/pr-fabric-reuse.mts";

const MG_HEAD = "f0b586a1a8bb83c39ed13ba11753ef8b2dc66f29";
const MG_TREE = "1111111111111111111111111111111111111111";
const OTHER_TREE = "2222222222222222222222222222222222222222";
const PR_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PR_BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_SHA = "cccccccccccccccccccccccccccccccccccccccc";
const MERGE_COMMIT = "dddddddddddddddddddddddddddddddddddddddd";
const REPOSITORY = "Hobo-Labs/HoBo";

function pull(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
	return {
		number: 1955,
		headSha: PR_HEAD,
		headRef: "feature",
		headRepository: REPOSITORY,
		baseSha: PR_BASE,
		...overrides,
	};
}

function run(overrides: Partial<PullRequestRun> = {}): PullRequestRun {
	return {
		id: 43281000761,
		event: "pull_request",
		status: "completed",
		conclusion: "success",
		path: ".github/workflows/hobo-ci.yml",
		head_sha: MERGE_COMMIT,
		head_branch: "feature",
		repository: { full_name: REPOSITORY },
		head_repository: { full_name: REPOSITORY },
		testedTree: MG_TREE,
		testedHead: PR_HEAD,
		testedBase: PR_BASE,
		workflowBlob: SHADOW_WORKFLOW_BLOB,
		...overrides,
	};
}

function input(
	overrides: Partial<PrFabricReuseInput> = {},
): PrFabricReuseInput {
	return {
		eventName: "merge_group",
		repository: REPOSITORY,
		workflowBasename: "hobo-ci.yml",
		headBranch: `gh-readonly-queue/main/pr-1955-${PR_BASE}`,
		baseBranch: "main",
		baseSha: PR_BASE,
		headSha: MG_HEAD,
		headTree: MG_TREE,
		expectedWorkflowBlob: SHADOW_WORKFLOW_BLOB,
		pull: pull(),
		runs: [run()],
		...overrides,
	};
}

describe("pr-fabric reuse on merge_group", () => {
	it("reuses a green pull-request run of the same tree, base and workflow", () => {
		const decision = decidePrFabricReuse(input());
		assert.equal(decision.reuse, true);
		assert.equal(decision.runId, 43281000761);
		assert.deepEqual(decision.covered, [...PR_FABRIC_COVERED_JOBS]);
		assert.deepEqual(decision.covered, [
			"pr_gate_validation",
			"workspace_tests",
			"scripts-tests",
		]);
	});

	it("refuses a pull run whose tested tree differs from the merge-group tree", () => {
		const decision = decidePrFabricReuse(
			input({ runs: [run({ testedTree: OTHER_TREE })] }),
		);
		assert.equal(decision.reuse, false);
		assert.match(decision.reason, /differs .* tested tree/u);
	});

	it("refuses a pull run tested against another base", () => {
		const decision = decidePrFabricReuse(
			input({ runs: [run({ testedBase: OTHER_SHA })] }),
		);
		assert.equal(decision.reuse, false);
		assert.match(decision.reason, /another base/u);
	});

	it("refuses a fork pull request", () => {
		const decision = decidePrFabricReuse(
			input({ pull: pull({ headRepository: "someone/fork" }) }),
		);
		assert.equal(decision.reuse, false);
		assert.match(decision.reason, /fork/u);
		assert.equal(
			decidePrFabricReuse(input({ pull: pull({ headRepository: undefined }) }))
				.reuse,
			false,
		);
	});

	it("refuses a stale head: the pull request moved after its green run", () => {
		const decision = decidePrFabricReuse(
			input({
				pull: pull({ headSha: OTHER_SHA }),
				runs: [run()],
			}),
		);
		assert.equal(decision.reuse, false);
		assert.match(decision.reason, /no green pull-request run for this head/u);
	});

	it("refuses a failed pull-request run at this head", () => {
		const decision = decidePrFabricReuse(
			input({ runs: [run({ conclusion: "failure" })] }),
		);
		assert.equal(decision.reuse, false);
		assert.match(decision.reason, /did not succeed/u);
		assert.equal(
			decidePrFabricReuse(
				input({ runs: [run({ status: "in_progress", conclusion: null })] }),
			).reuse,
			false,
		);
	});

	it("refuses a tampered workflow blob at the tested commit", () => {
		const decision = decidePrFabricReuse(
			input({ runs: [run({ workflowBlob: OTHER_SHA })] }),
		);
		assert.equal(decision.reuse, false);
		assert.match(decision.reason, /different workflow file/u);
	});

	it("refuses a run of another event", () => {
		for (const event of ["merge_group", "push", "workflow_dispatch"])
			assert.equal(
				decidePrFabricReuse(input({ runs: [run({ event })] })).reuse,
				false,
				event,
			);
	});

	it("refuses a cross-repository run", () => {
		for (const overrides of [
			{ repository: { full_name: "someone/fork" } },
			{ head_repository: { full_name: "someone/fork" } },
			{ repository: null, head_repository: null },
		] as const)
			assert.equal(
				decidePrFabricReuse(input({ runs: [run(overrides)] })).reuse,
				false,
				JSON.stringify(overrides),
			);
	});

	it("takes a later green run of the head over an earlier red one", () => {
		const decision = decidePrFabricReuse(
			input({ runs: [run({ id: 1, conclusion: "failure" }), run({ id: 2 })] }),
		);
		assert.equal(decision.reuse, true);
		assert.equal(decision.runId, 2);
	});

	it("applies only to a merge-group run on a parseable queue branch", () => {
		for (const overrides of [
			{ eventName: "push" },
			{ eventName: "pull_request" },
			{ headBranch: "main" },
			{ headBranch: null },
			{ headBranch: "gh-readonly-queue/main/pr-1955-not-a-sha" },
			{
				headBranch:
					"gh-readonly-queue/main/pr-1955-cccccccccccccccccccccccccccccccccccccccc",
			},
			{ headTree: "not-a-tree" },
			{ pull: undefined },
			{ pull: pull({ headSha: "short" }) },
		])
			assert.equal(decidePrFabricReuse(input(overrides)).reuse, false);
	});

	it("refuses a run of another workflow file path", () => {
		assert.equal(
			decidePrFabricReuse(
				input({ runs: [run({ path: ".github/workflows/pricing-ci.yml" })] }),
			).reuse,
			false,
		);
	});

	it("refuses a run whose tested commit is not a merge of the head", () => {
		const decision = decidePrFabricReuse(
			input({ runs: [run({ testedHead: undefined })] }),
		);
		assert.equal(decision.reuse, false);
		assert.match(decision.reason, /no green pull-request run/u);
	});
});

describe("pull-request run lookup", () => {
	it("lists pull_request runs of this workflow on the pull's head branch", async () => {
		const seen: string[] = [];
		const runs = await fetchPullRequestFabricRuns({
			repository: REPOSITORY,
			token: "t",
			workflowBasename: "hobo-ci.yml",
			branch: "feature",
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
			`https://api.github.com/repos/Hobo-Labs/HoBo/actions/workflows/hobo-ci.yml/runs?event=pull_request&branch=feature&per_page=${PR_FABRIC_RUN_LOOKUPS}`,
		);
	});

	it("answers undefined, never throws, when GitHub refuses or the input is unusable", async () => {
		const base = {
			repository: REPOSITORY,
			token: "t",
			workflowBasename: "hobo-ci.yml",
			branch: "feature",
		};
		assert.equal(
			await fetchPullRequestFabricRuns({
				...base,
				fetch: async () => ({ ok: false, status: 403, json: async () => ({}) }),
			}),
			undefined,
		);
		assert.equal(
			await fetchPullRequestFabricRuns({
				...base,
				fetch: async () => {
					throw new Error("network");
				},
			}),
			undefined,
		);
		for (const broken of [
			{ token: "" },
			{ branch: "" },
			{ repository: "Hobo-Labs" },
		])
			assert.equal(
				await fetchPullRequestFabricRuns({
					...base,
					...broken,
					fetch: async () => ({
						ok: true,
						status: 200,
						json: async () => ({}),
					}),
				}),
				undefined,
				JSON.stringify(broken),
			);
	});
});

describe("run enrichment", () => {
	const fetchApi = async (url: string) => {
		if (url.endsWith(`/git/commits/${MERGE_COMMIT}`))
			return {
				ok: true,
				status: 200,
				json: async () => ({
					sha: MERGE_COMMIT,
					tree: { sha: MG_TREE },
					parents: [{ sha: PR_BASE }, { sha: PR_HEAD }],
				}),
			};
		if (url.includes("/contents/"))
			return {
				ok: true,
				status: 200,
				json: async () => ({ sha: SHADOW_WORKFLOW_BLOB, type: "file" }),
			};
		return { ok: false, status: 404, json: async () => ({}) };
	};

	it("reads the tested tree, parents and workflow blob of the newest runs", async () => {
		const enriched = await enrichPullRequestRuns({
			repository: REPOSITORY,
			token: "t",
			workflowPath: ".github/workflows/hobo-ci.yml",
			runs: [{ id: 1, event: "pull_request", head_sha: MERGE_COMMIT }],
			fetch: fetchApi,
		});
		assert.deepEqual(enriched[0], {
			id: 1,
			event: "pull_request",
			head_sha: MERGE_COMMIT,
			testedTree: MG_TREE,
			testedBase: PR_BASE,
			testedHead: PR_HEAD,
			workflowBlob: SHADOW_WORKFLOW_BLOB,
		});
	});

	it("leaves a commit that is not a merge without a tested head, and enriches only the newest runs", async () => {
		const plain = "e".repeat(40);
		const fetchPlain = async (url: string) => {
			if (url.endsWith(`/git/commits/${plain}`))
				return {
					ok: true,
					status: 200,
					json: async () => ({
						sha: plain,
						tree: { sha: MG_TREE },
						parents: [{ sha: PR_BASE }],
					}),
				};
			return fetchApi(url);
		};
		const many = Array.from(
			{ length: PR_FABRIC_ENRICHED_RUNS + 2 },
			(_, i) => ({
				id: i,
				head_sha: i === 0 ? plain : MERGE_COMMIT,
			}),
		);
		const enriched = await enrichPullRequestRuns({
			repository: REPOSITORY,
			token: "t",
			workflowPath: ".github/workflows/hobo-ci.yml",
			runs: many,
			fetch: fetchPlain,
		});
		assert.equal(enriched[0]?.testedHead, undefined);
		assert.equal(enriched[0]?.testedBase, PR_BASE);
		for (const at of [1, PR_FABRIC_ENRICHED_RUNS - 1])
			assert.equal(enriched[at]?.testedHead, PR_HEAD, `run ${at}`);
		assert.equal(enriched[PR_FABRIC_ENRICHED_RUNS]?.testedHead, undefined);
		assert.equal(enriched[PR_FABRIC_ENRICHED_RUNS + 1]?.testedTree, undefined);
	});

	it("never throws when the reads fail", async () => {
		const enriched = await enrichPullRequestRuns({
			repository: REPOSITORY,
			token: "",
			workflowPath: ".github/workflows/hobo-ci.yml",
			runs: [{ id: 1, head_sha: MERGE_COMMIT }],
			fetch: async () => {
				throw new Error("network");
			},
		});
		assert.equal(enriched[0]?.testedTree, undefined);
	});
});

describe("pr-fabric reuse wiring", () => {
	const workflow = readFileSync(
		new URL("../../.github/workflows/hobo-ci.yml", import.meta.url),
		"utf8",
	);
	const action = readFileSync(
		new URL("../../.github/actions/route-runner/action.yml", import.meta.url),
		"utf8",
	);

	it("the route job reports the reuse answer and checks the script out at both bases", () => {
		assert.match(
			workflow,
			/pr-fabric-green: \$\{\{ steps\.route\.outputs\.pr-fabric-green \}\}/u,
		);
		const route = workflow.slice(
			workflow.indexOf("  route:"),
			workflow.indexOf("  ci-runner-image:"),
		);
		assert.equal(
			route.match(/^ +scripts\/ci\/pr-fabric-reuse\.mts$/gmu)?.length,
			2,
			"the route job must sparse-checkout the script at the head and the base",
		);
		assert.equal(
			route.match(/^ +scripts\/ci\/github-merge-group\.mts$/gmu)?.length,
			2,
		);
	});

	function job(name: string): string {
		const lines = workflow.split("\n");
		const start = lines.indexOf(`  ${name}:`);
		assert.ok(start >= 0, `missing job ${name}`);
		const rest = lines.slice(start + 1);
		const end = rest.findIndex((line) => /^  [A-Za-z0-9_-]+:$/u.test(line));
		return rest.slice(0, end < 0 ? rest.length : end).join("\n");
	}

	it("skips the covered gate jobs and runs the cheap lanes on a reused merge group", () => {
		for (const name of [
			"pr_gate_validation",
			"workspace_tests",
			"scripts-tests",
		]) {
			const condition = job(name).match(/^ {4}if: (.*)$/mu)?.[1] ?? "";
			assert.ok(
				condition.endsWith(
					"&& needs.route.outputs.pr-fabric-green != 'true' }}",
				),
				name,
			);
		}
		for (const name of ["ci-guard", "secret-scan"]) {
			const condition = job(name).match(/^ {4}if: (.*)$/mu)?.[1] ?? "";
			assert.ok(
				condition.includes(
					"(github.event_name == 'merge_group' && needs.route.outputs.pr-fabric-green == 'true')",
				),
				name,
			);
		}
		const gate = job("pr-gate");
		assert.match(
			gate,
			/PR_FABRIC_GREEN: \$\{\{ needs\.route\.outputs\.pr-fabric-green \}\}/u,
		);
		assert.match(gate, /\[ "\$\{PR_FABRIC_GREEN:-\}" = "true" \]/u);
	});

	it("the route action decides with the script and defaults to no reuse", () => {
		assert.match(action, /id: pr-fabric-reuse/u);
		assert.match(
			action,
			/value: \$\{\{ steps\.pr-fabric-reuse\.outputs\.pr-fabric-green \|\| 'false' \}\}/u,
		);
		assert.match(
			action,
			/value: \$\{\{ steps\.pr-fabric-reuse\.outputs\.pr-fabric-run \|\| '' \}\}/u,
		);
		assert.match(action, /scripts\/ci\/pr-fabric-reuse\.mts/u);
	});
});
