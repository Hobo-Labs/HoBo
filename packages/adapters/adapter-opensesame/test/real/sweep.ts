/**
 * "Nowhere": a sweep of everything a user can read that a run might have left
 * a value in. Processes (command line and environment, from /proc) and files
 * (a directory tree). It needs a control, because a sweep that finds nothing
 * proves nothing until it is shown to find something.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function canReadProcesses(): boolean {
	return existsSync("/proc/self/environ");
}

/** Pids whose command line or environment names `needle`, as "pid environ|cmdline". */
export function processesNaming(needle: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/u.test(entry)) continue;
		for (const part of ["cmdline", "environ"] as const) {
			try {
				if (readFileSync(`/proc/${entry}/${part}`).includes(needle)) {
					found.push(`${entry} ${part}`);
				}
			} catch {
				// A process that ended, or one this user cannot read.
			}
		}
	}
	return found;
}

/** Regular files under `root` whose bytes contain `needle`. */
export function filesNaming(root: string, needle: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const stat = statSync(path, { throwIfNoEntry: false });
			if (stat === undefined) continue;
			if (stat.isDirectory()) walk(path);
			else if (stat.isFile() && readFileSync(path).includes(needle)) {
				found.push(path);
			}
		}
	};
	walk(root);
	return found;
}

/** A process that holds `value` in its environment, the sweep's positive control. */
export function startDecoy(value: string) {
	const child = spawn("sleep", ["300"], {
		env: { PATH: process.env.PATH ?? "", DECOY: value },
		stdio: "ignore",
	});
	return {
		pid: child.pid,
		stop: () => {
			child.kill("SIGKILL");
		},
	};
}
