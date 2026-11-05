import { describe, expect, it } from "vitest";
import { createTickTrigger } from "../src/isolated-worker/tick-trigger.js";

describe("createTickTrigger", () => {
	it("runs once when triggered while idle", async () => {
		let runs = 0;
		const errors: unknown[] = [];
		const tick = createTickTrigger({
			run: async () => {
				runs++;
			},
			onError: (error) => errors.push(error),
		});
		tick.trigger();
		expect(runs).toBe(1);
		await Promise.resolve();
		expect(errors).toEqual([]);
	});

	it("coalesces triggers during a run into one follow-up", async () => {
		const releases: (() => void)[] = [];
		let runs = 0;
		const tick = createTickTrigger({
			run: () => {
				runs++;
				return new Promise<void>((resolve) => releases.push(resolve));
			},
			onError: () => {},
		});
		tick.trigger();
		tick.trigger();
		tick.trigger();
		expect(runs).toBe(1);
		releases[0]?.();
		await Promise.resolve();
		expect(runs).toBe(2);
		releases[1]?.();
		await Promise.resolve();
		expect(runs).toBe(2);
	});

	it("reports errors and accepts later triggers", async () => {
		const failure = new Error("tick failed");
		const errors: unknown[] = [];
		let runs = 0;
		const tick = createTickTrigger({
			run: async () => {
				runs++;
				if (runs === 1) throw failure;
			},
			onError: (error) => errors.push(error),
		});
		tick.trigger();
		await Promise.resolve();
		await Promise.resolve();
		expect(errors).toEqual([failure]);
		tick.trigger();
		await Promise.resolve();
		expect(runs).toBe(2);
		expect(errors).toEqual([failure]);
	});
});
