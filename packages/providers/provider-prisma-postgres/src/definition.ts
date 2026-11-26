/**
 * The product definition the catalog selects over.
 *
 * A data-only product implementing `data.postgres/v1` natively, and therefore
 * `data.relational/v1` by refinement.
 *
 * One deliberate choice deserves calling out: the default candidate ships
 * `creatorAuthorityAfterClaim: "unknown"`, which the default trust policy
 * rejects with `STRONG_CLAIM_REQUIRED`. Prisma documents the claim ceremony but
 * not what happens to the *pre-claim* credential afterwards, and "we could not
 * find out" is not the same as "it is fine". A catalog owner who has verified
 * rotation in the Prisma console opts in explicitly:
 *
 * ```ts
 * createPrismaClaimablePostgresCandidate({ creatorAuthorityAfterClaim: "rotatable" })
 * ```
 */
import type {
	CreatorAuthorityAfterClaim,
	ProfileImplementation,
	SelectionCandidate,
} from "@hobo/capability-profiles";

import { PINNED_CREATE_DB_VERSION } from "./cli.js";
import {
	PRISMA_DEFINITION_ID,
	PRISMA_DOCUMENTED_TTL_HOURS,
	PRISMA_PROVIDER_ID,
} from "./driver.js";

// public-contract: dates the provider documentation evidence snapshot.
export const PRISMA_EVIDENCE_CHECKED_AT = "2026-08-08";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

// public-contract: stable conformance evidence reference for selection.
export const PRISMA_CONFORMANCE_REF =
	"hobo.conformance/data.postgres/v1#prisma.claimable-postgres@2026-08-08";

export const PRISMA_PROFILE_IMPLEMENTATIONS: readonly ProfileImplementation[] =
	[
		{
			profileId: "data.postgres/v1",
			versionRange: ">=1",
			realization: "native",
			conformanceRef: PRISMA_CONFORMANCE_REF,
			conformance: "pass",
		},
	];

export type PrismaCandidateOverrides = {
	readonly evidenceExpiresAtMs?: number;
	readonly evidenceSignatureValid?: boolean;
	readonly secretCustodyAvailable?: boolean;
	readonly hasRegisteredDriver?: boolean;
	readonly conformance?: ProfileImplementation["conformance"];
	/**
	 * Set to `"rotatable"` only after verifying, in the Prisma console, that a
	 * claimed database's credential can be rotated by its new owner.
	 */
	readonly creatorAuthorityAfterClaim?: CreatorAuthorityAfterClaim;
	readonly supportsRotation?: boolean;
};

export function createPrismaClaimablePostgresCandidate(
	overrides: PrismaCandidateOverrides = {},
): SelectionCandidate {
	const conformance = overrides.conformance ?? "pass";
	return {
		definitionId: PRISMA_DEFINITION_ID,
		providerId: PRISMA_PROVIDER_ID,
		implementsProfiles: PRISMA_PROFILE_IMPLEMENTATIONS.map(
			(implementation) => ({
				...implementation,
				conformance,
			}),
		),
		// No `wasm`: `create-db` hands back a TCP PostgreSQL URI to
		// `db.prisma.io:5432`, and the HTTP-transport path is not part of this
		// product's documented output.
		runtimeModels: ["oci", "vm_iaas", "paas", "serverless_faas"],
		structuredCapabilities: {
			postgresWireProtocol: true,
			tls: true,
			transactions: true,
			constraints: true,
			jsonDocuments: true,
			preparedStatements: true,
			pooling: true,
			bootstrap: "public-anonymous-claimable",
			claimBoundary: "resource",
			// Not `provider-reported`: the pinned CLI computes the deadline from
			// its own clock.
			expirySource: "cli-local-clock",
			documentedTtlHours: PRISMA_DOCUMENTED_TTL_HOURS,
			associatedResourceClaim: true,
			pinnedCliVersion: PINNED_CREATE_DB_VERSION,
			// `serverVersion`, `maxStorageBytes`, `maxConnections`, and
			// `extensions` are unset: none is documented for the temporary tier.
		},
		producesBindingProfiles: ["binding.postgresql/v1"],
		// pg_dump only. Logical replication is not documented for this tier.
		migrationProfiles: ["migration.postgres.pg-dump/v1"],
		providerClass: "verified-emerging",
		evidenceExpiresAtMs:
			overrides.evidenceExpiresAtMs ??
			Date.parse(PRISMA_EVIDENCE_CHECKED_AT) + NINETY_DAYS_MS,
		evidenceSignatureValid: overrides.evidenceSignatureValid ?? true,
		creatorAuthorityAfterClaim:
			overrides.creatorAuthorityAfterClaim ?? "unknown",
		claimAtomicity: "single-resource",
		// (1) the workspace transfer ceremony, (2) the owner credential rotation.
		claimActionCount: 2,
		continuity: {
			// Documented: the database moves into the workspace and stays usable.
			endpoint: "preserved",
			data: "preserved",
			// Undocumented, so unknown rather than assumed benign.
			credentials: "unknown",
		},
		supportsExport: true,
		supportsRotation: overrides.supportsRotation ?? false,
		supportsRevocation: false,
		sponsorExposureMinorUnits: 0,
		hasRegisteredDriver: overrides.hasRegisteredDriver ?? true,
		secretCustodyAvailable: overrides.secretCustodyAvailable ?? true,
	};
}

/**
 * Default candidate. Fails the default trust policy on
 * `creatorAuthorityAfterClaim` by design — see the module comment.
 */
export const PRISMA_CLAIMABLE_POSTGRES_CANDIDATE: SelectionCandidate =
	createPrismaClaimablePostgresCandidate();

export type ProviderSourceRef = {
	readonly url: string;
	readonly checkedAt: string;
	readonly note: string;
};

export const PRISMA_SOURCE_REFS: readonly ProviderSourceRef[] = [
	{
		url: "https://docs.prisma.io/docs/postgres/npx-create-db",
		checkedAt: PRISMA_EVIDENCE_CHECKED_AT,
		note: "create-db CLI: no signup, 24-hour default lifetime, claim URL https://create-db.prisma.io?projectID=proj_…, --json machine-readable output, --region/-r with six documented regions, connection string postgresql://<user>:<password>@db.prisma.io:5432/postgres",
	},
	{
		url: "https://www.npmjs.com/package/create-db/v/1.2.1",
		checkedAt: PRISMA_EVIDENCE_CHECKED_AT,
		note: "Pinned CLI version 1.2.1 (also the published `latest` at review time); its type declarations define the DatabaseResult/DatabaseError JSON contract this package parses, and show deletionDate being computed from the local clock",
	},
];
