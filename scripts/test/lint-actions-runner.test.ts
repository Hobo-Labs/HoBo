import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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
});
