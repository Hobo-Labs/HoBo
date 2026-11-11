import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { GIT_LOCATION_VARIABLES } from "../ci/local-attest.mts";

// Git sets GIT_DIR, GIT_INDEX_FILE and the like for the hooks it runs. These
// tests run from pre-commit too, and every git command they start (their own
// or a script's) must act on its own repository, never the one being committed.
for (const name of GIT_LOCATION_VARIABLES) delete process.env[name];

const lint = fileURLToPath(new URL("../lint-actions.ts", import.meta.url));
const trunk =
	"${{ vars.HOBO_CI_TRUNK_RUNNER != 'false' && contains(fromJSON('[\"push\",\"workflow_dispatch\",\"merge_group\",\"workflow_run\"]'), github.event_name) && 'hobo-trunk' || 'hobo' }}";

const routed =
	"${{ needs.route.outputs.runner || (vars.HOBO_CI_TRUNK_RUNNER != 'false' && contains(fromJSON('[\"push\",\"workflow_dispatch\",\"merge_group\",\"workflow_run\"]'), github.event_name) && 'hobo-trunk' || 'hobo') }}";

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

const routeJob =
	"  route:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n        with:\n          persist-credentials: false\n      - id: route\n        uses: ./.github/actions/route-runner\n";

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
	it("allows the one GitHub-hosted runner needed for npm trusted publishing", () => {
		assert.equal(
			lintRunner("release-hobo.yml", "release-npm", "ubuntu-24.04"),
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
				"  route:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n",
			),
			0,
		);
		assert.notEqual(
			lintJobs(
				"  build:\n    if: ${{ always() }}\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n",
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
		`!(needs.route.outputs.attested == 'true' && contains(needs.route.outputs.attested-jobs, '"${id}"'))`;
	const attestingRoute = (sparse: string) =>
		`  route:\n    runs-on: ubuntu-24.04\n    outputs:\n      runner: \${{ steps.route.outputs.runner }}\n      attested: \${{ steps.route.outputs.attested }}\n      attested-jobs: \${{ steps.route.outputs.attested-jobs }}\n    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n        with:\n          persist-credentials: false\n          sparse-checkout: |\n            .github/actions/route-runner\n${sparse}      - id: route\n        uses: ./.github/actions/route-runner\n`;
	const verifierFiles =
		"            scripts/ci/attestation.mts\n            scripts/ci/verify-attestation.mts\n";
	const skippable = (id: string, condition: string, needs = "route") =>
		`  ${id}:\n    needs: ${needs}\n    if: \${{ github.event_name == 'pull_request' && ${condition} }}\n    runs-on: ${routed}\n    steps:\n      - run: echo ok\n`;

	it("lets a signed local run skip a covered job that names itself and needs the route job", () => {
		for (const id of ["ci-guard", "secret-scan", "pr_gate_validation"])
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
				"    runs-on: hobo\n    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n",
			),
			0,
		);
		assert.notEqual(
			probe('    runs-on: hobo\n    steps:\n      - run: "true"\n', ""),
			0,
		);
	});

	it("keeps label-by-name out of every other workflow", () => {
		assert.notEqual(
			lintRunner("pricing-ci.yml", "probe", "hobo-local-host"),
			0,
		);
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
