import { createMeteringBus, type UsageEvent } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createDaprActorHost,
	createInMemoryDaprClient,
	DaprLeaseConflictError,
	DaprStaleFenceError,
	defaultDaprRuntimeConfig,
} from "../src/index.js";

const CONFIG = defaultDaprRuntimeConfig("acme", "prod");

function hostFor(options: { withClient?: boolean; nowMs?: () => number } = {}) {
	return createDaprActorHost({
		config: CONFIG,
		...(options.withClient
			? { client: createInMemoryDaprClient() }
			: undefined),
		...(options.nowMs ? { nowMs: options.nowMs } : undefined),
		leaseTtlMs: 30_000,
	});
}

const stateOf = (host: ReturnType<typeof hostFor>, key = "Cart/1") =>
	host.state(key, {
		initialState: { items: 0 },
		fold: (state: { items: number }) => ({ items: state.items + 1 }),
	});

describe("acquiring an actor", () => {
	it("hands the first caller a lease", () => {
		expect(hostFor().acquire("Cart/1", { holderId: "a" })).toMatchObject({
			key: "Cart/1",
			holderId: "a",
			placement: "dapr",
		});
	});

	it("refuses a second holder while the first is live", () => {
		const host = hostFor();
		host.acquire("Cart/1", { holderId: "a" });
		expect(() => host.acquire("Cart/1", { holderId: "b" })).toThrow(
			DaprLeaseConflictError,
		);
	});

	it("names the holder that has it", () => {
		const host = hostFor();
		host.acquire("Cart/1", { holderId: "a" });
		expect(() => host.acquire("Cart/1", { holderId: "b" })).toThrow(
			/held by a/,
		);
	});

	it("lets a different actor be acquired independently", () => {
		const host = hostFor();
		host.acquire("Cart/1", { holderId: "a" });
		expect(() => host.acquire("Cart/2", { holderId: "b" })).not.toThrow();
	});

	it("hands the actor on after a release", () => {
		const host = hostFor();
		host.acquire("Cart/1", { holderId: "a" }).release();
		expect(() => host.acquire("Cart/1", { holderId: "b" })).not.toThrow();
	});

	it("hands the actor on after the lease expires", () => {
		let now = 1_000;
		const host = hostFor({ nowMs: () => now });
		host.acquire("Cart/1", { holderId: "a" });
		now += 31_000;
		expect(() => host.acquire("Cart/1", { holderId: "b" })).not.toThrow();
	});

	it("keeps the lease within its TTL", () => {
		let now = 1_000;
		const host = hostFor({ nowMs: () => now });
		host.acquire("Cart/1", { holderId: "a" });
		now += 29_000;
		expect(() => host.acquire("Cart/1", { holderId: "b" })).toThrow(
			DaprLeaseConflictError,
		);
	});

	it("carries an expiry the holder can see", () => {
		const host = hostFor({ nowMs: () => 1_000 });
		expect(host.acquire("Cart/1", { holderId: "a" }).expiresAt).toBe(
			new Date(31_000).toISOString(),
		);
	});

	it("freezes the lease it hands out", () => {
		expect(
			Object.isFrozen(hostFor().acquire("Cart/1", { holderId: "a" })),
		).toBe(true);
	});
});

describe("fence tokens", () => {
	it("starts at one", () => {
		expect(hostFor().acquire("Cart/1", { holderId: "a" }).fenceToken).toBe(1n);
	});

	it("increases on every re-acquire", () => {
		const host = hostFor();
		host.acquire("Cart/1", { holderId: "a" }).release();
		expect(host.acquire("Cart/1", { holderId: "b" }).fenceToken).toBe(2n);
	});

	it("keeps counting across an expiry, not just a release", () => {
		let now = 1_000;
		const host = hostFor({ nowMs: () => now });
		host.acquire("Cart/1", { holderId: "a" });
		now += 31_000;
		expect(host.acquire("Cart/1", { holderId: "b" }).fenceToken).toBe(2n);
	});

	it("counts per actor, not globally", () => {
		const host = hostFor();
		host.acquire("Cart/1", { holderId: "a" });
		expect(host.acquire("Cart/2", { holderId: "b" }).fenceToken).toBe(1n);
	});
});

describe("appending state", () => {
	it("accepts a write from the current holder", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		expect(stateOf(host).append(lease, { type: "item.Added" })).toMatchObject({
			seq: 1,
		});
	});

	it("numbers writes in order", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		const state = stateOf(host);
		state.append(lease, { type: "item.Added" });
		expect(state.append(lease, { type: "item.Added" }).seq).toBe(2);
	});

	it("refuses a write against an actor never acquired", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		expect(() =>
			stateOf(host, "Cart/2").append(lease, { type: "item.Added" }),
		).toThrow(DaprStaleFenceError);
	});

	it("refuses a write from a holder that released", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		lease.release();
		expect(() => stateOf(host).append(lease, { type: "item.Added" })).toThrow(
			DaprStaleFenceError,
		);
	});

	it("refuses a write carrying a superseded fence token", () => {
		const host = hostFor();
		const stale = host.acquire("Cart/1", { holderId: "a" });
		stale.release();
		host.acquire("Cart/1", { holderId: "b" });
		expect(() => stateOf(host).append(stale, { type: "item.Added" })).toThrow(
			/stale fence/,
		);
	});

	it("refuses a write whose holder does not match the token", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		expect(() =>
			stateOf(host).append(
				{ ...lease, holderId: "impostor" },
				{ type: "item.Added" },
			),
		).toThrow(DaprStaleFenceError);
	});

	it("refuses a write after the lease expired", () => {
		let now = 1_000;
		const host = hostFor({ nowMs: () => now });
		const lease = host.acquire("Cart/1", { holderId: "a" });
		now += 31_000;
		expect(() => stateOf(host).append(lease, { type: "item.Added" })).toThrow(
			/lease expired/,
		);
	});

	it("names the actor in every refusal", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		lease.release();
		expect(() => stateOf(host).append(lease, { type: "item.Added" })).toThrow(
			/Cart\/1/,
		);
	});
});

describe("reading state", () => {
	it("folds the appended events", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		const state = stateOf(host);
		state.append(lease, { type: "item.Added" });
		state.append(lease, { type: "item.Added" });
		expect(state.read()).toMatchObject({ seq: 2, state: { items: 2 } });
	});

	it("returns the initial state for an actor with no events", () => {
		expect(stateOf(hostFor()).read()).toMatchObject({
			seq: 0,
			state: { items: 0 },
		});
	});

	it("addresses the stream by app id and actor key", () => {
		expect(stateOf(hostFor()).read().streamId).toContain("Cart/1");
	});

	it("keeps two actors' streams apart", () => {
		const host = hostFor();
		const lease = host.acquire("Cart/1", { holderId: "a" });
		stateOf(host).append(lease, { type: "item.Added" });
		expect(stateOf(host, "Cart/2").read().seq).toBe(0);
	});
});

describe("the in-memory sidecar client path", () => {
	it("reports simulated fidelity for an in-memory client", () => {
		expect(hostFor({ withClient: true }).fidelity).toBe("simulated");
	});

	it("reports simulated fidelity without one", () => {
		expect(hostFor().fidelity).toBe("simulated");
	});

	it("still enforces single-writer with the client", () => {
		const host = hostFor({ withClient: true });
		host.acquire("Cart/1", { holderId: "a" });
		expect(() => host.acquire("Cart/1", { holderId: "b" })).toThrow(
			DaprLeaseConflictError,
		);
	});

	it("still fences state writes with the client", () => {
		const host = hostFor({ withClient: true });
		const lease = host.acquire("Cart/1", { holderId: "a" });
		lease.release();
		expect(() => stateOf(host).append(lease, { type: "item.Added" })).toThrow(
			DaprStaleFenceError,
		);
	});

	it("handles an actor key with no type separator", () => {
		const host = hostFor({ withClient: true });
		expect(() => host.acquire("singleton", { holderId: "a" })).not.toThrow();
	});

	it("handles an actor key with several separators", () => {
		const host = hostFor({ withClient: true });
		expect(() =>
			host.acquire("Cart/tenant-a/1", { holderId: "a" }),
		).not.toThrow();
	});

	it("releases through the client without throwing", () => {
		const host = hostFor({ withClient: true });
		expect(() =>
			host.acquire("Cart/1", { holderId: "a" }).release(),
		).not.toThrow();
	});

	it("ignores a release from a superseded lease", () => {
		const host = hostFor();
		const stale = host.acquire("Cart/1", { holderId: "a" });
		stale.release();
		const current = host.acquire("Cart/1", { holderId: "b" });
		stale.release();
		expect(() =>
			stateOf(host).append(current, { type: "item.Added" }),
		).not.toThrow();
	});
});

describe("metering", () => {
	it("emits a usage event on activation when a meter is wired", () => {
		const emitted: UsageEvent[] = [];
		const metering = createMeteringBus([
			{
				sinkId: "test",
				emit(event) {
					emitted.push(event);
				},
			},
		]);
		const host = createDaprActorHost({ config: CONFIG, metering });
		host.acquire("Cart/1", { holderId: "a" });
		expect(emitted).toHaveLength(1);
	});

	it("names the actor and the placement on the usage event", () => {
		const emitted: UsageEvent[] = [];
		const metering = createMeteringBus([
			{
				sinkId: "test",
				emit(event) {
					emitted.push(event);
				},
			},
		]);
		const host = createDaprActorHost({ config: CONFIG, metering });
		host.acquire("Cart/1", { holderId: "a" });
		expect(emitted[0]?.resource).toBe("Cart/1");
	});

	it("activates without one", () => {
		expect(() => hostFor().acquire("Cart/1", { holderId: "a" })).not.toThrow();
	});
});
