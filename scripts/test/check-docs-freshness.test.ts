import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "scripts/check-docs-freshness.ts");
const tsx = import.meta.resolve("tsx");

function write(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

function git(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		},
	});
	assert.equal(result.status, 0, result.stderr);
}

function runFreshness(cwd: string) {
	return spawnSync(process.execPath, ["--import", tsx, script], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			HOBO_DOCS_BASE: "",
			NODE_OPTIONS: "",
		},
	});
}

describe("docs freshness dependency paths", () => {
	it("ignores node_modules directories and symlinks but reports authored code", () => {
		const temporary = mkdtempSync(join(tmpdir(), "hobo-docs-freshness-"));
		try {
			const repo = join(temporary, "repo");
			const dependencies = join(temporary, "dependencies");
			mkdirSync(repo, { recursive: true });
			write(join(repo, ".gitignore"), "node_modules/\n");
			write(join(repo, "README.md"), "# Fixture\n");
			write(join(repo, "src/a.ts"), "export const a = 1;\n");
			write(join(dependencies, "index.js"), "module.exports = {};\n");
			git(repo, ["init", "--quiet"]);
			git(repo, ["config", "user.name", "fixture"]);
			git(repo, ["config", "user.email", "fixture@example.invalid"]);
			git(repo, ["add", ".gitignore", "README.md", "src/a.ts"]);
			git(repo, ["commit", "--quiet", "-m", "fixture"]);

			mkdirSync(join(repo, "src/draft/x"), { recursive: true });
			symlinkSync(dependencies, join(repo, "src/draft/x/node_modules"), "dir");
			write(
				join(repo, "src/draft/y/node_modules/pkg/index.js"),
				"module.exports = {};\n",
			);

			const installed = runFreshness(repo);
			assert.equal(installed.status, 0, installed.stdout + installed.stderr);
			assert.match(installed.stdout, /no code changes detected/u);

			write(join(repo, "src/b.ts"), "export const b = 2;\n");
			const changed = runFreshness(repo);
			assert.equal(changed.status, 1, changed.stdout + changed.stderr);
			assert.match(changed.stderr, /- src\/b\.ts/u);
			assert.doesNotMatch(changed.stdout + changed.stderr, /node_modules/u);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});
});
