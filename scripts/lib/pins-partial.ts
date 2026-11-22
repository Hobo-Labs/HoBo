import { randomBytes } from "node:crypto";
import { rmdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

interface Armed {
	readonly partial: string;
	readonly tree: boolean;
	readonly leaf: string;
	top: string | undefined;
	readonly abort: () => void;
	signal: NodeJS.Signals | null;
}

const armed = new Set<Armed>();
let listening = false;

export function partialPath(dest: string): string {
	return `${dest}.${process.pid}.${randomBytes(6).toString("hex")}.partial`;
}

export function partialOwner(name: string): number | null {
	const pid = /\.(\d+)(?:\.[0-9a-f]{12})?\.partial$/u.exec(name)?.[1];
	return pid === undefined ? null : Number(pid);
}

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
		guard.abort();
		try {
			clean(guard);
		} catch {}
	}
	stopListening();
	if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

export interface Guard {
	made(top: string | undefined): void;
	interrupted(): NodeJS.Signals | null;
	release(): void;
}

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

export function isLivePartial(path: string): boolean {
	for (const guard of armed) if (guard.partial === path) return true;
	return false;
}
