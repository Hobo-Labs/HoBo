import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CheckFidelity,
  runMtlsByDefaultConformanceGate
} from "../src/mtls-by-default-conformance-gate.js";
import { ConnectivityTier } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";

const NOW = "2026-06-29T00:25:00.000Z";
const REQUIRED_TIERS = [
  ConnectivityTier.SAME_PROVIDER_REGION,
  ConnectivityTier.SAME_PROVIDER_CROSS_REGION,
  ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
  ConnectivityTier.OVERLAY_MESH,
  ConnectivityTier.PUBLIC_MTLS
];

test("gate covers every realized tier with SVID-keyed mTLS and honest local/camp fidelity", () => {
  const report = runMtlsByDefaultConformanceGate({
    targets: allTierTargets()
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.coveredTiers, REQUIRED_TIERS);

  const handshakeFidelity = checksByTier(report, "svid-mtls-handshake");
  assert.equal(handshakeFidelity[ConnectivityTier.SAME_PROVIDER_REGION].fidelity, CheckFidelity.LOCAL);
  assert.equal(handshakeFidelity[ConnectivityTier.SAME_PROVIDER_CROSS_REGION].fidelity, CheckFidelity.LOCAL);
  assert.equal(handshakeFidelity[ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT].fidelity, CheckFidelity.CAMP);
  assert.equal(handshakeFidelity[ConnectivityTier.OVERLAY_MESH].fidelity, CheckFidelity.CAMP);
  assert.equal(handshakeFidelity[ConnectivityTier.PUBLIC_MTLS].fidelity, CheckFidelity.CAMP);

  for (const check of report.checks.filter((entry) => entry.kind !== "svid-mtls-handshake")) {
    assert.equal(check.fidelity, CheckFidelity.LOCAL);
    assert.equal(check.status, "rejected");
  }
});

test("tier stub that drops mTLS fails the gate", () => {
  const targets = allTierTargets();
  targets[0] = {
    ...targets[0],
    mtls: { ok: false, code: "stub.no-mtls", reason: "plain TCP stub" }
  };

  const report = runMtlsByDefaultConformanceGate({ targets });

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures[0], {
    tier: ConnectivityTier.SAME_PROVIDER_REGION,
    edgeId: "tier-1-edge",
    code: "mtls.tier.mtls-missing",
    reason: "tier 1 did not prove an SVID-keyed mTLS handshake"
  });
});

test("mTLS evidence must identify the bound target SVID peer", () => {
  const targets = allTierTargets();
  targets[1] = {
    ...targets[1],
    mtls: {
      ok: true,
      peer: {
        tenant: "tenant-a",
        trustDomain: "tenant-a",
        resource: "support-worker"
      }
    }
  };

  const report = runMtlsByDefaultConformanceGate({ targets });

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures[0], {
    tier: ConnectivityTier.SAME_PROVIDER_CROSS_REGION,
    edgeId: "tier-2-edge",
    code: "mtls.tier.peer-mismatch",
    reason: "tier 2 mTLS peer support-worker does not match target orders-db"
  });
});

test("tier that works but skips client-certificate verification fails closed", () => {
  const targets = allTierTargets();
  targets[3] = withCheck(targets[3], "plaintextPeer", {
    status: "accepted",
    code: "overlay.accepted-plaintext"
  });

  const report = runMtlsByDefaultConformanceGate({ targets });

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures[0], {
    tier: ConnectivityTier.OVERLAY_MESH,
    edgeId: "tier-4-edge",
    code: "mtls.tier.plaintext-accepted",
    reason: "tier 4 accepted unauthenticated/plaintext traffic"
  });
});

test("cross-tenant trust-domain peer must be rejected on every tier", () => {
  const targets = allTierTargets();
  targets[4] = withCheck(targets[4], "crossTenantPeer", {
    status: "accepted",
    code: "public-gateway.allowed-cross-tenant"
  });

  const report = runMtlsByDefaultConformanceGate({ targets });

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures[0], {
    tier: ConnectivityTier.PUBLIC_MTLS,
    edgeId: "tier-5-edge",
    code: "mtls.tier.cross-tenant-accepted",
    reason: "tier 5 accepted a peer from another tenant trust domain"
  });
});

test("camp-only handshake cannot report green without camp evidence", () => {
  const targets = allTierTargets();
  targets[2] = withCheck(targets[2], "svidMtlsHandshake", {
    fidelity: CheckFidelity.CAMP,
    status: "passed",
    evidenceRef: undefined,
    ranAt: undefined
  });

  const report = runMtlsByDefaultConformanceGate({ targets });

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures[0], {
    tier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    edgeId: "tier-3-edge",
    code: "mtls.coverage.camp-not-run",
    reason: "tier 3 marked a camp-only handshake green without camp run evidence"
  });
});

test("cross-cloud handshake mislabeled as local fails the coverage gate", () => {
  const targets = allTierTargets();
  targets[3] = withCheck(targets[3], "svidMtlsHandshake", {
    fidelity: CheckFidelity.LOCAL
  });

  const report = runMtlsByDefaultConformanceGate({ targets });

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures[0], {
    tier: ConnectivityTier.OVERLAY_MESH,
    edgeId: "tier-4-edge",
    code: "mtls.coverage.cross-cloud-mislabeled",
    reason: "tier 4 cross-cloud handshake must be tagged camp"
  });
});

test("missing realized tier fails instead of claiming full mTLS-by-default coverage", () => {
  const report = runMtlsByDefaultConformanceGate({
    targets: allTierTargets().filter((target) => target.tier !== ConnectivityTier.PUBLIC_MTLS)
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures[0], {
    tier: ConnectivityTier.PUBLIC_MTLS,
    edgeId: null,
    code: "mtls.tier.missing",
    reason: "tier 5 is missing from mTLS-by-default conformance coverage"
  });
});

function allTierTargets() {
  return [
    tierTarget({
      tier: ConnectivityTier.SAME_PROVIDER_REGION,
      edgeId: "tier-1-edge",
      sourceProvider: "aws",
      targetProvider: "aws",
      handshakeScope: "intra-tier",
      handshakeFidelity: CheckFidelity.LOCAL
    }),
    tierTarget({
      tier: ConnectivityTier.SAME_PROVIDER_CROSS_REGION,
      edgeId: "tier-2-edge",
      sourceProvider: "aws",
      targetProvider: "aws",
      handshakeScope: "intra-tier",
      handshakeFidelity: CheckFidelity.LOCAL
    }),
    tierTarget({
      tier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
      edgeId: "tier-3-edge",
      sourceProvider: "aws",
      targetProvider: "azure",
      handshakeScope: "cross-cloud",
      handshakeFidelity: CheckFidelity.CAMP
    }),
    tierTarget({
      tier: ConnectivityTier.OVERLAY_MESH,
      edgeId: "tier-4-edge",
      sourceProvider: "aws",
      targetProvider: "gcp",
      handshakeScope: "cross-cloud",
      handshakeFidelity: CheckFidelity.CAMP
    }),
    tierTarget({
      tier: ConnectivityTier.PUBLIC_MTLS,
      edgeId: "tier-5-edge",
      sourceProvider: "aws",
      targetProvider: "public-internet",
      handshakeScope: "cross-cloud",
      handshakeFidelity: CheckFidelity.CAMP
    })
  ];
}

function tierTarget({
  tier,
  edgeId,
  sourceProvider,
  targetProvider,
  handshakeScope,
  handshakeFidelity
}) {
  return {
    tier,
    edgeId,
    source: {
      resourceId: "orders-api",
      provider: sourceProvider,
      svid: "spiffe://tenant-a/shop/orders-api"
    },
    target: {
      resourceId: "orders-db",
      provider: targetProvider,
      svid: "spiffe://tenant-a/shop/orders-db"
    },
    mtls: {
      ok: true,
      peer: {
        tenant: "tenant-a",
        trustDomain: "tenant-a",
        resource: "orders-db"
      }
    },
    handshakeScope,
    checks: {
      svidMtlsHandshake: {
        status: "passed",
        fidelity: handshakeFidelity,
        evidenceRef: handshakeFidelity === CheckFidelity.CAMP ? `camp-run://${edgeId}` : undefined,
        ranAt: NOW
      },
      plaintextPeer: {
        status: "rejected",
        fidelity: CheckFidelity.LOCAL,
        code: "mtls.client-cert.required",
        ranAt: NOW
      },
      crossTenantPeer: {
        status: "rejected",
        fidelity: CheckFidelity.LOCAL,
        code: "mtls.peer.tenant-mismatch",
        ranAt: NOW
      }
    }
  };
}

function withCheck(target, key, patch) {
  return {
    ...target,
    checks: {
      ...target.checks,
      [key]: {
        ...target.checks[key],
        ...patch
      }
    }
  };
}

function checksByTier(report, kind) {
  return Object.fromEntries(
    report.checks
      .filter((check) => check.kind === kind)
      .map((check) => [check.tier, check])
  );
}
