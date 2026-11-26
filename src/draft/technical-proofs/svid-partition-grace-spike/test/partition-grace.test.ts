import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createRotationLease,
  evaluateTokenRenewal,
  reconcileAfterPartition,
  summarizeRecommendation,
} from "../src/partition-grace.js";

const SCOPE = [
  { port: "database/main", resource: "shop.db", actions: ["read", "write"] },
  { port: "queue/main", resource: "orders", actions: ["enqueue"] },
];

describe("HOBO-266 SVID partition grace spike", () => {
  it("chooses a bounded fail-open grace that never exceeds the current SVID notAfter", () => {
    const recommendation = summarizeRecommendation({ ttlMs: 15 * 60 * 1000 });
    const lease = createRotationLease({
      issuedAt: "2026-06-26T20:00:00.000Z",
      ttlMs: recommendation.ttlMs,
      renewalGraceMs: recommendation.maxRenewalGraceMs,
      scope: SCOPE,
    });

    assert.deepEqual(recommendation, {
      decision: "fail-open-within-signed-grace-then-fail-closed",
      ttlMs: 900000,
      rotateAtFraction: 2 / 3,
      maxRenewalGraceMs: 300000,
      graceCannotExceed: "current-svid-notAfter",
      workloadCanExtendGrace: false,
      staleBeyondSvidExpiry: false,
    });
    assert.equal(lease.rotateAt, "2026-06-26T20:10:00.000Z");
    assert.equal(lease.renewalGraceUntil, "2026-06-26T20:15:00.000Z");
    assert.equal(lease.notAfter, "2026-06-26T20:15:00.000Z");
  });

  it("renews from cache inside the signed grace window with the same-or-narrower scope", () => {
    const lease = fixtureLease();
    const decision = evaluateTokenRenewal(lease, {
      now: "2026-06-26T20:12:00.000Z",
      scope: [{ port: "database/main", resource: "shop.db", actions: ["read"] }],
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.mode, "partition-grace");
    assert.equal(decision.validUntil, "2026-06-26T20:15:00.000Z");
    assert.deepEqual(decision.events, ["identity.PartitionGraceEntered"]);
    assert.deepEqual(decision.scope, [
      { port: "database/main", resource: "shop.db", actions: ["read"] },
    ]);
  });

  it("fails closed once the partition outlasts the signed grace window", () => {
    const decision = evaluateTokenRenewal(fixtureLease(), {
      now: "2026-06-26T20:15:01.000Z",
      scope: [{ port: "database/main", resource: "shop.db", actions: ["read"] }],
    });

    assert.deepEqual(decision, {
      ok: false,
      mode: "fail-closed",
      reason: "renewal-grace-expired",
      now: "2026-06-26T20:15:01.000Z",
      leaseEpoch: 7,
      events: ["identity.PartitionGraceExpired"],
    });
  });

  it("does not let the workload extend its own grace or widen scope while partitioned", () => {
    const lease = fixtureLease();
    const extended = evaluateTokenRenewal(lease, {
      now: "2026-06-26T20:12:00.000Z",
      requestedGraceUntil: "2026-06-26T20:20:00.000Z",
    });
    const widened = evaluateTokenRenewal(lease, {
      now: "2026-06-26T20:12:00.000Z",
      scope: [{ port: "database/main", resource: "shop.db", actions: ["read", "admin"] }],
    });

    assert.equal(extended.ok, false);
    assert.equal(extended.reason, "workload-cannot-extend-renewal-grace");
    assert.equal(widened.ok, false);
    assert.equal(widened.reason, "scope-widening-requires-identity");
  });

  it("rotates exactly once after partition heal and reuses an observed rotation on replay", () => {
    const lease = fixtureLease();
    const healed = reconcileAfterPartition(lease, {
      now: "2026-06-26T20:14:00.000Z",
      observedEpochs: [],
    });
    const replay = reconcileAfterPartition(lease, {
      now: "2026-06-26T20:14:05.000Z",
      observedEpochs: [healed.epoch],
    });

    assert.equal(healed.ok, true);
    assert.equal(healed.action, "rotate-on-heal");
    assert.equal(healed.previousEpoch, 7);
    assert.equal(healed.epoch, 8);
    assert.deepEqual(healed.events, ["identity.Rotated"]);
    assert.equal(healed.lease.issuedAt, "2026-06-26T20:14:00.000Z");

    assert.deepEqual(replay, {
      ok: true,
      action: "reuse-existing-rotation",
      epoch: 8,
      previousEpoch: 7,
      events: [],
    });
  });

  it("fails closed on heal after grace instead of double-issuing or reviving stale credentials", () => {
    const healed = reconcileAfterPartition(fixtureLease(), {
      now: "2026-06-26T20:16:00.000Z",
    });

    assert.deepEqual(healed, {
      ok: false,
      action: "fail-closed",
      reason: "partition-outlasted-renewal-grace",
      now: "2026-06-26T20:16:00.000Z",
      previousEpoch: 7,
      events: ["identity.PartitionGraceExpired"],
    });
  });

  it("rejects malformed signed leases that could keep credentials alive past notAfter", () => {
    const lease = {
      ...fixtureLease(),
      rotateAt: "2026-06-26T20:20:00.000Z",
      renewalGraceUntil: "2026-06-26T20:15:00.000Z",
    };

    assert.throws(
      () =>
        evaluateTokenRenewal(lease, {
          now: "2026-06-26T20:16:00.000Z",
          scope: [{ port: "database/main", resource: "shop.db", actions: ["read"] }],
        }),
      /lease\.rotateAt must be inside the SVID validity window/,
    );
  });
});

function fixtureLease() {
  return createRotationLease({
    tenant: "tenant-a",
    runId: "run-hobo-266",
    agent: "release-agent",
    epoch: 7,
    issuedAt: "2026-06-26T20:00:00.000Z",
    ttlMs: 15 * 60 * 1000,
    renewalGraceMs: 5 * 60 * 1000,
    scope: SCOPE,
  });
}
