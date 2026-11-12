import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github", "workflows", "hobo-ci.yml"),
	"utf8",
);

describe("main full gate workspace sharding", () => {
	it("checks out what the route script loads, and no longer the capacity module it once read", () => {
		// The route script stopped loading `fleet/capacity.ts` (finding 146);
		// `route-runner.test.ts` checks every routed workflow against what the
		// script loads today.
		const routeStart = workflow.indexOf("  route:");
		const runnerImage = workflow.indexOf("  ci-runner-image:", routeStart);
		assert.ok(routeStart > -1);
		const route = workflow.slice(routeStart, runnerImage);
		assert.match(route, /packages\/ci\/src\/fleet-overflow\.ts/u);
		assert.doesNotMatch(route, /packages\/ci\/src\/fleet\/capacity\.ts/u);
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
		assert.match(plan, /needs: \[route, ci-runner-image\]/u);
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
		assert.match(block, /needs: \[route, ci-runner-image, main-gate-plan\]/u);
		assert.match(block, /--shard="\$SHARD\/\$SHARD_TOTAL"/u);
	});

	it("routes shards like pull request jobs: GitHub-hosted when the fleet is not taking jobs", () => {
		// Run 43271789046: the route job chose ubuntu-24.04 (the fleet had taken
		// up to 1376 s to pick a job up) while every main job still asked for
		// hobo-trunk. A shard is the one main job that needs nothing of the box.
		const shardStart = workflow.indexOf("  main_workspace_tests:");
		const finishStart = workflow.indexOf("  main_gate_finish:", shardStart);
		const block = workflow.slice(shardStart, finishStart);
		const runsOn = /^ {4}runs-on: (.+)$/mu.exec(block)?.[1] ?? "";
		assert.ok(runsOn.startsWith("${{ needs.route.outputs.runner || ("), runsOn);
		assert.ok(runsOn.endsWith("&& 'hobo-trunk' || 'hobo') }}"), runsOn);
		// Off the box there is no deps layer: the shard installs for itself.
		assert.match(block, /steps\.deps-layer\.outputs\.match != 'true'/u);
		assert.match(block, /name: Restore pnpm store/u);
		// The plan and the gate stay on the fleet: they use its Docker context.
		for (const id of ["main-gate-plan", "main-gate"]) {
			const start = workflow.indexOf(`  ${id}:\n`);
			const job = workflow.slice(
				start,
				workflow.indexOf("\n    steps:", start),
			);
			assert.doesNotMatch(job, /needs\.route\.outputs\.runner/u, id);
		}
	});

	it("finishes after the gate, the plan (with its secret scan) and the shards", () => {
		const finishStart = workflow.indexOf("  main_gate_finish:");
		const artifact = workflow.indexOf("  artifact-trust:", finishStart);
		const finish = workflow.slice(finishStart, artifact);
		assert.match(
			finish,
			/needs: \[route, main-gate, main-gate-plan, main_workspace_tests\]/u,
		);
		const planStart = workflow.indexOf("  main-gate-plan:");
		const plan = workflow.slice(
			planStart,
			workflow.indexOf("  main-gate:", planStart),
		);
		assert.match(plan, /gitleaks-main-scan\.mts --background/u);
		assert.match(plan, /gitleaks-main-scan\.mts --wait/u);
	});

	it("skips the gate and plans no shards when the merge queue passed the tree", () => {
		const gateStart = workflow.indexOf("  main-gate:");
		const gate = workflow.slice(
			gateStart,
			workflow.indexOf("  main_workspace_tests:", gateStart),
		);
		assert.match(gate, /needs: \[route, ci-runner-image\]/u);
		assert.match(
			gate,
			/!cancelled\(\) && needs\.route\.outputs\.merge-queue-green != 'true' && \(/u,
		);
		const planStart = workflow.indexOf("  main-gate-plan:");
		const plan = workflow.slice(planStart, gateStart);
		assert.match(
			plan,
			/MAIN_REUSE_MERGE_QUEUE: \$\{\{ needs\.route\.outputs\.merge-queue-green \}\}/u,
		);
		// The plan job itself never skips on reuse: it holds the secret scan.
		assert.doesNotMatch(
			plan.slice(0, plan.indexOf("    steps:")),
			/merge-queue-green/u,
		);
		const route = workflow.slice(
			workflow.indexOf("  route:"),
			workflow.indexOf("  ci-runner-image:"),
		);
		assert.match(route, /scripts\/ci\/merge-queue-reuse\.mts/u);
		assert.match(
			route,
			/reuse-merge-queue: \$\{\{ vars\.HOBO_CI_MAIN_REUSE_MERGE_QUEUE \}\}/u,
		);
	});

	it("skips workspace shard jobs when the plan emits no shards", () => {
		const shardStart = workflow.indexOf("  main_workspace_tests:");
		const finishStart = workflow.indexOf("  main_gate_finish:", shardStart);
		const block = workflow.slice(shardStart, finishStart);
		assert.match(block, /needs\.main-gate-plan\.outputs\.shards != '\[\]'/u);
		assert.match(block, /needs\.main-gate-plan\.outputs\.shards != ''/u);
	});
});
