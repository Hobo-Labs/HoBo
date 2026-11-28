import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { stagedChangedFileRecords } from "../lib/staged-merge-files.mts";

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const inherited = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
]);
const gitEnv = {
	...Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !inherited.has(name)),
	),
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "merge-scope-test",
	GIT_AUTHOR_EMAIL: "merge-scope-test@example.invalid",
	GIT_COMMITTER_NAME: "merge-scope-test",
	GIT_COMMITTER_EMAIL: "merge-scope-test@example.invalid",
};

function git(cwd: string, args: readonly string[], allowFail = false): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: gitEnv,
	});
	if (!allowFail) {
		assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function writeRepoFile(repo: string, rel: string, content: string): void {
	const full = join(repo, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
}

describe("stagedChangedFileRecords", () => {
	it("returns all staged files for normal non-merge commits", () => {
		const repo = mkdtempSync(join(tmpdir(), "hobo-staged-normal-"));
		scratch.push(repo);
		git(repo, ["init", "--quiet", "--initial-branch=main"]);
		writeRepoFile(repo, "packages/a/index.ts", "export const a = 1;\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "--quiet", "--no-verify", "-m", "init"]);

		writeRepoFile(repo, "packages/a/index.ts", "export const a = 2;\n");
		git(repo, ["add", "packages/a/index.ts"]);

		const records = stagedChangedFileRecords(repo);
		assert.deepEqual(
			records?.map((record) => record.path),
			["packages/a/index.ts"],
		);
	});

	it("excludes unrelated upstream files during an in-progress merge and keeps only conflict resolutions", () => {
		const repo = mkdtempSync(join(tmpdir(), "hobo-staged-merge-"));
		scratch.push(repo);
		git(repo, ["init", "--quiet", "--initial-branch=main"]);
		writeRepoFile(repo, "packages/shared/config.ts", "export const v = 0;\n");
		writeRepoFile(repo, "packages/unrelated/main.ts", "export const u = 0;\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "--quiet", "--no-verify", "-m", "base"]);

		git(repo, ["checkout", "--quiet", "-b", "feature"]);
		writeRepoFile(repo, "packages/shared/config.ts", "export const v = 1;\n");
		writeRepoFile(repo, "packages/feature/work.ts", "export const f = 1;\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "--quiet", "--no-verify", "-m", "feature work"]);

		git(repo, ["checkout", "--quiet", "main"]);
		writeRepoFile(repo, "packages/shared/config.ts", "export const v = 2;\n");
		writeRepoFile(repo, "packages/unrelated/main.ts", "export const u = 99;\n");
		writeRepoFile(repo, "packages/other/upstream.ts", "export const o = 1;\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "--quiet", "--no-verify", "-m", "upstream main"]);

		git(repo, ["checkout", "--quiet", "feature"]);
		git(repo, ["merge", "--no-commit", "--no-ff", "main"], true);
		writeRepoFile(repo, "packages/shared/config.ts", "export const v = 3;\n");
		git(repo, ["add", "packages/shared/config.ts"]);

		const records = stagedChangedFileRecords(repo);
		assert.deepEqual(
			records?.map((record) => record.path),
			["packages/shared/config.ts"],
		);
	});

	it("returns zero files for a clean fast merge with no conflict edits", () => {
		const repo = mkdtempSync(join(tmpdir(), "hobo-staged-clean-merge-"));
		scratch.push(repo);
		git(repo, ["init", "--quiet", "--initial-branch=main"]);
		writeRepoFile(repo, "packages/a/a.ts", "export const a = 1;\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "--quiet", "--no-verify", "-m", "base"]);

		git(repo, ["checkout", "--quiet", "-b", "feature"]);
		writeRepoFile(repo, "packages/b/b.ts", "export const b = 1;\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "--quiet", "--no-verify", "-m", "feature"]);

		git(repo, ["checkout", "--quiet", "main"]);
		writeRepoFile(repo, "packages/c/c.ts", "export const c = 1;\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "--quiet", "--no-verify", "-m", "upstream"]);

		git(repo, ["checkout", "--quiet", "feature"]);
		git(repo, ["merge", "--no-commit", "--no-ff", "main"]);

		const records = stagedChangedFileRecords(repo);
		assert.deepEqual(records, []);
	});
});
