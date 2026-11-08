import { describe, expect, it } from "vitest";
import {
	createDispatcherRegistry,
	decideDispatch,
	stableHash,
} from "../src/dispatcher.js";

const V1_BASELINE_HASH =
	"sha256:303b4e1d7563d16efbbf25de1737aa10a494a27a0ec4691df5ef5d8919b373c9";

describe("dispatcher v1 compatibility", () => {
	it("keeps the complete fixed-fixture decision byte-identical", () => {
		const decision = decideDispatch({
			registry: createDispatcherRegistry([
				{
					id: "github",
					providerId: "github",
					category: "runner",
					listUnitCost: 0.03,
					switchingCost: 0.01,
				},
				{
					id: "self-hosted",
					providerId: "self-hosted",
					category: "runner",
					listUnitCost: 0.01,
				},
			]),
			category: "runner",
			dispatchId: "v1-golden",
			objective: "maximize-credits",
			units: 5,
			incumbentProviderId: "github",
			reservationId: "reservation-v1-golden",
			ledgerView: {
				view: "CreditLedgerView",
				seq: 91,
				digest:
					"sha256:1111111111111111111111111111111111111111111111111111111111111111",
				asOf: "2026-06-27T00:00:00.000Z",
				accounts: [
					{
						providerId: "github",
						dimension: "runner.minutes",
						currency: "USD",
						listUnitCost: 0.03,
						freeHeadroom: 10,
						rateHeadroom: 100,
						concurrencyHeadroom: 2,
						budgetCap: 10,
						spendToDate: 1,
						credits: [
							{
								creditId: "github-free",
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
						concurrencyHeadroom: 4,
						budgetCap: 10,
						spendToDate: 0,
						credits: [],
					},
				],
			},
		});

		expect(stableHash(decision)).toBe(V1_BASELINE_HASH);
	});

	it("retains legacy reservations in replay inputs when they contain no nested decisions", () => {
		const ledgerView = {
			view: "CreditLedgerView",
			seq: 1,
			accounts: [{ providerId: "runner", dimension: "runner.minutes" }],
			reservations: [
				{
					reservationId: "legacy",
					providerId: "runner",
					dimension: "runner.minutes",
					units: 1,
					expectedSeq: 0,
					committedSeq: 1,
					status: "pending",
				},
			],
		};
		const decision = decideDispatch({
			registry: createDispatcherRegistry([
				{ providerId: "runner", category: "runner", listUnitCost: 1 },
			]),
			category: "runner",
			dispatchId: "legacy-reservation",
			ledgerView,
		});
		expect(decision.replayInput.ledgerView).toEqual(ledgerView);
	});
});
