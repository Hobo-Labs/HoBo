import { describe, expect, it } from "vitest";

import {
	assertNoBindleProviderSelection,
	bindle,
	CONTINUITY_TIER_DEFAULTS,
	ContinuityError,
	continuity,
	continuityPolicies,
	continuityViolations,
	parseContinuityPolicy,
	readContinuity,
} from "../src/index.js";

describe("continuity trait", () => {
	it("fills a tier's cost-balanced defaults and keeps overrides", () => {
		expect(parseContinuityPolicy({})).toEqual(
			CONTINUITY_TIER_DEFAULTS.standard,
		);
		expect(
			parseContinuityPolicy({ tier: "critical", standbys: 1 }),
		).toMatchObject({ tier: "critical", standbys: 1, recoveryPointMs: 30_000 });
	});

	it("refuses a policy that cannot restore what it promises", () => {
		expect(() =>
			parseContinuityPolicy({ standbys: 0, backupEveryMs: 0 }),
		).toThrow(ContinuityError);
		expect(() => parseContinuityPolicy({ recoveryPointMs: 10 })).toThrow(
			/at least 1000 ms/,
		);
		expect(() => parseContinuityPolicy({ failoverAfterMs: 0 })).toThrow(
			/failoverAfterMs/,
		);
	});

	it("rebuildable state promises no recovery point", () => {
		expect(
			parseContinuityPolicy({ tier: "rebuildable", recoveryPointMs: 5000 }),
		).toMatchObject({ onLoss: "rebuild", recoveryPointMs: 0, standbys: 0 });
	});

	it("round-trips through the annotation and reads per resource", () => {
		const app = bindle("app", (b) => ({
			journal: b.data().with(continuity({ tier: "critical" })),
			cache: b.kv().with(continuity({ tier: "rebuildable" })),
			api: b.api(),
		}));
		const policies = continuityPolicies(app);
		expect(policies.get("journal")?.standbys).toBe(2);
		expect(policies.get("cache")?.onLoss).toBe("rebuild");
		expect(policies.has("api")).toBe(false);
		expect(readContinuity(app.resources.journal?.annotations ?? [])).toEqual(
			CONTINUITY_TIER_DEFAULTS.critical,
		);
		expect(continuityViolations(app)).toEqual([]);
		expect(() => assertNoBindleProviderSelection(app)).not.toThrow();
	});

	it("flags continuity on a resource that holds no state", () => {
		const app = bindle("app", (b) => ({
			api: b.api().with(continuity()),
		}));
		expect(continuityViolations(app).map((v) => v.code)).toEqual([
			"CONTINUITY_ON_STATELESS",
		]);
	});
});
