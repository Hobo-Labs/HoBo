// "./provenance" (WP3): in-toto/SLSA provenance verified as Sigstore bundles
// (sigstore@5.0.1) or HoBo-signed attestations, with builder and signer pins.
export { isCompactJwt } from "./hobo-jwt.js";
export {
	PROVENANCE_REASON,
	type ProvenanceReasonCode,
} from "./reasons.js";
export {
	type HoboJwtPolicy,
	ProvenanceTrustPolicyError,
	parseTrustPolicy,
	SIGSTORE_PUBLIC_GOOD_SEED,
	type SigstorePolicy,
	type TrustPolicy,
} from "./trust-policy.js";
export {
	createProvenanceVerifier,
	type ProvenanceVerifierDeps,
} from "./verifier.js";
