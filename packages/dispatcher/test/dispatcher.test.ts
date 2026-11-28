import assert from "node:assert/strict";
import { test } from "vitest";
import {
	canonicalJson,
	createDispatcherRegistry,
	createReservationLedger,
	decideAndReserveDispatch,
	decideDispatch,
	decidePlacement,
	replayDispatchDecision,
} from "../src/dispatcher.js";
import type { JsonObject } from "../src/json.js";

const LEDGER_DIGEST =
	"sha256:1111111111111111111111111111111111111111111111111111111111111111";
const CATALOG_HASH =
	"sha256:2222222222222222222222222222222222222222222222222222222222222222";

function ledgerView(
	accounts = [],
	overrides: { seq?: number; digest?: string } = {},
) {
	return {
		view: "CreditLedgerView",
		seq: overrides.seq ?? 91,
		digest: overrides.digest ?? LEDGER_DIGEST,
		asOf: "2026-06-27T00:00:00.000Z",
		accounts,
	};
}

function account(providerId: string, overrides: JsonObject = {}) {
	// SAFETY: assertion required at this I/O or test boundary.
	const freeHeadroom = (overrides.freeHeadroom as number) ?? 0;
	return {
		providerId,
		dimension: overrides.dimension ?? "runner.minutes",
		currency: "USD",
		listUnitCost: overrides.listUnitCost ?? 0.02,
		freeHeadroom,
		rateHeadroom: overrides.rateHeadroom ?? 100,
		concurrencyHeadroom: overrides.concurrencyHeadroom ?? 10,
		budgetCap: overrides.budgetCap,
		spendToDate: overrides.spendToDate,
		credits: overrides.credits ?? [
			{
				creditId: `${providerId}-free`,
				freeHeadroom,
				expiresAt: overrides.expiresAt ?? "2026-07-01T00:00:00.000Z",
			},
		],
	};
}

function runner(id: string, overrides: JsonObject = {}) {
	return {
		id,
		providerId: id,
		category: "runner" as const,
		// SAFETY: assertion required at this I/O or test boundary.
		registered: (overrides.registered as boolean) ?? true,
		dimension: "runner.minutes",
		// SAFETY: assertion required at this I/O or test boundary.
		listUnitCost: (overrides.listUnitCost as number) ?? 0.02,
		// SAFETY: assertion required at this I/O or test boundary.
		switchingCost: (overrides.switchingCost as number) ?? 0,
	};
}

function placementCandidate(definitionId: string, overrides: JsonObject = {}) {
	return {
		definitionId,
		// SAFETY: assertion required at this I/O or test boundary.
		providerId: (overrides.providerId as string) ?? definitionId,
		// SAFETY: assertion required at this I/O or test boundary.
		registered: (overrides.registered as boolean) ?? true,
		resourceType: "object-store",
		dimension: "object-store.gib-month",
		// SAFETY: assertion required at this I/O or test boundary.
		listUnitCost: (overrides.listUnitCost as number) ?? 0.02,
		// SAFETY: assertion required at this I/O or test boundary.
		specificity: (overrides.specificity as number) ?? 1,
		// SAFETY: assertion required at this I/O or test boundary.
		priority: (overrides.priority as number) ?? 0,
		// SAFETY: assertion required at this I/O or test boundary.
		region: (overrides.region as string) ?? "us-east-1",
		// SAFETY: assertion required at this I/O or test boundary.
		switchingCost: (overrides.switchingCost as number) ?? 0,
	};
}

test("dispatch ranks a CI job to the cheapest registered runner with free headroom and pins CreditLedgerView@seq", () => {
	const registry = createDispatcherRegistry([
		runner("github-hosted", { listUnitCost: 0.03 }),
		runner("self-hosted", { listUnitCost: 0.01 }),
		runner("unregistered-free", { registered: false, listUnitCost: 0 }),
	]);

	const decision = decideDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-test",
		objective: "maximize-credits",
		units: 20,
		ledgerView: ledgerView([
			account("github-hosted", { freeHeadroom: 40, listUnitCost: 0.03 }),
			account("self-hosted", { freeHeadroom: 0, listUnitCost: 0.01 }),
			account("unregistered-free", { freeHeadroom: 100, listUnitCost: 0 }),
		]),
	});

	assert.equal(decision.ok, true);
	assert.equal(decision.selectedProvider, "github-hosted");
	assert.deepEqual(
		decision.ranking.map((candidate) => candidate.providerId),
		["github-hosted", "self-hosted"],
	);
	assert.equal(decision.dispatchEvent.type, "dispatch.Decided");
	assert.deepEqual(decision.dispatchEvent.data.ledgerInput, {
		view: "CreditLedgerView",
		seq: 91,
		reservationId: "reservation-intent-ci-test",
		balanceHash: LEDGER_DIGEST,
	});
});

test("milestone: replaying the same inputs yields a byte-identical dispatch.Decided fact", () => {
	const registry = createDispatcherRegistry([
		runner("github-hosted", { listUnitCost: 0.03 }),
		runner("self-hosted", { listUnitCost: 0.01 }),
	]);
	const request = {
		registry,
		category: "runner",
		dispatchId: "ci-replay",
		objective: "maximize-credits",
		units: 5,
		ledgerView: ledgerView([
			account("github-hosted", { freeHeadroom: 10, listUnitCost: 0.03 }),
			account("self-hosted", { freeHeadroom: 0, listUnitCost: 0.01 }),
		]),
	};

	const first = decideDispatch(request);
	const replayed = replayDispatchDecision(first.replayInput);

	assert.equal(replayed.selectedProvider, first.selectedProvider);
	assert.deepEqual(replayed.ranking, first.ranking);
	assert.equal(
		canonicalJson(replayed.dispatchEvent),
		canonicalJson(first.dispatchEvent),
	);
});

test("milestone: flipping a budget input flips the selected backend with an explicit reason code", () => {
	const registry = createDispatcherRegistry([
		runner("cheap", { listUnitCost: 0.01 }),
		runner("fallback", { listUnitCost: 0.03 }),
	]);
	const request = (cheapBudgetCap: number, seq: number) => ({
		registry,
		category: "runner",
		dispatchId: `ci-budget-flip-${seq}`,
		units: 5,
		ledgerView: ledgerView(
			[
				account("cheap", {
					freeHeadroom: 0,
					listUnitCost: 0.01,
					budgetCap: cheapBudgetCap,
					spendToDate: 0.99,
				}),
				account("fallback", {
					freeHeadroom: 0,
					listUnitCost: 0.03,
					budgetCap: 10,
					spendToDate: 0,
				}),
			],
			{ seq },
		),
	});

	const withinBudget = decideDispatch(request(10, 91));
	const overBudget = decideDispatch(request(1, 92));

	assert.equal(withinBudget.selectedProvider, "cheap");
	assert.equal(overBudget.selectedProvider, "fallback");
	assert.equal(
		overBudget.ranking.find((entry) => entry.providerId === "cheap")
			.budgetExceeded,
		true,
	);
	assert.match(
		overBudget.ranking.find((entry) => entry.providerId === "cheap").rationale,
		/budget-cap-exceeded/,
	);
});

test("traffic-backend category dispatches over traffic.requests with budget awareness", () => {
	const registry = createDispatcherRegistry([
		{
			id: "vercel-primary",
			providerId: "vercel-primary",
			category: "traffic-backend",
			listUnitCost: 0.05,
		},
		{
			id: "lakebed-cheap",
			providerId: "lakebed-cheap",
			category: "traffic-backend",
			listUnitCost: 0.01,
		},
	]);

	const decision = decideDispatch({
		registry,
		category: "traffic-backend",
		dispatchId: "route-swap-1",
		units: 100,
		ledgerView: ledgerView([
			account("vercel-primary", {
				dimension: "traffic.requests",
				freeHeadroom: 0,
				listUnitCost: 0.05,
			}),
			account("lakebed-cheap", {
				dimension: "traffic.requests",
				freeHeadroom: 0,
				listUnitCost: 0.01,
			}),
		]),
	});

	assert.equal(decision.ok, true);
	assert.equal(decision.selectedProvider, "lakebed-cheap");
	assert.equal(decision.ranking[0].dimension, "traffic.requests");
});

test("exhausting a free tier rotates the next dispatch pick", () => {
	const registry = createDispatcherRegistry([
		runner("github-hosted", { listUnitCost: 0.03 }),
		runner("self-hosted", { listUnitCost: 0.01 }),
	]);

	const first = decideDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-before-exhaustion",
		units: 5,
		ledgerView: ledgerView([
			account("github-hosted", { freeHeadroom: 5, listUnitCost: 0.03 }),
			account("self-hosted", { freeHeadroom: 0, listUnitCost: 0.01 }),
		]),
	});
	const afterExhaustion = decideDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-after-exhaustion",
		units: 5,
		ledgerView: ledgerView(
			[
				account("github-hosted", { freeHeadroom: 0, listUnitCost: 0.03 }),
				account("self-hosted", { freeHeadroom: 0, listUnitCost: 0.01 }),
			],
			{ seq: 92 },
		),
	});

	assert.equal(first.selectedProvider, "github-hosted");
	assert.equal(afterExhaustion.selectedProvider, "self-hosted");
});

test("placement records match.Decided with maximize-credits objective", () => {
	const decision = decidePlacement({
		resourceId: "assets",
		resourceType: "object-store",
		candidates: [
			placementCandidate("aws-s3", { providerId: "aws", listUnitCost: 0.03 }),
			placementCandidate("azure-blob", {
				providerId: "azure",
				listUnitCost: 0.02,
			}),
		],
		objective: "maximize-credits",
		units: 1,
		catalogContentHash: CATALOG_HASH,
		ledgerView: ledgerView([
			account("aws", {
				dimension: "object-store.gib-month",
				freeHeadroom: 10,
				listUnitCost: 0.03,
			}),
			account("azure", {
				dimension: "object-store.gib-month",
				freeHeadroom: 0,
				listUnitCost: 0.02,
			}),
		]),
	});

	assert.equal(decision.ok, true);
	assert.equal(decision.matchEvent.type, "match.Decided");
	assert.equal(decision.matchEvent.data.objective, "maximize-credits");
	assert.equal(decision.matchEvent.data.winner, "aws-s3");
	assert.equal(decision.matchEvent.data.catalogContentHash, CATALOG_HASH);
});

test("absent credit facts degrade to plain min-cost ranking", () => {
	const registry = createDispatcherRegistry([
		runner("expensive", { listUnitCost: 0.09 }),
		runner("cheap", { listUnitCost: 0.02 }),
	]);

	const decision = decideDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-no-credit-facts",
		units: 1,
		ledgerView: ledgerView([]),
	});

	assert.equal(decision.selectedProvider, "cheap");
	assert.equal(
		decision.ranking[0].rationale.includes("credit-facts=missing"),
		true,
	);
});

test("rate-limited free tiers do not win over runners with usable concurrency headroom", () => {
	const registry = createDispatcherRegistry([
		runner("rate-limited-free", { listUnitCost: 0.04 }),
		runner("warm-free", { listUnitCost: 0.05 }),
	]);

	const decision = decideDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-rate-limited",
		units: 1,
		ledgerView: ledgerView([
			account("rate-limited-free", {
				freeHeadroom: 100,
				rateHeadroom: 0,
				concurrencyHeadroom: 0,
				listUnitCost: 0.04,
			}),
			account("warm-free", {
				freeHeadroom: 5,
				rateHeadroom: 10,
				concurrencyHeadroom: 4,
				listUnitCost: 0.05,
			}),
		]),
	});

	assert.equal(decision.selectedProvider, "warm-free");
	assert.match(decision.ranking[1].rationale, /free-tier-not-depletable/);
});

test("free-tier chase loses when switching cost is higher than the savings", () => {
	const registry = createDispatcherRegistry([
		runner("incumbent", { listUnitCost: 0.01 }),
		runner("free-with-egress", { listUnitCost: 0.03, switchingCost: 0.25 }),
	]);

	const decision = decideDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-switching-cost",
		incumbentProviderId: "incumbent",
		units: 10,
		ledgerView: ledgerView([
			account("incumbent", { freeHeadroom: 0, listUnitCost: 0.01 }),
			account("free-with-egress", { freeHeadroom: 10, listUnitCost: 0.03 }),
		]),
	});

	assert.equal(decision.selectedProvider, "incumbent");
	assert.equal(decision.ranking[0].switchingCost, 0);
	assert.equal(decision.ranking[1].switchingCost, 0.25);
});

test("budget caps and spend-to-date keep over-cap cheap candidates behind affordable runners", () => {
	const registry = createDispatcherRegistry([
		runner("cheap-capped", { listUnitCost: 0.01 }),
		runner("open-budget", { listUnitCost: 0.03 }),
	]);

	const decision = decideDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-budget-cap",
		units: 5,
		ledgerView: ledgerView([
			account("cheap-capped", {
				freeHeadroom: 0,
				listUnitCost: 0.01,
				budgetCap: 1,
				spendToDate: 0.99,
			}),
			account("open-budget", {
				freeHeadroom: 0,
				listUnitCost: 0.03,
				budgetCap: 5,
				spendToDate: 0.5,
			}),
		]),
	});

	assert.equal(decision.selectedProvider, "open-budget");
	assert.equal(decision.ranking[1].budgetExceeded, true);
	assert.match(decision.ranking[1].rationale, /budget-cap-exceeded/);
});

test("reservation-CAS detects a stale ledger and re-ranks so concurrent dispatches cannot double-spend", () => {
	const registry = createDispatcherRegistry([
		runner("github-hosted", { listUnitCost: 0.03 }),
		runner("self-hosted", { listUnitCost: 0.01 }),
	]);
	const reservationLedger = createReservationLedger(
		ledgerView([
			account("github-hosted", { freeHeadroom: 1, listUnitCost: 0.03 }),
			account("self-hosted", { freeHeadroom: 0, listUnitCost: 0.01 }),
		]),
	);
	const staleSnapshot = reservationLedger.snapshot();

	const first = decideAndReserveDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-race-a",
		units: 1,
		ledgerView: staleSnapshot,
		reservationLedger,
	});
	const second = decideAndReserveDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-race-b",
		units: 1,
		ledgerView: staleSnapshot,
		reservationLedger,
	});

	assert.equal(first.selectedProvider, "github-hosted");
	assert.equal(first.reservation.status, "reserved");
	assert.equal(second.attempts[0].status, "cas-conflict");
	assert.deepEqual(
		second.attempts.map((attempt) => attempt.selectedProvider),
		["github-hosted", "self-hosted"],
	);
	assert.equal(second.selectedProvider, "self-hosted");
	assert.equal(second.dispatchEvent.data.ledgerInput.seq, 92);
	assert.equal(reservationLedger.snapshot().seq, 93);
	assert.equal(
		reservationLedger
			.snapshot()
			.accounts.find((entry) => entry.providerId === "github-hosted")
			.freeHeadroom,
		0,
	);
});

test("reservation lifecycle: confirm, release, and expire emit dispatch reservation facts", () => {
	const reservationLedger = createReservationLedger(
		ledgerView([
			account("github-hosted", { freeHeadroom: 5, listUnitCost: 0.03 }),
		]),
	);

	const reserved = reservationLedger.reserve({
		providerId: "github-hosted",
		dimension: "runner.minutes",
		reservationId: "res-1",
		units: 2,
		expectedSeq: 91,
		expiresAt: "2026-06-27T01:00:00.000Z",
	});
	assert.equal(reserved.ok, true);

	const confirmed = reservationLedger.confirm({
		reservationId: "res-1",
		providerUsageSeq: 7,
	});
	assert.equal(confirmed.ok, true);
	assert.equal(confirmed.reservation.providerUsageSeq, 7);

	const reservedAgain = reservationLedger.reserve({
		providerId: "github-hosted",
		dimension: "runner.minutes",
		reservationId: "res-2",
		units: 1,
		expectedSeq: reservationLedger.snapshot().seq,
		expiresAt: "2026-06-27T00:30:00.000Z",
	});
	assert.equal(reservedAgain.ok, true);

	const expiry = reservationLedger.expire({ now: "2026-06-27T00:45:00.000Z" });
	assert.equal(expiry.released, 1);
	assert.deepEqual(
		reservationLedger.events().map((event) => event.type),
		[
			"dispatch.ReservationReserved",
			"dispatch.ReservationConfirmed",
			"dispatch.ReservationReserved",
			"dispatch.LedgerTimeAdvanced",
			"dispatch.ReservationExpired",
		],
	);
	assert.equal(
		reservationLedger
			.snapshot()
			.accounts.find((entry) => entry.providerId === "github-hosted")
			.freeHeadroom,
		3,
	);
});

test("recorded hysteresis keeps an incumbent when a challenger is only near-equal", () => {
	const registry = createDispatcherRegistry([
		runner("incumbent", { listUnitCost: 0.1 }),
		runner("near-free-challenger", { listUnitCost: 0.095 }),
	]);
	const hysteresis = {
		incumbentProviderId: "incumbent",
		minimumSavings: 0.1,
		dwellWindow: "PT10M",
		observedAt: "2026-06-27T00:00:00.000Z",
	};

	const decision = decideDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-hysteresis",
		units: 10,
		ledgerView: ledgerView([
			account("incumbent", { freeHeadroom: 0, listUnitCost: 0.1 }),
			account("near-free-challenger", { freeHeadroom: 0, listUnitCost: 0.095 }),
		]),
		hysteresis,
	});

	assert.equal(decision.selectedProvider, "incumbent");
	assert.equal(decision.hysteresis.held, true);
	assert.deepEqual(decision.hysteresis.input, hysteresis);
	assert.match(decision.ranking[0].rationale, /hysteresis-held/);
	assert.match(
		decision.dispatchEvent.data.candidates[0].rationale,
		/hysteresis-held/,
	);
});

test("hysteresis does not hold an incumbent that violates the budget hard constraint", () => {
	const registry = createDispatcherRegistry([
		runner("incumbent", { listUnitCost: 0.01 }),
		runner("affordable-challenger", { listUnitCost: 0.03 }),
	]);

	const decision = decideDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-budget-hysteresis",
		units: 5,
		ledgerView: ledgerView([
			account("incumbent", {
				freeHeadroom: 0,
				listUnitCost: 0.01,
				budgetCap: 1,
				spendToDate: 0.99,
			}),
			account("affordable-challenger", {
				freeHeadroom: 0,
				listUnitCost: 0.03,
				budgetCap: 10,
				spendToDate: 0,
			}),
		]),
		hysteresis: {
			incumbentProviderId: "incumbent",
			minimumSavings: 1,
			dwellWindow: "PT10M",
			observedAt: "2026-06-27T00:00:00.000Z",
		},
	});

	assert.equal(decision.selectedProvider, "affordable-challenger");
	assert.equal(decision.hysteresis.held, false);
	assert.equal(decision.ranking[1].budgetExceeded, true);
});

test("expiring-soonest free credit wins among equal zero-cost candidates", () => {
	const registry = createDispatcherRegistry([
		runner("july-credit", { listUnitCost: 0.05 }),
		runner("june-credit", { listUnitCost: 0.05 }),
	]);

	const decision = decideDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-expiring-credit",
		units: 1,
		ledgerView: ledgerView([
			account("july-credit", {
				freeHeadroom: 5,
				expiresAt: "2026-07-15T00:00:00.000Z",
			}),
			account("june-credit", {
				freeHeadroom: 5,
				expiresAt: "2026-06-30T00:00:00.000Z",
			}),
		]),
	});

	assert.equal(decision.selectedProvider, "june-credit");
	assert.equal(
		decision.ranking[0].nextCreditExpiresAt,
		"2026-06-30T00:00:00.000Z",
	);
});

test("mis-declared free tier facts degrade gracefully to min-cost", () => {
	const registry = createDispatcherRegistry([
		runner("misdeclared-free", { listUnitCost: 0.04 }),
		runner("plain-cheap", { listUnitCost: 0.02 }),
	]);

	const decision = decideDispatch({
		registry,
		category: "runner",
		dispatchId: "ci-misdeclared-free",
		units: 1,
		ledgerView: ledgerView([
			account("misdeclared-free", {
				freeHeadroom: "unbounded",
				listUnitCost: 0.04,
			}),
		]),
	});

	assert.equal(decision.selectedProvider, "plain-cheap");
	assert.match(decision.ranking[1].rationale, /credit-facts=invalid/);
});

test("no registered candidates fails closed without emitting dispatch.Decided", () => {
	const decision = decideDispatch({
		registry: createDispatcherRegistry([
			runner("free-unregistered", { registered: false }),
		]),
		category: "runner",
		dispatchId: "ci-no-candidates",
		ledgerView: ledgerView([
			account("free-unregistered", { freeHeadroom: 10 }),
		]),
	});

	assert.equal(decision.ok, false);
	assert.match(decision.reason, /no registered runner candidates/);
	assert.equal(decision.dispatchEvent, undefined);
});
