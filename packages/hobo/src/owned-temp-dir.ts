/**
 * A temporary directory a process makes for itself and removes on every way
 * out a handler can reach. The default runtime keeps its throwaway event store
 * in one (`hobo-yard-*`), and the live Pulumi lane, without HOBO_PULUMI_WORKDIR,
 * its programs and state (`hobo-pulumi-live-*`); both were left in TMPDIR by
 * every run.
 *
 * - `ownedTempDir`, safe in any process: the directory is removed on the `exit`
 *   event, which a normal end and an uncaught error both reach. It touches no
 *   signal: a library does not decide how its host ends.
 * - `removeOwnedDirsOnSignals`, for a process's entry point only (`hobo`,
 *   `hobo-mcp`, and `hobo-code` when a /hobo verb loads the composition, through
 *   the export in cli.ts): also on SIGTERM, SIGHUP, SIGINT and SIGQUIT. When
 *   nothing else in the process listens for the signal, every owned directory
 *   is removed and the signal raised again with these handlers off, so the
 *   process still ends by it (status 128+n), as it would have. When something
 *   else listens (a server's graceful stop), that handler decides how the
 *   process ends, and `exit` removes the directories then. These handlers run
 *   before any other listener, so they also count one installed before them.
 *   Run after it, they missed a `once` handler, which is removed before it is
 *   called: hobo-code's shell installs its own before a /hobo verb loads the
 *   composition. Each handler knows its own signal: one emitted with
 *   `process.emit` carries no name. It does nothing in a worker thread, which
 *   shares its pid with the whole process.
 *
 * Installed by the library, the signal handlers ended hosts that never asked
 * for them: the hobo suite's serve-control test emits SIGINT to its own
 * handlers, and in a vitest worker thread that composed a default runtime the
 * handler took the emit for a signal and killed the whole runner.
 *
 * What no handler can reach: SIGKILL, and a crash of the process itself.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
// The one list of the signals that end a process here, hobo-code's: its
// launcher, which cannot import a build, reads the same file.
import { ENDING_SIGNALS } from "@hobo/code/ending-signals";

/** The part of a process the directories' removal is tied to. `process` is one. */
export interface DirOwner {
	readonly pid: number;
	on(event: "exit", listener: () => void): void;
	prependListener(event: NodeJS.Signals, listener: () => void): void;
	off(event: NodeJS.Signals, listener: () => void): void;
	listenerCount(event: NodeJS.Signals): number;
	kill(pid: number, signal: NodeJS.Signals): void;
}

function removeDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// Best effort while the process ends: a throw here would skip the exit listeners after this one.
	}
}

function removeAll(dirs: Set<string>): void {
	for (const dir of dirs) removeDir(dir);
	dirs.clear();
}

/** Each owner's directories, removed by one `exit` listener. */
const owned = new WeakMap<DirOwner, Set<string>>();
/** Owners whose entry point asked for the signal handlers, and has them now. */
const signalled = new WeakSet<DirOwner>();

function dirsOf(owner: DirOwner): Set<string> {
	const known = owned.get(owner);
	if (known !== undefined) return known;
	const dirs = new Set<string>();
	owned.set(owner, dirs);
	owner.on("exit", () => removeAll(dirs));
	return dirs;
}

/** Make `<TMPDIR>/<prefix>XXXXXX`, removed when `owner` exits; returns its path. */
export function ownedTempDir(
	prefix: string,
	owner: DirOwner = process,
): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirsOf(owner).add(dir);
	return dir;
}

/**
 * For a process's entry point: remove every directory `owner` owns, made before
 * or after this call, on SIGTERM, SIGHUP, SIGINT and SIGQUIT too, then raise the
 * signal again. One set of handlers per owner, however often it is called.
 */
export function removeOwnedDirsOnSignals(owner: DirOwner = process): void {
	if (!isMainThread || signalled.has(owner)) return;
	signalled.add(owner);
	const dirs = dirsOf(owner);
	const handlers = ENDING_SIGNALS.map((signal) => {
		const onSignal = () => {
			if (owner.listenerCount(signal) > 1) return;
			for (const [name, handler] of handlers) owner.off(name, handler);
			signalled.delete(owner);
			removeAll(dirs);
			owner.kill(owner.pid, signal);
		};
		return [signal, onSignal] as const;
	});
	for (const [name, handler] of handlers) owner.prependListener(name, handler);
}
