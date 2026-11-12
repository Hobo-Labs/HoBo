import { describe, expect, it } from "vitest";
import {
	jitEmptyExitKey,
	jitEmptyExitLaunchBlocked,
	nextJitEmptyExitDelayMs,
	recordJitEmptyExit,
} from "../src/jit-empty-exit-backoff.js";

describe("jit empty exit backoff", () => {
	it("uses exponential delays capped at max", () => {
		expect(nextJitEmptyExitDelayMs(1)).toBe(30_000);
		expect(nextJitEmptyExitDelayMs(2)).toBe(60_000);
		expect(nextJitEmptyExitDelayMs(5)).toBe(480_000);
		expect(nextJitEmptyExitDelayMs(10)).toBe(600_000);
	});

	it("blocks launch until nextLaunchMs", () => {
		const store = new Map();
		const key = jitEmptyExitKey(1, 42, 1);
		const recorded = recordJitEmptyExit(store, key, 1_000);
		expect(
			jitEmptyExitLaunchBlocked(store, key, recorded.nextLaunchMs - 1),
		).toEqual(recorded);
		expect(jitEmptyExitLaunchBlocked(store, key, recorded.nextLaunchMs)).toBe(
			undefined,
		);
	});
});
