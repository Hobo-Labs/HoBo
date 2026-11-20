import { describe, expect, it } from "vitest";

import {
	CD_JOURNAL_MEMBER_PLANS,
	journalMemberModels,
	UnknownMemberPlanError,
} from "../src/index.js";

describe("journalMemberModels", () => {
	it("gives each member that names a plan its model, under the member's id", () => {
		const models = journalMemberModels([
			{ id: "neon-eu", plan: "neon-claimable" },
			{ id: "self-hosted" },
		]);
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			backend: "neon-eu",
			plan: "neon-claimable",
			fixedMonthlyFeeMicros: 0,
		});
	});

	it("refuses a plan the catalog does not know", () => {
		expect(() =>
			journalMemberModels([{ id: "a", plan: "made-up-free-tier" }]),
		).toThrow(UnknownMemberPlanError);
	});

	it("cites a source for every plan and invents no allowance", () => {
		for (const plan of Object.values(CD_JOURNAL_MEMBER_PLANS)) {
			expect(plan.evidence.source).toMatch(/^https:\/\//u);
			for (const allowance of plan.allowances)
				if (allowance.included === undefined)
					expect(allowance.beyond).toBe("unknown");
		}
	});
});
