import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  quoteEffectiveMarginalCost,
  snapshotCreditLedger,
} from "../src/credit-ledger-view.js";

const CLOCK = "2026-06-15T12:00:00.000Z";

function creditRegistered(seq, overrides = {}) {
  return {
    type: "credit.Registered",
    seq,
    creditId: overrides.creditId ?? "credit-aws-runner-june",
    providerId: overrides.providerId ?? "aws",
    dimension: overrides.dimension ?? "runner-minutes",
    amount: overrides.amount ?? 100,
    currency: overrides.currency ?? "USD",
    listUnitCost: overrides.listUnitCost ?? 0.01,
    windowStart: overrides.windowStart ?? "2026-06-01T00:00:00.000Z",
    windowEnd: overrides.windowEnd ?? "2026-07-01T00:00:00.000Z",
    expiresAt: overrides.expiresAt,
  };
}

function creditReset(seq, overrides = {}) {
  return {
    type: "credit.Reset",
    seq,
    creditId: overrides.creditId ?? "credit-aws-runner-july",
    providerId: overrides.providerId ?? "aws",
    dimension: overrides.dimension ?? "runner-minutes",
    amount: overrides.amount ?? 100,
    currency: overrides.currency ?? "USD",
    listUnitCost: overrides.listUnitCost ?? 0.01,
    windowStart: overrides.windowStart ?? "2026-07-01T00:00:00.000Z",
    windowEnd: overrides.windowEnd ?? "2026-08-01T00:00:00.000Z",
  };
}

function meterUsage(seq, quantity, overrides = {}) {
  return {
    type: "meter.UsageRecorded",
    seq,
    providerId: overrides.providerId ?? "aws",
    dimension: overrides.dimension ?? "runner-minutes",
    quantity,
    occurredAt: overrides.occurredAt ?? CLOCK,
  };
}

function spendRecorded(seq, quantity, overrides = {}) {
  return {
    type: "spend.Recorded",
    seq,
    providerId: overrides.providerId ?? "aws",
    dimension: overrides.dimension ?? "runner-minutes",
    quantity,
    amount: overrides.amount ?? quantity * 0.01,
    currency: overrides.currency ?? "USD",
    occurredAt: overrides.occurredAt ?? CLOCK,
  };
}

describe("CreditLedgerView projection skeleton", () => {
  it("quotes zero marginal cost through free headroom and list price after", () => {
    const snapshot = snapshotCreditLedger(
      [creditRegistered(1), meterUsage(2, 80)],
      { seq: 2, clock: CLOCK },
    );

    const quote = quoteEffectiveMarginalCost(snapshot, {
      providerId: "aws",
      dimension: "runner-minutes",
      units: 25,
    });

    assert.equal(snapshot.seq, 2);
    assert.equal(snapshot.accounts[0].freeHeadroom, 20);
    assert.equal(quote.marginalUnitCost, 0);
    assert.equal(quote.totalCost, 0.05);
    assert.deepEqual(quote.segments, [
      { units: 20, unitCost: 0, reason: "free-headroom" },
      { units: 5, unitCost: 0.01, reason: "list-price" },
    ]);
  });

  it("replays the same snapshot seq with identical costs and digest", () => {
    const events = [creditRegistered(1), meterUsage(2, 80)];

    const first = snapshotCreditLedger(events, { seq: 2, clock: CLOCK });
    const second = snapshotCreditLedger(events, { seq: 2, clock: CLOCK });

    assert.equal(first.digest, second.digest);
    assert.deepEqual(
      quoteEffectiveMarginalCost(first, {
        providerId: "aws",
        dimension: "runner-minutes",
        units: 25,
      }),
      quoteEffectiveMarginalCost(second, {
        providerId: "aws",
        dimension: "runner-minutes",
        units: 25,
      }),
    );
  });

  it("advances reset-window headroom deterministically from pinned seq and clock", () => {
    const events = [
      creditRegistered(1),
      meterUsage(2, 100, { occurredAt: "2026-06-30T12:00:00.000Z" }),
      creditReset(3),
    ];

    const beforeResetEvent = snapshotCreditLedger(events, {
      seq: 2,
      clock: "2026-07-02T00:00:00.000Z",
    });
    const afterResetEvent = snapshotCreditLedger(events, {
      seq: 3,
      clock: "2026-07-02T00:00:00.000Z",
    });

    assert.equal(beforeResetEvent.accounts[0].freeHeadroom, 0);
    assert.equal(afterResetEvent.accounts[0].freeHeadroom, 100);
    assert.equal(
      quoteEffectiveMarginalCost(afterResetEvent, {
        providerId: "aws",
        dimension: "runner-minutes",
        units: 1,
      }).marginalUnitCost,
      0,
    );
  });

  it("keeps concurrent in-flight decisions isolated at their shared snapshot seq", () => {
    const events = [creditRegistered(1), meterUsage(2, 80)];

    const firstDecision = snapshotCreditLedger(events, { seq: 2, clock: CLOCK });
    const secondDecision = snapshotCreditLedger(events, { seq: 2, clock: CLOCK });
    const afterOneDecisionReportsUsage = snapshotCreditLedger(
      [...events, meterUsage(3, 10)],
      { seq: 3, clock: CLOCK },
    );

    assert.equal(firstDecision.accounts[0].freeHeadroom, 20);
    assert.equal(secondDecision.accounts[0].freeHeadroom, 20);
    assert.equal(afterOneDecisionReportsUsage.accounts[0].freeHeadroom, 10);
    assert.equal(firstDecision.casRequiredForReservation, true);
  });

  it("does not let later spend-to-date mutate an already pinned snapshot", () => {
    const events = [creditRegistered(1), meterUsage(2, 80)];
    const pinned = snapshotCreditLedger(events, { seq: 2, clock: CLOCK });
    const later = snapshotCreditLedger(
      [...events, spendRecorded(3, 15)],
      { seq: 3, clock: CLOCK },
    );

    assert.equal(pinned.accounts[0].freeHeadroom, 20);
    assert.equal(later.accounts[0].freeHeadroom, 5);
    assert.equal(pinned.digest, snapshotCreditLedger(events, { seq: 2, clock: CLOCK }).digest);
  });

  it("prices expired credits at list cost even when the reset window is still open", () => {
    const snapshot = snapshotCreditLedger(
      [
        creditRegistered(1, {
          expiresAt: "2026-06-10T00:00:00.000Z",
          windowEnd: "2026-07-01T00:00:00.000Z",
        }),
      ],
      { seq: 1, clock: CLOCK },
    );

    const quote = quoteEffectiveMarginalCost(snapshot, {
      providerId: "aws",
      dimension: "runner-minutes",
      units: 3,
    });

    assert.equal(snapshot.accounts[0].freeHeadroom, 0);
    assert.deepEqual(quote.segments, [
      { units: 3, unitCost: 0.01, reason: "list-price" },
    ]);
  });

  it("allows a reset to reopen headroom after an exhausted prior window", () => {
    const snapshot = snapshotCreditLedger(
      [
        creditRegistered(1),
        { type: "credit.Exhausted", seq: 2, creditId: "credit-aws-runner-june" },
        creditReset(3, {
          creditId: "credit-aws-runner-june",
        }),
      ],
      { seq: 3, clock: "2026-07-02T00:00:00.000Z" },
    );

    assert.equal(snapshot.accounts[0].freeHeadroom, 100);
  });
});
