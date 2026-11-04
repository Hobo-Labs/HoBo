import { describe, expect, it, vi } from "vitest";
import {
	createWorkerMemoryAdmission,
	type MemoryLease,
} from "../src/isolated-worker/memory-admission.js";
import { resolveWorkerMemoryConfig } from "../src/isolated-worker/memory-classes.js";

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
): MemoryLease {
	return { id, memoryMb, memoryClass };
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
				memoryClass: "light",
				memoryMb: 3_072,
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
				8_192,
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
});
