import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	fetchLastGreenMainSha,
	resolveMainTestBase,
} from "../ci/resolve-main-test-base.mts";

/**
 * `resolveMainTestBase` asks git in the working directory whether a commit
 * exists. The repository's own history is not an input the test controls: a
 * CI checkout with `fetch-depth: 2` has no `HEAD~2`, so the answer changed
 * with the machine. These tests run in a throwaway repository of four commits
 * (oldest first) with the user's git configuration switched off.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Base Test",
	GIT_AUTHOR_EMAIL: "base@example.invalid",
	GIT_COMMITTER_NAME: "Base Test",
	GIT_COMMITTER_EMAIL: "base@example.invalid",
};

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], {
		cwd,
		env: GIT_ENV,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

let repo = "";
let commits: readonly string[] = [];

/** Runs `check` with the throwaway repository as the working directory. */
function inRepo<T>(check: () => T): T {
	const home = process.cwd();
	process.chdir(repo);
	try {
		return check();
	} finally {
		process.chdir(home);
	}
}

describe("resolveMainTestBase", () => {
	before(() => {
		repo = mkdtempSync(join(tmpdir(), "main-test-base-"));
		git(repo, ["init", "--quiet"]);
		const made: string[] = [];
		for (let index = 0; index < 4; index += 1) {
			git(repo, ["commit", "--quiet", "--allow-empty", "-m", `c${index}`]);
			made.push(git(repo, ["rev-parse", "HEAD"]));
		}
		commits = made;
	});

	after(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("prefers last green over push before", () => {
		const [last, , pushBefore, head] = commits;
		const resolved = inRepo(() =>
			resolveMainTestBase({
				eventName: "push",
				pushBefore: pushBefore ?? "",
				head: head ?? "",
				lastGreenSha: last ?? "",
			}),
		);
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
		const [, pushBefore, , head] = commits;
		const resolved = inRepo(() =>
			resolveMainTestBase({
				eventName: "push",
				pushBefore: pushBefore ?? "",
				head: head ?? "",
			}),
		);
		assert.equal(resolved.source, "push-before");
		assert.equal(resolved.base, pushBefore);
	});
});

describe("fetchLastGreenMainSha", () => {
	it("lists only this workflow's main pushes, with a time limit", async () => {
		const seen: { url: string; signal: AbortSignal | null | undefined }[] = [];
		const found = await fetchLastGreenMainSha({
			repository: "Hobo-Labs/HoBo",
			token: "t",
			workflowBasename: "hobo-ci.yml",
			head: "f".repeat(40),
			fetch: async (url, init) => {
				seen.push({ url, signal: init.signal });
				return new Response(JSON.stringify({ workflow_runs: [] }), {
					status: 200,
				});
			},
		});
		assert.equal(found, undefined);
		assert.equal(
			seen[0]?.url,
			"https://api.github.com/repos/Hobo-Labs/HoBo/actions/workflows/hobo-ci.yml/runs?branch=main&event=push&status=completed&per_page=30",
		);
		assert.ok(seen[0]?.signal instanceof AbortSignal);
	});

	it("reads a timed-out or unreadable answer as no last green commit", async () => {
		const base = {
			repository: "Hobo-Labs/HoBo",
			token: "t",
			workflowBasename: "hobo-ci.yml",
			head: "f".repeat(40),
		};
		const timedOut = await fetchLastGreenMainSha({
			...base,
			fetch: async () => {
				throw new DOMException("The operation timed out.", "TimeoutError");
			},
		});
		assert.equal(timedOut, undefined);
		const garbled = await fetchLastGreenMainSha({
			...base,
			fetch: async () => new Response("<html>", { status: 200 }),
		});
		assert.equal(garbled, undefined);
		const malformed = await fetchLastGreenMainSha({
			...base,
			fetch: async () =>
				new Response(
					JSON.stringify({ workflow_runs: [{ conclusion: "success" }] }),
					{ status: 200 },
				),
		});
		assert.equal(malformed, undefined);
	});
});
