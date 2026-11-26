/**
 * `netlify.anonymous-static-site/v1` — narrow on purpose, and anonymous for real.
 *
 * Two properties are worth more than the feature list: the definition refuses
 * everything it has not proven on the anonymous path, and it never claims a
 * sponsor relationship it does not have. Both are asserted here rather than
 * described in a comment.
 */
import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
	type TrustPolicy,
} from "@hobo/capability-profiles";
import { describe, expect, it } from "vitest";

import {
	compileAnonymousClaimPlan,
	NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS,
	NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE,
	NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID,
	NETLIFY_AUTHENTICATED_SITE_CANDIDATE,
	NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID,
	NETLIFY_EVIDENCE_CHECKED_AT,
	NETLIFY_SOURCE_REFS,
	siteClaimItemId,
} from "../src/index.js";

const REGISTRY = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

/**
 * A policy that tolerates an emerging provider and a one-action claim, so the
 * rejections below are about *capability*, not about trust gates firing first.
 */
const PERMISSIVE: TrustPolicy = {
	...DEFAULT_TRUST_POLICY,
	minimumProviderClass: "experimental",
	creatorAuthorityAfterClaim: "may-be-retained",
	maximumClaimActions: 2,
	maximumEvidenceAgeMs: Number.MAX_SAFE_INTEGER,
	requireExportProfile: false,
};

function select(requiredProfiles: readonly { readonly profileId: string }[]) {
	return selectCapabilityImplementation({
		requirement: parseCapabilityRequirement({ requiredProfiles }),
		registry: REGISTRY,
		candidates: [NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE],
		policy: PERMISSIVE,
		nowMs: NOW,
	});
}

describe("this really is an anonymous deploy, and says so", () => {
	it("bills nobody before the claim", () => {
		// The number that separates this from the Vercel sponsored path. Zero
		// here is a fact about the offer, not a default nobody set.
		expect(
			NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE.sponsorExposureMinorUnits,
		).toBe(0);
	});

	it("does not claim its authority simply vanishes", () => {
		// `rotatable`, not `absent`. Netlify documents no endpoint that revokes
		// an anonymous deploy session, so absence cannot be asserted from here
		// — it has to be probed, and until it is, the honest declaration is
		// that the authority still needs dealing with.
		expect(
			NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE.creatorAuthorityAfterClaim,
		).toBe("rotatable");
		expect(NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE.continuity.credentials).toBe(
			"revoked",
		);
		expect(NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE.supportsRevocation).toBe(
			true,
		);
	});

	it("is one human action against one resource", () => {
		expect(NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE.claimActionCount).toBe(1);
		// Unlike Vercel: there is no second ownership fact riding along.
		expect(NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE.claimAtomicity).toBe(
			"single-resource",
		);
	});
});

describe("the definition implements static hosting and nothing else", () => {
	it("advertises exactly web.static/v1 and web.hosted/v1", () => {
		const profileIds =
			NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE.implementsProfiles
				.map((entry) => entry.profileId)
				.toSorted();
		expect(profileIds).toEqual(["web.hosted/v1", "web.static/v1"]);
	});

	it("is selected for a static hosting requirement", () => {
		const result = select([{ profileId: "web.static/v1" }]);
		expect(result.winner?.definitionId).toBe(
			NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID,
		);
	});

	it("REJECTS a requirement for api.http/v1", () => {
		// Netlify Functions are real, but not on a verified anonymous
		// `--no-build` deploy. Serving this ask would ship an app whose API
		// silently does not exist, with a green receipt.
		const result = select([
			{ profileId: "web.static/v1" },
			{ profileId: "api.http/v1" },
		]);
		expect(result.winner).toBeUndefined();
		expect(result.ranked).toEqual([]);
		expect(
			result.rejections.some(
				(rejection) =>
					rejection.definitionId ===
						NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID &&
					/api\.http/u.test(rejection.detail),
			),
		).toBe(true);
	});

	it("REJECTS a requirement for a service.* profile", () => {
		for (const profileId of [
			"service.worker/v1",
			"service.scheduled/v1",
			"service.queue-consumer/v1",
		]) {
			const result = select([{ profileId }]);
			expect(result.winner, `${profileId} must not select`).toBeUndefined();
			expect(result.rejections).not.toEqual([]);
		}
	});

	it("REJECTS server-side rendering and RPC too", () => {
		for (const profileId of ["web.ssr/v1", "api.rpc/v1"]) {
			const result = select([{ profileId }]);
			expect(result.winner, `${profileId} must not select`).toBeUndefined();
		}
	});

	it("declares the absent capabilities false rather than omitting them", () => {
		// An omitted key is indistinguishable from an unread one. A stated
		// `false` makes a `required` feature ask fail on a fact.
		const capabilities =
			NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE.structuredCapabilities;
		expect(capabilities.serverlessFunctions).toBe(false);
		expect(capabilities.edgeFunctions).toBe(false);
		expect(capabilities.serverSideRendering).toBe(false);
		// Attaching a custom domain needs an owner, so it is post-claim.
		expect(capabilities.customDomain).toBe(false);
	});
});

describe("the richer surface is a separate definition, not a wider one", () => {
	it("keeps the authenticated definition under its own id", () => {
		expect(NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID).not.toBe(
			NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID,
		);
		expect(NETLIFY_AUTHENTICATED_SITE_CANDIDATE.definitionId).toBe(
			NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID,
		);
	});

	it("is where api.http/v1 lives", () => {
		const profileIds =
			NETLIFY_AUTHENTICATED_SITE_CANDIDATE.implementsProfiles.map(
				(entry) => entry.profileId,
			);
		expect(profileIds).toContain("api.http/v1");
	});

	it("is not anonymous and not claimable", () => {
		expect(NETLIFY_AUTHENTICATED_SITE_CANDIDATE.claimActionCount).toBe(0);
		const capabilities =
			NETLIFY_AUTHENTICATED_SITE_CANDIDATE.structuredCapabilities;
		expect(capabilities.anonymousDeployment).toBe(false);
		expect(capabilities.bootstrap).toBe("operator-credential");
		// Where the capability the anonymous path refuses actually lives.
		expect(capabilities.serverlessFunctions).toBe(true);
	});

	it("advertises no driver it does not have", () => {
		// This package implements the anonymous path only. Advertising an
		// executor for the authenticated surface would let Matching select a
		// product with nothing behind it, so the candidate fails closed.
		expect(NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE.hasRegisteredDriver).toBe(
			true,
		);
		expect(NETLIFY_AUTHENTICATED_SITE_CANDIDATE.hasRegisteredDriver).toBe(
			false,
		);
	});

	it("is not selectable even for the profiles it declares", () => {
		const result = selectCapabilityImplementation({
			requirement: parseCapabilityRequirement({
				requiredProfiles: [{ profileId: "api.http/v1" }],
			}),
			registry: REGISTRY,
			candidates: [NETLIFY_AUTHENTICATED_SITE_CANDIDATE],
			policy: PERMISSIVE,
			nowMs: NOW,
		});
		expect(result.winner).toBeUndefined();
	});

	it("does not let the anonymous candidate win an authenticated-only ask", () => {
		// Both candidates offered; only the honest one may be selected.
		const result = selectCapabilityImplementation({
			requirement: parseCapabilityRequirement({
				requiredProfiles: [{ profileId: "api.http/v1" }],
			}),
			registry: REGISTRY,
			candidates: [
				NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE,
				NETLIFY_AUTHENTICATED_SITE_CANDIDATE,
			],
			policy: PERMISSIVE,
			nowMs: NOW,
		});
		expect(result.winner?.definitionId).not.toBe(
			NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID,
		);
	});
});

describe("the claim window is the provider's hour, not a local invention", () => {
	it("is one hour", () => {
		expect(NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS).toBe(60 * 60 * 1000);
	});

	it("becomes the claim item deadline and the lease expiry", () => {
		const deployedAtMs = NOW;
		const plan = compileAnonymousClaimPlan({
			deploymentRef: "deployment-1",
			siteId: "FAKE-site-0000",
			deployedAtMs,
			createdAtMs: deployedAtMs,
			fencingToken: "fence-1",
			claimDeadlineMs: deployedAtMs + NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS,
			expirySource: "documented-window",
		});

		const deadline = deployedAtMs + NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS;
		expect(plan.claimDeadlineMs).toBe(deadline);
		expect(plan.bundle.earliestDeadline).toBe(deadline);
		// Netlify really does delete the project at the deadline, so the lease
		// expiry is a provider-reported fact rather than a locally chosen TTL.
		expect(plan.lease.claimBy).toBe(deadline);
		expect(plan.lease.expiresAt).toBe(deadline);
		expect(plan.lease.renewable).toBe(false);
	});

	it("labels the deadline as derived from the documented window", () => {
		// The CLI reports no expiry field. Saying "provider-reported" here
		// would be passing off a local calculation as something Netlify said.
		const plan = compileAnonymousClaimPlan({
			deploymentRef: "deployment-1",
			siteId: "FAKE-site-0000",
			deployedAtMs: NOW,
			createdAtMs: NOW,
			fencingToken: "fence-1",
			claimDeadlineMs: NOW + NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS,
			expirySource: "documented-window",
		});
		expect(plan.expirySource).toBe("documented-window");
	});

	it("tracks exactly one claimable subject", () => {
		const plan = compileAnonymousClaimPlan({
			deploymentRef: "deployment-1",
			siteId: "FAKE-site-0000",
			deployedAtMs: NOW,
			createdAtMs: NOW,
			fencingToken: "fence-1",
			claimDeadlineMs: NOW + NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS,
			expirySource: "documented-window",
		});
		expect(plan.bundle.items).toHaveLength(1);
		expect(plan.bundle.items[0]?.id).toBe(siteClaimItemId("deployment-1"));
		expect(plan.bundle.atomicity).toBe("single-resource");
	});
});

describe("every third-party fact carries a source and a date", () => {
	it("records when a human actually read the docs", () => {
		expect(NETLIFY_EVIDENCE_CHECKED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
		expect(NETLIFY_SOURCE_REFS.length).toBeGreaterThan(0);
		for (const source of NETLIFY_SOURCE_REFS) {
			expect(source.url.startsWith("https://")).toBe(true);
			expect(source.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
		}
	});

	it("cites the official CLI and deploy documentation", () => {
		const urls = NETLIFY_SOURCE_REFS.map((source) => source.url).join(" ");
		expect(urls).toContain("docs.netlify.com");
		expect(urls).toMatch(/cli-guides|create-deploys|cli\.netlify\.com/u);
	});
});
