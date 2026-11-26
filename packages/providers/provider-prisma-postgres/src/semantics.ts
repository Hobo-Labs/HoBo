/**
 * The catalog record: a data-only Resource Definition vNext.
 *
 * The `ResourceDefinitionSemantics` and `ResourceDefinitionVNext` shapes are
 * **mirrored structurally** here rather than imported from `@hobo/cloud`. This
 * follows the direction `@hobo/cloud` itself already sets — it declares
 * `RegistrableProvider` locally "so `src/` never imports the provider adapter"
 * — and keeps the dependency arrow pointing one way: a provider is a leaf, the
 * control plane consumes it. Importing the control plane from a provider would
 * make every provider transitively depend on the event store, the planner, and
 * identity, and it would make a provider unbuildable without them.
 *
 * The mirror is not a hope. `test/semantics.test.ts` asserts field-for-field
 * that this block satisfies the exported `ResourceDefinitionSemantics` contract
 * as `@hobo/cloud` documents it, and the same test walks
 * `RESOURCE_DEFINITION_VNEXT_SCHEMA` and the parse rules
 * `parseResourceDefinitionVNext` enforces.
 *
 * Everything below is data. No clock, no environment, no I/O — a definition is
 * something you can hash into a catalog digest.
 */
import type {
	BindleRuntime,
	ClaimAtomicity,
	ContinuityGrade,
	CreatorAuthorityAfterClaim,
	ProfileImplementation,
	ProviderClass,
} from "@hobo/capability-profiles";

import { PINNED_CREATE_DB_VERSION } from "./cli.js";
import {
	createPrismaClaimablePostgresCandidate,
	PRISMA_CLAIMABLE_POSTGRES_CANDIDATE,
	PRISMA_CONFORMANCE_REF,
	PRISMA_EVIDENCE_CHECKED_AT,
	PRISMA_PROFILE_IMPLEMENTATIONS,
	type PrismaCandidateOverrides,
} from "./definition.js";
import {
	PRISMA_DEFINITION_ID,
	PRISMA_DOCUMENTED_TTL_HOURS,
	PRISMA_PROVIDER_ID,
} from "./driver.js";

/** Mirrors `@hobo/cloud`'s `RESOURCE_DEFINITION_VNEXT_SCHEMA`. */
// public-contract: schema identity shared with Resource Definition consumers.
export const RESOURCE_DEFINITION_VNEXT_SCHEMA =
	"hobo.resource-definition/vNext" as const;

export type PlacementConstraint = {
	readonly key: string;
	readonly operator: "in" | "not-in" | "equals" | "exists";
	readonly values: readonly string[];
};

export type RemediationHint = {
	readonly code: string;
	readonly message: string;
};

/** Structural mirror of `@hobo/cloud`'s `ResourceDefinitionSemantics`. */
export type ProductSemantics = {
	readonly schemaVersion: typeof RESOURCE_DEFINITION_VNEXT_SCHEMA;
	readonly productId: string;
	readonly displayName: string;
	readonly implementsProfiles: readonly ProfileImplementation[];
	readonly runtimeModels: readonly BindleRuntime[];
	readonly structuredCapabilities: Readonly<
		Record<string, boolean | number | string | readonly string[]>
	>;
	readonly placementConstraints: readonly PlacementConstraint[];
	readonly producesBindingProfiles: readonly string[];
	readonly requiresConnectivityProfiles?: readonly string[];
	readonly migrationProfiles: readonly string[];
	readonly bootstrapStrategyRef: string;
	readonly guestLeaseTemplateRef?: string;
	readonly claimStrategyRef: string;
	readonly compilerRef: string;
	readonly executorRef: string;
	readonly permissionProfileRef: string;
	readonly trustEvidenceRef: string;
	readonly sourceEvidenceRefs: readonly string[];
	readonly remediation: readonly RemediationHint[];
	readonly providerClass: ProviderClass;
	readonly evidenceExpiresAtMs?: number;
	readonly evidenceSignatureValid: boolean;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	readonly claimAtomicity: ClaimAtomicity;
	readonly claimActionCount: number;
	readonly continuity: {
		readonly endpoint: ContinuityGrade;
		readonly data: ContinuityGrade;
		readonly credentials:
			| "revoked"
			| "rotated"
			| "reauthorized"
			| "retained"
			| "unknown"
			| "not-applicable";
	};
	readonly supportsExport: boolean;
	readonly supportsRotation: boolean;
	readonly supportsRevocation: boolean;
	readonly sponsorExposureMinorUnits: number;
	readonly secretCustodyAvailable: boolean;
};

/** Refs the control plane resolves. Named here, implemented elsewhere. */
// public-contract: bootstrap strategy identity disclosed in deployment offers.
export const PRISMA_BOOTSTRAP_STRATEGY_REF = "bootstrap.prisma.create-db/v1";
// public-contract: claim strategy identity disclosed in deployment offers.
export const PRISMA_CLAIM_STRATEGY_REF = "claim.prisma.database/v1";
// public-contract: compiler identity pinned by Resource Definitions.
export const PRISMA_COMPILER_REF = "compile.prisma.claimable-postgres/v1";
// public-contract: executor identity pinned by Resource Definitions.
export const PRISMA_EXECUTOR_REF = "execute.prisma.claimable-postgres/v1";
// public-contract: permission profile required for provider execution.
export const PRISMA_PERMISSION_PROFILE_REF =
	"permissions.prisma.anonymous-create/v1";
// public-contract: evidence identity bound to the audited adapter version.
export const PRISMA_TRUST_EVIDENCE_REF = `hobo.evidence/provider-prisma-postgres/create-db@${PINNED_CREATE_DB_VERSION}#${PRISMA_EVIDENCE_CHECKED_AT}`;
// public-contract: guest lease template identity disclosed in offers.
export const PRISMA_GUEST_LEASE_TEMPLATE_REF =
	"lease.prisma.temporary-database/v1";

/**
 * Placement is genuinely constrained here, and saying so beats letting the
 * planner discover it at execution time: the pinned CLI accepts six region ids
 * and nothing else, and without `--region` it geolocates the calling host,
 * which is not a placement decision anyone made.
 */
export const PRISMA_PLACEMENT_CONSTRAINTS: readonly PlacementConstraint[] = [
	{
		key: "region",
		operator: "in",
		values: [
			"ap-northeast-1",
			"ap-southeast-1",
			"eu-central-1",
			"eu-west-3",
			"us-east-1",
			"us-west-1",
		],
	},
	{ key: "cloud", operator: "equals", values: ["aws"] },
];

/**
 * Remediation hints are read by a human staring at a failed plan, so each one
 * names the next action rather than restating the failure.
 */
export const PRISMA_REMEDIATION: readonly RemediationHint[] = [
	{
		code: "STRONG_CLAIM_REQUIRED",
		message:
			'Prisma does not document whether the pre-claim connection string survives a workspace transfer, so this product ships creatorAuthorityAfterClaim: "unknown". Verify rotation in the Prisma console, then register the candidate with createPrismaClaimablePostgresCandidate({ creatorAuthorityAfterClaim: "rotatable", supportsRotation: true }).',
	},
	{
		code: "PROVIDER_RATE_LIMITED",
		message:
			"The create service rate-limits at 100 requests per minute across all callers. Honour retryAfterMs; do not retry in a loop, and do not spread the load across identities.",
	},
	{
		code: "LEASE_EXPIRED",
		message: `An unclaimed database is reaped after ${PRISMA_DOCUMENTED_TTL_HOURS} hours. Complete the claim ceremony at the claim URL before the deadline, or provision a replacement — expired data is not recoverable.`,
	},
	{
		code: "PROVIDER_OPERATION_AMBIGUOUS",
		message:
			"There is no read-by-id API for a temporary database, so an unresolved create cannot be reconciled from the provider. Observe the local journal and resolve the intent by hand rather than re-running the CLI, which would orphan a second project.",
	},
	{
		code: "MIGRATION_FAILED",
		message:
			"Only migration.postgres.pg-dump/v1 is offered. Logical replication is not documented for the temporary tier; use a dump/restore cutover with a write freeze.",
	},
];

/** Non-secret facts a bundled claim strategy reads off the product record. */
// public-contract: provider resource kind used by claim inventory.
export const PRISMA_ASSOCIATED_RESOURCE_KIND = "prisma-postgres-project";

export type PrismaSemanticsOverrides = PrismaCandidateOverrides;

/**
 * Build the semantics block. Overrides mirror the candidate builder so a
 * catalog owner changes a fact once and both views move together.
 */
export function createPrismaClaimablePostgresSemantics(
	overrides: PrismaSemanticsOverrides = {},
): ProductSemantics {
	const candidate = createPrismaClaimablePostgresCandidate(overrides);
	return {
		schemaVersion: RESOURCE_DEFINITION_VNEXT_SCHEMA,
		productId: "prisma.claimable-postgres",
		displayName: "Prisma Postgres (temporary, claimable)",
		implementsProfiles: candidate.implementsProfiles,
		runtimeModels: candidate.runtimeModels,
		structuredCapabilities: candidate.structuredCapabilities,
		placementConstraints: PRISMA_PLACEMENT_CONSTRAINTS,
		producesBindingProfiles: candidate.producesBindingProfiles,
		migrationProfiles: candidate.migrationProfiles,
		bootstrapStrategyRef: PRISMA_BOOTSTRAP_STRATEGY_REF,
		guestLeaseTemplateRef: PRISMA_GUEST_LEASE_TEMPLATE_REF,
		claimStrategyRef: PRISMA_CLAIM_STRATEGY_REF,
		compilerRef: PRISMA_COMPILER_REF,
		executorRef: PRISMA_EXECUTOR_REF,
		permissionProfileRef: PRISMA_PERMISSION_PROFILE_REF,
		trustEvidenceRef: PRISMA_TRUST_EVIDENCE_REF,
		sourceEvidenceRefs: [
			"https://docs.prisma.io/docs/postgres/npx-create-db",
			`https://www.npmjs.com/package/create-db/v/${PINNED_CREATE_DB_VERSION}`,
			"https://github.com/prisma/create-db",
		],
		remediation: PRISMA_REMEDIATION,
		providerClass: candidate.providerClass,
		...(candidate.evidenceExpiresAtMs !== undefined
			? { evidenceExpiresAtMs: candidate.evidenceExpiresAtMs }
			: undefined),
		evidenceSignatureValid: candidate.evidenceSignatureValid,
		creatorAuthorityAfterClaim: candidate.creatorAuthorityAfterClaim,
		claimAtomicity: candidate.claimAtomicity,
		claimActionCount: candidate.claimActionCount,
		continuity: candidate.continuity,
		supportsExport: candidate.supportsExport,
		supportsRotation: candidate.supportsRotation,
		supportsRevocation: candidate.supportsRevocation,
		sponsorExposureMinorUnits: candidate.sponsorExposureMinorUnits,
		secretCustodyAvailable: candidate.secretCustodyAvailable,
	};
}

export const PRISMA_CLAIMABLE_POSTGRES_SEMANTICS: ProductSemantics =
	createPrismaClaimablePostgresSemantics();

/** Structural mirror of the legacy half of `ResourceDefinition`. */
export type LegacyDefinitionFields = {
	readonly id: string;
	readonly providerId: string;
	readonly port: string;
	readonly features: readonly string[];
	readonly regions: readonly string[];
	readonly specificity: number;
	readonly priority: number;
	readonly cost: {
		readonly sku: string;
		readonly unit: string;
		readonly marginalPrice: string;
	};
};

export type PrismaResourceDefinition = LegacyDefinitionFields & {
	readonly semantics: ProductSemantics;
	satisfies(request: { port: string; features?: string[] }): {
		readonly kind: "full" | "partial" | "none";
		readonly missing?: readonly string[];
	};
};

/** Legacy port/feature vocabulary, kept so an older catalog can still match. */
// public-contract: legacy port retained for compatibility reporting.
export const PRISMA_LEGACY_PORT = "data";
export const PRISMA_LEGACY_FEATURES: readonly string[] = [
	"postgres",
	"sql",
	"transactions",
	"anonymous-bootstrap",
	"claimable",
	"temporary",
];

/**
 * The full catalog record.
 *
 * `satisfies` is the one function on it, and it is pure: a total comparison
 * over the declared feature set, with no clock and no I/O. The real decision
 * lives in profile matching over `semantics`; this exists so a definition
 * loaded by an older planner still resolves rather than disappearing.
 */
export function createPrismaResourceDefinition(
	overrides: PrismaSemanticsOverrides = {},
): PrismaResourceDefinition {
	const semantics = createPrismaClaimablePostgresSemantics(overrides);
	return {
		id: PRISMA_DEFINITION_ID,
		providerId: PRISMA_PROVIDER_ID,
		port: PRISMA_LEGACY_PORT,
		features: PRISMA_LEGACY_FEATURES,
		regions: PRISMA_PLACEMENT_CONSTRAINTS[0]?.values ?? [],
		// Specific: one product, one capability, one tier.
		specificity: 10,
		// Below a paid managed Postgres. A 24-hour database should never win a
		// tie against something that survives the night.
		priority: 10,
		// Free on the provider's own allowance, and HoBo sponsors nothing.
		cost: {
			sku: PRISMA_DEFINITION_ID,
			unit: "database-hour",
			marginalPrice: "0",
		},
		semantics,
		satisfies(request) {
			if (request.port !== PRISMA_LEGACY_PORT) return { kind: "none" };
			const missing = (request.features ?? []).filter(
				(feature) => !PRISMA_LEGACY_FEATURES.includes(feature),
			);
			if (missing.length === 0) return { kind: "full" };
			return { kind: "partial", missing };
		},
	};
}

export const PRISMA_RESOURCE_DEFINITION: PrismaResourceDefinition =
	createPrismaResourceDefinition();

/**
 * The selection view, for a caller that already has the semantics block and
 * wants what `toSelectionCandidate` would produce without importing the
 * control plane.
 */
export const PRISMA_SELECTION_CANDIDATE = PRISMA_CLAIMABLE_POSTGRES_CANDIDATE;

export { PRISMA_CONFORMANCE_REF, PRISMA_PROFILE_IMPLEMENTATIONS };
