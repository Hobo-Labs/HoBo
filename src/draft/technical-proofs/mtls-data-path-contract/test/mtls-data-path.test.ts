import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  MTLS_DATA_PATH_SCHEMA_VERSION,
  evaluateMtlsHandshake,
  parseWorkloadSpiffeId,
  validateMtlsDataPathContract
} from "../src/mtls-data-path.js";

const now = "2026-06-28T12:00:00.000Z";
const api = "spiffe://yard/tenant-acme/shop/api";
const db = "spiffe://yard/tenant-acme/shop/db";
const tenantApi = "spiffe://tenant-acme/shop/api";
const tenantDb = "spiffe://tenant-acme/shop/db";

test("schema artifact parses and pins the consume-only mTLS data-path contract", () => {
  const schema = JSON.parse(readFileSync(new URL("../schema/hobo.mtls-data-path.v1.schema.json", import.meta.url), "utf8"));

  assert.equal(schema.$id, "https://hobo.dev/schemas/hobo.mtls-data-path.v1.schema.json");
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "connectionId",
    "tenant",
    "trustDomain",
    "sourceSvid",
    "peerCertificate",
    "allowedPeers",
    "certMaterialRef",
    "authz"
  ]);
  assert.equal(schema.properties.certMaterialRef.pattern, "^identity://");
  assert.equal(schema.properties.now.format, "date-time");
});

test("workload SPIFFE IDs parse as tenant-scoped service identities", () => {
  assert.deepEqual(parseWorkloadSpiffeId(db), {
    trustDomain: "yard",
    tenant: "tenant-acme",
    bindle: "shop",
    resource: "db"
  });
  assert.deepEqual(parseWorkloadSpiffeId(tenantDb), {
    trustDomain: "tenant-acme",
    tenant: "tenant-acme",
    bindle: "shop",
    resource: "db"
  });
  assert.throws(
    () => parseWorkloadSpiffeId("spiffe://tenant-acme/tenant-beta/shop/db"),
    /reserved for the yard trust-domain/
  );
});

test("two stub SVIDs establish an allowed mTLS data-path handshake", () => {
  const decision = evaluateMtlsHandshake(contract());

  assert.equal(decision.ok, true);
  assert.deepEqual(decision.peer, {
    trustDomain: "yard",
    tenant: "tenant-acme",
    bindle: "shop",
    resource: "db"
  });
  assert.equal(decision.authz.bindEdgeId, "shop.api->shop.db");
  assert.equal(decision.certMaterialRef, "identity://svid-cert/tenant-acme/shop/api");
});

test("tenant trust-domain form establishes the same bounded handshake", () => {
  const decision = evaluateMtlsHandshake(contract({
    trustDomain: "tenant-acme",
    sourceSvid: tenantApi,
    peerCertificate: cert(tenantDb),
    allowedPeers: [tenantDb]
  }));

  assert.equal(decision.ok, true);
  assert.deepEqual(decision.peer, {
    trustDomain: "tenant-acme",
    tenant: "tenant-acme",
    bindle: "shop",
    resource: "db"
  });
});

test("peer SVID outside the bind-derived allow-list is rejected", () => {
  const decision = evaluateMtlsHandshake(contract({
    peerCertificate: cert("spiffe://yard/tenant-acme/shop/payments"),
    allowedPeers: [db]
  }));

  assert.deepEqual(decision, {
    ok: false,
    code: "mtls.peer.not-allowed",
    reason: "peer spiffe://yard/tenant-acme/shop/payments is not in the bind-derived allow-list"
  });
});

test("valid cert from another tenant is denied by construction", () => {
  const decision = evaluateMtlsHandshake(contract({
    peerCertificate: cert("spiffe://yard/tenant-beta/shop/db"),
    allowedPeers: ["spiffe://yard/tenant-beta/shop/db"]
  }));

  assert.deepEqual(decision, {
    ok: false,
    code: "mtls.peer.tenant-mismatch",
    reason: "peer tenant tenant-beta does not match connection tenant tenant-acme"
  });
});

test("expired SVID fails closed before allow-list authorization", () => {
  const decision = evaluateMtlsHandshake(contract({
    peerCertificate: cert(db, {
      notAfter: "2026-06-28T11:59:59.000Z"
    })
  }));

  assert.deepEqual(decision, {
    ok: false,
    code: "mtls.peer.svid-expired",
    reason: "peer SVID is expired or not yet valid"
  });
});

test("rotated stale peer SVID epoch fails closed", () => {
  const decision = evaluateMtlsHandshake(contract({
    minimumPeerRotationEpoch: 3,
    peerCertificate: cert(db, { rotationEpoch: 2 })
  }));

  assert.deepEqual(decision, {
    ok: false,
    code: "mtls.peer.svid-rotated",
    reason: "peer SVID rotation epoch 2 is older than required epoch 3"
  });
});

test("malformed evaluation timestamp fails closed", () => {
  const decision = evaluateMtlsHandshake(contract({
    now: "not-a-date"
  }));

  assert.deepEqual(decision, {
    ok: false,
    code: "mtls.clock.invalid",
    reason: "now must be an ISO-8601 timestamp when provided"
  });
});

test("contract rejects embedded issuing material and requires an Identity reference", () => {
  assert.deepEqual(validateMtlsDataPathContract({
    ...contract(),
    certMaterialRef: "-----BEGIN PRIVATE KEY-----"
  }), {
    ok: false,
    code: "mtls.cert-material.invalid",
    reason: "certMaterialRef must be an identity:// reference"
  });

  assert.deepEqual(validateMtlsDataPathContract({
    ...contract(),
    privateKeyPem: "-----BEGIN PRIVATE KEY-----"
  }), {
    ok: false,
    code: "mtls.contract.scope-out",
    reason: "contract consumes Identity cert material and must not carry issuing/private key material"
  });
});

function contract(overrides = {}) {
  return {
    schemaVersion: MTLS_DATA_PATH_SCHEMA_VERSION,
    connectionId: "conn-shop-api-db",
    tenant: "tenant-acme",
    trustDomain: "yard",
    sourceSvid: api,
    peerCertificate: cert(db),
    allowedPeers: [db],
    certMaterialRef: "identity://svid-cert/tenant-acme/shop/api",
    minimumPeerRotationEpoch: 1,
    authz: {
      bindEdgeId: "shop.api->shop.db",
      verbs: ["connect"]
    },
    now,
    ...overrides
  };
}

function cert(spiffeId, overrides = {}) {
  return {
    spiffeId,
    serialNumber: "stub-cert-001",
    notBefore: "2026-06-28T11:55:00.000Z",
    notAfter: "2026-06-28T12:05:00.000Z",
    rotationEpoch: 1,
    ...overrides
  };
}
