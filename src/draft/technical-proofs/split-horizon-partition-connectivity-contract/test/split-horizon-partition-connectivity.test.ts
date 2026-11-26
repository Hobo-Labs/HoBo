import assert from "node:assert/strict";
import { test } from "vitest";

import {
  evaluateSplitHorizonResolution,
  reconcilePartitionRecovery,
  evaluateTrustLeaseFreshness,
  routeWithPartitionSafety
} from "../src/split-horizon-partition-connectivity.js";

test("split-horizon answers block promotion instead of choosing a majority target", () => {
  const result = evaluateSplitHorizonResolution({
    fqdn: "api.shop.com",
    recordType: "A",
    expectedTargets: ["198.51.100.10"],
    answersByVantage: [
      vantage("iad-recursive", ["198.51.100.10"], { region: "us-east-1", asn: 64512 }),
      vantage("fra-recursive", ["198.51.100.10"], { region: "eu-central-1", asn: 64513 }),
      vantage("syd-recursive", ["203.0.113.20"], { region: "ap-southeast-2", asn: 64514 }),
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    code: "dns.split-horizon.detected",
    reason: "api.shop.com resolved differently across independent vantages",
    promotion: "blocked",
    disagreeingVantages: ["syd-recursive"],
  });
});

test("resolver evidence must come from independent vantages before promotion is allowed", () => {
  const result = evaluateSplitHorizonResolution({
    fqdn: "api.shop.com",
    recordType: "A",
    expectedTargets: ["198.51.100.10"],
    answersByVantage: [
      vantage("iad-recursive-a", ["198.51.100.10"], {
        resolverNetwork: "corp-recursive",
        region: "us-east-1",
        asn: 64512,
      }),
      vantage("iad-recursive-b", ["198.51.100.10"], {
        resolverNetwork: "corp-recursive",
        region: "us-east-1",
        asn: 64512,
      }),
      vantage("iad-recursive-c", ["198.51.100.10"], {
        resolverNetwork: "corp-recursive",
        region: "us-east-1",
        asn: 64512,
      }),
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    code: "dns.vantage-independence.insufficient",
    reason: "api.shop.com requires independent DNS vantage evidence",
    promotion: "blocked",
    insufficientDimensions: ["resolverNetwork", "asn", "region"],
  });
});

test("failover during partition refuses an unconfirmable target even when it is healthy", () => {
  const result = routeWithPartitionSafety({
    localYardId: "yard-aws-prod",
    campYards: {
      "prod-us": "yard-aws-prod",
      "prod-eu": "yard-azure-prod",
    },
    trust: {
      now: "2026-06-28T21:06:00.000Z",
      maxLeaseTtlMs: 300000,
      canConfirmWithRoot: false,
      trustEvents: [
        {
          type: "junction.TrustEstablished",
          sequence: 10,
          peerYardId: "yard-azure-prod",
          issuedAt: "2026-06-28T21:00:00.000Z",
          validUntil: "2026-06-28T21:05:00.000Z",
        },
      ],
    },
    routingRequest: failoverRequest(),
  });

  assert.deepEqual(result, {
    status: "refused",
    code: "routing.partition.unconfirmable-target",
    reason: "failover target prod-eu is unconfirmable during cross-Yard partition",
    events: [],
  });
});

test("partition recovery re-converges routing deterministically without operator action", () => {
  const result = reconcilePartitionRecovery({
    localYardId: "yard-aws-prod",
    peerYardId: "yard-azure-prod",
    now: "2026-06-28T21:06:00.000Z",
    maxLeaseTtlMs: 300000,
    canConfirmWithRoot: true,
    trustEvents: [
      {
        type: "junction.TrustEstablished",
        sequence: 10,
        peerYardId: "yard-azure-prod",
        issuedAt: "2026-06-28T21:00:00.000Z",
        validUntil: "2026-06-28T21:05:00.000Z",
      },
      {
        type: "junction.TrustEstablished",
        sequence: 12,
        peerYardId: "yard-azure-prod",
        issuedAt: "2026-06-28T21:06:00.000Z",
        validUntil: "2026-06-28T21:11:00.000Z",
      },
    ],
    campYards: {
      "prod-us": "yard-aws-prod",
      "prod-eu": "yard-azure-prod",
    },
    routingRequest: failoverRequest(),
  });

  assert.equal(result.status, "reconverged");
  assert.equal(result.operatorActionRequired, false);
  assert.equal(result.appliedTrustSequence, 12);
  assert.equal(result.routing.status, "routed");
  assert.deepEqual(result.routing.record.targets, [{ camp: "prod-eu", value: "203.0.113.20" }]);
  assert.equal(result.routing.events[0].type, "domain.RoutingChanged");
});

test("partitioned Yard fails closed when peer trust freshness cannot be confirmed within TTL", () => {
  const result = evaluateTrustLeaseFreshness({
    yardId: "yard-aws-prod",
    peerYardId: "yard-azure-prod",
    now: "2026-06-28T21:06:00.000Z",
    maxLeaseTtlMs: 300000,
    canConfirmWithRoot: false,
    trustEvents: [
      {
        type: "junction.TrustEstablished",
        sequence: 10,
        peerYardId: "yard-azure-prod",
        issuedAt: "2026-06-28T21:00:00.000Z",
        validUntil: "2026-06-28T21:05:00.000Z",
      },
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    code: "junction.trust-lease.stale",
    guarantee: "fail-closed",
    reason: "yard-aws-prod cannot confirm yard-azure-prod trust freshness within 300000ms",
    actions: ["stop-honoring-peer-principals", "hold-routing-to-peer"],
  });
});

test("trust leases exceeding the TTL cap fail closed even before expiry", () => {
  const result = evaluateTrustLeaseFreshness({
    yardId: "yard-aws-prod",
    peerYardId: "yard-azure-prod",
    now: "2026-06-28T21:04:00.000Z",
    maxLeaseTtlMs: 300000,
    canConfirmWithRoot: true,
    trustEvents: [
      {
        type: "junction.TrustEstablished",
        sequence: 10,
        peerYardId: "yard-azure-prod",
        issuedAt: "2026-06-28T21:00:00.000Z",
        validUntil: "2026-06-28T21:10:00.000Z",
      },
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    code: "junction.trust-lease.ttl-exceeded",
    guarantee: "fail-closed",
    reason: "yard-aws-prod cannot confirm yard-azure-prod trust freshness within 300000ms",
    actions: ["stop-honoring-peer-principals", "hold-routing-to-peer"],
  });
});

test("later trust revocation wins over an older established lease after partition heals", () => {
  const result = evaluateTrustLeaseFreshness({
    yardId: "yard-aws-prod",
    peerYardId: "yard-azure-prod",
    now: "2026-06-28T21:04:00.000Z",
    maxLeaseTtlMs: 300000,
    canConfirmWithRoot: true,
    trustEvents: [
      {
        type: "junction.TrustEstablished",
        sequence: 10,
        peerYardId: "yard-azure-prod",
        issuedAt: "2026-06-28T21:00:00.000Z",
        validUntil: "2026-06-28T21:08:00.000Z",
      },
      {
        type: "junction.TrustRevoked",
        sequence: 11,
        peerYardId: "yard-azure-prod",
        issuedAt: "2026-06-28T21:04:00.000Z",
        validUntil: "2026-06-28T21:09:00.000Z",
      },
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    code: "junction.trust-revoked",
    guarantee: "fail-closed",
    reason: "yard-aws-prod applied revocation sequence 11 for yard-azure-prod",
    actions: ["stop-honoring-peer-principals", "hold-routing-to-peer"],
  });
});

function vantage(id, targets, extra = {}) {
  return {
    id,
    resolverNetwork: id,
    targets,
    observedAt: "2026-06-28T21:00:00.000Z",
    ...extra,
  };
}

function camp(campName, extra = {}) {
  return {
    camp: campName,
    validated: true,
    healthy: true,
    ...extra,
  };
}

function failoverRequest() {
  return {
    domain: "shop.com",
    recordName: "api.shop.com",
    activeCamp: "prod-us",
    sustainedFailureThreshold: 2,
    policy: {
      kind: "failover",
      targets: [
        { camp: "prod-us", priority: 1 },
        { camp: "prod-eu", priority: 2 },
      ],
    },
    camps: [
      camp("prod-us", { value: "198.51.100.10", healthy: false }),
      camp("prod-eu", { value: "203.0.113.20" }),
    ],
    healthSamples: [
      { camp: "prod-us", healthy: false },
      { camp: "prod-us", healthy: false },
    ],
  };
}
