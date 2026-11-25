import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { TestPlan } from "../ci/dependent-tests.mts";
import {
	repoPathNeedsPlaywright,
	workspaceShardNeedsPlaywright,
} from "../ci/job-needs-playwright-browser.mts";
import { readWorkspaces } from "../ci/job-scope.mts";

describe("job-needs-playwright-browser", () => {
	it("flags known Playwright browser tests", () => {
		assert.equal(
			repoPathNeedsPlaywright("packages/hobo/test/mcp-owner-page.test.ts"),
			true,
		);
		assert.equal(
			repoPathNeedsPlaywright(
				"packages/ci-dashboard/test/dashboard.browser.test.ts",
			),
			true,
		);
		assert.equal(
			repoPathNeedsPlaywright("packages/core/test/foo.test.ts"),
			false,
		);
	});

	it("reports true only for shards that run browser suites", () => {
		readRepo();
		const workspaces = readWorkspaces();
		const plan: TestPlan = {
			mode: "scoped",
			full: ["packages/ci-dashboard"],
			subsets: new Map(),
			skipped: [],
		};
		assert.equal(
			workspaceShardNeedsPlaywright({
				plan,
				shard: 0,
				shardTotal: 1,
			}),
			true,
		);
		const noBrowser: TestPlan = {
			mode: "scoped",
			full: ["packages/core"],
			subsets: new Map(),
			skipped: [],
		};
		assert.equal(
			workspaceShardNeedsPlaywright({
				plan: noBrowser,
				shard: 0,
				shardTotal: 1,
			}),
			false,
		);
		assert.ok(workspaces.length > 0);
	});
});
