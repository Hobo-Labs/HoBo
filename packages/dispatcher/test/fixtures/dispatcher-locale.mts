import {
	createDispatcherRegistry,
	createReservationLedger,
	decideDispatch,
	replayDispatchDecision,
} from "../../src/dispatcher.js";
import { decideDispatchV2 } from "../../src/dispatcher-v2.js";
import {
	dispatchQuoteScenario,
	staleDispatchQuoteScenario,
} from "../dispatcher-v2-fixtures.js";

const ids = ["z", "ä"];
const registration =
	process.env.HOBO_TEST_REVERSE === "1" ? [...ids].reverse() : ids;
const registry = createDispatcherRegistry(
	registration.map((providerId) => ({
		providerId,
		category: "runner",
		listUnitCost: 1,
	})),
);
const ledgerView = {
	view: "CreditLedgerView",
	seq: 0,
	accounts: ids.map((providerId) => ({
		providerId,
		dimension: "runner.minutes",
		listUnitCost: 1,
		freeHeadroom: 0,
		budgetCap: 5,
		spendToDate: 0,
	})),
};
const decision = decideDispatch({
	registry,
	ledgerView,
	category: "runner",
	dispatchId: "locale",
	units: 1,
});
if (!decision.ok) throw new Error("missing decision");
const replayInput = { ...decision.replayInput };
const replay = replayDispatchDecision(
	process.env.HOBO_TEST_REPLAY_INPUT
		? JSON.parse(process.env.HOBO_TEST_REPLAY_INPUT)
		: replayInput,
);
const legacyInput = { ...replayInput };
delete legacyInput.orderingVersion;
const legacy = replayDispatchDecision(legacyInput);
const v2 = decideDispatchV2({
	dispatchId: "v2-locale",
	category: "runner",
	candidates: registration.map((providerId) => ({
		providerId,
		scenario: dispatchQuoteScenario("same", "0.1"),
	})),
});
if (!v2.ok) throw new Error("missing v2 decision");
const rejected = decideDispatchV2({
	dispatchId: "v2-rejected",
	category: "runner",
	candidates: registration.map((providerId) => ({
		providerId,
		scenario: staleDispatchQuoteScenario("same"),
	})),
});
const ledger = createReservationLedger({
	view: "CreditLedgerView",
	seq: 0,
	asOf: "2026-01-01T00:00:00Z",
	accounts: [
		{
			providerId: "p",
			dimension: "runner.minutes",
			listUnitCost: 1,
			freeHeadroom: 2,
			credits: registration.map((creditId) => ({
				creditId,
				freeHeadroom: 1,
				expiresAt: "2027-01-01T00:00:00Z",
			})),
		},
	],
});
const reserved = ledger.reserve({
	providerId: "p",
	dimension: "runner.minutes",
	reservationId: "credit",
	units: 1,
	expectedSeq: 0,
});
if (!reserved.ok) throw new Error("missing reservation");
console.log(
	JSON.stringify({
		locale: Intl.Collator().resolvedOptions().locale,
		event: decision.dispatchEvent,
		replayInput,
		replayEvent: replay.dispatchEvent,
		orderingVersion: replayInput.orderingVersion,
		legacySelected: legacy.selectedProvider,
		v2Selected: v2.selectedProvider,
		v2Order: v2.ranking.map((candidate) => candidate.providerId),
		rejectedOrder: rejected.rejectedCandidates.map(
			(candidate) => candidate.providerId,
		),
		consumed: reserved.reservation.consumption?.credits.map(
			(credit) => credit.creditId,
		),
	}),
);
