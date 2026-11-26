/**
 * The cache fleet: exactly one active backend read from the register, sealed
 * moves, failing closed, and budget routing on the repair tick. Every member
 * is the in-memory engine; the clock is the test's.
 */
import { parseEphemeralKey, parseEphemeralTtlMs } from "@hobo/core";
import {
	createMemoryRedisExecutor,
	createRedisEphemeralState,
	meterExecutor,
} from "@hobo/kv-redis-compatible";
import { describe, expect, it } from "vitest";
import type {
	CacheBackendId,
	CacheBackendKind,
	OpenedCacheBackend,
} from "../src/cache-backend.js";
import {
	type CacheFleetLogLine,
	CacheFleetUnavailableError,
	createCacheFleet,
} from "../src/cache-fleet.js";
import { parseCacheOffers } from "../src/cache-offers.js";

const TTL = 60_000;
const SEAL = 150_000;
// Ten days into November 2026.
const START = Date.UTC(2026, 10, 11);
const key = parseEphemeralKey("hobo-ci:test:lease:one");
const ttl = parseEphemeralTtlMs(3_600_000);

type Member = OpenedCacheBackend & {
	down: boolean;
	wipe(): void;
	commands(): number;
};

function member(
	id: CacheBackendId,
	kind: CacheBackendKind,
	clock: { now: number },
): Member {
	let engine = createMemoryRedisExecutor({ now: () => clock.now });
	const meter = meterExecutor({
		execute: (command) => {
			if (self.down) throw new Error("connection refused");
			return engine.execute(command);
		},
	});
	const self: Member = {
		binding: { id, kind, names: [] },
		state: createRedisEphemeralState({ executor: meter }),
		units: ["commands"],
		usage: () => ({ commands: meter.usage().total }),
		close: async () => {},
		down: false,
		wipe() {
			engine = createMemoryRedisExecutor({ now: () => clock.now });
		},
		commands: () => meter.usage().total,
	};
	return self;
}

function world(ids: CacheBackendId[] = ["upstash", "valkey", "turso"]) {
	const clock = { now: START };
	const members = ids.map((id) =>
		member(id, id === "upstash" ? "upstash-rest" : "redis-protocol", clock),
	);
	const lines: CacheFleetLogLine[] = [];
	const scheduled: { delaySeconds: number; epoch: number }[] = [];
	const instance = (offersJson?: string) =>
		createCacheFleet({
			backends: members,
			environment: "test",
			offers: parseCacheOffers(offersJson),
			now: () => clock.now,
			log: (line) => lines.push(line),
			scheduleActivation: async (delaySeconds, epoch) => {
				scheduled.push({ delaySeconds, epoch });
			},
			assignmentTtlMs: TTL,
			sealWaitMs: SEAL,
			sleep: async (ms) => {
				clock.now += ms;
			},
		});
	return {
		clock,
		members,
		lines,
		scheduled,
		instance,
		member(id: CacheBackendId): Member {
			const found = members.find((entry) => entry.binding.id === id);
			if (!found) throw new Error(`no member ${id}`);
			return found;
		},
		/** Who holds `key`: the backend the relay's write landed on. */
		async holders(): Promise<string[]> {
			const found: string[] = [];
			for (const entry of members)
				if (!entry.down && (await entry.state.get(key)) !== undefined)
					found.push(entry.binding.id);
			return found;
		},
		/** Pretend a member has already spent `used` commands this month. */
		async spend(id: CacheBackendId, used: number) {
			await this.member(id).state.increment(
				parseEphemeralKey(`hobo-ci:test:fleet:usage:${id}:commands:2026-11`),
				used,
				parseEphemeralTtlMs(30 * 86_400_000),
			);
		},
	};
}

describe("one bound cache", () => {
	it("is active with no register to read", async () => {
		const w = world(["upstash"]);
		const fleet = w.instance();
		await fleet.state.putIfAbsent(key, "v", ttl);
		expect(await w.holders()).toEqual(["upstash"]);
		expect(
			await w
				.member("upstash")
				.state.get(parseEphemeralKey("hobo-ci:test:fleet:assignment")),
		).toBeUndefined();
		expect(await fleet.tick()).toMatchObject({
			action: "single",
			active: "upstash",
		});
	});
});

describe("several bound caches", () => {
	it("bootstraps the first configured member as active, the same from every instance", async () => {
		const w = world();
		const [one, two] = [w.instance(), w.instance()];
		await Promise.all([
			one.state.putIfAbsent(key, "v", ttl),
			two.state.get(key),
		]);
		expect(await w.holders()).toEqual(["upstash"]);
		expect([one.activeId(), two.activeId()]).toEqual(["upstash", "upstash"]);
	});

	it("caches the answer for a minute, then reads the register again", async () => {
		const w = world();
		const fleet = w.instance();
		await fleet.state.get(key);
		const reads = w.member("valkey").commands();
		await fleet.state.get(key);
		w.clock.now += TTL - 1;
		await fleet.state.get(key);
		expect(w.member("valkey").commands()).toBe(reads);
		w.clock.now += 1;
		await fleet.state.get(key);
		expect(w.member("valkey").commands()).toBeGreaterThan(reads);
	});

	it("fails closed, retryably, when no majority can be read", async () => {
		const w = world();
		w.member("valkey").down = true;
		w.member("turso").down = true;
		const fleet = w.instance();
		const refused = fleet.state.get(key);
		await expect(refused).rejects.toBeInstanceOf(CacheFleetUnavailableError);
		await expect(refused).rejects.toMatchObject({
			retryable: true,
			reason: "no-majority",
		});
	});
});

describe("a planned move", () => {
	it("seals, refuses writes everywhere once every cached answer has lapsed, then activates the target", async () => {
		const w = world();
		const deciding = w.instance();
		const serving = w.instance();
		await serving.state.putIfAbsent(key, "before", ttl);
		await deciding.tick();
		// Upstash has spent 150,000 commands in ten days: 90% projected.
		await w.spend("upstash", 150_000);
		const decision = await deciding.tick();
		expect(decision).toMatchObject({
			action: "switch",
			active: "upstash",
			target: "valkey",
		});
		expect(w.scheduled).toEqual([
			{ delaySeconds: SEAL / 1000, epoch: decision.epoch },
		]);
		const line = w.lines.find(
			(entry) =>
				entry.event === "hobo_ci_cache_fleet_decision" &&
				entry.action === "switch",
		);
		expect(line).toMatchObject({
			target: "valkey",
			reasons: ["commands projected 90%"],
			eligible: ["valkey", "turso"],
		});
		// The serving instance's answer is at most a minute old: still upstash.
		await serving.state.get(key);
		w.clock.now += TTL;
		await expect(serving.state.get(key)).rejects.toMatchObject({
			reason: "sealed",
		});
		await expect(deciding.state.get(key)).rejects.toMatchObject({
			reason: "sealed",
		});
		// Before the wait is over, a tick only reschedules.
		expect(await deciding.tick()).toMatchObject({ action: "sealed-waiting" });
		w.clock.now += SEAL;
		expect(await serving.tick()).toMatchObject({
			action: "activate",
			active: "valkey",
		});
		// Cold start: the new backend holds nothing until the relay writes it.
		await serving.state.putIfAbsent(key, "after", ttl);
		w.clock.now += TTL;
		expect(await deciding.state.get(key)).toMatchObject({ value: "after" });
		expect(await w.holders()).toEqual(["upstash", "valkey"]);
		expect(deciding.activeId()).toBe("valkey");
	});

	it("does not move back to the member it left within the month", async () => {
		const w = world(["upstash", "turso"]);
		const fleet = w.instance();
		await fleet.state.get(key);
		await w.spend("upstash", 150_000);
		expect((await fleet.tick()).action).toBe("switch");
		w.clock.now += SEAL;
		expect((await fleet.tick()).action).toBe("activate");
		w.clock.now += 2 * 3_600_000;
		const later = await fleet.tick();
		expect(later).toMatchObject({ action: "keep", active: "turso" });
	});
});

describe("an unplanned move", () => {
	it("probes a failing active member, then seals without it and activates a reachable one", async () => {
		const w = world();
		const fleet = w.instance();
		await fleet.state.get(key);
		w.member("upstash").down = true;
		const decision = await fleet.tick();
		expect(decision).toMatchObject({
			action: "failover",
			active: undefined,
			target: "valkey",
			reasons: ["writer-unreachable"],
		});
		w.clock.now += SEAL;
		expect(await fleet.tick()).toMatchObject({
			action: "activate",
			active: "valkey",
		});
	});

	it("holds when the active member's failure is not yet long enough", async () => {
		const w = world();
		const fleet = createCacheFleet({
			backends: w.members,
			environment: "test",
			offers: parseCacheOffers(
				JSON.stringify({ marks: { failoverAfterSeconds: 600 } }),
			),
			now: () => w.clock.now,
			assignmentTtlMs: TTL,
			sealWaitMs: SEAL,
			sleep: async (ms) => {
				w.clock.now += ms;
			},
		});
		await fleet.state.get(key);
		w.member("upstash").down = true;
		expect(await fleet.tick()).toMatchObject({
			action: "hold",
			reasons: ["writer-unreachable", "awaiting-failover-threshold"],
		});
	});
});

describe("usage, per member, in the units it bills", () => {
	it("adds each instance's commands to the member's monthly counter and logs names and numbers only", async () => {
		const w = world(["upstash"]);
		const fleet = w.instance();
		for (let n = 0; n < 9; n += 1) await fleet.state.get(key);
		await fleet.flushUsage(true);
		const line = w.lines.find((entry) => entry.event === "hobo_ci_cache_usage");
		expect(line).toMatchObject({
			backend: "upstash",
			kind: "upstash-rest",
			month: "2026-11",
			used: { commands: 9 },
			allowance: { commands: 500_000 },
			overBudget: false,
		});
		// Within the interval nothing is written; after it, the report's own
		// increment is counted.
		const before = w.lines.length;
		await fleet.flushUsage();
		expect(w.lines).toHaveLength(before);
		w.clock.now += 60_000;
		await fleet.flushUsage();
		expect(w.lines.at(-1)).toMatchObject({ used: { commands: 9 + 2 } });
	});
});
