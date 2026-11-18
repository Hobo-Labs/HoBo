import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
	resolveMergeGroupTarget,
	runAttestedJobs,
} from "../ci/local-attest.mts";
import type { PlannedJob } from "../ci/attested-jobs.mts";

it("runs and signs the actual merge-group commit against its live base", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "hobo-merge-group-run-"));
	const root = join(scratch, "repo");
	mkdirSync(root);
	const inherited = {
		GIT_CONFIG: process.env.GIT_CONFIG,
		GIT_DIR: process.env.GIT_DIR,
		GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
		GIT_WORK_TREE: process.env.GIT_WORK_TREE,
	};
	const unrelatedConfig = join(scratch, "unrelated-config");
	const unrelatedContent = "[fixture]\n\tmarker = unchanged\n";
	writeFileSync(unrelatedConfig, unrelatedContent);
	process.env.GIT_CONFIG = unrelatedConfig;
	process.env.GIT_DIR = join(scratch, "unrelated.git");
	process.env.GIT_INDEX_FILE = join(scratch, "unrelated-index");
	process.env.GIT_WORK_TREE = join(scratch, "unrelated-worktree");
	const env = {
		...Object.fromEntries(
			Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
		),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
	try {
		git("init", "--quiet");
		git("config", "user.name", "Test");
		git("config", "user.email", "test@example.invalid");
		git("config", "core.preloadindex", "false");
		git("config", "index.threads", "1");
		git("config", "maintenance.auto", "false");
		git("config", "gc.auto", "0");
		writeFileSync(join(root, ".gitignore"), ".hobo/attestations-out/\n");
		git("add", ".gitignore");
		git("commit", "--quiet", "-m", "base");
		const base = git("rev-parse", "HEAD");
		git("update-ref", "refs/remotes/origin/main", base);
		writeFileSync(join(root, "change.txt"), "queued change\n");
		git("add", "change.txt");
		git("commit", "--quiet", "-m", "queued commit");
		const head = git("rev-parse", "HEAD");
		const target = resolveMergeGroupTarget({
			cwd: root,
			baseRef: "origin/main",
		});
		assert.equal(target.mergeCommit, head);
		assert.equal(target.base, base);
		const plan: PlannedJob[] = [
			{
				id: "ci-guard",
				workflow: ".github/workflows/example.yml",
				workflowEnv: {},
				env: {},
				outputs: {},
				steps: [{ local: "run", run: `test "$GITHUB_SHA" = "${head}"` }],
			},
		];
		const privateKey = generateKeyPairSync("ed25519").privateKey;
		const run = {
			target,
			plan,
			events: ["merge_group"] as const,
			skipJobs: [],
			privateKey,
			env,
			engineVersion: () => undefined,
			toolVersions: () => ({ node: "test", pnpm: "test", turbo: "test" }),
		};
		const result = await runAttestedJobs(run);
		assert.equal(result.envelope.statement.testedCommit, head);
		assert.deepEqual(result.envelope.statement.events, ["merge_group"]);
		await assert.rejects(
			runAttestedJobs({ ...run, target: { ...target, mergeCommit: base } }),
			/inconsistent with the checked-out commits/u,
		);
		git("commit", "--allow-empty", "--quiet", "-m", "another group");
		assert.throws(
			() => resolveMergeGroupTarget({ cwd: root, baseRef: "origin/main" }),
			/current base as its only parent/u,
		);
		assert.equal(readFileSync(unrelatedConfig, "utf8"), unrelatedContent);
	} finally {
		for (const [name, value] of Object.entries(inherited)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(scratch, { recursive: true, force: true });
	}
});
