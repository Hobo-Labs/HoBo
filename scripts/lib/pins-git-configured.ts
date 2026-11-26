/**
 * The URL git's configuration gives a submodule, read the way
 * `git submodule update` reads it, and what to say when it is not the one
 * `.gitmodules` names: where it came from, and the fix that works there.
 *
 * Erasable TypeScript with node builtins only.
 */
import { resolve } from "node:path";

import { sameFile } from "./pins-file-identity.ts";
import { git, gitFailure, sameRepo, shellWord } from "./pins-git-core.ts";

/** A problem with the configured URL, and its fix. */
export interface UrlProblem {
	readonly problem: string;
	readonly fix: string;
}

/** One value of the key, as git lists it: the scope, the file (or the command line), the value. */
interface Setting {
	readonly scope: string;
	readonly origin: string;
	readonly value: string;
}

/**
 * Read with no scope, so every one is read, as `git submodule update` reads
 * them: the system and global files and what they include, this clone's own,
 * a worktree's `config.worktree`, and the command line (`git -c`, which a
 * child git gets as GIT_CONFIG_COUNT or GIT_CONFIG_PARAMETERS), the last one
 * winning. GIT_CONFIG is dropped, so nothing redirects the read;
 * `--show-scope` and `--show-origin` say where the fix goes, and `--get-all`
 * how many times the key is set there. An exit other than 0 (a value) or 1
 * (none set), a death by a signal included, is git failing to answer, and
 * that is a problem too, never "nothing is configured".
 */
export function configuredUrlProblem(
	root: string,
	path: string,
	name: string,
	wanted: string,
): UrlProblem | null {
	const key = `submodule.${name}.url`;
	const read = git(root, [
		"config",
		"-z",
		"--show-scope",
		"--show-origin",
		"--get-all",
		key,
	]);
	if (read.status !== 0 && read.status !== 1) {
		return {
			problem: `cannot read the URL git's configuration gives ${path} (${gitFailure("git config", read)})`,
			fix: `run git config --show-scope --show-origin --get-all ${shellWord(key)} to see why; the pins need git 2.31 or newer`,
		};
	}
	const fields = read.stdout.split("\0");
	const settings: Setting[] = [];
	for (let at = 0; at + 2 < fields.length; at += 3) {
		const [scope = "", origin = "", value = ""] = fields.slice(at, at + 3);
		settings.push({ scope, origin, value });
	}
	const last = settings.at(-1);
	if (last === undefined || sameRepo(last.value, wanted)) return null;
	const times = settings.filter((one) => one.origin === last.origin).length;
	const where = staleUrl(root, path, key, last, times);
	return {
		problem: `${where.said} ${last.value}, not ${wanted}${where.why}`,
		fix: where.fix,
	};
}

interface StaleUrl {
	/** Comes before the URL. */
	readonly said: string;
	/** Comes after the URL `.gitmodules` names. */
	readonly why: string;
	readonly fix: string;
}

/** What includes a file in `scope`'s configuration, in words. */
function includedFrom(scope: string): string {
	if (scope === "local") return "this clone's .git/config";
	if (scope === "worktree") return "config.worktree";
	if (scope === "command") return "the command line";
	return `the ${scope} configuration`;
}

/** The file a scope keeps itself, when `origin` is it. */
function isOwnFile(root: string, origin: string, own: string): boolean {
	if (!origin.startsWith("file:")) return false;
	const where = git(root, [
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		own,
	]);
	return (
		where.status === 0 &&
		sameFile(resolve(root, origin.slice("file:".length)), where.stdout)
	);
}

function staleUrl(
	root: string,
	path: string,
	key: string,
	last: Setting,
	times: number,
): StaleUrl {
	const sync = `git submodule sync -- ${path}`;
	const unsetAll = `--unset-all ${shellWord(key)}`;
	const file = last.origin.startsWith("file:")
		? last.origin.slice("file:".length)
		: undefined;
	if (last.scope === "local" && isOwnFile(root, last.origin, "config")) {
		// sync refuses a key set more than once ("multiple values").
		return times > 1
			? {
					said: `this clone's configured URL for ${path} is`,
					why: ` (set ${times} times in .git/config)`,
					fix: `git config ${unsetAll} && ${sync}`,
				}
			: {
					said: `this clone's configured URL for ${path} is`,
					why: ' (a stale "git submodule init")',
					fix: sync,
				};
	}
	// `config.worktree` is read after `.git/config`, so sync, which writes
	// the latter, would change nothing.
	if (
		last.scope === "worktree" &&
		isOwnFile(root, last.origin, "config.worktree")
	) {
		return {
			said: `this worktree's configured URL for ${path} (config.worktree) is`,
			why: "",
			fix: `git config --worktree ${unsetAll}`,
		};
	}
	if (last.scope === "global" || last.scope === "system") {
		// The file it is set in, which an `include.path` makes another file.
		const where =
			file === undefined ? `--${last.scope}` : `-f ${shellWord(file)}`;
		return {
			said: `the ${last.scope} git config sets the URL for ${path} to`,
			why: "",
			fix: `${sync}   (this clone's URL then overrides it; or: git config ${where} ${unsetAll})`,
		};
	}
	if (file !== undefined) {
		return {
			said: `the file ${file} (included from ${includedFrom(last.scope)}) sets the URL for ${path} to`,
			why: "",
			fix: `git config -f ${shellWord(file)} ${unsetAll}`,
		};
	}
	const from = "git -c, GIT_CONFIG_COUNT or GIT_CONFIG_PARAMETERS";
	return {
		said: `the command line (${from}) sets the URL for ${path} to`,
		why: "",
		fix: `drop ${key} from ${from}`,
	};
}
