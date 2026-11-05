import { describe, expect, it } from "vitest";
import {
	memoryClassForJob,
	memoryRequestForJob,
	parseAvailableMemoryMb,
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
			unmeasured: { light: 1_024, standard: 2_048, heavy: 4_096 },
			defaultClass: "standard",
			trunkReservationMb: 4_096,
			holMs: 60_000,
			learn: true,
		});
	});

	it("uses per-class reserves for unmeasured jobs", () => {
		const config = resolveWorkerMemoryConfig(
			{},
			{ totalMemoryMb: 15_989, trunkSlots: 1 },
		);
		expect(memoryRequestForJob("Secret scan", config).memoryMb).toBe(1_024);
		expect(memoryRequestForJob("unknown job", config).memoryMb).toBe(2_048);
		expect(memoryRequestForJob("PR impact gate", config).memoryMb).toBe(4_096);
		expect(config.trunkReservationMb).toBe(4_096);
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
				HOBO_CI_WORKER_MEMORY_RESERVE_MB: "3072",
				HOBO_CI_WORKER_MEMORY_CLASS_LIGHT_MB: "4096",
				HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB: "4096",
				HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB: "7000",
				HOBO_CI_WORKER_MEMORY_MB: "9000",
				HOBO_CI_WORKER_MEMORY_LIGHT_RESERVE_MB: "1536",
				HOBO_CI_WORKER_MEMORY_STANDARD_RESERVE_MB: "2048",
				HOBO_CI_WORKER_MEMORY_HEAVY_RESERVE_MB: "6500",
				HOBO_CI_WORKER_MEMORY_HOL_MS: "5000",
			},
			{ totalMemoryMb: 32_768, trunkSlots: 1 },
		);
		expect(config).toMatchObject({
			budgetMb: 20_000,
			reserveMb: 3_072,
			classes: { light: 4_096, standard: 4_096, heavy: 7_000 },
			unmeasured: { light: 1_536, standard: 2_048, heavy: 6_500 },
			trunkReservationMb: 6_500,
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
		["HOBO_CI_WORKER_MEMORY_LIGHT_RESERVE_MB", "511"],
		["HOBO_CI_WORKER_MEMORY_STANDARD_RESERVE_MB", "4097"],
		["HOBO_CI_WORKER_MEMORY_HEAVY_RESERVE_MB", "6145"],
		["HOBO_CI_WORKER_MEMORY_HOL_MS", "-1"],
		["HOBO_CI_WORKER_MEMORY_LEARN", "false"],
	])("rejects invalid %s", (name, value) => {
		expect(() =>
			resolveWorkerMemoryConfig(
				{ [name]: value },
				{ totalMemoryMb: 16_384, trunkSlots: 1 },
			),
		).toThrow(`invalid ${name}`);
	});

	it("moved from worker-memory: refuses an explicit budget that oversubscribes the host", () => {
		expect(() =>
			resolveWorkerMemoryConfig(
				{ HOBO_CI_WORKER_MEMORY_BUDGET_MB: "13942" },
				{ totalMemoryMb: 15_989, trunkSlots: 0 },
			),
		).toThrow(
			"worker memory budget 13942 MiB exceeds host/cgroup memory minus reserve 13941 MiB",
		);
		expect(() =>
			resolveWorkerMemoryConfig(
				{ HOBO_CI_WORKER_MEMORY_RESERVE_MB: "2047" },
				{ totalMemoryMb: 15_989, trunkSlots: 0 },
			),
		).toThrow("invalid HOBO_CI_WORKER_MEMORY_RESERVE_MB");
	});

	it("fails closed when the 16 GiB box cannot admit the largest general class", () => {
		expect(() =>
			resolveWorkerMemoryConfig(
				{ HOBO_CI_WORKER_MEMORY_BUDGET_MB: "10000" },
				{ totalMemoryMb: 15_989, trunkSlots: 1 },
			),
		).toThrow(
			"worker memory budget 10000 MiB cannot admit every class on an idle host: budget - trunk reservation = 5904 MiB, largest class = 6144 MiB, heavy trunk class = 6144 MiB; adjust HOBO_CI_WORKER_MEMORY_BUDGET_MB, HOBO_CI_WORKER_MEMORY_RESERVE_MB, HOBO_CI_WORKER_MEMORY_CLASS_LIGHT_MB, HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB, HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB, HOBO_CI_WORKER_MEMORY_MB, or HOBO_CI_WORKER_TRUNK_SLOTS",
		);
	});
});

describe("host available memory parsing", () => {
	it("parses MemAvailable from proc meminfo", () => {
		expect(
			parseAvailableMemoryMb(
				"MemTotal: 16384000 kB\nMemAvailable: 6815744 kB\nBuffers: 1024 kB\n",
			),
		).toBe(6_656);
	});

	it("returns undefined when MemAvailable is missing", () => {
		expect(parseAvailableMemoryMb("MemTotal: 16384000 kB\n")).toBeUndefined();
	});

	it("returns undefined for a garbage MemAvailable value", () => {
		expect(
			parseAvailableMemoryMb("MemAvailable: unknown kB\n"),
		).toBeUndefined();
	});
});
