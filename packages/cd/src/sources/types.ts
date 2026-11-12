// Driver-side extension of the frozen SubscriptionDriver port. A driver that
// can fetch attestation material for a discovered artifact implements
// `attestations`; createFreightSources verifies that material through the
// ProvenanceVerifier port. A driver without it can never satisfy
// `require_provenance` (define refuses; poll skips).
import type { DiscoveredArtifactRecord, SubscriptionRecord } from "../_generated/cd_pb.js";
import type { CdContext, Outcome, SubscriptionDriver } from "../ports.js";

export type AttestationMaterial = Readonly<{
	/** in-toto Statement v1 bytes (DSSE payload when it came from a bundle). */
	statement: Uint8Array;
	/** Sigstore bundle bytes, when the attestation is a bundle. */
	bundle?: Uint8Array;
}>;

export interface AttestingDriver extends SubscriptionDriver {
	attestations(
		input: Readonly<{
			subscription: SubscriptionRecord;
			artifact: DiscoveredArtifactRecord;
			signal: AbortSignal;
		}>,
		ctx: CdContext,
	): Promise<Outcome<readonly AttestationMaterial[]>>;
}

export function isAttestingDriver(driver: SubscriptionDriver): driver is AttestingDriver {
	return "attestations" in driver;
}
