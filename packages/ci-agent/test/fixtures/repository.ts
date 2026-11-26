import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGitWorkspace } from "../../src/git-workspace.js";

const IDENTITY = {
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
};

/**
 * A real "remote" (bare), an author's clone that pushes branches and
 * `refs/pull/<n>/head` to it, and the agent's own bare repository whose
 * `origin` is that remote. Nothing here is simulated git.
 */
export function createRepositories() {
	const root = mkdtempSync(join(tmpdir(), "hobo-ci-agent-test-"));
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			env: { ...process.env, ...IDENTITY },
			encoding: "utf8",
		}).trim();
	const remote = join(root, "remote.git");
	const author = join(root, "author");
	const agent = join(root, "agent.git");
	git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
	git(root, "init", "--quiet", "--initial-branch=main", author);
	git(author, "remote", "add", "origin", remote);
	git(root, "init", "--quiet", "--bare", agent);
	git(agent, "remote", "add", "origin", remote);
	const write = (
		files: Readonly<Record<string, string | Uint8Array | null>>,
	) => {
		for (const [path, content] of Object.entries(files)) {
			if (content === null) {
				git(author, "rm", "--quiet", "--", path);
				continue;
			}
			mkdirSync(dirname(join(author, path)), { recursive: true });
			writeFileSync(join(author, path), content);
		}
	};
	return {
		remote,
		/** The agent's own repository: objects it wrote but has not pushed live here. */
		agent,
		git,
		/** Commit files on `branch` (created from `from` when new) and push it. */
		commit(
			branch: string,
			files: Readonly<Record<string, string | Uint8Array | null>>,
			from = "main",
		): string {
			const exists =
				git(author, "branch", "--list", branch) !== "" || branch === "main";
			if (exists && git(author, "rev-parse", "--verify", "--quiet", "HEAD~0"))
				git(author, "checkout", "--quiet", branch);
			else git(author, "checkout", "--quiet", "-b", branch, from);
			write(files);
			git(author, "add", "--all");
			git(
				author,
				"commit",
				"--quiet",
				"--allow-empty",
				"-m",
				`change ${branch}`,
			);
			git(author, "push", "--quiet", "origin", `${branch}:${branch}`);
			return git(author, "rev-parse", "HEAD");
		},
		/** The first commit on main; the author clone has no HEAD before it. */
		seed(files: Readonly<Record<string, string>>): string {
			write(files);
			git(author, "add", "--all");
			git(author, "commit", "--quiet", "-m", "base");
			git(author, "push", "--quiet", "origin", "main:main");
			return git(author, "rev-parse", "HEAD");
		},
		/** Publish a branch as pull request `number`, the way GitHub exposes it. */
		pull(number: number, branch: string): void {
			git(
				author,
				"push",
				"--quiet",
				"origin",
				`${branch}:refs/pull/${number}/head`,
			);
		},
		remoteRef: (ref: string) => git(remote, "rev-parse", "--verify", ref),
		remoteFile: (ref: string, path: string) =>
			execFileSync("git", ["show", `${ref}:${path}`], {
				cwd: remote,
				encoding: "utf8",
			}),
		workspace: () => createGitWorkspace({ directory: agent }),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

export type Repositories = ReturnType<typeof createRepositories>;
