import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ENDING_SIGNALS } from "../bin/ending-signals.mjs";
import { launcherSignals } from "../bin/launcher-signals.mjs";
import { runInteractiveShell } from "../src/interactive-shell.js";
import { endingSignalHold, type SignalSource } from "../src/signal-hold.js";

// `bin/ending-signals.mjs` is the one list of the signals that end hobo-code.
// What acts on them reads that list, in its order, rather than writing the
// four out again in an order of its own.

afterEach(() => {
	vi.restoreAllMocks();
});

describe("what acts on hobo-code's ending signals reads the one list", () => {
	it("the launcher listens for that list itself", () => {
		expect(launcherSignals("linux").listen).toBe(ENDING_SIGNALS);
	});

	it("the shell quits on each, listening in the list's order", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-code-ending-"));
		const signals = new Set<string>(ENDING_SIGNALS);
		const listened: string[] = [];
		const once = process.once.bind(process);
		vi.spyOn(process, "once").mockImplementation((event, listener) => {
			const name = String(event);
			if (signals.has(name)) listened.push(name);
			return once(event, listener);
		});
		try {
			const quit = runInteractiveShell({
				stdin: new PassThrough(),
				stdout: new Writable({ write: (_chunk, _encoding, done) => done() }),
				host: {
					runVerb: async () => "ok",
					complete: async () => "unused",
				},
				hoboHome: home,
				sidecars: false,
				reducedMotion: true,
			});
			const deadline = Date.now() + 15_000;
			while (listened.length < ENDING_SIGNALS.length) {
				if (Date.now() > deadline)
					throw new Error(`the shell listened for ${listened.join(", ")}`);
				await sleep(20);
			}
			expect(listened).toEqual([...ENDING_SIGNALS]);
			process.emit("SIGQUIT");
			await expect(quit).resolves.toBe(0);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 20_000);

	it("a hold listens for that list, in its order", () => {
		const listened: string[] = [];
		const proc: SignalSource = {
			on: (signal) => {
				listened.push(signal);
			},
			off: () => {},
		};
		endingSignalHold(proc).hold();
		expect(listened).toEqual([...ENDING_SIGNALS]);
	});
});
