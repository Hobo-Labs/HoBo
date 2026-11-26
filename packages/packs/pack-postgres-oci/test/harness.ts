/**
 * Offline fixtures.
 *
 * The pack ships unsigned, so the tests sign the real document with a fixture
 * key and verify it through a stub verifier. That keeps the whole path under test
 * — parse, sign, verify, project — without this repo holding a signing key or a
 * test asserting a signature it cannot produce.
 */
import { parseSecretRef } from "@hobo/bindings";
import {
	type PackSignature,
	type PackSignatureVerdict,
	type PackSignatureVerifier,
	type PackTrustAnchors,
	packManifestPayloadDigest,
	type VerifiedPackManifest,
	verifyPackManifest,
} from "@hobo/pack-framework";

import {
	createPostgresPackManifest,
	POSTGRES_PACK_MANIFEST_DOCUMENT,
} from "../src/index.js";

export const FIXTURE_KEY_ID = "hobo-pack-signing-fixture";

export const FIXTURE_SIGNATURE: PackSignature = {
	algorithm: "ed25519",
	keyId: FIXTURE_KEY_ID,
	value: "ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Rz",
	payloadDigest: packManifestPayloadDigest(POSTGRES_PACK_MANIFEST_DOCUMENT),
	signedAt: "2026-08-08T00:00:00Z",
};

export const FIXTURE_ANCHORS: PackTrustAnchors = {
	trustedKeyIds: [FIXTURE_KEY_ID],
	allowedRegistries: ["docker.io"],
};

export function stubVerifier(
	verdict: PackSignatureVerdict = "valid",
): PackSignatureVerifier {
	return { verify: () => verdict };
}

export function verifiedPostgresPack(
	architecture: "linux/amd64" | "linux/arm64" = "linux/amd64",
): VerifiedPackManifest {
	return verifyPackManifest({
		manifest: createPostgresPackManifest(FIXTURE_SIGNATURE),
		verifier: stubVerifier("valid"),
		anchors: FIXTURE_ANCHORS,
		requestedArchitecture: architecture,
	});
}

/**
 * Branded through the real parser rather than cast: a test that casts a string
 * into a `SecretRef` is a test that would keep passing after the parser started
 * rejecting that string.
 */
export const SUPERUSER_REF = parseSecretRef(
	"hobo-secret://tenant-demo/pg-main/superuser",
).ref;
export const CERTIFICATE_REF = parseSecretRef(
	"hobo-secret://tenant-demo/pg-main/server-ca",
).ref;
