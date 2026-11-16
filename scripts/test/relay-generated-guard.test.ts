import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(
	new URL("../no-hand-edited-generated-files.mts", import.meta.url),
);
const tsx = import.meta.resolve("tsx");
const relaySource = "packages/ci-gh-actions/templates/hobo-ci-host.yml";
const relayOutput = "packages/ci-vercel/src/_generated-assets/relay-assets.ts";

function runGuard(paths: readonly string[]): number | null {
	const dir = mkdtempSync(join(tmpdir(), "hobo-relay-generated-guard-"));
	const env = { ...process.env };
	for (const key of Object.keys(env))
		if (key.startsWith("GIT_")) delete env[key];
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
	writeFileSync(env.GIT_CONFIG_GLOBAL, "");
	try {
		execFileSync("git", ["init", "--quiet"], { cwd: dir, env });
		for (const path of paths) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), "fixture\n");
		}
		execFileSync("git", ["add", "--", ...paths], { cwd: dir, env });
		return spawnSync(process.execPath, ["--import", tsx, guard], {
			cwd: dir,
			env,
			encoding: "utf8",
		}).status;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

it("permits the relay asset with its own source, but not unrelated generated files", () => {
	assert.equal(runGuard([relaySource, relayOutput]), 0);
	assert.notEqual(
		runGuard([relaySource, relayOutput, "other/src/_generated/unrelated.ts"]),
		0,
	);
});
