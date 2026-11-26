import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
	describe as describeProc,
	end,
	identify,
	running,
} from "./support/procs.js";

const sleepers: number[] = [];
afterEach(() => {
	for (const pid of sleepers.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
});

/** A process that does nothing for a minute, and its pid. */
function sleeper(): number {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
		stdio: "ignore",
	});
	const pid = child.pid;
	if (pid === undefined) throw new Error("could not start a process");
	sleepers.push(pid);
	return pid;
}

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("a recorded pid is a process, not a number", () => {
	it("knows a running process and sees it end", async () => {
		const pid = sleeper();
		await until(() => identify(pid) !== undefined);
		const id = identify(pid);
		expect(running(id)).toBe(true);
		end(id);
		await until(() => !running(id));
		expect(running(id)).toBe(false);
	});

	it("does not take another process for it when the pid has been reused, and does not kill that one", () => {
		const pid = sleeper();
		// The same number with another start time is what a recycled pid looks like.
		const recycled = { pid, started: "1" };
		expect(running(recycled)).toBe(false);
		end(recycled);
		expect(() => process.kill(pid, 0)).not.toThrow();
		expect(running(identify(pid))).toBe(true);
	});

	it("has no process for a pid that is 0, 1 or below, or not a number: kill(0) is a whole process group", () => {
		for (const pid of [undefined, 0, 1, -1, -4242, Number.NaN, 1.5]) {
			expect(identify(pid), String(pid)).toBeUndefined();
		}
		expect(running(undefined)).toBe(false);
		expect(() => end(undefined)).not.toThrow();
		expect(identify(2 ** 22 + 7)).toBeUndefined();
	});

	it("says what a surviving process is, for a failure message", async () => {
		const pid = sleeper();
		await until(() => identify(pid) !== undefined);
		const id = identify(pid);
		expect(describeProc(id)).toMatch(
			new RegExp(
				`^pid ${pid} \\(started \\d+\\) is [SRD] .*, parent ${process.pid}: .*setTimeout`,
				"u",
			),
		);
		end(id);
		await until(() => !running(id));
		expect(describeProc({ pid, started: "1" })).toContain(
			`pid ${pid} (started 1)`,
		);
		expect(describeProc(undefined)).toBe("no process");
	});
});
