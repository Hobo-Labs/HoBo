import { existsSync, lstatSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

import { inside, sameFile } from "./pins-file-identity.ts";
import { git, Refusal, sameRepo, shellWord } from "./pins-git-core.ts";
import {
	gitIgnoresName,
	type ModulesEntry,
	modulesEntry,
	modulesSectionNames,
} from "./pins-gitmodules.ts";

function realOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export function headOf(root: string, path: string): string | null {
	refuseLinkedPath(root, path);
	const sub = join(root, path);
	if (!existsSync(join(sub, ".git"))) return null;
	const top = git(sub, ["rev-parse", "--show-toplevel"]);
	if (top.status !== 0 || realOr(top.stdout) !== join(realOr(root), path)) {
		const answer =
			top.status === 0
				? `git answers for ${top.stdout} instead`
				: `git says: ${top.stderr.split("\n")[0] ?? ""}`;
		throw new Refusal(
			"SUBMODULE_STATE",
			`${path}/.git is not a usable repository of its own (${answer}); nothing is run in it`,
			moveAside(root, path),
		);
	}
	refuseSharedRepository(root, path, sub);
	refuseForeignRepository(root, path, sub);
	const result = git(sub, ["rev-parse", "--verify", "HEAD"]);
	return result.status === 0 ? result.stdout : null;
}

function moveAside(root: string, path: string): string {
	const target = freeName(root, `${path}.kept`);
	return `mv ${shellWord(path)} ${shellWord(target)} && git submodule update --init -- ${shellWord(path)}   (keeps the old checkout, and any work in it, at ${target})`;
}

function freeName(root: string, base: string): string {
	for (let count = 0; ; count += 1) {
		const name = count === 0 ? base : `${base}.${count}`;
		if (!existsAsLink(join(root, name))) return name;
	}
}

function existsAsLink(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function commonDir(dir: string): string | null {
	const result = git(dir, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	return result.status === 0 ? realOr(result.stdout) : null;
}

function refuseSharedRepository(root: string, path: string, sub: string): void {
	const shared = commonDir(sub);
	const own = commonDir(root);
	if (shared === null || own === null || !sameFile(shared, own)) return;
	throw new Refusal(
		"SUBMODULE_STATE",
		`${path}/.git names the superproject's own repository (${shared}); nothing is run in it`,
		moveAside(root, path),
	);
}

interface Repository {
	readonly gitDir: string;
	readonly common: string;
}

function repositoryOf(dir: string): Repository | null {
	const result = git(dir, [
		"rev-parse",
		"--absolute-git-dir",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	const [gitDir, common] = result.stdout.split("\n");
	if (result.status !== 0 || gitDir === undefined || common === undefined)
		return null;
	return { gitDir: realOr(gitDir), common: realOr(common) };
}

interface Foreign {
	readonly reason: string;
	readonly fix: string;
}

function foreignReason(
	root: string,
	path: string,
	sub: Repository,
): Foreign | null {
	const fix = moveAside(root, path);
	if (!sameFile(sub.common, sub.gitDir))
		return {
			reason: `is a linked worktree of the repository at ${sub.common}`,
			fix,
		};
	if (sameFile(sub.gitDir, join(root, path, ".git"))) return null;
	const owner = repositoryOf(root);
	const entry = entryOf(root, path);
	const modules =
		owner === null || entry === undefined
			? null
			: realOr(join(owner.gitDir, "modules", entry.name));
	if (modules !== null && sameFile(sub.gitDir, modules)) return null;
	if (basename(sub.gitDir).toLowerCase() === ".git")
		return {
			reason: `is the repository of another working tree (${dirname(sub.gitDir)})`,
			fix,
		};
	if (owner === null || entry === undefined || modules === null) return null;
	if (!insideEither(sub.gitDir, owner)) return null;
	const moduleDirs = join(owner.gitDir, "modules");
	const named = moduleNameOf(moduleDirs, sub.gitDir);
	const claimed =
		named !== null &&
		named !== entry.name &&
		modulesSectionNames(root).includes(named)
			? named
			: null;
	const theirs = !originIs(root, sub.gitDir, entry.url);
	if (
		!theirs &&
		claimed === null &&
		inside(sub.gitDir, moduleDirs) &&
		worktreeIs(root, sub.gitDir, path)
	)
		return null;
	if (theirs)
		return {
			reason: `belongs to another repository: its remote.origin.url is not ${entry.url}, the URL .gitmodules gives ${path}`,
			fix,
		};
	if (claimed !== null)
		return {
			reason: `is the module directory of the .gitmodules section "${claimed}", which git's update of that section would take over`,
			fix,
		};
	return {
		reason: `is inside the superproject's git directory but is not this submodule's (${modules})`,
		fix: existsSync(modules) ? fix : (renameFix(entry.name, named) ?? fix),
	};
}

function insideEither(gitDir: string, owner: Repository): boolean {
	return [owner.gitDir, owner.common].some((dir) => inside(gitDir, dir));
}

function originIs(root: string, gitDir: string, wanted: string): boolean {
	const origin = git(root, [
		"config",
		"-z",
		"-f",
		join(gitDir, "config"),
		"--includes",
		"--get-all",
		"remote.origin.url",
	]);
	const urls = origin.stdout.split("\0").slice(0, -1);
	return (
		origin.status === 0 && urls.length === 1 && sameRepo(urls[0] ?? "", wanted)
	);
}

function worktreeIs(root: string, gitDir: string, path: string): boolean {
	const set = git(root, [
		"config",
		"-f",
		join(gitDir, "config"),
		"--get",
		"core.worktree",
	]);
	return (
		set.status === 0 && sameFile(resolve(gitDir, set.stdout), join(root, path))
	);
}

function moduleNameOf(moduleDirs: string, gitDir: string): string | null {
	const name = relative(realOr(moduleDirs), gitDir).split(sep).join("/");
	return name === "" || name.startsWith("..") || isAbsolute(name) ? null : name;
}

function renameFix(name: string, other: string | null): string | null {
	if (other === null || gitIgnoresName(other)) return null;
	return `git config -f .gitmodules --rename-section ${shellWord(`submodule.${name}`)} ${shellWord(`submodule.${other}`)}`;
}

function entryOf(root: string, path: string): ModulesEntry | undefined {
	try {
		return modulesEntry(root, path) ?? undefined;
	} catch (error) {
		if (error instanceof Refusal) return undefined;
		throw error;
	}
}

function refuseForeignRepository(
	root: string,
	path: string,
	dir: string,
): void {
	const sub = repositoryOf(dir);
	if (sub === null) return;
	const foreign = foreignReason(root, path, sub);
	if (foreign === null) return;
	throw new Refusal(
		"SUBMODULE_STATE",
		`${path}/.git names ${sub.gitDir}, which ${foreign.reason}; nothing is run in it`,
		foreign.fix,
	);
}

function linkOnPath(root: string, path: string): string | null {
	const parts = path.split("/");
	for (let end = 1; end <= parts.length; end += 1) {
		const prefix = parts.slice(0, end).join("/");
		try {
			if (lstatSync(join(root, prefix)).isSymbolicLink()) return prefix;
		} catch {
			return null;
		}
	}
	return null;
}

function refuseLinkedPath(root: string, path: string): void {
	const link = linkOnPath(root, path);
	if (link === null) {
		if (linkOnPath(root, `${path}/.git`) === `${path}/.git`) {
			throw new Refusal(
				"SUBMODULE_STATE",
				`${path}/.git is a symbolic link; a submodule's .git is its own, so nothing is run in it`,
				moveAside(root, path),
			);
		}
		return;
	}
	throw new Refusal(
		"SUBMODULE_STATE",
		`${link} is a symbolic link; ${path} must be a directory of this checkout, so nothing is run in it`,
		link === path
			? `rm ${path} && git submodule update --init -- ${path}`
			: `rm ${link} && git checkout -- ${link} && git submodule update --init -- ${path}`,
	);
}
