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

	it("releases when no release tag is in the history, even if tags exist elsewhere", () => {
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
			/not a commit: no-such-rev/,
		);
	});

	it("reads a repository with no tags at all as never released", () => {
		const { dir, commit } = repo();
		const head = commit("README.md");
		expect(lastReleaseTag(dir, head)).toBeUndefined();
	});

	it("refuses a shallow checkout, whose missing history would hide the tags", () => {
		const { dir, git, commit } = repo();
		commit("site/a.html");
		git("tag", "v0.0.0-alpha.5");
		commit("docs/b.md");
		const shallow = mkdtempSync(join(tmpdir(), "hobo-release-shallow-"));
		repos.push(shallow);
		const clone = spawnSync(
			"git",
			["clone", "-q", "--depth=1", `file://${dir}`, shallow],
			{ encoding: "utf8" },
		);
		expect(clone.status, clone.stderr).toBe(0);
		expect(() =>
			releaseScopeSinceLastRelease(shallow, "HEAD", FILTERS),
		).toThrow(/checkout is shallow/);
	});
});

describe("as the release workflow runs it", () => {
	const root = join(import.meta.dirname, "..", "..");
	const workflow = readFileSync(
		join(root, ".github/workflows/release-hobo.yml"),
		"utf8",
	);

	it("asks since the last release, from the green commit", () => {
		expect(workflow).toMatch(
			/check-release-relevant-push\.mts \\\n\s+--since-last-release \\\n\s+--to "\$\{head_sha\}" \\\n\s+--github-output "\$GITHUB_OUTPUT"/,
		);
		expect(workflow).not.toMatch(/--from "\$\{head_sha\}\^"/);
	});

	it("queues main-train runs in one group, never cancelling a running release", () => {
		expect(workflow).toContain(
			"group: ${{ github.event_name == 'workflow_run' && format('hobo-release-train-{0}', github.event.workflow_run.event) || format('hobo-release-{0}-{1}', github.workflow, github.ref) }}",
		);
		expect(workflow).toContain(
			"cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
		);
	});

	it("writes run= for the gate under plain node", () => {
		const out = join(
			mkdtempSync(join(tmpdir(), "hobo-release-output-")),
			"out",
		);
		repos.push(dirname(out));
		writeFileSync(out, "");
		const run = spawnSync(
			process.execPath,
			[
				"--no-warnings",
				"scripts/ci/check-release-relevant-push.mts",
				"--from",
				"HEAD",
				"--to",
				"HEAD",
				"--github-output",
				out,
			],
			{ cwd: root, encoding: "utf8" },
		);
		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
		expect(readFileSync(out, "utf8")).toBe("run=false\n");
	});
});
