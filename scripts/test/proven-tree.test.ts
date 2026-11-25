import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	decideProvenTreeDelta,
	type FetchJson,
	main as prFabricMain,
	PR_FABRIC_REUSE_SETTING,
	type ProvenTreeReads,
	type PullRequestRun,
	prFabricTestedArtifactName,
	provenTreeReads,
	UNREAD_RUNS_REASON,
} from "../ci/pr-fabric-reuse.mts";
import { type Git, provenTreeBase } from "../ci/proven-tree.mts";

const repo = "Hobo-Labs/HoBo";
const base = "b".repeat(40);
const prHead = "f".repeat(40);
const proven = "a".repeat(40);
const tested = "c".repeat(40);
const tree = "e".repeat(40);
const ref = `refs/heads/gh-readonly-queue/main/pr-12-${base}`;

const input = {
	eventName: "merge_group",
	ref,
	enabled: true,
	repository: repo,
	workflowBasename: "hobo-ci.yml",
	baseSha: base,
};

const greenRun = (over: Partial<PullRequestRun> = {}): PullRequestRun => ({
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

const reads = (over: Partial<ProvenTreeReads> = {}): ProvenTreeReads => ({
	pull: async () => ({
		number: 12,
		head: { sha: prHead, repo: { full_name: repo } },
		base: { ref: "main", sha: "9".repeat(40) },
	}),
	runs: async () => [greenRun()],
	artifacts: async () => [
		{ name: "ci-trace-55" },
		{ name: prFabricTestedArtifactName(proven, tree) },
	],
	commit: async (sha) =>
		sha === proven
			? {
					commit: { tree: { sha: tree } },
					parents: [{ sha: tested }, { sha: prHead }],
				}
			: undefined,
	contains: async (ancestor, descendant) =>
		ancestor === tested && descendant === base,
	...over,
});

const reason = async (over: Partial<ProvenTreeReads>, extra = {}) => {
	const decision = await decideProvenTreeDelta({
		...input,
		...extra,
		reads: reads(over),
	});
	assert.equal(decision.proven, false);
	return decision.reason;
};

describe("the proven-tree delta decision", () => {
	it("names the tested merge commit of the newest green run for the current head", async () => {
		const decision = await decideProvenTreeDelta({
			...input,
			reads: reads({
				runs: async () => [greenRun({ id: 40 }), greenRun({ id: 55 })],
				artifacts: async (runId) =>
					runId === 55
						? [{ name: prFabricTestedArtifactName(proven, tree) }]
						: [],
			}),
		});
		assert.deepEqual(decision, {
			proven: true,
			reason: `proven-tree delta from ${proven} (pr 12, run 55)`,
			base: proven,
			tree,
			runId: 55,
			pr: 12,
		});
	});

	it("falls back to an older green run when the newest recorded nothing", async () => {
		const decision = await decideProvenTreeDelta({
			...input,
			reads: reads({
				runs: async () => [greenRun({ id: 40 }), greenRun({ id: 55 })],
				artifacts: async (runId) =>
					runId === 40
						? [{ name: prFabricTestedArtifactName(proven, tree) }]
						: [{ name: "ci-trace-55" }],
			}),
		});
		assert.equal(decision.proven, true);
		assert.equal(decision.runId, 40);
	});

	it("refuses a missing or expired artifact", async () => {
		assert.equal(
			await reason({ artifacts: async () => [{ name: "ci-trace-55" }] }),
			"no green PR Fabric run recorded the tree it tested",
		);
		assert.equal(
			await reason({
				artifacts: async () => [
					{ name: prFabricTestedArtifactName(proven, tree), expired: true },
				],
			}),
			"no green PR Fabric run recorded the tree it tested",
		);
		assert.equal(
			await reason({
				artifacts: async () => [{ name: `pr-fabric-tested-${proven}-short` }],
			}),
			"no green PR Fabric run recorded the tree it tested",
		);
		assert.equal(
			await reason({ artifacts: async () => undefined }),
			"the artifacts of run 55 could not be read",
		);
	});

	it("refuses runs that did not finish green for this pull request's head", async () => {
		const none =
			"no green PR Fabric run tested this pull request's current head";
		for (const run of [
			greenRun({ conclusion: "failure" }),
			greenRun({ conclusion: "cancelled" }),
			greenRun({ status: "in_progress", conclusion: null }),
			greenRun({ event: "push" }),
			greenRun({ path: ".github/workflows/other.yml" }),
			greenRun({ head_sha: "1".repeat(40) }),
			greenRun({ pull_requests: [{ number: 13 }] }),
			greenRun({ head_repository: { full_name: "fork/HoBo" } }),
			greenRun({ id: 0 }),
		])
			assert.equal(await reason({ runs: async () => [run] }), none);
		assert.equal(
			await reason({ runs: async () => undefined }),
			UNREAD_RUNS_REASON,
		);
	});

	it("refuses a recorded commit that is not the merge of the pull request's current head", async () => {
		assert.equal(
			await reason({
				commit: async () => ({
					commit: { tree: { sha: tree } },
					parents: [{ sha: tested }, { sha: "1".repeat(40) }],
				}),
			}),
			"the tested commit is not a merge of the pull request's head",
		);
		assert.equal(
			await reason({
				commit: async () => ({
					commit: { tree: { sha: tree } },
					parents: [{ sha: tested }],
				}),
			}),
			"the tested commit is not a merge of the pull request's head",
		);
		assert.equal(
			await reason({
				pull: async () => ({
					number: 12,
					head: { sha: "1".repeat(40), repo: { full_name: repo } },
					base: { ref: "main" },
				}),
				runs: async () => [greenRun({ head_sha: "1".repeat(40) })],
			}),
			"the tested commit is not a merge of the pull request's head",
		);
	});

	it("refuses a tree that differs from the recorded one", async () => {
		assert.equal(
			await reason({
				commit: async () => ({
					commit: { tree: { sha: "d".repeat(40) } },
					parents: [{ sha: tested }, { sha: prHead }],
				}),
			}),
			"the tested commit's tree is not the recorded tree",
		);
		assert.equal(
			await reason({ commit: async () => undefined }),
			`the tested commit ${proven} could not be read`,
		);
	});

	it("refuses a tested base the merge group's base does not contain", async () => {
		assert.equal(
			await reason({ contains: async () => false }),
			"the tested base is not an ancestor of the merge group's base",
		);
		assert.equal(
			await reason({ contains: async () => undefined }),
			"the ancestry of the tested base could not be read",
		);
	});

	it("refuses before any read outside a readable merge-queue entry", async () => {
		const untouched = reads({
			pull: async () => assert.fail("no read"),
		});
		for (const [extra, why] of [
			[{ enabled: false }, `${PR_FABRIC_REUSE_SETTING} is false`],
			[{ eventName: "pull_request" }, "not a merge group"],
			[{ ref: "refs/heads/main" }, "the merge-queue branch is not readable"],
			[
				{ baseSha: "c".repeat(40) },
				"the branch's base does not match the event",
			],
		] as const) {
			const decision = await decideProvenTreeDelta({
				...input,
				...extra,
				reads: untouched,
			});
			assert.deepEqual(decision, { proven: false, reason: why });
		}
		assert.equal(
			await reason({ pull: async () => undefined }),
			"pull request 12 could not be read",
		);
		assert.equal(
			await reason({
				pull: async () => ({
					number: 12,
					head: { sha: prHead, repo: { full_name: "fork/HoBo" } },
					base: { ref: "main" },
				}),
			}),
			"the pull request's head is in another repository",
		);
	});
});

describe("the proven-tree reads", () => {
	it("reads runs for the head, run artifacts, the commit and the ancestry", async () => {
		const urls: string[] = [];
		const answers = new Map(
			Object.entries({
				[`/repos/${repo}/actions/workflows/hobo-ci.yml/runs?event=pull_request&status=success&head_sha=${prHead}&per_page=30`]:
					{ workflow_runs: [greenRun()] },
				[`/repos/${repo}/actions/runs/55/artifacts?per_page=100`]: {
					artifacts: [
						{ name: prFabricTestedArtifactName(proven, tree), expired: false },
					],
				},
				[`/repos/${repo}/commits/${proven}`]: {
					commit: { tree: { sha: tree } },
					parents: [{ sha: tested }, { sha: prHead }],
				},
				[`/repos/${repo}/compare/${tested}...${base}`]: {
					merge_base_commit: { sha: tested },
				},
				[`/repos/${repo}/compare/${base}...${tested}`]: {
					merge_base_commit: { sha: tested },
				},
			}),
		);
		const fetchJson: FetchJson = async (url) => {
			urls.push(url);
			const body = answers.get(url.replace("https://api.github.com", ""));
			if (body === undefined) throw new Error(`unexpected ${url}`);
			return { ok: true, status: 200, json: async () => body };
		};
		const live = provenTreeReads({
			apiUrl: "https://api.github.com/",
			repository: repo,
			token: "token",
			workflowBasename: "hobo-ci.yml",
			fetch: fetchJson,
		});
		assert.deepEqual(await live.runs(prHead), [greenRun()]);
		assert.deepEqual(await live.artifacts(55), [
			{ name: prFabricTestedArtifactName(proven, tree), expired: false },
		]);
		assert.deepEqual(await live.commit(proven), {
			commit: { tree: { sha: tree } },
			parents: [{ sha: tested }, { sha: prHead }],
		});
		assert.equal(await live.contains(tested, base), true);
		assert.equal(await live.contains(base, tested), false);
		assert.equal(await live.pull(12), undefined);
		assert.equal(urls.length, 6);
	});

	it("answers nothing without a token or a usable answer", async () => {
		const offline = provenTreeReads({
			apiUrl: "https://api.github.com",
			repository: repo,
			token: "",
			workflowBasename: "hobo-ci.yml",
			fetch: async () => assert.fail("no fetch without a token"),
		});
		assert.equal(await offline.runs(prHead), undefined);
		assert.equal(await offline.artifacts(55), undefined);
		assert.equal(await offline.commit(proven), undefined);
		assert.equal(await offline.contains(tested, base), undefined);
		const failing = provenTreeReads({
			apiUrl: "https://api.github.com",
			repository: repo,
			token: "token",
			workflowBasename: "hobo-ci.yml",
			fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
		});
		assert.equal(await failing.runs(prHead), undefined);
		assert.equal(await failing.artifacts(55), undefined);
		assert.equal(await failing.contains(tested, base), undefined);
	});
});

describe("the route job outputs", () => {
	it("writes empty proven-tree outputs when nothing can be read", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-proven-tree-main-"));
		try {
			const output = join(directory, "output");
			await prFabricMain({
				GITHUB_EVENT_NAME: "merge_group",
				GITHUB_REF: ref,
				GITHUB_REPOSITORY: repo,
				BASE_SHA: base,
				HEAD_SHA: "d".repeat(40),
				GITHUB_OUTPUT: output,
			});
			assert.equal(
				readFileSync(output, "utf8"),
				"reuse=false\nreuse-run=\nproven-base=\nproven-tree=\nproven-run=\nproven-pr=\n",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

function fakeGit(over: Readonly<Record<string, string | undefined>> = {}) {
	const calls: string[] = [];
	const answers = new Map(
		Object.entries({
			[`cat-file -e ${proven}^{commit}`]: "",
			[`rev-parse ${proven}^{tree}`]: tree,
			[`merge-base --is-ancestor ${proven}^1 ${base}`]: "",
			"rev-parse HEAD^{tree}": "9".repeat(40),
			"rev-parse HEAD": "8".repeat(40),
			[`commit-tree --no-gpg-sign ${"9".repeat(40)} -p ${"8".repeat(40)} -p ${proven} -m proven-tree delta from ${proven}`]:
				"7".repeat(40),
			[`checkout --quiet --detach ${"7".repeat(40)}`]: "",
			...over,
		}),
	);
	return {
		calls,
		git: ((args) => {
			const key = args.join(" ");
			calls.push(key);
			return answers.get(key);
		}) satisfies Git,
	};
}

describe("the proven-tree checkout", () => {
	it("checks out the merge group tree over the proven commit and bases on it", () => {
		const { git, calls } = fakeGit();
		assert.deepEqual(provenTreeBase({ proven, tree, base, git }), {
			base: proven,
			reason: `HEAD is ${"7".repeat(40)}: the tree of ${"8".repeat(40)} over ${proven}`,
		});
		assert.equal(calls.at(-1), `checkout --quiet --detach ${"7".repeat(40)}`);
	});

	it("tries a fetch for a proven commit it does not hold", () => {
		const { git, calls } = fakeGit({
			[`cat-file -e ${proven}^{commit}`]: undefined,
			[`fetch --no-tags --quiet origin ${proven}`]: "",
		});
		assert.equal(provenTreeBase({ proven, tree, base, git }).base, base);
		assert.ok(calls.includes(`fetch --no-tags --quiet origin ${proven}`));
	});

	it("keeps the merge group base whenever the proof does not hold", () => {
		const cases: [Record<string, string | undefined>, string][] = [
			[
				{
					[`cat-file -e ${proven}^{commit}`]: undefined,
					[`fetch --no-tags --quiet origin ${proven}`]: undefined,
				},
				`the proven commit ${proven} could not be fetched`,
			],
			[
				{ [`rev-parse ${proven}^{tree}`]: "d".repeat(40) },
				"the proven commit's tree is not the recorded tree",
			],
			[
				{ [`merge-base --is-ancestor ${proven}^1 ${base}`]: undefined },
				"the proven commit's base is not in the merge group base",
			],
			[
				{ [`checkout --quiet --detach ${"7".repeat(40)}`]: undefined },
				"the descendant of the proven commit could not be checked out",
			],
		];
		for (const [over, why] of cases) {
			const { git } = fakeGit(over);
			assert.deepEqual(provenTreeBase({ proven, tree, base, git }), {
				base,
				reason: why,
			});
		}
		const { git } = fakeGit();
		assert.equal(
			provenTreeBase({ proven: "", tree, base, git }).reason,
			"no proven tree was named",
		);
		assert.equal(
			provenTreeBase({ proven, tree, base: "", git }).reason,
			"the merge group base is not known",
		);
	});

	it("makes merge-base answer the proven commit in a real repository", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-proven-tree-git-"));
		const run = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: directory,
				encoding: "utf8",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@t",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@t",
				},
			}).trim();
		const commit = (file: string, text: string, message: string) => {
			writeFileSync(join(directory, file), text);
			run("add", file);
			run("commit", "--quiet", "--no-gpg-sign", "-m", message);
			return run("rev-parse", "HEAD");
		};
		try {
			run("init", "--quiet", "-b", "main");
			const old = commit("a.txt", "a\n", "old main");
			run("checkout", "--quiet", "-b", "pr");
			const head = commit("pr.txt", "pr\n", "pr");
			run("checkout", "--quiet", "main");
			const moved = commit("b.txt", "b\n", "main moves");
			run("checkout", "--quiet", "--detach", old);
			run("merge", "--quiet", "--no-ff", "--no-gpg-sign", "--no-edit", head);
			const testedMerge = run("rev-parse", "HEAD");
			const testedTree = run("rev-parse", "HEAD^{tree}");
			run("checkout", "--quiet", "--detach", moved);
			run("merge", "--quiet", "--squash", head);
			run("commit", "--quiet", "--no-gpg-sign", "-m", "merge group");
			const group = run("rev-parse", "HEAD");
			const git: Git = (args, env) => {
				try {
					return execFileSync("git", args, {
						cwd: directory,
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
						env: { ...process.env, ...env },
					}).trim();
				} catch {
					return undefined;
				}
			};
			assert.equal(
				provenTreeBase({
					proven: testedMerge,
					tree: "1".repeat(40),
					base: moved,
					git,
				}).base,
				moved,
			);
			assert.equal(
				provenTreeBase({
					proven: testedMerge,
					tree: testedTree,
					base: moved,
					git,
				}).base,
				testedMerge,
			);
			assert.equal(run("merge-base", testedMerge, "HEAD"), testedMerge);
			assert.equal(
				run("rev-parse", "HEAD^{tree}"),
				run("rev-parse", `${group}^{tree}`),
			);
			assert.equal(run("rev-parse", "HEAD^1"), group);
			assert.equal(run("diff", "--name-only", testedMerge, "HEAD"), "b.txt");
			assert.equal(run("status", "--porcelain"), "");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
