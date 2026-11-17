/**
 * Dev environment bootstrap contract: mise.toml, bootstrap script, and optional Docker smoke.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "./support/pins-support.ts";

const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("dev-env bootstrap", () => {
	it("commits mise.toml and lockfile with matching tool names", () => {
		const toml = read("mise.toml");
		const lock = read("mise.lock");
		for (const tool of ["node", "pnpm", "cue", "turbo"]) {
			assert.match(toml, new RegExp(`${tool}\\s*=`, "u"));
			assert.match(lock, new RegExp(`\\[\\[tools\\.${tool}\\]\\]`, "u"));
		}
	});

	it("bootstrap-dev installs and activates mise on a clean PATH", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-bootstrap-"));
		const installer = join(dir, "installer.sh");
		const mise = join(dir, "bin", "mise");
		const log = join(dir, "mise.log");
		const installs = join(dir, "installs.log");
		writeFileSync(
			installer,
			[
				'printf "installed\\n" >> "$HOBO_MISE_TEST_INSTALLS"',
				'mkdir -p "$(dirname "$MISE_INSTALL_PATH")"',
				"cat > \"$MISE_INSTALL_PATH\" <<'FAKE_MISE'",
				"#!/bin/sh",
				'printf "%s\\n" "$*" >> "$HOBO_MISE_TEST_LOG"',
				"FAKE_MISE",
				'chmod +x "$MISE_INSTALL_PATH"',
				"",
			].join("\n"),
		);
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = spawnSync(
					"bash",
					["scripts/bootstrap-dev.sh", "--project-only"],
					{
						cwd: REPO_ROOT,
						encoding: "utf8",
						env: {
							...process.env,
							PATH: "/usr/bin:/bin",
							HOBO_SKIP_DOTFILES: "1",
							MISE_INSTALL_URL: `file://${installer}`,
							MISE_INSTALL_PATH: mise,
							HOBO_MISE_TEST_LOG: log,
							HOBO_MISE_TEST_INSTALLS: installs,
						},
					},
				);
				assert.equal(
					result.status,
					0,
					`bootstrap-dev failed:\n${result.stderr}\n${result.stdout}`,
				);
				assert.match(result.stdout, /bootstrap-dev: done/u);
			}
			assert.equal(readFileSync(installs, "utf8"), "installed\n");
			assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
				`trust ${join(REPO_ROOT, "mise.toml")}`,
				"install",
				"activate bash",
				`trust ${join(REPO_ROOT, "mise.toml")}`,
				"install",
				"activate bash",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("documents bootstrap in AGENTS.md and CLAUDE.md", () => {
		for (const doc of ["AGENTS.md", "CLAUDE.md"]) {
			const text = read(doc);
			assert.match(
				text,
				/bootstrap-dev\.sh/u,
				`${doc} mentions bootstrap-dev.sh`,
			);
			assert.match(text, /mise/u, `${doc} mentions mise`);
		}
	});
});
