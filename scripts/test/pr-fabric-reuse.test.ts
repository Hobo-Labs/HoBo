import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	AWAITING_EVIDENCE_REASON,
	type CommitAnswer,
	DEFAULT_REUSE_PR_FABRIC,
	decidePrFabricReuse,
	type FetchJson,
	fetchPullRequestRuns,
	main,
	mergeQueueEntry,
	PR_FABRIC_REUSE_SETTING,
	type PrFabricReads,
	type PullAnswer,
	type PullRequestRun,
	prFabricReads,
	reusePrFabricSetting,
	UNREAD_RUNS_REASON,
} from "../ci/pr-fabric-reuse.mts";
import { type JsonValue, readRunnerRouting } from "../ci/runner-routing.mts";

type CompareAnswer = Readonly<{
	merge_base_commit?: Readonly<{ sha?: string }>;
}>;
type GithubAnswer =
	| CommitAnswer
	| PullAnswer
	| CompareAnswer
	| Readonly<{ workflow_runs?: readonly PullRequestRun[] | string }>;

const repo = "Hobo-Labs/HoBo";
const base = "b".repeat(40);
const mergeHead = "d".repeat(40);
const prHead = "f".repeat(40);
const tree = "e".repeat(40);
const ref = `refs/heads/gh-readonly-queue/main/pr-12-${base}`;

const decisionInput = {
	eventName: "merge_group",
	ref,
	enabled: true,
	repository: repo,
	workflowBasename: "hobo-ci.yml",
	headSha: mergeHead,
	baseSha: base,
};

const greenRun = (
	over: Omit<Partial<PullRequestRun>, "id"> & { id?: number | undefined } = {},
): PullRequestRun => ({
	id: 55,
	event: "pull_request",
	status: "completed",
	conclusion: "success",
	path: ".github/workflows/hobo-ci.yml",
	head_sha: prHead,
	repository: { full_name: repo },
	head_repository: { full_name: repo },
	pull_requests: [{ number: 12 }],
	...over,
});

const happyReads = (over: Partial<PrFabricReads> = {}): PrFabricReads => ({
	commit: async (sha) =>
		sha === mergeHead
			? { commit: { tree: { sha: tree } }, parents: [{ sha: base }] }
			: sha === prHead
				? { commit: { tree: { sha: tree } } }
				: undefined,
	pull: async () => ({
		number: 12,
		head: { sha: prHead, repo: { full_name: repo } },
		base: { ref: "main", sha: base },
	}),
	mergeBase: async () => base,
	...over,
});

const refuse = async (
	over: Parameters<typeof decidePrFabricReuse>[0],
): Promise<string> => {
	const decision = await decidePrFabricReuse(over);
	assert.equal(decision.reuse, false);
	return decision.reason;
};

describe("the merge-queue entry branch name", () => {
	it("carries the pull request number and the base tip", () => {
		assert.deepEqual(mergeQueueEntry(ref), { number: 12, base });
		assert.deepEqual(
			mergeQueueEntry(
				`refs/heads/gh-readonly-queue/main/pr-2919-${"c".repeat(40)}`,
			),
			{ number: 2919, base: "c".repeat(40) },
		);
	});

	it("refuses every other shape", () => {
		for (const other of [
			"",
			"refs/heads/main",
			"refs/heads/gh-readonly-queue/develop/pr-12-" + base,
			`refs/heads/gh-readonly-queue/main/pr-12-${"b".repeat(7)}`,
			"refs/heads/gh-readonly-queue/main/pr-twelve-" + base,
			`refs/heads/gh-readonly-queue/main/pr--${base}`,
			`refs/heads/gh-readonly-queue/main/pr-12-${"B".repeat(40)}x`,
		])
			assert.equal(mergeQueueEntry(other), undefined, other);
	});
});

describe("the committed reuse policy", () => {
	const policyText = (mergeGroup: JsonValue | undefined) => {
		const committed = JSON.parse(readFileSync(".hobo/ci.json", "utf8"));
		return JSON.stringify({
			...committed,
			runnerRouting: { ...committed.runnerRouting, mergeGroup },
		});
	};

	it("is off for an unreadable policy and on for a policy without the block", () => {
		assert.equal(DEFAULT_REUSE_PR_FABRIC, false);
		assert.equal(
			PR_FABRIC_REUSE_SETTING,
			"runnerRouting.mergeGroup.reusePrFabric",
		);
		assert.equal(reusePrFabricSetting(undefined), false);
		assert.equal(reusePrFabricSetting("not json"), false);
		assert.equal(reusePrFabricSetting("{}"), false);
		assert.equal(reusePrFabricSetting(policyText(undefined)), true);
		assert.equal(
			reusePrFabricSetting(policyText({ reusePrFabric: "true" })),
			false,
		);
		assert.equal(
			reusePrFabricSetting(policyText({ reusePrFabric: true, extra: 1 })),
			false,
		);
		assert.equal(
			reusePrFabricSetting(policyText({ reusePrFabric: true })),
			true,
		);
	});

	it("is the committed file's answer, and the block parses as policy", () => {
		const committed = readFileSync(".hobo/ci.json", "utf8");
		assert.equal(readRunnerRouting(committed)?.mergeGroup.reusePrFabric, true);
		assert.equal(reusePrFabricSetting(committed), true);
	});
});

describe("the reuse decision", () => {
	it("accepts a green same-repo run of this workflow for this entry", async () => {
		const decision = await decidePrFabricReuse({
			...decisionInput,
			runs: [greenRun()],
			reads: happyReads(),
		});
		assert.deepEqual(decision, {
			reuse: true,
			reason: `a green PR Fabric run tested this tree at this base (pr 12, run 55)`,
			runId: 55,
		});
	});

	it("refuses everything short of that", async () => {
		assert.equal(
			await refuse({
				...decisionInput,
				enabled: false,
				runs: [greenRun()],
				reads: happyReads(),
			}),
			`${PR_FABRIC_REUSE_SETTING} is false`,
		);
		for (const eventName of ["pull_request", "push", ""])
			assert.equal(
				await refuse({
					...decisionInput,
					eventName,
					runs: [greenRun()],
					reads: happyReads(),
				}),
				"not a merge group",
				eventName,
			);
		for (const other of [
			"refs/heads/main",
			"refs/heads/gh-readonly-queue/develop/pr-12-" + base,
			`refs/heads/gh-readonly-queue/main/pr-12-${"b".repeat(7)}`,
			"refs/heads/gh-readonly-queue/main/pr-twelve-" + base,
		])
			assert.equal(
				await refuse({
					...decisionInput,
					ref: other,
					runs: [greenRun()],
					reads: happyReads(),
				}),
				"the merge-queue branch is not readable",
				other,
			);
		for (const [baseSha, reason] of [
			["c".repeat(40), "the branch's base does not match the event"],
			["", "the branch's base does not match the event"],
			["not-a-sha", "the branch's base does not match the event"],
		] as const)
			assert.equal(
				await refuse({
					...decisionInput,
					baseSha,
					runs: [greenRun()],
					reads: happyReads(),
				}),
				reason,
				baseSha,
			);
		assert.equal(
			await refuse({
				...decisionInput,
				ref: `refs/heads/gh-readonly-queue/main/pr-12-${"c".repeat(40)}`,
				runs: [greenRun()],
				reads: happyReads(),
			}),
			"the branch's base does not match the event",
		);
		assert.equal(
			await refuse({
				...decisionInput,
				headSha: "not-a-sha",
				runs: [greenRun()],
				reads: happyReads(),
			}),
			"the merge-group head commit is not known",
		);
		assert.equal(
			await refuse({
				...decisionInput,
				runs: [greenRun()],
				reads: happyReads({
					commit: async () => undefined,
				}),
			}),
			AWAITING_EVIDENCE_REASON,
		);
		assert.equal(
			await refuse({
				...decisionInput,
				runs: [greenRun()],
				reads: happyReads({
					commit: async (sha) =>
						sha === mergeHead
							? { commit: {}, parents: [{ sha: base }] }
							: sha === prHead
								? { commit: { tree: { sha: tree } } }
								: undefined,
				}),
			}),
			"the merge-group head commit has no tree",
		);
		assert.equal(
			await refuse({
				...decisionInput,
				runs: [greenRun()],
				reads: happyReads({
					commit: async (sha) =>
						sha === mergeHead
							? {
									commit: { tree: { sha: tree } },
									parents: [{ sha: "c".repeat(40) }],
								}
							: sha === prHead
								? { commit: { tree: { sha: tree } } }
								: undefined,
				}),
			}),
			"the merge group's first parent is not the entry's base",
		);
		assert.equal(
			await refuse({
				...decisionInput,
				runs: [greenRun()],
				reads: happyReads({
					pull: async () => undefined,
				}),
			}),
			"pull request 12 could not be read",
		);
		assert.equal(
			await refuse({
				...decisionInput,
				runs: [greenRun()],
				reads: happyReads({
					pull: async () => ({
						number: 13,
						head: { sha: prHead, repo: { full_name: repo } },
						base: { ref: "main", sha: base },
					}),
				}),
			}),
			"pull request 12 could not be read",
		);
		for (const [pull, reason] of [
			[
				{
					number: 12,
					head: { sha: prHead, repo: { full_name: repo } },
					base: { ref: "develop", sha: base },
				},
				"the pull request is not based on this entry's base",
			],
			[
				{
					number: 12,
					head: { sha: prHead, repo: { full_name: repo } },
					base: { ref: "main", sha: "c".repeat(40) },
				},
				"the pull request is not based on this entry's base",
			],
			[
				{
					number: 12,
					head: { sha: "short", repo: { full_name: repo } },
					base: { ref: "main", sha: base },
				},
				"the pull request's head commit is not known",
			],
			[
				{
					number: 12,
					head: { sha: prHead, repo: { full_name: "someone/fork" } },
					base: { ref: "main", sha: base },
				},
				"the pull request's head is in another repository",
			],
		] as const)
			assert.equal(
				await refuse({
					...decisionInput,
					runs: [greenRun()],
					reads: happyReads({
						pull: async () => pull,
					}),
				}),
				reason,
				JSON.stringify(pull),
			);
	});

	it("counts only a green run of this workflow, bound to this entry", async () => {
		const noRun =
			"no green PR Fabric run tested this pull request's current head";
		for (const [over, label] of [
			[{ event: "push" }, "another event"],
			[{ status: "in_progress" }, "an unfinished run"],
			[{ conclusion: "failure" }, "a failed run"],
			[{ path: ".github/workflows/other.yml" }, "another workflow"],
			[{ repository: { full_name: "someone/fork" } }, "a fork's run"],
			[{ head_repository: { full_name: "someone/fork" } }, "a fork head"],
			[{ pull_requests: [] }, "an unassociated run"],
			[{ pull_requests: [{ number: 13 }] }, "another pull request's run"],
			[{ head_sha: "a".repeat(40) }, "a stale head"],
			[{ id: 0 }, "no id"],
			[{ id: -1 }, "a negative id"],
			[{ id: 1.5 }, "a fractional id"],
			[{ id: undefined }, "an id-less run"],
		] as const)
			assert.equal(
				await refuse({
					...decisionInput,
					runs: [greenRun(over)],
					reads: happyReads(),
				}),
				noRun,
				label,
			);
		assert.equal(
			await refuse({ ...decisionInput, runs: [], reads: happyReads() }),
			noRun,
		);
	});

	it("fails closed when a bound run's evidence cannot be read", async () => {
		assert.equal(
			await refuse({
				...decisionInput,
				runs: [greenRun()],
				reads: happyReads({
					commit: async (sha) =>
						sha === mergeHead
							? { commit: { tree: { sha: tree } }, parents: [{ sha: base }] }
							: undefined,
				}),
			}),
			AWAITING_EVIDENCE_REASON,
		);
		assert.equal(
			await refuse({
				...decisionInput,
				runs: [greenRun()],
				reads: happyReads({
					commit: async (sha) =>
						sha === mergeHead
							? { commit: { tree: { sha: tree } }, parents: [{ sha: base }] }
							: { commit: {} },
				}),
			}),
			"the pull request's head commit has no tree",
		);
		assert.equal(
			await refuse({
				...decisionInput,
				runs: [greenRun()],
				reads: happyReads({
					mergeBase: async () => undefined,
				}),
			}),
			"the ancestry of the pull request could not be read",
		);
	});

	it("scans past a rejected green run to a later verified one", async () => {
		const otherTree = greenRun({
			id: 54,
			head_sha: "a".repeat(40),
		});
		const decision = await decidePrFabricReuse({
			...decisionInput,
			runs: [otherTree, greenRun({ id: 56 })],
			reads: happyReads(),
		});
		assert.equal(decision.reuse, true);
		assert.equal(decision.runId, 56);
		const wrongTree = greenRun({ id: 54 });
		const refused = await decidePrFabricReuse({
			...decisionInput,
			runs: [wrongTree, greenRun({ id: 56 })],
			reads: happyReads({
				commit: async (sha) =>
					sha === mergeHead
						? { commit: { tree: { sha: tree } }, parents: [{ sha: base }] }
						: { commit: { tree: { sha: "9".repeat(40) } } },
			}),
		});
		assert.equal(refused.reuse, false);
		assert.equal(
			refused.reason,
			"no green PR Fabric run tested this tree with the base contained in its head",
		);
		const diverged = await decidePrFabricReuse({
			...decisionInput,
			runs: [greenRun()],
			reads: happyReads({ mergeBase: async () => "a".repeat(40) }),
		});
		assert.equal(diverged.reuse, false);
		assert.equal(
			diverged.reason,
			"no green PR Fabric run tested this tree with the base contained in its head",
		);
	});
});

const okJson =
	(body: GithubAnswer): FetchJson =>
	async () => ({
		ok: true,
		status: 200,
		json: async () => body,
	});

describe("the evidence fetch", () => {
	it("reads the workflow's green pull-request runs, newest first", async () => {
		const urls: string[] = [];
		const runs = [greenRun()];
		const fetched = await fetchPullRequestRuns({
			apiUrl: "https://api.github.com",
			repository: repo,
			token: "token",
			workflowBasename: "hobo-ci.yml",
			fetch: async (url) => {
				urls.push(url);
				return {
					ok: true,
					status: 200,
					json: async () => ({ workflow_runs: runs }),
				};
			},
		});
		assert.deepEqual(fetched, runs);
		assert.deepEqual(urls, [
			`https://api.github.com/repos/${repo}/actions/workflows/hobo-ci.yml/runs?event=pull_request&status=success&per_page=30`,
		]);
	});

	it("is nothing when the read fails or the answer is not a list", async () => {
		const options = {
			apiUrl: "https://api.github.com",
			repository: repo,
			token: "token",
			workflowBasename: "hobo-ci.yml",
		};
		for (const fetchJson of [
			async () => ({ ok: false, status: 403, json: async () => ({}) }),
			async () => {
				throw new Error("offline");
			},
			okJson({ workflow_runs: "nope" }),
			okJson({}),
		])
			assert.equal(
				await fetchPullRequestRuns({ ...options, fetch: fetchJson }),
				undefined,
			);
		assert.equal(
			await fetchPullRequestRuns({ ...options, token: "", fetch: okJson({}) }),
			undefined,
		);
	});

	it("reads commits, the pull request, and the compare through the same paths", async () => {
		const urls: string[] = [];
		const commit = {
			commit: { tree: { sha: tree } },
			parents: [{ sha: base }],
		};
		const pull = {
			number: 12,
			head: { sha: prHead, repo: { full_name: repo } },
			base: { ref: "main", sha: base },
		};
		const reads = prFabricReads({
			apiUrl: "https://api.github.com/",
			repository: repo,
			token: "token",
			entryBase: base,
			fetch: okJsonWithUrls(urls, {
				[`/repos/${repo}/commits/${prHead}`]: commit,
				[`/repos/${repo}/pulls/12`]: pull,
				[`/repos/${repo}/compare/${base}...${prHead}`]: {
					merge_base_commit: { sha: base },
				},
			}),
		});
		assert.deepEqual(await reads.commit(prHead), commit);
		assert.deepEqual(await reads.pull(12), pull);
		assert.equal(await reads.mergeBase(prHead), base);
		assert.deepEqual(urls, [
			`https://api.github.com/repos/${repo}/commits/${prHead}`,
			`https://api.github.com/repos/${repo}/pulls/12`,
			`https://api.github.com/repos/${repo}/compare/${base}...${prHead}`,
		]);
	});

	it("answers nothing for a failing read or a malformed merge base", async () => {
		const failing: FetchJson = async () => ({
			ok: false,
			status: 500,
			json: async () => ({}),
		});
		const reads = prFabricReads({
			apiUrl: "https://api.github.com",
			repository: repo,
			token: "token",
			entryBase: base,
			fetch: failing,
		});
		assert.equal(await reads.commit(prHead), undefined);
		assert.equal(await reads.pull(12), undefined);
		assert.equal(await reads.mergeBase(prHead), undefined);
		const malformed = prFabricReads({
			apiUrl: "https://api.github.com",
			repository: repo,
			token: "token",
			entryBase: base,
			fetch: okJson({ merge_base_commit: { sha: "short" } }),
		});
		assert.equal(await malformed.mergeBase(prHead), undefined);
	});
});

function okJsonWithUrls(
	urls: string[],
	answers: Readonly<Record<string, GithubAnswer>>,
): FetchJson {
	return async (url) => {
		urls.push(url);
		const path = url.replace("https://api.github.com", "");
		const body = answers[path];
		if (body === undefined) throw new Error(`unexpected ${path}`);
		return { ok: true, status: 200, json: async () => body };
	};
}

describe("the route job entry point", () => {
	it("never fails the job and writes its outputs", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-pr-fabric-main-"));
		try {
			const output = join(directory, "output");
			const decision = await main({
				GITHUB_EVENT_NAME: "merge_group",
				GITHUB_REF: ref,
				GITHUB_REPOSITORY: repo,
				BASE_SHA: base,
				HEAD_SHA: mergeHead,
				GITHUB_OUTPUT: output,
			});
			assert.equal(decision.reuse, false);
			assert.equal(decision.reason, UNREAD_RUNS_REASON);
			assert.equal(readFileSync(output, "utf8"), "reuse=false\nreuse-run=\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("stops before any GitHub read when the event or branch is not a merge entry", async () => {
		const decision = await main({
			GITHUB_EVENT_NAME: "push",
			GITHUB_REF: "refs/heads/main",
			GITHUB_REPOSITORY: repo,
		});
		assert.equal(decision.reuse, false);
		assert.equal(
			decision.reason === UNREAD_RUNS_REASON,
			false,
			"no evidence fetch happened",
		);
	});
});
