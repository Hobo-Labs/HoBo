import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { CHECK_OUTPUT_LIMIT } from "./gate-status.js";
import {
	type GroupStop,
	groupTarget,
	type StopTarget,
	stopGroup as stopTarget,
} from "./process-group.js";

export const RELAY_BYTES = CHECK_OUTPUT_LIMIT / 8;
const TAIL_CHARS = 2000;

export const AI_BDD_GRACE_MS = 10_000;
const OUTPUT_CLOSE_WAIT_MS = 1000;

export interface AiBddCommand {
	readonly command: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly timeoutMs: number;
	readonly graceMs?: number;
	readonly relay: (chunk: Buffer) => void;
}

export interface AiBddRun {
	readonly args: readonly string[];
	readonly status: number | null;
	readonly unstartable: string;
	readonly timedOut: boolean;
	readonly tail: string;
	readonly printedRunDir: string | undefined;
	readonly stop: GroupStop;
}

const RUN_LINE = /^Run: (.+)$/u;
const MAX_RUN_LINE_CHARACTERS = 64 * 1024;

interface RunLineWatch {
	readonly write: (chunk: Buffer) => void;
	readonly last: () => string | undefined;
}

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
			if (partial.length > MAX_RUN_LINE_CHARACTERS) {
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

const runningProcessGraceMs = new Map<ChildProcess, number>();
const stoppingProcessGroups = new Map<ChildProcess, Promise<GroupStop>>();
let stoppedBySignal: NodeJS.Signals | undefined;

function commandTarget(child: ChildProcess): StopTarget {
	const exited = () => child.exitCode !== null || child.signalCode !== null;
	return {
		label: `ai-bdd (pid ${child.pid})`,
		signal: (signal) =>
			!exited() && child.kill(signal) ? { kind: "sent" } : { kind: "gone" },
		probe: () => (exited() ? { kind: "gone" } : { kind: "live" }),
	};
}

function targetOf(child: ChildProcess): StopTarget {
	if (child.pid === undefined) {
		return {
			label: "ai-bdd (not started)",
			signal: () => ({ kind: "gone" }),
			probe: () => ({ kind: "gone" }),
		};
	}
	if (process.platform === "win32") return commandTarget(child);
	return groupTarget(
		{ pgid: child.pid, sid: child.pid },
		process.platform === "linux" ? { procRoot: "/proc" } : {},
	);
}

function stopGroup(
	child: ChildProcess,
	signal: NodeJS.Signals,
	graceMs: number,
): Promise<GroupStop> {
	const pending = stoppingProcessGroups.get(child);
	if (pending !== undefined) return pending;
	const stop = stopTarget(targetOf(child), signal, graceMs);
	stoppingProcessGroups.set(child, stop);
	return stop;
}

export async function stopRunningAiBdd(signal: NodeJS.Signals): Promise<void> {
	stoppedBySignal = signal;
	await Promise.all(
		[...runningProcessGraceMs].map(([child, graceMs]) =>
			stopGroup(child, signal, graceMs),
		),
	);
}

interface OutputRelay {
	readonly write: (chunk: Buffer) => void;
	readonly end: () => void;
	readonly tail: () => string;
}

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
		let drain: NodeJS.Timeout | undefined;
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
		if (stoppedBySignal !== undefined) {
			finish(null, `not started: the check was stopped by ${stoppedBySignal}`);
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
			const reason = cause instanceof Error ? cause.message : String(cause);
			finish(null, reason);
			return;
		}
		runningProcessGraceMs.set(child, graceMs);
		let closed: Ending | undefined;
		let groupStop: GroupStop | undefined;
		const end = () => {
			if (groupStop === undefined || closed === undefined) return;
			clearTimeout(timer);
			runningProcessGraceMs.delete(child);
			stoppingProcessGroups.delete(child);
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
			runningProcessGraceMs.delete(child);
			finish(null, `${cause.name}: ${cause.message}`);
		});
		child.on("exit", (status, signal) => {
			void stopGroup(child, "SIGTERM", graceMs).then((stop) => {
				groupStop = stop;
				end();
				if (done) return;
				drain = setTimeout(() => {
					child.stdout?.destroy();
					child.stderr?.destroy();
					closed = closed ?? { status, signal };
					end();
				}, OUTPUT_CLOSE_WAIT_MS);
			});
		});
		child.on("close", (status, signal) => {
			closed = { status, signal };
			end();
		});
	});
}
