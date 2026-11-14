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
	createHostProbes,
	type HostProbes,
	type HostReaders,
	MEMORY_RESERVE_MB,
	type MemoryPressure,
	parseAvailableMemoryMb,
	parseMemoryPressure,
	readHostCapacity,
	type VolumeFigures,
} from "../../src/capacity/measure.js";

const probes = (
	memoryMb: number | undefined,
	volume: VolumeFigures,
	pressure: MemoryPressure = {},
): HostProbes => ({
	availableMemoryMb: async () => memoryMb,
	volume: async () => volume,
	memoryPressure: async () => pressure,
});

const PSI_TEXT =
	"some avg10=31.50 avg60=12.00 avg300=3.10 total=123456\nfull avg10=6.25 avg60=2.00 avg300=0.40 total=6543\n";

/** Fake fs readers: files by path, one statfs answer, and a platform. */
function readers(
	files: Readonly<Record<string, string>>,
	stats: Readonly<{ bavail: number; bsize: number; ffree: number }> | undefined,
	platform: NodeJS.Platform = "linux",
): HostReaders {
	return {
		platform,
		async readFile(path) {
			const text = files[path];
			if (text === undefined) throw new Error(`ENOENT: ${path}`);
			return text;
		},
		async statfs() {
			if (stats === undefined) throw new Error("ENOENT");
			return stats;
		},
		freemem: () => 4 * 1024 * 1024 * 1024,
	};
}

describe("readHostCapacity", () => {
	it("offers every slot, the memory above the reserve and the disk under the work root", async () => {
		const reading = await readHostCapacity(
			{ slots: 4, workRoot: "/work", labels: ["linux", "x64"] },
			probes(MEMORY_RESERVE_MB + 6_000, { freeDiskMb: 50_000 }),
		);
		expect(reading.capacity.freeSlots).toBe(4);
		expect(reading.capacity.totalSlots).toBe(4);
		expect(reading.capacity.freeMemoryMb).toBe(6_000);
		expect(reading.capacity.freeDiskMb).toBe(50_000);
		expect(reading.health).toBe(Health.REACHABLE);
		expect(reading.labels).toEqual(["linux", "x64"]);
		expect(reading.hostSignals).toEqual({});
	});

	it("carries free inodes and memory PSI beside the record as host signals", async () => {
		const reading = await readHostCapacity(
			{ slots: 1, workRoot: "/work", labels: [] },
			probes(
				MEMORY_RESERVE_MB + 1_000,
				{ freeDiskMb: 20_000, freeInodes: 12_345 },
				{ some: 31.5, full: 6.25 },
			),
		);
		expect(reading.hostSignals).toEqual({
			freeInodes: 12_345,
			psiMemorySome: 31.5,
			psiMemoryFull: 6.25,
		});
		// The record itself is unchanged: the agent derives the refusal (L43).
		expect(reading.health).toBe(Health.REACHABLE);
	});

	it("reports unknown figures as absent, never as zero", async () => {
		const reading = await readHostCapacity(
			{ slots: 2, workRoot: "/work", labels: [] },
			probes(undefined, {}),
		);
		expect(reading.capacity.freeMemoryMb).toBeUndefined();
		expect(reading.capacity.freeDiskMb).toBeUndefined();
		expect(reading.health).toBe(Health.REACHABLE);
	});

	it("is pressured when nothing is left above the memory reserve", async () => {
		const reading = await readHostCapacity(
			{ slots: 2, workRoot: "/work", labels: [] },
			probes(MEMORY_RESERVE_MB - 10, { freeDiskMb: 10_000 }),
		);
		expect(reading.capacity.freeMemoryMb).toBe(0);
		expect(reading.health).toBe(Health.PRESSURED);
	});

	it("caps figures at the largest the record can carry", async () => {
		const reading = await readHostCapacity(
			{ slots: 1, workRoot: "/work", labels: [] },
			probes(2 ** 40, { freeDiskMb: 2 ** 40 }),
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

describe("parseMemoryPressure", () => {
	it("reads avg10 of the some and full lines", () => {
		expect(parseMemoryPressure(PSI_TEXT)).toEqual({ some: 31.5, full: 6.25 });
	});

	it("leaves a missing line unknown", () => {
		expect(
			parseMemoryPressure("some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"),
		).toEqual({ some: 0 });
		expect(parseMemoryPressure("")).toEqual({});
		expect(parseMemoryPressure("some avg60=1.00\n")).toEqual({});
	});
});

describe("createHostProbes", () => {
	const STATS = { bavail: 2_621_440, bsize: 4_096, ffree: 30_000 };

	it("reads MemAvailable, the work volume and memory PSI through the readers", async () => {
		const probe = createHostProbes(
			readers(
				{
					"/proc/meminfo": "MemAvailable:    8192000 kB\n",
					"/proc/pressure/memory": PSI_TEXT,
				},
				STATS,
			),
		);
		expect(await probe.availableMemoryMb()).toBe(8_000);
		expect(await probe.volume("/work")).toEqual({
			freeDiskMb: 10_240,
			freeInodes: 30_000,
		});
		expect(await probe.memoryPressure()).toEqual({ some: 31.5, full: 6.25 });
	});

	it("answers unknown when a file or the volume cannot be read", async () => {
		const probe = createHostProbes(readers({}, undefined));
		expect(await probe.availableMemoryMb()).toBeUndefined();
		expect(await probe.volume("/work")).toEqual({});
		expect(await probe.memoryPressure()).toEqual({});
	});

	it("uses freemem and reads no PSI off Linux", async () => {
		const probe = createHostProbes(
			readers({ "/proc/pressure/memory": PSI_TEXT }, STATS, "darwin"),
		);
		expect(await probe.availableMemoryMb()).toBe(4_096);
		expect(await probe.memoryPressure()).toEqual({});
	});

	it("drops a figure that is not a whole, non-negative number", async () => {
		const probe = createHostProbes(
			readers({}, { bavail: 1, bsize: 4_096, ffree: -1 }),
		);
		expect(await probe.volume("/work")).toEqual({ freeDiskMb: 0 });
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
