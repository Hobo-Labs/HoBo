import { describe, expect, it, vi } from "vitest";
import {
	effectiveParallelLaunchSlots,
	logMainShardAdmissionHold,
	mainShardParallelLaunchCapacity,
} from "../src/main-shard-parallel-admission.js";
import type { TrunkWaitReason } from "../src/trunk-wait.js";

describe("effectiveParallelLaunchSlots", () => {
	it("preserves zero memory headroom without clamping to one", () => {
		expect(effectiveParallelLaunchSlots(3, 0, 0)).toBe(0);
	});

	it("adds live containers to the memory-derived additional cap", () => {
		expect(effectiveParallelLaunchSlots(3, 1, 1)).toBe(2);
		expect(effectiveParallelLaunchSlots(3, 1, 4)).toBe(3);
	});

	it("falls back to policy slots when memory cap is unset", () => {
		expect(effectiveParallelLaunchSlots(3, 2, undefined)).toBe(3);
	});
});

describe("mainShardParallelLaunchCapacity", () => {
	it("caps at launch slots", () => {
		expect(
			mainShardParallelLaunchCapacity({
				availableMb: 32_768,
				requestMb: 4096,
				reserveMb: 2048,
				volatilityMb: 1024,
				launchSlots: 2,
			}),
		).toBe(2);
	});
});

describe("main shard hold dedupe", () => {
	it("logs at most one hold event per wait key per pass", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const job = {
			repository: "Hobo-Labs/HoBo",
			runId: 1,
			id: 9,
			name: "Main workspace test shard 1",
			runAttempt: 1,
		};
		const keys = new Set<string>();
		const emit = (reason: TrunkWaitReason) => {
			const key = `${job.repository}:${job.id}:${job.runAttempt}`;
			if (keys.has(key)) return;
			keys.add(key);
			logMainShardAdmissionHold(job, reason);
		};
		emit("memory-headroom");
		emit("fleet-capacity");
		expect(error).toHaveBeenCalledTimes(1);
		const line = JSON.parse(String(error.mock.calls[0]?.[0]));
		expect(line.reason).toBe("memory-headroom");
		error.mockRestore();
	});
});

describe("logMainShardAdmissionHold", () => {
	it("emits hold telemetry for workspace shards", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const job = {
			repository: "Hobo-Labs/HoBo",
			runId: 1,
			id: 9,
			name: "Main workspace test shard 1",
			runAttempt: 1,
		};
		logMainShardAdmissionHold(job, "memory-headroom", { requestMb: 4096 });
		expect(error).toHaveBeenCalled();
		const line = JSON.parse(String(error.mock.calls[0]?.[0]));
		expect(line.event).toBe("hobo_ci_main_shard_admission_hold");
		expect(line.shardIndex).toBe(1);
		expect(line.reason).toBe("memory-headroom");
		error.mockRestore();
	});
});
