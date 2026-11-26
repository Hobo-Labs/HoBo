/**
 * The product definition the catalog selects over.
 *
 * This is a *data* product: it implements `data.postgres/v1` natively and
 * therefore `data.relational/v1` by refinement. The reverse never holds, which
 * is the whole point of the profile graph — a relational-only product such as
 * Cloudflare D1 is not a substitute here.
 *
 * Every claim below is either documented by Neon or deliberately absent.
 * Absent beats optimistic: an unset structured capability fails a `required`
 * feature gate, and that is the correct outcome for something unverified.
 */
import type {
	ProfileImplementation,
	SelectionCandidate,
} from "@hobo/capability-profiles";

import {
	NEON_DEFINITION_ID,
	NEON_PROVIDER_ID,
	NEON_UNCLAIMED_LIMITS,
} from "./driver.js";

/** Date a human read the official sources listed in the README. */
// public-contract: dates the provider documentation evidence snapshot.
export const NEON_EVIDENCE_CHECKED_AT = "2026-08-08";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

// public-contract: stable conformance evidence reference for selection.
export const NEON_CONFORMANCE_REF =
	"hobo.conformance/data.postgres/v1#neon.claimable-postgres@2026-08-08";

export const NEON_PROFILE_IMPLEMENTATIONS: readonly ProfileImplementation[] = [
	{
		profileId: "data.postgres/v1",
		versionRange: ">=1",
		realization: "native",
		conformanceRef: NEON_CONFORMANCE_REF,
		conformance: "pass",
	},
];

export type NeonCandidateOverrides = {
	/** Epoch ms after which the trust evidence must be re-gathered. */
	readonly evidenceExpiresAtMs?: number;
	/** Set false until the catalog owner has signed this evidence. */
	readonly evidenceSignatureValid?: boolean;
	readonly secretCustodyAvailable?: boolean;
	readonly hasRegisteredDriver?: boolean;
	readonly conformance?: ProfileImplementation["conformance"];
};

export function createNeonClaimablePostgresCandidate(
	overrides: NeonCandidateOverrides = {},
): SelectionCandidate {
	const conformance = overrides.conformance ?? "pass";
	return {
		definitionId: NEON_DEFINITION_ID,
		providerId: NEON_PROVIDER_ID,
		implementsProfiles: NEON_PROFILE_IMPLEMENTATIONS.map((implementation) => ({
			...implementation,
			conformance,
		})),
		// A managed Postgres endpoint is reachable from every runtime model:
		// wasm and serverless callers use the Neon serverless driver over
		// HTTP/WebSocket, everything else opens a TCP session.
		runtimeModels: ["wasm", "oci", "vm_iaas", "paas", "serverless_faas"],
		structuredCapabilities: {
			postgresWireProtocol: true,
			tls: true,
			transactions: true,
			constraints: true,
			jsonDocuments: true,
			preparedStatements: true,
			pooling: true,
			serverVersion: `>=${NEON_UNCLAIMED_LIMITS.postgresMajorVersion}`,
			maxStorageBytes: NEON_UNCLAIMED_LIMITS.maxStorageBytes,
			// Neon-specific, non-profile facts the catalog can rank on.
			maxTransferBytes: NEON_UNCLAIMED_LIMITS.maxTransferBytes,
			region: NEON_UNCLAIMED_LIMITS.region,
			bootstrap: "public-anonymous-claimable",
			claimBoundary: "resource",
			expirySource: "provider-reported",
			logicalReplicationOptIn: true,
			branches: NEON_UNCLAIMED_LIMITS.branches,
			// `extensions` and `maxConnections` are deliberately unset: neither
			// is documented for the unclaimed tier, and an unset capability
			// fails a required-feature gate instead of over-promising.
		},
		producesBindingProfiles: [
			"binding.postgresql/v1",
			"binding.neon-serverless/v1",
		],
		migrationProfiles: [
			"migration.postgres.pg-dump/v1",
			"migration.postgres.logical-copy/v1",
		],
		providerClass: "verified-emerging",
		evidenceExpiresAtMs:
			overrides.evidenceExpiresAtMs ??
			Date.parse(NEON_EVIDENCE_CHECKED_AT) + NINETY_DAYS_MS,
		evidenceSignatureValid: overrides.evidenceSignatureValid ?? true,
		// The owner can rotate the role password after the claim, which is what
		// finally removes the creating party's authority. Until then it is
		// retained, hence the blocking rotation action in the claim plan.
		creatorAuthorityAfterClaim: "rotatable",
		claimAtomicity: "single-resource",
		// (1) the browser transfer ceremony, (2) the owner credential rotation.
		claimActionCount: 2,
		continuity: {
			// Documented: "Your connection strings will continue to work."
			endpoint: "preserved",
			data: "preserved",
			credentials: "retained",
		},
		supportsExport: true,
		supportsRotation: true,
		supportsRevocation: true,
		// Anonymous, on the provider's free allowance. HoBo sponsors nothing.
		sponsorExposureMinorUnits: 0,
		hasRegisteredDriver: overrides.hasRegisteredDriver ?? true,
		secretCustodyAvailable: overrides.secretCustodyAvailable ?? true,
	};
}

/** Default candidate. Re-sign the evidence before catalog publication. */
export const NEON_CLAIMABLE_POSTGRES_CANDIDATE: SelectionCandidate =
	createNeonClaimablePostgresCandidate();

export type ProviderSourceRef = {
	readonly url: string;
	readonly checkedAt: string;
	readonly note: string;
};

export const NEON_SOURCE_REFS: readonly ProviderSourceRef[] = [
	{
		url: "https://neon.com/docs/reference/claimable-postgres",
		checkedAt: NEON_EVIDENCE_CHECKED_AT,
		note: "REST reference: POST /api/v1/database, GET /api/v1/database/:id, response fields, 72h expiry, unclaimed limits, AWS us-east-2, Postgres 17",
	},
	{
		url: "https://neon.com/blog/neon-launchpad",
		checkedAt: NEON_EVIDENCE_CHECKED_AT,
		note: "Launch post: connection strings keep working across a claim, password rotation is a post-claim owner action",
	},
	{
		url: "https://neon.new/",
		checkedAt: NEON_EVIDENCE_CHECKED_AT,
		note: "Product page repeating the unauthenticated create call and response fields",
	},
];
