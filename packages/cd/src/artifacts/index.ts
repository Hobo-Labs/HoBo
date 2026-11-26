// "./artifacts" (WP3): content-addressed artifact store and registry-digest
// verifier. Factories match the frozen `CdFactories` signatures in ports.ts.

export { parseOciReference, parsePurl } from "./coordinates.js";
export { parseDigest, sha256Digest } from "./digest.js";
export {
	ARTIFACT_REASON,
	type ArtifactReasonCode,
	ArtifactStoreError,
	isArtifactStoreError,
} from "./reasons.js";
export {
	DEFAULT_REGISTRIES,
	REGISTRY_ECOSYSTEMS,
	type RegistryEcosystem,
} from "./registries.js";
export {
	ARTIFACT_MULTIPART_THRESHOLD_BYTES,
	ARTIFACT_S3_KEY_PREFIX,
	ARTIFACT_S3_MAX_BLOB_BYTES,
	signS3Request,
} from "./s3.js";
export {
	ARTIFACT_STORE_COORDINATE_PREFIX,
	type ArtifactStoreDeps,
	createArtifactStore,
} from "./store.js";
export { ARTIFACT_METRICS } from "./telemetry.js";
export {
	type ArtifactVerifierDeps,
	createArtifactVerifier,
} from "./verifier.js";
