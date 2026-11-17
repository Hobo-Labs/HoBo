import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const tsx = import.meta.resolve("tsx");

const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;
const ENTRIES = 13_000;

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const hermetic = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(cwd: string, args: string[], input?: string): string {
	const result = spawnSync("git", args, {
		cwd,
		input,
		env: hermetic,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	assert.equal(result.status, 0, String(result.stderr));
	return result.stdout.trim();
}

function scratchDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratch.push(dir);
	return dir;
}

function bulkRepo(): string {
	const dir = scratchDir("hobo-git-output-");
	git(dir, ["init", "--quiet"]);
	const blob = git(dir, ["hash-object", "-w", "--stdin"], "");
	const stem = "p".repeat(80);
	const lines = Array.from(
		{ length: ENTRIES },
		(_, index) => `100644 ${blob} 0\tbulk/${stem}-${index}.test.ts`,
	);
	git(dir, ["update-index", "--add", "--index-info"], `${lines.join("\n")}\n`);
	return dir;
}

function commitBulk(dir: string): string {
	const base = git(dir, [
		"commit-tree",
		"-m",
		"base",
		git(dir, ["mktree"], ""),
	]);
	const head = git(dir, [
		"commit-tree",
		"-p",
		base,
		"-m",
		"bulk",
		git(dir, ["write-tree"]),
	]);
	git(dir, ["update-ref", "HEAD", head]);
	return base;
}

function writeStandardsFixture(dir: string) {
	const guidance = "Protobuf CUE Parse, don't validate PACT\n";
	mkdirSync(join(dir, "docs/design"), { recursive: true });
	writeFileSync(join(dir, "package.json"), '{ "typescript": "6.0.3" }\n');
	writeFileSync(join(dir, "pnpm-lock.yaml"), "typescript@6.0.3\n");
	writeFileSync(join(dir, "AGENTS.md"), guidance);
	writeFileSync(join(dir, "docs/design/technical-standards.md"), guidance);
}

function pnpmShimPath(): string {
	const bin = scratchDir("hobo-pnpm-shim-");
	const shim = join(bin, "pnpm");
	writeFileSync(shim, '#!/bin/sh\necho "pnpm-shim argc=$# $1 $2 $3"\n');
	chmodSync(shim, 0o755);
	return `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

function runScript(
	cwd: string,
	script: string,
	args: string[],
	env: NodeJS.ProcessEnv = {},
) {
	return spawnSync(
		process.execPath,
		["--import", tsx, join(root, "scripts", script), ...args],
		{
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				NODE_OPTIONS: "",
				HOBO_LINT_BASE: "",
				HOBO_DOCS_BASE: "",
				...env,
			},
		},
	);
}

describe("gates that capture a git file list", () => {
	let repo: string;

	before(() => {
		repo = bulkRepo();
		writeStandardsFixture(repo);
	});

	it("builds a listing past Node's default buffer", () => {
		for (const args of [["ls-files"], ["diff", "--cached", "--name-only"]]) {
			const size = Buffer.byteLength(git(repo, args));
			assert.ok(
				size > NODE_DEFAULT_MAX_BUFFER,
				`${args[0]}: only ${size} bytes`,
			);
		}
	});

	it("lint:docs --all lists every tracked file", () => {
		const result = runScript(repo, "run-linters.ts", ["--all"]);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /no changed markdown files/u);
		assert.doesNotMatch(result.stderr, /could not list/u);
	});

	it("lint:docs:staged lists every staged file", () => {
		const result = runScript(repo, "run-linters.ts", ["--staged"]);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /no changed markdown files/u);
	});

	it("standards:check --staged reads every staged file", () => {
		const result = runScript(repo, "check-technical-standards.ts", [
			"--staged",
		]);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /technical standards ok/u);
	});

	it("generated:guard reads every staged file", () => {
		const result = runScript(repo, "no-hand-edited-generated-files.mts", []);
		assert.equal(result.status, 0, result.stdout + result.stderr);
	});

	it("test:changed hands every changed test file to the runner", {
		skip: process.platform === "win32",
	}, () => {
		const base = commitBulk(repo);
		const result = runScript(repo, "run-changed-tests.mts", [], {
			HOBO_CHECK_BASE: base,
			PATH: pnpmShimPath(),
		});
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.doesNotMatch(result.stdout, /lane skipped/u);
		assert.match(
			result.stdout,
			new RegExp(`pnpm-shim argc=${ENTRIES + 5} `, "u"),
		);
	});
});
