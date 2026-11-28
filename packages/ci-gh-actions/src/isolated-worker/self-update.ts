import { join } from "node:path";

export const SELF_UPDATE_PATHS: readonly string[] = Object.freeze([
	".hobo/ci.json",
	"packages/backend-routing",
	"packages/bindles",
	"packages/broker",
	"packages/ci",
	"packages/ci-gh-actions",
	"packages/contracts",
	"packages/core",
	"packages/data-core",
	"packages/dispatcher",
	"packages/fleet",
	"packages/fleet-agent",
	"packages/fleet-nats",
	"packages/policy",
	"packages/pricing",
	"packages/provider-redaction",
	"packages/providers/provider-cedar",
	"packages/providers/provider-opa",
	"pnpm-lock.yaml",
	"scripts/lib/ci-runner-contract.mts",
	"scripts/lib/deps-key.mts",
]);
export const SELF_UPDATE_REFUSAL_HOLD_MS = 24 * 60 * 60_000;
export const SELF_UPDATE_CHECK_MS = 10 * 60_000;
// public-contract: the path a self-update re-execs; it moves only with the daemon.
export const SELF_UPDATE_DEFAULT_ENTRY =
	"packages/ci-gh-actions/scripts/isolated-worker-daemon.mts";
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
	checkoutRoot: string;
	currentCommit: string | undefined;
	worktreesRoot: string;
	entry: string;
	args: readonly string[];
	execPath: string;
	execArgv: readonly string[];
	env: Readonly<Record<string, string | undefined>>;
	git: (args: readonly string[], cwd: string) => Promise<string>;
	run: (
		command: string,
		args: readonly string[],
		cwd: string,
		env: Readonly<Record<string, string | undefined>>,
	) => Promise<void>;
	idle: () => boolean | Promise<boolean>;
	stop: () => Promise<void>;
	execve:
		| ((
				file: string,
				args: readonly string[],
				env: Readonly<Record<string, string | undefined>>,
		  ) => never | Promise<never>)
		| undefined;
	exit: (code: number) => never;
	log: (event: string, fields?: Fields) => void;
	now?: () => number;
}>;

function describe(error: Error | string): string {
	return (error instanceof Error ? error.message : error).slice(0, 500);
}

export function worktreePaths(porcelain: string): string[] {
	return porcelain
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim());
}

export function createSelfUpdater(options: SelfUpdaterOptions) {
	const now = options.now ?? Date.now;
	const intervalMs = options.settings.intervalHours * 60 * 60_000;
	let lastLookAtMs = now();
	let inFlight = false;
	const refusedUntil = new Map<string, number>();
	let prepared: string | undefined;
	let readyLogged: string | undefined;
	const git = (args: readonly string[], cwd = options.checkoutRoot) =>
		options.git(args, cwd);
	const worktreeFor = (head: string) => join(options.worktreesRoot, head);

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
		async tick(): Promise<SelfUpdateOutcome> {
			if (!options.settings.enabled) return "disabled";
			if (inFlight) return "in-progress";
			inFlight = true;
			try {
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
				if (!(await options.idle())) return "busy";
				await restart(head);
				return "restarting";
			} finally {
				inFlight = false;
			}
		},
	};
}
