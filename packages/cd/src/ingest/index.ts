// "@hobo/cd/ingest" (WP1): push ingress into the Freight ledger: manifests,
// in-toto/SLSA attestations, inbound CDEvents, and OIDC trusted publishers.
export { type ArtifactCdEvent, CDEVENT_ATTESTATION_KEY, CDEVENT_MAX_BYTES, parseArtifactCdEvent } from "./cdevent.js";
export { createFreightIngest, DECLARATION_HASH_PARAMETER, type FreightIngestDeps } from "./ingest.js";
export {
	cacheLifetimeMs,
	createTrustedPublisherVerifier,
	parseTrustedPublisher,
	readTrustedPublishers,
	type TrustedPublisherVerifierDeps,
} from "./publishers.js";
export { artifactFromSubject, type Purl, parsePurl, sourcesForPurl } from "./purl.js";
export { INGEST_METRIC, INGEST_REASON, type IngestReasonCode } from "./reasons.js";
// The manifest writer is exported here too so a build (WP15) or any CI
// imports one subpath for the whole push path.
export { writeFreightManifest } from "../freight/manifest.js";
