import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const linter = fileURLToPath(new URL("../lint-actions.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");

function runLinter(file: string, extraJobs: string) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-runner-policy-"));
	try {
		const workflows = join(directory, ".github", "workflows");
		mkdirSync(workflows, { recursive: true });
		writeFileSync(
			join(workflows, file),
			`name: Runner policy fixture\non:\n  pull_request:\njobs:\n  normal:\n    runs-on: hobo\n    steps:\n      - run: true\n${extraJobs}`,
		);
		return spawnSync(process.execPath, ["--import", tsx, linter], {
			cwd: directory,
			encoding: "utf8",
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function job(id: string, runner: string) {
	return `  ${id}:\n    runs-on: ${runner}\n    steps:\n      - run: true\n`;
}

test("allows Ubuntu only for the npm publishing job in release-hobo", () => {
	const result = runLinter(
		"release-hobo.yml",
		job("release-npm", "ubuntu-24.04"),
	);
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
});

test("rejects another Ubuntu job even beside the npm publishing exception", () => {
	const result = runLinter(
		"release-hobo.yml",
		job("release-npm", "ubuntu-24.04") + job("other", "ubuntu-24.04"),
	);
	assert.ifError(result.error);
	assert.equal(result.status, 1, result.stderr);
	assert.match(
		result.stderr,
		/runs-on must be hobo or the trunk label expression/,
	);
});

test("rejects the npm job exception in another workflow or on another runner", () => {
	const scenarios: [string, string][] = [
		["release-code.yml", "ubuntu-24.04"],
		["release-hobo.yml", "ubuntu-22.04"],
	];
	for (const [file, runner] of scenarios) {
		const result = runLinter(file, job("release-npm", runner));
		assert.ifError(result.error);
		assert.equal(result.status, 1, result.stderr);
		assert.match(
			result.stderr,
			/runs-on must be hobo or the trunk label expression/,
		);
	}
});
