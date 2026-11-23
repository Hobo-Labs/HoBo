import type {
	LocalHostingAuthorizationContext,
	LocalHostingProof,
} from "../../src/yard-placement/index.js";

export function approveLocalHosting(
	input: LocalHostingAuthorizationContext,
): LocalHostingProof {
	return {
		schemaVersion: "hobo.local-hosting-proof/v1",
		bindingDigest: input.bindingDigest,
		effect: "allow",
		obligationsSatisfied: true,
		policyHash: `sha256:${"a".repeat(64)}`,
		evidenceRef: "test-host",
		liabilityBoundMicros: 0,
	};
}
