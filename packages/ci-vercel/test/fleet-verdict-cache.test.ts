import {
	type FleetReporter,
	type FleetVerdictMode,
	parseFleetVerdictPath,
	parseFleetVerdictReport,
} from "@hobo/ci-gh-actions";
import {
	createMemoryRedisExecutor,
	createRedisEphemeralState,
} from "@hobo/kv-redis-compatible";
import { describe, expect, it } from "vitest";
import { createCacheFleetVerdicts } from "../src/fleet-verdict-cache.js";

const START = Date.parse("2026-11-12T16:00:00Z");
const repository = parseFleetVerdictPath("/v1/fleet/verdicts/Hobo-Labs/HoBo");
const box1: FleetReporter = {
	id: "box-1",
	publicKey: "VQLcrFt00Tc-cySxdYNR4cXm5phbpj5QpvkTWtOr5q8",
	accountId: "hobo-labs",
	labels: ["hobo"],
};
const enrolled = { reporters: [box1], dailyBlockMinutes: 240 };

function setup() {
	if (!repository) throw new Error("no repository");
	const clock = { now: START };
	// The cache: an engine the test can replace, as a flushed store would be.
	let engine = createMemoryRedisExecutor({ now: () => clock.now });
	const state = createRedisEphemeralState({
		executor: { execute: (command) => engine.execute(command) },
	});
	const verdicts = (environment = "production") =>
		createCacheFleetVerdicts({ state, environment, now: () => clock.now });
	let sequence = BigInt(START);
	const report = async (
		kept: ReturnType<typeof verdicts>,
		blocks: boolean,
		options: {
			mode?: FleetVerdictMode;
			ttlSeconds?: number;
			sequence?: bigint;
		} = {},
	) => {
		const parsed = parseFleetVerdictReport(
			JSON.stringify({
				blocked: blocks ? { hobo: { reason: "no-capacity" } } : {},
				ttlSeconds: options.ttlSeconds ?? 180,
				mode: options.mode ?? "report",
			}),
		);
		if (!parsed) throw new Error("not a report");
		sequence += 1n;
		return kept.accept(
			{
				repository,
				reporter: box1,
				sequence: options.sequence ?? sequence,
				report: parsed,
			},
			enrolled,
		);
	};
	const served = async (kept: ReturnType<typeof verdicts>) =>
		(await kept.read(repository, enrolled)).blocked.hobo !== undefined;
	return {
		clock,
		verdicts,
		report,
		served,
		repository,
		flush: () => {
			engine = createMemoryRedisExecutor({ now: () => clock.now });
		},
	};
}

describe("fleet verdicts on the cache", () => {
	it("serves what was reported until it expires, and nothing after", async () => {
		const h = setup();
		const kept = h.verdicts();
		expect(await h.served(kept)).toBe(false);
		await h.report(kept, true);
		expect(await h.served(kept)).toBe(true);
		// The reporter stops (its box crashed): the entry lapses at 180 s.
		h.clock.now += 179_000;
		expect(await h.served(kept)).toBe(true);
		h.clock.now += 1_000;
		expect(await h.served(kept)).toBe(false);
		const status = await kept.status(h.repository, enrolled);
		expect(status.reporters[0]?.live).toBe(false);
		expect(status.reporters[0]?.state?.labels.hobo?.lastBlockedAt).toBe(
			"2026-11-12T16:00:00.000Z",
		);
	});

	it("serves a clear within one report of the reporter clearing", async () => {
		const h = setup();
		const kept = h.verdicts();
		await h.report(kept, true);
		h.clock.now += 60_000;
		await h.report(kept, false);
		expect(await h.served(kept)).toBe(false);
	});

	it("after the cache is lost, comes back with the next report, restarts the allowance and resumes replay protection", async () => {
		const h = setup();
		const kept = h.verdicts();
		for (let minute = 0; minute < 3; minute++) {
			await h.report(kept, true);
			h.clock.now += 60_000;
		}
		await h.report(kept, true);
		expect(
			(await kept.status(h.repository, enrolled)).allowance.hobo?.usedSeconds,
		).toBe(180);
		h.flush();
		// Nothing kept: open, and no reporter is live.
		expect(await h.served(kept)).toBe(false);
		const lost = await kept.status(h.repository, enrolled);
		expect(lost.reporters[0]?.live).toBe(false);
		expect(lost.reporters[0]?.state).toBeUndefined();
		expect(lost.allowance).toEqual({});
		// The reporter's next report, within a minute, puts the block back.
		h.clock.now += 60_000;
		const accepted = await h.report(kept, true);
		expect(accepted.accepted).toBe(true);
		expect(await h.served(kept)).toBe(true);
		const back = await kept.status(h.repository, enrolled);
		expect(back.allowance.hobo).toMatchObject({
			usedSeconds: 0,
			windowStart: "2026-11-12T16:04:00.000Z",
		});
		// Replay protection resumes from that report.
		const replayed = await h.report(kept, true, {
			sequence: back.reporters[0]?.state?.lastSequence ?? 0n,
		});
		expect(replayed).toEqual({ accepted: false, reason: "replayed" });
	});

	it("lets the cache's own expiry end a verdict, whatever this process's clock says", async () => {
		const h = setup();
		const cacheClock = { now: START };
		const state = createRedisEphemeralState({
			executor: createMemoryRedisExecutor({ now: () => cacheClock.now }),
		});
		// A relay whose clock never moves: only the cache can end the verdict.
		const kept = createCacheFleetVerdicts({
			state,
			environment: "production",
			now: () => START,
		});
		await h.report(kept, true, { ttlSeconds: 60 });
		cacheClock.now += 59_000;
		expect(await h.served(kept)).toBe(true);
		cacheClock.now += 1_000;
		expect(await h.served(kept)).toBe(false);
	});

	it("does not serve a verdict past its own expiry even while the cache still holds it", async () => {
		const h = setup();
		// A cache whose clock never moves: it never drops the entry itself.
		const state = createRedisEphemeralState({
			executor: createMemoryRedisExecutor({ now: () => START }),
		});
		const relayClock = { now: START };
		const kept = createCacheFleetVerdicts({
			state,
			environment: "production",
			now: () => relayClock.now,
		});
		await h.report(kept, true, { ttlSeconds: 60 });
		relayClock.now += 59_000;
		expect(await h.served(kept)).toBe(true);
		relayClock.now += 1_000;
		expect(await h.served(kept)).toBe(false);
	});

	it("keeps one deployment environment's verdicts from another's", async () => {
		const h = setup();
		await h.report(h.verdicts("preview"), true);
		expect(await h.served(h.verdicts("production"))).toBe(false);
		expect(await h.served(h.verdicts("preview"))).toBe(true);
	});

	it("reads an agreed verdict in one cache round trip", async () => {
		const h = setup();
		const counted = { calls: 0 };
		const clock = { now: START };
		const engine = createMemoryRedisExecutor({ now: () => clock.now });
		const state = createRedisEphemeralState({
			executor: {
				execute: (command) => {
					counted.calls++;
					return engine.execute(command);
				},
			},
		});
		const kept = createCacheFleetVerdicts({
			state,
			environment: "production",
			now: () => clock.now,
		});
		await h.report(kept, true);
		counted.calls = 0;
		expect(await h.served(kept)).toBe(true);
		expect(counted.calls).toBe(1);
	});

	it("gives up, loudly, when every write loses a race", async () => {
		const h = setup();
		const engine = createMemoryRedisExecutor({ now: () => START });
		const state = createRedisEphemeralState({ executor: engine });
		const contended = createCacheFleetVerdicts({
			state: {
				...state,
				getMany: (keys) => state.getMany(keys),
				putIfAbsent: async () => ({ applied: false }),
				compareAndSet: async () => ({ applied: false }),
			},
			environment: "production",
			now: () => START,
		});
		await expect(h.report(contended, true)).rejects.toThrow("contended");
	});
});
