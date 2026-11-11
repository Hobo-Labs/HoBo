import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	lastReleaseTag,
	releaseScopeBetween,
	releaseScopeSinceLastRelease,
} from "../ci/check-release-relevant-push.mts";

const FILTERS = ["site/**", "scripts/ci/*release*"];

const repos: string[] = [];
afterEach(() => {
	for (const dir of repos.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function repo() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-release-scope-"));
	repos.push(dir);
	const git = (...args: string[]) => {
		const run = spawnSync("git", args, {
			cwd: dir,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
			},
		});
		if (run.status !== 0)
			throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
		return run.stdout.trim();
	};
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("config", "tag.gpgSign", "false");
	git("config", "commit.gpgSign", "false");
	const commit = (path: string) => {
		const file = join(dir, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${path} ${Math.random()}\n`);
		git("add", "-A");
		git("commit", "-q", "-m", `change ${path}`);
		return git("rev-parse", "HEAD");
	};
	return { dir, git, commit };
}

describe("main train release scope", () => {
	it("releases a change whose own CI run never finished, once a later commit goes green", () => {
		const { dir, git, commit } = repo();
		commit("README.md");
		git("tag", "-a", "v0.0.0-alpha.5", "-m", "release");
		commit("site/index.html"); // its run was cancelled by the next push
		const head = commit("docs/notes.md"); // the run that went green
		expect(releaseScopeBetween(dir, `${head}^`, head, FILTERS).run).toBe(false);
		const scope = releaseScopeSinceLastRelease(dir, head, FILTERS);
		expect(scope).toMatchObject({ run: true, from: "v0.0.0-alpha.5" });
		expect(scope.reason).toBe("release paths changed since v0.0.0-alpha.5");
	});

	it("skips when nothing on a release path changed since the last release", () => {
		const { dir, git, commit } = repo();
		commit("site/index.html");
		git("tag", "-a", "v0.0.0-alpha.5", "-m", "release");
		const head = commit("docs/notes.md");
		expect(releaseScopeSinceLastRelease(dir, head, FILTERS)).toMatchObject({
			run: false,
			from: "v0.0.0-alpha.5",
		});
	});

	it("skips a commit that is itself already released", () => {
		const { dir, git, commit } = repo();
		const head = commit("site/index.html");
		git("tag", "v0.0.0-alpha.6");
		expect(releaseScopeSinceLastRelease(dir, head, FILTERS).run).toBe(false);
	});

	it("measures from the newest release tag, and ignores sdk-v and cli-v tags", () => {
		const { dir, git, commit } = repo();
		commit("site/a.html");
		git("tag", "v0.0.0-alpha.5");
		commit("site/b.html");
		git("tag", "v0.0.0-alpha.6");
		commit("scripts/ci/push-release-thing.mts");
		git("tag", "sdk-v1.0.0");
		const head = commit("docs/notes.md");
		expect(lastReleaseTag(dir, head)).toBe("v0.0.0-alpha.6");
		expect(releaseScopeSinceLastRelease(dir, head, FILTERS)).toMatchObject({
			run: true,
			from: "v0.0.0-alpha.6",
		});
	});

	it("releases when no release tag is in the history (tags left on rewritten history)", () => {
		const { dir, git, commit } = repo();
		commit("README.md");
		git("checkout", "-q", "--orphan", "old");
		commit("site/old.html");
		git("tag", "v0.0.0-alpha.2");
		git("checkout", "-q", "main");
		const head = commit("docs/notes.md");
		expect(lastReleaseTag(dir, head)).toBeUndefined();
		expect(releaseScopeSinceLastRelease(dir, head, FILTERS)).toMatchObject({
			run: true,
			reason: `no release tag (v[0-9]*) in the history of ${head}`,
		});
	});

	it("names a revision it cannot read instead of releasing", () => {
		const { dir, commit } = repo();
		commit("README.md");
		expect(() => lastReleaseTag(dir, "no-such-rev")).toThrow(
			/git describe no-such-rev/,
		);
	});
});
