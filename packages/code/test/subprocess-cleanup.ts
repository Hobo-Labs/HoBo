import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const trackedChildren = new Set<ChildProcess>();
const registeredSidecarPids = new Set<number>();

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

export function registerSidecarPid(pid: number): void {
	if (Number.isInteger(pid) && pid > 0) registeredSidecarPids.add(pid);
}

export function killRegisteredSidecarGroups(
	signal: NodeJS.Signals = "SIGKILL",
): void {
	for (const pid of registeredSidecarPids) killProcessGroup(pid, signal);
	registeredSidecarPids.clear();
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

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function readProcessHoboHome(pid: number): string | undefined {
	try {
		const raw = readFileSync(`/proc/${pid}/environ`);
		for (const entry of raw.toString("binary").split("\0")) {
			if (entry.startsWith("HOBO_HOME=")) return entry.slice("HOBO_HOME=".length);
		}
	} catch {
		// process exited
	}
	return undefined;
}

function hoboHomeForPid(pid: number): string | undefined {
	return readProcessHoboHome(pid);
}

/** Linux-only: pids running the detached Evidence worker. */
export function listLeakedEvidenceSidecarPids(): number[] {
	if (process.platform !== "linux") return [];
	const leaked: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/u.test(name)) continue;
		const pid = Number(name);
		try {
			const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
			if (!cmdline.includes("evidence-sidecar-main.js")) continue;
			leaked.push(pid);
		} catch {
			// raced exit
		}
	}
	return leaked;
}

const EPHEMERAL_HOME_MARKERS = [
	"hobo-code-signals-",
	"hobo-evidence-reap-",
	"hobo-code-sidecars-",
	"hobo-code-sidecar-proj-",
	"hobo-code-sidecar-keep-",
	"hobo-evidence-reap-home-",
] as const;

function isEphemeralEvidenceSidecar(pid: number): boolean {
	const home = hoboHomeForPid(pid);
	return (
		home !== undefined &&
		EPHEMERAL_HOME_MARKERS.some((marker) => home.includes(marker))
	);
}

/** Sidecar outlived its HOBO_HOME directory (true leak), not a sibling parallel test. */
function isOrphanedEphemeralEvidenceSidecar(pid: number): boolean {
	const home = hoboHomeForPid(pid);
	if (home === undefined || !isEphemeralEvidenceSidecar(pid)) return false;
	return !existsSync(home);
}

/** Kill Evidence workers whose HOBO_HOME dir is already gone; wait until none remain. */
export async function drainOrphanedEvidenceSidecars(
	waitMs = 5_000,
): Promise<void> {
	for (const pid of listLeakedEvidenceSidecarPids().filter(
		isOrphanedEphemeralEvidenceSidecar,
	)) {
		killProcessGroup(pid);
	}
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		const alive = listLeakedEvidenceSidecarPids().filter(
			isOrphanedEphemeralEvidenceSidecar,
		);
		if (alive.length === 0) return;
		for (const pid of alive) killProcessGroup(pid);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** Fail closed when a test-scoped Evidence worker is still alive after teardown. */
export function assertNoLeakedEvidenceSidecars(): void {
	const ephemeralLeaks = listLeakedEvidenceSidecarPids().filter(
		isOrphanedEphemeralEvidenceSidecar,
	);
	if (ephemeralLeaks.length > 0) {
		for (const pid of ephemeralLeaks) killProcessGroup(pid);
		throw new Error(
			`leaked evidence-sidecar-main.js processes: ${ephemeralLeaks.join(", ")}`,
		);
	}
	registeredSidecarPids.clear();
}

/** Kill Evidence workers scoped to these HOBO_HOME dirs; wait until none remain. */
export async function drainEvidenceSidecarsForHomes(
	homes: readonly string[],
	waitMs = 5_000,
): Promise<void> {
	const matchesHome = (pid: number): boolean => {
		const home = readProcessHoboHome(pid);
		return (
			home !== undefined && homes.some((candidate) => home === candidate)
		);
	};
	for (const pid of listLeakedEvidenceSidecarPids().filter(matchesHome)) {
		killProcessGroup(pid);
	}
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		const alive = listLeakedEvidenceSidecarPids().filter(matchesHome);
		if (alive.length === 0) return;
		for (const pid of alive) killProcessGroup(pid);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
