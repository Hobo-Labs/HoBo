import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	fetchLastGreenMainSha,
	resolveMainTestBase,
} from "../ci/resolve-main-test-base.mts";

const rev = (name: string) =>
	spawnSync("git", ["rev-parse", name], { encoding: "utf8" }).stdout.trim();

/** A fetch that records the URL it was asked for and answers with `runs`. */
function runsApi(runs: readonly object[]) {
	const urls: string[] = [];
	const fetch = async (url: string, _init: RequestInit) => {
		urls.push(url);
		return new Response(JSON.stringify({ workflow_runs: runs }), {
			status: 200,
		});
	};
	return { urls, fetch };
}

const green = (sha: string) => ({
	head_sha: sha,
	conclusion: "success",
	event: "push",
	path: ".github/workflows/hobo-ci.yml",
});

describe("fetchLastGreenMainSha", () => {
	const lookup = {
		repository: "Hobo-Labs/HoBo",
		token: "t",
		workflowBasename: "hobo-ci.yml",
	};

	it("asks for main's pushes when no branch is given", async () => {
		const api = runsApi([green(rev("HEAD~1"))]);
		const sha = await fetchLastGreenMainSha({
			...lookup,
			head: rev("HEAD"),
			fetch: api.fetch,
		});
		assert.equal(sha, rev("HEAD~1"));
		assert.deepEqual(api.urls, [
			"https://api.github.com/repos/Hobo-Labs/HoBo/actions/runs?branch=main&event=push&status=completed&per_page=30",
		]);
	});

	it("asks for the pushed branch's own runs, not main's", async () => {
		// After main is merged into a long-lived branch, main's last green commit
		// is an ancestor of the branch head. Asked for main's runs, the lookup
		// returned it, and the branch's tests were scoped against main.
		const api = runsApi([green(rev("HEAD~1"))]);
		await fetchLastGreenMainSha({
			...lookup,
			head: rev("HEAD"),
			branch: "feature/hobo-code",
			fetch: api.fetch,
		});
		assert.deepEqual(api.urls, [
			"https://api.github.com/repos/Hobo-Labs/HoBo/actions/runs?branch=feature%2Fhobo-code&event=push&status=completed&per_page=30",
		]);
	});

	it("finds nothing when the branch has no green run, so the caller falls back", async () => {
		const api = runsApi([]);
		const sha = await fetchLastGreenMainSha({
			...lookup,
			head: rev("HEAD"),
			branch: "feature/hobo-code",
			fetch: api.fetch,
		});
		assert.equal(sha, undefined);
	});
});

describe("the callers of the last-green lookup", () => {
	it("pass the pushed branch", () => {
		// Left out, the lookup searches main's runs whatever was pushed.
		for (const script of [
			"resolve-main-test-base.mts",
			"plan-main-workspace-shards.mts",
		]) {
			const source = readFileSync(
				join(import.meta.dirname, "..", "ci", script),
				"utf8",
			);
			const at = source.indexOf("await fetchLastGreenMainSha({");
			const call = source.slice(at);
			// Only a push has a pushed branch; both scripts ask under that guard.
			assert.match(
				source.slice(source.indexOf("async function main()"), at),
				/eventName === "push"/u,
				script,
			);
			assert.match(
				call.slice(0, call.indexOf("});")),
				/\bbranch: process\.env\.GITHUB_REF_NAME\?\.trim\(\) \|\| "main",/u,
				script,
			);
		}
	});

	// The script as the workflow runs it, with `fetch` replaced by one that
	// prints the URL it was asked for and answers with no runs.
	const lookups = (env: Readonly<Record<string, string>>) => {
		const preload = `data:text/javascript,${encodeURIComponent(
			"globalThis.fetch = async (url) => { process.stderr.write(`lookup ${url}\\n`); return new Response(JSON.stringify({ workflow_runs: [] })); };",
		)}`;
		const run = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				"--import",
				preload,
				join(import.meta.dirname, "..", "ci", "resolve-main-test-base.mts"),
			],
			{
				encoding: "utf8",
				env: {
					PATH: process.env.PATH ?? "",
					GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					GITHUB_TOKEN: "t",
					HEAD_SHA: rev("HEAD"),
					PUSH_BEFORE: "",
					...env,
				},
			},
		);
		assert.equal(run.status, 0, run.stderr);
		return run.stderr
			.split("\n")
			.filter((line) => line.startsWith("lookup "))
			.map((line) => new URL(line.slice("lookup ".length)).search);
	};

	it("a push to main asks for main's runs, as before the branch was passed", () => {
		const main = "?branch=main&event=push&status=completed&per_page=30";
		assert.deepEqual(lookups({ EVENT_NAME: "push", GITHUB_REF_NAME: "main" }), [
			main,
		]);
		// No ref name (a local run) is main too.
		assert.deepEqual(lookups({ EVENT_NAME: "push" }), [main]);
		assert.deepEqual(
			lookups({ EVENT_NAME: "push", GITHUB_REF_NAME: "feature/hobo-code" }),
			["?branch=feature%2Fhobo-code&event=push&status=completed&per_page=30"],
		);
	});

	it("no other event looks anything up, whatever its ref name is", () => {
		// GITHUB_REF_NAME is not a branch on these: a merge group's is
		// `gh-readonly-queue/main/pr-…`, a pull request's `<n>/merge`. The
		// workflow sends only pushes here, and the script asks only for a push.
		for (const [EVENT_NAME, GITHUB_REF_NAME] of [
			["schedule", "main"],
			["workflow_dispatch", "some-branch"],
			["merge_group", "gh-readonly-queue/main/pr-1-0123456789abcdef"],
			["pull_request", "1/merge"],
		] as const)
			assert.deepEqual(
				lookups({ EVENT_NAME, GITHUB_REF_NAME }),
				[],
				EVENT_NAME,
			);
	});
});

describe("resolveMainTestBase", () => {
	it("prefers last green over push before", () => {
		const head = spawnSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).stdout.trim();
		const last = spawnSync("git", ["rev-parse", "HEAD~3"], {
			encoding: "utf8",
		}).stdout.trim();
		const before = spawnSync("git", ["rev-parse", "HEAD~1"], {
			encoding: "utf8",
		}).stdout.trim();
		const resolved = resolveMainTestBase({
			eventName: "push",
			pushBefore: before,
			head,
			lastGreenSha: last,
		});
		assert.equal(resolved.base, last);
		assert.equal(resolved.source, "last-green");
	});

	it("schedule runs repo-wide", () => {
		const resolved = resolveMainTestBase({
			eventName: "schedule",
			pushBefore: "",
			head: "a".repeat(40),
		});
		assert.equal(resolved.base, "");
		assert.equal(resolved.source, "none");
	});
	it("falls back to push before when last green is absent", () => {
		const before = spawnSync("git", ["rev-parse", "HEAD~2"], {
			encoding: "utf8",
		}).stdout.trim();
		const head = spawnSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).stdout.trim();
		const resolved = resolveMainTestBase({
			eventName: "push",
			pushBefore: before,
			head,
		});
		assert.equal(resolved.source, "push-before");
		assert.equal(resolved.base, before);
	});
});
