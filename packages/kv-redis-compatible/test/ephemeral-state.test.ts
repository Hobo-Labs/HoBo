/**
 * The ephemeral-state conformance suite against the in-memory engine, plus
 * the binding behaviour the suite cannot see from the port: the NOSCRIPT
 * fallback, what the meter counts, and the parse boundary.
 *
 * The same cases run against a real Valkey/Redis in `ephemeral-resp.test.ts`
 * and over the Upstash REST adapter in `@hobo/provider-upstash`.
 */
import {
	EPHEMERAL_STATE_COMMAND_COST,
	EphemeralStateParseError,
	parseEphemeralKey,
	parseEphemeralTtlMs,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	commandBudgetStatus,
	createManualClock,
	createMemoryEphemeralState,
	createMemoryRedisExecutor,
	createRedisEphemeralState,
	EPHEMERAL_SCRIPTS,
	EPHEMERAL_STATE_CONFORMANCE_CASES,
	type EphemeralConformanceContext,
	KvRedisCompatibleError,
	meterExecutor,
	runEphemeralStateConformance,
} from "../src/index.js";

function memoryContext(): EphemeralConformanceContext {
	const clock = createManualClock();
	const engine = createMemoryRedisExecutor({ now: clock.now });
	const metered = meterExecutor(engine);
	const first = createRedisEphemeralState({ executor: metered });
	const others = [1, 2, 3].map(() =>
		createRedisEphemeralState({ executor: engine }),
	);
	return {
		clients: [first, ...others],
		advanceTime: async (ms) => clock.advance(ms),
		usage: () => metered.usage(),
		keyPrefix: "mem:",
		ttlMs: 1_000,
	};
}

describe("ephemeral-state conformance — in-memory engine", () => {
	for (const entry of EPHEMERAL_STATE_CONFORMANCE_CASES) {
		it(entry.id, async () => {
			await entry.run(memoryContext());
		});
	}

	it("has unique case ids with a rationale each", () => {
		const ids = EPHEMERAL_STATE_CONFORMANCE_CASES.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const entry of EPHEMERAL_STATE_CONFORMANCE_CASES) {
			expect(entry.rationale.length).toBeGreaterThan(40);
		}
	});

	it("runs as a report outside a test runner, every case passing", async () => {
		const results = await runEphemeralStateConformance(memoryContext());
		expect(results.filter((result) => result.status !== "pass")).toEqual([]);
		expect(results).toHaveLength(EPHEMERAL_STATE_CONFORMANCE_CASES.length);
	});
});

describe("a broken binding fails the suite", () => {
	it("reports fail, not pass, when compareAndSet ignores the version", async () => {
		const clock = createManualClock();
		const engine = createMemoryRedisExecutor({ now: clock.now });
		const metered = meterExecutor(engine);
		const honest = createRedisEphemeralState({ executor: metered });
		const broken = {
			...honest,
			// Last-writer-wins: the bug a CAS exists to prevent.
			compareAndSet: async (
				key: Parameters<typeof honest.compareAndSet>[0],
				_expected: Parameters<typeof honest.compareAndSet>[1],
				value: string,
				ttlMs: Parameters<typeof honest.compareAndSet>[3],
			) => {
				const current = await honest.get(key);
				return current === undefined
					? { applied: false as const }
					: honest.compareAndSet(key, current.version, value, ttlMs);
			},
		};
		const results = await runEphemeralStateConformance({
			clients: [broken],
			advanceTime: async (ms) => clock.advance(ms),
			usage: () => metered.usage(),
			keyPrefix: "broken:",
			ttlMs: 1_000,
		});
		const failed = results.filter((result) => result.status === "fail");
		expect(failed.map((result) => result.id)).toContain(
			"versioning.cas-advances-and-rejects-stale",
		);
		expect(failed.map((result) => result.id)).toContain(
			"lock.expired-lease-is-lost",
		);
	});
});

describe("script handles and command cost", () => {
	const key = parseEphemeralKey("cost:k");
	const ttl = parseEphemeralTtlMs(1_000);

	it("falls back to EVAL once per script after NOSCRIPT, then stays on EVALSHA", async () => {
		const engine = createMemoryRedisExecutor({ now: () => 0 });
		const metered = meterExecutor(engine);
		const state = createRedisEphemeralState({ executor: metered });

		await state.increment(key, 1, ttl);
		expect(metered.usage()).toEqual({
			total: 2,
			byVerb: { EVALSHA: 1, EVAL: 1 },
		});
		await state.increment(key, 1, ttl);
		expect(metered.usage().total).toBe(3);

		engine.flushScripts(); // a restarted server forgets cached scripts
		metered.reset();
		expect(await state.increment(key, 1, ttl)).toBe(3);
		expect(metered.usage().total).toBe(2);
	});

	it("documents a cost for every port method", () => {
		for (const operation of [
			"get",
			"getMany",
			"putIfAbsent",
			"compareAndSet",
			"delete",
			"increment",
			"expire",
		] as const) {
			expect(EPHEMERAL_STATE_COMMAND_COST[operation]).toBe(1);
		}
		expect(EPHEMERAL_STATE_COMMAND_COST["ring.append"]).toBe(3);
		expect(EPHEMERAL_STATE_COMMAND_COST["ring.read"]).toBe(2);
	});

	it("meters verbs only and reports each to the callback", async () => {
		const seen: string[] = [];
		const metered = meterExecutor(createMemoryRedisExecutor(), {
			onCommand: (verb) => seen.push(verb),
		});
		const state = createRedisEphemeralState({ executor: metered });
		await state.putIfAbsent(key, "secret-looking-value", ttl);
		await state.get(key);
		expect(seen).toEqual(["EVALSHA", "EVAL", "HMGET"]);
		expect(JSON.stringify(metered.usage())).not.toContain("secret");
	});

	it("projects a period's usage against an allowance", () => {
		expect(
			commandBudgetStatus({
				used: 250_000,
				allowance: 500_000,
				elapsedFraction: 0.25,
			}),
		).toEqual({ usedFraction: 0.5, projected: 1_000_000, overBudget: true });
		expect(
			commandBudgetStatus({
				used: 100_000,
				allowance: 500_000,
				elapsedFraction: 0.5,
			}).overBudget,
		).toBe(false);
	});

	it("keeps every script to plain Redis 5+ hash commands", () => {
		for (const script of Object.values(EPHEMERAL_SCRIPTS)) {
			const verbs = [...script.body.matchAll(/redis\.call\('([A-Z]+)'/gu)].map(
				(match) => match[1],
			);
			for (const verb of verbs) {
				expect([
					"EXISTS",
					"HSET",
					"HMGET",
					"HINCRBY",
					"PEXPIRE",
					"DEL",
				]).toContain(verb);
			}
		}
	});
});

describe("the parse boundary", () => {
	it("refuses keys, TTLs, and steps the port cannot honour", () => {
		expect(() => parseEphemeralKey("")).toThrow(EphemeralStateParseError);
		expect(() => parseEphemeralKey("has space")).toThrow(
			EphemeralStateParseError,
		);
		expect(() => parseEphemeralKey("x".repeat(513))).toThrow(
			EphemeralStateParseError,
		);
		expect(() => parseEphemeralTtlMs(0)).toThrow(EphemeralStateParseError);
		expect(() => parseEphemeralTtlMs(1.5)).toThrow(EphemeralStateParseError);
		expect(() => parseEphemeralTtlMs(31 * 24 * 3_600_000)).toThrow(
			EphemeralStateParseError,
		);
	});

	it("rejects a non-integer increment step before sending anything", async () => {
		const metered = meterExecutor(createMemoryRedisExecutor());
		const state = createRedisEphemeralState({ executor: metered });
		await expect(
			state.increment(parseEphemeralKey("k"), 0.5, parseEphemeralTtlMs(1_000)),
		).rejects.toThrow(EphemeralStateParseError);
		expect(metered.usage().total).toBe(0);
	});

	it("surfaces an error reply as a rejected call, never as a value", async () => {
		const state = createRedisEphemeralState({
			executor: {
				execute: async () => ({ kind: "error", message: "WRONGTYPE" }),
			},
		});
		await expect(state.get(parseEphemeralKey("k"))).rejects.toThrow(
			KvRedisCompatibleError,
		);
	});

	it("uses injected incarnations, so versions are deterministic in tests", async () => {
		let n = 0;
		const state = createMemoryEphemeralState({
			now: () => 0,
			newIncarnation: () => `inc${++n}`,
		});
		const write = await state.putIfAbsent(
			parseEphemeralKey("k"),
			"v",
			parseEphemeralTtlMs(1_000),
		);
		expect(write).toEqual({ applied: true, version: "inc1:1" });
	});
});
