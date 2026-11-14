/**
 * The git primitives the pin code is built on: running git as an argument
 * vector, reading the index's gitlink and the submodule's state. The
 * submodule's HEAD, and the checks before it, are in pins-git-head.ts.
 * Nothing here moves a submodule or touches the network.
 *
 * Erasable TypeScript with node builtins only.
 */
import {
	type SpawnSyncOptionsWithStringEncoding,
	spawnSync,
} from "node:child_process";
import { join } from "node:path";

import { PinsError, type PinsErrorCode } from "./pins.ts";
import {
	endedBySignal,
	exitStatus,
	REPEATED_SIGNALS,
} from "./pins-git-signal.ts";
import { netTimeout } from "./pins-net.ts";

export { endedBySignal, exitStatus } from "./pins-git-signal.ts";
export { sameRepo } from "./pins-repo-url.ts";

export interface GitResult {
	/** git's exit status; a death by a signal is 128 + its number, as a shell reports it, never 1. */
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
	/** The signal that ended git, when one did. */
	readonly signal?: NodeJS.Signals;
}

/** Why git did not answer: the signal that ended it, or its exit and first line of error. */
export function gitFailure(what: string, read: GitResult): string {
	return read.signal === undefined
		? `${what} exited ${read.status}: ${read.stderr.split("\n")[0] ?? ""}`
		: `${what} was killed by ${read.signal}`;
}

/** `value` as one shell word, for a printed fix: as it is when plain, else single-quoted. */
export function shellWord(value: string): string {
	return /^[\w./:@%+=,-]+$/u.test(value)
		? value
		: `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Run git in its own process group under a deadline, from a small node
 * parent: when the deadline passes the whole group gets SIGTERM, then
 * SIGKILL, so no transport helper outlives the call holding a pipe or a
 * connection. A signal the parent gets is passed on to the group. The
 * listeners exist before git does: git runs in a session of its own, so a
 * signal that found the parent with no listener would end the parent and
 * leave git running. git starts on the event loop's check phase, after any
 * signal already pending has been handled, and a signal handled before git
 * exists ends the parent with 128 + its number (130 for SIGINT) without
 * starting git. Exit 124 means the deadline passed.
 *
 * A git that dies of a signal is reported as that signal. For the six Node
 * leaves at their default action and that dump no core (REPEATED_SIGNALS) the
 * parent ends by the same signal, so a caller sees the signal itself. Not for
 * the others: re-raising SIGSEGV, SIGABRT or SIGQUIT made node write a core
 * file of its own, SIGUSR1 started Node's inspector, and SIGPIPE, which Node
 * ignores, ended the parent only after a 1 s fallback. For those the parent
 * exits with the explicit status 128 + N and `endedBySignal` reads the name
 * back from it. A real exit status, 129 and 130 included, is passed through
 * as it is.
 */
export const UNDER_DEADLINE = `
const { spawn } = require("node:child_process");
const { signals } = require("node:os").constants;
const again = ${JSON.stringify(REPEATED_SIGNALS)};
const [ms, ...args] = process.argv.slice(1);
let child;
const group = (signal) => {
	if (child === undefined) process.exit(128 + signals[signal]);
	try { process.kill(-child.pid, signal); } catch {}
};
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => group(name));
setImmediate(() => {
	child = spawn("git", args, { stdio: "inherit", detached: true });
	let late = false;
	const timer = setTimeout(() => {
		late = true;
		group("SIGTERM");
		setTimeout(() => { group("SIGKILL"); process.exit(124); }, 2000).unref();
	}, Number(ms));
	child.on("error", (error) => { console.error(error.message); process.exit(127); });
	child.on("exit", (code, signal) => {
		clearTimeout(timer);
		if (late) process.exit(124);
		if (code !== null) process.exit(code);
		if (!again.includes(signal)) process.exit(128 + signals[signal]);
		// git died of a signal that is safe to repeat: die of the same one.
		for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeAllListeners(name);
		process.kill(process.pid, signal);
		setTimeout(() => process.exit(128 + signals[signal]), 1000);
	});
});
`;

/**
 * git's own `local_repo_env`: exactly the names `git rev-parse
 * --local-env-vars` prints on git 2.43, the set git clears before it runs a
 * command in a submodule, plus GIT_NAMESPACE. They beat the working
 * directory, and git exports some of them to every hook (GIT_DIR and
 * GIT_INDEX_FILE in a linked worktree), so a pins verb run from a hook would
 * otherwise act on the superproject instead of the submodule or the probe.
 * `pins-git-env.test.ts` checks the list against the installed git.
 */
export const LOCAL_REPO_ENV = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_OBJECT_DIRECTORY",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_GRAFT_FILE",
	"GIT_INDEX_FILE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_REPLACE_REF_BASE",
	"GIT_PREFIX",
	"GIT_SHALLOW_FILE",
	"GIT_COMMON_DIR",
	// Printed by git before 2.40 (the CI runner image's bookworm git is 2.39).
	"GIT_INTERNAL_SUPER_PREFIX",
	"GIT_NAMESPACE",
] as const;

/**
 * In git's list, but kept: they carry the invoking user's configuration
 * (`git -c`, and GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n through
 * GIT_CONFIG_COUNT), which git itself passes to a submodule's commands; CI
 * credentials and the tests' hermetic configuration travel this way (ADR-0169
 * says why that is in scope). GIT_CONFIG is not kept: it only redirects the
 * `git config` command, and git drops it for a submodule too.
 * GIT_CEILING_DIRECTORIES is not in git's list and stays: it only narrows.
 */
const KEPT_CONFIGURATION: ReadonlySet<string> = new Set([
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
]);

/** This process's environment without the repository-locating variables. */
export function gitEnvironment(
	from: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env = { ...from };
	for (const name of LOCAL_REPO_ENV) {
		if (!KEPT_CONFIGURATION.has(name)) delete env[name];
	}
	return env;
}

/** A git call with a deadline: how long, and what to call it in the error. */
export interface Deadline {
	readonly ms: number;
	readonly what: string;
}

export function git(
	cwd: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = {},
	deadline?: Deadline,
): GitResult {
	const [command, argv] =
		deadline === undefined
			? ["git", [...args]]
			: [
					process.execPath,
					["-e", UNDER_DEADLINE, String(deadline.ms), ...args],
				];
	const options: SpawnSyncOptionsWithStringEncoding = {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: "pipe",
		env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
	};
	// The group is killed at the deadline; this only bounds the parent.
	if (deadline !== undefined) options.timeout = deadline.ms + 10_000;
	const result = spawnSync(command, argv, options);
	if (
		deadline !== undefined &&
		(result.status === 124 || isTimeout(result.error))
	) {
		throw netTimeout(deadline.what, deadline.ms);
	}
	if (result.error !== undefined) {
		throw new PinsError(
			"GIT_FAILED",
			`cannot run git: ${result.error.message}`,
		);
	}
	const status = exitStatus(result.status, result.signal);
	const stdout = (result.stdout ?? "").trim();
	const stderr = (result.stderr ?? "").trim();
	const signal = endedBySignal(
		result.status,
		result.signal,
		deadline !== undefined,
	);
	if (signal === null) return { status, stdout, stderr };
	return { status, stdout, stderr, signal };
}

function isTimeout(error: Error | undefined): boolean {
	return error !== undefined && "code" in error && error.code === "ETIMEDOUT";
}

export function must(
	cwd: string,
	args: readonly string[],
	what: string,
): string {
	const result = git(cwd, args);
	if (result.status !== 0) {
		throw new PinsError(
			"GIT_FAILED",
			`${what} failed: git ${args.join(" ")}\n${result.stderr}`,
		);
	}
	return result.stdout;
}

export function short(commit: string): string {
	return commit.slice(0, 7);
}

/** A refusal that `status` prints as a problem with its fix, and the other verbs throw. */
export class Refusal extends PinsError {
	readonly problem: string;
	readonly fix: string;
	constructor(code: PinsErrorCode, problem: string, fix: string) {
		super(code, `${problem}\nfix: ${fix}`);
		this.problem = problem;
		this.fix = fix;
	}
}

const GITLINK = /^160000 ([0-9a-f]{40}) 0\t/u;

/** A git version the pins need, and what needs it. */
export interface GitNeed {
	readonly major: number;
	readonly minor: number;
	readonly why: string;
}

/** Every git pin: `rev-parse --path-format=absolute` (`config --show-scope` is 2.26). */
export const MIN_GIT: GitNeed = {
	major: 2,
	minor: 31,
	why: "git rev-parse --path-format=absolute, git config --show-scope",
};

/** A pin with a sparse cone: `sparse-checkout set --cone`, which `set` takes from 2.35. */
export const SPARSE_GIT: GitNeed = {
	major: 2,
	minor: 35,
	why: "git sparse-checkout set --cone, for a pin with a sparse cone",
};

/** What `git --version` said, read once per process; null when it is in another form. */
let found: { said: string; major: number; minor: number } | null | undefined;

/**
 * Refuses a git older than `need`. The version is read once per process. A
 * version git prints in another form is let through: every read that needs
 * a newer git also fails closed on its own.
 */
export function requireGit(root: string, need: GitNeed = MIN_GIT): void {
	if (found === undefined) {
		const said = git(root, ["--version"]).stdout;
		const match = /^git version (\d+)\.(\d+)/u.exec(said);
		found =
			match === null
				? null
				: { said, major: Number(match[1]), minor: Number(match[2]) };
	}
	if (found === null) return;
	if (
		found.major < need.major ||
		(found.major === need.major && found.minor < need.minor)
	) {
		throw new PinsError(
			"GIT_FAILED",
			`${found.said} is older than ${need.major}.${need.minor}, which the pins need (${need.why}); install git ${need.major}.${need.minor} or newer`,
		);
	}
}

/** The commit the index pins `path` at: the first git call of every git verb, after the version check. */
export function gitlinkOf(root: string, path: string): string {
	requireGit(root);
	if (git(root, ["rev-parse", "--is-inside-work-tree"]).stdout !== "true") {
		throw new PinsError(
			"SUBMODULE_STATE",
			`${root} is not a git checkout (a zip download has no submodules); clone with git: git clone --recurse-submodules <the repository>`,
		);
	}
	const line = git(root, ["ls-files", "-s", "--", path]).stdout;
	const commit = GITLINK.exec(line)?.[1];
	if (commit === undefined) {
		throw new PinsError(
			"SUBMODULE_STATE",
			`${path} is not a submodule gitlink in this repository's index`,
		);
	}
	return commit;
}

/** Uncommitted changes to tracked files (untracked build output is ignored). */
export function isDirty(root: string, path: string): boolean {
	return (
		git(join(root, path), ["status", "--porcelain", "--untracked-files=no"])
			.stdout !== ""
	);
}

/**
 * Whether any branch, tag, remote-tracking ref or `refs/pins/*` contains
 * `commit`: if none does, the only thing holding it is the reflog.
 */
export function onAnyRef(root: string, path: string, commit: string): boolean {
	return (
		git(join(root, path), [
			"for-each-ref",
			"--contains",
			commit,
			"--count=1",
			"--format=%(refname)",
		]).stdout !== ""
	);
}

/**
 * Remember a commit the pins put the submodule on. A shallow clone does not
 * have it in any remote-tracking ref's history, so without this a later move
 * off it would look like abandoning unpushed work.
 */
export function keepPin(root: string, path: string, commit: string): void {
	must(
		join(root, path),
		["update-ref", `refs/pins/${commit}`, commit],
		"recording the pinned commit",
	);
}

export function isShallow(root: string, path: string): boolean {
	return (
		git(join(root, path), ["rev-parse", "--is-shallow-repository"]).stdout ===
		"true"
	);
}
