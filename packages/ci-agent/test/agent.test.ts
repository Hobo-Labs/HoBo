import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CommitChecks, createCiAgent } from "../src/agent.js";
import type { MergeWorkspace } from "../src/git-workspace.js";
import { createMemoryJournal } from "../src/journal.js";
import { observeQueue } from "../src/planner.js";
import type { ResolutionEngine } from "../src/resolver.js";
import type { StructuredMerger } from "../src/structured-merge.js";
import { type PolicyOverrides, testConfig } from "./fixtures/config.js";
import { scriptedEngine, takeBoth } from "./fixtures/engine.js";
import {
	createRepositories,
	type Repositories,
} from "./fixtures/repository.js";

const BASE = "one\ntwo\nthree\nfour\nfive\n";
type Pull = {
	number: number;
	branch: string;
	head: string;
	started?: boolean;
	fork?: boolean;
	paths?: string[];
	/** The branch it targets; another pull request's branch for a stack. */
	base?: string;
};

describe("CI agent tick (real git, scripted engine)", () => {
	let repos: Repositories;
	let clock: string;
	beforeEach(() => {
		repos = createRepositories();
		repos.seed({ "a.txt": BASE, "b.txt": "b\n" });
		clock = "2026-11-10T12:00:00.000Z";
	});
	afterEach(() => repos.cleanup());

	/** A pull request branch that changes line two of a.txt. */
	function pull(number: number, text: string, extra: Partial<Pull> = {}): Pull {
		const branch = `pr-${number}`;
		const head = repos.commit(branch, { "a.txt": BASE.replace("two", text) });
		repos.pull(number, branch);
		return { number, branch, head, paths: ["a.txt"], ...extra };
	}
	function setup(
		mode: "observe" | "suggest" | "apply",
		pulls: Pull[],
		overrides: PolicyOverrides = {},
		engines: ResolutionEngine[] = [takeBoth()],
		/** Wraps the real workspace, to fail one of its steps. */
		wrap: (workspace: MergeWorkspace) => MergeWorkspace = (w) => w,
		structured?: StructuredMerger,
	) {
		const journal = createMemoryJournal();
		const comments: { number: number; body: string }[] = [];
		const enqueued: number[] = [];
		const refuseEnqueue = new Set<number>();
		const base = { requiresChecks: true, lookupFails: false };
		/** The repository's checks per commit; unlisted commits have none. */
		const checks = new Map<string, CommitChecks>();
		const agent = createCiAgent({
			config: testConfig(mode, overrides),
			queue: {
				baseRequiresChecks: async () => {
					if (base.lookupFails) throw new Error("lookup failed");
					return base.requiresChecks;
				},
				commitChecks: async (sha) =>
					checks.get(sha) ?? { state: "none", failures: "" },
				snapshot: async () =>
					observeQueue({
						repository: "hobo-labs/hobo",
						baseRef: "main",
						baseSha: repos.remoteRef("refs/heads/main"),
						observedAt: clock,
						entries: pulls.map((entry, position) => ({
							number: entry.number,
							headSha: entry.head,
							headRef: entry.branch,
							baseRef: entry.base ?? "main",
							position,
							enqueuedAt: "2026-11-10T11:00:00.000Z",
							changedPaths: entry.paths ?? [],
							// Like the host: once enqueued, an entry is in the queue.
							started:
								(entry.started ?? false) || enqueued.includes(entry.number),
							fork: entry.fork ?? false,
						})),
					}),
			},
			publisher: {
				comment: async (number, body) => {
					comments.push({ number, body });
				},
				enqueue: async (entry) => {
					if (refuseEnqueue.has(entry.number)) throw new Error("not mergeable");
					enqueued.push(entry.number);
				},
			},
			workspace: wrap(repos.workspace()),
			engines,
			structured,
			journal,
			now: () => clock,
		});
		const types = async () =>
			(await journal.events()).map((event) => event.type);
		return {
			agent,
			journal,
			comments,
			enqueued,
			refuseEnqueue,
			base,
			checks,
			types,
		};
	}
	const branches = () =>
		repos
			.git(repos.remote, "for-each-ref", "--format=%(refname)", "refs/heads")
			.split("\n");

	it("observe: plans and resolves locally, and writes nothing to the remote", async () => {
		const first = pull(1, "TWO from 1");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const before = branches();
		const { agent, comments, enqueued, types } = setup("observe", [first]);
		const report = await agent.tick();

		expect(report.plan?.resolutions).toMatchObject([
			{ number: 1, against: [], paths: ["a.txt"] },
		]);
		expect(report.resolutions).toMatchObject([
			{
				number: 1,
				outcome: "resolved",
				engineId: "scripted",
				files: [{ path: "a.txt", regions: 1 }],
				publishedRef: "",
			},
		]);
		expect(report.resolutions[0]?.commitSha).toMatch(/^[a-f0-9]{40}$/);
		expect(await types()).toEqual([
			"ci.agent.PlanProposed",
			"ci.agent.ResolutionSettled",
		]);
		expect(branches()).toEqual(before);
		expect(repos.remoteRef("refs/heads/pr-1")).toBe(first.head);
		expect(comments).toEqual([]);
		expect(enqueued).toEqual([]);
	});

	it("suggest: pushes a candidate branch and a comment, and leaves the pull request branch alone", async () => {
		const first = pull(1, "TWO from 1");
		const main = repos.commit("main", {
			"a.txt": BASE.replace("two", "TWO from main"),
		});
		const engine = takeBoth();
		const { agent, comments, types, journal } = setup("suggest", [first], {}, [
			engine,
		]);
		const report = await agent.tick();

		const ref = `refs/heads/hobo-agent/resolve/1-${first.head.slice(0, 8)}`;
		const commit = report.resolutions[0]?.commitSha ?? "";
		expect(repos.remoteRef(ref)).toBe(commit);
		expect(repos.remoteFile(ref, "a.txt")).toBe(
			"one\nTWO from 1\nTWO from main\nthree\nfour\nfive\n",
		);
		expect(repos.git(repos.remote, "log", "-1", "--format=%P", commit)).toBe(
			`${first.head} ${main}`,
		);
		const message = repos.git(repos.remote, "log", "-1", "--format=%B", commit);
		expect(message).toContain("has not been reviewed");
		expect(message).toMatch(/Hobo-Agent-Resolution: [a-f0-9]{64}/);
		expect(message).toContain("Hobo-Agent-Engine: scripted (scripted-model)");
		expect(repos.remoteRef("refs/heads/pr-1")).toBe(first.head);
		expect(repos.remoteRef("refs/heads/main")).toBe(main);
		expect(comments).toHaveLength(1);
		expect(comments[0]).toMatchObject({ number: 1 });
		expect(comments[0]?.body).toContain("Nothing on this branch was changed");
		expect(await types()).toEqual([
			"ci.agent.PlanProposed",
			"ci.agent.ResolutionSettled",
			"ci.agent.ResolutionPublished",
		]);

		// The same queue again: no second model call, no second comment, no new event.
		const again = await agent.tick();
		expect(again.resolutions).toEqual([]);
		expect(engine.requests).toHaveLength(1);
		expect(comments).toHaveLength(1);
		expect(await journal.events()).toHaveLength(3);
	});

	it("apply: fast-forwards the pull request branch, and enqueues clean work in planned order", async () => {
		const conflicted = pull(1, "TWO from 1");
		const cleanA = { ...pull(2, "two"), paths: ["b.txt"] };
		repos.commit("pr-2", { "b.txt": "b from 2\n" });
		repos.pull(2, "pr-2");
		cleanA.head = repos.remoteRef("refs/heads/pr-2");
		const started = { ...pull(3, "two"), started: true, paths: ["c.txt"] };
		const main = repos.commit("main", {
			"a.txt": BASE.replace("two", "TWO from main"),
		});
		const { agent, comments, enqueued, types } = setup("apply", [
			started,
			conflicted,
			cleanA,
		]);
		const report = await agent.tick();

		const commit = report.resolutions[0]?.commitSha ?? "";
		expect(repos.remoteRef("refs/heads/pr-1")).toBe(commit);
		expect(repos.git(repos.remote, "log", "-1", "--format=%P", commit)).toBe(
			`${conflicted.head} ${main}`,
		);
		expect(comments[0]?.body).toContain("was pushed to this branch");
		// Never the base branch, and never a merge: main is where it was.
		expect(repos.remoteRef("refs/heads/main")).toBe(main);
		// 3 is already in the queue; 1 still conflicted at this snapshot; 2 is clean.
		expect(enqueued).toEqual([2]);
		expect(report.enqueued).toEqual([2]);
		expect(await types()).toEqual([
			"ci.agent.PlanProposed",
			"ci.agent.ResolutionSettled",
			"ci.agent.ResolutionPublished",
			"ci.agent.EntryEnqueued",
		]);
	});

	it.each([
		["the base branch has no required checks", { requiresChecks: false }],
		["the lookup fails", { lookupFails: true }],
	])("apply: only suggests when %s", async (_name, state) => {
		const conflicted = pull(1, "TWO from 1");
		const clean = pull(2, "two", { paths: ["x.txt"] });
		const main = repos.commit("main", {
			"a.txt": BASE.replace("two", "TWO from main"),
		});
		const { agent, comments, enqueued, base, types } = setup("apply", [
			conflicted,
			clean,
		]);
		Object.assign(base, state);
		const report = await agent.tick();

		expect(report.applyWithheld).toBe(true);
		// Nothing a model wrote reached a pull request branch or the merge queue.
		expect(repos.remoteRef("refs/heads/pr-1")).toBe(conflicted.head);
		expect(repos.remoteRef("refs/heads/main")).toBe(main);
		expect(enqueued).toEqual([]);
		expect(report.enqueued).toEqual([]);
		// The resolution is still offered, on a side branch.
		expect(
			repos.remoteRef(
				`refs/heads/hobo-agent/resolve/1-${conflicted.head.slice(0, 8)}`,
			),
		).toBe(report.resolutions[0]?.commitSha);
		expect(comments[0]?.body).toContain("Nothing on this branch was changed");
		expect(await types()).toEqual([
			"ci.agent.PlanProposed",
			"ci.agent.ApplyWithheld",
			"ci.agent.ResolutionSettled",
			"ci.agent.ResolutionPublished",
		]);

		// Recorded once a day, not once a pass; and apply resumes once confirmed.
		await agent.tick();
		expect(
			(await types()).filter((type) => type === "ci.agent.ApplyWithheld"),
		).toHaveLength(1);
		Object.assign(base, { requiresChecks: true, lookupFails: false });
		const confirmed = await agent.tick();
		expect(confirmed.applyWithheld).toBe(false);
		expect(confirmed.enqueued).toEqual([2]);
	});

	it("observe and suggest never ask whether the base branch is protected", async () => {
		for (const mode of ["observe", "suggest"] as const) {
			const { agent, base } = setup(mode, [
				pull(mode === "observe" ? 1 : 2, "two"),
			]);
			base.lookupFails = true;
			const report = await agent.tick();
			expect(report.applyWithheld).toBe(false);
			expect(report.failures).toBe(0);
		}
	});

	it("apply: never pushes to a fork's branch; it falls back to a candidate branch", async () => {
		const fork = pull(1, "TWO from fork", { fork: true });
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const { agent, comments } = setup("apply", [fork]);
		await agent.tick();
		expect(repos.remoteRef("refs/heads/pr-1")).toBe(fork.head);
		expect(
			repos.remoteRef(
				`refs/heads/hobo-agent/resolve/1-${fork.head.slice(0, 8)}`,
			),
		).toMatch(/^[a-f0-9]{40}$/);
		expect(comments[0]?.body).toContain("Nothing on this branch was changed");
	});

	it("apply: asks to enqueue a commit once per ten minutes, and a refusal does not stop the tick", async () => {
		const first = pull(1, "two", { paths: ["x.txt"] });
		const second = pull(2, "two", { paths: ["y.txt"] });
		const { agent, enqueued, refuseEnqueue } = setup("apply", [first, second]);
		refuseEnqueue.add(1);
		const report = await agent.tick();
		expect(enqueued).toEqual([2]);
		expect(report.failures).toBe(1);
		refuseEnqueue.clear();
		expect((await agent.tick()).enqueued).toEqual([]);
		clock = "2026-11-10T12:11:00.000Z";
		expect((await agent.tick()).enqueued).toEqual([1]);
	});

	it("abstains on a protected path without asking the engine, and does not try again", async () => {
		const branch = "pr-1";
		const head = repos.commit(branch, { "pnpm-lock.yaml": "lock from 1\n" });
		repos.pull(1, branch);
		repos.commit("main", { "pnpm-lock.yaml": "lock from main\n" });
		const engine = takeBoth();
		const before = branches();
		const { agent, comments, journal } = setup(
			"apply",
			[{ number: 1, branch, head, paths: ["pnpm-lock.yaml"] }],
			{},
			[engine],
		);
		const report = await agent.tick();
		expect(report.resolutions).toMatchObject([
			{ outcome: "abstained", reason: "protected-path", commitSha: "" },
		]);
		await agent.tick();
		expect(engine.requests).toHaveLength(0);
		expect(comments).toEqual([]);
		expect(branches()).toEqual(before);
		expect(repos.remoteRef("refs/heads/pr-1")).toBe(head);
		expect(await journal.events()).toHaveLength(2);
	});

	it("suggest with rollup: combines conflicting pull requests on one candidate branch", async () => {
		const first = pull(1, "TWO from 1");
		const second = pull(2, "TWO from 2");
		const main = repos.remoteRef("refs/heads/main");
		const { agent, comments, types } = setup("suggest", [first, second], {
			queue: { rollup: true },
		});
		const report = await agent.tick();

		expect(report.plan?.resolutions).toMatchObject([
			{ number: 2, against: [1] },
		]);
		expect(report.rollupRef).toMatch(
			/^refs\/heads\/hobo-agent\/rollup\/[a-f0-9]{12}$/,
		);
		const ref = report.rollupRef ?? "";
		// 1 merged cleanly onto main; 2 was resolved against main plus 1.
		expect(repos.remoteFile(ref, "a.txt")).toBe(
			"one\nTWO from 1\nTWO from 2\nthree\nfour\nfive\n",
		);
		expect(
			repos.git(repos.remote, "merge-base", "--is-ancestor", first.head, ref),
		).toBe("");
		expect(
			repos.git(repos.remote, "merge-base", "--is-ancestor", second.head, ref),
		).toBe("");
		expect(repos.remoteRef("refs/heads/main")).toBe(main);
		expect(repos.remoteRef("refs/heads/pr-1")).toBe(first.head);
		expect(repos.remoteRef("refs/heads/pr-2")).toBe(second.head);
		expect(comments.map((comment) => comment.number)).toEqual([1, 2]);
		expect(comments[0]?.body).toContain("nothing was merged");
		expect(await types()).toEqual([
			"ci.agent.PlanProposed",
			"ci.agent.ResolutionSettled",
			"ci.agent.RollupPublished",
		]);
		// Published once.
		expect((await agent.tick()).rollupRef).toBeUndefined();
		expect(comments).toHaveLength(2);
	});

	it("stops at the daily token budget, records it once, and resumes the next day", async () => {
		const first = pull(1, "TWO from 1");
		const second = pull(2, "TWO from 2");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const engine = takeBoth();
		// An attempt reserves its prompt estimate plus 1,000 output tokens (about
		// 1,720); the scripted engine reports 120 spent. The second cannot fit.
		const budget = {
			budget: { maxOutputTokens: 1_000, maxTokensPerDay: 1_800 },
		};
		const { agent, journal, types } = setup("observe", [first], budget, [
			engine,
		]);
		expect((await agent.tick()).resolutions).toHaveLength(1);

		const next = setup("observe", [second], budget, [engine]);
		// The same journal, as after a restart: today's spend is still known.
		for (const event of await journal.events())
			await next.journal.append(event);
		expect((await next.agent.tick()).resolutions).toEqual([]);
		await next.agent.tick();
		expect(
			(await next.types()).filter((type) => type.endsWith("BudgetExhausted")),
		).toHaveLength(1);
		expect(engine.requests).toHaveLength(1);

		clock = "2026-11-11T00:00:01.000Z";
		expect((await next.agent.tick()).resolutions).toMatchObject([
			{ number: 2, outcome: "resolved" },
		]);
		expect(await types()).toContain("ci.agent.ResolutionSettled");
	});

	it("limits model-backed resolutions per tick and tolerates a failing comment", async () => {
		const pulls = [
			pull(1, "TWO from 1"),
			pull(2, "TWO from 2"),
			pull(3, "TWO from 3"),
		];
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const engine = takeBoth();
		const { agent } = setup(
			"observe",
			pulls,
			{ budget: { maxResolutionsPerTick: 2 } },
			[engine],
		);
		expect(
			(await agent.tick()).resolutions.map((entry) => entry.number),
		).toEqual([1, 2]);
		expect(
			(await agent.tick()).resolutions.map((entry) => entry.number),
		).toEqual([3]);
		expect(engine.requests).toHaveLength(3);
	});

	it("publishes on a later pass a resolution whose push failed, without asking the model again", async () => {
		const first = pull(1, "TWO from 1");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const engine = takeBoth();
		let failPush = true;
		const { agent, comments } = setup(
			"suggest",
			[first],
			{},
			[engine],
			(w) => ({
				...w,
				push: async (commit, ref) => {
					if (failPush) throw new Error("network");
					return w.push(commit, ref);
				},
			}),
		);
		const ref = `refs/heads/hobo-agent/resolve/1-${first.head.slice(0, 8)}`;
		const report = await agent.tick();
		expect(report.failures).toBe(1);
		expect(comments).toEqual([]);
		expect(() => repos.remoteRef(ref)).toThrow();

		failPush = false;
		const retried = await agent.tick();
		expect(retried.resolutions).toEqual([]);
		expect(repos.remoteRef(ref)).toBe(report.resolutions[0]?.commitSha);
		expect(comments).toHaveLength(1);
		expect(engine.requests).toHaveLength(1);
		// Published once: a third pass changes nothing.
		await agent.tick();
		expect(comments).toHaveLength(1);
	});

	it("apply: never enqueues the same commit twice, even after the queue ejects it", async () => {
		const clean = pull(1, "two", { paths: ["x.txt"] });
		const { agent, enqueued } = setup("apply", [clean]);
		expect((await agent.tick()).enqueued).toEqual([1]);
		// The merge queue ejected it (its checks failed): it is waiting again.
		enqueued.splice(0);
		clock = "2026-11-10T13:00:00.000Z";
		expect((await agent.tick()).enqueued).toEqual([]);
		// A new commit on the pull request is a new candidate.
		clean.head = repos.commit("pr-1", { "x.txt": "fixed\n" });
		repos.pull(1, "pr-1");
		expect((await agent.tick()).enqueued).toEqual([1]);
	});

	it("apply: does not enqueue a pull request whose trial merge could not run", async () => {
		const broken = pull(1, "two", { paths: ["x.txt"] });
		const clean = pull(2, "two", { paths: ["y.txt"] });
		const { agent } = setup(
			"apply",
			[broken, clean],
			{},
			[takeBoth()],
			(w) => ({
				...w,
				trial: async (ours, theirs) => {
					if (ours === broken.head) throw new Error("git merge-tree failed");
					return w.trial(ours, theirs);
				},
			}),
		);
		const report = await agent.tick();
		expect(report.enqueued).toEqual([2]);
		expect(report.failures).toBeGreaterThan(0);
	});

	it("rollup: an abstained peer conflict is not sent to the model again on later passes", async () => {
		const first = pull(1, "TWO from 1");
		const second = pull(2, "TWO from 2");
		const unsure = takeBoth(0.3);
		const { agent } = setup(
			"suggest",
			[first, second],
			{ queue: { rollup: true } },
			[unsure],
		);
		expect((await agent.tick()).rollupRef).toBeUndefined();
		expect(unsure.requests).toHaveLength(1);
		// Commit dates come from the parents, not the clock: a later pass makes
		// the same candidate commit, so the attempt is recognised.
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await agent.tick();
		expect(unsure.requests).toHaveLength(1);
	});

	it("repairs a published resolution whose checks failed, once, on top of its own commit", async () => {
		const first = pull(1, "TWO from 1");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const engine = scriptedEngine((request) =>
			request.regions.map((region) => ({
				id: region.id,
				resolution: request.previous
					? "TWO repaired\n"
					: region.ours + region.theirs,
				confidence: 0.95,
			})),
		);
		const { agent, comments, checks, types } = setup("suggest", [first], {}, [
			engine,
		]);
		const ref = `refs/heads/hobo-agent/resolve/1-${first.head.slice(0, 8)}`;
		const original = (await agent.tick()).resolutions[0]?.commitSha ?? "";
		expect(repos.remoteRef(ref)).toBe(original);

		// Checks still running: nothing happens.
		checks.set(original, { state: "pending", failures: "" });
		expect((await agent.tick()).resolutions).toEqual([]);
		checks.set(original, {
			state: "failure",
			failures:
				"check test (FAILURE): duplicate line\n  a.txt:2 expected one TWO",
		});
		const repair = (await agent.tick()).resolutions[0];
		expect(repair).toMatchObject({ outcome: "resolved", attempt: 1 });
		// The engine saw what it wrote last time and what the checks said.
		expect(engine.requests[1]?.previous).toEqual({
			regions: [{ id: 0, resolution: "TWO from 1\nTWO from main\n" }],
			checkFailures:
				"check test (FAILURE): duplicate line\n  a.txt:2 expected one TWO",
		});
		// A fast-forward of the same branch, on top of the failed commit.
		expect(repos.remoteRef(ref)).toBe(repair?.commitSha);
		expect(
			repos.git(
				repos.remote,
				"log",
				"-1",
				"--format=%P",
				repair?.commitSha ?? "",
			),
		).toBe(original);
		expect(repos.remoteFile(ref, "a.txt")).toBe(
			"one\nTWO repaired\nthree\nfour\nfive\n",
		);
		expect(comments.at(-1)?.body).toContain("pushed a corrected merge commit");

		// The repair fails too: one repair is the limit, so a person is told.
		checks.set(repair?.commitSha ?? "", { state: "failure", failures: "x" });
		await agent.tick();
		expect(engine.requests).toHaveLength(2);
		expect(comments.at(-1)?.body).toContain("will not try again");
		await agent.tick();
		expect(
			comments.filter((c) => c.body.includes("will not try again")),
		).toHaveLength(1);
		expect(
			(await types()).filter((type) => type === "ci.agent.ResolutionChecked"),
		).toHaveLength(2);
	});

	it("reuses a resolution whose checks passed for the same conflict, without the model", async () => {
		const first = pull(1, "TWO from 1");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const engine = takeBoth();
		const pulls = [first];
		const { agent, checks } = setup("suggest", pulls, {}, [engine]);
		const original = (await agent.tick()).resolutions[0]?.commitSha ?? "";
		checks.set(original, { state: "success", failures: "" });
		await agent.tick();
		expect(engine.requests).toHaveLength(1);

		// A second pull request makes the same change and meets the same conflict.
		{
			// Branched from where the first one was, before main moved.
			const head = repos.commit(
				"pr-2",
				{ "a.txt": BASE.replace("two", "TWO from 1") },
				`${first.head}^`,
			);
			repos.pull(2, "pr-2");
			pulls.push({ number: 2, branch: "pr-2", head, paths: ["a.txt"] });
		}
		const report = await agent.tick();
		expect(engine.requests).toHaveLength(1);
		expect(report.resolutions).toMatchObject([
			{ number: 2, outcome: "resolved", engineId: "recorded" },
		]);
		const commit = report.resolutions[0]?.commitSha ?? "";
		expect(repos.git(repos.agent, "show", `${commit}:a.txt`)).toBe(
			repos.git(repos.agent, "show", `${original}:a.txt`),
		);
		expect(
			repos.git(repos.agent, "log", "-1", "--format=%B", commit),
		).toContain("Hobo-Agent-Engine: recorded resolutions");
	});

	it("does not reuse a resolution whose checks failed", async () => {
		const first = pull(1, "TWO from 1");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const engine = takeBoth();
		const pulls = [first];
		const { agent, checks } = setup(
			"suggest",
			pulls,
			{ resolution: { maxRepairs: 0 } },
			[engine],
		);
		const original = (await agent.tick()).resolutions[0]?.commitSha ?? "";
		checks.set(original, { state: "failure", failures: "test failed" });
		await agent.tick();
		{
			// Branched from where the first one was, before main moved.
			const head = repos.commit(
				"pr-2",
				{ "a.txt": BASE.replace("two", "TWO from 1") },
				`${first.head}^`,
			);
			repos.pull(2, "pr-2");
			pulls.push({ number: 2, branch: "pr-2", head, paths: ["a.txt"] });
		}
		await agent.tick();
		expect(engine.requests).toHaveLength(2);
	});

	it("commits a clean structured merge without the model, and says so", async () => {
		const first = pull(1, "TWO from 1");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const engine = takeBoth();
		const seen: { base: string; ours: string; theirs: string }[] = [];
		const { agent, journal } = setup(
			"suggest",
			[first],
			{ resolution: { structuredMerge: true } },
			[engine],
			(w) => w,
			{
				id: "mergiraf",
				merge: async ({ base, ours, theirs }) => {
					seen.push({ base, ours, theirs });
					return BASE.replace("two", "TWO from 1 and main");
				},
			},
		);
		const report = await agent.tick();
		expect(engine.requests).toHaveLength(0);
		expect(seen).toEqual([
			{
				base: BASE,
				ours: BASE.replace("two", "TWO from 1"),
				theirs: BASE.replace("two", "TWO from main"),
			},
		]);
		expect(report.resolutions).toMatchObject([
			{
				outcome: "resolved",
				engineId: "structured",
				model: "mergiraf",
				files: [{ path: "a.txt", regions: 0, structured: true }],
			},
		]);
		const commit = report.resolutions[0]?.commitSha ?? "";
		expect(repos.git(repos.agent, "show", `${commit}:a.txt`)).toBe(
			BASE.replace("two", "TWO from 1 and main").trimEnd(),
		);
		const message = repos.git(repos.agent, "log", "-1", "--format=%B", commit);
		expect(message).toContain("- a.txt (structured merge of the whole file)");
		expect(message).toContain("Hobo-Agent-Engine: structured merge (mergiraf)");
		expect(
			(await journal.events()).filter(
				(event) => event.type === "ci.agent.ResolutionSettled",
			),
		).toHaveLength(1);
	});

	it("records passing checks once and does not repair", async () => {
		const first = pull(1, "TWO from 1");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const engine = takeBoth();
		const { agent, checks, journal } = setup("suggest", [first], {}, [engine]);
		const original = (await agent.tick()).resolutions[0]?.commitSha ?? "";
		checks.set(original, { state: "success", failures: "" });
		await agent.tick();
		await agent.tick();
		expect(engine.requests).toHaveLength(1);
		expect(
			(await journal.events()).filter(
				(event) => event.type === "ci.agent.ResolutionChecked",
			),
		).toMatchObject([{ checksState: "success" }]);
	});

	it("apply: does not repair a pull request branch someone else has moved", async () => {
		const first = pull(1, "TWO from 1");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const engine = takeBoth();
		const { agent, checks, comments } = setup("apply", [first], {}, [engine]);
		const original = (await agent.tick()).resolutions[0]?.commitSha ?? "";
		// The author pushed on top of the agent's commit.
		const tree = repos.git(repos.remote, "rev-parse", `${original}^{tree}`);
		first.head = repos.git(
			repos.remote,
			"commit-tree",
			tree,
			"-p",
			original,
			"-m",
			"author fix",
		);
		repos.git(repos.remote, "update-ref", "refs/heads/pr-1", first.head);
		repos.git(repos.remote, "update-ref", "refs/pull/1/head", first.head);
		checks.set(original, { state: "failure", failures: "x" });
		await agent.tick();
		expect(engine.requests).toHaveLength(1);
		expect(comments.some((c) => c.body.includes("will not try again"))).toBe(
			false,
		);
	});

	it("apply: waits for a re-run, without repairing, when checks failed only for infrastructure", async () => {
		const first = pull(1, "TWO from 1");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const engine = takeBoth();
		const { agent, checks, enqueued, journal } = setup("apply", [first], {}, [
			engine,
		]);
		const resolved = (await agent.tick()).resolutions[0]?.commitSha ?? "";
		first.head = resolved;
		repos.git(repos.remote, "update-ref", "refs/pull/1/head", resolved);
		checks.set(resolved, { state: "infrastructure", failures: "" });
		await agent.tick();
		await agent.tick();
		expect(engine.requests).toHaveLength(1);
		expect(enqueued).toEqual([]);
		expect(
			(await journal.events()).some(
				(event) => event.type === "ci.agent.ResolutionChecked",
			),
		).toBe(false);
		// Someone re-ran the checks and they passed.
		checks.set(resolved, { state: "success", failures: "" });
		expect((await agent.tick()).enqueued).toEqual([1]);
		expect(engine.requests).toHaveLength(1);
	});

	it("apply: waits for the checks on its own merge commit before enqueueing", async () => {
		const first = pull(1, "TWO from 1");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const { agent, checks, enqueued } = setup("apply", [first]);
		const resolved = (await agent.tick()).resolutions[0]?.commitSha ?? "";
		// The pull request's head is now the agent's commit, and it merges cleanly.
		first.head = resolved;
		repos.git(repos.remote, "update-ref", "refs/pull/1/head", resolved);
		checks.set(resolved, { state: "pending", failures: "" });
		expect((await agent.tick()).enqueued).toEqual([]);
		// The pass that sees them pass records it and enqueues.
		checks.set(resolved, { state: "success", failures: "" });
		expect((await agent.tick()).enqueued).toEqual([1]);
		expect(enqueued).toEqual([1]);
	});

	it("apply: isolates and does not re-add a pull request the merge queue ejected", async () => {
		const first = pull(1, "two", { paths: ["x.txt"] });
		const second = pull(2, "two", { paths: ["y.txt"] });
		const { agent, enqueued, comments } = setup("apply", [first, second]);
		expect((await agent.tick()).enqueued).toEqual([1, 2]);
		// The queue removed #1; #2 is still in it.
		enqueued.splice(enqueued.indexOf(1), 1);
		clock = "2026-11-10T12:05:00.000Z";
		const report = await agent.tick();
		expect(report.ejected).toEqual([1]);
		expect(report.enqueued).toEqual([]);
		expect(comments.filter((c) => c.number === 1)).toHaveLength(1);
		expect(comments[0]?.body).toContain("the queue removed it");
		// Batched alone, and noticed once.
		expect(
			report.plan?.batches.find((batch) => batch.numbers.includes(1))?.numbers,
		).toEqual([1]);
		expect((await agent.tick()).ejected).toEqual([]);
	});

	it("apply: does not put two conflicting pull requests in the queue together", async () => {
		const first = pull(1, "TWO from 1");
		const second = pull(2, "TWO from 2");
		const { agent, enqueued } = setup("apply", [first, second]);
		expect((await agent.tick()).enqueued).toEqual([1]);
		expect(enqueued).toEqual([1]);
		// Once #1 has merged, #2 conflicts with the base branch and is resolved there.
		repos.git(repos.remote, "update-ref", "refs/heads/main", first.head);
		enqueued.splice(0);
		const { agent: next } = setup("apply", [second]);
		expect((await next.tick()).resolutions).toMatchObject([
			{ number: 2, outcome: "resolved" },
		]);
	});

	it("leaves a stacked pull request to its parent: not resolved, not enqueued", async () => {
		const parent = pull(1, "TWO from 1");
		const child = { ...pull(2, "TWO from 2"), base: "pr-1", paths: ["a.txt"] };
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const { agent, enqueued } = setup("apply", [parent, child]);
		const report = await agent.tick();
		expect(report.resolutions.map((resolution) => resolution.number)).toEqual([
			1,
		]);
		expect(enqueued).not.toContain(2);
	});

	it("records a failed engine and does not publish anything", async () => {
		const first = pull(1, "TWO from 1");
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO from main") });
		const before = branches();
		const { agent, comments } = setup("apply", [first], {}, [
			scriptedEngine(() => {
				throw new Error("provider down");
			}),
		]);
		expect((await agent.tick()).resolutions).toMatchObject([
			{ outcome: "failed", reason: "engine-unavailable" },
		]);
		expect(branches()).toEqual(before);
		expect(comments).toEqual([]);
	});
});
