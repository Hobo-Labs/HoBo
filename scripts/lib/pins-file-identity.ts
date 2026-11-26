/**
 * Whether two paths name one file, and whether a path lies in a directory,
 * decided by identity (device and inode) rather than by comparing strings.
 * realpathSync resolves symbolic links and `..`, but not a bind mount, a
 * hard link, or a second spelling on a case-insensitive filesystem
 * (`.GIT` for `.git` on macOS or Windows): those name one file under two
 * paths that no string comparison sees as equal.
 *
 * Erasable TypeScript with node builtins only.
 */
import { statSync } from "node:fs";
import { dirname } from "node:path";

/** Device and inode of what `path` names (links followed), or null when it cannot be read. */
function identity(path: string): string | null {
	try {
		const { dev, ino } = statSync(path, { bigint: true });
		return `${dev}:${ino}`;
	} catch {
		return null;
	}
}

/** Whether both paths name one existing file or directory. */
export function sameFile(left: string, right: string): boolean {
	const one = identity(left);
	return one !== null && one === identity(right);
}

/** Whether `path` is `dir` or below it: each of `path`'s parents is compared with `dir` by identity. */
export function inside(path: string, dir: string): boolean {
	const target = identity(dir);
	if (target === null) return false;
	for (let at = path; ; at = dirname(at)) {
		if (identity(at) === target) return true;
		if (dirname(at) === at) return false;
	}
}
