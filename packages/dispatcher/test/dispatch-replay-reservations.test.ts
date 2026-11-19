import { describe, expect, it } from "vitest";
import {
	createDispatcherRegistry,
	decideCreditDispatch,
} from "../src/dispatcher.js";

describe("dispatch replay inputs", () => {
	it("retains reservations made without a dispatch decision", () => {
		const ledgerView = {
			view: "CreditLedgerView",
			seq: 1,
			accounts: [{ providerId: "runner", dimension: "runner.minutes" }],
			reservations: [
				{
					reservationId: "manual-reservation",
					providerId: "runner",
					dimension: "runner.minutes",
					units: 1,
					expectedSeq: 0,
					committedSeq: 1,
					status: "pending",
				},
			],
		};
		const decision = decideCreditDispatch({
			registry: createDispatcherRegistry([
				{ providerId: "runner", category: "runner", listUnitCost: 1 },
			]),
			category: "runner",
			dispatchId: "manual-reservation",
			ledgerView,
		});
		expect(decision.replayInput.ledgerView).toEqual(ledgerView);
	});
});
