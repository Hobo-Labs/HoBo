import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isMainTrainReleasePath,
	lastReleaseTag,
	releaseScopeBetween,
} from "../ci/check-release-relevant-push.mts";

const repos: string[] = [];
afterEach(() => {
	for (const dir of repos.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "main-train-release-scope-"));
	repos.push(dir);
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, {
			cwd: dir,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
			},
		});
		if (result.status !== 0)
			throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
		return result.stdout.trim();
	};
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Release Test");
	git("config", "user.email", "release-test@example.invalid");
	git("config", "commit.gpgSign", "false");
	const write = (name: string, content = name) => {
		const path = join(dir, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	};
	const commit = (message: string) => {
		git("add", "-A");
		git("commit", "-q", "-m", message);
		return git("rev-parse", "HEAD");
	};
	write("docs/baseline.md");
	const base = commit("base");
	const runCli = (from: string, to: string) => {
		const executable = join(dir, "scripts/ci/check-release-relevant-push.mts");
		mkdirSync(dirname(executable), { recursive: true });
		writeFileSync(
			executable,
			readFileSync(
				join(import.meta.dirname, "../ci/check-release-relevant-push.mts"),
			),
		);
		return spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				executable,
				"--from",
				from,
				"--to",
				to,
			],
			{ cwd: dir, encoding: "utf8" },
		);
	};
	return { dir, git, write, commit, base, runCli };
}

describe("main train release scope uses its own conservative policy", () => {
	it.each([
		"packages/core/src/index.ts",
		"packages/runtime/src/index.ts",
		"packages/providers/provider-github/src/index.ts",
		"packages/cli/README.md",
		"site/src/index.astro",
		"external/ts-autocode",
		"deploy/release-images/oci.json",
		"release/npm-scope-map.json",
		"scripts/ci/stage-sdk-artifacts.mts",
		"scripts/new-tool.ts",
		".github/workflows/release-hobo.yml",
		"pnpm-lock.yaml",
		"docs/future-generator.ts",
		"docs/notes.md",
		"media/artwork/image.webp",
		"media/package.json",
		"unknown-new-area/output.ts",
	])("releases a deployable, tooling or unknown change: %s", (path) => {
		const f = fixture();
		f.write(path);
		const head = f.commit("change");
		expect(releaseScopeBetween(f.dir, f.base, head).run).toBe(true);
		const cli = f.runCli(f.base, head);
		expect(cli.status, cli.stderr).toBe(0);
		expect(cli.stdout).toContain("release-relevant");
	});

	it("releases core changes even when the workflow PR filter is narrower", () => {
		const f = fixture();
		f.write(
			".github/workflows/release-hobo.yml",
			'on:\n  pull_request:\n    paths:\n      - "site/**"\n',
		);
		const before = f.commit("narrow PR filters");
		f.write("packages/core/src/index.ts");
		const head = f.commit("change core");
		const cli = f.runCli(before, head);
		expect(cli.status, cli.stderr).toBe(0);
		expect(cli.stdout).toContain("release-relevant");
	});

	it("releases a mixed docs and code range", () => {
		const f = fixture();
		f.write("docs/notes.md");
		f.write("packages/core/src/index.ts");
		const head = f.commit("mixed change");
		expect(releaseScopeBetween(f.dir, f.base, head).run).toBe(true);
	});

	it("ignores an issue-template-only change", () => {
		const f = fixture();
		f.write(".github/ISSUE_TEMPLATE/bug report.md");
		const head = f.commit("issue template");
		expect(releaseScopeBetween(f.dir, f.base, head).run).toBe(false);
		const cli = f.runCli(f.base, head);
		expect(cli.status, cli.stderr).toBe(0);
		expect(cli.stdout).toContain("not-release-relevant");
		expect(isMainTrainReleasePath("media/generator.ts")).toBe(true);
		expect(isMainTrainReleasePath("docs/data.json")).toBe(true);
	});

	it("does not hide relevant files moved to docs or removed", () => {
		const f = fixture();
		f.write("packages/core/src/index.ts");
		const withCode = f.commit("add code");
		f.git("mv", "packages/core/src/index.ts", "docs/moved.md");
		const moved = f.commit("move code");
		expect(releaseScopeBetween(f.dir, withCode, moved).run).toBe(true);
		f.write("packages/core/src/deleted.ts");
		const beforeDelete = f.commit("add another file");
		f.git("rm", "packages/core/src/deleted.ts");
		const deleted = f.commit("delete code");
		expect(releaseScopeBetween(f.dir, beforeDelete, deleted).run).toBe(true);
	});

	it("detects a release input moved into excluded metadata", () => {
		const f = fixture();
		f.write("packages/core/src/index.ts");
		const beforeMove = f.commit("add core");
		mkdirSync(join(f.dir, ".github/ISSUE_TEMPLATE"), { recursive: true });
		f.git(
			"mv",
			"packages/core/src/index.ts",
			".github/ISSUE_TEMPLATE/moved.md",
		);
		const afterMove = f.commit("move core to metadata");
		expect(releaseScopeBetween(f.dir, beforeMove, afterMove).run).toBe(true);
	});

	it("detects a move from issue metadata into code and ignores issue-only renames", () => {
		const f = fixture();
		f.write(".github/ISSUE_TEMPLATE/old.md");
		const beforeMove = f.commit("add issue template");
		f.git(
			"mv",
			".github/ISSUE_TEMPLATE/old.md",
			".github/ISSUE_TEMPLATE/new.md",
		);
		const metadataMove = f.commit("rename issue template");
		expect(releaseScopeBetween(f.dir, beforeMove, metadataMove).run).toBe(
			false,
		);
		mkdirSync(join(f.dir, "packages/core/src"), { recursive: true });
		f.git("mv", ".github/ISSUE_TEMPLATE/new.md", "packages/core/src/new.ts");
		const codeMove = f.commit("move to code");
		expect(releaseScopeBetween(f.dir, metadataMove, codeMove).run).toBe(true);
	});

	it("keeps unusual filenames intact and refuses option-shaped revisions", () => {
		const f = fixture();
		f.write("packages/core/src/name\nwith newline.ts");
		const head = f.commit("odd filename");
		expect(releaseScopeBetween(f.dir, f.base, head).run).toBe(true);
		expect(() =>
			releaseScopeBetween(f.dir, "--output=/tmp/not-a-ref", head),
		).toThrow(/not a commit/);
		expect(() => lastReleaseTag(f.dir, "--output=/tmp/not-a-ref")).toThrow(
			/not a commit/,
		);
	});
});
