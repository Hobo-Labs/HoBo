/**
 * Which places a program may be taken from, and which directories a program
 * may be found through. The store passphrase goes to `opensesame`, and
 * OpenSesame's first act is to run a bare `node`, so both lookups are decisions
 * about where code the caller did not write may sit.
 *
 * A place is trusted when:
 *
 * - it resolves (through every symlink) to something that exists;
 * - neither the place nor where it resolves is under a `node_modules/.bin`
 *   directory, where a dependency can name a program anything;
 * - it is not inside the working directory's tree, which a checkout controls
 *   (unless the working directory is the filesystem root or the home directory,
 *   which are not projects);
 * - on a system with users (not Windows), the place and every directory above it
 *   belong to the effective user or to root, and only they can write: nothing is
 *   writable by group or others, except a sticky directory (`/tmp`) whose owner
 *   is the user or root, in which others can add files but not replace ours.
 *
 * What this does not check: the contents of the place, ACLs and extended
 * attributes, a mount that lies about modes (WSL's `/mnt/c`, FAT: every file
 * looks 0777 and is refused), or that a trusted place stays trusted between the
 * check and the use. A swap in that gap needs write access to the place or to a
 * directory above it, which is what the rule refuses.
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { OpenSesameAdapterError } from "./errors.js";

/** What the rule reads of one file or directory. */
export type EntryStat = Readonly<{
	uid: number;
	mode: number;
	directory: boolean;
}>;

/** The file system as the rule sees it; tests supply a tree in memory. */
export interface TrustFs {
	/** Where `path` ends once every symlink is followed, or `undefined` when it does not exist. */
	realpath(path: string): string | undefined;
	/** Owner and mode of what `path` ends at, or `undefined`. */
	stat(path: string): EntryStat | undefined;
}

export type Trust = Readonly<{
	fs: TrustFs;
	/** The effective uid; `undefined` where there are none (Windows), and then no owner or mode is checked. */
	euid: number | undefined;
	cwd: string;
	home: string;
}>;

const nodeFs: TrustFs = {
	realpath(target) {
		try {
			return realpathSync(target);
		} catch {
			return undefined;
		}
	},
	stat(target) {
		try {
			const stats = statSync(target);
			return {
				uid: stats.uid,
				mode: stats.mode,
				directory: stats.isDirectory(),
			};
		} catch {
			return undefined;
		}
	},
};

/** This process's file system, user, working directory and home. */
export function nodeTrust(): Trust {
	return {
		fs: nodeFs,
		euid: process.geteuid?.(),
		cwd: process.cwd(),
		home: homedir(),
	};
}

const STICKY = 0o1000;
const GROUP_OR_OTHERS_WRITE = 0o022;
const SAFE_POSIX_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];

function hasNodeModulesBin(target: string): boolean {
	const parts = target.split(/[\\/]/u);
	return parts.some(
		(part, at) => part === "node_modules" && parts[at + 1] === ".bin",
	);
}

function insideProject(real: string, trust: Trust): boolean {
	const cwd = trust.fs.realpath(trust.cwd) ?? trust.cwd;
	const home = trust.fs.realpath(trust.home) ?? trust.home;
	if (cwd === home || path.parse(cwd).root === cwd) return false;
	return real === cwd || real.startsWith(`${cwd}${path.sep}`);
}

/** `real`, then each directory above it up to the root. */
function chain(real: string): string[] {
	const out = [real];
	for (
		let at = path.dirname(real);
		at !== out[out.length - 1];
		at = path.dirname(at)
	) {
		out.push(at);
	}
	return out;
}

/** Why `target` is not a trusted place, or `undefined` when it is. */
export function placeProblem(target: string, trust: Trust): string | undefined {
	const real = trust.fs.realpath(target);
	if (real === undefined) return `${target} does not exist`;
	if (hasNodeModulesBin(target) || hasNodeModulesBin(real)) {
		return `${target} is under a node_modules/.bin directory, where a dependency can put a program of any name`;
	}
	if (insideProject(real, trust)) {
		return `${target} is inside the working directory's tree, which a checkout controls`;
	}
	if (trust.euid === undefined) return undefined;
	for (const place of chain(real)) {
		const stats = trust.fs.stat(place);
		if (stats === undefined) return `${place} cannot be inspected`;
		if (stats.uid !== trust.euid && stats.uid !== 0) {
			return `${place} is owned by another user`;
		}
		const writable = (stats.mode & GROUP_OR_OTHERS_WRITE) !== 0;
		const sticky = stats.directory && (stats.mode & STICKY) !== 0;
		if (writable && !sticky) return `${place} is writable by group or others`;
	}
	return undefined;
}

/** The absolute, non-empty entries of a PATH, in order. */
export function absolutePathEntries(
	pathValue: string | undefined,
	platform: NodeJS.Platform,
): string[] {
	const flavour = platform === "win32" ? path.win32 : path.posix;
	return (pathValue ?? "")
		.split(flavour.delimiter)
		.filter((entry) => entry !== "" && flavour.isAbsolute(entry));
}

/** The system directories a PATH falls back to when none of the caller's passes; each is held to the same rule. */
function defaultPath(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): string[] {
	if (platform !== "win32") return SAFE_POSIX_PATH;
	const root = env.SYSTEMROOT ?? env.SystemRoot ?? "C:\\Windows";
	return [`${root}\\System32`, root];
}

/**
 * Whether others can put a new name in `directory`. Sticky stops them removing
 * or renaming a name, not adding one, so a sticky `/tmp` that is fine above a
 * file is not fine as a directory a program is looked up in by name.
 */
function othersCanAdd(directory: string, trust: Trust): boolean {
	if (trust.euid === undefined) return false;
	const mode = trust.fs.stat(directory)?.mode;
	return mode === undefined || (mode & GROUP_OR_OTHERS_WRITE) !== 0;
}

/** The entries that pass the rule, each as it resolves, none twice. */
function trustedEntries(entries: readonly string[], trust: Trust): string[] {
	const kept: string[] = [];
	for (const entry of entries) {
		if (trust.fs.stat(entry)?.directory !== true) continue;
		if (placeProblem(entry, trust) !== undefined) continue;
		const real = trust.fs.realpath(entry);
		if (real === undefined || othersCanAdd(real, trust)) continue;
		if (!kept.includes(real)) kept.push(real);
	}
	return kept;
}

/**
 * The PATH a run is started with: the caller's, reduced to the absolute
 * directories that exist, are trusted places and that only their owner can add
 * a file to (a sticky `/tmp` is not one), each written as it resolves and none
 * twice. An empty or relative entry means the working directory, and an older
 * OpenSesame's first act is a bare `node` lookup with the store passphrase in
 * its environment. When nothing is left, the fixed system directories, reduced
 * the same way: `/usr/local/bin` is exactly the directory a hosted image or an
 * Intel Homebrew leaves open to all, and the fallback is no way around the rule.
 * When not even those pass there is no PATH to give: an empty one makes the
 * lookup search the working directory, so the run is refused
 * (`bridge_missing`) before anything is started or any passphrase is passed.
 */
export function trustedPath(
	pathValue: string | undefined,
	trust: Trust,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): string {
	const flavour = platform === "win32" ? path.win32 : path.posix;
	const mine = trustedEntries(absolutePathEntries(pathValue, platform), trust);
	const kept =
		mine.length > 0
			? mine
			: trustedEntries(
					absolutePathEntries(
						defaultPath(platform, env).join(flavour.delimiter),
						platform,
					),
					trust,
				);
	if (kept.length === 0) {
		throw new OpenSesameAdapterError(
			"bridge_missing",
			"no directory is left to look `node` up in: every entry of PATH is empty, relative, missing or in a place others could have written, and so is each system directory (/usr/local/bin, /usr/bin, /bin; on Windows SystemRoot's System32 and SystemRoot). Nothing was started and the store passphrase went nowhere. Put `opensesame` and `node` in a directory only you and root can write, and put that directory on PATH",
		);
	}
	return kept.join(flavour.delimiter);
}
