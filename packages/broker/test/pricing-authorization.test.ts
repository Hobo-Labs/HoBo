import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { authorizeBillingSpend } from "../src/pricing-authorization.js";

describe("authorizeBillingSpend", () => {
	it("prefers quote incremental over legacy spend estimate", () => {
		const result = authorizeBillingSpend({
			spendEstimateUsd: 100,
			quoteIncrementalUsd: 5,
			billing: {
				quota: "default",
				quotaUsed: 0,
				quotaLimit: 1000,
				budgetUsd: 50,
				spendCapUsd: 40,
			},
		});
		assert.equal(result.ok, true);
		assert.equal(result.authorizedUsd, 5);
	});

	it("prefers quote incremental decimal over legacy spend estimate", () => {
		const result = authorizeBillingSpend({
			spendEstimateUsd: 100,
			quoteIncrementalUsd: 99,
			quoteIncrementalDecimal: "5.25",
			billing: {
				quota: "default",
				quotaUsed: 0,
				quotaLimit: 1000,
				budgetUsd: 50,
				spendCapUsd: 40,
			},
		});
		assert.equal(result.ok, true);
		assert.equal(result.authorizedUsd, 5.25);
	});

	it("rejects negative quote incremental decimal", () => {
		const result = authorizeBillingSpend({
			quoteIncrementalDecimal: "-0.01",
			billing: {
				quota: "default",
				quotaUsed: 0,
				quotaLimit: 1000,
				budgetUsd: 50,
				spendCapUsd: 40,
			},
		});
		assert.equal(result.ok, false);
		assert.equal(result.reasons[0]?.code, "spend-estimate-invalid");
	});
});
