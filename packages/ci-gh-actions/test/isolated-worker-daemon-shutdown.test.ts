import { describe, expect, it, vi } from "vitest";
import {
	countInFlightWorkerLeases,
	waitForIsolatedWorkerDrain,
} from "../src/isolated-worker/daemon-shutdown.js";

type WorkerLeaseRow = {
	accountId: string;
	provider: string;
	state: string;
};

describe("isolated worker daemon shutdown", () => {
	it("counts in-flight leases for the worker account only", () => {
		const leases = [
			{
				accountId: "worker-a",
				provider: "hobo-box-worker",
				state: "running",
			},
			{
				accountId: "worker-a",
				provider: "hobo-box-worker",
				state: "completed",
			},
			{
				accountId: "worker-b",
				provider: "hobo-box-worker",
				state: "running",
			},
			{
				accountId: "worker-a",
				provider: "vercel",
				state: "running",
			},
			{
				accountId: "worker-a",
				provider: "kubernetes",
				state: "claiming",
			},
		];
		expect(countInFlightWorkerLeases(leases, "worker-a")).toBe(2);
	});

	it("waits until in-flight leases drain or times out", async () => {
		let clock = 0;
		const leases: Array<WorkerLeaseRow> = [
			{
				accountId: "acct",
				provider: "kubernetes",
				state: "running",
			},
		];
		const activeLeases = vi
			.fn()
			.mockImplementationOnce(async () => leases)
			.mockImplementationOnce(async () => leases)
			.mockImplementation(async () => [
				{ accountId: "acct", provider: "kubernetes", state: "completed" },
			]);
		const sleep = vi.fn(async () => {
			clock += 500;
		});
		const result = await waitForIsolatedWorkerDrain({
			activeLeases,
			workerAccountId: "acct",
			pollMs: 500,
			timeoutMs: 2_000,
			sleep,
			now: () => clock,
		});
		expect(result).toEqual({ drained: true, remaining: 0 });
		expect(activeLeases).toHaveBeenCalledTimes(3);

		clock = 0;
		const stuck = vi.fn(async () => leases);
		const timedOut = await waitForIsolatedWorkerDrain({
			activeLeases: stuck,
			workerAccountId: "acct",
			pollMs: 100,
			timeoutMs: 250,
			sleep: async () => {
				clock += 100;
			},
			now: () => clock,
		});
		expect(timedOut).toEqual({ drained: false, remaining: 1 });
	});
});
