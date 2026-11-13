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
		assert.match(
			block,
			/needs: \[route, ci-runner-image, ci-deps-image, main-gate-plan\]/u,
		);
		assert.match(block, /--shard="\$SHARD\/\$SHARD_TOTAL"/u);
	});

	it("finishes with gitleaks after workspace shards", () => {
		const finishStart = workflow.indexOf("  main_gate_finish:");
		const artifact = workflow.indexOf("  artifact-trust:", finishStart);
		const finish = workflow.slice(finishStart, artifact);
		assert.match(
			finish,
			/needs: \[route, main-gate, main-gate-plan, main_workspace_tests\]/u,
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

	it("shards use the plan job's own route", () => {
		// The plan job and the full gate follow the route job; the shards and
		// the finish job follow the plan job's second ask, then the run's route.
		for (const name of ["main-gate-plan", "main-gate"])
			assert.equal(runsOn(job(name)), ROUTED, name);
		for (const name of ["main_workspace_tests", "main_gate_finish"])
			assert.equal(runsOn(job(name)), SHARD, name);
		assert.match(
			job("main-gate-plan"),
			/^      shard_runner: \$\{\{ steps\.reroute\.outputs\.shard_runner \|\| needs\.route\.outputs\.shard_runner \}\}$/mu,
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
		for (const input of [
			"route: ${{ inputs.route || 'auto' }}",
			'attest: "false"',
			'include-own-run: "true"',
		])
			assert.ok(step.includes(input), input);
		// Routing settings are committed policy and the routing slip, never inputs.
		assert.doesNotMatch(
			step,
			/vars\.|local-runner|trunk-runner|max-wait|max-queued/u,
		);
		// A second ask that cannot decide outputs no runner (the action's
		// fallback, route-runner.test.ts), so the run's route stands; a skipped
		// or failed plan job leaves the shards on the run's route, then GitHub-hosted.
		assert.ok(
			SHARD.includes(
				"needs.main-gate-plan.outputs.shard_runner || needs.route.outputs.shard_runner || 'ubuntu-24.04'",
			),
		);
	});

	it("keeps the deps image off a main run the route sent away from the fleet", () => {
		const deps = job("ci-deps-image");
		assert.match(deps, /^    needs: \[route\]$/mu);
		const condition = deps.slice(
			deps.indexOf("    if:"),
			deps.indexOf("    runs-on:"),
		);
		assert.match(condition, /github\.event_name == 'pull_request' \|\|/u);
		assert.match(
			condition,
			/\(needs\.route\.outputs\.tier == 'fleet' \|\| needs\.route\.result != 'success'\)/u,
		);
		// A skipped deps job does not stop the shards.
		assert.doesNotMatch(
			job("main_workspace_tests"),
			/needs\.ci-deps-image\.result/u,
		);
	});

	it("can be pinned from a dispatch, which reaches the route script as an argument", () => {
		assert.match(
			workflow,
			/^  workflow_dispatch:\n    inputs:\n      route:\n/mu,
		);
		assert.match(job("route"), /route: \$\{\{ inputs\.route \|\| 'auto' \}\}/u);
		assert.doesNotMatch(workflow, /vars\.HOBO_CI_/u);
	});
});

const ROUTED = "${{ needs.route.outputs.runner || 'ubuntu-24.04' }}";
const SHARD =
	"${{ needs.main-gate-plan.outputs.shard_runner || needs.route.outputs.shard_runner || 'ubuntu-24.04' }}";

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
