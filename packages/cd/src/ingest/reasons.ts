import { UNVERIFIED_TRIGGER } from "../events.js";

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
	journalConflict: "ingest-journal-conflict",
} as const);

export type IngestReasonCode =
	(typeof INGEST_REASON)[keyof typeof INGEST_REASON];

export const INGEST_METRIC = Object.freeze({
	accepted: "hobo.cd.ingest.accepted",
	refused: "hobo.cd.ingest.refused",
	pollsScheduled: "hobo.cd.ingest.polls_scheduled",
	publisherVerified: "hobo.cd.publisher.verified",
	publisherRefused: "hobo.cd.publisher.refused",
	oidcFetch: "hobo.cd.publisher.oidc_fetch",
} as const);
