/**
 * Runnable example: free-tier reservation ledger cannot over-commit concurrent
 * dispatch. Gate executes this file and diffs stdout to the sibling .expected.txt.
 */
import assert from "node:assert/strict";

import {
	createDispatcherRegistry,
	createReservationLedger,
	decideAndReserveDispatch,
} from "../../dispatcher-maximize-credits-contract/src/dispatcher.js";

function ledgerView(accounts) {
	return {
		view: "CreditLedgerView",
		seq: 200,
		digest: `sha256:${"a".repeat(64)}`,
		asOf: "2026-06-27T00:00:00.000Z",
		accounts,
	};
}

function account(providerId, freeHeadroom, listUnitCost) {
	return {
		providerId,
		dimension: "runner.minutes",
		currency: "USD",
		listUnitCost,
		freeHeadroom,
		rateHeadroom: 100,
		concurrencyHeadroom: 10,
		credits: [
			{
				creditId: `${providerId}-free`,
				freeHeadroom,
				expiresAt: "2099-07-01T00:00:00.000Z",
			},
		],
	};
}

const registry = createDispatcherRegistry([
	{
		id: "free-runner",
		providerId: "free-runner",
		category: "runner",
		dimension: "runner.minutes",
		listUnitCost: 0.04,
	},
	{
		id: "paid-runner",
		providerId: "paid-runner",
		category: "runner",
		dimension: "runner.minutes",
		listUnitCost: 0.01,
	},
]);

const reservationLedger = createReservationLedger(
	ledgerView([
		account("free-runner", 2, 0.04),
		account("paid-runner", 0, 0.01),
	]),
);
const staleSnapshot = reservationLedger.snapshot();

const decisions = Array.from({ length: 5 }, (_, index) =>
	decideAndReserveDispatch({
		registry,
		category: "runner",
		dispatchId: `ci-burst-${index + 1}`,
		units: 1,
		ledgerView: staleSnapshot,
		reservationLedger,
	}),
);

const selected = decisions.map((d) => d.selectedProvider);
console.log(`selected: ${selected.join(",")}`);
assert.deepEqual(selected, [
	"free-runner",
	"free-runner",
	"paid-runner",
	"paid-runner",
	"paid-runner",
]);
const freeHeadroom = reservationLedger
	.snapshot()
	.accounts.find((a) => a.providerId === "free-runner").freeHeadroom;
console.log(`free-runner remaining headroom: ${freeHeadroom}`);
assert.equal(freeHeadroom, 0);
console.log("reservation-cap: ok");
