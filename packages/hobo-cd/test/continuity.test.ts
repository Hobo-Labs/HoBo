import {
	continuityFleetPlan,
	continuityShortfalls,
} from "@hobo/backend-routing";
import { continuityPolicies, continuityViolations } from "@hobo/bindles";
import { describe, expect, it } from "vitest";

import cd, { CD_RESOURCES } from "../src/bindle.js";
import { cdJournalContinuity } from "../src/continuity.js";

describe("HoBo CD continuity", () => {
	it("declares a policy on every stateful resource", () => {
		const policies = continuityPolicies(cd);
		expect(policies.get(CD_RESOURCES.journal)).toEqual(cdJournalContinuity());
		expect(policies.get(CD_RESOURCES.config)?.tier).toBe("rebuildable");
		expect(continuityViolations(cd)).toEqual([]);
	});

	it("the journal's fleet can fail over by majority within its recovery point", () => {
		const plan = continuityFleetPlan(cdJournalContinuity());
		expect(plan.copy).toBe("snapshot");
		expect(plan.fleet.rpoMs).toBe(5 * 60_000);
		expect(
			continuityShortfalls(plan, {
				standbys: 2,
				tickEveryMs: 60_000,
				vendors: 3,
			}),
		).toEqual([]);
	});
});
