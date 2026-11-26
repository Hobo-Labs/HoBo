import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createDispatcherRegistry,
  createReservationLedger,
  decideAndReserveDispatch,
} from "../../dispatcher-maximize-credits-contract/src/dispatcher.js";

function ledgerView(accounts = [], overrides = {}) {
  return {
    view: "CreditLedgerView",
    seq: overrides.seq ?? 200,
    digest: overrides.digest ?? "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    credits: overrides.credits ?? [
      {
        creditId: `${providerId}-free`,
        freeHeadroom,
        expiresAt: "2026-07-01T00:00:00.000Z",
      },
    ],
  };
}

function runner(id, overrides = {}) {
  return {
    id,
    providerId: id,
    category: "runner",
    dimension: "runner.minutes",
    listUnitCost: overrides.listUnitCost ?? 0.02,
  };
}

function registry() {
  return createDispatcherRegistry([
    runner("free-runner", { listUnitCost: 0.04 }),
    runner("paid-runner", { listUnitCost: 0.01 }),
  ]);
}

test("N-way concurrent CI burst cannot consume more free-tier units than the allotment", () => {
  const reservationLedger = createReservationLedger(
    ledgerView([
      account("free-runner", { freeHeadroom: 2, listUnitCost: 0.04 }),
      account("paid-runner", { freeHeadroom: 0, listUnitCost: 0.01 }),
    ]),
  );
  const staleSnapshot = reservationLedger.snapshot();

  const decisions = Array.from({ length: 5 }, (_, index) => decideAndReserveDispatch({
    registry: registry(),
    category: "runner",
    dispatchId: `ci-burst-${index + 1}`,
    units: 1,
    ledgerView: staleSnapshot,
    reservationLedger,
  }));

  assert.deepEqual(decisions.map((decision) => decision.selectedProvider), [
    "free-runner",
    "free-runner",
    "paid-runner",
    "paid-runner",
    "paid-runner",
  ]);
  assert.equal(
    reservationLedger.snapshot().accounts.find((entry) => entry.providerId === "free-runner").freeHeadroom,
    0,
  );
  assert.equal(
    reservationLedger.snapshot().reservations.filter((entry) => entry.providerId === "free-runner").length,
    2,
  );
});

test("dispatch failure releases a pending reservation and restores headroom", () => {
  const reservationLedger = createReservationLedger(
    ledgerView([account("free-runner", { freeHeadroom: 1, listUnitCost: 0.04 })]),
  );
  const decision = decideAndReserveDispatch({
    registry: createDispatcherRegistry([runner("free-runner", { listUnitCost: 0.04 })]),
    category: "runner",
    dispatchId: "ci-release",
    units: 1,
    reservationId: "reserve-ci-release",
    reservationLedger,
  });

  assert.equal(decision.selectedProvider, "free-runner");
  assert.equal(reservationLedger.snapshot().accounts[0].freeHeadroom, 0);

  const release = reservationLedger.release({
    reservationId: "reserve-ci-release",
    reason: "dispatch-failed",
  });

  assert.equal(release.ok, true);
  assert.equal(release.status, "released");
  assert.equal(reservationLedger.snapshot().accounts[0].freeHeadroom, 1);
  assert.deepEqual(reservationLedger.events().map((event) => event.type), [
    "dispatch.ReservationReserved",
    "dispatch.ReservationReleased",
  ]);
});

test("reserved-but-never-confirmed dispatch expires and releases without a second spend", () => {
  const reservationLedger = createReservationLedger(
    ledgerView([account("free-runner", { freeHeadroom: 1, listUnitCost: 0.04 })]),
  );

  decideAndReserveDispatch({
    registry: createDispatcherRegistry([runner("free-runner", { listUnitCost: 0.04 })]),
    category: "runner",
    dispatchId: "ci-timeout",
    units: 1,
    reservationId: "reserve-ci-timeout",
    reservationExpiresAt: "2026-06-27T00:05:00.000Z",
    reservationLedger,
  });

  const expiry = reservationLedger.expire({
    now: "2026-06-27T00:06:00.000Z",
  });

  assert.equal(expiry.released, 1);
  assert.equal(reservationLedger.snapshot().accounts[0].freeHeadroom, 1);
  assert.equal(reservationLedger.events().at(-1).type, "dispatch.ReservationExpired");
});

test("confirmed reservations are recorded and are not released by timeout cleanup", () => {
  const reservationLedger = createReservationLedger(
    ledgerView([account("free-runner", { freeHeadroom: 1, listUnitCost: 0.04 })]),
  );

  decideAndReserveDispatch({
    registry: createDispatcherRegistry([runner("free-runner", { listUnitCost: 0.04 })]),
    category: "runner",
    dispatchId: "ci-confirm",
    units: 1,
    reservationId: "reserve-ci-confirm",
    reservationExpiresAt: "2026-06-27T00:05:00.000Z",
    reservationLedger,
  });

  const confirm = reservationLedger.confirm({
    reservationId: "reserve-ci-confirm",
    providerUsageSeq: 501,
  });
  const expiry = reservationLedger.expire({
    now: "2026-06-27T00:06:00.000Z",
  });

  assert.equal(confirm.ok, true);
  assert.equal(confirm.status, "confirmed");
  assert.equal(expiry.released, 0);
  assert.equal(reservationLedger.snapshot().accounts[0].freeHeadroom, 0);
  assert.equal(reservationLedger.events().at(-1).type, "dispatch.ReservationConfirmed");
});

test("late provider usage cannot confirm an already expired reservation", () => {
  const reservationLedger = createReservationLedger(
    ledgerView([account("free-runner", { freeHeadroom: 1, listUnitCost: 0.04 })]),
  );

  decideAndReserveDispatch({
    registry: createDispatcherRegistry([runner("free-runner", { listUnitCost: 0.04 })]),
    category: "runner",
    dispatchId: "ci-late-usage",
    units: 1,
    reservationId: "reserve-ci-late-usage",
    reservationExpiresAt: "2026-06-27T00:05:00.000Z",
    reservationLedger,
  });

  reservationLedger.expire({
    now: "2026-06-27T00:06:00.000Z",
  });
  const lateConfirm = reservationLedger.confirm({
    reservationId: "reserve-ci-late-usage",
    providerUsageSeq: 777,
  });

  assert.equal(lateConfirm.ok, false);
  assert.equal(lateConfirm.status, "not-confirmable");
  assert.equal(reservationLedger.snapshot().accounts[0].freeHeadroom, 1);
  assert.deepEqual(reservationLedger.events().map((event) => event.type), [
    "dispatch.ReservationReserved",
    "dispatch.ReservationExpired",
  ]);
});
