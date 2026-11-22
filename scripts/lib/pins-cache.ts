import { lstatSync, readdirSync, rmSync } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { PinsError } from "./pins.ts";
import { isLivePartial, partialOwner } from "./pins-partial.ts";

export interface DirInfo {
	readonly uid: number;
	readonly mode: number;
	readonly directory: boolean;
}

export interface DirProblem {
	readonly problem: string;
	readonly fix: string;
}

export function dirProblem(
	info: DirInfo,
	uid: number,
	path: string,
): DirProblem | null {
	if (!info.directory) {
		return { problem: `${path} is not a directory`, fix: `remove ${path}` };
	}
	if (info.uid !== uid) {
		return {
			problem: `${path} is owned by uid ${info.uid}, not by you (uid ${uid})`,
			fix: "set XDG_CACHE_HOME to a directory you own",
		};
	}
	if ((info.mode & 0o022) !== 0) {
		return {
			problem: `${path} is writable by group or others`,
			fix: `chmod go-w ${path}`,
		};
	}
	return null;
}

async function problemAt(path: string): Promise<DirProblem | null> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
	const uid = process.getuid?.() ?? info.uid;
	return dirProblem(
		{ uid: info.uid, mode: info.mode, directory: info.isDirectory() },
		uid,
		path,
	);
}

export async function cacheProblem(
	cache: string,
	sha256?: string,
): Promise<DirProblem | null> {
	return (
		(await problemAt(cache)) ??
		(sha256 === undefined ? null : await problemAt(join(cache, sha256)))
	);
}

const MIN_AGE_MS = 60_000;
const MAX_AGE_MS = 3_600_000;

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function abandoned(
	path: string,
	pid: number,
	age: number,
	alive: (pid: number) => boolean,
): boolean {
	if (age <= MIN_AGE_MS || isLivePartial(path)) return false;
	return age > MAX_AGE_MS || pid === process.pid || !alive(pid);
}

export function sweepProbes(cache: string, now: number = Date.now()): string[] {
	const removed: string[] = [];
	let names: string[];
	try {
		names = readdirSync(cache);
	} catch {
		return removed;
	}
	const uid = process.getuid?.();
	for (const name of names) {
		if (!name.startsWith(".probe-")) continue;
		const path = join(cache, name);
		try {
			const info = lstatSync(path);
			const mine = uid === undefined || info.uid === uid;
			if (info.isDirectory() && mine && now - info.mtimeMs > MAX_AGE_MS) {
				rmSync(path, { recursive: true, force: true });
				removed.push(path);
			}
		} catch {}
	}
	return removed;
}

export async function sweepPartials(
	cache: string,
	now: number = Date.now(),
	alive: (pid: number) => boolean = pidAlive,
): Promise<string[]> {
	const removed: string[] = sweepProbes(cache, now);
	let dirs: string[];
	try {
		dirs = await readdir(cache);
	} catch {
		return removed;
	}
	for (const dir of dirs) {
		if (dir.startsWith(".probe-")) continue;
		let names: string[];
		try {
			names = await readdir(join(cache, dir));
		} catch {
			continue;
		}
		for (const name of names) {
			const pid = partialOwner(name);
			if (pid === null) continue;
			const path = join(cache, dir, name);
			try {
				const age = now - (await lstat(path)).mtimeMs;
				if (abandoned(path, pid, age, alive)) {
					await rm(path, { force: true });
					removed.push(path);
				}
			} catch {}
		}
	}
	return removed;
}

export async function prepareCache(
	cache: string,
	sha256?: string,
): Promise<void> {
	try {
		await mkdir(cache, { recursive: true, mode: 0o700 });
	} catch (error) {
		const exists =
			error instanceof Error && "code" in error && error.code === "EEXIST";
		if (!exists) throw error;
	}
	const unsafe = await cacheProblem(cache, sha256);
	if (unsafe !== null) {
		throw new PinsError(
			"CACHE_UNSAFE",
			`${unsafe.problem}; the cache holds executables, so nothing is written to it. fix: ${unsafe.fix}`,
		);
	}
	await sweepPartials(cache);
}
