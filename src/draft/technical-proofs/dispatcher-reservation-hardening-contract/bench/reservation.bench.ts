import { bench, describe } from "vitest";

import {
	createDispatcherRegistry,
	createReservationLedger,
	decideAndReserveDispatch,
} from "../../dispatcher-maximize-credits-contract/src/dispatcher.js";

const registry = createDispatcherRegistry([
	{
		id: "free-runner",
		providerId: "free-runner",
		category: "runner",
		dimension: "runner.minutes",
		listUnitCost: 0.04,
	},
]);

describe("reservation ledger hot path", () => {
	bench("reserve one unit", () => {
		const reservationLedger = createReservationLedger({
			view: "CreditLedgerView",
			seq: 1,
			digest: `sha256:${"b".repeat(64)}`,
			asOf: "2026-07-30T00:00:00.000Z",
			accounts: [
				{
					providerId: "free-runner",
					dimension: "runner.minutes",
					currency: "USD",
					listUnitCost: 0.04,
					freeHeadroom: 100,
					rateHeadroom: 100,
					concurrencyHeadroom: 10,
					credits: [
						{
							creditId: "c1",
							freeHeadroom: 100,
							expiresAt: "2099-01-01T00:00:00.000Z",
						},
					],
				},
			],
		});
		decideAndReserveDispatch({
			registry,
			category: "runner",
			dispatchId: "bench-1",
			units: 1,
			reservationLedger,
		});
	});
});
