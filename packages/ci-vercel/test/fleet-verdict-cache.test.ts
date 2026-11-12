import {
	noFleetVerdict,
	parseFleetVerdictPath,
	parseFleetVerdictReport,
	standingFleetVerdict,
} from "@hobo/ci-gh-actions";
import {
	createMemoryRedisExecutor,
	createRedisEphemeralState,
} from "@hobo/kv-redis-compatible";
import { describe, expect, it } from "vitest";
import { createCacheFleetVerdicts } from "../src/fleet-verdict-cache.js";

describe("fleet verdicts on the cache", () => {
	const start = Date.parse("2026-11-12T16:00:00Z");
	const setup = () => {
		const clock = { now: start };
		const state = createRedisEphemeralState({
			executor: createMemoryRedisExecutor({ now: () => clock.now }),
		});
		const verdicts = (environment = "production") =>
			createCacheFleetVerdicts({ state, environment, now: () => clock.now });
		return { clock, verdicts };
	};
	const repository = parseFleetVerdictPath("/v1/fleet/verdicts/Hobo-Labs/HoBo");
	const standing = (reason: string, ttlSeconds: number, at: number) => {
		const report = parseFleetVerdictReport(
			JSON.stringify({ blocked: { hobo: { reason } }, ttlSeconds }),
		);
		if (!report || !repository) throw new Error("fixture is not a report");
		return standingFleetVerdict(repository, report, at);
	};

	it("serves what was reported until it expires, and nothing after", async () => {
		if (!repository) throw new Error("no repository");
		const { clock, verdicts } = setup();
		const kept = verdicts();
		expect(await kept.read(repository)).toBeUndefined();
		await kept.write(standing("no-capacity", 120, clock.now));
		expect((await kept.read(repository))?.blocked.hobo?.reason).toBe(
			"no-capacity",
		);
		clock.now += 119_000;
		expect(await kept.read(repository)).toBeDefined();
		clock.now += 1_000;
		expect(await kept.read(repository)).toBeUndefined();
	});

	it("lets a later report replace an earlier one and extend its life", async () => {
		if (!repository) throw new Error("no repository");
		const { clock, verdicts } = setup();
		const kept = verdicts();
		await kept.write(standing("no-capacity", 60, clock.now));
		clock.now += 50_000;
		await kept.write(standing("no-node", 60, clock.now));
		clock.now += 50_000;
		expect((await kept.read(repository))?.blocked.hobo?.reason).toBe("no-node");
	});

	it("forgets a verdict when a report blocks nothing", async () => {
		if (!repository) throw new Error("no repository");
		const { clock, verdicts } = setup();
		const kept = verdicts();
		await kept.write(standing("no-node", 180, clock.now));
		await kept.write(noFleetVerdict(repository));
		expect(await kept.read(repository)).toBeUndefined();
	});

	it("lets the cache's own expiry end a verdict, whatever this process's clock says", async () => {
		if (!repository) throw new Error("no repository");
		const cacheClock = { now: start };
		const state = createRedisEphemeralState({
			executor: createMemoryRedisExecutor({ now: () => cacheClock.now }),
		});
		// A relay whose clock never moves: only the cache can end the verdict.
		const kept = createCacheFleetVerdicts({
			state,
			environment: "production",
			now: () => start,
		});
		await kept.write(standing("no-node", 60, start));
		cacheClock.now += 59_000;
		expect(await kept.read(repository)).toBeDefined();
		cacheClock.now += 1_000;
		expect(await kept.read(repository)).toBeUndefined();
	});

	it("does not serve a verdict past its own expiry even while the cache still holds it", async () => {
		if (!repository) throw new Error("no repository");
		const relayClock = { now: start };
		const state = createRedisEphemeralState({
			// A cache whose clock never moves: only the verdict's time can end it.
			executor: createMemoryRedisExecutor({ now: () => start }),
		});
		const kept = createCacheFleetVerdicts({
			state,
			environment: "production",
			now: () => relayClock.now,
		});
		await kept.write(standing("no-node", 60, start));
		relayClock.now += 59_999;
		expect(await kept.read(repository)).toBeDefined();
		relayClock.now += 1;
		expect(await kept.read(repository)).toBeUndefined();
	});

	it("gives up, loudly, when every write loses a race", async () => {
		if (!repository) throw new Error("no repository");
		const state = createRedisEphemeralState({
			executor: createMemoryRedisExecutor({ now: () => start }),
		});
		const contended = createCacheFleetVerdicts({
			state: {
				...state,
				get: (key) => state.get(key),
				putIfAbsent: async () => ({ applied: false }),
				compareAndSet: async () => ({ applied: false }),
			},
			environment: "production",
			now: () => start,
		});
		await expect(
			contended.write(standing("no-node", 60, start)),
		).rejects.toThrow("fleet verdict contended");
	});

	it("keeps one deployment environment's verdicts from another's", async () => {
		if (!repository) throw new Error("no repository");
		const { clock, verdicts } = setup();
		await verdicts("preview").write(standing("no-node", 180, clock.now));
		expect(await verdicts("production").read(repository)).toBeUndefined();
		expect(await verdicts("preview").read(repository)).toBeDefined();
	});
});
