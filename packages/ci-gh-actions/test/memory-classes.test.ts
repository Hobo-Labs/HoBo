import { describe, expect, it } from "vitest";
import {
	memoryClassForJob,
	resolveWorkerMemoryConfig,
} from "../src/isolated-worker/memory-classes.js";

describe("worker memory config", () => {
	it("resolves defaults that admit trunk and heavy PR work on the 16 GiB box", () => {
		const config = resolveWorkerMemoryConfig(
			{},
			{ totalMemoryMb: 15_989, trunkSlots: 1 },
		);
		expect(config).toEqual({
			budgetMb: 13_941,
			reserveMb: 2_048,
			classes: { light: 3_072, standard: 4_096, heavy: 6_144 },
			defaultClass: "standard",
			trunkReservationMb: 6_144,
			holMs: 60_000,
		});
	});

	it("maps exact workflow job names and defaults unknown jobs to standard", () => {
		expect(memoryClassForJob("CI fabric contract guard")).toBe("light");
		expect(memoryClassForJob("PR impact gate")).toBe("heavy");
		expect(memoryClassForJob("CI fabric contract guard (retry)")).toBe(
			"standard",
		);
	});

	it("honours explicit budget, reserve, class, heavy alias, and HOL overrides", () => {
		const config = resolveWorkerMemoryConfig(
			{
				HOBO_CI_WORKER_MEMORY_BUDGET_MB: "20000",
				HOBO_CI_WORKER_MEMORY_RESERVE_MB: "1024",
				HOBO_CI_WORKER_MEMORY_CLASS_LIGHT_MB: "4096",
				HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB: "4096",
				HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB: "7000",
				HOBO_CI_WORKER_MEMORY_MB: "9000",
				HOBO_CI_WORKER_MEMORY_HOL_MS: "5000",
			},
			{ totalMemoryMb: 32_768, trunkSlots: 1 },
		);
		expect(config).toMatchObject({
			budgetMb: 20_000,
			reserveMb: 1_024,
			classes: { light: 4_096, standard: 4_096, heavy: 7_000 },
			trunkReservationMb: 7_000,
			holMs: 5_000,
		});
		expect(
			resolveWorkerMemoryConfig(
				{ HOBO_CI_WORKER_MEMORY_MB: "6000" },
				{ totalMemoryMb: 16_384, trunkSlots: 0 },
			).classes.heavy,
		).toBe(6_000);
	});

	it("uses the lower cgroup limit for the default budget", () => {
		expect(
			resolveWorkerMemoryConfig(
				{},
				{
					totalMemoryMb: 32_768,
					cgroupMemoryLimitMb: 16_384,
					trunkSlots: 0,
				},
			).budgetMb,
		).toBe(14_336);
	});

	it.each([
		["HOBO_CI_WORKER_MEMORY_BUDGET_MB", "nope"],
		["HOBO_CI_WORKER_MEMORY_RESERVE_MB", "-1"],
		["HOBO_CI_WORKER_MEMORY_CLASS_LIGHT_MB", "3071"],
		["HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB", "1.5"],
		["HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB", "0"],
		["HOBO_CI_WORKER_MEMORY_HOL_MS", "-1"],
	])("rejects invalid %s", (name, value) => {
		expect(() =>
			resolveWorkerMemoryConfig(
				{ [name]: value },
				{ totalMemoryMb: 16_384, trunkSlots: 1 },
			),
		).toThrow(`invalid ${name}`);
	});

	it("fails closed when the 16 GiB box cannot admit the largest general class", () => {
		expect(() =>
			resolveWorkerMemoryConfig(
				{ HOBO_CI_WORKER_MEMORY_BUDGET_MB: "10000" },
				{ totalMemoryMb: 15_989, trunkSlots: 1 },
			),
		).toThrow(
			"worker memory budget 10000 MiB cannot admit every class on an idle host: budget - trunk reservation = 3856 MiB, largest class = 6144 MiB, heavy trunk class = 6144 MiB; adjust HOBO_CI_WORKER_MEMORY_BUDGET_MB, HOBO_CI_WORKER_MEMORY_RESERVE_MB, HOBO_CI_WORKER_MEMORY_CLASS_LIGHT_MB, HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB, HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB, HOBO_CI_WORKER_MEMORY_MB, or HOBO_CI_WORKER_TRUNK_SLOTS",
		);
	});
});
