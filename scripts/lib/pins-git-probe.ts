/**
 * Whether a server serves a commit, asked from a repository nobody uses.
 *
 * Fetching a commit, even with `--dry-run`, downloads its pack and, with
 * `--depth`, writes `shallow`: run in the superproject or the submodule it
 * would turn a full clone shallow and add objects to the user's repository.
 * So the question is asked from a new, empty bare repository under the cache
 * root (private, checked like the asset cache), removed as soon as the
 * answer is in. Its git runs asynchronously under the same signal guard as a
 * download (`pins-partial.ts`): SIGINT, SIGTERM or SIGHUP removes the
 * repository and ends that git's process group. One a harder kill left is
 * swept, older than an hour, before every probe (`sweepProbes`).
 *
 * Erasable TypeScript with node builtins only.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { PinsError } from "./pins.ts";
import { cacheDir } from "./pins-assets.ts";
import { dirProblem, sweepProbes } from "./pins-cache.ts";
import { type GitResult, git, gitEnvironment } from "./pins-git-core.ts";
import { terminalHint } from "./pins-git-hint.ts";
import {
	allowedProtocols,
	type NetOptions,
	NOT_SERVED,
	netArgs,
} from "./pins-git-net.ts";
import { netTimeout, netTimeoutMs } from "./pins-net.ts";
import { armGuard } from "./pins-partial.ts";

function assertPrivate(cache: string): void {
	try {
		mkdirSync(cache, { recursive: true, mode: 0o700 });
	} catch {
		// A file where the directory belongs is reported below.
	}
	const info = lstatSync(cache);
	const problem = dirProblem(
		{ uid: info.uid, mode: info.mode, directory: info.isDirectory() },
		process.getuid?.() ?? info.uid,
		cache,
	);
	if (problem !== null) {
		throw new PinsError(
			"CACHE_UNSAFE",
			`${problem.problem}; the server is asked from a throwaway repository there, so nothing is written to it. fix: ${problem.fix}`,
		);
	}
}

/** What a probe's git may write before it is stopped (the old spawnSync bound). */
const MAX_OUTPUT_BYTES = 64 * 1024 ** 2;

/** One network git, in its own process group, ended at the deadline or by `stop`. */
interface ProbeGit {
	readonly result: Promise<GitResult>;
	stop(): void;
}

function probeGit(
	repo: string,
	args: readonly string[],
	options: NetOptions,
): ProbeGit {
	const ms = netTimeoutMs();
	const child = spawn("git", netArgs(args), {
		cwd: repo,
		detached: true,
		// The answer is the exit status and stderr; stdout is not needed.
		stdio: ["ignore", "ignore", "pipe"],
		env: {
			...gitEnvironment(),
			GIT_TERMINAL_PROMPT: "0",
			LC_ALL: "C",
			GIT_ALLOW_PROTOCOL: allowedProtocols(options.allowLocal, false),
		},
	});
	const group = (signal: NodeJS.Signals): void => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, signal);
		} catch {
			// Already gone.
		}
	};
	let escalation: ReturnType<typeof setTimeout> | undefined;
	const stop = (): void => {
		group("SIGTERM");
		// Cancelled at close: once git is gone its group id may be reused.
		escalation ??= setTimeout(() => group("SIGKILL"), 2000).unref();
	};
	let late = false;
	const timer = setTimeout(() => {
		late = true;
		stop();
	}, ms);
	let stderr = "";
	let flooded = false;
	child.stderr.on("data", (chunk: Buffer) => {
		if (flooded) return;
		if (stderr.length + chunk.length > MAX_OUTPUT_BYTES) {
			flooded = true;
			stop();
			return;
		}
		stderr += chunk.toString("utf8");
	});
	const result = new Promise<GitResult>((resolve, reject) => {
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new PinsError("GIT_FAILED", `cannot run git: ${error.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(escalation);
			if (late) reject(netTimeout(`git ${args.join(" ")}`, ms));
			else if (flooded) {
				reject(
					new PinsError(
						"GIT_FAILED",
						`git ${args.join(" ")} wrote more than 64 MiB of output; it was stopped`,
					),
				);
			} else
				resolve({
					status: code ?? 128,
					stdout: "",
					stderr: stderr.trim(),
				});
		});
	});
	return { result, stop };
}

/**
 * Run `ask` in a new, empty bare repository that is removed afterwards, also
 * when a signal ends the run; `ask` gets the repository and a way to run one
 * network git in it.
 */
export async function withProbeRepo<T>(
	ask: (
		repo: string,
		run: (args: readonly string[]) => Promise<GitResult>,
	) => Promise<T>,
	options: NetOptions,
	cache: string = cacheDir(),
): Promise<T> {
	assertPrivate(cache);
	sweepProbes(cache);
	const repo = join(cache, `.probe-${randomBytes(6).toString("hex")}`);
	let current: ProbeGit | undefined;
	// Armed before the directory exists, released after it is gone.
	const guard = armGuard(repo, () => current?.stop(), true);
	try {
		mkdirSync(repo, { mode: 0o700 });
		// No template: no hook of anyone's can run in it.
		const init = git(repo, ["init", "--quiet", "--bare", "--template=", "."]);
		if (init.status !== 0) {
			throw new PinsError(
				"GIT_FAILED",
				`cannot create a probe repository: ${init.stderr}`,
			);
		}
		const interrupted = (): PinsError | null => {
			const signal = guard.interrupted();
			return signal === null
				? null
				: new PinsError(
						"INTERRUPTED",
						`the probe was interrupted by ${signal}`,
					);
		};
		let answer: T;
		try {
			answer = await ask(repo, (args) => {
				current = probeGit(repo, args, options);
				return current.result;
			});
		} catch (error) {
			// The git a signal stopped fails; the signal is what happened.
			throw interrupted() ?? error;
		}
		const stopped = interrupted();
		if (stopped !== null) throw stopped;
		return answer;
	} finally {
		rmSync(repo, { recursive: true, force: true });
		guard.release();
	}
}

/**
 * Whether `url` will serve `sha`. A commit that exists only here (made in a
 * `--reference` clone, or never pushed) is answered "not our ref", which no
 * amount of local objects can hide: this asks the server by fetching the
 * commit into a throwaway repository, never into the superproject or the
 * submodule. A failure that is not that answer (no network, a bad host) is an
 * error, not a "no".
 */
export async function remoteHas(
	url: string,
	sha: string,
	options: NetOptions,
): Promise<boolean> {
	return await withProbeRepo(async (_repo, run) => {
		const result = await run(["fetch", "--depth", "1", "--no-tags", url, sha]);
		if (result.status === 0) return true;
		if (NOT_SERVED.test(result.stderr)) return false;
		throw new PinsError(
			"GIT_FAILED",
			`could not ask ${url} for ${sha.slice(0, 7)}: ${result.stderr}${terminalHint(result.stderr)}`,
		);
	}, options);
}
