/**
 * Setup file for the shared-worker project: a test file must leave the worker
 * as it found it.
 *
 * Files in that project share one worker process and module graph, so a
 * timer, server, socket or child process one file leaves running keeps
 * running under the files after it, where it can fire into their state or
 * hold their ports. After each file, anything it started that still keeps the
 * event loop alive, and does not go away within a short grace, fails the file,
 * naming it and what was left.
 *
 * - Servers, sockets, pipes and child processes: the resources keeping the
 *   event loop alive (`process.getActiveResourcesInfo()`), against a record
 *   taken before the file. File system requests in flight are left out; they
 *   finish on their own.
 * - Timers: Node reports those per timer list (one entry per duration), not
 *   per timer, so a count of them misses a timer that shares a duration with
 *   another. The global `setTimeout` and `setInterval` are wrapped for the
 *   file instead, and every referenced timer the file started and neither
 *   fired (a timeout) nor cleared is reported. Vitest keeps its own references
 *   to the timer functions, so its timers are not counted.
 */
import { afterAll, beforeAll, expect } from "vitest";

const NOT_COUNTED = new Set([
	"FSReqCallback",
	"FSReqPromise",
	"FileHandle",
	"Timeout",
	"Immediate",
]);
const GRACE_MS = 2000;

function census(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const resource of process.getActiveResourcesInfo()) {
		if (NOT_COUNTED.has(resource)) continue;
		counts.set(resource, (counts.get(resource) ?? 0) + 1);
	}
	return counts;
}

interface Tracked {
	readonly kind: "setTimeout" | "setInterval";
	readonly timer: NodeJS.Timeout;
	done: boolean;
}

const original = {
	setTimeout: globalThis.setTimeout,
	setInterval: globalThis.setInterval,
	clearTimeout: globalThis.clearTimeout,
	clearInterval: globalThis.clearInterval,
};
let timers = new Map<NodeJS.Timeout, Tracked>();

function track(
	kind: Tracked["kind"],
	start: (wrapped: (...args: unknown[]) => void) => NodeJS.Timeout,
	callback: (...args: unknown[]) => void,
): NodeJS.Timeout {
	let entry: Tracked | undefined;
	const timer = start((...args) => {
		if (entry && kind === "setTimeout") entry.done = true;
		callback(...args);
	});
	entry = { kind, timer, done: false };
	timers.set(timer, entry);
	return timer;
}

type TimerHandle = NodeJS.Timeout | string | number | undefined;

function clear(timer: TimerHandle) {
	for (const entry of timers.values())
		if (entry.timer === timer || Number(entry.timer) === timer)
			entry.done = true;
}

type Callback = (...args: unknown[]) => void;

function install() {
	timers = new Map();
	const timeout = (callback: Callback, ms?: number, ...args: unknown[]) =>
		track(
			"setTimeout",
			(wrapped) => original.setTimeout(wrapped, ms, ...args),
			callback,
		);
	const interval = (callback: Callback, ms?: number, ...args: unknown[]) =>
		track(
			"setInterval",
			(wrapped) => original.setInterval(wrapped, ms, ...args),
			callback,
		);
	const clearTimer = (timer?: TimerHandle) => {
		clear(timer);
		original.clearTimeout(timer);
	};
	const clearRepeat = (timer?: TimerHandle) => {
		clear(timer);
		original.clearInterval(timer);
	};
	// SAFETY: same call signature as setTimeout; the cast restores the overloads and Node's `__promisify__` a wrapper lacks.
	globalThis.setTimeout = timeout as typeof setTimeout;
	// SAFETY: same call signature as setInterval; the cast restores its overloads.
	globalThis.setInterval = interval as typeof setInterval;
	// SAFETY: same call signature as clearTimeout; the cast restores its overloads.
	globalThis.clearTimeout = clearTimer as typeof clearTimeout;
	// SAFETY: same call signature as clearInterval; the cast restores its overloads.
	globalThis.clearInterval = clearRepeat as typeof clearInterval;
}

function uninstall() {
	globalThis.setTimeout = original.setTimeout;
	globalThis.setInterval = original.setInterval;
	globalThis.clearTimeout = original.clearTimeout;
	globalThis.clearInterval = original.clearInterval;
}

function leftRunning(baseline: Map<string, number>): string[] {
	const left: string[] = [];
	for (const [resource, count] of census()) {
		const over = count - (baseline.get(resource) ?? 0);
		if (over > 0) left.push(`${resource} x${over}`);
	}
	for (const kind of ["setTimeout", "setInterval"] as const) {
		const live = [...timers.values()].filter(
			(entry) => entry.kind === kind && !entry.done && entry.timer.hasRef(),
		).length;
		if (live > 0) left.push(`${kind} x${live}`);
	}
	return left;
}

let baseline = new Map<string, number>();
let file = "this test file";

beforeAll(() => {
	file = expect.getState().testPath ?? file;
	baseline = census();
	install();
});

afterAll(async () => {
	try {
		const deadline = Date.now() + GRACE_MS;
		let left = leftRunning(baseline);
		while (left.length > 0 && Date.now() < deadline) {
			await new Promise((resolve) => original.setTimeout(resolve, 25));
			left = leftRunning(baseline);
		}
		if (left.length > 0)
			throw new Error(
				`${file} left ${left.join(", ")} running in the shared test worker; stop or close it before the file ends`,
			);
	} finally {
		uninstall();
	}
});
