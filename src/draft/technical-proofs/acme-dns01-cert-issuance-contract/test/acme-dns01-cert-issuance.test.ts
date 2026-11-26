import assert from "node:assert/strict";
import { test } from "vitest";

import { createInMemoryDnsAdapter } from "../../hobo-dns-port-contract/src/dns-port.js";
import {
  evaluateObligationGate,
  replayObligationEvents,
} from "../../obligation-engine-contract/src/obligation-engine.js";
import {
  assertNoStaticCertificateSecret,
  createFixtureAcmeDns01Endpoint,
  createFixtureIdentityCertificateAuthority,
  createProviderManagedCertAdapter,
  requestAcmeDns01Certificate,
  requestProviderManagedCertificate,
  rotateAcmeDns01Certificate,
} from "../src/acme-dns01-cert-issuance.js";

test("DNS-01 issuance stages the challenge in shadow DNS and emits a secretless domain.CertIssued", async () => {
  const events = [];
  const dnsAdapter = createInMemoryDnsAdapter({ id: "dns-shadow" });
  const identity = createFixtureIdentityCertificateAuthority({
    issuer: "identity://yard-prod",
    now: () => new Date("2026-06-27T16:00:00.000Z"),
  });
  const acme = createFixtureAcmeDns01Endpoint({ dnsAdapter });

  const result = await requestAcmeDns01Certificate({
    domain: "shop.com",
    camp: "prod-us",
    camps: ["prod-us", "prod-eu"],
    subjectNames: ["shop.com", "*.shop.com"],
    dnsAdapter,
    identity,
    acme,
    eventSink: (event) => events.push(event),
  });

  assert.equal(result.status, "issued");
  assert.equal(result.certificate.source, "identity-acme-dns01");
  assert.deepEqual(result.certificate.subjectNames, ["*.shop.com", "shop.com"]);
  assert.match(result.certificate.certRef, /^cert:\/\/identity\/shop-com-/);
  assert.equal(result.certificate.privateKeyRef.startsWith("keyref://identity/"), true);
  assert.equal("privateKeyPem" in result.certificate, false);
  assert.deepEqual(result.order.camps, ["prod-us", "prod-eu"]);
  assert.deepEqual(result.events.at(-1).data.camps, ["prod-us", "prod-eu"]);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["domain.ValidationStarted", "domain.Validated", "domain.CertIssued"],
  );
  assert.deepEqual(dnsAdapter.inspectLiveZone("shop.com"), []);
  assert.deepEqual(dnsAdapter.inspectShadowZone("shop.com"), [
    {
      name: "_acme-challenge.shop.com",
      type: "TXT",
      ttl: 60,
      targets: [
        { camp: "prod-us", value: result.order.challenge.token },
        { camp: "prod-eu", value: result.order.challenge.token },
      ],
      policy: {
        kind: "failover",
        targets: [
          { camp: "prod-us", priority: 1 },
          { camp: "prod-eu", priority: 2 },
        ],
      },
      campOverrides: [
        {
          camp: "prod-us",
          targets: [{ camp: "prod-us", value: result.order.challenge.token }],
        },
        {
          camp: "prod-eu",
          targets: [{ camp: "prod-eu", value: result.order.challenge.token }],
        },
      ],
    },
  ]);

  assertNoStaticCertificateSecret(
    {
      certificate: result.certificate,
      events,
      shadowDns: dnsAdapter.inspectShadowZone("shop.com"),
      liveDns: dnsAdapter.inspectLiveZone("shop.com"),
    },
    [identity.fixturePrivateKeyMaterial],
  );
});

test("rotation renews before expiry and emits domain.CertRotated with old and new cert refs", async () => {
  const dnsAdapter = createInMemoryDnsAdapter({ id: "dns-rotation" });
  const identity = createFixtureIdentityCertificateAuthority({
    issuer: "identity://yard-prod",
    now: () => new Date("2026-06-27T16:00:00.000Z"),
  });
  const acme = createFixtureAcmeDns01Endpoint({ dnsAdapter });
  const existingCertificate = {
    certRef: "cert://identity/shop-com-old",
    privateKeyRef: "keyref://identity/shop-com-old",
    source: "identity-acme-dns01",
    subjectNames: ["api.shop.com", "shop.com", "*.shop.com"],
    issuedAt: "2026-04-01T00:00:00.000Z",
    expiresAt: "2026-07-10T00:00:00.000Z",
  };

  const result = await rotateAcmeDns01Certificate({
    domain: "shop.com",
    camp: "prod-us",
    existingCertificate,
    renewBeforeDays: 30,
    dnsAdapter,
    identity,
    acme,
  });

  assert.equal(result.status, "rotated");
  assert.deepEqual(result.certificate.subjectNames, ["*.shop.com", "api.shop.com", "shop.com"]);
  assert.notEqual(result.certificate.certRef, existingCertificate.certRef);
  assert.equal(result.events.at(-1).type, "domain.CertRotated");
  assert.equal(result.events.at(-1).data.oldCertRef, existingCertificate.certRef);
  assert.equal(result.events.at(-1).data.newCertRef, result.certificate.certRef);
  assert.ok(new Date(result.events.at(-1).data.rotatedAt) < new Date(existingCertificate.expiresAt));
});

test("failed renewal raises an obligation and never emits a silent successful rotation", async () => {
  const dnsAdapter = createInMemoryDnsAdapter({ id: "dns-renewal-failure" });
  const identity = createFixtureIdentityCertificateAuthority({
    issuer: "identity://yard-prod",
    now: () => new Date("2026-06-27T16:00:00.000Z"),
    failFinalize: "ACME CA unavailable",
  });
  const acme = createFixtureAcmeDns01Endpoint({ dnsAdapter });

  const result = await rotateAcmeDns01Certificate({
    domain: "shop.com",
    camp: "prod-us",
    existingCertificate: {
      certRef: "cert://identity/shop-com-old",
      privateKeyRef: "keyref://identity/shop-com-old",
      source: "identity-acme-dns01",
      subjectNames: ["shop.com", "*.shop.com"],
      issuedAt: "2026-04-01T00:00:00.000Z",
      expiresAt: "2026-07-10T00:00:00.000Z",
    },
    renewBeforeDays: 30,
    dnsAdapter,
    identity,
    acme,
  });

  assert.equal(result.status, "escalated");
  assert.deepEqual(
    result.events.map((event) => event.type).slice(-2),
    ["domain.CertRenewalFailed", "policy.ObligationCreated"],
  );
  assert.equal(result.events.some((event) => event.type === "domain.CertRotated"), false);
  const obligationEvent = result.events.at(-1);
  assert.equal(obligationEvent.obligationId, obligationEvent.data.obligation.id);
  assert.match(obligationEvent.data.obligation.metadata.reason, /ACME CA unavailable/);
  assert.ok(new Date(obligationEvent.data.obligation.deadline) < new Date(result.existingCertificate.expiresAt));

  const replay = replayObligationEvents([obligationEvent]);
  assert.equal(replay.ignoredEvents.length, 0);
  assert.equal(replay.obligations[0].kind, "certificate-renewal");
  assert.equal(replay.obligations[0].status, "pending");
  assert.equal(evaluateObligationGate([obligationEvent]).blocked, true);
});

test("challenge records that touch the live zone fail closed before certificate issuance", async () => {
  const dnsAdapter = createInMemoryDnsAdapter({
    id: "lying-dns",
    shadowWritesAlsoTouchLive: true,
  });
  const result = await requestAcmeDns01Certificate({
    domain: "shop.com",
    camp: "prod-us",
    subjectNames: ["shop.com"],
    dnsAdapter,
    identity: createFixtureIdentityCertificateAuthority(),
    acme: createFixtureAcmeDns01Endpoint({ dnsAdapter }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.events.at(-1).type, "domain.ValidationFailed");
  assert.equal(result.events.some((event) => event.type === "domain.CertIssued"), false);
  assert.match(result.reason, /live zone changed during shadow write/i);
});

test("provider-managed cert adapter is an opt-in per-Camp seam with no static key material", async () => {
  const adapter = createProviderManagedCertAdapter({
    provider: "aws-acm",
    now: () => new Date("2026-06-27T16:00:00.000Z"),
  });

  const us = await requestProviderManagedCertificate({
    domain: "shop.com",
    camp: "prod-us",
    subjectNames: ["shop.com", "*.shop.com"],
    adapter,
  });
  const eu = await requestProviderManagedCertificate({
    domain: "shop.com",
    camp: "prod-eu",
    subjectNames: ["shop.com", "*.shop.com"],
    adapter,
  });

  assert.equal(us.status, "issued");
  assert.equal(eu.status, "issued");
  assert.equal(us.certificate.source, "provider-managed");
  assert.equal(eu.certificate.source, "provider-managed");
  assert.notEqual(us.certificate.certRef, eu.certificate.certRef);
  assert.match(us.certificate.certRef, /^cert:\/\/provider\/aws-acm\/shop-com-/);
  assert.equal(us.events.at(-1).type, "domain.CertIssued");
  assert.equal(eu.events.at(-1).type, "domain.CertIssued");
  assert.deepEqual(adapter.requests, [
    {
      domain: "shop.com",
      camp: "prod-us",
      subjectNames: ["*.shop.com", "shop.com"],
    },
    {
      domain: "shop.com",
      camp: "prod-eu",
      subjectNames: ["*.shop.com", "shop.com"],
    },
  ]);
  assert.equal("privateKeyPem" in us.certificate, false);
  assert.equal("privateKeyPem" in eu.certificate, false);
  assertNoStaticCertificateSecret({ usCertificate: us.certificate, euCertificate: eu.certificate, events: [...us.events, ...eu.events] }, [
    "-----BEGIN PRIVATE KEY-----",
  ]);
});
