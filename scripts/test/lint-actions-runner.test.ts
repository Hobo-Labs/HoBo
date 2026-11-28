import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_LOCATION_VARIABLES } from "../ci/local-attest.mts";
import {
	COMPOSITE_STEP_UNSUPPORTED_KEYS,
	lintCompositeStepFields,
} from "../lint-actions.ts";
import { testRunner } from "./support/test-runner.ts";

const { describe, it } = await testRunner();

const ci = (...parts: string[]): string => ["HOBO", "CI", ...parts].join("_");

// Git sets GIT_DIR, GIT_INDEX_FILE and the like for the hooks it runs. These
// tests run from pre-commit too, and every git command they start (their own
// or a script's) must act on its own repository, never the one being committed.
for (const name of GIT_LOCATION_VARIABLES) delete process.env[name];

const lint = fileURLToPath(new URL("../lint-actions.ts", import.meta.url));
const trunk =
	'${{ contains(fromJSON(\'["push","workflow_dispatch","merge_group","workflow_run"]\'), github.event_name) && \'hobo-trunk\' || \'hobo\' }}';

const routed =
	"${{ needs.route.result == 'success' && (needs.route.outputs.runner || 'ubuntu-24.04') || 'ubuntu-24.04' }}";
const depsRunner =
	"${{ (needs.route.outputs.tier == 'fleet' && (needs.route.outputs.box_runner || needs.route.outputs.runner)) || (needs.route.outputs.tier == 'github' && needs.route.outputs.runner) || 'ubuntu-24.04' }}";

function lintJobs(jobs: string): number | null {
	const root = mkdtempSync(join(tmpdir(), "hobo-actions-lint-"));
	try {
		const dir = join(root, ".github", "workflows");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "pricing-ci.yml"),
			`name: fixture\non:\n  push:\njobs:\n${jobs}  trunk:\n    runs-on: ${trunk}\n    steps:\n      - run: echo ok\n`,
		);
		return spawnSync(process.execPath, ["--experimental-strip-types", lint], {
			cwd: root,
			encoding: "utf8",
		}).status;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** What the main gate's shards ask for: the plan job's second ask, then the run's route. */
const shardRunner =
	"${{ needs.main-gate-plan.outputs.shard_runner || needs.route.outputs.shard_runner || 'ubuntu-24.04' }}";
const mergeShardRunner =
	"${{ needs.pr_gate_plan.outputs.shard_runner || needs.route.outputs.runner || 'ubuntu-24.04' }}";

/** Lints a repository holding one composite action and no workflow. */
function lintAction(text: string): number | null {
	const root = mkdtempSync(join(tmpdir(), "hobo-actions-lint-"));
	try {
		const dir = join(root, ".github", "actions", "fixture");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "action.yml"), text);
		return spawnSync(process.execPath, ["--experimental-strip-types", lint], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY: "1" },
		}).status;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function lintFile(file: string, text: string): number | null {
	const root = mkdtempSync(join(tmpdir(), "hobo-actions-lint-"));
	try {
		const dir = join(root, ".github", "workflows");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, file), text);
		return spawnSync(process.execPath, ["--experimental-strip-types", lint], {
			cwd: root,
			encoding: "utf8",
		}).status;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const pullRequestOn =
	"on:\n  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]\n";
const routeJob =
	"  route:\n    if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          persist-credentials: false\n      - id: route\n        uses: ./.github/actions/route-runner\n";

function lintRunner(
	file: string,
	jobId: string,
	runner: string,
): number | null {
	const root = mkdtempSync(join(tmpdir(), "hobo-actions-lint-"));
	try {
		const dir = join(root, ".github", "workflows");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, file),
			`name: fixture\non:\n  push:\njobs:\n  ${jobId}:\n    runs-on: ${runner}\n    steps:\n      - run: echo ok\n  trunk:\n    runs-on: ${trunk}\n    steps:\n      - run: echo ok\n`,
		);
		return spawnSync(process.execPath, ["--experimental-strip-types", lint], {
			cwd: root,
			encoding: "utf8",
		}).status;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("Actions runner policy", () => {
	it("rejects a shard route selected by the proposed change", () => {
		const workflow = (jobId: string, needs: string) =>
			`name: fixture\non:\n  merge_group:\njobs:\n${routeJob}  ${jobId}:\n    needs: ${needs}\n    runs-on: ${mergeShardRunner}\n    steps:\n      - run: echo ok\n  trunk:\n    runs-on: ${trunk}\n    steps:\n      - run: echo ok\n`;
		assert.notEqual(
			lintFile(
				"hobo-ci.yml",
				workflow("workspace_tests", "[route, pr_gate_validation]"),
			),
			0,
		);
	});
	it("allows the deps-image fallback only for PR validation without promotion", () => {
		const deps =
			"bash packages/ci-gh-actions/deploy/ci-runner/deps/build-deps.sh --no-promote";
		const job = (
			name: string,
			runner: string,
			run: string,
			needs = "    needs: route\n",
			condition = "    if: ${{ !cancelled() && needs.route.result == 'success' && github.event_name == 'pull_request' }}\n",
		) =>
			`name: fixture\n${pullRequestOn}jobs:\n${routeJob}  ${name}:\n${needs}${condition}    runs-on: ${runner}\n    steps:\n      - name: Build\n        run: ${run}\n`;
		assert.equal(
			lintFile("hobo-ci.yml", job("ci-deps-image", depsRunner, deps)),
			0,
		);
		assert.notEqual(lintFile("hobo-ci.yml", job("other", depsRunner, deps)), 0);
		assert.notEqual(
			lintFile("hobo-ci.yml", job("ci-deps-image", depsRunner, deps, "")),
			0,
		);
		assert.notEqual(
			lintFile(
				"hobo-ci.yml",
				job("ci-deps-image", depsRunner, deps, undefined, ""),
			),
			0,
		);
		assert.notEqual(
			lintFile(
				"hobo-ci.yml",
				job(
					"ci-deps-image",
					depsRunner,
					deps,
					undefined,
					"    if: ${{ !cancelled() && github.event_name == 'pull_request' }}\n",
				),
			),
			0,
		);
		assert.notEqual(
			lintFile(
				"hobo-ci.yml",
				job("ci-deps-image", depsRunner, deps.replace(" --no-promote", "")),
			),
			0,
		);
		assert.notEqual(
			lintFile("hobo-ci.yml", job("ci-deps-image", routed, deps)),
			0,
		);
	});
	it("allows the pricing publisher on the npm-required hosted runner", () => {
		assert.equal(
			lintRunner(
				"release-pricing.yml",
				"pricing-release-publish",
				"ubuntu-24.04",
			),
			0,
		);
		assert.notEqual(
			lintRunner(
				"release-pricing.yml",
				"pricing-release-build",
				"ubuntu-24.04",
			),
			0,
		);
	});

	it("allows the one GitHub-hosted runner needed for npm trusted publishing", () => {
		assert.equal(
			lintRunner("release-hobo.yml", "release-npm", "ubuntu-24.04"),
			0,
		);
		// The job that builds the hobo CLI release-npm runs with its OIDC token.
		assert.equal(
			lintRunner("release-hobo.yml", "release-hobo-cli", "ubuntu-24.04"),
			0,
		);
	});

	it("allows exactly the hosted release-integration shard jobs", () => {
		for (const [file, id] of [
			["release-hobo-pr.yml", "release-integration"],
			["release-hobo.yml", "release-hobo-integration"],
			["hobo-ci.yml", "release-hobo-integration"],
		] as const)
			assert.equal(lintRunner(file, id, "ubuntu-24.04"), 0, `${file}:${id}`);
		assert.notEqual(
			lintRunner("release-hobo-pr.yml", "other", "ubuntu-24.04"),
			0,
		);
	});

	it("rejects the same runner on another job or workflow and other hosted images", () => {
		assert.notEqual(lintRunner("release-hobo.yml", "other", "ubuntu-24.04"), 0);
		assert.notEqual(
			lintRunner("pricing-ci.yml", "release-npm", "ubuntu-24.04"),
			0,
		);
		assert.notEqual(
			lintRunner("release-hobo.yml", "release-npm", "ubuntu-22.04"),
			0,
		);
	});

	it("allows the routed label on a job that needs the route job", () => {
		for (const needs of ["route", "[route, other]", "[other, route]"])
			assert.equal(
				lintJobs(
					`${routeJob}  build:\n    needs: ${needs}\n    runs-on: ${routed}\n    steps:\n      - run: echo ok\n`,
				),
				0,
				needs,
			);
	});

	it("allows the shard runner on a job that needs the route and plan jobs", () => {
		for (const needs of [
			"[route, main-gate-plan]",
			"[other, main-gate-plan, route]",
		])
			assert.equal(
				lintJobs(
					`${routeJob}  main-gate-plan:\n    needs: route\n    runs-on: ${routed}\n    steps:\n      - run: echo ok\n  shard:\n    needs: ${needs}\n    runs-on: ${shardRunner}\n    steps:\n      - run: echo ok\n`,
				),
				0,
				needs,
			);
	});

	it("rejects the shard runner on a job that does not need both the route and plan jobs", () => {
		for (const needs of ["route", "main-gate-plan", "[other]"])
			assert.notEqual(
				lintJobs(
					`${routeJob}  shard:\n    needs: ${needs}\n    runs-on: ${shardRunner}\n    steps:\n      - run: echo ok\n`,
				),
				0,
				needs,
			);
	});

	it("rejects fleet state passed to a workflow", () => {
		const job = (body: string) =>
			lintJobs(`  build:\n    runs-on: ${trunk}\n${body}`);
		assert.equal(job("    steps:\n      - run: echo ok\n"), 0);
		// A repository variable read anywhere in the workflow.
		assert.notEqual(
			job(
				`    steps:\n      - run: echo \${{ vars.${ci("FLEET", "ROUTES")} }}\n`,
			),
			0,
		);
		// An environment variable by that name, whatever its value.
		assert.notEqual(
			job(
				`    env:\n      ${ci("FLEET", "ROUTES")}: "1"\n    steps:\n      - run: echo ok\n`,
			),
			0,
		);
		// An action input by that name.
		const uses = (input: string) =>
			job(
				`    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          clean: false\n      - uses: ./.github/actions/route-runner\n        with:\n          ${input}: hobo\n`,
			);
		assert.equal(uses("route"), 0);
		assert.notEqual(uses("fleet-routes"), 0);
		// The inputs that carried the retired routing variables (ADR-0181).
		for (const input of [
			"local-runner",
			"trunk-runner",
			"max-wait-seconds",
			"max-queued",
			"reuse-merge-queue",
		])
			assert.notEqual(uses(input), 0, input);
		assert.notEqual(
			lintAction(
				"name: fixture\ninputs:\n  fleet-routes:\n    required: false\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo ok\n",
			),
			0,
		);
		assert.equal(
			lintAction(
				"name: fixture\ninputs:\n  mode:\n    required: false\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo ok\n",
			),
			0,
		);
	});

	it("rejects every routing variable and routing name ADR-0181 retires", () => {
		const job = (body: string) =>
			lintJobs(`  build:\n    runs-on: ${trunk}\n${body}`);
		// Any repository variable under HOBO_CI_, routing or not.
		for (const name of [
			"HOBO_CI_TRUNK_RUNNER",
			"HOBO_CI_ROUTE",
			ci("LOCAL", "RUNNER"),
			"HOBO_CI_BOX_RUNNER",
			"HOBO_CI_MAIN_REUSE_MERGE_QUEUE",
			"HOBO_CI_TURBO_API",
			"HOBO_CI_ANYTHING",
		])
			assert.notEqual(
				job(`    steps:\n      - run: echo \${{ vars.${name} }}\n`),
				0,
				name,
			);
		// The trunk expression with the retired kill switch.
		assert.notEqual(
			lintRunner(
				"pricing-ci.yml",
				"build",
				"${{ vars.HOBO_CI_TRUNK_RUNNER != 'false' && 'hobo-trunk' || 'hobo' }}",
			),
			0,
		);
		// Every name on ADR-0181's routing list, as an environment variable.
		for (const name of [
			"HOBO_CI_ROUTE",
			"HOBO_CI_ROUTE_MAX_WAIT_SECONDS",
			"HOBO_CI_ROUTE_MAX_QUEUED",
			"HOBO_CI_TRUNK_RUNNER",
			ci("LOCAL", "RUNNER"),
			"HOBO_CI_INCLUDE_OWN_RUN",
			"HOBO_CI_ATTESTED",
			"HOBO_CI_FLEET_VERDICT_MODE",
			"HOBO_CI_FLEET_REPORTER_ID",
			"HOBO_CI_FLEET_EXTERNAL_POOLS_JSON",
			"HOBO_CI_FLEET_REPORTERS_JSON",
			ci("FLEET", "CAPACITY", "VOLATILITY", "MB"),
			"HOBO_CI_TRUNK_HEADROOM_FLEET_DEFER_MS",
			"HOBO_CI_WORKER_SLOTS",
			"HOBO_CI_WORKER_TRUNK_SLOTS",
			"HOBO_CI_WORKER_TRUNK_LEND",
			"HOBO_CI_WORKER_PR_CAP_WITH_TRUNK",
			"HOBO_CI_WORKER_MERGE_GROUP_LEASES",
			"HOBO_CI_JOB_ADMISSION",
			"MAIN_WORKSPACE_PARALLEL_CAP",
			"HOBO_CI_BOX_RUNNER",
			"HOBO_CI_MAIN_REUSE_MERGE_QUEUE",
		])
			assert.notEqual(
				job(`    env:\n      ${name}: "1"\n    steps:\n      - run: echo ok\n`),
				0,
				name,
			);
		// Names that only share a prefix are not routing.
		for (const name of ["HOBO_CI_WORKER_IMAGE", "HOBO_CI_DEPS_LAYER"])
			assert.equal(
				job(`    env:\n      ${name}: "1"\n    steps:\n      - run: echo ok\n`),
				0,
				name,
			);
		assert.notEqual(
			lintAction(
				"name: fixture\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      env:\n        HOBO_CI_ROUTE: ${{ inputs.mode }}\n      run: echo ok\n",
			),
			0,
		);
	});

	it("rejects a routing variable in an installable template, but not onboarding's relay placeholder", () => {
		const lintTemplate = (text: string) => {
			const root = mkdtempSync(join(tmpdir(), "hobo-actions-lint-"));
			try {
				const dir = join(root, "packages", "ci-gh-actions", "templates");
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "fixture.yml"), text);
				return spawnSync(
					process.execPath,
					["--experimental-strip-types", lint],
					{ cwd: root, encoding: "utf8" },
				).status;
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		};
		assert.equal(
			lintTemplate(
				"env:\n  HOBO_CI_RELAY_URL: ${{ vars.HOBO_CI_RELAY_URL }}\n",
			),
			0,
		);
		assert.notEqual(
			lintTemplate(
				`jobs:\n  smoke:\n    runs-on: \${{ vars.HOBO_CI_TRUNK_RUNNER }}\n`,
			),
			0,
		);
	});

	it("rejects the routed label on a job that does not need the route job", () => {
		for (const needs of ["", "    needs: reroute\n", "    needs: [other]\n"])
			assert.notEqual(
				lintJobs(
					`${routeJob}  build:\n${needs}    runs-on: ${routed}\n    steps:\n      - run: echo ok\n`,
				),
				0,
				needs,
			);
	});

	it("keeps the route job and gates that run no action GitHub-hosted, and nothing else", () => {
		assert.equal(lintJobs(routeJob), 0);
		const mergeGroupTrunk =
			"${{ github.event_name == 'merge_group' && 'hobo-trunk' || 'ubuntu-24.04' }}";
		const trunkRoute = routeJob
			.replace("runs-on: ubuntu-24.04", `runs-on: ${mergeGroupTrunk}`)
			.replace(
				"persist-credentials: false\n",
				"persist-credentials: false\n          clean: false\n",
			);
		const trunkGate = (id: string) =>
			`  ${id}:\n    if: \${{ always() }}\n    runs-on: ${mergeGroupTrunk}\n    steps:\n      - run: echo ok\n`;
		const hoboCi = (jobs: string) =>
			lintFile(
				"hobo-ci.yml",
				`name: fixture\non:\n  merge_group:\njobs:\n${jobs}  trunk:\n    runs-on: ${trunk}\n    steps:\n      - run: echo ok\n`,
			);
		assert.equal(hoboCi(`${trunkRoute}${trunkGate("pr-gate")}`), 0);
		assert.notEqual(
			hoboCi(
				routeJob.replace(
					"runs-on: ubuntu-24.04",
					`runs-on: ${mergeGroupTrunk}`,
				),
			),
			0,
			"a route job on the trunk fleet must keep its default-path checkout",
		);
		assert.notEqual(hoboCi(`${trunkRoute}${trunkGate("gate")}`), 0);
		assert.notEqual(lintJobs(trunkRoute), 0);
		assert.notEqual(lintJobs(trunkGate("pr-gate")), 0);
		assert.notEqual(
			hoboCi(
				`  build:\n    runs-on: ${mergeGroupTrunk}\n    steps:\n      - run: echo ok\n`,
			),
			0,
		);
		const mergeGroupScripts =
			"${{ github.event_name == 'merge_group' && 'agent37' || (needs.route.result == 'success' && (needs.route.outputs.runner || 'ubuntu-24.04') || 'ubuntu-24.04') }}";
		const scriptsJob = (id: string, needs: string) =>
			`  ${id}:\n${needs}    runs-on: ${mergeGroupScripts}\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          clean: false\n`;
		assert.equal(
			hoboCi(
				`${routeJob}${scriptsJob("scripts-tests", "    needs: [route]\n")}`,
			),
			0,
		);
		assert.notEqual(hoboCi(`${routeJob}${scriptsJob("scripts-tests", "")}`), 0);
		assert.notEqual(
			hoboCi(
				`${routeJob}${scriptsJob("workspace_tests", "    needs: [route]\n")}`,
			),
			0,
		);
		assert.notEqual(
			lintJobs(
				`${routeJob}${scriptsJob("scripts-tests", "    needs: [route]\n")}`,
			),
			0,
		);
		assert.equal(
			lintJobs(
				"  gate:\n    if: ${{ always() }}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n",
			),
			0,
		);
		// A hosted job that is not a gate, a route job that does not route, and
		// a hosted gate that runs an action.
		assert.notEqual(
			lintJobs(
				"  gate:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n",
			),
			0,
		);
		assert.notEqual(
			lintJobs(
				"  route:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n",
			),
			0,
		);
		assert.notEqual(
			lintJobs(
				"  build:\n    if: ${{ always() }}\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n",
			),
			0,
		);
		assert.notEqual(
			lintJobs(
				"  gate:\n    if: ${{ always() }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
			),
			0,
		);
	});
	it("passes on this repository's own workflows", () => {
		// Offline: whether a pinned action commit exists is `pnpm run actions:lint`'s
		// question; the shape of the workflows is this one's.
		const run = spawnSync(
			process.execPath,
			["--experimental-strip-types", lint],
			{
				cwd: fileURLToPath(new URL("../..", import.meta.url)),
				encoding: "utf8",
				env: { ...process.env, HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY: "1" },
			},
		);
		assert.equal(run.status, 0, run.stderr);
	});

	const skipFor = (id: string) =>
		`!(needs.route.result == 'success' && needs.route.outputs.attested == 'true' && contains(needs.route.outputs.attested-jobs, '"${id}"'))`;
	const attestingRoute = (sparse: string) =>
		`  route:\n    if: \${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}\n    runs-on: ubuntu-24.04\n    outputs:\n      runner: \${{ steps.route.outputs.runner }}\n      attested: \${{ steps.route.outputs.attested }}\n      attested-jobs: \${{ steps.route.outputs.attested-jobs }}\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          persist-credentials: false\n          sparse-checkout: |\n            .github/actions/route-runner\n${sparse}      - id: route\n        uses: ./.github/actions/route-runner\n`;
	const verifierFiles =
		"            scripts/ci/attestation.mts\n            scripts/ci/verify-attestation.mts\n";
	const skippable = (id: string, condition: string, needs = "route") =>
		`  ${id}:\n    needs: ${needs}\n    if: \${{ github.event_name == 'pull_request' && ${condition} }}\n    runs-on: ${routed}\n    steps:\n      - run: echo ok\n`;

	it("lets a signed local run skip a covered job that names itself and needs the route job", () => {
		for (const id of [
			"ci-guard",
			"secret-scan",
			"pr_gate_plan",
			"pr_gate_validation",
		])
			assert.equal(
				lintJobs(
					`${attestingRoute(verifierFiles)}${skippable(id, skipFor(id))}`,
				),
				0,
				id,
			);
	});

	it("rejects skipping a job that is not covered, or by another job's id, or by a looser condition", () => {
		// The image build and the gates are never covered.
		for (const id of [
			"ci-runner-image",
			"ci-deps-image",
			"dev-cold-loop-gate",
			"build",
		])
			assert.notEqual(
				lintJobs(
					`${attestingRoute(verifierFiles)}${skippable(id, skipFor(id))}`,
				),
				0,
				id,
			);
		for (const condition of [
			"!(needs.route.outputs.attested == 'true' && contains(needs.route.outputs.attested-jobs, '\"ci-guard\"'))",
			skipFor("secret-scan"),
			`${skipFor("ci-guard")} && ${skipFor("secret-scan")}`,
			"needs.route.outputs.attested != 'true'",
			"!contains(needs.route.outputs.attested-jobs, 'ci-guard')",
			`(${skipFor("ci-guard")} || needs.route.outputs.attested == 'true')`,
		])
			assert.notEqual(
				lintJobs(
					`${attestingRoute(verifierFiles)}${skippable("ci-guard", condition)}`,
				),
				0,
				condition,
			);
	});

	it("rejects a route job that reports an attestation without checking the verifier out", () => {
		assert.equal(lintJobs(attestingRoute(verifierFiles)), 0);
		assert.notEqual(lintJobs(attestingRoute("")), 0);
		assert.notEqual(
			lintJobs(attestingRoute("            scripts/ci/attestation.mts\n")),
			0,
		);
	});

	it("makes a gate that waits on a covered job decide with the shared helper, unchanged", () => {
		const helper = [
			"attested() {",
			'  [ "${ROUTE_RESULT:-}" = "success" ] || return 1',
			'  [ "${ATTESTED:-}" = "true" ] || return 1',
			'  case "${ATTESTED_JOBS:-}" in',
			'    *"\\"$1\\""*) return 0 ;;',
			"  esac",
			"  return 1",
			"}",
		];
		const environment = [
			"ROUTE_RESULT: ${{ needs.route.result }}",
			"ATTESTED: ${{ needs.route.outputs.attested }}",
			"ATTESTED_JOBS: ${{ needs.route.outputs.attested-jobs }}",
		];
		const gate = (
			needs: string,
			env: readonly string[] = environment,
			script: readonly string[] = helper,
		) =>
			`${attestingRoute(verifierFiles)}  release-pr-gate:\n    needs: ${needs}\n    if: \${{ always() }}\n    runs-on: ubuntu-24.04\n    steps:\n      - env:\n${env.map((entry) => `          ${entry}\n`).join("")}        run: |\n${script.map((entry) => `          ${entry}\n`).join("")}          attested release-contract\n`;
		assert.equal(lintJobs(gate("[route, release-contract]")), 0);
		// Each line of the environment and of the helper is needed, as written.
		for (const index of environment.keys())
			assert.notEqual(
				lintJobs(
					gate(
						"[route, release-contract]",
						environment.filter((_entry, at) => at !== index),
					),
				),
				0,
				environment[index],
			);
		for (const index of helper.keys())
			assert.notEqual(
				lintJobs(
					gate(
						"[route, release-contract]",
						environment,
						helper.filter((_entry, at) => at !== index),
					),
				),
				0,
				helper[index],
			);
		// A helper that does not ask whether the route job succeeded.
		assert.notEqual(
			lintJobs(
				gate(
					"[route, release-contract]",
					environment,
					helper.map((entry) => entry.replace('"success"', '"skipped"')),
				),
			),
			0,
		);
		// Reading the attestation without needing the route job.
		assert.notEqual(lintJobs(gate("[release-contract]")), 0);
		// A gate that waits on a covered job and does not read the attestation
		// at all would take, or refuse, a skipped job on its own rule.
		const blind = `${attestingRoute(verifierFiles)}  release-pr-gate:\n    needs: [route, release-contract]\n    if: \${{ always() }}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n`;
		assert.notEqual(lintJobs(blind), 0);
		// A gate that waits on no covered job has nothing to decide.
		assert.equal(
			lintJobs(blind.replace("[route, release-contract]", "[route]")),
			0,
		);
	});

	const probe = (job: string, head = "permissions: {}\n") =>
		lintFile(
			"fleet-probe.yml",
			`name: fixture\non:\n  workflow_dispatch:\n${head}jobs:\n  probe:\n${job}`,
		);

	it("lets the probe ask for each self-hosted label by name, and do nothing", () => {
		for (const label of ["hobo", "hobo-trunk", "hobo-local-host"])
			assert.equal(
				probe(`    runs-on: ${label}\n    steps:\n      - run: "true"\n`),
				0,
				label,
			);
	});

	/** The probe workflow as committed: its gate job and the local box's gated probe. */
	const committedProbe = readFileSync(
		fileURLToPath(
			new URL("../../.github/workflows/fleet-probe.yml", import.meta.url),
		),
		"utf8",
	);

	it("lets the probe gate the local box on committed policy, read with the route job's reader", () => {
		assert.equal(lintFile("fleet-probe.yml", committedProbe), 0);
		// The gate job pinned line for line: anything else it runs is refused.
		assert.notEqual(
			lintFile(
				"fleet-probe.yml",
				committedProbe.replace(
					"--get localRunner)",
					"--get localRunner; curl https://example.test)",
				),
			),
			0,
		);
		// The local box's probe runs only on the gate's answer.
		assert.notEqual(
			lintFile(
				"fleet-probe.yml",
				committedProbe.replace(
					"    if: needs.local-box-enrolled.outputs.enrolled == 'true'\n",
					"",
				),
			),
			0,
		);
	});

	it("rejects probes that can run for draft PR events or read an untrusted checkout", () => {
		const guard =
			"    if: (github.event_name == 'pull_request_target' && github.event.pull_request.draft == false) || (github.event_name == 'workflow_run' && github.event.workflow_run.event != 'pull_request') || github.event_name == 'workflow_dispatch'\n";
		assert.notEqual(
			lintFile("fleet-probe.yml", committedProbe.replace(guard, "")),
			0,
		);
		assert.notEqual(
			lintFile(
				"fleet-probe.yml",
				committedProbe.replace(
					"github.event.workflow_run.event != 'pull_request'",
					"true",
				),
			),
			0,
		);
		assert.notEqual(
			lintFile(
				"fleet-probe.yml",
				committedProbe.replace(
					"          ref: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.base.sha || github.sha }}\n",
					"",
				),
			),
			0,
		);
	});

	it("rejects a probe that asks for another runner, runs something, or holds permissions", () => {
		assert.notEqual(
			probe('    runs-on: ubuntu-24.04\n    steps:\n      - run: "true"\n'),
			0,
		);
		assert.notEqual(
			probe("    runs-on: hobo\n    steps:\n      - run: echo ok\n"),
			0,
		);
		assert.notEqual(
			probe(
				"    runs-on: hobo\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n",
			),
			0,
		);
		assert.notEqual(
			probe('    runs-on: hobo\n    steps:\n      - run: "true"\n', ""),
			0,
		);
	});

	const healthJob = (job: string, run = "node scripts/ci/ci-health.mts") =>
		lintFile(
			"ci-health.yml",
			`name: fixture\non:\n  workflow_dispatch:\npermissions:\n  actions: read\njobs:\n${job}    runs-on: ubuntu-24.04\n    steps:\n      - run: ${run}\n`,
		);

	it("lets the health monitor run one GitHub-hosted ci-health job that runs the monitor", () => {
		assert.equal(healthJob("  ci-health:\n"), 0);
	});

	it("rejects a health monitor job by another name, on another runner, or running something else", () => {
		assert.notEqual(healthJob("  monitor:\n"), 0);
		assert.notEqual(healthJob("  ci-health:\n", "pnpm install"), 0);
		assert.notEqual(
			lintFile(
				"ci-health.yml",
				"name: fixture\non:\n  workflow_dispatch:\njobs:\n  ci-health:\n    runs-on: hobo\n    steps:\n      - run: node scripts/ci/ci-health.mts\n",
			),
			0,
		);
	});

	it("keeps label-by-name out of every other workflow", () => {
		assert.notEqual(
			lintRunner("pricing-ci.yml", "probe", "hobo-local-host"),
			0,
		);
	});

	it("rejects unsupported keys on composite action steps", () => {
		assert.deepEqual(
			[...COMPOSITE_STEP_UNSUPPORTED_KEYS],
			[
				"timeout-minutes",
				"runs-on",
				"needs",
				"strategy",
				"concurrency",
				"services",
				"container",
				"permissions",
				"outputs",
			],
		);
		const composite = (steps: string) =>
			`name: fixture\nruns:\n  using: composite\n  steps:\n${steps}`;
		const step = (body: string) =>
			composite(`    - shell: bash\n${body}      run: echo ok\n`);
		const errorsFor = (text: string) => {
			const errors: string[] = [];
			lintCompositeStepFields(errors, "actions/fixture/action.yml", text);
			return errors;
		};
		const allowed = errorsFor(
			[
				"name: fixture",
				"outputs:",
				"  result:",
				"    description: step result",
				"    value: ${{ steps.main.outputs.value }}",
				"runs:",
				"  using: composite",
				"  steps:",
				"    - id: main",
				"      if: steps.deps.outputs.match != 'true'",
				"      shell: bash",
				"      working-directory: scripts",
				"      continue-on-error: true",
				"      env:",
				"        FOO: bar",
				"      run: echo ok",
				"    - uses: ./local",
				"      with:",
				"        timeout-minutes: '1'",
				"",
			].join("\n"),
		);
		assert.deepEqual(allowed, []);
		assert.deepEqual(
			errorsFor(
				"name: fixture\nruns:\n  using: node20\n  main: index.js\n  steps:\n    - timeout-minutes: 8\n      run: echo ok\n",
			),
			[],
		);
		for (const key of COMPOSITE_STEP_UNSUPPORTED_KEYS) {
			const errors = errorsFor(step(`      ${key}: 1\n`));
			assert.equal(errors.length, 1, key);
			assert.match(
				errors[0] ?? "",
				new RegExp(
					`^actions/fixture/action\\.yml:[0-9]+: composite step 1 must not set ${key}`,
				),
				key,
			);
			assert.notEqual(lintAction(step(`      ${key}: 1\n`)), 0, key);
		}
		const later = errorsFor(
			composite(
				"    - shell: bash\n      run: echo ok\n    - shell: bash\n      runs-on: hobo\n      run: echo no\n",
			),
		);
		assert.equal(later.length, 1);
		assert.match(later[0] ?? "", /composite step 2 must not set runs-on/);
		assert.equal(
			lintAction(
				step("      env:\n        FOO: bar\n      continue-on-error: true\n"),
			),
			0,
		);
	});

	it("exits 0 when deps materialize outputs are missing after a non-zero status", () => {
		const action = readFileSync(
			fileURLToPath(
				new URL(
					"../../.github/actions/ci-deps-recovery/action.yml",
					import.meta.url,
				),
			),
			"utf8",
		);
		assert.equal(action.includes("timeout-minutes:"), false);
		const command =
			"timeout 480 node --experimental-strip-types --no-warnings scripts/ci/materialize-ghcr-deps-layer.mts";
		const commandAt = action.indexOf(command);
		const header = "      run: |\n";
		const runAt = action.lastIndexOf(header, commandAt);
		const nextStep = action.indexOf("\n    - name:", commandAt);
		assert.ok(commandAt > 0 && runAt > 0 && nextStep > commandAt);
		const script = `${action
			.slice(runAt + header.length, nextStep)
			.split("\n")
			.map((line) => line.slice(8))
			.join("\n")
			.trim()}\n`;
		const runWrapper = (input: {
			readonly nodeStatus: number;
			readonly nodeOutput?: string;
			readonly timeoutStatus?: number;
			readonly githubOutput?: string | null;
			readonly warmStore?: boolean;
		}) => {
			const root = mkdtempSync(join(tmpdir(), "hobo-deps-wrap-"));
			try {
				const timeout = join(root, "timeout");
				const node = join(root, "node");
				writeFileSync(
					timeout,
					input.timeoutStatus === undefined
						? '#!/bin/sh\nshift\nexec "$@"\n'
						: `#!/bin/sh\nexit ${input.timeoutStatus}\n`,
				);
				writeFileSync(
					node,
					'#!/bin/sh\nif [ "${4:-}" = "--check-warm-store" ]; then printf \'%s\\n\' "${FAKE_WARM_STORE:-false}"; exit 0; fi\nif [ -n "${FAKE_NODE_OUTPUT:-}" ]; then printf \'%s\\n\' "$FAKE_NODE_OUTPUT" >> "$GITHUB_OUTPUT"; fi\nexit "${FAKE_NODE_STATUS:-0}"\n',
				);
				chmodSync(timeout, 0o755);
				chmodSync(node, 0o755);
				const outputPath = join(root, "github-output");
				const env: NodeJS.ProcessEnv = {
					...process.env,
					PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
					FAKE_NODE_STATUS: String(input.nodeStatus),
					FAKE_NODE_OUTPUT: input.nodeOutput ?? "",
					FAKE_WARM_STORE: String(input.warmStore === true),
				};
				delete env.GITHUB_OUTPUT;
				if (input.githubOutput !== null && input.githubOutput !== undefined) {
					writeFileSync(outputPath, input.githubOutput);
					env.GITHUB_OUTPUT = outputPath;
				}
				const result = spawnSync("bash", ["-c", script], {
					env,
					encoding: "utf8",
				});
				return {
					status: result.status,
					stdout: result.stdout,
					stderr: result.stderr,
					output:
						input.githubOutput === null || input.githubOutput === undefined
							? ""
							: readFileSync(outputPath, "utf8"),
				};
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		};
		const missing = runWrapper({ nodeStatus: 7, githubOutput: "" });
		assert.equal(missing.status, 0, `${missing.stdout}${missing.stderr}`);
		assert.match(missing.output, /^materialized=false\n/u);
		assert.match(missing.output, /^source=failed$/mu);
		assert.match(missing.output, /^install=false$/mu);
		const timedOut = runWrapper({
			nodeStatus: 0,
			timeoutStatus: 124,
			githubOutput: "",
		});
		assert.equal(timedOut.status, 0, `${timedOut.stdout}${timedOut.stderr}`);
		assert.match(
			timedOut.stdout,
			/::warning title=hobo-ci-deps-materialize-timeout::/,
		);
		assert.match(timedOut.output, /^install=false$/mu);
		const timedOutWarm = runWrapper({
			nodeStatus: 0,
			timeoutStatus: 124,
			githubOutput: "",
			warmStore: true,
		});
		assert.equal(timedOutWarm.status, 0);
		assert.match(timedOutWarm.output, /^install=true$/mu);
		const partialWarm = runWrapper({
			nodeStatus: 0,
			timeoutStatus: 124,
			githubOutput: "materialized=true\n",
			warmStore: true,
		});
		assert.equal(partialWarm.status, 0);
		assert.match(
			partialWarm.output,
			/materialized=false\nsource=failed\ninstall=true\n$/u,
		);
		const unset = runWrapper({ nodeStatus: 1, githubOutput: null });
		assert.equal(unset.status, 0, `${unset.stdout}${unset.stderr}`);
		const decided = runWrapper({
			nodeStatus: 9,
			githubOutput: "materialized=true\nsource=local\ninstall=false\n",
			nodeOutput: "",
		});
		assert.equal(decided.status, 9);
		assert.equal(
			decided.output,
			"materialized=true\nsource=local\ninstall=false\n",
		);
		const succeeded = runWrapper({
			nodeStatus: 0,
			githubOutput: "",
			nodeOutput: "materialized=true\ninstall=false",
		});
		assert.equal(succeeded.status, 0);
		assert.equal(succeeded.output, "materialized=true\ninstall=false\n");
	});

	it("passes on this repository's own workflows", () => {
		// The cases above lint fixtures. Nothing else in the commit or PR gates
		// runs the lint on the real files, so a workflow edit that broke a rule
		// (a box checkout without `clean: false`) reached main unnoticed.
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", lint],
			{
				cwd: fileURLToPath(new URL("../..", import.meta.url)),
				encoding: "utf8",
			},
		);
		assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
	});
});
