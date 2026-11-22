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

async function gitCheckoutAbove(path: string): Promise<string | undefined> {
	let current = path;
	for (;;) {
		if (await exists(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

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
