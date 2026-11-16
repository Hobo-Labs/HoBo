/**
 * `mise_ensure_installed` retries the whole mise install: the installer
 * downloads the release and its checksum without retries of its own, and one
 * reset connection on a hosted runner used to fail the job.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "./support/pins-support.ts";

/** An installer that fails until it has run `failures` times, then succeeds. */
function fakeInstaller(failures: number) {
	const dir = mkdtempSync(join(tmpdir(), "mise-install-retry-"));
	const counter = join(dir, "runs");
	writeFileSync(counter, "0");
	const script = join(dir, "install.sh");
	writeFileSync(
		script,
		[
			`n=$(cat '${counter}')`,
			"n=$((n + 1))",
			`echo "$n" > '${counter}'`,
			`[ "$n" -gt ${failures} ]`,
			"",
		].join("\n"),
	);
	return {
		url: `file://${script}`,
		runs: () => Number(readFileSync(counter, "utf8")),
	};
}

function ensureInstalled(url: string, attempts: number) {
	return spawnSync(
		"bash",
		["-c", `source scripts/lib/mise-path.sh && mise_ensure_installed`],
		{
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: {
				// No mise on PATH, so the installer runs.
				PATH: "/usr/bin:/bin",
				HOME: process.env.HOME ?? "/tmp",
				MISE_INSTALL_URL: url,
				MISE_INSTALL_ATTEMPTS: String(attempts),
				MISE_INSTALL_RETRY_DELAY: "0",
			},
		},
	);
}

describe("mise install retry", () => {
	it("succeeds once a transient failure clears", () => {
		const installer = fakeInstaller(2);
		const result = ensureInstalled(installer.url, 4);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(installer.runs(), 3);
		assert.match(result.stderr, /install attempt 2 failed/u);
	});

	it("gives up after the configured attempts", () => {
		const installer = fakeInstaller(10);
		const result = ensureInstalled(installer.url, 3);
		assert.notEqual(result.status, 0);
		assert.equal(installer.runs(), 3);
		assert.match(result.stderr, /install failed after 3 attempts/u);
	});
});
