import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	boxGitMirrorPath,
	createBoxGitMirror,
	defaultGitMirrorFallbackRoot,
	defaultGitMirrorPreferredRoot,
	resolveGitMirrorRoot,
	shaRef,
} from "../src/isolated-worker/git-mirror.js";
import { isCompleteGitMirror } from "../src/isolated-worker/git-mirror-usability.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

type CommitSource = {
	source: string;
	first: string;
	second: string;
};

function commitSource(root: string): CommitSource {
	const source = join(root, "source");
	mkdirSync(source);
	git(source, ["init", "-b", "main"]);
	git(source, ["config", "user.name", "HoBo Test"]);
	git(source, ["config", "user.email", "hobo-test@example.invalid"]);
	git(source, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(source, "README.md"), "one\n");
	git(source, ["add", "README.md"]);
	git(source, ["commit", "-m", "one"]);
	const first = git(source, ["rev-parse", "HEAD"]);
	writeFileSync(join(source, "README.md"), "two\n");
	git(source, ["add", "README.md"]);
	git(source, ["commit", "-m", "two"]);
	const second = git(source, ["rev-parse", "HEAD"]);
	return { source, first, second };
}

describe("resolveGitMirrorRoot", () => {
	it("uses the preferred root when it is writable", () => {
		const preferred = mkdtempSync(join(tmpdir(), "hobo-git-mirror-pref-"));
		roots.push(preferred);
		expect(resolveGitMirrorRoot(preferred, "/tmp/fallback-unused")).toBe(
			preferred,
		);
	});

	it("falls back when the preferred root cannot be created", () => {
		const fallback = mkdtempSync(join(tmpdir(), "hobo-git-mirror-fb-"));
		roots.push(fallback);
		// A permission failure is simulated: as root, a read-only parent
		// directory would not stop mkdir, and this test runs as root in containers.
		for (const code of ["EACCES", "EPERM", "EROFS"])
			expect(
				resolveGitMirrorRoot("/var/lib/hobo-ci/git", fallback, (root) => {
					if (root !== fallback)
						throw Object.assign(new Error("denied"), { code });
				}),
			).toBe(fallback);
		// Any other failure is not a reason to fall back.
		expect(() =>
			resolveGitMirrorRoot("/var/lib/hobo-ci/git", fallback, () => {
				throw Object.assign(new Error("full"), { code: "ENOSPC" });
			}),
		).toThrow("full");
	});

	it("defaultGitMirrorFallbackRoot is absolute", () => {
		expect(defaultGitMirrorFallbackRoot()).toMatch(/^\//);
	});

	it("defaultGitMirrorPreferredRoot uses box cache without HOBO_CI_GIT_MIRROR_ROOT", () => {
		const priorUser = process.env.USER;
		const priorHome = process.env.HOME;
		const priorRoot = process.env.HOBO_CI_GIT_MIRROR_ROOT;
		delete process.env.HOBO_CI_GIT_MIRROR_ROOT;
		process.env.USER = "box";
		process.env.HOME = "/home/box";
		try {
			expect(defaultGitMirrorPreferredRoot()).toBe(
				"/home/box/.cache/hobo-ci/git",
			);
		} finally {
			if (priorRoot === undefined) delete process.env.HOBO_CI_GIT_MIRROR_ROOT;
			else process.env.HOBO_CI_GIT_MIRROR_ROOT = priorRoot;
			if (priorUser === undefined) delete process.env.USER;
			else process.env.USER = priorUser;
			if (priorHome === undefined) delete process.env.HOME;
			else process.env.HOME = priorHome;
		}
	});
});

describe("boxGitMirrorPath", () => {
	it("places owner/name.git under the absolute root", () => {
		expect(boxGitMirrorPath("/var/lib/hobo-ci/git", "Hobo-Labs/HoBo")).toBe(
			"/var/lib/hobo-ci/git/Hobo-Labs/HoBo.git",
		);
	});

	it("rejects a relative or traversing root", () => {
		expect(() => boxGitMirrorPath("relative", "Hobo-Labs/HoBo")).toThrow(
			/absolute/,
		);
		expect(() =>
			boxGitMirrorPath("/var/lib/hobo-ci/git/../escape", "Hobo-Labs/HoBo"),
		).toThrow(/absolute/);
	});
});

describe("createBoxGitMirror", () => {
	it("fetches a later origin commit into refs/hobo/sha and never as a branch name", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-git-mirror-"));
		roots.push(root);
		const { source, first, second } = commitSource(root);
		git(source, ["update-ref", "refs/heads/main", first]);
		git(source, ["symbolic-ref", "HEAD", "refs/heads/main"]);
		const mirror = createBoxGitMirror({
			root: join(root, "mirrors"),
			repository: "Hobo-Labs/HoBo",
			originUrl: source,
		});
		expect(await mirror.ensure(first)).toEqual({
			status: "hit",
			mirror: mirror.path,
		});
		git(source, ["update-ref", "refs/heads/main", second]);
		const result = await mirror.ensure(second);
		expect(result).toEqual({ status: "hit", mirror: mirror.path });
		expect(
			git(root, [
				"--git-dir",
				mirror.path,
				"cat-file",
				"-e",
				`${second}^{commit}`,
			]),
		).toBe("");
		expect(
			git(root, ["--git-dir", mirror.path, "show-ref", shaRef(second)]),
		).toContain(second);
		const refs = git(root, [
			"--git-dir",
			mirror.path,
			"for-each-ref",
			"--format=%(refname)",
		]);
		expect(
			refs.split("\n").filter((name) => name.startsWith("refs/heads/")),
		).toEqual(["refs/heads/main"]);
		expect(
			git(root, ["--git-dir", mirror.path, "rev-parse", "refs/heads/main"]),
		).toBe(second);
	});

	it("repairs an existing blob:none promisor mirror on ensure", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-git-mirror-"));
		roots.push(root);
		const { source, first } = commitSource(root);
		const mirrorPath = boxGitMirrorPath(
			join(root, "mirrors"),
			"Hobo-Labs/HoBo",
		);
		mkdirSync(dirname(mirrorPath), { recursive: true });
		execFileSync("git", ["clone", "--bare", source, mirrorPath]);
		execFileSync("git", [
			"--git-dir",
			mirrorPath,
			"config",
			"remote.origin.promisor",
			"true",
		]);
		execFileSync("git", [
			"--git-dir",
			mirrorPath,
			"config",
			"extensions.partialclonefilter",
			"blob:none",
		]);
		const mirror = createBoxGitMirror({
			root: join(root, "mirrors"),
			repository: "Hobo-Labs/HoBo",
			originUrl: source,
		});
		const result = await mirror.ensure(first);
		expect(result).toEqual({ status: "hit", mirror: mirror.path });
		expect(isCompleteGitMirror(mirror.path)).toBe(true);
	});

	it("misses a commit the origin does not have", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-git-mirror-"));
		roots.push(root);
		const { source } = commitSource(root);
		const mirror = createBoxGitMirror({
			root: join(root, "mirrors"),
			repository: "Hobo-Labs/HoBo",
			originUrl: source,
		});
		const missing = "0".repeat(40);
		const result = await mirror.ensure(missing);
		expect(result.status).toBe("miss");
		if (result.status === "miss")
			expect(result.reason).toMatch(/fetch failed|does not contain/);
		const refs = git(root, [
			"--git-dir",
			mirror.path,
			"for-each-ref",
			"--format=%(refname)",
		]);
		expect(refs).not.toContain(shaRef(missing));
	});

	it("serializes two ensure calls onto one writer", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-git-mirror-"));
		roots.push(root);
		const { source, first, second } = commitSource(root);
		const mirror = createBoxGitMirror({
			root: join(root, "mirrors"),
			repository: "Hobo-Labs/HoBo",
			originUrl: source,
		});
		const [a, b] = await Promise.all([
			mirror.ensure(first),
			mirror.ensure(second),
		]);
		expect(a).toEqual({ status: "hit", mirror: mirror.path });
		expect(b).toEqual({ status: "hit", mirror: mirror.path });
	});
});
