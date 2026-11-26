/**
 * Offline fixtures.
 *
 * The pack ships unsigned, so the tests sign the real document with a fixture key
 * and verify it through a stub verifier. The whole path stays under test — parse,
 * sign, verify, project — without this repo holding a signing key or a test
 * asserting a signature it cannot produce.
 */
import { parseSecretRef } from "@hobo/bindings";
import {
	type PackSignature,
	type PackSignatureVerdict,
	type PackSignatureVerifier,
	type PackTrustAnchors,
	packManifestPayloadDigest,
	parsePackManifest,
	type VerifiedPackManifest,
	verifyPackManifest,
} from "@hobo/pack-framework";

import {
	createValkeyPackManifest,
	VALKEY_PACK_MANIFEST_DOCUMENT,
} from "../src/index.js";

export const FIXTURE_KEY_ID = "hobo-pack-signing-fixture";

export const FIXTURE_SIGNATURE: PackSignature = {
	algorithm: "ed25519",
	keyId: FIXTURE_KEY_ID,
	value: "ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Rz",
	payloadDigest: packManifestPayloadDigest(VALKEY_PACK_MANIFEST_DOCUMENT),
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

export function verifiedValkeyPack(
	architecture: "linux/amd64" | "linux/arm64" = "linux/amd64",
): VerifiedPackManifest {
	return verifyPackManifest({
		manifest: createValkeyPackManifest(FIXTURE_SIGNATURE),
		verifier: stubVerifier("valid"),
		anchors: FIXTURE_ANCHORS,
		requestedArchitecture: architecture,
	});
}

/**
 * A verified manifest for a *different* pack id, used to prove the pack-id guards
 * reject a manifest the type system is happy with. Built through the real parse
 * and verify path rather than by casting the valkey manifest.
 */
export function verifiedOtherPack(): VerifiedPackManifest {
	const document = {
		...VALKEY_PACK_MANIFEST_DOCUMENT,
		packId: "pack.other.oci/v1",
	};
	return verifyPackManifest({
		manifest: parsePackManifest({
			...document,
			signature: {
				...FIXTURE_SIGNATURE,
				payloadDigest: packManifestPayloadDigest(document),
			},
		}),
		verifier: stubVerifier("valid"),
		anchors: FIXTURE_ANCHORS,
		requestedArchitecture: "linux/amd64",
	});
}

/**
 * Branded through the real parser rather than cast: a test that casts a string
 * into a `SecretRef` keeps passing after the parser starts rejecting that string.
 */
export const AUTH_REF = parseSecretRef(
	"hobo-secret://tenant-demo/valkey-main/requirepass",
).ref;
export const CERTIFICATE_REF = parseSecretRef(
	"hobo-secret://tenant-demo/valkey-main/server-ca",
).ref;

/** A bound local volume, which every legal configuration of this pack needs. */
export const VOLUME_BINDING = {
	volumeName: "valkey-data",
	storage: { kind: "local-volume", volumeId: "vol-valkey-0001" },
} as const;

/** The three required settings, spelled out at every call site on purpose. */
export const REQUIRED_VALUES = {
	dataVolume: "valkey-data",
	authPasswordRef: AUTH_REF,
	durabilityMode: "aof-everysec",
	evictionPolicy: "noeviction",
	maxmemoryBytes: 256 * 1024 * 1024,
} as const;
