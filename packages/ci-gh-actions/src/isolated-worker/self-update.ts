/**
 * The box relay keeps itself current (plan 0026, 3.8; ADR-0181).
 *
 * Every `runnerRouting.selfUpdate.intervalHours`, and only when the box is
 * idle, the daemon fetches `origin main`. It moves only forward along main's
 * first-parent line (the commit it runs is the first parent of the oldest
 * commit main added since), and only when the daemon's own paths changed.
 * It prepares the new head in a separate git worktree: `pnpm install
 * --frozen-lockfile`, submodule update, build, and the daemon's
 * `--self-check` entry, which loads every module and the committed
 * `runnerRouting` and exits 0. Only then does it stop with the existing
 * `handoff` mode (the next daemon adopts the running containers) and re-exec
 * itself in place with `process.execve` on the new worktree: same PID, so no
 * supervisor is assumed.
 *
 * A preparation that fails logs `hobo_ci_self_update_refused`, the old code
 * keeps running, and the same head is not tried again for 24 hours. A Node
 * without `process.execve` logs `hobo_ci_self_update_ready` and keeps
 * running: the daemon never exits without a guaranteed restart.
 *
 * Everything that touches the host (git, processes, `execve`, the stop) is
 * passed in, so the rules are tested with fakes.
 */
import { join } from "node:path";

/** What the daemon's own code is made of: a change elsewhere is not its. */
export const SELF_UPDATE_PATHS: readonly string[] = Object.freeze([
	"packages/ci-gh-actions",
	"packages/ci",
	"pnpm-lock.yaml",
	"scripts/lib/ci-runner-contract.mts",
	"scripts/lib/deps-key.mts",
]);
/** A head whose preparation failed is not tried again for this long. */
export const SELF_UPDATE_REFUSAL_HOLD_MS = 24 * 60 * 60_000;
/** How often the daemon asks whether an update is due (and the box idle). */
export const SELF_UPDATE_CHECK_MS = 10 * 60_000;
/** The daemon's entry, relative to its checkout. */
// public-contract: the path a self-update re-execs; it moves only with the daemon.
export const SELF_UPDATE_DEFAULT_ENTRY =
	"packages/ci-gh-actions/scripts/isolated-worker-daemon.mts";
/** The argument that makes the entry check itself and exit. */
// public-contract: the daemon entry's command-line flag, run by older daemons.
export const SELF_CHECK_ARGUMENT = "--self-check";

const SHA = /^[0-9a-f]{40}$/u;

export type SelfUpdateSettings = Readonly<{
	enabled: boolean;
	intervalHours: number;
}>;

export type SelfUpdateStep =
	| "worktree"
	| "install"
	| "submodules"
	| "build"
	| "self-check";

export type SelfUpdateOutcome =
	| "disabled"
	| "in-progress"
	| "not-due"
	| "busy"
	| "commit-unknown"
	| "fetch-failed"
	| "current"
	| "held"
	| "off-main"
	| "unchanged"
	| "refused"
	| "ready"
	| "restarting";

type Fields = Readonly<Record<string, string | number | boolean>>;

export type SelfUpdaterOptions = Readonly<{
	settings: SelfUpdateSettings;
	/** The checkout the daemon runs from, and the commit it is at. */
	checkoutRoot: string;
	currentCommit: string | undefined;
	/** Where new heads are prepared, one worktree per head. */
	worktreesRoot: string;
	/** The daemon's entry, relative to a checkout. */
	entry: string;
	/** Arguments after the entry, kept across the re-exec. */
	args: readonly string[];
	execPath: string;
	execArgv: readonly string[];
	env: Readonly<Record<string, string | undefined>>;
	/** `git <args>` in `cwd`; resolves with its standard output. */
	git: (args: readonly string[], cwd: string) => Promise<string>;
	/** Runs one preparation command in `cwd`; rejects when it fails. */
	run: (
		command: string,
		args: readonly string[],
		cwd: string,
		env: Readonly<Record<string, string | undefined>>,
	) => Promise<void>;
	/** No lease, launch, warm start, deps build or collection in progress. */
	idle: () => boolean | Promise<boolean>;
	/**
	 * Stops the daemon with the `handoff` mode and resolves once it has
	 * stopped, without exiting the process.
	 */
	stop: () => Promise<void>;
	/** `process.execve`, or nothing on a Node that does not have it. */
	execve:
		| ((
				file: string,
				args: readonly string[],
				env: Readonly<Record<string, string | undefined>>,
		  ) => never)
		| undefined;
	/** Last resort when neither the new nor the old code can be exec'd. */
	exit: (code: number) => never;
	log: (event: string, fields?: Fields) => void;
	now?: () => number;
}>;

/** An error's message, short enough for a log field. */
function describe(error: Error | string): string {
	return (error instanceof Error ? error.message : error).slice(0, 500);
}

/** Worktree paths `git worktree list --porcelain` names. */
export function worktreePaths(porcelain: string): string[] {
	return porcelain
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim());
}

export function createSelfUpdater(options: SelfUpdaterOptions) {
	const now = options.now ?? Date.now;
	const intervalMs = options.settings.intervalHours * 60 * 60_000;
	// The first look is one interval after start: a box that just started is
	// already on the code it was started with.
	let lastLookAtMs = now();
	let inFlight = false;
	const refusedUntil = new Map<string, number>();
	let prepared: string | undefined;
	let readyLogged: string | undefined;
	const git = (args: readonly string[], cwd = options.checkoutRoot) =>
		options.git(args, cwd);
	const worktreeFor = (head: string) => join(options.worktreesRoot, head);

	/** Removes earlier prepared worktrees; never the running checkout. */
	async function removeStale(): Promise<void> {
		let listed: string[];
		try {
			listed = worktreePaths(await git(["worktree", "list", "--porcelain"]));
		} catch {
			return;
		}
		for (const path of listed)
			if (
				path.startsWith(`${options.worktreesRoot}/`) &&
				path !== options.checkoutRoot
			)
				await git(["worktree", "remove", "--force", path]).catch(
					() => undefined,
				);
		await git(["worktree", "prune"]).catch(() => undefined);
	}

	async function prepare(head: string): Promise<boolean> {
		const dir = worktreeFor(head);
		await removeStale();
		const steps: readonly [SelfUpdateStep, () => Promise<void>][] = [
			[
				"worktree",
				async () => {
					await git(["worktree", "add", "--detach", dir, head]);
				},
			],
			[
				"install",
				() =>
					options.run(
						"pnpm",
						["install", "--frozen-lockfile"],
						dir,
						options.env,
					),
			],
			[
				"submodules",
				() =>
					options.run(
						"git",
						["submodule", "update", "--init", "--recursive"],
						dir,
						options.env,
					),
			],
			[
				"build",
				() =>
					options.run(
						"pnpm",
						[
							"exec",
							"turbo",
							"run",
							"build",
							"--filter=@hobo/ci-gh-actions",
							"--output-logs=errors-only",
						],
						dir,
						options.env,
					),
			],
			[
				"self-check",
				() =>
					options.run(
						options.execPath,
						[
							...options.execArgv,
							join(dir, options.entry),
							SELF_CHECK_ARGUMENT,
						],
						dir,
						// Built just above: the entry does not build again.
						{ ...options.env, HOBO_CI_WORKER_BUILD: "0" },
					),
			],
		];
		log("hobo_ci_self_update_preparing", { head, worktree: dir });
		for (const [step, perform] of steps) {
			try {
				await perform();
			} catch (error) {
				const until = now() + SELF_UPDATE_REFUSAL_HOLD_MS;
				refusedUntil.set(head, until);
				log("hobo_ci_self_update_refused", {
					head,
					step,
					message: describe(error instanceof Error ? error : String(error)),
					retryAfter: new Date(until).toISOString(),
				});
				await git(["worktree", "remove", "--force", dir]).catch(
					() => undefined,
				);
				return false;
			}
		}
		return true;
	}

	function log(event: string, fields: Fields = {}): void {
		options.log(event, {
			from: options.currentCommit ?? "unknown",
			...fields,
		});
	}

	/** Stops with `handoff` and replaces this process with the new code. */
	async function restart(head: string): Promise<never> {
		const execve = options.execve;
		if (!execve) throw new Error("execve unavailable");
		const dir = worktreeFor(head);
		log("hobo_ci_self_update_restarting", { head, worktree: dir });
		await options.stop();
		const argv = (root: string) => [
			options.execPath,
			...options.execArgv,
			join(root, options.entry),
			...options.args,
		];
		try {
			return execve(options.execPath, argv(dir), options.env);
		} catch (error) {
			log("hobo_ci_self_update_exec_failed", {
				head,
				message: describe(error instanceof Error ? error : String(error)),
			});
		}
		// The daemon has stopped: start the code it was running, in place.
		try {
			return execve(options.execPath, argv(options.checkoutRoot), options.env);
		} catch (error) {
			log("hobo_ci_self_update_exec_failed", {
				head: options.currentCommit ?? "unknown",
				message: describe(error instanceof Error ? error : String(error)),
			});
		}
		return options.exit(1);
	}

	async function look(): Promise<SelfUpdateOutcome> {
		const current = options.currentCommit;
		if (current === undefined || !SHA.test(current)) {
			log("hobo_ci_self_update_skipped", { reason: "commit-unknown" });
			return "commit-unknown";
		}
		let head: string;
		try {
			await git([
				"fetch",
				"--quiet",
				"--no-tags",
				"origin",
				"+refs/heads/main:refs/remotes/origin/main",
			]);
			head = (
				await git([
					"rev-parse",
					"--verify",
					"refs/remotes/origin/main^{commit}",
				])
			).trim();
			if (!SHA.test(head)) throw new Error("main is not a commit");
		} catch (error) {
			log("hobo_ci_self_update_check_failed", {
				message: describe(error instanceof Error ? error : String(error)),
			});
			return "fetch-failed";
		}
		if (head === current) return "current";
		if ((refusedUntil.get(head) ?? 0) > now()) return "held";
		if (prepared === head) return "ready";
		// Forward along main's first-parent line only: the oldest commit main
		// added since `current` must have `current` as its first parent.
		const added = (
			await git(["rev-list", "--first-parent", `${current}..${head}`]).catch(
				() => "",
			)
		)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => SHA.test(line));
		const oldest = added.at(-1);
		const parent =
			oldest === undefined
				? undefined
				: (
						await git(["rev-parse", "--verify", `${oldest}^1`]).catch(() => "")
					).trim();
		if (parent !== current) {
			log("hobo_ci_self_update_skipped", { head, reason: "off-main" });
			return "off-main";
		}
		const changed = (
			await git([
				"diff",
				"--name-only",
				current,
				head,
				"--",
				...SELF_UPDATE_PATHS,
			]).catch(() => undefined)
		)
			?.split("\n")
			.filter((line) => line.trim() !== "");
		if (changed === undefined) {
			log("hobo_ci_self_update_check_failed", {
				head,
				message: "cannot compare the daemon's paths",
			});
			return "fetch-failed";
		}
		if (changed.length === 0) {
			log("hobo_ci_self_update_skipped", { head, reason: "unchanged" });
			return "unchanged";
		}
		if (!(await prepare(head))) return "refused";
		prepared = head;
		return "ready";
	}

	return {
		/**
		 * One look, when it is due and the box is idle. Resolves with what it
		 * found; on a restart it never resolves (the process is replaced).
		 */
		async tick(): Promise<SelfUpdateOutcome> {
			if (!options.settings.enabled) return "disabled";
			if (inFlight) return "in-progress";
			inFlight = true;
			try {
				// A prepared head waits only for an idle box; without execve it
				// is not started at all, so main is looked at again on schedule.
				const waiting = prepared !== undefined && options.execve !== undefined;
				if (!waiting && now() - lastLookAtMs < intervalMs) return "not-due";
				if (!(await options.idle())) return "busy";
				if (!waiting) {
					lastLookAtMs = now();
					const outcome = await look();
					if (outcome !== "ready") return outcome;
				}
				const head = prepared;
				if (head === undefined) return "not-due";
				if (!options.execve) {
					if (readyLogged !== head) {
						readyLogged = head;
						log("hobo_ci_self_update_ready", {
							head,
							worktree: worktreeFor(head),
							reason: "execve-unavailable",
						});
					}
					return "ready";
				}
				// Preparation takes minutes: start the new code only while the
				// box is still idle, or at the next idle look.
				if (!(await options.idle())) return "busy";
				await restart(head);
				return "restarting";
			} finally {
				inFlight = false;
			}
		},
	};
}
