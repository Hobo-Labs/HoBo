import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import {
	canonicalJson,
	createDispatcherRegistry,
	decideDispatch,
	stableHash,
} from "../src/dispatcher.js";

const V1_DISPATCH_DECIDED_BASELINE =
	"sha256:e34ab9a5dbf0a42cd1305f1b6d36c8280d9057c60f49d736d21afbacf8bfcccd";

describe("decideDispatch v1 stability", () => {
	it("keeps a byte-identical dispatch.Decided fact for the pinned replay fixture", () => {
		const registry = createDispatcherRegistry([
			{
				id: "github-hosted",
				category: "runner",
				dimension: "runner.minutes",
				listUnitCost: 0.03,
			},
			{
				id: "self-hosted",
				category: "runner",
				dimension: "runner.minutes",
				listUnitCost: 0.01,
			},
		]);
		const decision = decideDispatch({
			registry,
			category: "runner",
			dispatchId: "ci-replay",
			objective: "maximize-credits",
			units: 5,
			ledgerView: {
				view: "CreditLedgerView",
				seq: 91,
				digest:
					"sha256:1111111111111111111111111111111111111111111111111111111111111111",
				asOf: "2026-06-27T00:00:00.000Z",
				accounts: [
					{
						providerId: "github-hosted",
						dimension: "runner.minutes",
						currency: "USD",
						listUnitCost: 0.03,
						freeHeadroom: 10,
						rateHeadroom: 100,
						concurrencyHeadroom: 10,
						credits: [
							{
								creditId: "github-hosted-free",
								freeHeadroom: 10,
								expiresAt: "2026-07-01T00:00:00.000Z",
							},
						],
					},
					{
						providerId: "self-hosted",
						dimension: "runner.minutes",
						currency: "USD",
						listUnitCost: 0.01,
						freeHeadroom: 0,
						rateHeadroom: 100,
						concurrencyHeadroom: 10,
						credits: [
							{
								creditId: "self-hosted-free",
								freeHeadroom: 0,
								expiresAt: "2026-07-01T00:00:00.000Z",
							},
						],
					},
				],
			},
		});

		assert.equal(decision.ok, true);
		const digest = stableHash(canonicalJson(decision.dispatchEvent));
		expect(digest).toBe(V1_DISPATCH_DECIDED_BASELINE);
	});
});
