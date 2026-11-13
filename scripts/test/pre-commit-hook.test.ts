import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const HOOK = ".githooks/pre-commit";
const LAUNCHER = "scripts/run-script.mts";

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-pre-commit-"));
	scratch.push(dir);
	return dir;
}

// Node alone on PATH beside git and sh: the hook must not need a package
// manager, and the directory node ships in also holds pnpm and npm.
const nodeBin = join(tempDir(), "bin");
mkdirSync(nodeBin);
symlinkSync(process.execPath, join(nodeBin, "node"));
const globalConfig = join(tempDir(), "gitconfig");
writeFileSync(globalConfig, "");

/** Nothing inherited from whoever runs the suite: no opt-out, no base, no outer repository. */
const baseEnv = {
	HOME: tempDir(),
	PATH: [nodeBin, "/usr/bin", "/bin"].join(":"),
	GIT_CONFIG_GLOBAL: globalConfig,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(cwd: string, args: string[]) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: baseEnv,
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

// Stand-ins for the four scripts the hook runs. Each records its name and
// the arguments it received, so a test sees exactly what reached the gates.
const RECORD = `import { appendFileSync } from "node:fs";
const [name, ...args] = process.argv.slice(2);
appendFileSync("calls.jsonl", JSON.stringify({ name, args }) + "\\n");
`;
const FETCH = `import { appendFileSync } from "node:fs";
appendFileSync("calls.jsonl", JSON.stringify({ name: "fetch:pr-base", args: [] }) + "\\n");
if (process.env.FIXTURE_FETCH_ERROR) {
	console.error(process.env.FIXTURE_FETCH_ERROR);
	process.exit(1);
}
console.error("Fetching origin/main for targeted checks...");
console.log(process.env.FIXTURE_BASE ?? "main");
`;

/** A repository with one commit on main, this hook, the launcher and stub scripts. */
function fixture(): string {
	const repo = tempDir();
	git(repo, ["init", "--quiet", "--initial-branch=main"]);
	writeFileSync(join(repo, "README"), "fixture\n");
	git(repo, ["add", "README"]);
	git(repo, ["commit", "--quiet", "--no-verify", "-m", "fixture"]);
	for (const file of [HOOK, LAUNCHER]) {
		mkdirSync(dirname(join(repo, file)), { recursive: true });
		copyFileSync(join(root, file), join(repo, file));
	}
	writeFileSync(join(repo, "record.mjs"), RECORD);
	writeFileSync(join(repo, "fetch.mjs"), FETCH);
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({
			private: true,
			scripts: {
				"generated:guard": "node record.mjs generated:guard",
				"plans:guard": "node record.mjs plans:guard",
				"fetch:pr-base": "node fetch.mjs",
				"check:relevant:staged": "node record.mjs check:relevant:staged",
			},
		}),
	);
	// What the gates need first: tsx, which generated:guard loads.
	mkdirSync(join(repo, "node_modules", "tsx"), { recursive: true });
	writeFileSync(join(repo, "node_modules", "tsx", "package.json"), "{}");
	return repo;
}

/** Runs the hook as git does: from the top of the work tree. */
function hook(repo: string, extra: Record<string, string> = {}) {
	return spawnSync("/bin/sh", [HOOK], {
		cwd: repo,
		encoding: "utf8",
		env: { ...baseEnv, ...extra },
	});
}

type Call = { readonly name: string; readonly args: readonly string[] };

function calls(repo: string): Call[] {
	const file = join(repo, "calls.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line): Call => JSON.parse(line));
}

// `git check-ref-format` accepts this, so it can arrive as a PR's base branch.
const QUOTED = "main';touch${IFS}PWNED;#";

describe(".githooks/pre-commit", () => {
	it("runs with no package manager on PATH", () => {
		const probe = spawnSync("/bin/sh", ["-c", "command -v pnpm npm"], {
			env: baseEnv,
		});
		assert.notEqual(probe.status, 0);
		const repo = fixture();
		const result = hook(repo);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(calls(repo), [
			{ name: "fetch:pr-base", args: [] },
			{ name: "generated:guard", args: [] },
			{ name: "plans:guard", args: ["--staged"] },
			{ name: "check:relevant:staged", args: ["--base=main"] },
		]);
	});

	it("hands the gates a base holding ' and ; exactly, and runs nothing from it", () => {
		for (const source of [
			{ HOBO_ARCHITECTURE_BASE: QUOTED },
			{ FIXTURE_BASE: QUOTED },
		]) {
			const repo = fixture();
			git(repo, ["branch", QUOTED]);
			const result = hook(repo, source);
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(calls(repo).at(-1), {
				name: "check:relevant:staged",
				args: [`--base=${QUOTED}`],
			});
			assert.equal(existsSync(join(repo, "PWNED")), false);
		}
	});

	it("refuses a base that is not a commit before any gate runs", () => {
		const repo = fixture();
		const result = hook(repo, {
			HOBO_ARCHITECTURE_BASE: "no-such';touch PWNED;#",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /no-such';touch PWNED;#/u);
		assert.match(result.stderr, /HOBO_ARCHITECTURE_BASE/u);
		assert.deepEqual(calls(repo), []);
		assert.equal(existsSync(join(repo, "PWNED")), false);
	});

	it("shows why fetch:pr-base failed, and how to go on", () => {
		const repo = fixture();
		const why =
			"fatal: 'no-such-remote' does not appear to be a git repository";
		const result = hook(repo, { FIXTURE_FETCH_ERROR: why });
		assert.notEqual(result.status, 0);
		assert.ok(result.stderr.includes(why), result.stderr);
		assert.match(result.stderr, /HOBO_ARCHITECTURE_BASE=/u);
		assert.deepEqual(
			calls(repo).map((call) => call.name),
			["fetch:pr-base"],
		);
	});

	it("does not fetch when HOBO_ARCHITECTURE_BASE names the base", () => {
		const repo = fixture();
		const result = hook(repo, {
			HOBO_ARCHITECTURE_BASE: "main",
			FIXTURE_FETCH_ERROR: "fetch must not run",
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(
			calls(repo).map((call) => call.name),
			["generated:guard", "plans:guard", "check:relevant:staged"],
		);
	});

	it("says in one line how to install when dependencies are missing", () => {
		// No node_modules at all, or one an install never filled (empty, or
		// without tsx): either way the first gate would die in a stack trace.
		for (const install of ["absent", "empty"]) {
			const repo = fixture();
			rmSync(join(repo, "node_modules"), { recursive: true });
			if (install === "empty") mkdirSync(join(repo, "node_modules"));
			const result = hook(repo);
			assert.notEqual(result.status, 0, install);
			const lines = result.stderr.trim().split("\n");
			assert.equal(lines.length, 1, `${install}: ${result.stderr}`);
			assert.match(lines[0] ?? "", /install/u);
			assert.match(lines[0] ?? "", /HOBO_SKIP_HOOKS=1/u);
			assert.deepEqual(calls(repo), [], install);
		}
	});

	it("is skipped by HOBO_SKIP_HOOKS=1 or true, and not by 0 or false", () => {
		for (const value of ["1", "true", "TRUE", "yes", "on"]) {
			const repo = fixture();
			rmSync(join(repo, "node_modules"), { recursive: true });
			const result = hook(repo, { HOBO_SKIP_HOOKS: value });
			assert.equal(result.status, 0, `${value}: ${result.stderr}`);
			assert.deepEqual(calls(repo), [], value);
		}
		for (const value of ["0", "false", "no", "off", ""]) {
			const repo = fixture();
			const result = hook(repo, { HOBO_SKIP_HOOKS: value });
			assert.equal(result.status, 0, `${value}: ${result.stderr}`);
			assert.equal(calls(repo).at(-1)?.name, "check:relevant:staged", value);
		}
	});
});
