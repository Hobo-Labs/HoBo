// The key directory rules of design §6.4: never inside a git checkout, mode
// 0700, never writable by group or others, owned by the user running the agent;
// every file in it 0600 and replaced atomically. On Windows, POSIX modes do not
// exist and only the git-checkout rule applies (the directory inherits the
// user profile's ACL).
import { randomBytes } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const posix = process.platform !== "win32";
const GROUP_OR_OTHERS_WRITE = 0o022;
const GROUP_OR_OTHERS_ANY = 0o077;

function isMissing(error: Error): boolean {
	return "code" in error && error.code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && isMissing(error)) return false;
		throw error;
	}
}

/** The nearest directory at or above `path` holding a `.git` entry (a directory, or a worktree's file). */
async function gitCheckoutAbove(path: string): Promise<string | undefined> {
	let current = path;
	for (;;) {
		if (await exists(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * Makes `home` usable as a key directory, creating it `0700` when absent, and
 * answers its absolute path. Refuses a directory inside a git checkout, one
 * group or others can write, and one another user owns. An existing directory
 * nobody else can write is tightened to `0700`.
 */
export async function prepareKeyDirectory(home: string): Promise<string> {
	const absolute = resolve(home);
	const checkout = await gitCheckoutAbove(absolute);
	if (checkout !== undefined)
		throw new Error(
			`the key directory ${absolute} is inside the git checkout ${checkout}; set HOBO_FLEET_HOME outside it`,
		);
	await mkdir(absolute, { recursive: true, mode: 0o700 });
	const info = await stat(absolute);
	if (!info.isDirectory())
		throw new Error(`the key directory ${absolute} is not a directory`);
	if (!posix) return absolute;
	if ((info.mode & GROUP_OR_OTHERS_WRITE) !== 0)
		throw new Error(
			`the key directory ${absolute} is writable by group or others (mode ${(info.mode & 0o777).toString(8)}); refusing to load keys from it`,
		);
	const uid = process.getuid?.();
	if (uid !== undefined && info.uid !== uid)
		throw new Error(
			`the key directory ${absolute} is owned by another user (uid ${info.uid})`,
		);
	if ((info.mode & 0o777) !== 0o700) await chmod(absolute, 0o700);
	return absolute;
}

/**
 * Reads a private file of the key directory, or answers undefined when it is
 * absent. Refuses a file group or others can read or write.
 */
export async function readPrivateFile(
	path: string,
): Promise<string | undefined> {
	let text: string;
	try {
		if (posix) {
			const info = await lstat(path);
			if (!info.isFile())
				throw new Error(`the key file ${path} is not a regular file`);
			if ((info.mode & GROUP_OR_OTHERS_ANY) !== 0)
				throw new Error(
					`the key file ${path} has permissions ${(info.mode & 0o777).toString(8)}; it must be 0600`,
				);
		}
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && isMissing(error)) return undefined;
		throw error;
	}
	return text;
}

/** Atomic replace: a `0600` temporary file beside `path`, flushed, then renamed over it. */
export async function writePrivateFile(
	path: string,
	text: string,
): Promise<void> {
	const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(text, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		if (posix) await chmod(temporary, 0o600);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function removePrivateFile(path: string): Promise<void> {
	await rm(path, { force: true });
}
