import { describe, expect, it } from "vitest";

import { endingSignalHold, type SignalSource } from "../src/signal-hold.js";

/** A process whose ending-signal listeners a test can see and call. */
function source(): SignalSource & {
	listening(): string[];
	send(signal: NodeJS.Signals): void;
} {
	const listeners = new Map<string, ((signal: NodeJS.Signals) => void)[]>();
	return {
		on(signal, listener) {
			listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
		},
		off(signal, listener) {
			listeners.set(
				signal,
				(listeners.get(signal) ?? []).filter((entry) => entry !== listener),
			);
		},
		listening: () =>
			[...listeners].filter(([, all]) => all.length > 0).map(([name]) => name),
		send(signal) {
			for (const listener of listeners.get(signal) ?? []) listener(signal);
		},
	};
}

describe("endingSignalHold", () => {
	it("listens for nothing until held, then for the four ending signals", () => {
		const proc = source();
		const signals = endingSignalHold(proc);
		expect(proc.listening()).toEqual([]);
		signals.hold();
		signals.hold();
		expect(signals.held).toBe(true);
		expect(proc.listening()).toEqual([
			"SIGINT",
			"SIGTERM",
			"SIGHUP",
			"SIGQUIT",
		]);
	});

	it("records the first signal, and tells each reaction of every one until it stops", () => {
		const proc = source();
		const signals = endingSignalHold(proc);
		signals.hold();
		const seen: string[] = [];
		const stop = signals.whileHeld((signal) => seen.push(signal));
		proc.send("SIGHUP");
		proc.send("SIGINT");
		stop();
		proc.send("SIGTERM");
		expect(signals.first).toBe("SIGHUP");
		expect(seen).toEqual(["SIGHUP", "SIGINT"]);
	});

	it("listens for nothing once released", () => {
		const proc = source();
		const signals = endingSignalHold(proc);
		signals.hold();
		const seen: string[] = [];
		signals.whileHeld((signal) => seen.push(signal));
		signals.release();
		proc.send("SIGINT");
		expect(proc.listening()).toEqual([]);
		expect(signals.held).toBe(false);
		expect(seen).toEqual([]);
	});
});
