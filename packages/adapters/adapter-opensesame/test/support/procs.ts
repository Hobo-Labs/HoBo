/**
 * Telling a process from a later one that reuses its pid. A pid is 15 bits here
 * (kernel.pid_max 32768) and every Node process takes a dozen of them for its
 * threads, so on a machine running test suites a pid is recycled within seconds.
 * A test that records a pid and signals or polls it later, by the number alone,
 * can find an innocent process with it: `stops()` read "still running" for a
 * command that was long gone, in 3 of 20 runs of the lane, and `process.kill(pid,
 * "SIGKILL")` after a test can kill the test runner's own parent. The start time
 * in /proc/<pid>/stat (clock ticks since boot) is fixed for a process's life and
 * differs for the next owner of the number; Linux is the platform of this package.
 */

import { readFileSync } from "node:fs";

export type ProcId = Readonly<{ pid: number; started: string }>;

type Stat = Readonly<{ state: string; started: string }>;

function statOf(pid: number): Stat | undefined {
	try {
		const text = readFileSync(`/proc/${pid}/stat`, "utf8");
		// pid (comm) state ppid ...: comm may hold spaces and parentheses, so read from its last ")".
		const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
		const [state] = fields;
		const started = fields[19];
		return state === undefined || started === undefined
			? undefined
			: { state, started };
	} catch {
		return undefined;
	}
}

/** The command line of `pid` as one string, or "" when there is no such process. */
export function commandOf(pid: number): string {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
	} catch {
		return "";
	}
}

/** The process `pid` is right now, or `undefined` when there is none (or `pid` is 0, 1 or below: `kill(0)` is a whole process group). */
export function identify(pid: number | undefined): ProcId | undefined {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return undefined;
	const stat = statOf(pid);
	return stat === undefined ? undefined : { pid, started: stat.started };
}

/** What that process is now, for a failure message: its state, its parent and its command line. */
export function describe(id: ProcId | undefined): string {
	if (id === undefined) return "no process";
	try {
		const status = readFileSync(`/proc/${id.pid}/status`, "utf8");
		const field = (name: string) =>
			new RegExp(`^${name}:\\s*(.*)$`, "mu").exec(status)?.[1] ?? "?";
		return `pid ${id.pid} (started ${id.started}) is ${field("State")}, parent ${field("PPid")}: ${commandOf(id.pid).slice(0, 160)}`;
	} catch {
		return `pid ${id.pid} (started ${id.started}) is gone`;
	}
}

/** Whether that very process is still running: not gone, not a zombie, not another process that has its pid. */
export function running(id: ProcId | undefined): boolean {
	if (id === undefined) return false;
	const stat = statOf(id.pid);
	return (
		stat !== undefined && stat.started === id.started && stat.state !== "Z"
	);
}

/** SIGKILL that very process if it is still running; a process that has since taken its pid is left alone. */
export function end(id: ProcId | undefined): void {
	if (id === undefined || !running(id)) return;
	try {
		process.kill(id.pid, "SIGKILL");
	} catch {
		// Gone between the check and the signal.
	}
}
