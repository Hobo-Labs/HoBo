import { UNVERIFIED_TRIGGER } from "../events.js";

// public-contract: refusal codes of the ingest boundary (manifest, attestation,
// CDEvent, trusted-publisher token). Every refusal carries a remediation.
export const INGEST_REASON = Object.freeze({
	publisherRecordInvalid: "publisher-record-invalid",
	publisherIssuer: "publisher-issuer-unconfigured",
	publisherToken: "publisher-token-invalid",
	publisherExpired: "publisher-token-expired",
	publisherAudience: "publisher-audience-mismatch",
	publisherClaims: "publisher-claims-mismatch",
	publisherDiscovery: "publisher-discovery-failed",
	publisherScope: "publisher-bindle-scope",
	attestationInvalid: "attestation-invalid",
	declarationMissing: "attestation-declaration-missing",
	provenanceUnverified: "provenance-unverified",
	cdeventInvalid: "cdevent-invalid",
	cdeventUnsupported: "cdevent-unsupported",
	unverifiedTrigger: UNVERIFIED_TRIGGER,
	unauthorized: "ingest-unauthorized",
	proposalOnly: "ingest-proposal-only",
	ungoverned: "ingest-ungoverned",
} as const);

export type IngestReasonCode = (typeof INGEST_REASON)[keyof typeof INGEST_REASON];

// public-contract: metric names the ingest boundary emits through TelemetrySink.
export const INGEST_METRIC = Object.freeze({
	accepted: "hobo.cd.ingest.accepted",
	refused: "hobo.cd.ingest.refused",
	pollsScheduled: "hobo.cd.ingest.polls_scheduled",
	publisherVerified: "hobo.cd.publisher.verified",
	publisherRefused: "hobo.cd.publisher.refused",
	oidcFetch: "hobo.cd.publisher.oidc_fetch",
} as const);
