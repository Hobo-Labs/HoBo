import { readFileSync } from "node:fs";
import { assertNoBindleProviderSelection } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import {
	CI_RELAY_REPAIR_SCHEDULE,
	CI_RELAY_RESOURCES,
	ciCacheBindle,
	ciConfigBindle,
	ciD1CacheBindle,
	ciPostgresCacheBindle,
	ciRelayBindle,
	ciRunnerBindle,
	ciUpstashBlobCacheBindle,
} from "../src/app.js";

describe("the CI SDK application", () => {
	it("describes the repair schedule that the relay actually deploys", () => {
		const vercel: unknown = JSON.parse(
			readFileSync(
				new URL("../../ci-vercel/vercel.json", import.meta.url),
				"utf8",
			),
		);
		expect(CI_RELAY_REPAIR_SCHEDULE).toEqual({
			name: "hobo-ci-repair",
			cron: "*/15 * * * *",
			topic: "hobo-ci",
		});
		expect(vercel).toMatchObject({
			schedules: {
				[CI_RELAY_REPAIR_SCHEDULE.name]: {
					schedule: CI_RELAY_REPAIR_SCHEDULE.cron,
					topic: CI_RELAY_REPAIR_SCHEDULE.topic,
				},
			},
		});
	});

	it("declares the project, native bucket, relay, queues and repair schedule in dependency order", () => {
		expect(
			Object.fromEntries(
				Object.entries(ciRelayBindle.resources).map(([name, row]) => [
					name,
					row.kind,
				]),
			),
		).toEqual({
			project: "web",
			relay: "api",
			"hobo-ci": "queue",
			"hobo-ci-intake": "queue",
			"hobo-ci-lease-steps": "queue",
			"hobo-ci-repair": "schedule",
			cache: "bucket",
		});
		expect(ciRelayBindle.resources.cache?.declaredAllow).toEqual([
			"read",
			"write",
			"delete",
		]);
		expect(ciRelayBindle.edges).toEqual(
			expect.arrayContaining([
				{ from: "cache", to: "project" },
				{ from: "relay", to: "project" },
				{ from: "relay", to: "cache" },
				{ from: "hobo-ci", to: "relay" },
				{ from: "hobo-ci-intake", to: "relay" },
				{ from: "hobo-ci-lease-steps", to: "relay" },
				{ from: "hobo-ci-repair", to: "relay" },
				{ from: "hobo-ci-repair", to: "hobo-ci" },
			]),
		);
		expect(CI_RELAY_RESOURCES.cache).toBe("cache");
	});

	it("keeps cache, configuration and runner peers in separate provider-neutral Bindles", () => {
		for (const app of [
			ciRelayBindle,
			ciCacheBindle,
			ciConfigBindle,
			ciD1CacheBindle,
			ciPostgresCacheBindle,
			ciRunnerBindle,
			ciUpstashBlobCacheBindle,
		])
			expect(() => assertNoBindleProviderSelection(app)).not.toThrow();
		expect(ciD1CacheBindle.resources.cache?.kind).toBe("data");
		expect(ciPostgresCacheBindle.resources.cache?.kind).toBe("data");
		expect(ciUpstashBlobCacheBindle.resources.cache?.kind).toBe("bucket");
		expect(ciConfigBindle.resources.config?.kind).toBe("secret");
		expect(ciRunnerBindle.resources.runner?.kind).toBe("job");
	});
});
