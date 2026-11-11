import { create } from "@bufbuild/protobuf";
import { ConfigurationSchema } from "@hobo/ci";
import { describe, expect, it, vi } from "vitest";
import {
	countInFlightWorkerLeases,
	mergeDrainInFlightCount,
	parseWorkerStopMode,
	stopIsolatedWorker,
	waitForIsolatedWorkerDrain,
	workerOfferKey,
	workerOfferKeys,
} from "../src/isolated-worker/daemon-shutdown.js";

const box = (id: string, providerAccountId: string, enabled = true) => ({
	id,
	provider: "hobo-box-worker",
	backend: "isolated-container",
	providerAccountId,
	enabled,
});

const configuration = create(ConfigurationSchema, {
	accounts: [
		{
			id: "customer-a",
			offers: [
				box("box", "worker-a"),
				box("box-off", "worker-a", false),
				box("other-box", "worker-b"),
				{
					id: "vercel",
					provider: "vercel",
					backend: "sandbox",
					providerAccountId: "worker-a",
				},
			],
		},
		{ id: "customer-b", offers: [box("box", "worker-b")] },
	],
});

describe("isolated worker daemon shutdown", () => {
	it("owns the isolated-container offers routed to this worker, disabled ones included", () => {
		expect([...workerOfferKeys(configuration, "worker-a")].sort()).toEqual(
			[
				workerOfferKey("customer-a", "box"),
				workerOfferKey("customer-a", "box-off"),
			].sort(),
		);
		expect(workerOfferKeys(undefined, "worker-a").size).toBe(0);
	});

	it("counts drain in-flight as the max of live leases and running worker containers", () => {
		expect(mergeDrainInFlightCount(0, 2)).toBe(2);
		expect(mergeDrainInFlightCount(3, 1)).toBe(3);
	});

	it("counts in-flight leases on this worker's offers, whatever customer account owns them", () => {
		const offers = workerOfferKeys(configuration, "worker-a");
		const leases = [
			{ accountId: "customer-a", offerId: "box", state: "running" },
			{ accountId: "customer-a", offerId: "box", state: "dispatched" },
			{ accountId: "customer-a", offerId: "box-off", state: "claiming" },
			{ accountId: "customer-a", offerId: "box", state: "completed" },
			{ accountId: "customer-a", offerId: "box", state: "reserved" },
			{ accountId: "customer-a", offerId: "other-box", state: "running" },
			{ accountId: "customer-a", offerId: "vercel", state: "running" },
			// Same offer id, another account: not this worker's offer.
			{ accountId: "customer-b", offerId: "box", state: "running" },
		];
		expect(countInFlightWorkerLeases(leases, offers)).toBe(3);
		// The worker's own id never names a lease's account: the old check
		// compared the two and found nothing to wait for.
		expect(
			countInFlightWorkerLeases(
				leases,
				new Set([workerOfferKey("worker-a", "box")]),
			),
		).toBe(0);
	});

	it("reconciles before every count, so a running job is waited for until its runner exits", async () => {
		let clock = 0;
		let running = 2;
		const order: string[] = [];
		const reconcile = vi.fn(async () => {
			order.push("reconcile");
			if (clock >= 1_000) running = Math.max(0, running - 1);
		});
		const inFlight = vi.fn(async () => {
			order.push("count");
			return running;
		});
		const waiting: number[] = [];
		const result = await waitForIsolatedWorkerDrain({
			inFlight,
			reconcile,
			pollMs: 500,
			timeoutMs: 10_000,
			onWaiting: (remaining) => waiting.push(remaining),
			sleep: async (ms) => {
				clock += ms;
			},
			now: () => clock,
		});
		expect(result).toEqual({ drained: true, remaining: 0 });
		expect(waiting).toEqual([2, 2, 1]);
		expect(order.slice(0, 4)).toEqual([
			"reconcile",
			"count",
			"reconcile",
			"count",
		]);
		expect(reconcile).toHaveBeenCalledTimes(inFlight.mock.calls.length);
	});

	it("keeps counting when a reconcile fails, and reports what is left on timeout", async () => {
		let clock = 0;
		const result = await waitForIsolatedWorkerDrain({
			inFlight: async () => 1,
			reconcile: async () => {
				throw new Error("github unavailable");
			},
			pollMs: 100,
			timeoutMs: 250,
			sleep: async (ms) => {
				clock += ms;
			},
			now: () => clock,
		});
		expect(result).toEqual({ drained: false, remaining: 1 });
	});

	it("defaults an unset or empty stop mode to handoff", () => {
		expect(parseWorkerStopMode(undefined)).toBe("handoff");
		expect(parseWorkerStopMode("")).toBe("handoff");
	});

	it("accepts both explicit stop modes", () => {
		expect(parseWorkerStopMode("handoff")).toBe("handoff");
		expect(parseWorkerStopMode("drain")).toBe("drain");
	});

	it("rejects an invalid stop mode", () => {
		expect(() => parseWorkerStopMode("wait")).toThrow(
			"invalid HOBO_CI_WORKER_STOP_MODE",
		);
	});

	it("hands off running containers after one reconcile and no waiting", async () => {
		const order: string[] = [];
		const reconcile = vi.fn(async () => {
			order.push("reconcile");
		});
		const inFlight = vi.fn(async () => {
			order.push("count");
			return 2;
		});
		const sleep = vi.fn(async () => undefined);
		const now = vi.fn(() => 0);
		const result = await stopIsolatedWorker({
			mode: "handoff",
			inFlight,
			reconcile,
			pollMs: 100,
			timeoutMs: 1_000,
			sleep,
			now,
		});
		expect(result).toEqual({
			mode: "handoff",
			drained: false,
			remaining: 2,
		});
		expect(order).toEqual(["reconcile", "count"]);
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(inFlight).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
		expect(now).not.toHaveBeenCalled();
	});

	it("hands off even when reconciliation fails", async () => {
		const result = await stopIsolatedWorker({
			mode: "handoff",
			inFlight: async () => 3,
			reconcile: async () => {
				throw new Error("docker unavailable");
			},
			pollMs: 100,
			timeoutMs: 1_000,
		});
		expect(result).toEqual({
			mode: "handoff",
			drained: false,
			remaining: 3,
		});
	});

	it("drain mode waits until in-flight work reaches zero", async () => {
		let clock = 0;
		let running = 1;
		const sleep = vi.fn(async (ms: number) => {
			clock += ms;
		});
		const result = await stopIsolatedWorker({
			mode: "drain",
			inFlight: async () => running,
			reconcile: async () => {
				if (clock > 0) running = 0;
			},
			pollMs: 100,
			timeoutMs: 1_000,
			sleep,
			now: () => clock,
		});
		expect(result).toEqual({ mode: "drain", drained: true, remaining: 0 });
		expect(sleep).toHaveBeenCalledTimes(1);
	});

	it("drain mode reports the remaining work on timeout", async () => {
		let clock = 0;
		const result = await stopIsolatedWorker({
			mode: "drain",
			inFlight: async () => 1,
			reconcile: async () => undefined,
			pollMs: 100,
			timeoutMs: 250,
			sleep: async (ms) => {
				clock += ms;
			},
			now: () => clock,
		});
		expect(result).toEqual({ mode: "drain", drained: false, remaining: 1 });
		expect(clock).toBe(250);
	});
});
