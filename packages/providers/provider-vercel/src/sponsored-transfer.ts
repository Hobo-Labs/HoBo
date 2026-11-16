/**
 * `vercel.sponsored-project-transfer/v1` — the honest name for what Vercel's
 * Claim Deployments flow actually is.
 *
 * HoBo creates a real Vercel project and deployment with a real, tightly scoped
 * **sponsoring** credential inside an isolated project boundary, then hands
 * ownership to a human through a project transfer request. Nothing about it is
 * anonymous: there is an account, there is a payer, and the payer is HoBo until
 * the human clicks Transfer. {@link SPONSORED_PROJECT_TRANSFER_BOOTSTRAP} states
 * that in the offer, and `sponsorExposureMinorUnits > 0` states it to Matching —
 * which, under `DEFAULT_TRUST_POLICY` (`sponsorBudgetMinorUnits: 0`), means this
 * definition is not selectable until an operator funds a budget on purpose.
 *
 * Vercel presents ONE ceremony that moves the project and its associated
 * marketplace resources together. That presentation is not an atomicity
 * guarantee: the accept flow calls the resource provider's own verify/accept
 * endpoints, each of which has its own documented failure modes. So this module
 * emits **two** {@link ClaimItem}s — application and database — with atomicity
 * `provider-bundled`, and the shared `@hobo/claims` reducer is what refuses to
 * call a half-finished bundle a success.
 *
 * Vercel Drop (`./temporary-station.js`) is a different product and stays
 * separate. Drop requires a Vercel account to claim the resulting project, so it
 * is not direct anonymous deployment either.
 */

import type { SelectionCandidate } from "@hobo/capability-profiles";
import {
	type ClaimBundle,
	type ClaimCommand,
	type ClaimCoordinatorState,
	ClaimError,
	type ClaimEvent,
	type ClaimItem,
	claimAtomicityOf,
	type GuestLease,
	type Instant,
	reduce,
} from "@hobo/claims";

import { VercelProviderError } from "./provider-errors.js";

const CHECKED = "2026-08-08";

/** A third-party fact with the URL it came from and the date it was read. */
// parallel-type-allowed: the proto VerifiedSourceRef is the design-time contract view and this package wires no buf codegen, so nothing generated exists to import; the TypeScript form is what the frozen source tables are authored as, with checkedOn kept a literal date string rather than a wire timestamp.
export type VerifiedSourceRef = {
	readonly url: string;
	/** UTC `YYYY-MM-DD` a human/agent actually read the page. */
	readonly checkedOn: string;
	readonly note: string;
};

// public-contract: the definition id Matching and receipts pin.
export const VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID =
	"vercel.sponsored-project-transfer/v1";
// public-contract: provider identifier used in offers and receipts.
export const VERCEL_PROVIDER_ID = "vercel";
// public-contract: stable conformance evidence reference for selection.
export const SPONSORED_PROJECT_TRANSFER_CONFORMANCE_REF =
	"conformance.vercel.sponsored-project-transfer/v1";

export const SPONSORED_PROJECT_TRANSFER_SOURCES: readonly VerifiedSourceRef[] =
	Object.freeze([
		Object.freeze({
			url: "https://vercel.com/docs/deployments/claim-deployments",
			checkedOn: CHECKED,
			// The literal query string is described rather than written out: the
			// leak scanner treats a claim URL carrying a code as a credential,
			// and a doc note is not worth teaching it exceptions for.
			note: "claim URL is https://vercel.com/claim-deployment with the transfer code in a `code` query parameter and an optional `returnUrl`; associated resources transfer with the project; accept is PUT /projects/transfer-request/:code",
		}),
		Object.freeze({
			url: "https://vercel.com/docs/rest-api/reference/endpoints/projects/create-project-transfer-request",
			checkedOn: CHECKED,
			note: "POST /projects/{idOrName}/transfer-request returns a code valid for 24 hours; optional callbackUrl + callbackSecret webhook signed with HMAC-SHA256; 410 on an expired code",
		}),
		Object.freeze({
			url: "https://vercel.com/docs/integrations/create-integration/marketplace-flows",
			checkedOn: CHECKED,
			note: "resource transfer accept flow calls the integration server twice (verify, then accept) and documents its own failure modes: invalid provider claim id, missing installation, billing plan conflict, resource ownership",
		}),
		Object.freeze({
			url: "https://vercel.com/docs/rest-api/reference/endpoints/projects/find-a-project-by-id-or-name",
			checkedOn: CHECKED,
			note: "GET /v9/projects/{idOrName} returns a required accountId, which is the post-transfer ownership fact",
		}),
		Object.freeze({
			url: "https://vercel.com/docs/rest-api/reference/endpoints/authentication/delete-an-authentication-token",
			checkedOn: CHECKED,
			note: "DELETE /v3/user/tokens/{tokenId} invalidates a token; tokenId 'current' invalidates the authenticating token",
		}),
		Object.freeze({
			url: "https://vercel.com/docs/functions/limitations",
			checkedOn: CHECKED,
			note: "request/response body cap 4.5 MB; Hobby max duration 300s default and maximum; streaming supported",
		}),
	]);

/**
 * Documented lifetime of the transfer code, from the REST reference. It is the
 * human's deadline, so it becomes `ClaimItem.deadline` and `GuestLease.claimBy`
 * rather than a locally invented TTL.
 */
export const PROJECT_TRANSFER_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Marketplace providers Vercel documents as supporting resource transfer with a
 * claim. Verified 2026-08-08 — the docs name three, not one, so recording only
 * Prisma here would understate the surface.
 */
export const RESOURCE_TRANSFER_CAPABLE_MARKETPLACE_PROVIDERS = Object.freeze([
	"neon",
	"prisma",
	"supabase",
] as const);

export type ResourceTransferCapableProvider =
	(typeof RESOURCE_TRANSFER_CAPABLE_MARKETPLACE_PROVIDERS)[number];

/**
 * The associated resource this definition models end to end. The other two
 * documented providers are recorded above but are not wired here, because a
 * transfer path is only real once its verification and rotation steps exist.
 */
export const MODELLED_ASSOCIATED_RESOURCE = Object.freeze({
	marketplaceProvider: "prisma",
	/** The HoBo resource definition that owns this resource's own claim facts. */
	resourceDefinitionId: "prisma.postgres/v1",
	capabilityProfileId: "data.postgres/v1",
	bindingProfileRef: "binding.postgresql/v1",
} as const);

/**
 * HoBo's own sponsor exposure cap in minor currency units, not a Vercel price.
 * Ranking input only: nothing here is billing input, and no vendor signed it.
 */
export const DEFAULT_SPONSOR_EXPOSURE_MINOR_UNITS = 500;

export type BootstrapDisclosure = {
	readonly definitionId: string;
	readonly bootstrapClass: "sponsor";
	/** False, always. There is an account and a payer before the claim. */
	readonly publiclyAnonymous: false;
	readonly sponsorBacked: true;
	readonly initialOwner: "hobo-sponsor";
	readonly costBearerBeforeClaim: "hobo-sponsor";
	readonly costBearerAfterClaim: "claiming-team";
	readonly sponsorExposureMinorUnits: number;
	/** How the sponsoring credential is confined while HoBo owns the project. */
	readonly isolation: {
		readonly boundary: "dedicated-sponsor-team-and-project";
		readonly credentialScope: "single-project-deploy-and-transfer";
		readonly sharedWithOtherTenants: false;
	};
	/** Offer copy. Asserted by test never to describe this as anonymous. */
	readonly offerSummary: string;
	readonly humanClaimActions: number;
	readonly sources: readonly VerifiedSourceRef[];
};

export const SPONSORED_PROJECT_TRANSFER_BOOTSTRAP: BootstrapDisclosure =
	Object.freeze({
		definitionId: VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID,
		bootstrapClass: "sponsor",
		publiclyAnonymous: false,
		sponsorBacked: true,
		initialOwner: "hobo-sponsor",
		costBearerBeforeClaim: "hobo-sponsor",
		costBearerAfterClaim: "claiming-team",
		sponsorExposureMinorUnits: DEFAULT_SPONSOR_EXPOSURE_MINOR_UNITS,
		isolation: Object.freeze({
			boundary: "dedicated-sponsor-team-and-project",
			credentialScope: "single-project-deploy-and-transfer",
			sharedWithOtherTenants: false,
		}),
		offerSummary:
			"HoBo creates this Vercel project with its own sponsoring credential and is the initial owner and cost bearer. You take ownership by accepting a project transfer request, which also moves the connected database. The transfer code expires 24 hours after it is issued.",
		humanClaimActions: 1,
		sources: SPONSORED_PROJECT_TRANSFER_SOURCES,
	} as const);

/**
 * Evidence expiry for the conformance run behind this candidate, as an absolute
 * instant. Selection reads no clock, so this is data, not `Date.now()`.
 */
export const SPONSORED_PROJECT_TRANSFER_EVIDENCE_EXPIRES_AT_MS = Date.UTC(
	2026,
	8,
	7,
);

export type SponsoredCandidateOptions = {
	readonly evidenceExpiresAtMs?: number;
	readonly sponsorExposureMinorUnits?: number;
	readonly hasRegisteredDriver?: boolean;
	readonly secretCustodyAvailable?: boolean;
};

/**
 * The Matching view of this definition.
 *
 * Numeric capability keys are present only where a Vercel doc states them.
 * Anything unread is absent rather than guessed, which makes a `required`
 * feature ask fail closed instead of selecting on a fabricated limit.
 */
export function createVercelSponsoredProjectTransferCandidate(
	options: SponsoredCandidateOptions = {},
): SelectionCandidate {
	const sponsorExposureMinorUnits =
		options.sponsorExposureMinorUnits ?? DEFAULT_SPONSOR_EXPOSURE_MINOR_UNITS;
	if (sponsorExposureMinorUnits <= 0) {
		throw new VercelProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"a sponsor-backed definition must declare a positive sponsor exposure; zero would advertise it as user-funded or anonymous",
		);
	}
	return {
		definitionId: VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID,
		providerId: VERCEL_PROVIDER_ID,
		implementsProfiles: [
			{
				profileId: "web.static/v1",
				versionRange: ">=1",
				realization: "native",
				conformanceRef: SPONSORED_PROJECT_TRANSFER_CONFORMANCE_REF,
				conformance: "pass",
			},
			{
				profileId: "web.hosted/v1",
				versionRange: ">=1",
				realization: "native",
				conformanceRef: SPONSORED_PROJECT_TRANSFER_CONFORMANCE_REF,
				conformance: "pass",
			},
			{
				profileId: "web.ssr/v1",
				versionRange: ">=1",
				realization: "native",
				conformanceRef: SPONSORED_PROJECT_TRANSFER_CONFORMANCE_REF,
				conformance: "pass",
			},
			{
				profileId: "api.http/v1",
				versionRange: ">=1",
				realization: "native",
				conformanceRef: SPONSORED_PROJECT_TRANSFER_CONFORMANCE_REF,
				conformance: "pass",
			},
		],
		runtimeModels: ["serverless_faas", "paas"],
		structuredCapabilities: {
			httpsOnly: true,
			customDomain: true,
			streaming: true,
			streamingResponse: true,
			// Vercel Functions are request/response; no documented upgrade path.
			websocketUpgrade: false,
			egress: true,
			maxBodyBytes: 4_718_592,
			timeoutMs: 300_000,
			// Transfer-shaped facts Matching can gate on directly.
			sponsorBacked: true,
			publiclyAnonymous: false,
			associatedResourceTransfer: true,
			associatedResourceProviders:
				RESOURCE_TRANSFER_CAPABLE_MARKETPLACE_PROVIDERS,
		},
		producesBindingProfiles: ["binding.http/v1"],
		migrationProfiles: [],
		providerClass: "established",
		evidenceExpiresAtMs:
			options.evidenceExpiresAtMs ??
			SPONSORED_PROJECT_TRANSFER_EVIDENCE_EXPIRES_AT_MS,
		evidenceSignatureValid: true,
		// Not "absent": the transfer moves the project out of HoBo's team, but it
		// does not by itself invalidate the sponsoring token's other grants. That
		// only becomes true after the documented revocation step below, so the
		// declaration stops at what the ceremony guarantees.
		creatorAuthorityAfterClaim: "rotatable",
		claimAtomicity: "provider-bundled",
		claimActionCount: 1,
		continuity: {
			endpoint: "preserved",
			data: "preserved",
			credentials: "rotated",
		},
		supportsExport: true,
		supportsRotation: true,
		supportsRevocation: true,
		sponsorExposureMinorUnits,
		hasRegisteredDriver: options.hasRegisteredDriver ?? true,
		secretCustodyAvailable: options.secretCustodyAvailable ?? true,
	};
}

/** The frozen default candidate, for registries that want data not a call. */
export const VERCEL_SPONSORED_PROJECT_TRANSFER_CANDIDATE: SelectionCandidate =
	Object.freeze(createVercelSponsoredProjectTransferCandidate());

/**
 * Sponsor spend is a gate, not a ranking input. Selection already rejects an
 * over-budget candidate; this is the same refusal at provision time, where the
 * budget is a live number rather than a policy constant.
 */
export function assertSponsorBudget(input: {
	readonly exposureMinorUnits: number;
	readonly remainingBudgetMinorUnits: number;
}): void {
	if (input.exposureMinorUnits > input.remainingBudgetMinorUnits) {
		throw new VercelProviderError(
			"SPONSOR_BUDGET_EXCEEDED",
			`sponsor exposure ${input.exposureMinorUnits} exceeds the remaining budget ${input.remainingBudgetMinorUnits}`,
			{
				detail: {
					exposureMinorUnits: input.exposureMinorUnits,
					remainingBudgetMinorUnits: input.remainingBudgetMinorUnits,
				},
			},
		);
	}
}

/** Stable item ids. Two subjects, because there are two ownership facts. */
export const SPONSORED_CLAIM_ITEM_IDS = Object.freeze({
	project: "vercel-project",
	associatedResource: "vercel-associated-resource",
} as const);

export const SPONSORED_CLAIM_STRATEGY_REFS = Object.freeze({
	project: `${VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID}#project`,
	associatedResource: `${VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID}#associated-resource`,
} as const);

export type SponsoredBundleInput = {
	readonly bundleId: string;
	readonly deploymentRef: string;
	readonly projectSubjectRef: string;
	readonly resourceSubjectRef: string;
	/** Provider-issued instant the 24 hour transfer code stops working. */
	readonly transferCodeExpiresAt: Instant;
	/** Opaque handle into the one-time action store. Never the claim URL. */
	readonly oneTimeActionRef?: string;
};

/**
 * Build the claim bundle.
 *
 * `provider-bundled` is asserted rather than assumed: the shared reducer
 * derives atomicity from the items, and both items name Vercel because Vercel
 * is the party running the single ceremony, even though the second subject is a
 * Prisma Postgres database.
 */
export function createSponsoredProjectTransferBundle(
	input: SponsoredBundleInput,
): ClaimBundle {
	const projectItem: ClaimItem = {
		id: SPONSORED_CLAIM_ITEM_IDS.project,
		subjectRef: input.projectSubjectRef,
		subjectKind: "camp",
		providerId: VERCEL_PROVIDER_ID,
		claimStrategyRef: SPONSORED_CLAIM_STRATEGY_REFS.project,
		mode: "project-transfer",
		...(input.oneTimeActionRef !== undefined
			? { oneTimeActionRef: input.oneTimeActionRef }
			: undefined),
		deadline: input.transferCodeExpiresAt,
		continuity: {
			endpoint: "preserved",
			data: "not-applicable",
			credentials: "revoked",
		},
		creatorAuthorityAfterClaim: "unknown",
		verificationRef: "vercel.verify.project-account-id/v1",
		postClaimActions: ["revoke-bootstrap-authority"],
		completedPostClaimActions: [],
		status: "pending",
	};
	const resourceItem: ClaimItem = {
		id: SPONSORED_CLAIM_ITEM_IDS.associatedResource,
		subjectRef: input.resourceSubjectRef,
		subjectKind: "resource",
		providerId: VERCEL_PROVIDER_ID,
		claimStrategyRef: SPONSORED_CLAIM_STRATEGY_REFS.associatedResource,
		mode: "resource-claim",
		...(input.oneTimeActionRef !== undefined
			? { oneTimeActionRef: input.oneTimeActionRef }
			: undefined),
		deadline: input.transferCodeExpiresAt,
		continuity: {
			endpoint: "rebound",
			data: "preserved",
			credentials: "rotated",
		},
		creatorAuthorityAfterClaim: "unknown",
		verificationRef: "vercel.verify.associated-resource-probe/v1",
		postClaimActions: ["rotate-binding", "revoke-bootstrap-authority"],
		completedPostClaimActions: [],
		status: "pending",
	};
	const items = [projectItem, resourceItem];
	return {
		schemaVersion: "hobo.claim-bundle/v1",
		id: input.bundleId,
		deploymentRef: input.deploymentRef,
		items,
		// The database follows the project through Vercel's one ceremony.
		dependencyEdges: [
			{
				fromItemId: SPONSORED_CLAIM_ITEM_IDS.project,
				toItemId: SPONSORED_CLAIM_ITEM_IDS.associatedResource,
			},
		],
		atomicity: claimAtomicityOf(items),
		earliestDeadline: input.transferCodeExpiresAt,
		compensation: {
			// An unclaimed sponsored project keeps costing HoBo money and does
			// not self-expire, so timing out means destroy, not retain.
			onTimeout: "destroy",
			// Vercel documents no rollback of a completed transfer, so a half
			// moved bundle is repaired forward rather than pretend-reversed.
			onPartialClaim: "continue-and-repair",
		},
		status: "pending",
	};
}

export type SponsoredLeaseInput = {
	readonly leaseId: string;
	readonly subjectRef: string;
	readonly createdAt: Instant;
	readonly transferCodeExpiresAt: Instant;
	readonly fencingToken: string;
	readonly costCapRef?: string;
};

/**
 * The guest lease.
 *
 * `expiresAt` is deliberately absent: Vercel does not expire an unclaimed
 * project, which is exactly why the sponsor bears cost and why the cleanup
 * policy is `delete`. `claimBy` is the provider-documented 24 hour code window.
 */
export function createSponsoredProjectTransferLease(
	input: SponsoredLeaseInput,
): GuestLease {
	return {
		schemaVersion: "hobo.guest-lease/v1",
		id: input.leaseId,
		subjectRef: input.subjectRef,
		bootstrapStrategyRef: VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID,
		bootstrapClass: "sponsor",
		createdAt: input.createdAt,
		claimBy: input.transferCodeExpiresAt,
		renewable: false,
		renewalCount: 0,
		...(input.costCapRef !== undefined
			? { costCapRef: input.costCapRef }
			: undefined),
		cleanupPolicy: "delete",
		status: "active",
		fencingToken: input.fencingToken,
	};
}

export type SponsoredBootstrapInput = {
	readonly deploymentRef: string;
	readonly offerId: string;
	readonly offerDigest: string;
	readonly acceptedAt: Instant;
	readonly lease: GuestLease;
	readonly projectSubjectRef: string;
	readonly resourceSubjectRef: string;
	/** One key per logical attempt, so a retried provision cannot double-create. */
	readonly idempotencyKey: string;
};

/**
 * Commands that take an accepted offer to a provisioned, unclaimed deployment.
 *
 * The two `RecordProvisionedSubject` commands are the point: the application and
 * the database are separate ownership facts from the moment they exist, not just
 * at claim time.
 */
export function sponsoredProjectTransferBootstrapCommands(
	input: SponsoredBootstrapInput,
): readonly ClaimCommand[] {
	return [
		{
			kind: "CompileDeploymentOffer",
			deploymentRef: input.deploymentRef,
			offerId: input.offerId,
		},
		{
			kind: "AcceptDeploymentOffer",
			offerId: input.offerId,
			offerDigest: input.offerDigest,
			acceptedAt: input.acceptedAt,
		},
		{ kind: "ReserveGuestLease", lease: input.lease },
		{
			kind: "StartGuestDeployment",
			deploymentRef: input.deploymentRef,
			idempotencyKey: `${input.idempotencyKey}:start`,
		},
		{
			kind: "RecordProvisionedSubject",
			subjectRef: input.projectSubjectRef,
			subjectKind: "camp",
			providerId: VERCEL_PROVIDER_ID,
			idempotencyKey: `${input.idempotencyKey}:project`,
		},
		{
			kind: "RecordProvisionedSubject",
			subjectRef: input.resourceSubjectRef,
			subjectKind: "resource",
			providerId: VERCEL_PROVIDER_ID,
			idempotencyKey: `${input.idempotencyKey}:resource`,
		},
	];
}

/** What the effectful side actually observed for one subject. */
export type SubjectClaimOutcome = {
	readonly observed: "pending" | "claimed" | "expired";
	/** Independent verification result. A provider "yes" is not this. */
	readonly verified: boolean;
	readonly evidenceRef: string;
	readonly rotatedBindingId?: string;
	readonly revocationEvidenceRef?: string;
};

export type SponsoredClaimOutcome = {
	readonly at: Instant;
	readonly bundleId: string;
	readonly project: SubjectClaimOutcome;
	readonly associatedResource: SubjectClaimOutcome;
};

function itemClaimCommands(
	itemId: string,
	outcome: SubjectClaimOutcome,
	at: Instant,
	postClaimActions: readonly string[],
): readonly ClaimCommand[] {
	const commands: ClaimCommand[] = [
		{ kind: "BeginClaimItem", itemId, at },
		{ kind: "ObserveClaimItem", itemId, observedStatus: outcome.observed, at },
	];
	if (outcome.observed !== "claimed") return commands;
	commands.push({
		kind: "VerifyOwnership",
		itemId,
		verified: outcome.verified,
		evidenceRef: outcome.evidenceRef,
		// Authority is only absent once revocation is proven, and the reducer
		// sets that itself when RevokeBootstrapAuthority lands.
		creatorAuthorityAfterClaim: outcome.verified ? "rotatable" : "unknown",
	});
	if (!outcome.verified) return commands;
	if (postClaimActions.includes("rotate-binding")) {
		if (outcome.rotatedBindingId === undefined) {
			throw new VercelProviderError(
				"BINDING_ROTATION_REQUIRED",
				`claim item ${itemId} owes a binding rotation but no rotated binding id was supplied`,
				{ detail: { itemId } },
			);
		}
		commands.push({
			kind: "RotateCapabilityBinding",
			itemId,
			bindingId: outcome.rotatedBindingId,
		});
	}
	if (postClaimActions.includes("revoke-bootstrap-authority")) {
		if (outcome.revocationEvidenceRef === undefined) {
			throw new VercelProviderError(
				"CLAIM_NOT_VERIFIED",
				`claim item ${itemId} owes sponsor-authority revocation but no evidence ref was supplied`,
				{ detail: { itemId } },
			);
		}
		commands.push({
			kind: "RevokeBootstrapAuthority",
			itemId,
			evidenceRef: outcome.revocationEvidenceRef,
		});
	}
	commands.push({ kind: "CompleteClaimItem", itemId, at });
	return commands;
}

/**
 * The command sequence for one observed claim attempt, per item, in dependency
 * order (project first — the database follows it).
 */
export function sponsoredProjectTransferClaimCommands(
	outcome: SponsoredClaimOutcome,
): readonly ClaimCommand[] {
	return [
		{ kind: "BeginClaimBundle", bundleId: outcome.bundleId, at: outcome.at },
		...itemClaimCommands(
			SPONSORED_CLAIM_ITEM_IDS.project,
			outcome.project,
			outcome.at,
			["revoke-bootstrap-authority"],
		),
		...itemClaimCommands(
			SPONSORED_CLAIM_ITEM_IDS.associatedResource,
			outcome.associatedResource,
			outcome.at,
			["rotate-binding", "revoke-bootstrap-authority"],
		),
	];
}

// parallel-type-allowed: the proto SponsoredClaimReport is the design-time contract view and this package wires no buf codegen; the TypeScript form is deliberately narrower — bundleStatus and lifecycle are the `@hobo/claims` unions rather than strings, and failureCode is optional under exactOptionalPropertyTypes so "no failure" cannot be spelled as an empty string.
export type SponsoredClaimReport = {
	readonly bundleStatus: ClaimBundle["status"];
	readonly lifecycle: ClaimCoordinatorState["lifecycle"];
	/** True only when the shared reducer accepted CompleteClaimBundle. */
	readonly atomicSuccess: boolean;
	readonly outstandingItemIds: readonly string[];
	readonly failureCode?: string;
};

export type SponsoredClaimResult = {
	readonly state: ClaimCoordinatorState;
	readonly events: readonly ClaimEvent[];
	readonly report: SponsoredClaimReport;
};

/**
 * Fold an observed claim attempt through the shared `@hobo/claims` reducer.
 *
 * This package owns strategy and data; the reducer owns the invariants. The
 * completion attempt is unconditional on purpose: whether the bundle may be
 * called complete is the reducer's ruling, so a driver bug here cannot promote
 * a half-moved deployment to success.
 */
export function runSponsoredProjectTransferClaim(
	initial: ClaimCoordinatorState,
	outcome: SponsoredClaimOutcome,
	options: { readonly fencingToken: string },
): SponsoredClaimResult {
	let state = initial;
	const events: ClaimEvent[] = [];
	for (const command of sponsoredProjectTransferClaimCommands(outcome)) {
		const result = reduce(state, command, options);
		state = result.state;
		events.push(...result.events);
	}

	let atomicSuccess = false;
	let failureCode: string | undefined;
	try {
		const completed = reduce(
			state,
			{
				kind: "CompleteClaimBundle",
				bundleId: outcome.bundleId,
				at: outcome.at,
			},
			options,
		);
		state = completed.state;
		events.push(...completed.events);
		atomicSuccess = true;
	} catch (error) {
		if (!(error instanceof ClaimError)) throw error;
		failureCode = error.code;
	}

	const items = state.bundle?.items ?? [];
	const outstandingItemIds = items
		.filter((item) => item.status !== "completed")
		.map((item) => item.id);

	return {
		state,
		events,
		report: {
			bundleStatus: state.bundle?.status ?? "pending",
			lifecycle: state.lifecycle,
			atomicSuccess,
			outstandingItemIds,
			...(failureCode !== undefined ? { failureCode } : undefined),
		},
	};
}
