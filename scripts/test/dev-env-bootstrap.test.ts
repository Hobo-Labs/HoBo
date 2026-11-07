/**
 * Dev environment bootstrap contract: mise.toml, bootstrap script, and optional Docker smoke.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

	it("bootstrap-dev --project-only succeeds on a clean PATH with curl", () => {
		const result = spawnSync(
			"bash",
			["scripts/bootstrap-dev.sh", "--project-only"],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${process.env.HOME}/.local/bin:/usr/bin:/bin`,
					HOBO_SKIP_DOTFILES: "1",
				},
			},
		);
		assert.equal(
			result.status,
			0,
			`bootstrap-dev failed:\n${result.stderr}\n${result.stdout}`,
		);
		assert.match(result.stdout, /bootstrap-dev: done/u);
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
