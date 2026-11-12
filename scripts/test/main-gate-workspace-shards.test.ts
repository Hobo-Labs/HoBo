import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github", "workflows", "hobo-ci.yml"),
	"utf8",
);

describe("main full gate workspace sharding", () => {
	it("sparse-checkouts fleet capacity for the route job", () => {
		const routeStart = workflow.indexOf("  route:");
		const runnerImage = workflow.indexOf("  ci-runner-image:", routeStart);
		assert.ok(routeStart > -1);
		const route = workflow.slice(routeStart, runnerImage);
		assert.match(route, /packages\/ci\/src\/fleet\/capacity\.ts/u);
	});

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
		assert.match(plan, /emit-main-workspace-shard-matrix\.mts/u);
		assert.match(plan, /id: shard_matrix/u);
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
		assert.match(block, /needs\.main-gate-plan\.outputs\.shard_matrix/u);
		assert.match(block, /matrix\.runner/u);
		assert.match(
			block,
			/needs: \[ci-runner-image, ci-deps-image, main-gate-plan\]/u,
		);
		assert.doesNotMatch(block, /needs: \[route,/u);
		assert.match(block, /--shard="\$SHARD\/\$SHARD_TOTAL"/u);
	});

	it("declares repository and token before plan cache restore", () => {
		const src = readFileSync(
			join(import.meta.dirname, "..", "ci", "plan-main-workspace-shards.mts"),
			"utf8",
		);
		const repoDecl = src.indexOf(
			"const repository = process.env.GITHUB_REPOSITORY",
		);
		const cacheRestore = src.indexOf("tryRestorePlanCache(head)");
		assert.ok(repoDecl > -1);
		assert.ok(cacheRestore > -1);
		assert.ok(repoDecl < cacheRestore);
	});

	it("finishes with gitleaks after workspace shards", () => {
		const finishStart = workflow.indexOf("  main_gate_finish:");
		const artifact = workflow.indexOf("  artifact-trust:", finishStart);
		const finish = workflow.slice(finishStart, artifact);
		assert.match(
			finish,
			/needs: \[main-gate, main-gate-plan, main_workspace_tests\]/u,
		);
		assert.match(finish, /gitleaks-main-scan\.mts --background/u);
		assert.match(finish, /gitleaks-main-scan\.mts --wait/u);
	});

	it("skips workspace shard jobs when the plan emits no shards", () => {
		const shardStart = workflow.indexOf("  main_workspace_tests:");
		const finishStart = workflow.indexOf("  main_gate_finish:", shardStart);
		const block = workflow.slice(shardStart, finishStart);
		assert.match(block, /needs\.main-gate-plan\.outputs\.shards != '\[\]'/u);
		assert.match(block, /needs\.main-gate-plan\.outputs\.shards != ''/u);
	});
});
