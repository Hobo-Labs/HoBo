import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { CI_RUNNER_PLAYWRIGHT_CHROMIUM } from "../lib/ci-runner-contract.mts";
import {
	playwrightHeadlessShellInstallDir,
	playwrightHeadlessShellInstalled,
} from "../lib/playwright-headless-shell-install.mts";

describe("playwright headless shell install trust", () => {
	it("rejects cache trees that only carry INSTALLATION_COMPLETE", () => {
		const root = mkdtempSync(join(tmpdir(), "pw-cache-"));
		const installDir = playwrightHeadlessShellInstallDir(root);
		mkdirSync(installDir, { recursive: true });
		writeFileSync(join(installDir, "INSTALLATION_COMPLETE"), "1\n");
		assert.equal(playwrightHeadlessShellInstalled(root), false);
	});

	it("accepts a tree with a runnable headless-shell executable", () => {
		const root = mkdtempSync(join(tmpdir(), "pw-cache-"));
		const installDir = playwrightHeadlessShellInstallDir(root);
		const executable = join(
			installDir,
			"chrome-headless-shell-linux64",
			"chrome-headless-shell",
		);
		mkdirSync(join(installDir, "chrome-headless-shell-linux64"), {
			recursive: true,
		});
		writeFileSync(executable, "#!/bin/sh\nexit 0\n");
		chmodSync(executable, 0o755);
		writeFileSync(join(installDir, "INSTALLATION_COMPLETE"), "1\n");
		assert.equal(playwrightHeadlessShellInstalled(root), true);
		assert.equal(
			installDir.endsWith(
				`chromium_headless_shell-${CI_RUNNER_PLAYWRIGHT_CHROMIUM.revision}`,
			),
			true,
		);
	});
});
