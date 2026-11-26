/**
 * Git fixtures for the sibling-pin tests: a hermetic git environment, a
 * throwaway "remote" repository, a work tree whose submodule has not been
 * initialised yet, and a clone to lend objects.
 *
 * Nothing here touches the network or the user's git configuration.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GitConfig = readonly (readonly [string, string])[];

/**
 * git with the user's configuration (signing, hooks, identity) switched off, a
 * fixed identity, and the file transport allowed so a local repository can be
 * a submodule remote. Child processes inherit it, so the script under test
 * sees exactly the same git.
 */
export function gitEnv(
	extra: NodeJS.ProcessEnv = {},
	more: GitConfig = [],
): NodeJS.ProcessEnv {
	const config: GitConfig = [
		["protocol.file.allow", "always"],
		["init.defaultBranch", "main"],
		["commit.gpgsign", "false"],
		...more,
	];
	const env: NodeJS.ProcessEnv = {};
	for (const [index, [key, value]] of config.entries()) {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	}
	return {
		...process.env,
		NODE_OPTIONS: "",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: String(config.length),
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "Pins Test",
		GIT_AUTHOR_EMAIL: "pins@example.invalid",
		GIT_COMMITTER_NAME: "Pins Test",
		GIT_COMMITTER_EMAIL: "pins@example.invalid",
		...env,
		...extra,
	};
}

export function git(
	cwd: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = gitEnv(),
): string {
	return execFileSync("git", [...args], {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

export interface Remote {
	readonly dir: string;
	readonly url: string;
	/** Full commit ids, oldest first. */
	readonly shas: readonly string[];
}

/**
 * A repository with three commits, each rewriting the same four files. Two
 * made with different labels share no commit, so a test can have a second
 * upstream whose history is not the first one's.
 */
export function makeRemote(parent: string, label = "revision"): Remote {
	const dir = join(parent, "remote");
	mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q"]);
	const shas: string[] = [];
	for (const revision of ["1", "2", "3"]) {
		for (const file of [
			"README.md",
			"packages/a/x.txt",
			"packages/b/y.txt",
			"docs/z.txt",
		]) {
			mkdirSync(dirname(join(dir, file)), { recursive: true });
			writeFileSync(join(dir, file), `${label} ${revision}\n`);
		}
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", `${label} ${revision}`]);
		shas.push(git(dir, ["rev-parse", "HEAD"]));
	}
	return { dir, url: `file://${dir}`, shas };
}

export interface PinsFileOptions {
	readonly path?: string;
	readonly repo?: string;
	readonly sparse?: readonly string[] | null;
	/** Pin the gitlink at this commit instead of one of the remote's (it need not exist there). */
	readonly gitlink?: string;
	/** Raw JSON of the manifest's `assets` section. */
	readonly assets?: string;
}

export function pinsJson(
	remoteUrl: string,
	options: PinsFileOptions = {},
): string {
	const manifest = {
		schemaVersion: 1,
		git: {
			lib: {
				path: options.path ?? "external/lib",
				repo: options.repo ?? remoteUrl,
				branch: "main",
				sparse: options.sparse ?? null,
			},
		},
		assets: JSON.parse(options.assets ?? '{"tool":null}'),
		vendor: {},
	};
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * A work tree shaped like a fresh clone: `external/lib` is a gitlink at
 * `remote.shas[pinned]`, `.gitmodules` names the remote, and the submodule has
 * not been initialised.
 */
export function makeWork(
	parent: string,
	remote: Remote,
	pinned: number,
	options: PinsFileOptions = {},
): string {
	const stage = join(parent, "stage");
	mkdirSync(stage, { recursive: true });
	git(stage, ["init", "-q"]);
	const path = options.path ?? "external/lib";
	git(stage, ["submodule", "add", "-q", remote.url, path]);
	if (options.gitlink === undefined) {
		git(join(stage, path), ["checkout", "-q", remote.shas[pinned] ?? ""]);
	}
	mkdirSync(join(stage, "tools/pins"), { recursive: true });
	writeFileSync(
		join(stage, "tools/pins/siblings.json"),
		pinsJson(remote.url, options),
	);
	git(stage, ["add", "-A"]);
	if (options.gitlink !== undefined) {
		// After `add -A`, which would re-read the submodule's own HEAD.
		git(stage, [
			"update-index",
			"--cacheinfo",
			`160000,${options.gitlink},${path}`,
		]);
	}
	git(stage, ["commit", "-q", "-m", "super"]);
	const work = join(parent, "work");
	git(parent, ["clone", "-q", stage, work]);
	return work;
}

/** A full clone to lend objects: `--reference` against it needs no download. */
export function makeReference(parent: string, remote: Remote): string {
	const dir = join(parent, "reference");
	git(parent, ["clone", "-q", "--no-hardlinks", remote.dir, dir]);
	return dir;
}
