
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";

const ENDING_SIGNALS: readonly NodeJS.Signals[] = [
	"SIGTERM",
	"SIGHUP",
	"SIGINT",
	"SIGQUIT",
];

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
	}
}

function removeAll(dirs: Set<string>): void {
	for (const dir of dirs) removeDir(dir);
	dirs.clear();
}

const owned = new WeakMap<DirOwner, Set<string>>();
const signalled = new WeakSet<DirOwner>();

function dirsOf(owner: DirOwner): Set<string> {
	const known = owned.get(owner);
	if (known !== undefined) return known;
	const dirs = new Set<string>();
	owned.set(owner, dirs);
	owner.on("exit", () => removeAll(dirs));
	return dirs;
}

export function ownedTempDir(
	prefix: string,
	owner: DirOwner = process,
): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirsOf(owner).add(dir);
	return dir;
}

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
