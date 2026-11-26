import {
	createInMemoryKms,
	type JwtSvidClaims,
	JwtSvidIssuer,
} from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	BUNDLE_MANIFEST_SCHEMA,
	type BundleManifest,
	bundleManifestDigest,
	ingestBundleManifest,
	parseProvenanceStatement,
	type SignatureVerifier,
	verifyBundleProvenance,
} from "../src/index.js";

const NOW = 1_754_000_000;

function parsedManifest(
	overrides: Partial<BundleManifest> = {},
): BundleManifest {
	const result = ingestBundleManifest({
		schema: BUNDLE_MANIFEST_SCHEMA,
		name: "kv-cache",
		version: "1.0.0",
		provider: "cloudflare",
		capabilities: [{ port: "hobo:kv", features: ["ttl"] }],
		description: "KV cache bundle",
	});
	if (!result.ok) throw new Error("fixture manifest must parse");
	return { ...result.manifest, ...overrides };
}

function issuerFixture() {
	const kms = createInMemoryKms();
	kms.generateRsaKey("registry-signing-k1");
	return new JwtSvidIssuer({
		issuerUrl: "https://issuer.registry.test",
		kms,
		activeKeyId: "registry-signing-k1",
		jwksKeyIds: ["registry-signing-k1"],
	});
}

async function signedAttestation(
	issuer: JwtSvidIssuer,
	digest: string,
): Promise<string> {
	const claims: JwtSvidClaims = {
		sub: "spiffe://hobo/bundle-publisher",
		aud: "hobo-registry",
		tenant: "t1",
		parentPrincipal: { kind: "service", id: "registry" },
		codeVersion: { digest, version: "1.0.0" },
		scope: [],
		exp: NOW + 3600,
		nbf: NOW - 10,
		iat: NOW,
	};
	return issuer.signJwtSvid(claims);
}

function verifierFor(issuer: JwtSvidIssuer): SignatureVerifier {
	return {
		jwks: issuer.jwks(),
		issuer: issuer.issuerUrl,
		audience: "hobo-registry",
		now: NOW,
	};
}

function statementFor(digest: string) {
	return {
		_type: "https://in-toto.io/Statement/v1",
		subject: [
			{
				name: "kv-cache@1.0.0",
				digest: { sha256: digest.replace(/^sha256:/, "") },
			},
		],
		predicateType: "https://slsa.dev/provenance/v1",
		predicate: {
			builder: { id: "https://builder.example/hobo" },
			buildType: "https://builder.example/hobo/bundle@v1",
		},
	};
}

describe("verifyBundleProvenance", () => {
	it("verifies a correctly signed digest with a binding provenance statement", async () => {
		const manifest = parsedManifest();
		const digest = bundleManifestDigest(manifest);
		const issuer = issuerFixture();
		const result = await verifyBundleProvenance({
			manifest,
			attestation: await signedAttestation(issuer, digest),
			statement: statementFor(digest),
			verifier: verifierFor(issuer),
		});
		expect(result.status).toBe("verified");
		if (result.status !== "verified") throw new Error("expected verified");
		expect(result.manifestDigest).toBe(digest);
		expect(result.signedBy).toBe("spiffe://hobo/bundle-publisher");
	});

	it("fails when the manifest was tampered with after signing", async () => {
		const manifest = parsedManifest();
		const issuer = issuerFixture();
		const attestation = await signedAttestation(
			issuer,
			bundleManifestDigest(manifest),
		);
		const result = await verifyBundleProvenance({
			manifest: parsedManifest({ version: "1.0.1-tampered" }),
			attestation,
			verifier: verifierFor(issuer),
		});
		expect(result.status).toBe("failed");
	});

	it("fails when the attestation signature itself is tampered", async () => {
		const manifest = parsedManifest();
		const digest = bundleManifestDigest(manifest);
		const issuer = issuerFixture();
		const attestation = await signedAttestation(issuer, digest);
		const [header, payload, signature] = attestation.split(".");
		const flipped = signature?.startsWith("A") ? "B" : "A";
		const result = await verifyBundleProvenance({
			manifest,
			attestation: `${header}.${payload}.${flipped}${signature?.slice(1)}`,
			verifier: verifierFor(issuer),
		});
		expect(result.status).toBe("failed");
	});

	it("fails against a foreign issuer's key material (credential-gated)", async () => {
		const manifest = parsedManifest();
		const digest = bundleManifestDigest(manifest);
		const signingIssuer = issuerFixture();
		const foreignIssuer = issuerFixture();
		const result = await verifyBundleProvenance({
			manifest,
			attestation: await signedAttestation(signingIssuer, digest),
			verifier: verifierFor(foreignIssuer),
		});
		expect(result.status).toBe("failed");
	});

	it("reports an explicit unverified status when no verifier is configured", async () => {
		const manifest = parsedManifest();
		const issuer = issuerFixture();
		const result = await verifyBundleProvenance({
			manifest,
			attestation: await signedAttestation(
				issuer,
				bundleManifestDigest(manifest),
			),
		});
		expect(result.status).toBe("unverified");
		if (result.status !== "unverified") throw new Error("expected unverified");
		expect(result.reason).toContain("no signature verifier");
	});

	it("fails when the provenance subject does not bind the manifest", async () => {
		const manifest = parsedManifest();
		const digest = bundleManifestDigest(manifest);
		const issuer = issuerFixture();
		const result = await verifyBundleProvenance({
			manifest,
			attestation: await signedAttestation(issuer, digest),
			statement: statementFor(`sha256:${"f".repeat(64)}`),
			verifier: verifierFor(issuer),
		});
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("expected failed");
		expect(result.reasons[0]).toContain("does not bind");
	});

	it("fails on a malformed provenance statement instead of skipping it", async () => {
		const manifest = parsedManifest();
		const digest = bundleManifestDigest(manifest);
		const issuer = issuerFixture();
		const result = await verifyBundleProvenance({
			manifest,
			attestation: await signedAttestation(issuer, digest),
			statement: { _type: "https://example.test/not-in-toto" },
			verifier: verifierFor(issuer),
		});
		expect(result.status).toBe("failed");
	});
});

describe("parseProvenanceStatement", () => {
	it("parses a well-formed SLSA statement", () => {
		const parsed = parseProvenanceStatement(
			statementFor(`sha256:${"a".repeat(64)}`),
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("expected ok");
		expect(parsed.statement.predicate.builderId).toBe(
			"https://builder.example/hobo",
		);
		expect(parsed.statement.subject[0]?.sha256).toBe("a".repeat(64));
	});

	it("rejects unsupported types, missing subjects, and builder-less predicates", () => {
		const parsed = parseProvenanceStatement({
			_type: "https://example.test/nope",
			predicateType: "https://example.test/nope",
			subject: [],
			predicate: {},
		});
		expect(parsed.ok).toBe(false);
		if (parsed.ok) throw new Error("expected rejection");
		expect(parsed.errors.map((e) => e.code).sort()).toEqual([
			"invalid-predicate",
			"missing-subject",
			"unsupported-predicate-type",
			"unsupported-statement-type",
		]);
	});
});
