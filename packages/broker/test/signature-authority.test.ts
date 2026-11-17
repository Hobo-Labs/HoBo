import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
	canonicalResolutionJson,
	generateResolutionSigningKey,
	signResolution,
	verifyResolution,
} from "../src/signing.js";
import type { PolicyHash, ResolutionReceipt } from "../src/types.js";

const receipt: ResolutionReceipt = {
	schemaVersion: "hobo.broker/v1",
	requestId: "request",
	brokerId: "broker",
	catalogHash: "sha256:catalog",
	// SAFETY: the test fixture is an intentionally branded policy hash.
	policyHash: "sha256:policy" as PolicyHash,
	placementPolicyId: "policy",
	stationId: "station",
	railHash: "sha256:rail",
	placements: [
		{
			resourceId: "api",
			providerId: "provider",
			definitionId: "definition",
			region: "region",
			sku: "sku",
			unit: "hour",
			marginalPrice: "1",
		},
	],
};

describe("resolution signature authority", () => {
	it("requires a separately trusted signing key", () => {
		const trusted = generateResolutionSigningKey();
		const attacker = generateResolutionSigningKey();
		const valid = signResolution(receipt, trusted);
		const forged = signResolution(receipt, attacker);
		expect(verifyResolution(receipt, valid, trusted.publicKeyPem)).toBe(true);
		expect(verifyResolution(receipt, valid, attacker.publicKeyPem)).toBe(false);
		expect(verifyResolution(receipt, forged, trusted.publicKeyPem)).toBe(false);
		expect(
			verifyResolution(
				receipt,
				{ ...valid, publicKeyPem: attacker.publicKeyPem },
				trusted.publicKeyPem,
			),
		).toBe(false);
		expect(
			verifyResolution(
				receipt,
				{ ...valid, signature: Buffer.alloc(64).toString("base64") },
				trusted.publicKeyPem,
			),
		).toBe(false);
		// @ts-expect-error A verifier without an enrolled key must fail closed.
		expect(verifyResolution(receipt, forged)).toBe(false);
	});
	it("verifies the recorded payload digest as well as the signature", () => {
		const key = generateResolutionSigningKey();
		const signature = signResolution(receipt, key);
		expect(
			verifyResolution(
				receipt,
				{ ...signature, payloadDigest: `sha256:${"0".repeat(64)}` },
				key.publicKeyPem,
			),
		).toBe(false);
	});
	it("rejects a signing key with a different advertised public key", () => {
		const key = generateResolutionSigningKey();
		const other = generateResolutionSigningKey();
		expect(() =>
			signResolution(receipt, { ...key, publicKeyPem: other.publicKeyPem }),
		).toThrow(/signing-key-mismatch/u);
	});
	it("canonicalizes keys independently of locale-specific comparison", () => {
		const compare = vi
			.spyOn(String.prototype, "localeCompare")
			.mockImplementation(() => {
				throw new Error("locale used");
			});
		try {
			expect(canonicalResolutionJson({ z: 1, A: 2, a: 3 })).toBe(
				'{"A":2,"a":3,"z":1}',
			);
		} finally {
			compare.mockRestore();
		}
	});
	it("rejects invalid encodings and malformed trusted keys", () => {
		const key = generateResolutionSigningKey();
		const signature = signResolution(receipt, key);
		expect(
			verifyResolution(
				receipt,
				{ ...signature, signature: `${signature.signature}=` },
				key.publicKeyPem,
			),
		).toBe(false);
		expect(verifyResolution(receipt, signature, "not a public key")).toBe(
			false,
		);
	});
	it("uses one stable copy of the advertised signing key", () => {
		const key = generateResolutionSigningKey();
		const other = generateResolutionSigningKey();
		let reads = 0;
		const variable = {
			privateKey: key.privateKey,
			get publicKeyPem() {
				return ++reads === 1 ? key.publicKeyPem : other.publicKeyPem;
			},
		};
		const signed = signResolution(receipt, variable);
		expect(reads).toBe(1);
		expect(verifyResolution(receipt, signed, key.publicKeyPem)).toBe(true);
	});
	it("binds generated request identities to the enrolled signer and digest", () => {
		const trusted = generateResolutionSigningKey();
		const attacker = generateResolutionSigningKey();
		fc.assert(
			fc.property(fc.string({ minLength: 1, maxLength: 40 }), (requestId) => {
				const value = { ...receipt, requestId };
				const signed = signResolution(value, trusted);
				const forged = signResolution(value, attacker);
				expect(verifyResolution(value, signed, trusted.publicKeyPem)).toBe(
					true,
				);
				expect(verifyResolution(value, forged, trusted.publicKeyPem)).toBe(
					false,
				);
				expect(
					verifyResolution(
						{ ...value, requestId: `${requestId}x` },
						signed,
						trusted.publicKeyPem,
					),
				).toBe(false);
			}),
			{ seed: 614518, numRuns: 120 },
		);
	});

	it("verifies a signed resolution when locale collation differs on the verifier", () => {
		const key = generateResolutionSigningKey();
		const signed = signResolution(receipt, key);
		const original = String.prototype.localeCompare;
		const compare = vi
			.spyOn(String.prototype, "localeCompare")
			.mockImplementation(function (this: string, other: string) {
				return -original.call(this, other);
			});
		try {
			expect(verifyResolution(receipt, signed, key.publicKeyPem)).toBe(true);
		} finally {
			compare.mockRestore();
		}
	});

	it("never emits private key material as the advertised public key", () => {
		const key = generateResolutionSigningKey();
		const privatePem = key.privateKey
			.export({ type: "pkcs8", format: "pem" })
			.toString();
		expect(() =>
			signResolution(receipt, { ...key, publicKeyPem: privatePem }),
		).toThrow(/signing-key-mismatch/u);
		const signed = signResolution(receipt, key);
		expect(verifyResolution(receipt, signed, privatePem)).toBe(false);
		expect(() =>
			signResolution(receipt, {
				...key,
				publicKeyPem: `${key.publicKeyPem}\n${privatePem}`,
			}),
		).toThrow(/signing-key-mismatch/u);
	});
});
