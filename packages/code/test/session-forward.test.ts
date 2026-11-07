import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DevMachine } from "../src/dev-machines.js";
import { forwardResidentSessions } from "../src/session-forward.js";
import { endingSignalHold, type SignalSource } from "../src/signal-hold.js";

/** A process whose ending-signal listeners a test calls. */
function source(): SignalSource & { send(signal: NodeJS.Signals): void } {
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
		send(signal) {
			for (const listener of listeners.get(signal) ?? []) listener(signal);
		},
	};
}

/** A stand-in for the spawned ssh: it records what it is sent, and exits when told. */
function ssh(): EventEmitter & {
	kills: string[];
	kill(signal: string): boolean;
} {
	const kills: string[] = [];
	return Object.assign(new EventEmitter(), {
		kills,
		kill(signal: string) {
			kills.push(signal);
			return true;
		},
	});
}

const machine: DevMachine = {
	id: "box",
	host: "box.ts.net",
	isolationClass: "development",
};

afterEach(() => {
	vi.useRealTimers();
});

describe("forwardResidentSessions", () => {
	it("after ssh has ended on a signal, still holds the signals, and a second one stops nothing", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const proc = source();
		const signals = endingSignalHold(proc);
		signals.hold();
		const child = ssh();
		const forwarded = forwardResidentSessions(
			{
				machine,
				port: 4242,
				identityAgent: "/run/agent.sock",
				authorizationExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			},
			signals,
			{
				stdout: new Writable({ write: (_chunk, _encoding, done) => done() }),
				startSsh: () => child,
			},
		);
		await vi.waitFor(() => expect(child.listenerCount("exit")).toBe(1));
		proc.send("SIGINT");
		expect(child.kills).toEqual(["SIGINT"]);
		child.emit("exit", null, "SIGINT");
		await expect(forwarded).resolves.toBe(130);
		// The caller closes the authorization next, and the signals stay held
		// until it has: a second one now is only recorded.
		expect(signals.held).toBe(true);
		proc.send("SIGINT");
		expect(child.kills).toEqual(["SIGINT"]);
		expect(vi.getTimerCount()).toBe(0);
		signals.release();
	});

	it("ends with 128+n when ssh's exit is seen before the signal that ended it", async () => {
		// The launcher signals hobo-code's whole group, ssh included. Node can
		// hand hobo-code ssh's exit before the signal: they reach different
		// threads. The status was then ssh's (1), not 128+n.
		const proc = source();
		const signals = endingSignalHold(proc);
		signals.hold();
		const child = ssh();
		const forwarded = forwardResidentSessions(
			{
				machine,
				port: 4242,
				identityAgent: "/run/agent.sock",
				authorizationExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			},
			signals,
			{
				stdout: new Writable({ write: (_chunk, _encoding, done) => done() }),
				startSsh: () => child,
			},
		);
		await vi.waitFor(() => expect(child.listenerCount("exit")).toBe(1));
		child.emit("exit", null, "SIGTERM");
		proc.send("SIGTERM");
		await expect(forwarded).resolves.toBe(143);
		expect(child.kills).toEqual([]);
		signals.release();
	});
});
