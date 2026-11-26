import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

const run = (env: Record<string, string | undefined>): string =>
	execFileSync("node", ["--import", "tsx", "scripts/ci/turbo-scm-base.mts"], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	}).trim();

describe("turbo-scm-base", () => {
	it("uses merge_group base sha", () => {
		assert.equal(
			run({
				GITHUB_EVENT_NAME: "merge_group",
				GITHUB_EVENT_MERGE_GROUP_BASE_SHA: "abc123",
			}),
			"abc123",
		);
	});

	it("uses origin base ref for pull_request (stack parent via PR base)", () => {
		assert.equal(
			run({
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_BASE_REF: "sdlc/feat-01-schema",
			}),
			"origin/sdlc/feat-01-schema",
		);
	});

	it("defaults to origin/main for push and dispatch", () => {
		assert.equal(run({ GITHUB_EVENT_NAME: "push" }), "origin/main");
		assert.equal(
			run({ GITHUB_EVENT_NAME: "workflow_dispatch" }),
			"origin/main",
		);
	});
});
