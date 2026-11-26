import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { guardRun } from "../src/supervise.js";

/** A process OpenSesame has already gone from: kill reports ESRCH by throwing, as a wrapped or faked one may. */
const GONE = {
	stderr: null,
	on: () => undefined,
	kill: (): boolean => {
		throw new Error("ESRCH");
	},
};

describe("a signal passed on to an OpenSesame that cannot be killed", () => {
	it("does not throw out of the signal listener, for each signal it passes on", () => {
		for (const signal of ["SIGTERM", "SIGHUP", "SIGINT", "SIGQUIT"] as const) {
			const host = new EventEmitter();
			const guard = guardRun(host, () => undefined);
			guard.attach(GONE);
			expect(() => host.emit(signal, signal), signal).not.toThrow();
			guard.release();
		}
	});

	it("leaves the listeners after ours to run, and the guard working: the signal is remembered and the run still ends", () => {
		const host = new EventEmitter();
		const raised: string[] = [];
		const guard = guardRun(host, (signal) => raised.push(signal));
		guard.attach(GONE);
		let later = 0;
		host.on("SIGINT", () => {
			later += 1;
		});
		host.emit("SIGINT", "SIGINT");
		host.emit("SIGINT", "SIGINT");
		expect(later).toBe(2);
		expect(guard.received()).toBe("SIGINT");
		guard.detach();
		guard.release();
		expect(raised).toEqual(["SIGINT"]);
		expect(host.listenerCount("SIGINT")).toBe(1);
		expect(host.listenerCount("exit")).toBe(0);
	});
});
