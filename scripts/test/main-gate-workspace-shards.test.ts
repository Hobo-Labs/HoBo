import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github", "workflows", "hobo-ci.yml"),
	"utf8",
);

describe("main full gate workspace sharding", () => {
	it("plans shards in main-gate-plan and runs them outside the S0 job", () => {
		const planStart = workflow.indexOf("  main-gate-plan:");
		const mainStart = workflow.indexOf("  main-gate:", planStart);
		assert.ok(planStart > -1);
		assert.ok(mainStart > planStart);
		const plan = workflow.slice(planStart, mainStart);
		const main = workflow.slice(
			mainStart,
			workflow.indexOf("  main_workspace_tests:", mainStart),
		);
		assert.match(plan, /plan-main-workspace-shards\.mts/u);
		assert.match(plan, /needs: \[ci-runner-image\]/u);
		assert.doesNotMatch(plan, /pnpm-install\.mts/u);
		assert.match(plan, /HOBO_TURBO_INVOKER: mise/u);
		assert.match(plan, /main-gate-plan-\$\{\{ github\.sha \}\}/u);
		assert.match(main, /resolve-main-test-base\.mts/u);
		assert.match(main, /--external-workspace-tests/u);
		assert.doesNotMatch(main, /name: Workspace tests/u);
		assert.doesNotMatch(main, /Plan main workspace test shards/u);
	});

	it("shards workspace tests across fleet runners", () => {
		const shardStart = workflow.indexOf("  main_workspace_tests:");
		const finishStart = workflow.indexOf("  main_gate_finish:", shardStart);
		assert.ok(shardStart > -1);
		assert.ok(finishStart > shardStart);
		const block = workflow.slice(shardStart, finishStart);
		assert.match(block, /Main workspace test shard \$\{\{ matrix\.shard \}\}/u);
		assert.match(block, /needs\.main-gate-plan\.outputs\.shards/u);
		assert.match(
			block,
			/needs: \[ci-runner-image, ci-deps-image, main-gate-plan\]/u,
		);
		assert.doesNotMatch(block, /needs: \[route,/u);
		assert.match(block, /--shard="\$SHARD\/\$SHARD_TOTAL"/u);
	});

	it("finishes with gitleaks after workspace shards", () => {
		const finishStart = workflow.indexOf("  main_gate_finish:");
		const artifact = workflow.indexOf("  artifact-trust:", finishStart);
		const finish = workflow.slice(finishStart, artifact);
		assert.match(finish, /needs: \[main-gate, main_workspace_tests\]/u);
		assert.match(finish, /gitleaks-main-scan\.mts --background/u);
		assert.match(finish, /gitleaks-main-scan\.mts --wait/u);
	});
});
