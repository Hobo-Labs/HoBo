import { describe, expect, it } from "vitest";
import {
	classifyHostHealth,
	createHostHealthMonitor,
	type HostHealthSample,
	type HostHealthVerdict,
	readHostHealthSample,
} from "../src/isolated-worker/host-health.js";

const HEALTHY: HostHealthSample = {
	loadPerCpu: 0.6,
	memoryAvailableFraction: 0.5,
	storage: [{ path: "/work", freeBytesFraction: 0.6, freeInodesFraction: 0.7 }],
};

function sample(overrides: Partial<HostHealthSample>): HostHealthSample {
	return { ...HEALTHY, ...overrides };
}

describe("host health classification", () => {
	it("is ok with room in every resource", () => {
		expect(classifyHostHealth(HEALTHY)).toEqual({ state: "ok", reasons: [] });
	});

	it("names each resource at the worst level and nothing below it", () => {
		expect(
			classifyHostHealth(
				sample({ loadPerCpu: 1.5, memoryAvailableFraction: 0.15 }),
			),
		).toEqual({ state: "pressured", reasons: ["load", "memory"] });
		expect(
			classifyHostHealth(
				sample({
					loadPerCpu: 2,
					storage: [
						{ path: "/work", freeBytesFraction: 0.5, freeInodesFraction: 0.04 },
					],
				}),
			),
		).toEqual({ state: "critical", reasons: ["storage-inodes"] });
	});

	it("takes the worst filesystem, not the first", () => {
		expect(
			classifyHostHealth(
				sample({
					storage: [
						{ path: "/work", freeBytesFraction: 0.6, freeInodesFraction: 0.7 },
						{
							path: "/var/lib/docker",
							freeBytesFraction: 0.05,
							freeInodesFraction: 0.5,
						},
					],
				}),
			),
		).toEqual({ state: "critical", reasons: ["storage-bytes"] });
	});

	it("does not guess when memory cannot be read", () => {
		const { memoryAvailableFraction: _unread, ...unread } = HEALTHY;
		expect(classifyHostHealth(unread).state).toBe("ok");
	});

	it("honours authored thresholds", () => {
		expect(
			classifyHostHealth(sample({ loadPerCpu: 1.2 }), {
				loadPerCpu: { pressured: 1, critical: 2 },
				memoryAvailableFraction: { pressured: 0.15, critical: 0.07 },
				storageFreeFraction: { pressured: 0.15, critical: 0.05 },
			}).state,
		).toBe("pressured");
	});
});

describe("host health monitor", () => {
	function monitor(samples: (HostHealthSample | Error)[]) {
		let nowMs = 0;
		let reads = 0;
		const events: [string, Record<string, string | number | boolean>][] = [];
		const pressure: HostHealthVerdict[] = [];
		const health = createHostHealthMonitor({
			sample: async () => {
				const next = samples[Math.min(reads, samples.length - 1)];
				reads += 1;
				if (next === undefined || next instanceof Error)
					throw next ?? new Error("no sample");
				return next;
			},
			now: () => nowMs,
			log: (event, fields) => events.push([event, { ...fields }]),
			onPressure: (verdict) => pressure.push(verdict),
		});
		return {
			health,
			events,
			pressure,
			reads: () => reads,
			/** Advance one sampling interval and observe. */
			async step(count = 1) {
				let verdict = health.current();
				for (let index = 0; index < count; index += 1) {
					verdict = await health.observe();
					nowMs += 10_000;
				}
				return verdict;
			},
			advance(ms: number) {
				nowMs += ms;
			},
		};
	}
	const OVERLOADED = sample({ loadPerCpu: 4 });

	it("samples at most once per interval however often it is asked", async () => {
		const h = monitor([HEALTHY]);
		await h.health.observe();
		await h.health.observe();
		h.advance(9_999);
		await h.health.observe();
		expect(h.reads()).toBe(1);
		h.advance(1);
		await h.health.observe();
		expect(h.reads()).toBe(2);
	});

	it("needs three bad samples in a row before it calls the host critical", async () => {
		const h = monitor([HEALTHY, OVERLOADED, OVERLOADED, HEALTHY, OVERLOADED]);
		expect((await h.step(3)).state).toBe("ok");
		// One good sample breaks the run; the count starts over.
		expect((await h.step(2)).state).toBe("ok");
		expect((await h.step(2)).state).toBe("critical");
		expect(h.pressure).toEqual([{ state: "critical", reasons: ["load"] }]);
	});

	it("needs six good samples in a row before it clears", async () => {
		const h = monitor([
			OVERLOADED,
			OVERLOADED,
			OVERLOADED,
			...Array.from({ length: 5 }, () => HEALTHY),
			OVERLOADED,
			...Array.from({ length: 6 }, () => HEALTHY),
		]);
		expect((await h.step(3)).state).toBe("critical");
		expect((await h.step(5)).state).toBe("critical");
		expect((await h.step(1)).state).toBe("critical");
		expect((await h.step(5)).state).toBe("critical");
		expect((await h.step(1)).state).toBe("ok");
		// Recovery is not pressure.
		expect(h.pressure).toHaveLength(1);
	});

	it("counts a run that moves between bad levels, and settles on the mildest it sustained", async () => {
		const PRESSURED = sample({ loadPerCpu: 2 });
		const h = monitor([
			PRESSURED,
			OVERLOADED,
			PRESSURED,
			OVERLOADED,
			PRESSURED,
			OVERLOADED,
			PRESSURED,
			OVERLOADED,
			PRESSURED,
		]);
		// Pressured, critical, pressured: at least pressured three times running.
		expect((await h.step(3)).state).toBe("pressured");
		// Critical needs its own three in a row; alternating never gets there.
		expect((await h.step(6)).state).toBe("pressured");
		expect(h.pressure).toEqual([{ state: "pressured", reasons: ["load"] }]);
	});

	it("recovers through a run that moves between better levels, to the worst of them", async () => {
		const PRESSURED = sample({ loadPerCpu: 2 });
		const h = monitor([
			OVERLOADED,
			OVERLOADED,
			OVERLOADED,
			HEALTHY,
			PRESSURED,
			HEALTHY,
			PRESSURED,
			HEALTHY,
			PRESSURED,
			HEALTHY,
		]);
		expect((await h.step(3)).state).toBe("critical");
		expect((await h.step(5)).state).toBe("critical");
		expect((await h.step(1)).state).toBe("pressured");
	});

	it("gives up on a sample that does not come back and keeps the loop turning", async () => {
		const events: string[] = [];
		const health = createHostHealthMonitor({
			sample: () => new Promise<HostHealthSample>(() => undefined),
			sampleTimeoutMs: 20,
			log: (event, fields) => events.push(`${event}:${fields.message}`),
		});
		await expect(health.observe()).resolves.toEqual({
			state: "ok",
			reasons: [],
		});
		expect(events).toEqual([
			"hobo_ci_host_health_sample_failed:host health sample timed out",
		]);
	});

	it("logs the first sample, every change, and a lasting bad state every five minutes", async () => {
		const h = monitor([HEALTHY, OVERLOADED]);
		await h.step(1);
		expect(h.events).toHaveLength(1);
		expect(h.events[0]?.[1]).toMatchObject({ state: "ok", loadPerCpu: 0.6 });
		await h.step(3);
		expect(h.events.at(-1)?.[1]).toMatchObject({
			state: "critical",
			previous: "ok",
			reasons: "load",
			loadPerCpu: 4,
			storageFreeInodesFraction: 0.7,
		});
		expect(h.events).toHaveLength(2);
		await h.step(10);
		expect(h.events).toHaveLength(2);
		h.advance(5 * 60_000);
		await h.step(1);
		expect(h.events).toHaveLength(3);
	});

	it("keeps its verdict when a sample cannot be read", async () => {
		const h = monitor([
			OVERLOADED,
			OVERLOADED,
			OVERLOADED,
			new Error("statfs failed"),
		]);
		expect((await h.step(3)).state).toBe("critical");
		expect((await h.step(4)).state).toBe("critical");
		expect(h.events.at(-1)).toEqual([
			"hobo_ci_host_health_sample_failed",
			{ message: "statfs failed" },
		]);
	});
});

describe("host health sample", () => {
	const stats = (bfree: number, ffree: number, files = 1000) => ({
		blocks: 1000,
		bfree,
		files,
		ffree,
	});

	it("turns host facts into fractions, one entry per distinct path", async () => {
		const read: string[] = [];
		const result = await readHostHealthSample({
			loadAverage1m: 6,
			cpus: 4,
			memory: { availableMb: 2048, totalMb: 16_384 },
			paths: ["/var/lib/docker", "/work", "/work"],
			statfs: async (path) => {
				read.push(path);
				return path === "/work" ? stats(100, 40) : stats(500, 900);
			},
		});
		expect(read).toEqual(["/var/lib/docker", "/work"]);
		expect(result).toEqual({
			loadPerCpu: 1.5,
			memoryAvailableFraction: 0.125,
			storage: [
				{
					path: "/var/lib/docker",
					freeBytesFraction: 0.5,
					freeInodesFraction: 0.9,
				},
				{ path: "/work", freeBytesFraction: 0.1, freeInodesFraction: 0.04 },
			],
		});
	});

	it("does not call a filesystem without inodes short of them, or guess unread memory", async () => {
		const result = await readHostHealthSample({
			loadAverage1m: 1,
			cpus: 0,
			paths: ["/work"],
			statfs: async () => stats(500, 0, 0),
		});
		expect(result).toEqual({
			loadPerCpu: 1,
			storage: [
				{ path: "/work", freeBytesFraction: 0.5, freeInodesFraction: 1 },
			],
		});
	});
});
