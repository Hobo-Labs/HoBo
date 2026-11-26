import assert from "node:assert/strict";
import { test } from "vitest";

import { validateControlPlaneEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import {
  createDispatcherRegistry,
  createReservationLedger,
  decideAndReserveDispatch,
  decideDispatch,
  decidePlacement,
  replayDispatchDecision,
} from "../src/dispatcher.js";

const LEDGER_DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const CATALOG_HASH = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

function ledgerView(accounts = [], overrides = {}) {
  return {
    view: "CreditLedgerView",
    seq: overrides.seq ?? 91,
    digest: overrides.digest ?? LEDGER_DIGEST,
    asOf: "2026-06-27T00:00:00.000Z",
    accounts,
  };
}

function account(providerId, overrides = {}) {
  const freeHeadroom = overrides.freeHeadroom ?? 0;
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

function runner(id, overrides = {}) {
  return {
    id,
    providerId: id,
    category: "runner",
    registered: overrides.registered ?? true,
    dimension: "runner.minutes",
    listUnitCost: overrides.listUnitCost ?? 0.02,
    switchingCost: overrides.switchingCost ?? 0,
  };
}

function placementCandidate(definitionId, overrides = {}) {
  return {
    definitionId,
    providerId: overrides.providerId ?? definitionId,
    registered: overrides.registered ?? true,
    resourceType: "object-store",
    dimension: "object-store.gib-month",
    listUnitCost: overrides.listUnitCost ?? 0.02,
    specificity: overrides.specificity ?? 1,
    priority: overrides.priority ?? 0,
    region: overrides.region ?? "us-east-1",
    switchingCost: overrides.switchingCost ?? 0,
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
  assert.deepEqual(decision.ranking.map((candidate) => candidate.providerId), [
    "github-hosted",
    "self-hosted",
  ]);
  assert.equal(decision.dispatchEvent.type, "dispatch.Decided");
  assert.deepEqual(decision.dispatchEvent.data.ledgerInput, {
    view: "CreditLedgerView",
    seq: 91,
    reservationId: "reservation-intent-ci-test",
    balanceHash: LEDGER_DIGEST,
  });
  assert.equal(validateControlPlaneEvent(decision.dispatchEvent).ok, true);
});

test("replaying the same dispatch decision yields an identical pick and event body", () => {
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
  assert.deepEqual(replayed.dispatchEvent.data, first.dispatchEvent.data);
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
    ledgerView: ledgerView([
      account("github-hosted", { freeHeadroom: 0, listUnitCost: 0.03 }),
      account("self-hosted", { freeHeadroom: 0, listUnitCost: 0.01 }),
    ], { seq: 92 }),
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
      placementCandidate("azure-blob", { providerId: "azure", listUnitCost: 0.02 }),
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
  assert.equal(validateControlPlaneEvent(decision.matchEvent).ok, true);
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
  assert.equal(decision.ranking[0].rationale.includes("credit-facts=missing"), true);
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
  assert.deepEqual(second.attempts.map((attempt) => attempt.selectedProvider), [
    "github-hosted",
    "self-hosted",
  ]);
  assert.equal(second.selectedProvider, "self-hosted");
  assert.equal(second.dispatchEvent.data.ledgerInput.seq, 92);
  assert.equal(validateControlPlaneEvent(second.dispatchEvent).ok, true);
  assert.equal(reservationLedger.snapshot().seq, 93);
  assert.equal(
    reservationLedger.snapshot().accounts.find((entry) => entry.providerId === "github-hosted").freeHeadroom,
    0,
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
  assert.match(decision.dispatchEvent.data.candidates[0].rationale, /hysteresis-held/);
  assert.equal(validateControlPlaneEvent(decision.dispatchEvent).ok, true);
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
      account("july-credit", { freeHeadroom: 5, expiresAt: "2026-07-15T00:00:00.000Z" }),
      account("june-credit", { freeHeadroom: 5, expiresAt: "2026-06-30T00:00:00.000Z" }),
    ]),
  });

  assert.equal(decision.selectedProvider, "june-credit");
  assert.equal(decision.ranking[0].nextCreditExpiresAt, "2026-06-30T00:00:00.000Z");
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
    registry: createDispatcherRegistry([runner("free-unregistered", { registered: false })]),
    category: "runner",
    dispatchId: "ci-no-candidates",
    ledgerView: ledgerView([account("free-unregistered", { freeHeadroom: 10 })]),
  });

  assert.equal(decision.ok, false);
  assert.match(decision.reason, /no registered runner candidates/);
  assert.equal(decision.dispatchEvent, undefined);
});
