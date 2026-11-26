import assert from "node:assert/strict";
import { test } from "vitest";

import { assertNoStaticCertificateSecret } from "../../acme-dns01-cert-issuance-contract/src/acme-dns01-cert-issuance.js";
import { createInMemoryDnsAdapter } from "../../hobo-dns-port-contract/src/dns-port.js";
import {
  createAirGapNetworkGuard,
  createInternalCaPrivateAcmeAuthority,
  createPrivateAcmeEndpoint,
  createPublicAcmeEndpoint,
  requestInternalCaPrivateAcmeCertificate,
  rotateInternalCaPrivateAcmeCertificate,
} from "../src/internal-ca-private-acme.js";

const PROFILE = Object.freeze({
  yard: "yard-sovereign",
  camp: "airgap-prod",
  boundary: "sovereign-boundary",
  egress: "none",
});

test("air-gapped Camp issues an internal-CA cert through private ACME with zero egress", async () => {
  const dnsAdapter = createInMemoryDnsAdapter({ id: "in-boundary-dns" });
  const network = createAirGapNetworkGuard({ boundary: PROFILE.boundary });
  const authority = createInternalCaPrivateAcmeAuthority({
    boundary: PROFILE.boundary,
    caName: "sovereign-ca",
    now: () => new Date("2026-06-28T06:00:00.000Z"),
  });
  const privateAcme = createPrivateAcmeEndpoint({
    boundary: PROFILE.boundary,
    dnsAdapter,
    network,
  });

  const result = await requestInternalCaPrivateAcmeCertificate({
    profile: PROFILE,
    domain: "shop.internal",
    subjectNames: ["shop.internal", "*.shop.internal"],
    dnsAdapter,
    authority,
    acme: privateAcme,
  });

  assert.equal(result.status, "issued");
  assert.equal(result.certificate.source, "internal-ca-private-acme");
  assert.match(result.certificate.certRef, /^cert:\/\/internal-ca\/sovereign-boundary\/shop-internal-/);
  assert.match(result.certificate.privateKeyRef, /^keyref:\/\/kms\/sovereign-boundary\/tls\//);
  assert.equal(result.certificate.caKeyRef, "keyref://kms/sovereign-boundary/ca/sovereign-ca");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["domain.ValidationStarted", "domain.Validated", "domain.CertIssued"],
  );
  assert.deepEqual(dnsAdapter.inspectLiveZone("shop.internal"), []);
  assert.deepEqual(network.snapshot().egressAttempts, []);
  assert.deepEqual(network.snapshot().internalCalls, ["private-acme://sovereign-boundary/sovereign-ca"]);

  const acmeEvidence = result.events
    .find((event) => event.type === "domain.Validated")
    .data.checks.find((check) => check.kind === "acme-challenge").evidence;
  assert.equal(acmeEvidence.source, "private-acme");
  assert.equal(acmeEvidence.boundary, PROFILE.boundary);

  assertNoStaticCertificateSecret(
    {
      certificate: result.certificate,
      events: result.events,
      shadowDns: dnsAdapter.inspectShadowZone("shop.internal"),
      network: network.snapshot(),
    },
    [authority.fixtureCaKeyMaterial],
  );
});

test("private ACME rotation stays in-boundary and emits domain.CertRotated before expiry", async () => {
  const dnsAdapter = createInMemoryDnsAdapter({ id: "rotation-dns" });
  const network = createAirGapNetworkGuard({ boundary: PROFILE.boundary });
  const authority = createInternalCaPrivateAcmeAuthority({
    boundary: PROFILE.boundary,
    caName: "sovereign-ca",
    now: () => new Date("2026-06-28T06:00:00.000Z"),
  });
  const privateAcme = createPrivateAcmeEndpoint({
    boundary: PROFILE.boundary,
    dnsAdapter,
    network,
  });

  const result = await rotateInternalCaPrivateAcmeCertificate({
    profile: PROFILE,
    domain: "shop.internal",
    dnsAdapter,
    authority,
    acme: privateAcme,
    renewBeforeDays: 30,
    existingCertificate: {
      certRef: "cert://internal-ca/sovereign-boundary/shop-internal-old",
      privateKeyRef: "keyref://kms/sovereign-boundary/tls/shop-internal-old",
      caKeyRef: "keyref://kms/sovereign-boundary/ca/sovereign-ca",
      source: "internal-ca-private-acme",
      subjectNames: ["shop.internal", "*.shop.internal"],
      issuedAt: "2026-04-01T00:00:00.000Z",
      expiresAt: "2026-07-10T00:00:00.000Z",
    },
  });

  assert.equal(result.status, "rotated");
  assert.equal(result.certificate.source, "internal-ca-private-acme");
  assert.equal(result.events.at(-1).type, "domain.CertRotated");
  assert.equal(result.events.at(-1).data.source, "internal-ca-private-acme");
  assert.equal(result.events.at(-1).data.oldCertRef, "cert://internal-ca/sovereign-boundary/shop-internal-old");
  assert.ok(new Date(result.events.at(-1).data.rotatedAt) < new Date("2026-07-10T00:00:00.000Z"));
  assert.deepEqual(network.snapshot().egressAttempts, []);
});

test("public ACME fallback is refused before any egress attempt", async () => {
  const dnsAdapter = createInMemoryDnsAdapter({ id: "public-fallback-dns" });
  const network = createAirGapNetworkGuard({ boundary: PROFILE.boundary });
  const authority = createInternalCaPrivateAcmeAuthority({
    boundary: PROFILE.boundary,
    caName: "sovereign-ca",
  });

  const result = await requestInternalCaPrivateAcmeCertificate({
    profile: PROFILE,
    domain: "shop.internal",
    subjectNames: ["shop.internal"],
    dnsAdapter,
    authority,
    acme: createPublicAcmeEndpoint({ network }),
  });

  assert.equal(result.status, "refused");
  assert.match(result.reason, /public ACME is forbidden/i);
  assert.equal(result.events.at(-1).type, "domain.CertIssuanceRefused");
  assert.equal(result.events.some((event) => event.type === "domain.CertIssued"), false);
  assert.deepEqual(network.snapshot().egressAttempts, []);
  assert.deepEqual(dnsAdapter.inspectShadowZone("shop.internal"), []);
  assert.deepEqual(dnsAdapter.inspectLiveZone("shop.internal"), []);
});

test("CA key refs must stay inside the Yard boundary", () => {
  assert.throws(
    () =>
      createInternalCaPrivateAcmeAuthority({
        boundary: PROFILE.boundary,
        caName: "sovereign-ca",
        caKeyRef: "keyref://kms/external-boundary/ca/sovereign-ca",
      }),
    /in-boundary KMS keyref/,
  );
});
