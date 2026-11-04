import type { ChildProcess } from "node:child_process";

const trackedChildren = new Set<ChildProcess>();

export function killProcessGroup(
	pid: number,
	signal: NodeJS.Signals = "SIGKILL",
): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

export function trackChild(child: ChildProcess): ChildProcess {
	trackedChildren.add(child);
	return child;
}

export function killTrackedSubprocesses(): void {
	for (const child of trackedChildren) {
		if (
			child.pid !== undefined &&
			child.exitCode === null &&
			child.signalCode === null
		) {
			killProcessGroup(child.pid);
		}
	}
	trackedChildren.clear();
}
