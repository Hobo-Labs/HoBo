import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const workflow = readFileSync(".github/workflows/hobo-ci.yml", "utf8");

function job(name: string): string {
	const lines = workflow.split("\n");
	const start = lines.indexOf(`  ${name}:`);
	assert.ok(start >= 0, `missing job ${name}`);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/u.test(line));
	return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

function shellForStep(block: string, name: string): string {
	const start = block.indexOf(`      - name: ${name}\n`);
	assert.ok(start >= 0, `missing step ${name}`);
	const match = block
		.slice(start)
		.match(/\n {8}run: \|\n((?: {10}[^\n]*\n?)+)/u);
	assert.ok(match?.[1] !== undefined, `missing shell for ${name}`);
	return match[1]
		.replace(/^ {10}/gmu, "")
		.replaceAll("${{ github.event_name }}", "pull_request");
}

/**
 * A pull request's checkout as GitHub makes it: `refs/pull/N/merge`, a merge
 * commit whose first parent is the base branch as it is now, while the
 * event's `pull_request.base.sha` can still name an older base.
 */
describe("a PR's own changes, against the base its merge commit was made on", () => {
	let repo: string;
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	const commit = (path: string, text: string) => {
		mkdirSync(join(repo, dirname(path)), { recursive: true });
		writeFileSync(join(repo, path), text);
		git("add", "--all");
		git("commit", "-q", "-m", path);
		return git("rev-parse", "HEAD");
	};
	/** The PR merge commit for a PR that changed `path`, after main changed a deps input. */
	const mergeRef = (path: string) => {
		const eventBase = commit("README.md", "base\n");
		git("checkout", "-q", "-b", "pr");
		const prHead = commit(path, "the pull request's change\n");
		git("checkout", "-q", "main");
		const mainTip = commit("scripts/lib/deps-key.mts", "main's later change\n");
		git("merge", "-q", "--no-ff", "--no-edit", "pr");
		return { eventBase, mainTip, prHead };
	};
	const run = (step: string, env: Record<string, string>) => {
		const output = join(repo, ".output");
		const result = spawnSync("bash", ["-c", step], {
			cwd: repo,
			encoding: "utf8",
			env: { ...process.env, ...env, GITHUB_OUTPUT: output },
		});
		assert.equal(result.status, 0, result.stderr);
		return readFileSync(output, "utf8");
	};

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "hobo-pr-diff-base-"));
		git("init", "-q", "-b", "main");
		git("config", "user.email", "ci@example.invalid");
		git("config", "user.name", "ci");
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	it("does not build the deps image for a PR that left its inputs alone", () => {
		const { eventBase, prHead } = mergeRef("packages/ci-agent/src/agent.ts");
		const scope = shellForStep(
			job("ci-deps-image"),
			"Limit PR builds to deps image inputs",
		);
		assert.equal(
			run(scope, { PR_BASE_SHA: eventBase, PR_HEAD_SHA: prHead }),
			"run=false\n",
		);
	});

	it("builds it for a PR that changed one", () => {
		const { eventBase, prHead } = mergeRef("scripts/ci/deps-layer.mts");
		const scope = shellForStep(
			job("ci-deps-image"),
			"Limit PR builds to deps image inputs",
		);
		assert.equal(
			run(scope, { PR_BASE_SHA: eventBase, PR_HEAD_SHA: prHead }),
			"run=true\n",
		);
	});

	it("bases the affected set on the merge commit's first parent", () => {
		const { eventBase, mainTip, prHead } = mergeRef(
			"packages/ci-agent/src/agent.ts",
		);
		const base = shellForStep(
			job("pr_gate_validation"),
			"Resolve Turbo SCM base",
		);
		assert.equal(
			run(base, { PR_BASE_SHA: eventBase, PR_HEAD_SHA: prHead }),
			`base=${mainTip}\n`,
		);
	});

	it("falls back to the event's base for any other merge commit at HEAD", () => {
		// A merge whose second parent is not the PR head: here a head that
		// itself merged main in, checked out directly. Its first parent is the
		// PR's own previous commit, not a base.
		const { eventBase, prHead } = mergeRef("packages/ci-agent/src/agent.ts");
		git("checkout", "-q", "pr");
		git("merge", "-q", "--no-ff", "--no-edit", "main");
		const base = shellForStep(
			job("pr_gate_validation"),
			"Resolve Turbo SCM base",
		);
		assert.equal(
			run(base, { PR_BASE_SHA: eventBase, PR_HEAD_SHA: prHead }),
			`base=${eventBase}\n`,
		);
	});
});
