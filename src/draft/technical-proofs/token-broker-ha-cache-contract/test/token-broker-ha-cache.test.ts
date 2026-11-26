import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createTokenBrokerCluster,
  recommendedBrokerCacheBounds,
} from "../src/token-broker-ha-cache.js";

const SCOPE = [
  { port: "database/main", resource: "shop.db", actions: ["read", "write"] },
  { port: "queue/main", resource: "orders", actions: ["enqueue"] },
];

describe("HOBO-287 token broker HA credential cache contract", () => {
  it("renews in-flight workload credentials from cache during broker downtime inside grace", () => {
    const cluster = createFixtureCluster();
    const issued = cluster.requestCredential({
      now: "2026-06-26T20:00:00.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: SCOPE,
    });

    cluster.setIdentityAvailable(false);
    cluster.stopReplica("broker-a");
    const renewed = cluster.requestCredential({
      now: "2026-06-26T20:12:00.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: [{ port: "database/main", resource: "shop.db", actions: ["read"] }],
    });

    assert.equal(issued.ok, true);
    assert.equal(issued.source, "identity");
    assert.equal(renewed.ok, true);
    assert.equal(renewed.source, "credential-cache");
    assert.equal(renewed.mode, "renewal-grace");
    assert.equal(renewed.replicaId, "broker-b");
    assert.equal(renewed.dataPlaneOutage, false);
    assert.deepEqual(renewed.scope, [
      { port: "database/main", resource: "shop.db", actions: ["read"] },
    ]);
    assert.deepEqual(renewed.events, [
      "identity.BrokerReplicaUnavailable",
      "identity.BrokerFailover",
      "identity.PartitionGraceEntered",
      "token.Granted",
      "token.Used",
    ]);
  });

  it("fails closed when broker downtime outlasts the signed renewal-grace window", () => {
    const cluster = createFixtureCluster();
    cluster.requestCredential({
      now: "2026-06-26T20:00:00.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: SCOPE,
    });
    cluster.setIdentityAvailable(false);
    cluster.stopReplica("broker-a");

    const denied = cluster.requestCredential({
      now: "2026-06-26T20:15:01.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: [{ port: "database/main", resource: "shop.db", actions: ["read"] }],
    });

    assert.deepEqual(denied, {
      ok: false,
      mode: "fail-closed",
      reason: "renewal-grace-expired",
      replicaId: "broker-b",
      dataPlaneOutage: true,
      events: [
        "identity.BrokerReplicaUnavailable",
        "identity.BrokerFailover",
        "identity.PartitionGraceExpired",
        "token.Denied",
      ],
    });
  });

  it("fails over to another broker replica transparently while identity is healthy", () => {
    const cluster = createFixtureCluster();
    cluster.requestCredential({
      now: "2026-06-26T20:00:00.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: SCOPE,
    });
    cluster.stopReplica("broker-a");

    const renewed = cluster.requestCredential({
      now: "2026-06-26T20:08:00.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: [{ port: "queue/main", resource: "orders", actions: ["enqueue"] }],
    });

    assert.equal(renewed.ok, true);
    assert.equal(renewed.source, "identity");
    assert.equal(renewed.replicaId, "broker-b");
    assert.equal(renewed.mode, "live-renewal");
    assert.equal(renewed.dataPlaneOutage, false);
    assert.deepEqual(renewed.events, [
      "identity.BrokerReplicaUnavailable",
      "identity.BrokerFailover",
      "token.Granted",
      "token.Used",
    ]);
  });

  it("uses the HOBO-266 grace and TTL bounds without extending past SVID notAfter", () => {
    const recommendation = recommendedBrokerCacheBounds({ ttlMs: 15 * 60 * 1000 });
    const cluster = createFixtureCluster();
    const issued = cluster.requestCredential({
      now: "2026-06-26T20:00:00.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: SCOPE,
    });

    assert.deepEqual(recommendation, {
      ttlMs: 900000,
      rotateAtFraction: 2 / 3,
      maxRenewalGraceMs: 300000,
      renewalGraceCannotExceed: "current-svid-notAfter",
    });
    assert.equal(issued.lease.rotateAt, "2026-06-26T20:10:00.000Z");
    assert.equal(issued.lease.renewalGraceUntil, "2026-06-26T20:15:00.000Z");
    assert.equal(issued.lease.notAfter, "2026-06-26T20:15:00.000Z");
  });

  it("invalidates a poisoned cache entry whose backing token was revoked", () => {
    const cluster = createFixtureCluster();
    const issued = cluster.requestCredential({
      now: "2026-06-26T20:00:00.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: SCOPE,
    });
    cluster.setIdentityAvailable(false);
    cluster.revokeToken(issued.tokenId);

    const denied = cluster.requestCredential({
      now: "2026-06-26T20:12:00.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: [{ port: "database/main", resource: "shop.db", actions: ["read"] }],
    });

    assert.deepEqual(denied, {
      ok: false,
      mode: "fail-closed",
      reason: "cached-token-revoked",
      replicaId: "broker-a",
      dataPlaneOutage: true,
      events: ["identity.CacheEntryInvalidated", "token.Revoked", "token.Denied"],
    });
  });

  it("does not let workloads pin a stale cached credential to dodge revocation", () => {
    const cluster = createFixtureCluster();
    const issued = cluster.requestCredential({
      now: "2026-06-26T20:00:00.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: SCOPE,
    });
    cluster.setIdentityAvailable(false);
    cluster.revokeToken(issued.tokenId);

    const denied = cluster.requestCredential({
      now: "2026-06-26T20:12:00.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: [{ port: "database/main", resource: "shop.db", actions: ["read"] }],
      pinnedTokenId: issued.tokenId,
    });

    assert.equal(denied.ok, false);
    assert.equal(denied.mode, "fail-closed");
    assert.equal(denied.reason, "workload-cannot-pin-stale-credential");
    assert.equal(denied.dataPlaneOutage, true);
    assert.deepEqual(denied.events, ["identity.CacheEntryInvalidated", "token.Denied"]);
  });

  it("requires live identity for scope widening instead of minting broader cached tokens", () => {
    const cluster = createFixtureCluster();
    cluster.requestCredential({
      now: "2026-06-26T20:00:00.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: [{ port: "database/main", resource: "shop.db", actions: ["read"] }],
    });
    cluster.setIdentityAvailable(false);

    const denied = cluster.requestCredential({
      now: "2026-06-26T20:12:00.000Z",
      workloadId: "run-42/api",
      tenant: "tenant-a",
      audience: "postgres",
      scope: [{ port: "database/main", resource: "shop.db", actions: ["read", "write"] }],
    });

    assert.equal(denied.ok, false);
    assert.equal(denied.reason, "scope-widening-requires-identity");
    assert.deepEqual(denied.events, [
      "identity.PartitionGraceEntered",
      "token.Denied",
    ]);
  });

  it("rejects duplicate replica ids because HA needs distinct broker replicas", () => {
    assert.throws(
      () =>
        createTokenBrokerCluster({
          replicas: ["broker-a", "broker-a"],
        }),
      /replicas must contain distinct broker replica ids/,
    );
  });
});

function createFixtureCluster() {
  return createTokenBrokerCluster({
    replicas: ["broker-a", "broker-b"],
    ttlMs: 15 * 60 * 1000,
    maxRenewalGraceMs: 5 * 60 * 1000,
    issuer: "yard-identity",
  });
}
