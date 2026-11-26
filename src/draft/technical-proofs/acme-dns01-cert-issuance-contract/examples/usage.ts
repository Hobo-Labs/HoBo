/**
 * Runnable example for acme-dns01-cert-issuance-contract. The draft-artifact gate
 * EXECUTES this with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Proves HOBO-144: DNS-01 issuance stages the challenge in SHADOW DNS only, emits a
 * secretless domain.CertIssued, and rotation renews before expiry (or reports not-due).
 * A fixed clock and fixture CA keep every ref/token deterministic.
 */
import { strict as assert } from "node:assert";

import { createInMemoryDnsAdapter } from "../../hobo-dns-port-contract/src/dns-port.js";
import {
	assertNoStaticCertificateSecret,
	createFixtureAcmeDns01Endpoint,
	createFixtureIdentityCertificateAuthority,
	requestAcmeDns01Certificate,
	rotateAcmeDns01Certificate,
} from "../src/acme-dns01-cert-issuance.ts";

const NOW = () => new Date("2026-06-27T16:00:00.000Z");

// 1) Issue a wildcard cert for shop.com across two camps via DNS-01.
const events: Array<{ type: string }> = [];
const dnsAdapter = createInMemoryDnsAdapter({ id: "dns-shadow" });
const identity = createFixtureIdentityCertificateAuthority({
	issuer: "identity://yard-prod",
	now: NOW,
});
const acme = createFixtureAcmeDns01Endpoint({ dnsAdapter });

const issued = await requestAcmeDns01Certificate({
	domain: "shop.com",
	camp: "prod-us",
	camps: ["prod-us", "prod-eu"],
	subjectNames: ["shop.com", "*.shop.com"],
	dnsAdapter,
	identity,
	acme,
	eventSink: (event: { type: string }) => events.push(event),
});

assert.equal(issued.status, "issued");
assert.equal(issued.certificate.source, "identity-acme-dns01");
console.log(`issued: status=${issued.status} source=${issued.certificate.source}`);
console.log(`certRef: ${issued.certificate.certRef}`);
console.log(`subjectNames: ${issued.certificate.subjectNames.join(",")}`);
console.log(`event types: ${issued.events.map((event: { type: string }) => event.type).join(" -> ")}`);

// 2) The challenge lives ONLY in the shadow zone; the live zone is untouched.
const shadow = dnsAdapter.inspectShadowZone("shop.com");
assert.equal(dnsAdapter.inspectLiveZone("shop.com").length, 0);
assert.equal(shadow.length, 1);
assert.equal(shadow[0].name, "_acme-challenge.shop.com");
assert.equal(shadow[0].type, "TXT");
assert.deepEqual(
	shadow[0].targets.map((target: { camp: string }) => target.camp),
	["prod-us", "prod-eu"],
);
console.log(`shadow zone: ${shadow[0].name} ${shadow[0].type} camps=${shadow[0].targets.length} liveZone=empty`);

// 3) No static private-key material leaks into any surface.
assertNoStaticCertificateSecret(
	{
		certificate: issued.certificate,
		events,
		shadowDns: shadow,
		liveDns: dnsAdapter.inspectLiveZone("shop.com"),
	},
	[identity.fixturePrivateKeyMaterial],
);
assert.equal("privateKeyPem" in issued.certificate, false);
assert.ok(issued.certificate.privateKeyRef.startsWith("keyref://identity/"));
console.log("secret check: no static key material on any surface (privateKeyRef only)");

// 4) Rotation inside the renewal window issues a new cert and links old -> new.
const existingCertificate = {
	certRef: "cert://identity/shop-com-old",
	privateKeyRef: "keyref://identity/shop-com-old",
	source: "identity-acme-dns01",
	subjectNames: ["shop.com", "*.shop.com"],
	issuedAt: "2026-04-01T00:00:00.000Z",
	expiresAt: "2026-07-10T00:00:00.000Z", // 12.7 days out < 30-day window
};
const rotationDns = createInMemoryDnsAdapter({ id: "dns-rotate" });
const rotated = await rotateAcmeDns01Certificate({
	domain: "shop.com",
	camp: "prod-us",
	existingCertificate,
	renewBeforeDays: 30,
	dnsAdapter: rotationDns,
	identity,
	acme: createFixtureAcmeDns01Endpoint({ dnsAdapter: rotationDns }),
});
assert.equal(rotated.status, "rotated");
assert.notEqual(rotated.certificate.certRef, existingCertificate.certRef);
const rotatedEvent = rotated.events.at(-1);
assert.equal(rotatedEvent.type, "domain.CertRotated");
assert.equal(rotatedEvent.data.oldCertRef, existingCertificate.certRef);
assert.equal(rotatedEvent.data.newCertRef, rotated.certificate.certRef);
console.log(`rotation: status=${rotated.status} event=${rotatedEvent.type}`);
console.log(`rotation refs: old=${rotatedEvent.data.oldCertRef} new=${rotatedEvent.data.newCertRef}`);

// 5) A cert far from expiry is not renewed.
const notDue = await rotateAcmeDns01Certificate({
	domain: "shop.com",
	camp: "prod-us",
	existingCertificate: { ...existingCertificate, expiresAt: "2026-12-01T00:00:00.000Z" },
	renewBeforeDays: 30,
	dnsAdapter,
	identity,
	acme,
	now: NOW,
});
assert.equal(notDue.status, "not-due");
assert.equal(notDue.events.length, 0);
console.log(`rotation (far from expiry): status=${notDue.status} events=${notDue.events.length}`);

console.log("CONTRACT HELD: shadow-staged DNS-01, secretless events, windowed rotation");
