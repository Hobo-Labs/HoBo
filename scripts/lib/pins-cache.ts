/**
 * The cache directory's hygiene. It holds executables that a later command
 * runs, so it is created private (0700), refused when it is not the user's
 * own and closed to others, and swept of the partial files a dead download
 * left behind. (A download killed by a signal removes its own; this is for the
 * ones that were killed harder.)
 *
 * Erasable TypeScript with node builtins only.
 */
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

/** What is wrong with a cache directory, given what `lstat` says about it. */
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

/** The first thing wrong with the cache root or, when given, one digest directory. */
export async function cacheProblem(
	cache: string,
	sha256?: string,
): Promise<DirProblem | null> {
	return (
		(await problemAt(cache)) ??
		(sha256 === undefined ? null : await problemAt(join(cache, sha256)))
	);
}

/** A partial file younger than this may be a download that is just starting. */
const MIN_AGE_MS = 60_000;
/**
 * A live download writes, or gives up, long before this: every network wait is
 * bounded by HOBO_PINS_NET_TIMEOUT_MS (at most ten minutes). Past it a partial
 * file is a leftover whatever its pid says, which a reused pid cannot fake.
 */
const MAX_AGE_MS = 3_600_000;

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/**
 * Whether a partial file `age` ms old, named after `pid`, belongs to nobody.
 * This process knows its own live downloads, so a file named after its own pid
 * that is not one of them (a killed run that was also pid 1) is a leftover; for
 * another pid, a live process keeps the file until the age bound.
 */
function abandoned(
	path: string,
	pid: number,
	age: number,
	alive: (pid: number) => boolean,
): boolean {
	if (age <= MIN_AGE_MS || isLivePartial(path)) return false;
	return age > MAX_AGE_MS || pid === process.pid || !alive(pid);
}

/**
 * Remove the throwaway probe repositories (`.probe-*`, `pins-git-probe.ts`)
 * that a killed run left in the cache root: only real directories (a link is
 * never followed or removed), only the user's own, only older than an hour
 * (no probe runs that long: its git call has a deadline of at most ten
 * minutes). Synchronous, so the git-only verbs can call it too.
 */
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
		} catch {
			// Gone between the listing and now.
		}
	}
	return removed;
}

/**
 * Remove the `*.partial` files no live download is writing: older than a
 * minute and either older than an hour or named after a process that is gone.
 * Lock-free: nothing is held, and a reused pid only delays a sweep, by at most
 * the hour.
 */
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
			} catch {
				// Gone between the listing and now: nothing to sweep.
			}
		}
	}
	return removed;
}

/**
 * Make the cache ready to write: create it private if it is missing, refuse it
 * if it is not safe, and sweep what a dead download left.
 */
export async function prepareCache(
	cache: string,
	sha256?: string,
): Promise<void> {
	try {
		await mkdir(cache, { recursive: true, mode: 0o700 });
	} catch (error) {
		// A file where the directory belongs is reported below, not thrown as EEXIST.
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
