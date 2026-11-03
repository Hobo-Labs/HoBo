import assert from "node:assert/strict";
import { test } from "vitest";

import { runCanDeployUpcasterGate } from "../src/upcaster.js";
import {
	PRICING_EVENT_CONTRACTS,
	pricingCorpusBaseline,
} from "../src/pricing-event-contracts.js";

test("pricing.* golden corpus passes the upcaster gate", () => {
	const baseline = pricingCorpusBaseline();
	for (const contract of PRICING_EVENT_CONTRACTS) {
		const report = runCanDeployUpcasterGate(contract, {
			baselineCorpus: {
				...baseline,
				entries: baseline.entries.filter((entry) =>
					entry.key.startsWith(`${contract.type}@`),
				),
			},
		});
		assert.deepEqual(report.errors, [], `gate failed for ${contract.type}`);
	}
});
