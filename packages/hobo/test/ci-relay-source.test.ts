import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	importerClosure,
	parseLockfile,
} from "../../../scripts/lib/pnpm-lockfile.mts";
import {
	pnpmWorkspaceClosure,
	readRelaySource,
} from "../src/ci-relay-source.js";
import { pinnedGitEnvironment } from "../src/pinned-git-source.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("relay source inputs", () => {
	it("matches the repository's existing pnpm workspace dependency graph", () => {
		const lock = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
		const expected = [
			...importerClosure(parseLockfile(lock), [".", "packages/ci-vercel"]),
		].sort();
		expect(pnpmWorkspaceClosure(lock, [".", "packages/ci-vercel"])).toEqual(
			expected,
		);
	});

	it("collects the pinned tree when invoked from inside the relay package", () => {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		const source = readRelaySource(resolve(root, "packages/ci-vercel"), sha);
		const paths = new Set(source.files.map((file) => file.path));
		expect(source.commit).toBe(sha);
		expect(paths.has("pnpm-lock.yaml")).toBe(true);
		expect(paths.has("packages/ci-vercel/api/relay.ts")).toBe(true);
		expect(paths.has("packages/core/src/index.ts")).toBe(true);
		expect([...paths].some((path) => path.startsWith("site/"))).toBe(false);
	});

	it("ignores inherited repository overrides and does not pass credentials to Git", () => {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		const previousCommonDir = process.env.GIT_COMMON_DIR;
		const previousToken = process.env.GITHUB_TOKEN;
		try {
			process.env.GIT_COMMON_DIR = resolve(
				tmpdir(),
				`hobo-foreign-git-${randomUUID()}`,
			);
			process.env.GITHUB_TOKEN = "synthetic-github-credential";
			const env = pinnedGitEnvironment();
			expect(env.GIT_COMMON_DIR).toBeUndefined();
			expect(env.GITHUB_TOKEN).toBeUndefined();
			expect(env.GIT_ALLOW_PROTOCOL).toBe("");
			expect(
				readRelaySource(resolve(root, "packages/ci-vercel"), sha).commit,
			).toBe(sha);
		} finally {
			if (previousCommonDir === undefined) delete process.env.GIT_COMMON_DIR;
			else process.env.GIT_COMMON_DIR = previousCommonDir;
			if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = previousToken;
		}
	});

	it("refuses missing or escaping workspace dependencies", () => {
		const lock =
			"lockfileVersion: '9.0'\nimporters:\n  .:\n  packages/app:\n    dependencies:\n      bad:\n        version: link:../../../outside\n";
		expect(() => pnpmWorkspaceClosure(lock, ["packages/app"])).toThrow(
			/escapes/u,
		);
		expect(() =>
			pnpmWorkspaceClosure("lockfileVersion: '9.0'\nimporters:\n  .:\n", [
				"packages/app",
			]),
		).toThrow(/missing/u);
	});
});
