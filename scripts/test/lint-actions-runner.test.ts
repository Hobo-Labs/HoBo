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
});
