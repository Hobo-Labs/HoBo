// "./provenance" (WP3): in-toto/SLSA provenance verified as Sigstore bundles
// (sigstore@5.0.1) or HoBo-signed attestations, with builder and signer pins.
export { isCompactJwt } from "./hobo-jwt.js";
export {
	PROVENANCE_REASON,
	type ProvenanceReasonCode,
} from "./reasons.js";
export {
	GITHUB_ACTIONS_ISSUER,
	GITHUB_WORKFLOW_BUILD_TYPE,
	githubActionsBuild,
	githubWorkflowIdentity,
	INTOTO_PAYLOAD_TYPE,
	type NpmProvenance,
	npmPackagePurl,
	npmProvenanceStatement,
	type ProvenanceSigner,
	ProvenanceSigningError,
	SLSA_PROVENANCE_V1,
	signNpmProvenance,
	sigstoreKeylessSigner,
	type WorkflowRunBuild,
} from "./signer.js";
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
