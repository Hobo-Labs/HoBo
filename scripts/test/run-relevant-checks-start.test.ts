import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const runner = join(root, "scripts/run-relevant-checks.ts");
// See run-relevant-checks-git-failure.test.ts: only tsx maps the runner's
// `./relevant-check-policy.js` import to its source.
const tsx = import.meta.resolve("tsx");

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-agent-check-start-"));
	scratch.push(dir);
	return dir;
}

// Node, git and sh, and no package manager: the directory node ships in also
// holds pnpm.
const nodeBin = join(tempDir(), "bin");
mkdirSync(nodeBin);
symlinkSync(process.execPath, join(nodeBin, "node"));
const env = {
	HOME: tempDir(),
	PATH: [nodeBin, "/usr/bin", "/bin"].join(":"),
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(cwd: string, args: string[]) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
}

function write(dir: string, file: string, text: string) {
	mkdirSync(dirname(join(dir, file)), { recursive: true });
	writeFileSync(join(dir, file), text);
}

function runChecks(cwd: string, ...flags: string[]) {
	return spawnSync(
		process.execPath,
		["--import", tsx, runner, "--staged", ...flags],
		{ cwd, encoding: "utf8", env },
	);
}

// A gate that cannot start is a failed gate, and the person committing has to
// be told which one and why: the runner used to print only its `▶` line.
describe("agent:check when a check cannot start", () => {
	it("says which check could not start and why", () => {
		const repo = tempDir();
		git(repo, ["init", "--quiet"]);
		// A root package.json with none of the selected scripts keeps them on
		// pnpm, and there is no pnpm here.
		write(repo, "package.json", "{}\n");
		write(repo, "docs/note.md", "# note\n");
		git(repo, ["add", "."]);
		const result = runChecks(repo);
		assert.notEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(
			result.stderr,
			/fail {2}pnpm run install:check — could not start pnpm: .*ENOENT/u,
		);
	});

	it("refuses an exec it cannot run without pnpm, without crashing", () => {
		const repo = tempDir();
		git(repo, ["init", "--quiet"]);
		write(repo, "package.json", "{}\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "--quiet", "--no-verify", "-m", "fixture"]);
		write(repo, "packages/foo/package.json", '{ "name": "foo" }\n');
		write(repo, "packages/foo/src/a.ts", "export const a = 1;\n");
		git(repo, ["add", "."]);
		// Every `pnpm run` gate this change selects passes, through the
		// launcher; only the workspace tests are an exec of turbo, which is not
		// installed.
		const explained = runChecks(repo, "--explain");
		assert.equal(explained.status, 0, explained.stderr);
		const names = [...explained.stdout.matchAll(/^- pnpm run (\S+)/gmu)].map(
			(match) => match[1] ?? "",
		);
		assert.match(explained.stdout, /^- pnpm exec turbo run test/mu);
		const scripts = Object.fromEntries(names.map((name) => [name, "true"]));
		write(repo, "package.json", JSON.stringify({ scripts }));
		mkdirSync(join(repo, "scripts"));
		copyFileSync(
			join(root, "scripts/run-script.mts"),
			join(repo, "scripts/run-script.mts"),
		);
		const result = runChecks(repo);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(
			result.stderr,
			/fail {2}pnpm exec turbo run test .*node_modules\/\.bin\/turbo is not installed/u,
		);
		assert.doesNotMatch(result.stderr, /^\s+at /mu);
	});
});
