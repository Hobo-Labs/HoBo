import { describe, expect, it, vi } from "vitest";
import {
	type StartContainerOptions,
	startContainer,
} from "./fixtures/start-container.js";

const definition = <Started>(start: () => Promise<Started>) => ({ start });
const started = { id: "container" };
const instantRetries: StartContainerOptions = { betweenAttemptsMs: 0 };

describe("starting a container beside another file's reaper", () => {
	it("returns the container when the first start works", async () => {
		const build = vi.fn(() => definition(async () => started));
		await expect(startContainer(build)).resolves.toBe(started);
		expect(build).toHaveBeenCalledTimes(1);
	});

	it("starts again, from a new definition, while the reaper cannot be reached", async () => {
		let attempts = 0;
		const build = vi.fn(() =>
			definition(async () => {
				attempts += 1;
				if (attempts < 3) throw new Error("Failed to connect to Reaper");
				return started;
			}),
		);
		await expect(startContainer(build, instantRetries)).resolves.toBe(started);
		expect(build).toHaveBeenCalledTimes(3);
	});

	it("gives up after four attempts", async () => {
		const build = vi.fn(() =>
			definition(async () => {
				throw new Error("Failed to connect to Reaper");
			}),
		);
		await expect(startContainer(build, instantRetries)).rejects.toThrow(
			"Failed to connect to Reaper",
		);
		expect(build).toHaveBeenCalledTimes(4);
	});

	it("waits between reaper retries when configured", async () => {
		vi.useFakeTimers();
		try {
			const build = vi.fn(() =>
				definition(async () => {
					throw new Error("Failed to connect to Reaper");
				}),
			);
			const result = startContainer(build, { betweenAttemptsMs: 1_000 });
			const refused = expect(result).rejects.toThrow(
				"Failed to connect to Reaper",
			);
			await vi.advanceTimersByTimeAsync(3_000);
			await refused;
			expect(build).toHaveBeenCalledTimes(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not retry any other failure", async () => {
		const build = vi.fn(() =>
			definition(async () => {
				throw new Error("image not found");
			}),
		);
		await expect(startContainer(build)).rejects.toThrow("image not found");
		expect(build).toHaveBeenCalledTimes(1);
	});
});
