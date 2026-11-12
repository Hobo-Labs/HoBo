import {
	createMemoryRedisExecutor,
	createRedisEphemeralState,
} from "@hobo/kv-redis-compatible";
import { describe, expect, it } from "vitest";
import { CacheWorkerHealth } from "../src/worker-health-cache.js";

describe("deployment-scoped worker health on the cache", () => {
	const at = Date.parse("2026-11-11T12:00:00Z");
	const state = () =>
		createRedisEphemeralState({
			executor: createMemoryRedisExecutor({ now: () => at }),
		});

	it("keeps an older deployment's evidence from vouching for this one", async () => {
		const shared = state();
		const health = (deploymentId: string) =>
			new CacheWorkerHealth({
				state: shared,
				environment: "production",
				deploymentId,
				now: () => at,
			});
		const current = health("dpl_current");
		const old = health("dpl_previous");
		for (const component of [
			"repair",
			"repair-deliveries",
			"repair-queued",
		] as const)
			await old.mark(component, true);
		expect(await old.summary()).toBe("ok");
		expect(await current.summary()).toBe("starting");
		await old.mark("repair", false, at + 1);
		await current.mark("repair", true);
		expect((await current.status()).repair).toBe("ok");
		expect((await old.status()).repair).toBe("failing");
	});

	it("rejects malformed deployment IDs and keeps a local namespace without one", async () => {
		const shared = state();
		expect(
			() =>
				new CacheWorkerHealth({
					state: shared,
					environment: "production",
					deploymentId: "dpl_bad:repair",
				}),
		).toThrow("invalid worker deployment ID");
		const local = new CacheWorkerHealth({
			state: shared,
			environment: "production",
			now: () => at,
		});
		await local.mark("repair", true);
		expect((await local.status()).repair).toBe("ok");
		const deployed = new CacheWorkerHealth({
			state: shared,
			environment: "production",
			deploymentId: "dpl_current",
			now: () => at,
		});
		expect((await deployed.status()).repair).toBe("starting");
	});
});
