import { describe, expect, it, vi } from "vitest";
import {
	logMainShardAdmissionHold,
	mainShardParallelLaunchCapacity,
} from "../src/main-shard-parallel-admission.js";

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
