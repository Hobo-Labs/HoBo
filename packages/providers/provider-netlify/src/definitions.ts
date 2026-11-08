/**
 * The Netlify products the catalog selects over.
 *
 * The important structural decision here is that there are *two* of them.
 *
 * `netlify.anonymous-static-site/v1` is deliberately narrow: prebuilt assets on
 * a hosted origin, and nothing else. Netlify Functions and Edge Functions are
 * real Netlify capabilities, but they are not part of the pre-claim anonymous
 * profile this driver can honestly stand behind, so this definition does not
 * claim `api.http/v1` or any `service.*` profile. A Bindle that needs a backend
 * is *rejected* against it rather than deployed into something that will fail
 * later, or claimed as supported and then quietly under-delivered.
 *
 * `netlify.authenticated-site/v1` is where the richer surface lives. Widening the
 * anonymous definition to reach it would make the narrow claim untrue for every
 * caller; a second definition keeps both honest, and Matching picks whichever
 * the requirement and the available credential actually justify.
 */
import type {
	ProfileImplementation,
	SelectionCandidate,
} from "@hobo/capability-profiles";

import {
	NETLIFY_ANONYMOUS_BOOTSTRAP_STRATEGY_REF,
	NETLIFY_ANONYMOUS_CLAIM_STRATEGY_REF,
	NETLIFY_PROVIDER_ID,
} from "./claim-plan.js";
import { NETLIFY_CLI_PACKAGE_SPEC } from "./process-runner.js";
import {
	type ProviderResourceDefinitionData,
	type ProviderSourceRef,
	RESOURCE_DEFINITION_VNEXT_SCHEMA,
	type ResourceDefinitionSemanticsData,
	semanticsToSelectionCandidate,
} from "./resource-definition.js";

// public-contract: stable anonymous-site Resource Definition identifier.
export const NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID =
	"netlify.anonymous-static-site/v1" as const;
// public-contract: stable authenticated-site Resource Definition identifier.
export const NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID =
	"netlify.authenticated-site/v1" as const;

/** Date a human read the official sources listed in the README. */
// public-contract: dates the provider evidence snapshot.
export const NETLIFY_EVIDENCE_CHECKED_AT = "2026-08-08";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export const NETLIFY_SOURCE_REFS: readonly ProviderSourceRef[] = [
	{
		url: "https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/",
		checkedAt: NETLIFY_EVIDENCE_CHECKED_AT,
		note: "Anonymous deploys: `netlify deploy --allow-anonymous` deploys without an account and creates a claimable project; one hour to claim ownership; unclaimed projects are removed after one hour; a claimed project takes the team's default project visibility",
	},
	{
		url: "https://docs.netlify.com/deploy/create-deploys/",
		checkedAt: NETLIFY_EVIDENCE_CHECKED_AT,
		note: "Repeats the anonymous path and the one-hour claim window, and confirms a manual deploy runs no build command",
	},
	{
		url: "https://cli.netlify.com/commands/deploy/",
		checkedAt: NETLIFY_EVIDENCE_CHECKED_AT,
		note: "Flag reference for `deploy`: --allow-anonymous, --json (output deployment data as JSON), --dir, --no-build, --site-name, --message; official example `netlify deploy --allow-anonymous --dir ./public --no-build`",
	},
	{
		url: "https://registry.npmjs.org/netlify-cli/latest",
		checkedAt: NETLIFY_EVIDENCE_CHECKED_AT,
		note: `netlify-cli latest is 27.1.1 (published 2026-08-07); pinned here as ${NETLIFY_CLI_PACKAGE_SPEC}`,
	},
];

const CONFORMANCE_SUFFIX = `@${NETLIFY_EVIDENCE_CHECKED_AT}`;

function implementation(
	profileId: string,
	conformance: ProfileImplementation["conformance"],
): ProfileImplementation {
	return {
		profileId,
		versionRange: ">=1",
		realization: "native",
		conformanceRef: `hobo.conformance/${profileId}#netlify${CONFORMANCE_SUFFIX}`,
		conformance,
	};
}

export type NetlifyDefinitionOverrides = {
	readonly evidenceExpiresAtMs?: number;
	readonly evidenceSignatureValid?: boolean;
	readonly secretCustodyAvailable?: boolean;
	readonly conformance?: ProfileImplementation["conformance"];
};

function baseSemantics(
	overrides: NetlifyDefinitionOverrides,
): Pick<
	ResourceDefinitionSemanticsData,
	| "schemaVersion"
	| "placementConstraints"
	| "migrationProfiles"
	| "providerClass"
	| "evidenceExpiresAtMs"
	| "evidenceSignatureValid"
	| "sourceEvidenceRefs"
	| "secretCustodyAvailable"
> {
	return {
		schemaVersion: RESOURCE_DEFINITION_VNEXT_SCHEMA,
		placementConstraints: [],
		migrationProfiles: [],
		// Netlify is a long-established provider; this is a maturity class, not
		// an endorsement or a partnership claim.
		providerClass: "established",
		evidenceExpiresAtMs:
			overrides.evidenceExpiresAtMs ??
			Date.parse(NETLIFY_EVIDENCE_CHECKED_AT) + NINETY_DAYS_MS,
		evidenceSignatureValid: overrides.evidenceSignatureValid ?? true,
		sourceEvidenceRefs: NETLIFY_SOURCE_REFS.map((source) => source.url),
		secretCustodyAvailable: overrides.secretCustodyAvailable ?? true,
	};
}

/**
 * The narrow pre-claim product.
 *
 * `sponsorExposureMinorUnits` is 0 and that is a fact, not an omission: nobody
 * pays for an anonymous Netlify deploy, which is exactly what distinguishes this
 * from a sponsor-backed path where HoBo is the cost bearer.
 */
export function createNetlifyAnonymousStaticSiteDefinition(
	overrides: NetlifyDefinitionOverrides = {},
): ProviderResourceDefinitionData {
	const conformance = overrides.conformance ?? "pass";
	return {
		id: NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID,
		providerId: NETLIFY_PROVIDER_ID,
		port: "compute",
		semantics: {
			...baseSemantics(overrides),
			productId: "netlify.anonymous-static-site",
			displayName: "Netlify anonymous static site (claimable within one hour)",
			// web.static/v1 and web.hosted/v1 ONLY. Functions and edge functions
			// are out of scope for the anonymous profile by construction.
			implementsProfiles: [
				implementation("web.static/v1", conformance),
				implementation("web.hosted/v1", conformance),
			],
			// `paas` is the honest fit: Netlify manages the origin. There is no
			// `static_site` runtime model, and claiming `serverless_faas` here
			// would imply the functions this profile deliberately excludes.
			runtimeModels: ["paas"],
			structuredCapabilities: {
				bootstrap: "anonymous-claimable",
				anonymousDeployment: true,
				// No HoBo account and no HoBo money are involved.
				sponsorOwnsProviderAccount: false,
				claimBoundary: "site",
				claimCeremony: "single-resource",
				claimDeadlineHours: 1,
				expirySource: "documented-window",
				cliPackage: NETLIFY_CLI_PACKAGE_SPEC,
				httpsOnly: true,
				immutableCaching: true,
				customRedirects: true,
				customHeaders: true,
				spaFallback: true,
				// Attaching a custom domain needs an owner, so it is a
				// post-claim capability rather than a pre-claim one.
				customDomain: false,
				// Deliberately declared false rather than omitted, so a
				// requirement that asks for a backend is refused with a reason.
				serverlessFunctions: false,
				edgeFunctions: false,
				serverSideRendering: false,
			},
			producesBindingProfiles: ["binding.http/v1"],
			bootstrapStrategyRef: NETLIFY_ANONYMOUS_BOOTSTRAP_STRATEGY_REF,
			guestLeaseTemplateRef: "hobo.guest-lease/netlify.anonymous/v1",
			claimStrategyRef: NETLIFY_ANONYMOUS_CLAIM_STRATEGY_REF,
			compilerRef: "compile.netlify.anonymous-static-site/v1",
			executorRef: "execute.netlify.anonymous-static-site/v1",
			permissionProfileRef: "permissions.netlify.anonymous-cli/v1",
			trustEvidenceRef: `hobo.evidence/provider-netlify/anonymous-static-site${CONFORMANCE_SUFFIX}`,
			remediation: [
				{
					code: "claim.window-elapsed",
					message:
						"The documented one hour claim window elapsed and Netlify removed the unclaimed project. Re-deploy; there is nothing to recover.",
				},
				{
					code: "claim.anonymous-authority-remains",
					message:
						"The pre-claim anonymous claim material still works after the claim. Treat the site as not yet handed over until that material is proven unusable or explicitly rotated.",
				},
				{
					code: "profile.backend-required",
					message:
						"This product serves prebuilt assets only. A requirement for api.http/v1 or a service.* profile needs netlify.authenticated-site/v1 (or another provider), not a wider anonymous claim.",
				},
			],
			creatorAuthorityAfterClaim: "rotatable",
			claimAtomicity: "single-resource",
			claimActionCount: 1,
			continuity: {
				endpoint: "preserved",
				data: "preserved",
				credentials: "revoked",
			},
			// No export driver is implemented for a Netlify site, and an
			// unimplemented export path is worse than an absent one.
			supportsExport: false,
			supportsRotation: false,
			supportsRevocation: true,
			sponsorExposureMinorUnits: 0,
		},
	};
}

/**
 * The authenticated product, kept separate on purpose.
 *
 * This is where Functions and Edge Functions live. It needs a Netlify token, so
 * its bootstrap class is not anonymous and there is no claim ceremony: the
 * account already belongs to the operator.
 */
export function createNetlifyAuthenticatedSiteDefinition(
	overrides: NetlifyDefinitionOverrides = {},
): ProviderResourceDefinitionData {
	const conformance = overrides.conformance ?? "pass";
	return {
		id: NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID,
		providerId: NETLIFY_PROVIDER_ID,
		port: "compute",
		semantics: {
			...baseSemantics(overrides),
			productId: "netlify.authenticated-site",
			displayName: "Netlify site deployed with an operator credential",
			implementsProfiles: [
				implementation("web.static/v1", conformance),
				implementation("web.hosted/v1", conformance),
				implementation("web.ssr/v1", conformance),
				implementation("api.http/v1", conformance),
			],
			runtimeModels: ["paas", "serverless_faas"],
			structuredCapabilities: {
				bootstrap: "operator-credential",
				anonymousDeployment: false,
				sponsorOwnsProviderAccount: false,
				claimBoundary: "none",
				httpsOnly: true,
				immutableCaching: true,
				customRedirects: true,
				customHeaders: true,
				spaFallback: true,
				customDomain: true,
				streamingResponse: true,
				streaming: true,
				egress: true,
				serverlessFunctions: true,
				edgeFunctions: true,
				serverSideRendering: true,
			},
			producesBindingProfiles: ["binding.http/v1"],
			// Nothing to bootstrap and nothing to claim: the operator owns the
			// account before the first deploy.
			bootstrapStrategyRef: "bootstrap.netlify.operator-credential/v1",
			claimStrategyRef: "claim.none/v1",
			compilerRef: "compile.netlify.authenticated-site/v1",
			// Empty on purpose, which makes `hasRegisteredDriver` false and this
			// candidate unselectable. The definition describes the shape of the
			// authenticated surface so the anonymous one does not have to be
			// widened to cover it — but this package ships no authenticated
			// driver, and advertising one would let Matching pick a product
			// with nothing behind it.
			executorRef: "",
			permissionProfileRef: "permissions.netlify.operator-token/v1",
			trustEvidenceRef: `hobo.evidence/provider-netlify/authenticated-site${CONFORMANCE_SUFFIX}`,
			remediation: [
				{
					code: "auth.token-required",
					message:
						"This product needs a Netlify personal access token in custody. Use netlify.anonymous-static-site/v1 for a pre-account deployment.",
				},
			],
			creatorAuthorityAfterClaim: "absent",
			claimAtomicity: "single-resource",
			claimActionCount: 0,
			continuity: {
				endpoint: "preserved",
				data: "preserved",
				credentials: "not-applicable",
			},
			supportsExport: false,
			supportsRotation: true,
			supportsRevocation: true,
			sponsorExposureMinorUnits: 0,
		},
	};
}

export const NETLIFY_DEFINITIONS: readonly ProviderResourceDefinitionData[] = [
	createNetlifyAnonymousStaticSiteDefinition(),
	createNetlifyAuthenticatedSiteDefinition(),
	createNetlifyStaticDeployDefinition(),
];

export const NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE: SelectionCandidate =
	semanticsToSelectionCandidate(createNetlifyAnonymousStaticSiteDefinition());

export const NETLIFY_AUTHENTICATED_SITE_CANDIDATE: SelectionCandidate =
	semanticsToSelectionCandidate(createNetlifyAuthenticatedSiteDefinition());

export const NETLIFY_CANDIDATES: readonly SelectionCandidate[] =
	NETLIFY_DEFINITIONS.map(semanticsToSelectionCandidate);

/** Immutable prebuilt deployment; the account-backed site's function/SSR
 * capabilities are not claimed by the static artifact driver. */
export function createNetlifyStaticDeployDefinition(
	overrides: NetlifyDefinitionOverrides = {},
): ProviderResourceDefinitionData {
	const base = createNetlifyAuthenticatedSiteDefinition(overrides),
		conformance = overrides.conformance ?? "pass";
	return {
		...base,
		id: "netlify.static-deploy/v1",
		semantics: {
			...base.semantics,
			productId: "netlify.static-deploy/v1",
			displayName: "Netlify immutable static deployment in an owned site",
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
				edgeFunctions: false,
				serverSideRendering: false,
			},
			compilerRef: "compile.netlify.static-deploy/v1",
			executorRef: "execute.netlify.static-deploy/v1",
			supportsExport: false,
			supportsRotation: false,
		},
	};
}
