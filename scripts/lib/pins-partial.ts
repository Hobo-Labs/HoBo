/**
 * What a download leaves on disk while it runs, and what happens to it when
 * the process is told to stop.
 *
 * A download arms a guard before it creates anything: the directory it may
 * make and the partial file it will write. One listener per signal (SIGINT,
 * SIGTERM, SIGHUP) serves every armed guard in the process. When a signal
 * arrives, each guard's partial file and the directories its fetch made are
 * removed synchronously, its download is aborted, and the signal is raised
 * again only when no other listener is left for it: a program that embeds the
 * fetch and handles the signal itself keeps running, its handler called once,
 * and its fetch rejects instead.
 *
 * Erasable TypeScript with node builtins only.
 */
import { randomBytes } from "node:crypto";
import { rmdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

interface Armed {
	readonly partial: string;
	/** The guarded path is a directory to remove whole (a probe repository). */
	readonly tree: boolean;
	readonly leaf: string;
	/** The topmost directory the fetch made, once it has made any. */
	top: string | undefined;
	readonly abort: () => void;
	signal: NodeJS.Signals | null;
}

const armed = new Set<Armed>();
let listening = false;

/**
 * `<dest>.<pid>.<12 random hex>.partial`: the pid says whose it is, the random
 * part makes it unique, so a file a killed run left (even one whose pid this
 * run has, as pid 1 in a container) can never be the name this run opens.
 */
export function partialPath(dest: string): string {
	return `${dest}.${process.pid}.${randomBytes(6).toString("hex")}.partial`;
}

/** The pid in a partial file's name (with or without the random part), if it is one. */
export function partialOwner(name: string): number | null {
	const pid = /\.(\d+)(?:\.[0-9a-f]{12})?\.partial$/u.exec(name)?.[1];
	return pid === undefined ? null : Number(pid);
}

/** `rmdir` from `leaf` up to `top`, stopping at the first one that is not empty. */
export function removeEmptyDirs(leaf: string, top: string | undefined): void {
	if (top === undefined) return;
	for (let dir = leaf; ; dir = dirname(dir)) {
		try {
			rmdirSync(dir);
		} catch {
			return;
		}
		if (dir === top || dirname(dir) === dir) return;
	}
}

function clean(guard: Armed): void {
	// A tree may still gain an entry from a git that is only now stopping;
	// the retries apply to a recursive removal only.
	rmSync(guard.partial, {
		force: true,
		recursive: guard.tree,
		maxRetries: 2,
		retryDelay: 20,
	});
	removeEmptyDirs(guard.leaf, guard.top);
}

function stopListening(): void {
	for (const name of SIGNALS) process.off(name, onSignal);
	listening = false;
}

function onSignal(signal: NodeJS.Signals): void {
	for (const guard of armed) {
		guard.signal = signal;
		// Stop the writer first, then clean. The listener must never throw: a
		// throw here would skip the other guards and the re-raise, so whatever
		// cannot be removed now is left to the hourly sweep.
		guard.abort();
		try {
			clean(guard);
		} catch {
			// Swept later (sweepProbes, sweepPartials).
		}
	}
	stopListening();
	// Re-raise only when nobody else will handle it: the default action then
	// ends the process by this signal, as if the guard had never been there.
	if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

export interface Guard {
	/** Record what `mkdirSync(..., { recursive: true })` returned. */
	made(top: string | undefined): void;
	/** The signal that interrupted this download, if one did. */
	interrupted(): NodeJS.Signals | null;
	/** Disarm: the file is in place, or the failure path has cleaned up. */
	release(): void;
}

/**
 * Arm a guard for a download into `partial`, whose directory the fetch may
 * create. Call it before creating anything, and release it after the verified
 * file has been renamed into place (or the failure path has cleaned up).
 * With `tree`, `partial` is a directory (a probe repository) removed whole.
 */
export function armGuard(
	partial: string,
	abort: () => void,
	tree = false,
): Guard {
	const guard: Armed = {
		partial,
		tree,
		leaf: dirname(partial),
		top: undefined,
		abort,
		signal: null,
	};
	armed.add(guard);
	if (!listening) {
		for (const name of SIGNALS) process.on(name, onSignal);
		listening = true;
	}
	return {
		made(top) {
			guard.top = top;
		},
		interrupted: () => guard.signal,
		release() {
			armed.delete(guard);
			if (armed.size === 0 && listening) stopListening();
		},
	};
}

/** Whether `path` is the partial file of a download this process is running. */
export function isLivePartial(path: string): boolean {
	for (const guard of armed) if (guard.partial === path) return true;
	return false;
}
