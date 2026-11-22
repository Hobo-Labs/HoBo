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
	function job(id: string): string {
		const start = workflow.indexOf(`\n  ${id}:\n`);
		expect(start, id).toBeGreaterThan(-1);
		const rest = workflow.slice(start + 1);
		const end = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
		return end < 0 ? rest : rest.slice(0, end + 1);
	}
	function jobIf(id: string): string {
		const body = job(id);
		const start = body.indexOf("if: >-");
		expect(start, `${id}: job-level if`).toBeGreaterThan(-1);
		const runsOn = body.indexOf("runs-on:", start);
		expect(runsOn, `${id}: runs-on after the job-level if`).toBeGreaterThan(-1);
		return body.slice(start, runsOn);
	}

	it("asks since the last release, from the green commit", () => {
		expect(workflow).toMatch(
			/check-release-relevant-push\.mts \\\n\s+--since-last-release \\\n\s+--to "\$\{head_sha\}" \\\n\s+--github-output "\$GITHUB_OUTPUT"/,
		);
		expect(workflow).not.toMatch(/--from "\$\{head_sha\}\^"/);
	});

	it("queues main-train runs in one group and cancels stale pull_request or merge_group release runs", () => {
		expect(workflow).toContain(`concurrency:
  group: >-
    \${{ github.event_name == 'merge_group' && format('{0}-merge-group-{1}', github.workflow, github.event.merge_group.head_ref) ||
    (github.event_name == 'workflow_run' && format('hobo-release-train-{0}-{1}', github.event.workflow_run.event, github.event.workflow_run.conclusion)) ||
    format('hobo-release-{0}-{1}', github.workflow, github.ref) }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}`);
	});

	it("keeps publishing jobs out of a merge_group run the queue can cancel", () => {
		const publishAllowances = {
			"release-hobo-cli":
				/needs\.release-main-train-gate\.outputs\.run == 'true'|needs\.release-pages-gate\.outputs\.deploy == 'true'|startsWith\(github\.ref, 'refs\/tags\/(?:sdk|cli)-v'\)|github\.event_name == 'workflow_dispatch'/u,
			"release-oci-build-tag":
				/needs\.release-main-train-gate\.outputs\.run == 'true'|startsWith\(github\.ref, 'refs\/tags\/(?:sdk|cli)-v'\)|github\.event_name == 'workflow_dispatch'/u,
			"release-images":
				/needs\.release-main-train-gate\.outputs\.run == 'true'|startsWith\(github\.ref, 'refs\/tags\/(?:sdk|cli)-v'\)|github\.event_name == 'workflow_dispatch'/u,
			"release-publish":
				/needs\.release-main-train-gate\.outputs\.run == 'true'|startsWith\(github\.ref, 'refs\/tags\/(?:sdk|cli)-v'\)|github\.event_name == 'workflow_dispatch'/u,
			"release-attest":
				/needs\.release-main-train-gate\.outputs\.run == 'true'|startsWith\(github\.ref, 'refs\/tags\/(?:sdk|cli)-v'\)|github\.event_name == 'workflow_dispatch'/u,
			"release-npm":
				/needs\.release-main-train-gate\.outputs\.run == 'true'|startsWith\(github\.ref, 'refs\/tags\/sdk-v'\)|github\.event_name == 'workflow_dispatch'/u,
			"release-tag": /needs\.release-main-train-gate\.outputs\.run == 'true'/u,
			"release-github":
				/startsWith\(github\.ref, 'refs\/tags\/(?:sdk|cli)-v'\)/u,
		} as const;
		for (const [id, allowance] of Object.entries(publishAllowances)) {
			const condition = jobIf(id).replace(/^if: >-\n/u, "");
			expect(
				condition,
				`${id}: publish jobs must be gated by route success`,
			).toMatch(/needs\.route\.result == 'success'/u);
			for (const event of [
				"merge_group",
				"pull_request",
				"pull_request_target",
			]) {
				expect(
					condition,
					`${id}: a cancelled merge-group or untrusted pull-request run must not publish`,
				).not.toMatch(new RegExp(`github\\.event_name == '${event}'`, "u"));
			}
			expect(
				condition,
				`${id}: an explicit trusted event alternative must be the only way past the gate`,
			).toMatch(allowance);
		}
		expect(
			jobIf("release-github"),
			"an independent tag release still requires this run's publish",
		).toContain("needs.release-publish.result == 'success'");
		const realize = jobIf("release-realize").replace(/^if: >-\n/u, "");
		expect(realize).toMatch(
			/^\s*!cancelled\(\) && \(needs\.route\.result == 'success' \|\| needs\.route\.result == 'failure'\) &&\n\s*\(github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group'\)\s*$/u,
		);
	});

	it("fetches release tags where the Turbo base is measured and consumed", () => {
		const gate = job("release-main-train-gate");
		const checkout = gate.slice(
			gate.indexOf("uses: actions/checkout@"),
			gate.indexOf("- uses: $/.github/actions/ci-runner-preflight"),
		);
		expect(
			checkout,
			"git describe needs the tags a sparse build omits",
		).toContain("fetch-depth: 0");
		expect(checkout).toContain("fetch-tags: true");
		for (const id of ["release-oci-build-tag", "release-publish"] as const) {
			expect(
				job(id),
				`${id}: fetch the measured base before the scoped Turbo build`,
			).toContain(
				"run: node --no-warnings scripts/ci/fetch-release-turbo-base.mts",
			);
		}
	});

	it("gates the publish train on a route that failed, but never the Pages publish", () => {
		for (const id of [
			"release-main-train-gate",
			"release-contract",
			"release-hobo-integration",
			"release-realize",
		]) {
			expect(
				jobIf(id),
				`${id}: a failed route falls back to the pinned hosted runner, and the GHCR/npm publish train behind these gates must still run`,
			).toContain(
				"(needs.route.result == 'success' || needs.route.result == 'failure')",
			);
		}
		const pages = jobIf("release-pages");
		expect(pages).toContain("needs.route.result == 'success'");
		expect(
			pages,
			"Pages writes a public surface, so a run whose route never decided must not publish it",
		).not.toContain("needs.route.result == 'failure'");
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
		expect(readFileSync(out, "utf8")).toBe("run=false\nfrom=HEAD\n");
	});
});
