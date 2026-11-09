/**
 * hobo-code's launcher (`bin/hobo-code.mjs`) runs the process that does the
 * work in a session of its own, with an IPC channel, and passes on the signals
 * that end hobo-code. Killed outright, it passes on nothing: its end of the
 * channel closes, and this process takes that as the hangup it is otherwise
 * never sent, so the shell restores the terminal and the composed store is
 * removed. Not on Windows, where the child shares the launcher's console.
 */

/** The part of a process this needs; `process` is one. */
export interface LaunchedProcess {
	readonly pid: number;
	readonly platform: NodeJS.Platform;
	/** Defined only in a process started with an IPC channel. */
	readonly send?: unknown;
	readonly connected?: boolean;
	readonly channel?: { unref(): void } | null;
	once(event: "disconnect", listener: () => void): void;
	kill(pid: number, signal: NodeJS.Signals): void;
}

export function hangUpWhenLauncherGoes(proc: LaunchedProcess = process): void {
	if (proc.platform === "win32" || proc.send === undefined) return;
	// The launcher can be gone before this runs, killed while this process was
	// still loading its modules: its `disconnect` came with no one listening,
	// and the channel is closed already.
	if (proc.channel == null || proc.connected !== true) {
		proc.kill(proc.pid, "SIGHUP");
		return;
	}
	proc.once("disconnect", () => proc.kill(proc.pid, "SIGHUP"));
	proc.channel.unref();
}
