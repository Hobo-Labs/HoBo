/**
 * O16: the cache fleet behaves as before with no other service. It is a
 * local-mode fleet (`createLocalFleet`, one `BACKEND` member per bound cache,
 * declared under the owner's `AUTO_OWNER` approval) run by the one-active
 * loop of `@hobo/fleet/assignment`, and every call it makes goes to the
 * in-memory cache backends: this file fails any `fetch`, socket, TLS, HTTP or
 * UDP call.
 */
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { parseEphemeralKey, parseEphemeralTtlMs } from "@hobo/core";
import { CoordinationMode, MemberKind, MemberState } from "@hobo/fleet";
import {
	createMemoryRedisExecutor,
	createRedisEphemeralState,
	meterExecutor,
} from "@hobo/kv-redis-compatible";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	CacheBackendId,
	OpenedCacheBackend,
} from "../src/cache-backend.js";
import {
	type CacheFleetLogLine,
	createCacheFleet,
} from "../src/cache-fleet.js";
import { parseCacheOffers } from "../src/cache-offers.js";

const TTL = 60_000;
const SEAL = 150_000;
const START = Date.UTC(2026, 10, 11);
const key = parseEphemeralKey("hobo-ci:test:lease:one");
const ttl = parseEphemeralTtlMs(3_600_000);

// ── The guard: nothing leaves the process ──────────────────────────────────

const violations: string[] = [];
const restores: (() => void)[] = [];

function refuse(what: string): never {
	violations.push(what);
	throw new Error(`the cache fleet reached for the network: ${what}`);
}

/** Replaces a property for one test; defineProperty, because the replacement need not match the original's overloads. */
function patch<T extends object>(target: T, name: keyof T & string): void {
	const original = target[name];
	Object.defineProperty(target, name, {
		value: () => refuse(name),
		writable: true,
		configurable: true,
	});
	restores.push(() => {
		Object.defineProperty(target, name, {
			value: original,
			writable: true,
			configurable: true,
		});
	});
}

beforeEach(() => {
	violations.length = 0;
	patch(globalThis, "fetch");
	patch(net, "connect");
	patch(net, "createConnection");
	patch(net.Socket.prototype, "connect");
	patch(tls, "connect");
	patch(http, "request");
	patch(http, "get");
	patch(https, "request");
	patch(https, "get");
	patch(dgram, "createSocket");
});

afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	expect(violations).toEqual([]);
});

// ── In-memory cache backends ────────────────────────────────────────────────

type Member = OpenedCacheBackend & { down: boolean };

function world(
	ids: CacheBackendId[] = ["upstash", "valkey", "turso"],
	offersJson?: string,
) {
	const clock = { now: START };
	const members: Member[] = ids.map((id) => {
		const engine = createMemoryRedisExecutor({ now: () => clock.now });
		const meter = meterExecutor({
			execute: (command) => {
				if (self.down) throw new Error("connection refused");
				return engine.execute(command);
			},
		});
		const self: Member = {
			binding: {
				id,
				kind: id === "upstash" ? "upstash-rest" : "redis-protocol",
				names: [],
			},
			state: createRedisEphemeralState({ executor: meter }),
			units: ["commands"],
			usage: () => ({ commands: meter.usage().total }),
			close: async () => {},
			down: false,
		};
		return self;
	});
	const lines: CacheFleetLogLine[] = [];
	const fleet = createCacheFleet({
		backends: members,
		environment: "test",
		offers: parseCacheOffers(offersJson),
		now: () => clock.now,
		log: (line) => lines.push(line),
		scheduleActivation: async () => {},
		assignmentTtlMs: TTL,
		sealWaitMs: SEAL,
		sleep: async (ms) => {
			clock.now += ms;
		},
	});
	const member = (id: CacheBackendId): Member => {
		const found = members.find((entry) => entry.binding.id === id);
		if (found === undefined) throw new Error(`no member ${id}`);
		return found;
	};
	const spend = (id: CacheBackendId, used: number) =>
		member(id).state.increment(
			parseEphemeralKey(`hobo-ci:test:fleet:usage:${id}:commands:2026-11`),
			used,
			parseEphemeralTtlMs(30 * 86_400_000),
		);
	return { clock, members, lines, fleet, member, spend };
}

describe("the cache fleet as a local-mode fleet", () => {
	it("declares one ACTIVE BACKEND member per bound cache, in configured order, in a one-active fleet", async () => {
		const w = world();
		const local = await w.fleet.localFleet();
		expect(local.fleet.coordination).toBe(CoordinationMode.ONE_ACTIVE);
		expect(local.fleet.policy?.membershipEpochs).toBe(false);
		expect(
			local.members.map((record) => ({
				kind: record.kind,
				state: record.state,
				name: record.memberships[0]?.name,
			})),
		).toEqual(
			["upstash", "valkey", "turso"].map((name) => ({
				kind: MemberKind.BACKEND,
				state: MemberState.ACTIVE,
				name,
			})),
		);
	});

	it("runs bootstrap, a sealed switch, activation and a failover through the one-active loop", async () => {
		const w = world();
		await w.fleet.state.putIfAbsent(key, "v", ttl);
		expect(w.fleet.activeId()).toBe("upstash");
		await w.spend("upstash", 150_000);
		const switched = await w.fleet.tick();
		expect(switched).toMatchObject({
			action: "switch",
			target: "valkey",
			route: { action: "switch", target: "valkey" },
		});
		w.clock.now += SEAL;
		expect(await w.fleet.tick()).toMatchObject({
			action: "activate",
			active: "valkey",
		});
		w.member("valkey").down = true;
		expect(await w.fleet.tick()).toMatchObject({
			action: "failover",
			active: undefined,
			target: "turso",
		});
		// The loop logs its own tick line, and the relay its decision line.
		expect(w.lines.map((line) => line.event)).toEqual(
			expect.arrayContaining([
				"hobo_fleet_assignment_tick",
				"hobo_ci_cache_fleet_decision",
			]),
		);
	});

	it("keeps membership epochs off by default and pins the member set first once the configuration turns them on", async () => {
		const off = world();
		await off.fleet.state.get(key);
		expect((await off.fleet.tick()).action).toBe("keep");

		const on = world(undefined, JSON.stringify({ membershipEpochs: true }));
		expect((await on.fleet.localFleet()).fleet.policy?.membershipEpochs).toBe(
			true,
		);
		await on.fleet.state.get(key);
		expect(await on.fleet.tick()).toMatchObject({
			action: "membership",
			reasons: ["pin-members", "proposal-decided"],
		});
		expect((await on.fleet.tick()).action).toBe("keep");
	});

	it("answers a single member with no register and no network", async () => {
		const w = world(["upstash"]);
		await w.fleet.state.putIfAbsent(key, "v", ttl);
		expect(await w.fleet.tick()).toMatchObject({
			action: "single",
			active: "upstash",
		});
	});
});
