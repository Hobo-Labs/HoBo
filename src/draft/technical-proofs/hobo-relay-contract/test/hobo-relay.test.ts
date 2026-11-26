import assert from "node:assert/strict";
import { test } from "vitest";

import {
  attemptInboundConnection,
  authorizeRelayConnection,
  attachRelay,
  dispatchRelayWork,
  pipelineRelayConnect,
  registerRelay,
  routeRelayTarget
} from "../src/hobo-relay.js";

const now = "2026-06-28T12:00:00.000Z";
const yardSvid = "spiffe://yard/tenant-acme/hobo-yard/control-plane";
const relaySvid = "spiffe://yard/tenant-acme/hobo-relay/private-relay";

test("relay registration and attach require governed allow plus outbound-only TCP 443 SVID authentication", () => {
  const registration = registerRelay(relaySpec(), policyAllow("hobo:relay:register"));
  assert.equal(registration.ok, true);
  assert.deepEqual(registration.audit, [
    {
      type: "policy.Decided",
      action: "hobo:relay:register",
      effect: "allow",
      relayId: "relay-private-network"
    },
    {
      type: "relay.Registered",
      relayId: "relay-private-network",
      targetIds: ["cluster-a", "cluster-b"]
    }
  ]);

  const session = attachRelay(registration.relay, policyAllow("hobo:relay:attach"));

  assert.equal(session.ok, true);
  assert.equal(session.session.transport.direction, "relay-to-yard");
  assert.equal(session.session.transport.port, 443);
  assert.equal(session.session.hasInboundListener, false);
  assert.equal(session.session.peer.spiffeId, relaySvid);
  assert.deepEqual(session.session.targetIds, ["cluster-a", "cluster-b"]);
});

test("yard dispatches work and receives exec results through the relay without credential egress", () => {
  const session = attachedRelay();

  const routed = dispatchRelayWork(session.session, {
    workId: "exec-apply-db",
    targetId: "cluster-a",
    resourceId: "db",
    provider: "aws",
    credentialRef: "private-broker://cluster-a/scoped-token/db/apply",
    outputs: { endpoint: "postgres://db.internal" }
  });

  assert.equal(routed.ok, true);
  assert.deepEqual(routed.yardFrames, [
    {
      type: "relay.WorkDispatched",
      relayId: "relay-private-network",
      targetId: "cluster-a",
      workId: "exec-apply-db",
      resourceId: "db",
      provider: "aws"
    },
    {
      type: "exec.Succeeded",
      relayId: "relay-private-network",
      targetId: "cluster-a",
      workId: "exec-apply-db",
      outputs: { endpoint: "postgres://db.internal" }
    }
  ]);
  assert.deepEqual(routed.privateExecutorFrame, {
    targetId: "cluster-a",
    workId: "exec-apply-db",
    resourceId: "db",
    provider: "aws",
    credentialRef: "private-broker://cluster-a/scoped-token/db/apply"
  });
  assert.equal(JSON.stringify(routed.yardFrames).includes("scoped-token"), false);
});

test("one relay routes multiple private targets by target id", () => {
  const session = attachedRelay().session;

  assert.deepEqual(routeRelayTarget(session, "cluster-a"), {
    ok: true,
    relayId: "relay-private-network",
    target: {
      targetId: "cluster-a",
      kind: "kubernetes-cluster",
      privateNetwork: "prod-a",
      allowedResourceIds: ["db"]
    }
  });
  assert.deepEqual(routeRelayTarget(session, "cluster-b"), {
    ok: true,
    relayId: "relay-private-network",
    target: {
      targetId: "cluster-b",
      kind: "vm-pool",
      privateNetwork: "prod-b",
      allowedResourceIds: ["vm-pool"]
    }
  });
});

test("inbound listeners and inbound connection attempts are impossible", () => {
  assert.deepEqual(registerRelay(relaySpec({
    transport: {
      direction: "yard-to-relay",
      protocol: "tcp",
      port: 443
    }
  }), policyAllow("hobo:relay:register")), {
    ok: false,
    code: "relay.transport.not-outbound",
    reason: "relay must dial the Yard over outbound TCP 443"
  });

  assert.deepEqual(registerRelay(relaySpec({
    inboundListeners: [{ host: "0.0.0.0", port: 8443 }]
  }), policyAllow("hobo:relay:register")), {
    ok: false,
    code: "relay.inbound.exposed",
    reason: "relay contract forbids inbound listeners into the private network"
  });

  assert.deepEqual(attemptInboundConnection(attachedRelay().session), {
    ok: false,
    code: "relay.inbound.unavailable",
    reason: "relay relay-private-network exposes no inbound listener"
  });
});

test("unauthenticated, expired, or cross-tenant SVIDs cannot attach", () => {
  assert.deepEqual(attachRelay(registerRelay(relaySpec({
    mtls: mtlsContract({
      peerCertificate: undefined
    })
  }), policyAllow("hobo:relay:register")).relay, policyAllow("hobo:relay:attach")), {
    ok: false,
    code: "relay.attach.svid-rejected",
    reason: "peerCertificate must be an object"
  });

  assert.deepEqual(attachRelay(registerRelay(relaySpec({
    mtls: mtlsContract({
      peerCertificate: cert(relaySvid, { notAfter: "2026-06-28T11:59:59.000Z" })
    })
  }), policyAllow("hobo:relay:register")).relay, policyAllow("hobo:relay:attach")), {
    ok: false,
    code: "relay.attach.svid-rejected",
    reason: "peer SVID is expired or not yet valid"
  });

  assert.deepEqual(attachRelay(registerRelay(relaySpec({
    mtls: mtlsContract({
      peerCertificate: cert("spiffe://yard/tenant-beta/hobo-relay/private-relay"),
      allowedPeers: ["spiffe://yard/tenant-beta/hobo-relay/private-relay"]
    })
  }), policyAllow("hobo:relay:register")).relay, policyAllow("hobo:relay:attach")), {
    ok: false,
    code: "relay.attach.svid-rejected",
    reason: "peer tenant tenant-beta does not match connection tenant tenant-acme"
  });
});

test("target id mismatch and credential material in a Yard work frame fail closed", () => {
  const session = attachedRelay().session;

  assert.deepEqual(routeRelayTarget(session, "metadata-service"), {
    ok: false,
    code: "relay.target.unknown",
    reason: "target id metadata-service is not registered for relay relay-private-network"
  });

  assert.deepEqual(dispatchRelayWork(session, {
    workId: "exec-apply-db",
    targetId: "cluster-a",
    resourceId: "db",
    provider: "aws",
    credentialRef: "private-broker://cluster-a/scoped-token/db/apply",
    credentialMaterial: "secret-token-value"
  }), {
    ok: false,
    code: "relay.credential.egress",
    reason: "Yard work frames must carry private-network credential references, never credential material"
  });
});

test("relay register and attach actions are governed deny-by-default", () => {
  assert.deepEqual(registerRelay(relaySpec(), policyDeny("hobo:relay:register")), {
    ok: false,
    code: "relay.policy.denied",
    reason: "policy denied hobo:relay:register for relay relay-private-network",
    audit: [{
      type: "policy.Decided",
      action: "hobo:relay:register",
      effect: "deny",
      relayId: "relay-private-network"
    }]
  });

  const registration = registerRelay(relaySpec(), policyAllow("hobo:relay:register"));
  assert.deepEqual(attachRelay(registration.relay, policyDeny("hobo:relay:attach")), {
    ok: false,
    code: "relay.policy.denied",
    reason: "policy denied hobo:relay:attach for relay relay-private-network",
    audit: [{
      type: "policy.Decided",
      action: "hobo:relay:attach",
      effect: "deny",
      relayId: "relay-private-network"
    }]
  });
});

test("relay is not an SSRF or lateral-movement pivot", () => {
  const session = attachedRelay({
    targets: [
      {
        targetId: "cluster-a",
        kind: "kubernetes-cluster",
        privateNetwork: "prod-a",
        endpoint: {
          host: "api.cluster-a.private",
          port: 6443,
          allowedResolvedIps: ["10.10.0.20"]
        },
        allowedResourceIds: ["cluster-a/control-plane"]
      },
      {
        targetId: "cluster-b",
        kind: "kubernetes-cluster",
        privateNetwork: "prod-b",
        endpoint: {
          host: "api.cluster-b.private",
          port: 6443
        },
        allowedResourceIds: ["cluster-b/control-plane"]
      },
      {
        targetId: "metadata-alias",
        kind: "kubernetes-cluster",
        privateNetwork: "prod-a",
        endpoint: {
          host: "api.metadata-alias.private",
          port: 443,
          allowedResolvedIps: ["169.254.169.254"]
        },
        allowedResourceIds: ["metadata-service"]
      },
      {
        targetId: "cluster-unscoped",
        kind: "kubernetes-cluster",
        privateNetwork: "prod-c",
        endpoint: {
          host: "api.cluster-unscoped.private",
          port: 6443,
          allowedResolvedIps: ["10.30.0.40"]
        }
      }
    ]
  }).session;

  assert.deepEqual(authorizeRelayConnection(session, {
    connectionId: "conn-ssrf-metadata",
    targetId: "cluster-a",
    destination: {
      host: "169.254.169.254",
      port: 80,
      resolvedIp: "169.254.169.254"
    }
  }), {
    ok: false,
    code: "relay.target.address-mismatch",
    reason: "target cluster-a may only connect to api.cluster-a.private:6443",
    audit: [{
      type: "relay.RequestDenied",
      relayId: "relay-private-network",
      targetId: "cluster-a",
      reason: "relay.target.address-mismatch"
    }]
  });

  assert.deepEqual(authorizeRelayConnection(session, {
    connectionId: "conn-rebind",
    targetId: "cluster-a",
    destination: {
      host: "api.cluster-a.private",
      port: 6443,
      resolvedIp: "10.99.0.99"
    }
  }), {
    ok: false,
    code: "relay.target.rebinding-denied",
    reason: "target cluster-a resolved to unregistered address 10.99.0.99",
    audit: [{
      type: "relay.RequestDenied",
      relayId: "relay-private-network",
      targetId: "cluster-a",
      reason: "relay.target.rebinding-denied"
    }]
  });

  assert.deepEqual(authorizeRelayConnection(session, {
    connectionId: "conn-metadata-alias",
    targetId: "metadata-alias",
    destination: {
      host: "api.metadata-alias.private",
      port: 443,
      resolvedIp: "169.254.169.254"
    }
  }), {
    ok: false,
    code: "relay.target.metadata-endpoint-denied",
    reason: "target metadata-alias resolves to a metadata endpoint",
    audit: [{
      type: "relay.RequestDenied",
      relayId: "relay-private-network",
      targetId: "metadata-alias",
      reason: "relay.target.metadata-endpoint-denied"
    }]
  });

  assert.deepEqual(authorizeRelayConnection(session, {
    connectionId: "conn-no-allowlist",
    targetId: "cluster-b",
    destination: {
      host: "api.cluster-b.private",
      port: 6443,
      resolvedIp: "10.20.0.30"
    }
  }), {
    ok: false,
    code: "relay.target.rebinding-denied",
    reason: "target cluster-b has no explicit resolved IP allowlist",
    audit: [{
      type: "relay.RequestDenied",
      relayId: "relay-private-network",
      targetId: "cluster-b",
      reason: "relay.target.rebinding-denied"
    }]
  });

  assert.deepEqual(authorizeRelayConnection(session, {
    connectionId: "conn-forward-proxy",
    destination: {
      host: "10.0.0.8",
      port: 8080,
      resolvedIp: "10.0.0.8"
    }
  }), {
    ok: false,
    code: "relay.forward-proxy.denied",
    reason: "relay requires a registered target id for every private-network connection",
    audit: [{
      type: "relay.RequestDenied",
      relayId: "relay-private-network",
      targetId: null,
      reason: "relay.forward-proxy.denied"
    }]
  });

  assert.deepEqual(dispatchRelayWork(session, {
    workId: "exec-unscoped",
    targetId: "cluster-unscoped",
    resourceId: "cluster-unscoped/control-plane",
    provider: "aws",
    credentialRef: "private-broker://cluster-unscoped/scoped-token/control-plane/apply",
    outputs: {}
  }), {
    ok: false,
    code: "relay.work.scope-missing",
    reason: "target cluster-unscoped has no registered resource scope",
    audit: [{
      type: "relay.RequestDenied",
      relayId: "relay-private-network",
      targetId: "cluster-unscoped",
      workId: "exec-unscoped",
      reason: "relay.work.scope-missing"
    }]
  });

  assert.deepEqual(dispatchRelayWork(session, {
    workId: "exec-metadata",
    targetId: "cluster-a",
    resourceId: "metadata-service",
    provider: "aws",
    credentialRef: "private-broker://cluster-a/scoped-token/metadata/read",
    outputs: {}
  }), {
    ok: false,
    code: "relay.work.out-of-scope",
    reason: "work exec-metadata targets resource metadata-service outside target cluster-a scope",
    audit: [{
      type: "relay.RequestDenied",
      relayId: "relay-private-network",
      targetId: "cluster-a",
      workId: "exec-metadata",
      reason: "relay.work.out-of-scope"
    }]
  });

  const authorized = authorizeRelayConnection(session, {
    connectionId: "conn-cluster-a",
    targetId: "cluster-a",
    destination: {
      host: "api.cluster-a.private",
      port: 6443,
      resolvedIp: "10.10.0.20"
    }
  });
  assert.equal(authorized.ok, true);
  assert.deepEqual(pipelineRelayConnect(authorized.connection, {
    connectionId: "conn-pipelined-metadata",
    targetId: "metadata-service",
    destination: {
      host: "169.254.169.254",
      port: 80,
      resolvedIp: "169.254.169.254"
    }
  }), {
    ok: false,
    code: "relay.connection.pipelining-denied",
    reason: "connection conn-cluster-a is scoped to target cluster-a and cannot open a second target",
    audit: [{
      type: "relay.RequestDenied",
      relayId: "relay-private-network",
      targetId: "cluster-a",
      attemptedTargetId: "metadata-service",
      reason: "relay.connection.pipelining-denied"
    }]
  });
});

function attachedRelay(overrides = {}) {
  const registration = registerRelay(relaySpec(overrides), policyAllow("hobo:relay:register"));
  assert.equal(registration.ok, true);
  const session = attachRelay(registration.relay, policyAllow("hobo:relay:attach"));
  assert.equal(session.ok, true);
  return session;
}

function relaySpec(overrides = {}) {
  return {
    relayId: "relay-private-network",
    tenant: "tenant-acme",
    transport: {
      direction: "relay-to-yard",
      protocol: "tcp",
      port: 443
    },
    inboundListeners: [],
    mtls: mtlsContract(),
    targets: [
      {
        targetId: "cluster-a",
        kind: "kubernetes-cluster",
        privateNetwork: "prod-a",
        allowedResourceIds: ["db"]
      },
      {
        targetId: "cluster-b",
        kind: "vm-pool",
        privateNetwork: "prod-b",
        allowedResourceIds: ["vm-pool"]
      }
    ],
    ...overrides
  };
}

function mtlsContract(overrides = {}) {
  return {
    schemaVersion: "hobo.mtls-data-path/v1",
    connectionId: "conn-yard-relay",
    tenant: "tenant-acme",
    trustDomain: "yard",
    sourceSvid: yardSvid,
    peerCertificate: cert(relaySvid),
    allowedPeers: [relaySvid],
    certMaterialRef: "identity://svid-cert/tenant-acme/hobo-yard/control-plane",
    authz: {
      bindEdgeId: "yard.control-plane->relay.private-relay",
      verbs: ["connect"]
    },
    now,
    ...overrides
  };
}

function cert(spiffeId, overrides = {}) {
  return {
    spiffeId,
    serialNumber: "stub-cert-relay",
    notBefore: "2026-06-28T11:55:00.000Z",
    notAfter: "2026-06-28T12:05:00.000Z",
    rotationEpoch: 1,
    ...overrides
  };
}

function policyAllow(action) {
  return { action, effect: "allow" };
}

function policyDeny(action) {
  return { action, effect: "deny" };
}
