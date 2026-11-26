import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const linters = join(root, "scripts/run-linters.ts");
const tsx = import.meta.resolve("tsx");

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function emptyDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-docs-lint-"));
	scratch.push(dir);
	return dir;
}

/** A repository with no commits and nothing staged. */
function emptyRepo(): string {
	const dir = emptyDir();
	const init = spawnSync("git", ["init", "--quiet"], { cwd: dir });
	assert.equal(init.status, 0, String(init.stderr));
	return dir;
}

function runLinters(cwd: string, flag: string) {
	return spawnSync(process.execPath, ["--import", tsx, linters, flag], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, NODE_OPTIONS: "", HOBO_LINT_BASE: "" },
	});
}

// lint:docs:changed and lint:docs:staged are gates agent:check selects, so a
// changed-file list they could not read must stop them, as it stops
// agent:check and lint:slop:changed. They used to read a git failure as "no
// changed markdown files" and exit 0.
describe("lint:docs when git cannot list the changed files", () => {
	it("fails, naming the base, when the base does not resolve", () => {
		const result = runLinters(emptyRepo(), "--base=origin/no-such-branch");
		assert.equal(result.status, 2, result.stdout + result.stderr);
		assert.match(
			result.stderr,
			/could not diff against origin\/no-such-branch/u,
		);
		assert.doesNotMatch(result.stdout, /skipping docs linters/u);
	});

	it("fails outside a git work tree", () => {
		const result = runLinters(emptyDir(), "--staged");
		assert.equal(result.status, 2, result.stdout + result.stderr);
		assert.match(result.stderr, /could not list the staged files/u);
	});

	it("still skips an empty but readable diff", () => {
		const result = runLinters(emptyRepo(), "--staged");
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /no changed markdown files/u);
	});
});
