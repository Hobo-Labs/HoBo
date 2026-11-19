import { resolve } from "node:path";

import { sameFile } from "./pins-file-identity.ts";
import { git, gitFailure, sameRepo, shellWord } from "./pins-git-core.ts";

export interface UrlProblem {
	readonly problem: string;
	readonly fix: string;
}

interface Setting {
	readonly scope: string;
	readonly origin: string;
	readonly value: string;
}

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
	readonly said: string;
	readonly why: string;
	readonly fix: string;
}

function includedFrom(scope: string): string {
	if (scope === "local") return "this clone's .git/config";
	if (scope === "worktree") return "config.worktree";
	if (scope === "command") return "the command line";
	return `the ${scope} configuration`;
}

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
