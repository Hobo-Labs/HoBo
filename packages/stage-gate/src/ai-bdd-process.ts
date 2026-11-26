/**
 * One ai-bdd command as a process (ADR-0172), bounded in time and in what it
 * passes on:
 *
 * - It runs in a process group of its own (POSIX). A timeout, or SIGINT or
 *   SIGTERM to the gate, stops that group: the signal first (SIGTERM for a
 *   timeout, else the one the gate got), and SIGKILL to whatever of it is left
 *   after AI_BDD_GRACE_MS. Its own exit stops what it left in its group the
 *   same way. Playwright launches each browser as the leader of a group of its
 *   own, out of reach of a group signal, and closes it from its SIGTERM and
 *   SIGINT handlers: that is why the signal goes first. A process ai-bdd
 *   started in another group and that ignores SIGTERM can outlive the check.
 *   On Linux a group /proc shows holding only zombies of one thread is
 *   SIGKILLed at once, and what /proc cannot read as such counts as live
 *   (src/process-group.ts). The run carries how the stop ended (`stop`):
 *   gone, killed, or unconfirmed when kill was refused (EPERM, EACCES) or
 *   members were still running a second after SIGKILL, which the check records
 *   as not run.
 *   Once ai-bdd has exited and its group is gone, its output is waited for
 *   DRAIN_MS more at most: a process outside the group that holds the pipe
 *   open does not hold the check.
 * - Its output is relayed, but only the first RELAY_BYTES as they come and
 *   the last RELAY_BYTES when it exits: the stage-gate runner captures a
 *   check's stderr up to CHECK_OUTPUT_LIMIT, and a check that writes more is
 *   killed for it, so a passing run that prints a lot must not reach that
 *   limit. Nothing is buffered whole; the evidence keeps the last TAIL_CHARS
 *   characters.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { CHECK_OUTPUT_LIMIT } from "./gate-status.js";
import {
	type GroupStop,
	groupTarget,
	type StopTarget,
	stopGroup as stopTarget,
} from "./process-group.js";

/** Relayed from the start, and again from the end, of a command's output. */
export const RELAY_BYTES = CHECK_OUTPUT_LIMIT / 8;
const TAIL_CHARS = 2000;

/** How long a process group has to end after it is signalled, before SIGKILL. */
export const AI_BDD_GRACE_MS = 10_000;
/** How long after its group is gone ai-bdd's output may stay open before it is no longer waited for. */
const DRAIN_MS = 1000;

export interface AiBddCommand {
	readonly command: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly timeoutMs: number;
	/** Between the signal that stops its group and SIGKILL; AI_BDD_GRACE_MS unless set. */
	readonly graceMs?: number;
	/** Where the output is relayed (the check's stderr). */
	readonly relay: (chunk: Buffer) => void;
}

export interface AiBddRun {
	readonly args: readonly string[];
	/** Its exit code; null when it did not exit by itself. */
	readonly status: number | null;
	/** Why it has no exit code: a spawn error or a signal. Empty when it exited. */
	readonly unstartable: string;
	/** It outlived `timeoutMs`, and its process group was stopped. */
	readonly timedOut: boolean;
	/** The last characters of its output, stdout and stderr as they came. */
	readonly tail: string;
	/** The directory of the last `Run: <dir>` line on its stdout: `ai-bdd run` names the run it made so. */
	readonly printedRunDir: string | undefined;
	/**
	 * How the stop of its process group went once it ended (process-group.ts):
	 * gone, killed, or unconfirmed (kill was refused, or members were
	 * still running), which the check records as not run.
	 */
	readonly stop: GroupStop;
}

const RUN_LINE = /^Run: (.+)$/u;
/** A stdout line longer than this is not read for RUN_LINE. */
const LINE_LIMIT = 64 * 1024;

interface RunLineWatch {
	readonly write: (chunk: Buffer) => void;
	readonly last: () => string | undefined;
}

/** Reads a stream line by line for the last `Run: <dir>` line, holding one line at most. */
function watchRunLine(): RunLineWatch {
	const decoder = new StringDecoder("utf8");
	let partial = "";
	let overlong = false;
	let last: string | undefined;
	const take = (line: string) => {
		const dir = RUN_LINE.exec(line.replace(/\r$/u, ""))?.[1];
		if (dir !== undefined) last = dir;
	};
	return {
		write(chunk) {
			const lines = `${partial}${decoder.write(chunk)}`.split("\n");
			partial = lines.pop() ?? "";
			for (const line of lines) {
				if (!overlong) take(line);
				overlong = false;
			}
			if (partial.length > LINE_LIMIT) {
				partial = "";
				overlong = true;
			}
		},
		last() {
			if (!overlong) take(`${partial}${decoder.end()}`);
			partial = "";
			return last;
		},
	};
}

/** Each ai-bdd still running, and its grace period. */
const running = new Map<ChildProcess, number>();
/** Each group being stopped: a second stop of the same group waits for the first. */
const stopping = new Map<ChildProcess, Promise<GroupStop>>();
/** Set once the gate itself is told to stop: no ai-bdd starts after that. */
let stoppedBy: NodeJS.Signals | undefined;

/** Windows has no process groups: the command itself, which every signal ends at once. */
function commandTarget(child: ChildProcess): StopTarget {
	const exited = () => child.exitCode !== null || child.signalCode !== null;
	return {
		label: `ai-bdd (pid ${child.pid})`,
		signal: (signal) =>
			!exited() && child.kill(signal) ? { kind: "sent" } : { kind: "gone" },
		probe: () => (exited() ? { kind: "gone" } : { kind: "live" }),
	};
}

/** ai-bdd's process group, or on Windows the command itself. */
function targetOf(child: ChildProcess): StopTarget {
	if (child.pid === undefined) {
		return {
			label: "ai-bdd (not started)",
			signal: () => ({ kind: "gone" }),
			probe: () => ({ kind: "gone" }),
		};
	}
	if (process.platform === "win32") return commandTarget(child);
	// Spawned detached, it called setsid() before exec: it leads a session and a
	// group, both numbered by its pid. On Linux /proc is read once the kernel has
	// found a member, to tell a zombie from it.
	return groupTarget(
		{ pgid: child.pid, sid: child.pid },
		process.platform === "linux" ? { procRoot: "/proc" } : {},
	);
}

/** Stop ai-bdd's process group (process-group.ts); a second stop of it waits for the first. */
function stopGroup(
	child: ChildProcess,
	signal: NodeJS.Signals,
	graceMs: number,
): Promise<GroupStop> {
	const pending = stopping.get(child);
	if (pending !== undefined) return pending;
	const stop = stopTarget(targetOf(child), signal, graceMs);
	stopping.set(child, stop);
	return stop;
}

/**
 * The gate was told to stop (the entry script calls this on SIGINT and
 * SIGTERM): pass the signal on to every ai-bdd group still running, SIGKILL
 * what is left after its grace, and start no other. Resolves when all are gone.
 */
export async function stopRunningAiBdd(signal: NodeJS.Signals): Promise<void> {
	stoppedBy = signal;
	await Promise.all(
		[...running].map(([child, graceMs]) => stopGroup(child, signal, graceMs)),
	);
}

interface OutputRelay {
	readonly write: (chunk: Buffer) => void;
	readonly end: () => void;
	readonly tail: () => string;
}

/** The first RELAY_BYTES go out as they come; of the rest, the last RELAY_BYTES go out at the end. */
function boundedRelay(relay: (chunk: Buffer) => void): OutputRelay {
	let relayed = 0;
	let held: Buffer[] = [];
	let heldBytes = 0;
	let dropped = 0;
	let tail = "";
	return {
		write(chunk) {
			tail = `${tail}${chunk.toString("utf8")}`.slice(-TAIL_CHARS);
			const head = chunk.subarray(0, Math.max(0, RELAY_BYTES - relayed));
			if (head.length > 0) {
				relay(head);
				relayed += head.length;
			}
			const rest = chunk.subarray(head.length);
			if (rest.length === 0) return;
			held.push(rest);
			heldBytes += rest.length;
			while (
				held.length > 1 &&
				heldBytes - (held[0]?.length ?? 0) >= RELAY_BYTES
			) {
				const first = held[0]?.length ?? 0;
				held = held.slice(1);
				heldBytes -= first;
				dropped += first;
			}
		},
		end() {
			if (dropped > 0) {
				relay(
					Buffer.from(
						`\n[... ${dropped} bytes of ai-bdd output not relayed ...]\n`,
					),
				);
			}
			for (const chunk of held) relay(chunk);
		},
		tail: () => tail,
	};
}

interface Ending {
	readonly status: number | null;
	readonly signal: NodeJS.Signals | null;
}

export function runAiBdd(
	spec: AiBddCommand,
	args: readonly string[],
): Promise<AiBddRun> {
	const [executable = "", ...prefix] = spec.command;
	const graceMs = spec.graceMs ?? AI_BDD_GRACE_MS;
	const output = boundedRelay(spec.relay);
	const runLine = watchRunLine();
	return new Promise((settle) => {
		let done = false;
		let timedOut = false;
		/** Waits DRAIN_MS for `close` after the group is gone; cleared once settled, so it keeps nothing alive. */
		let drain: NodeJS.Timeout | undefined;
		/** No group was started, or none of it was left. */
		const NOTHING_LEFT: GroupStop = { kind: "gone" };
		const finish = (
			status: number | null,
			unstartable: string,
			stop: GroupStop = NOTHING_LEFT,
		) => {
			if (done) return;
			done = true;
			clearTimeout(drain);
			output.end();
			settle({
				args,
				status,
				unstartable,
				timedOut,
				tail: output.tail(),
				printedRunDir: runLine.last(),
				stop,
			});
		};
		if (stoppedBy !== undefined) {
			finish(null, `not started: the check was stopped by ${stoppedBy}`);
			return;
		}
		let child: ChildProcess;
		try {
			child = spawn(executable, [...prefix, ...args], {
				cwd: spec.cwd,
				env: spec.env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
		} catch (cause) {
			// Node refuses some commands before any process exists (a .cmd shim on Windows: EINVAL).
			const reason = cause instanceof Error ? cause.message : String(cause);
			finish(null, reason);
			return;
		}
		running.set(child, graceMs);
		let closed: Ending | undefined;
		/** How the stop of its group went, once it has ended. */
		let groupStop: GroupStop | undefined;
		const end = () => {
			if (groupStop === undefined || closed === undefined) return;
			clearTimeout(timer);
			running.delete(child);
			stopping.delete(child);
			finish(
				timedOut ? null : closed.status,
				closed.signal === null ? "" : `ended by ${closed.signal}`,
				groupStop,
			);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			void stopGroup(child, "SIGTERM", graceMs);
		}, spec.timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			output.write(chunk);
			runLine.write(chunk);
		});
		child.stderr?.on("data", output.write);
		child.on("error", (cause) => {
			clearTimeout(timer);
			running.delete(child);
			finish(null, `${cause.name}: ${cause.message}`);
		});
		// What it started and left running in its group goes with it.
		child.on("exit", (status, signal) => {
			void stopGroup(child, "SIGTERM", graceMs).then((stop) => {
				groupStop = stop;
				end();
				if (done) return;
				// A process outside the group can hold ai-bdd's stdout or stderr open, and `close` would wait for it.
				drain = setTimeout(() => {
					child.stdout?.destroy();
					child.stderr?.destroy();
					closed = closed ?? { status, signal };
					end();
				}, DRAIN_MS);
			});
		});
		child.on("close", (status, signal) => {
			closed = { status, signal };
			end();
		});
	});
}
