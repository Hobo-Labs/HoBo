import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { resolveMainTestBase } from "../ci/resolve-main-test-base.mts";

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
