/**
 * The sponsor-backed Vercel products the catalog selects over.
 *
 * These are *data*. The single most important fact they carry is that HoBo is
 * the initial owner and the cost bearer: `bootstrapStrategyRef` is
 * `bootstrap.vercel.sponsored/v1`, `bootstrapClass` on the lease is `sponsor`,
 * and `sponsorExposureMinorUnits` is greater than zero, which is what makes a
 * trust policy with `allowSponsor: false` or a zero sponsor budget reject them.
 *
 * Vercel is never classified as direct anonymous. Vercel Drop still requires a
 * Vercel account, so it is not an anonymous deployment path either; it lives in
 * `temporary-station.ts` and is deliberately not described by these
 * definitions.
 */
import type {
	ProfileImplementation,
	SelectionCandidate,
} from "@hobo/capability-profiles";

import {
	type ProviderResourceDefinitionData,
	type ProviderSourceRef,
	RESOURCE_DEFINITION_VNEXT_SCHEMA,
	type ResourceDefinitionSemanticsData,
	semanticsToSelectionCandidate,
} from "./resource-definition.js";
import {
	RESOURCE_TRANSFER_CAPABLE_MARKETPLACE_PROVIDERS,
	VERCEL_PROVIDER_ID,
	VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID,
} from "./sponsored-transfer.js";

/**
 * Product-level definition ids.
 *
 * They are separate from the *strategy* id
 * ({@link VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID}) because one transfer
 * ceremony backs three offers: a sponsored site, a sponsored HTTP API, and a
 * sponsored deployment handed over together with its marketplace database.
 */
// public-contract: stable sponsored-web Resource Definition identifier.
export const VERCEL_SPONSORED_WEB_DEFINITION_ID =
	"vercel.sponsored-web/v1" as const;
// public-contract: stable sponsored-API Resource Definition identifier.
export const VERCEL_SPONSORED_API_DEFINITION_ID =
	"vercel.sponsored-api/v1" as const;
// public-contract: stable ownership-claim Resource Definition identifier.
export const VERCEL_CLAIM_DEPLOYMENT_DEFINITION_ID =
	"vercel.claim-deployment/v1" as const;

/** Bootstrap strategy every sponsored Vercel product is provisioned through. */
// public-contract: bootstrap strategy disclosed before deployment.
export const VERCEL_BOOTSTRAP_STRATEGY_REF =
	"bootstrap.vercel.sponsored/v1" as const;
/** The transfer ceremony that claims them. */
export const VERCEL_CLAIM_STRATEGY_REF =
	VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID;

/** Date a human read the official sources listed in the README. */
// public-contract: dates the provider evidence snapshot.
export const VERCEL_EVIDENCE_CHECKED_AT = "2026-08-08";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Sponsor exposure per sponsored deployment, in minor currency units.
 *
 * This is a HoBo-side budget marker, not a Vercel price: no vendor price is
 * transcribed here. Its only load-bearing property is being greater than zero,
 * which forces sponsor-aware trust policy to make a decision instead of
 * treating the product as free.
 */
export const VERCEL_SPONSOR_EXPOSURE_MINOR_UNITS = 100;

export const VERCEL_SOURCE_REFS: readonly ProviderSourceRef[] = [
	{
		url: "https://vercel.com/docs/deployments/claim-deployments",
		checkedAt: VERCEL_EVIDENCE_CHECKED_AT,
		note: "Claim URL https://vercel.com/claim-deployment?code=&returnUrl=, the transfer-request/accept endpoints, and the associated-resource providers that support transfer (Neon, Supabase, Prisma)",
	},
	{
		url: "https://vercel.com/docs/rest-api/projects/create-project-transfer-request",
		checkedAt: VERCEL_EVIDENCE_CHECKED_AT,
		note: "POST /projects/{idOrName}/transfer-request returns { code }, valid for 24 hours; documents 401, 403, and 410 responses",
	},
	{
		url: "https://vercel.com/docs/integrations/create-integration/marketplace-flows",
		checkedAt: VERCEL_EVIDENCE_CHECKED_AT,
		note: "Resources with Claim Deployments: verify/accept callbacks are implemented by the integration provider; credential rotation syncs environment variables but does not redeploy",
	},
	{
		url: "https://vercel.com/docs/rest-api/authentication/delete-an-authentication-token",
		checkedAt: VERCEL_EVIDENCE_CHECKED_AT,
		note: "DELETE /v3/user/tokens/{tokenId} invalidates an authentication token for future requests",
	},
	{
		url: "https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name",
		checkedAt: VERCEL_EVIDENCE_CHECKED_AT,
		note: "GET /v9/projects/{idOrName} returns the project with a required accountId, which is the ownership fact this driver re-reads",
	},
];

const CONFORMANCE_SUFFIX = `@${VERCEL_EVIDENCE_CHECKED_AT}`;

function implementation(
	profileId: string,
	conformance: ProfileImplementation["conformance"],
): ProfileImplementation {
	return {
		profileId,
		versionRange: ">=1",
		realization: "native",
		conformanceRef: `hobo.conformance/${profileId}#vercel.sponsored${CONFORMANCE_SUFFIX}`,
		conformance,
	};
}

export type VercelDefinitionOverrides = {
	readonly evidenceExpiresAtMs?: number;
	readonly evidenceSignatureValid?: boolean;
	readonly secretCustodyAvailable?: boolean;
	readonly conformance?: ProfileImplementation["conformance"];
	readonly sponsorExposureMinorUnits?: number;
};

/** Facts every sponsored Vercel product shares. */
function baseSemantics(
	overrides: VercelDefinitionOverrides,
): Omit<
	ResourceDefinitionSemanticsData,
	| "productId"
	| "displayName"
	| "implementsProfiles"
	| "structuredCapabilities"
	| "runtimeModels"
> {
	return {
		schemaVersion: RESOURCE_DEFINITION_VNEXT_SCHEMA,
		placementConstraints: [],
		producesBindingProfiles: ["binding.http/v1"],
		migrationProfiles: [],
		bootstrapStrategyRef: VERCEL_BOOTSTRAP_STRATEGY_REF,
		guestLeaseTemplateRef: "hobo.guest-lease/vercel.sponsored/v1",
		claimStrategyRef: VERCEL_CLAIM_STRATEGY_REF,
		compilerRef: "compile.vercel.sponsored-transfer/v1",
		executorRef: "execute.vercel.sponsored-transfer/v1",
		permissionProfileRef: "permissions.vercel.sponsor-token/v1",
		trustEvidenceRef: `hobo.evidence/provider-vercel/sponsored-project-transfer${CONFORMANCE_SUFFIX}`,
		sourceEvidenceRefs: VERCEL_SOURCE_REFS.map((source) => source.url),
		remediation: [
			{
				code: "claim.transfer-code-expired",
				message:
					"The transfer code passed its documented 24 hour window. Request a new transfer code; the deployment itself is unaffected.",
			},
			{
				code: "claim.resource-not-transferred",
				message:
					"The project moved but an associated marketplace resource did not. Confirm the target team has the provider's integration installed and can accept its billing plan, then repair the resource item.",
			},
			{
				code: "claim.sponsor-authority-remains",
				message:
					"The sponsoring credential can still reach the project. Revoke the deployment tokens issued before the claim before reporting the claim complete.",
			},
		],
		// Vercel is a long-established provider; this is a maturity class, not
		// an endorsement or a partnership claim.
		providerClass: "established",
		evidenceExpiresAtMs:
			overrides.evidenceExpiresAtMs ??
			Date.parse(VERCEL_EVIDENCE_CHECKED_AT) + NINETY_DAYS_MS,
		evidenceSignatureValid: overrides.evidenceSignatureValid ?? true,
		// The sponsoring token keeps working after the transfer until it is
		// revoked, so authority is removable rather than absent by default.
		creatorAuthorityAfterClaim: "rotatable",
		claimAtomicity: "provider-bundled",
		claimActionCount: 1,
		continuity: {
			endpoint: "preserved",
			data: "preserved",
			credentials: "revoked",
		},
		// No export driver is implemented for a Vercel project, and an
		// unimplemented export path is worse than an absent one.
		supportsExport: false,
		supportsRotation: true,
		supportsRevocation: true,
		sponsorExposureMinorUnits:
			overrides.sponsorExposureMinorUnits ??
			VERCEL_SPONSOR_EXPOSURE_MINOR_UNITS,
		secretCustodyAvailable: overrides.secretCustodyAvailable ?? true,
	};
}

/** Facts common to every sponsored product, exposed for ranking. */
function sponsoredCapabilities() {
	return {
		bootstrap: "sponsor-backed",
		// HoBo owns the Vercel account and bears the cost until a human claims.
		sponsorOwnsProviderAccount: true,
		anonymousDeployment: false,
		claimBoundary: "project",
		claimCeremony: "provider-bundled",
		claimDeadlineHours: 24,
		// The transfer-request response has no expiry field, so the deadline is
		// derived from the documented window and labelled as such.
		expirySource: "documented-window",
		transferableResourceProducts:
			RESOURCE_TRANSFER_CAPABLE_MARKETPLACE_PROVIDERS,
		httpsOnly: true,
	};
}

export function createVercelSponsoredWebDefinition(
	overrides: VercelDefinitionOverrides = {},
): ProviderResourceDefinitionData {
	const conformance = overrides.conformance ?? "pass";
	return {
		id: VERCEL_SPONSORED_WEB_DEFINITION_ID,
		providerId: VERCEL_PROVIDER_ID,
		port: "compute",
		semantics: {
			...baseSemantics(overrides),
			productId: "vercel.sponsored-web",
			displayName: "Vercel sponsored web deployment (claimable)",
			implementsProfiles: [
				implementation("web.static/v1", conformance),
				implementation("web.hosted/v1", conformance),
				implementation("web.ssr/v1", conformance),
			],
			runtimeModels: ["serverless_faas", "paas"],
			structuredCapabilities: {
				...sponsoredCapabilities(),
				customDomain: true,
				streamingResponse: true,
			},
		},
	};
}

export function createVercelSponsoredApiDefinition(
	overrides: VercelDefinitionOverrides = {},
): ProviderResourceDefinitionData {
	const conformance = overrides.conformance ?? "pass";
	return {
		id: VERCEL_SPONSORED_API_DEFINITION_ID,
		providerId: VERCEL_PROVIDER_ID,
		port: "compute",
		semantics: {
			...baseSemantics(overrides),
			productId: "vercel.sponsored-api",
			displayName: "Vercel sponsored HTTP API (claimable)",
			implementsProfiles: [implementation("api.http/v1", conformance)],
			runtimeModels: ["serverless_faas"],
			structuredCapabilities: {
				...sponsoredCapabilities(),
				streaming: true,
				egress: true,
			},
		},
	};
}

/**
 * The claim-deployment product: a sponsored deployment handed over *with* its
 * associated marketplace resources.
 *
 * It costs two human actions rather than one — the dashboard ceremony, then
 * the owner rotating the database credential the sponsor still holds — and its
 * credential continuity is `rotated`, not `revoked`.
 */
export function createVercelClaimDeploymentDefinition(
	overrides: VercelDefinitionOverrides = {},
): ProviderResourceDefinitionData {
	const conformance = overrides.conformance ?? "pass";
	return {
		id: VERCEL_CLAIM_DEPLOYMENT_DEFINITION_ID,
		providerId: VERCEL_PROVIDER_ID,
		port: "compute",
		semantics: {
			...baseSemantics(overrides),
			productId: "vercel.claim-deployment",
			displayName: "Vercel claimable deployment with associated resources",
			implementsProfiles: [
				implementation("web.static/v1", conformance),
				implementation("web.hosted/v1", conformance),
			],
			runtimeModels: ["serverless_faas", "paas"],
			structuredCapabilities: {
				...sponsoredCapabilities(),
				associatedResourceTransfer: true,
				customDomain: true,
			},
			producesBindingProfiles: ["binding.http/v1", "binding.postgresql/v1"],
			requiresConnectivityProfiles: ["vercel.postgres.environment-ref/v1"],
			claimActionCount: 2,
			continuity: {
				endpoint: "preserved",
				data: "preserved",
				credentials: "rotated",
			},
		},
	};
}

export const VERCEL_SPONSORED_DEFINITIONS: readonly ProviderResourceDefinitionData[] =
	[
		createVercelSponsoredWebDefinition(),
		createVercelSponsoredApiDefinition(),
		createVercelClaimDeploymentDefinition(),
	];

export const VERCEL_SPONSORED_CANDIDATES: readonly SelectionCandidate[] =
	VERCEL_SPONSORED_DEFINITIONS.map(semanticsToSelectionCandidate);

/** Native immutable static deployment using an operator-owned project. */
export function createVercelStaticDeployDefinition(
	overrides: VercelDefinitionOverrides = {},
): ProviderResourceDefinitionData {
	const conformance = overrides.conformance ?? "pass";
	return {
		id: "vercel.static-deploy/v1",
		providerId: VERCEL_PROVIDER_ID,
		port: "compute",
		semantics: {
			schemaVersion: RESOURCE_DEFINITION_VNEXT_SCHEMA,
			productId: "vercel.static-deploy/v1",
			displayName: "Vercel immutable static deployment in an owned project",
			implementsProfiles: [
				implementation("web.static/v1", conformance),
				implementation("web.hosted/v1", conformance),
			],
			runtimeModels: ["paas"],
			structuredCapabilities: {
				bootstrap: "operator-credential",
				anonymousDeployment: false,
				httpsOnly: true,
				immutableArtifact: true,
				serverlessFunctions: false,
				serverSideRendering: false,
			},
			placementConstraints: [],
			producesBindingProfiles: ["binding.http/v1"],
			migrationProfiles: [],
			bootstrapStrategyRef: "bootstrap.vercel.operator-credential/v1",
			claimStrategyRef: "claim.none/v1",
			compilerRef: "compile.vercel.static-deploy/v1",
			executorRef: "execute.vercel.static-deploy/v1",
			permissionProfileRef: "permissions.vercel.operator-token/v1",
			trustEvidenceRef: `hobo.evidence/provider-vercel/static-deploy${CONFORMANCE_SUFFIX}`,
			sourceEvidenceRefs: [
				"https://vercel.com/docs/rest-api/reference/endpoints/deployments/create-a-new-deployment",
			],
			remediation: [],
			providerClass: "established",
			evidenceExpiresAtMs:
				overrides.evidenceExpiresAtMs ??
				Date.parse(VERCEL_EVIDENCE_CHECKED_AT) + NINETY_DAYS_MS,
			evidenceSignatureValid: overrides.evidenceSignatureValid ?? true,
			creatorAuthorityAfterClaim: "absent",
			claimAtomicity: "single-resource",
			claimActionCount: 0,
			continuity: {
				endpoint: "preserved",
				data: "not-applicable",
				credentials: "not-applicable",
			},
			supportsExport: false,
			supportsRotation: false,
			supportsRevocation: true,
			sponsorExposureMinorUnits: 0,
			secretCustodyAvailable: overrides.secretCustodyAvailable ?? true,
		},
	};
}
export const VERCEL_DEFINITIONS: readonly ProviderResourceDefinitionData[] = [
	...VERCEL_SPONSORED_DEFINITIONS,
	createVercelStaticDeployDefinition(),
];
