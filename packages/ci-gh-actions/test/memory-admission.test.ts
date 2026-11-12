import { describe, expect, it, vi } from "vitest";
import {
	createWorkerMemoryAdmission,
	type MemoryLease,
} from "../src/isolated-worker/memory-admission.js";
import {
	memoryRequestForJob,
	resolveWorkerMemoryConfig,
} from "../src/isolated-worker/memory-classes.js";
import type { MemoryPeakHistories } from "../src/isolated-worker/memory-peaks.js";

function config(budgetMb: number, trunkSlots = 0) {
	return resolveWorkerMemoryConfig(
		{ HOBO_CI_WORKER_MEMORY_BUDGET_MB: String(budgetMb) },
		{ totalMemoryMb: 32_768, trunkSlots },
	);
}

function lease(
	id: string,
	memoryMb: number,
	memoryClass: "light" | "standard" | "heavy" = "heavy",
	state = "running",
	sandboxStage?: string,
): MemoryLease {
	return { id, memoryMb, memoryClass, state, sandboxStage };
}

describe("worker memory admission", () => {
	it("admits only the heavy jobs that fit and admits the next after a lease ends", () => {
		let now = 0;
		const admission = createWorkerMemoryAdmission(config(14_336), {
			now: () => now,
		});
		const active: MemoryLease[] = [];
		const generalLeaseIds = new Set<string>();
		for (const jobId of [1, 2, 3]) {
			const decision = admission.admit({
				jobId,
				memoryClass: "heavy",
				memoryMb: 8_192,
				rank: 1,
				activeLeases: active,
				generalLeaseIds,
			});
			if (decision.admitted) {
				active.push(lease(String(jobId), 8_192));
				generalLeaseIds.add(String(jobId));
			}
			expect(decision.admitted).toBe(jobId === 1);
		}
		expect(active).toHaveLength(1);
		active.splice(0, 1);
		generalLeaseIds.clear();
		now = 2_000;
		expect(
			admission.admit({
				jobId: 2,
				memoryClass: "heavy",
				memoryMb: 8_192,
				rank: 1,
				activeLeases: active,
				generalLeaseIds,
			}).admitted,
		).toBe(true);
	});

	it("allows backfill before HOL timeout and blocks the same rank after it", () => {
		let now = 0;
		const admission = createWorkerMemoryAdmission(config(8_192), {
			now: () => now,
		});
		const activeLeases = [lease("running", 5_000, "standard")];
		const generalLeaseIds = new Set(["running"]);
		const heavy = {
			jobId: 1,
			memoryClass: "heavy",
			memoryMb: 4_000,
			rank: 1,
			activeLeases,
			generalLeaseIds,
		} as const;
		expect(admission.admit(heavy)).toMatchObject({
			admitted: false,
			blockRank: false,
		});
		expect(
			admission.admit({
				jobId: 2,
				memoryClass: "light",
				memoryMb: 3_072,
				rank: 1,
				activeLeases,
				generalLeaseIds,
			}).admitted,
		).toBe(true);
		now = 60_001;
		expect(admission.admit(heavy)).toMatchObject({
			admitted: false,
			blockRank: true,
		});
	});

	it("blocks a waiting trunk rank immediately instead of waiting for HOL timeout", () => {
		const admission = createWorkerMemoryAdmission(config(8_192), {
			now: () => 0,
		});
		expect(
			admission.admit({
				jobId: 1,
				memoryClass: "heavy",
				memoryMb: 4_000,
				rank: 0,
				activeLeases: [lease("running", 5_000, "standard")],
				generalLeaseIds: new Set(["running"]),
			}),
		).toMatchObject({ admitted: false, blockRank: true });
	});

	it("never blocks lower ranks for a trunk request that exceeds the whole budget", () => {
		let now = 0;
		const admission = createWorkerMemoryAdmission(config(6_144), {
			now: () => now,
		});
		const impossible = {
			jobId: 1,
			memoryClass: "heavy",
			memoryMb: 8_192,
			rank: 0,
			activeLeases: [],
			generalLeaseIds: new Set<string>(),
		} as const;
		expect(admission.admit(impossible)).toMatchObject({
			admitted: false,
			blockRank: false,
		});
		now = 60_001;
		expect(admission.admit(impossible)).toMatchObject({
			admitted: false,
			blockRank: false,
		});
	});

	it("admits one heavy PR and trunk heavy on the 16 GiB box while a second PR waits", () => {
		const admission = createWorkerMemoryAdmission(
			resolveWorkerMemoryConfig({}, { totalMemoryMb: 15_989, trunkSlots: 1 }),
		);
		const activeLeases: MemoryLease[] = [];
		const generalLeaseIds = new Set<string>();
		expect(
			admission.admit({
				jobId: 1,
				memoryClass: "heavy",
				memoryMb: 6_144,
				rank: 1,
				activeLeases,
				generalLeaseIds,
			}).admitted,
		).toBe(true);
		activeLeases.push(lease("1", 6_144));
		generalLeaseIds.add("1");
		expect(
			admission.admit({
				jobId: 2,
				memoryClass: "heavy",
				memoryMb: 6_144,
				rank: 1,
				activeLeases,
				generalLeaseIds,
			}).admitted,
		).toBe(false);
		expect(
			admission.admit({
				jobId: 3,
				memoryClass: "heavy",
				memoryMb: 6_144,
				rank: 0,
				activeLeases,
				generalLeaseIds,
			}).admitted,
		).toBe(true);
	});

	it("fits three mixed slots inside 15989 MiB with a 2048 MiB host reserve", () => {
		const admission = createWorkerMemoryAdmission(
			resolveWorkerMemoryConfig({}, { totalMemoryMb: 15_989, trunkSlots: 0 }),
		);
		const activeLeases: MemoryLease[] = [];
		const generalLeaseIds = new Set<string>();
		const requests = [
			{ memoryClass: "heavy", memoryMb: 6_144 },
			{ memoryClass: "standard", memoryMb: 4_096 },
			{ memoryClass: "light", memoryMb: 3_072 },
		] as const;
		for (const [index, request] of requests.entries()) {
			expect(
				admission.admit({
					jobId: index + 1,
					...request,
					rank: 1,
					activeLeases,
					generalLeaseIds,
				}).admitted,
			).toBe(true);
			activeLeases.push(
				lease(String(index + 1), request.memoryMb, request.memoryClass),
			);
			generalLeaseIds.add(String(index + 1));
		}
		expect(activeLeases.reduce((sum, entry) => sum + entry.memoryMb, 0)).toBe(
			13_312,
		);
	});

	it("keeps heavy trunk memory reserved and admits trunk against the full budget", () => {
		const admission = createWorkerMemoryAdmission(config(12_288, 1));
		const activeLeases: MemoryLease[] = [];
		const generalLeaseIds = new Set<string>();
		expect(
			admission.admit({
				jobId: 1,
				memoryClass: "standard",
				memoryMb: 4_096,
				rank: 1,
				activeLeases,
				generalLeaseIds,
			}).admitted,
		).toBe(true);
		activeLeases.push(lease("1", 4_096, "standard"));
		generalLeaseIds.add("1");
		expect(
			admission.admit({
				jobId: 2,
				memoryClass: "heavy",
				memoryMb: 6_144,
				rank: 1,
				activeLeases,
				generalLeaseIds,
			}).admitted,
		).toBe(false);
		expect(
			admission.admit({
				jobId: 3,
				memoryClass: "heavy",
				memoryMb: 6_144,
				rank: 0,
				activeLeases,
				generalLeaseIds,
			}).admitted,
		).toBe(true);
	});

	it("uses real trunk lease classification for warm memory and protects the idle reservation", () => {
		const resolved = resolveWorkerMemoryConfig(
			{},
			{ totalMemoryMb: 15_989, trunkSlots: 1 },
		);
		const admission = createWorkerMemoryAdmission(resolved);
		const activeLeases = [lease("trunk", 6_144)];
		const generalLeaseIds = new Set<string>();
		expect(admission.reserveWarm(activeLeases, 6_144, generalLeaseIds)).toBe(
			true,
		);
		expect(
			createWorkerMemoryAdmission(resolved).reserveWarm(
				[],
				10_000,
				new Set<string>(),
			),
		).toBe(false);
	});

	it("counts a warm reservation and legacy leases without a stored request", () => {
		const admission = createWorkerMemoryAdmission(config(14_336));
		const activeLeases = [lease("legacy", 0, "heavy")];
		const generalLeaseIds = new Set(["legacy"]);
		expect(
			admission.admit({
				jobId: 1,
				memoryClass: "standard",
				memoryMb: 4_096,
				rank: 1,
				activeLeases,
				generalLeaseIds,
			}).admitted,
		).toBe(true);
		expect(admission.reserveWarm(activeLeases, 4_096, generalLeaseIds)).toBe(
			true,
		);
		expect(
			admission.admit({
				jobId: 2,
				memoryClass: "heavy",
				memoryMb: 6_144,
				rank: 1,
				activeLeases,
				generalLeaseIds,
			}).admitted,
		).toBe(false);
	});

	it("caps PR leases only while a trunk lease is active", () => {
		const log = vi.fn();
		const admission = createWorkerMemoryAdmission(config(14_336), { log });
		const activeLeases = [lease("trunk", 3_072, "light")];
		const generalLeaseIds = new Set<string>();
		const request = (jobId: number, rank = 1) =>
			({
				jobId,
				memoryClass: "light",
				memoryMb: 3_072,
				rank,
				activeLeases,
				generalLeaseIds,
			}) as const;
		expect(admission.admit(request(1)).admitted).toBe(true);
		activeLeases.push(lease("pr-1", 3_072, "light"));
		generalLeaseIds.add("pr-1");
		expect(admission.admit(request(2))).toMatchObject({
			admitted: false,
			blockRank: false,
		});
		expect(log).toHaveBeenLastCalledWith(
			"hobo_ci_memory_admission_wait",
			expect.objectContaining({
				reason: "trunk-pr-cap",
				activeGeneral: 1,
				prCapWithTrunk: 1,
			}),
		);
		expect(admission.admit(request(3, 0)).admitted).toBe(true);
		activeLeases.splice(0, 1);
		expect(admission.admit(request(2)).admitted).toBe(true);
	});

	it("lets trunk rank-0 admission ignore unlaunched PR reservations in the budget", () => {
		const admission = createWorkerMemoryAdmission(config(8_192), {
			prCapWithTrunk: 1,
		});
		const activeLeases = [
			lease("pr-reserved", 4_096, "standard", "reserved"),
			lease("trunk-run", 4_096, "standard", "running"),
		];
		const general = new Set(["pr-reserved"]);
		expect(
			admission.admit({
				jobId: 9,
				memoryClass: "standard",
				memoryMb: 4_096,
				rank: 0,
				activeLeases,
				generalLeaseIds: general,
				trunkLeaseIds: new Set(["trunk-run"]),
			}).admitted,
		).toBe(true);
	});

	it("can pause all new PR leases while trunk is active", () => {
		const admission = createWorkerMemoryAdmission(config(14_336), {
			prCapWithTrunk: 0,
		});
		expect(
			admission.admit({
				jobId: 1,
				memoryClass: "light",
				memoryMb: 3_072,
				rank: 1,
				activeLeases: [lease("trunk", 3_072, "light")],
				generalLeaseIds: new Set<string>(),
			}).admitted,
		).toBe(false);
	});

	it("logs each distinct wait state once and logs admission", () => {
		const log = vi.fn();
		const admission = createWorkerMemoryAdmission(config(6_144), {
			log,
			now: () => 0,
		});
		const request = {
			jobId: 42,
			memoryClass: "heavy",
			memoryMb: 8_192,
			rank: 1,
			activeLeases: [],
			generalLeaseIds: new Set<string>(),
		} as const;
		admission.admit(request);
		admission.admit(request);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_memory_admission_wait",
			expect.objectContaining({
				jobId: 42,
				memoryClass: "heavy",
				requestMb: 8_192,
				inUseMb: 0,
				budgetMb: 6_144,
				waitedMs: 0,
			}),
		);
		admission.admit({ ...request, memoryMb: 5_120 });
		expect(log).toHaveBeenLastCalledWith(
			"hobo_ci_memory_admitted",
			expect.objectContaining({ jobId: 42, waitedMs: 0 }),
		);
	});

	it("admits two PR jobs whose learned reservations fit where class sizes do not", () => {
		const peaks: MemoryPeakHistories = {
			"PR impact validation": { peaksMb: [100, 100, 100] },
			"PR off-path checks (ts-autocode surface, production packages)": {
				peaksMb: [100, 100, 100],
			},
		};
		const resolved = resolveWorkerMemoryConfig(
			{ HOBO_CI_WORKER_MEMORY_BUDGET_MB: "8000" },
			{ totalMemoryMb: 32_768, trunkSlots: 0 },
			peaks,
		);
		const log = vi.fn();
		const admission = createWorkerMemoryAdmission(resolved, { log });
		const activeLeases: MemoryLease[] = [];
		const generalLeaseIds = new Set<string>();
		const names = [
			"PR impact validation",
			"PR off-path checks (ts-autocode surface, production packages)",
		];

		for (const [index, name] of names.entries()) {
			const request = memoryRequestForJob(name, resolved);
			expect(request.memoryMb).toBe(1_024);
			expect(
				admission.admit({
					jobId: index + 1,
					...request,
					rank: 1,
					activeLeases,
					generalLeaseIds,
				}).admitted,
			).toBe(true);
			activeLeases.push(lease(String(index + 1), request.memoryMb));
			generalLeaseIds.add(String(index + 1));
		}
		expect(6_144 * 2).toBeGreaterThan(resolved.budgetMb);
		expect(log).toHaveBeenLastCalledWith(
			"hobo_ci_memory_admitted",
			expect.objectContaining({ learned: true, classMb: 6_144 }),
		);
	});

	it("restores class-sized reservations when learning is disabled", () => {
		const peaks: MemoryPeakHistories = {
			"PR impact validation": { peaksMb: [100, 100, 100] },
		};
		const resolved = resolveWorkerMemoryConfig(
			{
				HOBO_CI_WORKER_MEMORY_BUDGET_MB: "8000",
				HOBO_CI_WORKER_MEMORY_LEARN: "0",
			},
			{ totalMemoryMb: 32_768, trunkSlots: 0 },
			peaks,
		);
		const request = memoryRequestForJob("PR impact validation", resolved);
		const log = vi.fn();
		const admission = createWorkerMemoryAdmission(resolved, { log });
		const activeLeases: MemoryLease[] = [];
		const generalLeaseIds = new Set<string>();

		expect(request).toEqual({ memoryClass: "heavy", memoryMb: 6_144 });
		expect(
			admission.admit({
				jobId: 1,
				...request,
				rank: 1,
				activeLeases,
				generalLeaseIds,
			}).admitted,
		).toBe(true);
		activeLeases.push(lease("1", request.memoryMb));
		generalLeaseIds.add("1");
		expect(
			admission.admit({
				jobId: 2,
				...request,
				rank: 1,
				activeLeases,
				generalLeaseIds,
			}).admitted,
		).toBe(false);
		expect(log).toHaveBeenLastCalledWith(
			"hobo_ci_memory_admission_wait",
			expect.objectContaining({ learned: false, classMb: 6_144 }),
		);
	});

	it("recomputes the idle trunk reservation from new peaks", () => {
		const peaks = {
			"Main full gate": { peaksMb: [1_000, 1_000, 1_000] },
		} satisfies MemoryPeakHistories;
		const resolved = resolveWorkerMemoryConfig(
			{ HOBO_CI_WORKER_MEMORY_BUDGET_MB: "8000" },
			{ totalMemoryMb: 32_768, trunkSlots: 1 },
			peaks,
		);
		const admission = createWorkerMemoryAdmission(resolved);
		const request = {
			jobId: 1,
			memoryClass: "standard",
			memoryMb: 4_096,
			rank: 1,
			activeLeases: [],
			generalLeaseIds: new Set<string>(),
		} as const;
		expect(resolved.trunkReservationMb).toBe(1_536);
		expect(admission.admit(request).admitted).toBe(true);
		const trunk = peaks["Main full gate"];
		if (!trunk) throw new Error("trunk history missing");
		trunk.peaksMb = [3_000, 3_000, 3_000];
		expect(admission.admit(request).admitted).toBe(false);
	});

	it("dedupes memory-budget waits across small host availability changes", () => {
		let availableMb = 2_500;
		const log = vi.fn();
		const admission = createWorkerMemoryAdmission(config(6_144), {
			log,
			now: () => 0,
			availableMemoryMb: () => availableMb,
		});
		const request = {
			jobId: 42,
			memoryClass: "heavy",
			memoryMb: 8_192,
			rank: 1,
			activeLeases: [],
			generalLeaseIds: new Set<string>(),
		} as const;

		expect(admission.admit(request).admitted).toBe(false);
		availableMb = 2_600;
		expect(admission.admit(request).admitted).toBe(false);
		expect(log).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_memory_admission_wait",
			expect.objectContaining({
				reason: "memory-budget",
				availableMb: 2_500,
			}),
		);
	});

	it("blocks standard trunk admission under CPU contention and logs headroom fields", () => {
		const log = vi.fn();
		const admission = createWorkerMemoryAdmission(config(16_384, 3), {
			log,
			hostCores: () => 4,
			hostPressure: () => ({
				atMs: 0,
				loadPerCpu: 1.1,
			}),
			availableMemoryMb: () => 8_000,
		});
		const active = [
			lease("gate", 4_096, "standard", "running", "running"),
			lease("shard0", 4_096, "standard", "running", "running"),
		];
		expect(
			admission.admit({
				jobId: 3,
				memoryClass: "standard",
				memoryMb: 4_096,
				rank: 1,
				activeLeases: active,
				generalLeaseIds: new Set(["gate", "shard0"]),
			}),
		).toMatchObject({ admitted: false, reason: "cpu-contention" });
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_memory_admission_wait",
			expect.objectContaining({
				reason: "cpu-contention",
				cpuCores: 4,
				cpuRequest: 4,
				cpuReserved: 0,
				cpuRunningTrunkJobs: 2,
			}),
		);
	});

	it("admits main trunk shard on eight cores with load 1.6 and two or three running standards", () => {
		const admission = createWorkerMemoryAdmission(config(24_576, 4), {
			hostCores: () => 8,
			hostPressure: () => ({
				atMs: 0,
				loadPerCpu: 1.6 / 8,
			}),
			availableMemoryMb: () => 16_000,
		});
		const running = (id: string) =>
			lease(id, 4_096, "standard", "running", "running");
		for (const count of [2, 3] as const) {
			const active = Array.from({ length: count }, (_, index) =>
				running(`shard${index}`),
			);
			const generalLeaseIds = new Set(active.map((entry) => entry.id));
			expect(
				admission.admit({
					jobId: 90 + count,
					memoryClass: "standard",
					memoryMb: 4_096,
					rank: 0,
					activeLeases: active,
					generalLeaseIds,
				}),
			).toMatchObject({ admitted: true });
		}
	});

	it("does not reserve CPUs for memory-only holds with empty sandboxStage proto default", () => {
		const admission = createWorkerMemoryAdmission(config(24_576, 4), {
			hostCores: () => 8,
			hostPressure: () => ({
				atMs: 0,
				loadPerCpu: 1.9 / 8,
			}),
			availableMemoryMb: () => 20_000,
		});
		const active = [
			lease("shard0", 4_096, "standard", "running", "running"),
			lease("held1", 4_096, "standard", "reserved", ""),
		];
		const generalLeaseIds = new Set(active.map((entry) => entry.id));
		expect(
			admission.admit({
				jobId: 42,
				memoryClass: "standard",
				memoryMb: 4_096,
				rank: 0,
				activeLeases: active,
				generalLeaseIds,
			}),
		).toMatchObject({ admitted: true });
	});

	it("does not reserve CPUs for memory-only holds blocked on admission (run 43152192203)", () => {
		const admission = createWorkerMemoryAdmission(config(24_576, 4), {
			hostCores: () => 8,
			hostPressure: () => ({
				atMs: 0,
				loadPerCpu: 1.9 / 8,
			}),
			availableMemoryMb: () => 20_000,
		});
		const active = [
			lease("shard0", 4_096, "standard", "running", "running"),
			lease("held1", 4_096, "standard", "reserved"),
			lease("held2", 4_096, "standard", "reserved"),
			lease("held3", 4_096, "standard", "reserved"),
		];
		const generalLeaseIds = new Set(active.map((entry) => entry.id));
		expect(
			admission.admit({
				jobId: 41,
				memoryClass: "standard",
				memoryMb: 4_096,
				rank: 0,
				activeLeases: active,
				generalLeaseIds,
			}),
		).toMatchObject({ admitted: true });
	});

	it("reserves CPUs for a standard job launching but not yet running", () => {
		const log = vi.fn();
		const admission = createWorkerMemoryAdmission(config(24_576, 4), {
			log,
			hostCores: () => 8,
			hostPressure: () => ({
				atMs: 0,
				loadPerCpu: 1.9 / 8,
			}),
			availableMemoryMb: () => 16_000,
		});
		const active = [
			lease("shard0", 4_096, "standard", "running", "running"),
			lease("launching", 4_096, "standard", "running", "creating"),
		];
		const generalLeaseIds = new Set(active.map((entry) => entry.id));
		expect(
			admission.admit({
				jobId: 40,
				memoryClass: "standard",
				memoryMb: 4_096,
				rank: 0,
				activeLeases: active,
				generalLeaseIds,
			}),
		).toMatchObject({ admitted: false, reason: "cpu-contention" });
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_memory_admission_wait",
			expect.objectContaining({
				cpuReserved: 4,
				cpuRunningTrunkJobs: 1,
				cpuLoad1: 1.9,
				cpuHeadroom: 1.1,
			}),
		);
	});

	it("blocks admission when host PSI reports memory pressure", () => {
		const log = vi.fn();
		const admission = createWorkerMemoryAdmission(config(16_384), {
			log,
			hostPressure: () => ({
				atMs: 0,
				memoryPsi: { someAvg10: 40, fullAvg10: 30 },
			}),
			availableMemoryMb: () => 8_000,
		});
		expect(
			admission.admit({
				jobId: 1,
				memoryClass: "light",
				memoryMb: 1_024,
				rank: 1,
				activeLeases: [],
				generalLeaseIds: new Set<string>(),
			}),
		).toMatchObject({ admitted: false, reason: "host-pressure" });
	});

	it("blocks admission below the live host reserve and logs host-available", () => {
		const log = vi.fn();
		const availableMemoryMb = vi.fn(() => 2_500);
		const admission = createWorkerMemoryAdmission(config(8_000), {
			log,
			availableMemoryMb,
		});
		const request = {
			jobId: 1,
			memoryClass: "light",
			memoryMb: 1_024,
			rank: 1,
			activeLeases: [],
			generalLeaseIds: new Set<string>(),
		} as const;

		expect(admission.admit(request).admitted).toBe(false);
		expect(availableMemoryMb).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_memory_admission_wait",
			expect.objectContaining({
				reason: "host-available",
				availableMb: 2_500,
			}),
		);
	});

	it("uses only the budget when host availability is unavailable", () => {
		const admission = createWorkerMemoryAdmission(config(6_144), {
			availableMemoryMb: () => undefined,
		});
		expect(
			admission.admit({
				jobId: 1,
				memoryClass: "heavy",
				memoryMb: 6_144,
				rank: 1,
				activeLeases: [],
				generalLeaseIds: new Set<string>(),
			}).admitted,
		).toBe(true);
	});

	it("applies the live host guard to warm reservations", () => {
		let availableMb = 2_500;
		const availableMemoryMb = vi.fn(() => availableMb);
		const admission = createWorkerMemoryAdmission(config(8_000), {
			availableMemoryMb,
		});
		expect(admission.reserveWarm([], 1_024, new Set<string>())).toBe(false);
		availableMb = 3_072;
		expect(admission.reserveWarm([], 1_024, new Set<string>())).toBe(true);
		expect(availableMemoryMb).toHaveBeenCalledTimes(2);
	});

	it("counts an unlaunched reserved lease toward the memory budget", () => {
		const admission = createWorkerMemoryAdmission(config(6_144));
		const reserved = { ...lease("reserved", 6_144), state: "reserved" };

		expect(
			admission.admit({
				jobId: 1,
				memoryClass: "light",
				memoryMb: 3_072,
				rank: 1,
				activeLeases: [reserved],
				generalLeaseIds: new Set(["reserved"]),
			}),
		).toMatchObject({ admitted: false, reason: "memory-budget" });
	});
});
