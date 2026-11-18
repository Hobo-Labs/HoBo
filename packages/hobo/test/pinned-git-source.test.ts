import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readPinnedGitSource } from "../src/pinned-git-source.js";

const directories: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(): string {
	const cwd = mkdtempSync(join(tmpdir(), "hobo-pinned-source-"));
	directories.push(cwd);
	git(cwd, "init", "-q");
	git(cwd, "config", "user.name", "Source test");
	git(cwd, "config", "user.email", "source@example.invalid");
	return cwd;
}

function commit(cwd: string): string {
	git(cwd, "add", "-A");
	git(cwd, "commit", "-qm", "fixture");
	return git(cwd, "rev-parse", "HEAD");
}

afterEach(() => {
	for (const cwd of directories.splice(0))
		rmSync(cwd, { recursive: true, force: true });
});

describe("pinned Git deployment source", () => {
	it("reads only selected committed bytes, even when the checkout has changed", () => {
		const cwd = repository();
		mkdirSync(join(cwd, "app"));
		writeFileSync(join(cwd, "app", "main.bin"), Buffer.from([0, 255, 1]));
		writeFileSync(join(cwd, "app", "name with spaces.txt"), "committed\n");
		writeFileSync(join(cwd, "other.txt"), "outside");
		const sha = commit(cwd);
		writeFileSync(join(cwd, "app", "name with spaces.txt"), "modified");
		writeFileSync(join(cwd, "app", "untracked.txt"), "not an artifact");

		const source = readPinnedGitSource({ cwd, sha, paths: ["app"] });
		expect(source.commit).toBe(sha);
		expect(source.files.map((file) => file.path)).toEqual([
			"app/main.bin",
			"app/name with spaces.txt",
		]);
		expect(source.files[0]?.content).toEqual(Buffer.from([0, 255, 1]));
		expect(source.files[1]?.content.toString()).toBe("committed\n");
		expect(
			readPinnedGitSource({ cwd: join(cwd, "app"), sha, paths: ["app"] }),
		).toEqual(source);
		expect(
			readPinnedGitSource({ cwd, sha, paths: ["app", "app/main.bin"] }),
		).toEqual(source);
		expect(() =>
			readPinnedGitSource({ cwd, sha, paths: ["app", "app/name"] }),
		).toThrow(/absent/i);
	});

	it("refuses unpinned revisions, unsafe selections, symlinks, and excessive artifacts", () => {
		const cwd = repository();
		writeFileSync(join(cwd, "regular"), "12345");
		symlinkSync("regular", join(cwd, "link"));
		const sha = commit(cwd);
		expect(() =>
			readPinnedGitSource({ cwd, sha: "HEAD", paths: ["regular"] }),
		).toThrow();
		expect(() =>
			readPinnedGitSource({ cwd, sha, paths: ["../outside"] }),
		).toThrow();
		expect(() => readPinnedGitSource({ cwd, sha, paths: ["link"] })).toThrow(
			/symlink/i,
		);
		expect(() =>
			readPinnedGitSource({ cwd, sha, paths: ["regular"], maxBytes: 4 }),
		).toThrow(/limit/i);
	});

	it.each([
		["GIT_COMMON_DIR", ".git"],
		["GIT_OBJECT_DIRECTORY", ".git/objects"],
		["GIT_ALTERNATE_OBJECT_DIRECTORIES", ".git/objects"],
	])("ignores inherited %s when locating the pinned repository", (name, suffix) => {
		const cwd = repository();
		writeFileSync(join(cwd, "own"), "own source");
		const ownSha = commit(cwd);
		const other = repository();
		writeFileSync(join(other, "foreign"), "foreign source");
		const otherSha = commit(other);
		const previous = process.env[name];
		try {
			process.env[name] = join(other, suffix);
			expect(
				readPinnedGitSource({
					cwd,
					sha: ownSha,
					paths: ["own"],
				}).files[0]?.content.toString(),
			).toBe("own source");
			expect(() =>
				readPinnedGitSource({ cwd, sha: otherSha, paths: ["foreign"] }),
			).toThrow();
		} finally {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
	});

	it.skipIf(process.platform === "win32")(
		"does not fetch missing objects when Git ignores the no-lazy-fetch setting",
		() => {
			const cwd = repository();
			writeFileSync(join(cwd, "payload"), "committed source");
			const sha = commit(cwd);
			const blob = git(cwd, "rev-parse", "HEAD:payload");
			const remote = join(cwd, "remote.git");
			git(cwd, "init", "--bare", "--quiet", remote);
			git(remote, "config", "uploadpack.allowFilter", "true");
			git(
				cwd,
				"push",
				"--quiet",
				pathToFileURL(remote).href,
				"HEAD:refs/heads/main",
			);
			git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
			const clone = join(cwd, "partial");
			git(
				cwd,
				"clone",
				"--quiet",
				"--filter=blob:none",
				"--no-checkout",
				pathToFileURL(remote).href,
				clone,
			);
			const hasBlob = () =>
				spawnSync("git", ["-C", clone, "cat-file", "-e", blob], {
					env: { ...process.env, GIT_ALLOW_PROTOCOL: "" },
				}).status === 0;
			expect(hasBlob()).toBe(false);
			const bin = join(cwd, "bin");
			mkdirSync(bin);
			writeFileSync(
				join(bin, "git"),
				'#!/bin/sh\nunset GIT_NO_LAZY_FETCH\nexec "$HOBO_TEST_REAL_GIT" "$@"\n',
				{ mode: 0o755 },
			);
			const oldPath = process.env.PATH;
			const oldRealGit = process.env.HOBO_TEST_REAL_GIT;
			const realGit = execFileSync("which", ["git"], {
				encoding: "utf8",
			}).trim();
			try {
				process.env.PATH = `${bin}:${oldPath ?? ""}`;
				process.env.HOBO_TEST_REAL_GIT = realGit;
				expect(() =>
					readPinnedGitSource({ cwd: clone, sha, paths: ["payload"] }),
				).toThrow();
			} finally {
				if (oldPath === undefined) delete process.env.PATH;
				else process.env.PATH = oldPath;
				if (oldRealGit === undefined) delete process.env.HOBO_TEST_REAL_GIT;
				else process.env.HOBO_TEST_REAL_GIT = oldRealGit;
			}
			expect(hasBlob()).toBe(false);
		},
	);
});
