import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	PackError,
	parsePackManifest,
	verifyPackManifest,
} from "../src/index.js";
import { FIXTURE_ANCHORS, fixtureManifest, stubVerifier } from "./harness.js";

function expectPackError(fn: () => void, code: string): void {
	try {
		fn();
	} catch (error) {
		assert.ok(
			error instanceof PackError,
			`expected a PackError, got ${String(error)}`,
		);
		assert.equal(error.code, code);
		return;
	}
	throw new Error(`expected ${code} but nothing was thrown`);
}

const anchors = {
	trustedKeyIds: [...FIXTURE_ANCHORS.trustedKeyIds],
	allowedRegistries: [...FIXTURE_ANCHORS.allowedRegistries],
};

describe("verifyPackManifest", () => {
	it("verifies a signed manifest and selects the requested architecture", () => {
		const verified = verifyPackManifest({
			manifest: parsePackManifest(fixtureManifest()),
			verifier: stubVerifier("valid"),
			anchors,
			requestedArchitecture: "linux/arm64",
		});
		assert.equal(verified.selectedArchitecture, "linux/arm64");
		assert.equal(
			verified.selectedImage.reference.registry,
			"registry.example.test",
		);
		assert.equal(
			verified.verifiedPayloadDigest,
			verified.signature.payloadDigest,
		);
	});

	it("treats linux/arm64 and linux/arm64/v8 as the same hardware", () => {
		const verified = verifyPackManifest({
			manifest: parsePackManifest(fixtureManifest()),
			verifier: stubVerifier("valid"),
			anchors,
			requestedArchitecture: "linux/arm64/v8",
		});
		assert.equal(verified.selectedImage.architecture, "linux/arm64");
	});

	it("fails closed on an invalid signature", () => {
		expectPackError(
			() =>
				verifyPackManifest({
					manifest: parsePackManifest(fixtureManifest()),
					verifier: stubVerifier("invalid"),
					anchors,
					requestedArchitecture: "linux/amd64",
				}),
			"PACK_INTEGRITY_UNVERIFIED",
		);
	});

	it("fails closed on an unknown verdict, exactly like a forged one", () => {
		expectPackError(
			() =>
				verifyPackManifest({
					manifest: parsePackManifest(fixtureManifest()),
					verifier: stubVerifier("unknown"),
					anchors,
					requestedArchitecture: "linux/amd64",
				}),
			"PACK_INTEGRITY_UNVERIFIED",
		);
	});

	it("rejects a signature from an untrusted key", () => {
		expectPackError(
			() =>
				verifyPackManifest({
					manifest: parsePackManifest(
						fixtureManifest((draft) => draft, { keyId: "some-other-key" }),
					),
					verifier: stubVerifier("valid"),
					anchors,
					requestedArchitecture: "linux/amd64",
				}),
			"PACK_INTEGRITY_UNVERIFIED",
		);
	});

	it("rejects everything when no trust anchor is configured", () => {
		expectPackError(
			() =>
				verifyPackManifest({
					manifest: parsePackManifest(fixtureManifest()),
					verifier: stubVerifier("valid"),
					anchors: {
						trustedKeyIds: [],
						allowedRegistries: ["registry.example.test"],
					},
					requestedArchitecture: "linux/amd64",
				}),
			"PACK_INTEGRITY_UNVERIFIED",
		);
	});

	it("reports a payload that changed after signing as a contract change", () => {
		expectPackError(
			() =>
				verifyPackManifest({
					manifest: parsePackManifest(
						fixtureManifest((draft) => draft, {
							payloadDigest:
								"sha256:0000000000000000000000000000000000000000000000000000000000000000",
						}),
					),
					verifier: stubVerifier("valid"),
					anchors,
					requestedArchitecture: "linux/amd64",
				}),
			"PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("rejects an architecture the manifest does not pin", () => {
		expectPackError(
			() =>
				verifyPackManifest({
					manifest: parsePackManifest(fixtureManifest()),
					verifier: stubVerifier("valid"),
					anchors,
					requestedArchitecture: "linux/s390x",
				}),
			"ARCHITECTURE_UNSUPPORTED",
		);
	});

	it("rejects an image served from a registry outside the allowlist", () => {
		expectPackError(
			() =>
				verifyPackManifest({
					manifest: parsePackManifest(fixtureManifest()),
					verifier: stubVerifier("valid"),
					anchors: {
						trustedKeyIds: anchors.trustedKeyIds,
						allowedRegistries: ["ghcr.io"],
					},
					requestedArchitecture: "linux/amd64",
				}),
			"PACK_INTEGRITY_UNVERIFIED",
		);
	});

	it("rejects a manifest whose conformance outcome is not a pass", () => {
		expectPackError(
			() =>
				verifyPackManifest({
					manifest: parsePackManifest(
						fixtureManifest((draft) => ({
							...draft,
							conformance: { ...draft.conformance, outcome: "unknown" },
						})),
					),
					verifier: stubVerifier("valid"),
					anchors,
					requestedArchitecture: "linux/amd64",
				}),
			"PACK_CONFORMANCE_FAILED",
		);
	});

	it("passes the exact signed payload to the verifier and nothing else", () => {
		const seen: string[] = [];
		const manifest = parsePackManifest(fixtureManifest());
		verifyPackManifest({
			manifest,
			verifier: {
				verify(request) {
					seen.push(request.payload);
					return "valid";
				},
			},
			anchors,
			requestedArchitecture: "linux/amd64",
		});
		assert.deepEqual(seen, [manifest.signingPayload]);
		assert.ok(!manifest.signingPayload.includes('"signature"'));
	});
});
