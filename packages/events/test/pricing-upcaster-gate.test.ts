import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

import {
	PRICING_EVENT_CONTRACTS,
	pricingCorpusBaseline,
} from "../src/pricing-event-contracts.js";
import {
	type CorpusBaseline,
	runCanDeployUpcasterGate,
} from "../src/upcaster.js";

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

test("can-deploy: every pricing.* contract replays clean against the pinned baseline file", () => {
	const baselinePath = path.join(
		import.meta.dirname,
		"..",
		"corpus",
		"golden-replay-baseline.json",
	);
	// SAFETY: the committed baseline file is validated by the gate as CorpusBaseline.
	const pinned = JSON.parse(
		readFileSync(baselinePath, "utf8"),
	) as CorpusBaseline;
	const pricingBaseline = pricingCorpusBaseline();
	const pricingEntries = pinned.entries.filter((entry) =>
		entry.key.startsWith("pricing."),
	);
	assert.deepEqual(
		pricingEntries,
		pricingBaseline.entries,
		"pricing corpus baseline drift",
	);

	for (const contract of PRICING_EVENT_CONTRACTS) {
		const report = runCanDeployUpcasterGate(contract, {
			baselineCorpus: {
				...pinned,
				entries: pinned.entries.filter((entry) =>
					entry.key.startsWith(`${contract.type}@`),
				),
			},
		});
		assert.deepEqual(report.errors, [], `gate failed for ${contract.type}`);
	}
});
