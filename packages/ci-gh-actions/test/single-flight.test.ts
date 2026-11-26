import { describe, expect, it, vi } from "vitest";
import { singleFlight } from "../src/isolated-worker/single-flight.js";

describe("singleFlight", () => {
	it("returns the in-flight promise instead of starting overlapping work", async () => {
		let finish: (() => void) | undefined;
		const run = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const guarded = singleFlight(run);

		const first = guarded();
		const second = guarded();
		expect(second).toBe(first);
		expect(run).toHaveBeenCalledOnce();
		finish?.();
		await first;
	});

	it("allows another run after the previous one settles", async () => {
		const run = vi.fn(async () => undefined);
		const guarded = singleFlight(run);

		await guarded();
		await guarded();
		expect(run).toHaveBeenCalledTimes(2);
	});
});
