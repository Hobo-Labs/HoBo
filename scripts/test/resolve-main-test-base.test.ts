import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
	fetchLastGreenMainSha,
	resolveMainTestBase,
} from "../ci/resolve-main-test-base.mts";

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
