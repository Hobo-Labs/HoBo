import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
	exitSpawnFailClosed,
	spawnFailClosedCode,
} from "../lib/spawn-sync-fail-closed.mts";

function mockSpawn(
	partial: Partial<SpawnSyncReturns<string>>,
): SpawnSyncReturns<string> {
	return {
		pid: 0,
		output: [null, null, null],
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
		...partial,
	};
}

describe("spawnFailClosedCode", () => {
	it("returns null on success", () => {
		expect(spawnFailClosedCode(mockSpawn({ status: 0 }))).toBeNull();
	});

	it("returns 1 on spawn error", () => {
		expect(
			spawnFailClosedCode(
				mockSpawn({ status: null, error: new Error("enoent") }),
			),
		).toBe(1);
	});

	it("returns 1 on signal kill", () => {
		expect(
			spawnFailClosedCode(mockSpawn({ status: null, signal: "SIGKILL" })),
		).toBe(1);
	});

	it("returns status on non-zero exit", () => {
		expect(spawnFailClosedCode(mockSpawn({ status: 2 }))).toBe(2);
	});

	it("returns 1 when status is null without error or signal", () => {
		expect(spawnFailClosedCode(mockSpawn({ status: null }))).toBe(1);
	});
});

describe("exitSpawnFailClosed", () => {
	it("exits 1 on signal", () => {
		const exit = vi.spyOn(process, "exit");
		// SAFETY: vitest mock must match process.exit arity; implementation throws to capture code.
		exit.mockImplementation(((code) => {
			throw new Error(`exit:${code}`);
		}) as typeof process.exit);
		expect(() =>
			exitSpawnFailClosed(
				"test",
				mockSpawn({ status: null, signal: "SIGTERM" }),
			),
		).toThrow("exit:1");
		expect(exit).toHaveBeenCalledWith(1);
		exit.mockRestore();
	});
});
