/**
 * Host capacity (design §6.8): what this host has free, measured the way the
 * box worker measures it today. An absent figure is unknown, never zero.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Health } from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import { createHostCapacity } from "../../src/capacity/index.js";
import {
	type HostProbes,
	MEMORY_RESERVE_MB,
	parseAvailableMemoryMb,
	readHostCapacity,
} from "../../src/capacity/measure.js";

const probes = (
	memoryMb: number | undefined,
	diskMb: number | undefined,
): HostProbes => ({
	availableMemoryMb: async () => memoryMb,
	freeDiskMb: async () => diskMb,
});

describe("readHostCapacity", () => {
	it("offers every slot, the memory above the reserve and the disk under the work root", async () => {
		const reading = await readHostCapacity(
			{ slots: 4, workRoot: "/work", labels: ["linux", "x64"] },
			probes(MEMORY_RESERVE_MB + 6_000, 50_000),
		);
		expect(reading.capacity.freeSlots).toBe(4);
		expect(reading.capacity.totalSlots).toBe(4);
		expect(reading.capacity.freeMemoryMb).toBe(6_000);
		expect(reading.capacity.freeDiskMb).toBe(50_000);
		expect(reading.health).toBe(Health.REACHABLE);
		expect(reading.labels).toEqual(["linux", "x64"]);
	});

	it("reports unknown figures as absent, never as zero", async () => {
		const reading = await readHostCapacity(
			{ slots: 2, workRoot: "/work", labels: [] },
			probes(undefined, undefined),
		);
		expect(reading.capacity.freeMemoryMb).toBeUndefined();
		expect(reading.capacity.freeDiskMb).toBeUndefined();
		expect(reading.health).toBe(Health.REACHABLE);
	});

	it("is pressured when nothing is left above the memory reserve", async () => {
		const reading = await readHostCapacity(
			{ slots: 2, workRoot: "/work", labels: [] },
			probes(MEMORY_RESERVE_MB - 10, 10_000),
		);
		expect(reading.capacity.freeMemoryMb).toBe(0);
		expect(reading.health).toBe(Health.PRESSURED);
	});

	it("caps figures at the largest the record can carry", async () => {
		const reading = await readHostCapacity(
			{ slots: 1, workRoot: "/work", labels: [] },
			probes(2 ** 40, 2 ** 40),
		);
		expect(reading.capacity.freeMemoryMb).toBe(0xffff_ffff);
		expect(reading.capacity.freeDiskMb).toBe(0xffff_ffff);
	});
});

describe("parseAvailableMemoryMb", () => {
	it("reads MemAvailable from /proc/meminfo", () => {
		expect(
			parseAvailableMemoryMb(
				"MemTotal:       16384000 kB\nMemFree:  1000 kB\nMemAvailable:    8192000 kB\n",
			),
		).toBe(8_000);
	});

	it("answers undefined when the line is missing", () => {
		expect(parseAvailableMemoryMb("MemTotal: 1 kB\n")).toBeUndefined();
	});
});

describe("createHostCapacity", () => {
	it("measures this host", async () => {
		const workRoot = mkdtempSync(join(tmpdir(), "hobo-fleet-capacity-"));
		const reading = await createHostCapacity({
			slots: 3,
			workRoot,
			labels: ["self-hosted"],
		}).read();
		expect(reading.capacity.freeSlots).toBe(3);
		expect(reading.capacity.freeDiskMb).toBeGreaterThan(0);
		expect(reading.capacity.freeMemoryMb).toBeDefined();
		expect(reading.labels).toEqual(["self-hosted"]);
	});

	it("reports the disk of a missing work root as unknown", async () => {
		const reading = await createHostCapacity({
			slots: 1,
			workRoot: join(tmpdir(), "hobo-fleet-no-such-root", "deeper"),
			labels: [],
		}).read();
		expect(reading.capacity.freeDiskMb).toBeUndefined();
	});

	it("refuses a slot count that is not a whole number from 0 to 1024", () => {
		for (const slots of [-1, 1.5, 1025, Number.NaN])
			expect(() =>
				createHostCapacity({ slots, workRoot: tmpdir(), labels: [] }),
			).toThrow(/slots/u);
	});

	it("refuses an empty label", () => {
		expect(() =>
			createHostCapacity({ slots: 1, workRoot: tmpdir(), labels: [""] }),
		).toThrow(/label/u);
	});
});
