/**
 * Runnable example for s3-02-hobo-identity (HOBO-628). The draft-artifact gate EXECUTES
 * this with `node --import tsx` and diffs stdout against usage.expected.txt — keep both
 * honest. Real RSA keys are generated per run, so tokens are asserted, never printed.
 *
 * Demonstrates the real @hobo/identity draft contract: attestation-gated JWT-SVID
 * issuance bound to the MEASURED tenant (not caller claims), gateway verification via
 * JWKS, key-rotating renewal inside the grace window with the old token still valid,
 * and fail-closed denials (tampered signature, expired measurement, scope widening)
 * that mint no SVID and no audit event.
 */
import { strict as assert } from "node:assert";

import { createFixtureHostAttestor, IdentityService } from "../src/index.ts";
import { type JsonObject } from "../src/json.js";


const ISSUER_URL = "https://identity.yard.example";
const NOW = "2026-06-25T15:00:00.000Z";
const IMAGE_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CODE_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SCOPE = { port: "database", resource: "shop.db", verbs: ["write"] } as const;

function launchMeasurement(overrides: JsonObject = {}) {
	return {
		runId: "run-20260625-identity-628",
		tenant: "tenant-a",
		parentPrincipal: { kind: "user", id: "user:platform-admin" },
		codeVersion: { digest: CODE_DIGEST, version: "git:628-identity" },
		componentImageDigest: IMAGE_DIGEST,
		hostId: "host-firecracker-1",
		issuedAt: "2026-06-25T14:59:30.000Z",
		expiresAt: "2026-06-25T15:01:00.000Z",
		nonce: "nonce-hobo-628",
		isolationTier: "firecracker-microvm",
		...overrides,
	};
}

const attestor = createFixtureHostAttestor({ hostId: "host-firecracker-1" });
const hostPublicKeys = attestor.publicKeys();
const document = attestor.createDocument({
	launchMeasurement: launchMeasurement(),
	// The caller claims a DIFFERENT tenant — issuance must bind the measured one.
	claimed: { tenant: "tenant-evil" },
});

const service = new IdentityService({
	issuerUrl: ISSUER_URL,
	genesisKeyId: "yard-genesis-2026-07",
	ttlSeconds: 900,
	renewalGraceSeconds: 300,
});
console.log(`discovery: issuer=${service.discovery().issuer} jwks_keys=${service.jwks().keys.length}`);

// 1) Attested workload -> JWT-SVID bound to the measured tenant, plus identity.Issued.
const issued = await service.issueSvidFromAttestation({
	attestationDocument: document,
	requestedScope: SCOPE,
	audience: "hobo-gateway",
	agentName: "deployer",
	hostPublicKeys,
	knownImageDigests: [IMAGE_DIGEST],
	now: NOW,
});
assert.equal(issued.status, "issued");
if (issued.status !== "issued") throw new Error("unreachable");
assert.equal(issued.svid.subject, "spiffe://yard/tenant-a/agent/deployer", "measured tenant wins over claimed");
// SAFETY: `assert.match(issued.events[0]?.data.svidRef as string, /^tokenref:\/\/identity\/` is required at this I/O or test boundary.
assert.match(issued.events[0]?.data.svidRef as string, /^tokenref:\/\/identity\/svid\//);
console.log(`issued: subject=${issued.svid.subject} event=${issued.events[0]?.type} expiresAt=${issued.svid.expiresAt}`);
console.log("tenant binding: measured tenant-a beats claimed tenant-evil");

// 2) The gateway authenticates the token against the issuer's JWKS.
const gateway = await service.authenticateAtGateway({ token: issued.token, audience: "hobo-gateway", now: NOW });
assert.equal(gateway.status, "authenticated");
if (gateway.status !== "authenticated") throw new Error("unreachable");
console.log(`gateway: status=${gateway.status} tenant=${gateway.tenant} scope=${gateway.scope.map((s) => `${s.port}/${s.resource}:${s.verbs.join("+")}`).join(",")}`);

// 3) Rotation inside the renewal grace window rotates the signing key; the old token still verifies.
const rotateAt = "2026-06-25T15:14:30.000Z";
const rotated = await service.rotateSvid({
	identityId: issued.svid.identityId,
	now: rotateAt,
	nextKeyId: "yard-rollover-2026-07",
});
assert.equal(rotated.status, "rotated");
if (rotated.status !== "rotated") throw new Error("unreachable");
const oldStillValid = await service.authenticateAtGateway({ token: issued.token, audience: "hobo-gateway", now: rotateAt });
const newValid = await service.authenticateAtGateway({ token: rotated.token, audience: "hobo-gateway", now: rotateAt });
assert.equal(oldStillValid.status, "authenticated");
assert.equal(newValid.status, "authenticated");
console.log(`rotated: event=${rotated.events[0]?.type} newKid=${rotated.svid.signerKid} oldTokenStillValid=${oldStillValid.status === "authenticated"}`);

// 4) Too-early rotation is denied — renewal is grace-window-gated.
const early = await service.rotateSvid({ identityId: rotated.svid.identityId, now: "2026-06-25T15:15:00.000Z" });
assert.equal(early.status, "denied");
if (early.status !== "denied") throw new Error("unreachable");
console.log(`early rotation denied: ${early.reason}`);

// 5) Scope widening during rotation is denied.
const widened = await service.rotateSvidWithScope({
	identityId: rotated.svid.identityId,
	requestedScope: { port: "database", resource: "shop.db", verbs: ["write", "delete"] },
	now: "2026-06-25T15:28:45.000Z",
});
assert.equal(widened.status, "denied");
if (widened.status !== "denied") throw new Error("unreachable");
console.log(`scope widening denied: ${widened.reason}`);

// 6) Tampered and expired attestations are denied WITHOUT minting SVIDs or audit events.
const before = service.getAuditEvents().length;
const tampered = await service.issueSvidFromAttestation({
	attestationDocument: { ...document, hostSignature: { ...document.hostSignature, value: "00".repeat(32) } },
	requestedScope: SCOPE,
	audience: "hobo-gateway",
	agentName: "deployer",
	hostPublicKeys,
	knownImageDigests: [IMAGE_DIGEST],
	now: NOW,
});
assert.equal(tampered.status, "denied");
if (tampered.status !== "denied") throw new Error("unreachable");
const expired = await service.issueSvidFromAttestation({
	attestationDocument: attestor.createDocument({
		launchMeasurement: launchMeasurement({
			issuedAt: "2026-06-25T14:50:00.000Z",
			expiresAt: "2026-06-25T14:59:00.000Z",
		}),
		claimed: { tenant: "tenant-a" },
	}),
	requestedScope: SCOPE,
	audience: "hobo-gateway",
	agentName: "deployer",
	hostPublicKeys,
	knownImageDigests: [IMAGE_DIGEST],
	now: NOW,
});
assert.equal(expired.status, "denied");
if (expired.status !== "denied") throw new Error("unreachable");
assert.equal(service.getAuditEvents().length, before, "denials leave no audit events");
console.log(`tampered attestation denied: ${tampered.reason}`);
console.log(`expired attestation denied: ${expired.reason}`);
console.log(`audit log: events=${service.getAuditEvents().map((event) => event.type).join(",")}`);

console.log("CONTRACT HELD: identity issues attestation-bound, scope-frozen, rotatable JWT-SVIDs and fails closed");
