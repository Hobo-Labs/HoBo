import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
