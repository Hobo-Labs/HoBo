import type { RivetSignedCapability } from "../src/distributed-auth.js";

/** Only for fake transport tests; the real engine test uses an Ed25519 issuer. */
export function testCapability(): RivetSignedCapability {
	return {
		version: 1,
		issuer: "issuer",
		audience: "audience",
		subject: "tester",
		capabilityId: "test",
		scopeDigest: `sha256:${"a".repeat(64)}`,
		issuedAtMs: 1,
		expiresAtMs: 60_000,
		signature: "a".repeat(86),
	};
}
