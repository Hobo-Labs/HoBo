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
		const routeStart = workflow.indexOf("\n  route:\n");
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
		assert.match(plan, /install-toolchain: false/u);
		assert.match(plan, /main-gate-plan-\$\{\{ github\.sha \}\}/u);
		assert.match(main, /resolve-main-test-base\.mts/u);
		assert.match(main, /--external-workspace-tests/u);
		assert.doesNotMatch(main, /name: Workspace tests/u);
		assert.doesNotMatch(main, /Plan main workspace test shards/u);
	});

	it("shards workspace tests across the runners the plan job chose", () => {
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

	it("shards use the plan job's own route", () => {
		// The plan job and the full gate follow the route job; the shards
		// follow the plan job's second ask, then the run's route.
		for (const name of ["main-gate-plan", "main-gate"])
			assert.equal(runsOn(job(name)), ROUTED, name);
		assert.equal(runsOn(job("main_workspace_tests")), SHARD);
		// The finish job only adds up the other jobs' results, so like the two
		// required gates it never asks the fleet for a runner (finding 154).
		assert.equal(runsOn(job("main_gate_finish")), "ubuntu-24.04");
		assert.match(job("main_gate_finish"), /^    permissions: \{\}$/mu);
		assert.doesNotMatch(job("main_gate_finish"), /^\s+(- )?uses: /mu);
		assert.match(
			job("main-gate-plan"),
			/^      shard_runner: \$\{\{ steps\.reroute\.outputs\.runner \|\| needs\.route\.outputs\.runner \}\}$/mu,
		);
		assert.match(job("main-gate"), /^    needs: \[route, ci-runner-image\]$/mu);
	});

	it("the re-ask runs after the full checkout and falls back to the run's route", () => {
		const plan = job("main-gate-plan");
		assert.match(
			plan,
			/^    permissions:\n      actions: read\n      contents: read$/mu,
		);
		const steps = plan.slice(plan.indexOf("    steps:"));
		const full = steps.indexOf("          fetch-depth: 0");
		const reroute = steps.indexOf("        id: reroute");
		assert.ok(
			full > -1 && reroute > full,
			"reroute must follow the full checkout",
		);
		const step = steps.slice(
			steps.lastIndexOf("      - ", reroute),
			steps.indexOf("\n      - ", reroute),
		);
		assert.match(step, /if: needs\.route\.outputs\.tier == 'fleet'/u);
		assert.match(step, /uses: \.\/\.github\/actions\/route-runner/u);
		assert.match(step, /token: \$\{\{ github\.token \}\}/u);
		assert.match(
			step,
			/mode: \$\{\{ inputs\.route \|\| vars\.HOBO_CI_ROUTE \}\}/u,
		);
		for (const input of [
			"local-runner: ${{ vars.HOBO_CI_LOCAL_RUNNER }}",
			"max-wait-seconds: ${{ vars.HOBO_CI_ROUTE_MAX_WAIT_SECONDS }}",
			"max-queued: ${{ vars.HOBO_CI_ROUTE_MAX_QUEUED }}",
			"trunk-runner: ${{ vars.HOBO_CI_TRUNK_RUNNER }}",
			'attest: "false"',
			'include-own-run: "true"',
		])
			assert.ok(step.includes(input), input);
		// A second ask that cannot decide outputs no runner (the action's
		// fallback, route-runner.test.ts), so the run's route stands; a skipped
		// or failed plan job leaves the shards on the trunk expression.
		assert.ok(
			SHARD.includes(
				"needs.main-gate-plan.outputs.shard_runner || needs.route.outputs.runner || (",
			),
		);
	});

	it("keeps the deps image off a main run the route sent away from the fleet", () => {
		// On main there is no deps image job to wait on the fleet for (finding
		// 154): the plan job looks at the layer, and only on the box worker, so a
		// run the route sent to GitHub-hosted or a local box does nothing here.
		const deps = job("ci-deps-image");
		assert.match(deps, /^    needs: \[route\]$/mu);
		assert.match(
			deps,
			/^    if: \$\{\{ !cancelled\(\) && github\.event_name == 'pull_request' \}\}$/mu,
		);
		const plan = job("main-gate-plan");
		const check = plan.slice(
			plan.indexOf("      - name: Check current local deps image"),
			plan.indexOf("      - name: Login to GHCR for read-only cache"),
		);
		assert.match(check, /"\$\{HOBO_CI_PNPM_STORE_MOUNTED:-\}" != "1"/u);
		assert.match(check, /echo "current=true" >> "\$GITHUB_OUTPUT"/u);
		for (const name of [
			"Login to GHCR for read-only cache",
			"Resolve local or GHCR deps image",
			"Verify deps image under job mount",
			"Promote verified deps image",
		]) {
			const step = plan.slice(plan.indexOf(`      - name: ${name}`));
			assert.match(
				step.slice(0, step.indexOf("\n      - name:", 1)),
				/if: steps\.deps-current\.outputs\.current != 'true'/u,
				name,
			);
		}
		// No shard waits on a deps job.
		assert.doesNotMatch(job("main_workspace_tests"), /ci-deps-image/u);
	});

	it("can be pinned from a dispatch without touching repository variables", () => {
		assert.match(
			workflow,
			/^  workflow_dispatch:\n    inputs:\n      route:\n/mu,
		);
		assert.match(
			job("route"),
			/mode: \$\{\{ inputs\.route \|\| vars\.HOBO_CI_ROUTE \}\}/u,
		);
	});
});

const TRUNK =
	"(vars.HOBO_CI_TRUNK_RUNNER != 'false' && contains(fromJSON('[\"push\",\"workflow_dispatch\",\"merge_group\",\"workflow_run\"]'), github.event_name) && 'hobo-trunk' || 'hobo')";
const ROUTED = `\${{ needs.route.outputs.runner || ${TRUNK} }}`;
const SHARD = `\${{ needs.main-gate-plan.outputs.shard_runner || needs.route.outputs.runner || ${TRUNK} }}`;

/** One job's block of the workflow, up to the next job. */
function job(name: string): string {
	const lines = workflow.split("\n");
	const start = lines.indexOf(`  ${name}:`);
	assert.ok(start > -1, name);
	const next = lines.findIndex(
		(line, index) => index > start && /^  [A-Za-z0-9_-]+:$/u.test(line),
	);
	return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

function runsOn(block: string): string | undefined {
	return /^    runs-on: (.*)$/mu.exec(block)?.[1];
}
