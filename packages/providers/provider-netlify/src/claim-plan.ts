/**
 * The pure claim compiler for `netlify.anonymous-static-site/v1`.
 *
 * No clock, no network, no randomness, no environment, no filesystem: every
 * instant and identifier arrives as an argument, so the same inputs always
 * compile the same plan and a replay produces the same bundle.
 *
 * The state machine itself lives in `@hobo/claims`. This module only shapes the
 * lease and the bundle the shared reducer then owns — there is deliberately no
 * second lifecycle here.
 *
 * One subject, one ceremony: an anonymous Netlify deploy hands over a site and
 * nothing else, so the bundle is `single-resource`. That is a real difference
 * from a bundled transfer, not a simplification — there is no second ownership
 * fact that can be left behind.
 */
import type {
	ClaimBundle,
	ClaimCommand,
	ClaimItem,
	GuestLease,
	Instant,
} from "@hobo/claims";

import {
	type ExpirySource,
	NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS,
} from "./deploy-output.js";

// public-contract: provider identifier used in offers and receipts.
export const NETLIFY_PROVIDER_ID = "netlify" as const;
// public-contract: claim strategy disclosed before deployment.
export const NETLIFY_ANONYMOUS_CLAIM_STRATEGY_REF =
	"netlify.anonymous-static-site/v1" as const;
// public-contract: bootstrap strategy disclosed before deployment.
export const NETLIFY_ANONYMOUS_BOOTSTRAP_STRATEGY_REF =
	"bootstrap.netlify.anonymous-cli/v1" as const;
// public-contract: ownership verification method used by claim plans.
export const NETLIFY_SITE_VERIFICATION_REF =
	"hobo.verification/netlify.site-claim/v1" as const;

export function siteClaimItemId(deploymentRef: string): string {
	return `${deploymentRef}#site`;
}

export type AnonymousClaimPlanInput = {
	readonly deploymentRef: string;
	readonly siteId: string;
	/** Instant the provider acknowledged the deploy. */
	readonly deployedAtMs: Instant;
	readonly createdAtMs: Instant;
	readonly fencingToken: string;
	/** Provider-reported deadline when there is one. */
	readonly claimDeadlineMs?: Instant;
	readonly expirySource?: ExpirySource;
};

export type AnonymousClaimPlan = {
	readonly lease: GuestLease;
	readonly bundle: ClaimBundle;
	readonly claimDeadlineMs: Instant;
	readonly expirySource: ExpirySource;
};

function siteItem(
	input: AnonymousClaimPlanInput,
	deadline: Instant,
): ClaimItem {
	return {
		id: siteClaimItemId(input.deploymentRef),
		subjectRef: `netlify:site:${input.siteId}`,
		subjectKind: "camp",
		providerId: NETLIFY_PROVIDER_ID,
		claimStrategyRef: NETLIFY_ANONYMOUS_CLAIM_STRATEGY_REF,
		mode: "site-claim",
		deadline,
		continuity: {
			// The claim moves the site between teams; the *.netlify.app hostname
			// and the deployed files survive it. The pre-claim mutation
			// credential does not, which is the obligation below.
			endpoint: "preserved",
			data: "preserved",
			credentials: "revoked",
		},
		creatorAuthorityAfterClaim: "rotatable",
		verificationRef: NETLIFY_SITE_VERIFICATION_REF,
		// No binding rotation: a static site produces no credentialed binding
		// for a workload to consume, so inventing one would be a false
		// obligation. What must happen is that the anonymous claim material
		// stops working.
		postClaimActions: ["revoke-bootstrap-authority"],
		completedPostClaimActions: [],
		status: "pending",
	};
}

export function compileAnonymousClaimPlan(
	input: AnonymousClaimPlanInput,
): AnonymousClaimPlan {
	const deadline =
		input.claimDeadlineMs ??
		input.deployedAtMs + NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS;
	const expirySource = input.expirySource ?? "documented-window";
	const item = siteItem(input, deadline);

	const lease: GuestLease = {
		schemaVersion: "hobo.guest-lease/v1",
		id: `${input.deploymentRef}#lease`,
		subjectRef: item.subjectRef,
		bootstrapStrategyRef: NETLIFY_ANONYMOUS_BOOTSTRAP_STRATEGY_REF,
		// Genuinely anonymous *and* claimable: no HoBo account is involved and
		// no HoBo money is at risk, but the site is not public property either —
		// it belongs to whoever claims it within the hour.
		bootstrapClass: "anonymous-claimable",
		createdAt: input.createdAtMs,
		// Netlify removes an unclaimed project after the window, so the lease
		// expiry and the claim deadline are the same provider-owned instant.
		expiresAt: deadline,
		claimBy: deadline,
		renewable: false,
		renewalCount: 0,
		// Netlify reaps the project itself; deleting it again would be a second
		// failure path for no benefit.
		cleanupPolicy: "retain-until-provider-expiry",
		status: "active",
		fencingToken: input.fencingToken,
	};

	const bundle: ClaimBundle = {
		schemaVersion: "hobo.claim-bundle/v1",
		id: `${input.deploymentRef}#claim`,
		deploymentRef: input.deploymentRef,
		items: [item],
		dependencyEdges: [],
		atomicity: "single-resource",
		earliestDeadline: deadline,
		compensation: {
			onTimeout: "retain-until-provider-expiry",
			onPartialClaim: "continue-and-repair",
		},
		status: "pending",
	};

	return { lease, bundle, claimDeadlineMs: deadline, expirySource };
}

/** Commands that stage the compiled plan into the shared coordinator. */
export function anonymousBootstrapCommands(input: {
	readonly deploymentRef: string;
	readonly offerId: string;
	readonly offerDigest: string;
	readonly plan: AnonymousClaimPlan;
	readonly siteId: string;
	readonly idempotencyKey: string;
	readonly at: Instant;
}): readonly ClaimCommand[] {
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
			acceptedAt: input.at,
		},
		{ kind: "ReserveGuestLease", lease: input.plan.lease },
		{
			kind: "StartGuestDeployment",
			deploymentRef: input.deploymentRef,
			idempotencyKey: input.idempotencyKey,
		},
		{
			kind: "RecordProvisionedSubject",
			subjectRef: `netlify:site:${input.siteId}`,
			subjectKind: "camp",
			providerId: NETLIFY_PROVIDER_ID,
			idempotencyKey: `${input.idempotencyKey}#site`,
		},
	];
}
