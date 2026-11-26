import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createX509SvidAuthority,
  establishMutualTls,
  rotateX509Svid,
  tamperSvidSan,
} from "../src/x509-svid-mtls.js";

const baseTime = Date.parse("2026-06-26T08:00:00.000Z");

const api = {
  tenant: "acme",
  bindle: "orders",
  resource: "api",
  attestation: {
    tenant: "acme",
    bindle: "orders",
    resource: "api",
    measurement: "sha256:" + "a".repeat(64),
  },
};

const worker = {
  tenant: "acme",
  bindle: "orders",
  resource: "worker",
  attestation: {
    tenant: "acme",
    bindle: "orders",
    resource: "worker",
    measurement: "sha256:" + "b".repeat(64),
  },
};

test("fixture services establish mTLS with SPIFFE ID in the X.509 SAN", () => {
  const authority = createX509SvidAuthority({
    trustDomain: "yard",
    ttlSeconds: 120,
    rotateBeforeSeconds: 30,
    now: baseTime,
  });

  const apiSvid = authority.issueWorkloadSvid(api);
  const workerSvid = authority.issueWorkloadSvid(worker);
  const connection = establishMutualTls({
    client: workerSvid,
    server: apiSvid,
    trustBundle: authority.trustBundle(),
    now: baseTime + 1_000,
  });

  assert.equal(connection.ok, true);
  assert.equal(connection.clientSpiffeId, "spiffe://yard/acme/orders/worker");
  assert.equal(connection.serverSpiffeId, "spiffe://yard/acme/orders/api");
  assert.deepEqual(apiSvid.certificate.x509.subjectAltName.uris, [
    "spiffe://yard/acme/orders/api",
  ]);
  assert.equal(apiSvid.delivery.channel, "identity.workload-svid");
  assert.equal(Object.hasOwn(apiSvid, "privateKey"), false);
  assert.equal(apiSvid.events[0].type, "identity.Issued");
});

test("copied SVID certificate without the workload private key cannot authenticate", () => {
  const authority = createX509SvidAuthority({
    trustDomain: "yard",
    ttlSeconds: 120,
    now: baseTime,
  });

  const apiSvid = authority.issueWorkloadSvid(api);
  const copiedApiSvid = JSON.parse(JSON.stringify(apiSvid));
  const workerSvid = authority.issueWorkloadSvid(worker);

  assert.throws(
    () =>
      establishMutualTls({
        client: workerSvid,
        server: copiedApiSvid,
        trustBundle: authority.trustBundle(),
        now: baseTime + 1_000,
      }),
    /private key proof required/,
  );
});

test("certificates rotate within TTL without dropping an established mTLS session", () => {
  const authority = createX509SvidAuthority({
    trustDomain: "yard",
    ttlSeconds: 100,
    rotateBeforeSeconds: 40,
    overlapSeconds: 25,
    now: baseTime,
  });

  const apiSvid = authority.issueWorkloadSvid(api);
  const workerSvid = authority.issueWorkloadSvid(worker);
  const session = establishMutualTls({
    client: workerSvid,
    server: apiSvid,
    trustBundle: authority.trustBundle(),
    now: baseTime + 1_000,
  });

  const refreshed = establishMutualTls({
    client: workerSvid,
    server: apiSvid,
    trustBundle: authority.trustBundle(),
    now: baseTime + 65_000,
    autoRotate: {
      authority,
      attestations: {
        server: api.attestation,
      },
    },
  });
  const rotation = refreshed.rotations.server;

  assert.equal(rotation.rotated, true);
  assert.equal(rotation.gapFree, true);
  assert.equal(rotation.previousAcceptedUntil >= rotation.next.certificate.notBefore, true);
  assert.equal(rotation.events[0].type, "identity.Rotated");
  assert.equal(session.remainsEstablishedAfter(rotation).ok, true);
  assert.equal(refreshed.serverSvidRef, rotation.next.svidRef);
  assert.equal(refreshed.ok, true);
});

test("service presenting another tenant trust-domain certificate is rejected", () => {
  const acmeAuthority = createX509SvidAuthority({
    trustDomain: "yard",
    ttlSeconds: 120,
    now: baseTime,
  });
  const betaAuthority = createX509SvidAuthority({
    trustDomain: "foreign-yard",
    ttlSeconds: 120,
    now: baseTime,
  });

  const apiSvid = acmeAuthority.issueWorkloadSvid(api);
  const betaClient = betaAuthority.issueWorkloadSvid({
    tenant: "beta",
    bindle: "orders",
    resource: "worker",
    attestation: {
      tenant: "beta",
      bindle: "orders",
      resource: "worker",
      measurement: "sha256:" + "c".repeat(64),
    },
  });

  assert.throws(
    () =>
      establishMutualTls({
        client: betaClient,
        server: apiSvid,
        trustBundle: acmeAuthority.trustBundle({ tenant: "acme" }),
        expectedTenant: "acme",
        now: baseTime + 1_000,
      }),
    /SPIFFE ID trust-domain mismatch/,
  );
});

test("air-gap mode issues via internal CA without phone-home", () => {
  const authority = createX509SvidAuthority({
    trustDomain: "yard",
    mode: "airgap",
    ttlSeconds: 120,
    now: baseTime,
  });

  const apiSvid = authority.issueWorkloadSvid(api);

  assert.equal(authority.profile().caPath, "internal-ca/private-acme");
  assert.equal(authority.profile().phoneHomeRequired, false);
  assert.equal(apiSvid.certificate.issuer.caPath, "internal-ca/private-acme");
  assert.equal(apiSvid.events[0].data.caPath, "internal-ca/private-acme");
});

test("workloads cannot request SPIFFE IDs outside their tenant trust domain", () => {
  const authority = createX509SvidAuthority({
    trustDomain: "yard",
    ttlSeconds: 120,
    now: baseTime,
  });

  assert.throws(
    () =>
      authority.issueWorkloadSvid({
        ...api,
        requestedSpiffeId: "spiffe://yard/beta/orders/api",
      }),
    /outside tenant trust domain/,
  );
});

test("certificate past rotation window stops authenticating", () => {
  const authority = createX509SvidAuthority({
    trustDomain: "yard",
    ttlSeconds: 100,
    rotateBeforeSeconds: 20,
    overlapSeconds: 10,
    now: baseTime,
  });

  const apiSvid = authority.issueWorkloadSvid(api);
  const workerSvid = authority.issueWorkloadSvid(worker);
  const rotation = rotateX509Svid({
    authority,
    current: apiSvid,
    attestation: api.attestation,
    now: baseTime + 85_000,
  });

  assert.throws(
    () =>
      establishMutualTls({
        client: workerSvid,
        server: apiSvid,
        trustBundle: authority.trustBundle(),
        now: rotation.previousAcceptedUntil + 1,
      }),
    /certificate past rotation window/,
  );
});

test("spoofed SAN not signed by the SVID CA is rejected", () => {
  const authority = createX509SvidAuthority({
    trustDomain: "yard",
    ttlSeconds: 120,
    now: baseTime,
  });

  const apiSvid = authority.issueWorkloadSvid(api);
  const workerSvid = authority.issueWorkloadSvid(worker);
  const spoofed = tamperSvidSan(apiSvid, "spiffe://yard/acme/orders/admin");

  assert.throws(
    () =>
      establishMutualTls({
        client: workerSvid,
        server: spoofed,
        trustBundle: authority.trustBundle(),
        now: baseTime + 1_000,
      }),
    /SVID-CA signature verification failed/,
  );
});
