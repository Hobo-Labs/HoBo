import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
} from "@hobo/capability-profiles";
import {
	attachBundle,
	type ClaimCommand,
	initialState,
	reduce,
} from "@hobo/claims";
import { describe, expect, it } from "vitest";

import {
	assertSponsorBudget,
	createSponsoredProjectTransferBundle,
	createSponsoredProjectTransferLease,
	createVercelSponsoredProjectTransferCandidate,
	DEFAULT_SPONSOR_EXPOSURE_MINOR_UNITS,
	isVercelProviderError,
	PROJECT_TRANSFER_CODE_TTL_MS,
	RESOURCE_TRANSFER_CAPABLE_MARKETPLACE_PROVIDERS,
	runSponsoredProjectTransferClaim,
	SPONSORED_CLAIM_ITEM_IDS,
	SPONSORED_PROJECT_TRANSFER_BOOTSTRAP,
	type SponsoredClaimOutcome,
	type SubjectClaimOutcome,
	sponsoredProjectTransferBootstrapCommands,
	VERCEL_DROP_CLASSIFICATION,
	VERCEL_SPONSORED_PROJECT_TRANSFER_CANDIDATE,
	VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID,
} from "../src/index.js";

const REGISTRY = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const FENCE = "fence-1";
const TRANSFER_DEADLINE = NOW + PROJECT_TRANSFER_CODE_TTL_MS;

const PROJECT_SUBJECT = "hobo://camp/vercel/prj_FAKEsponsoredproject000000";
const RESOURCE_SUBJECT = "hobo://resource/prisma-postgres/FAKEresource000000";

function bundle() {
	return createSponsoredProjectTransferBundle({
		bundleId: "bundle-1",
		deploymentRef: "deployment-1",
		projectSubjectRef: PROJECT_SUBJECT,
		resourceSubjectRef: RESOURCE_SUBJECT,
		transferCodeExpiresAt: TRANSFER_DEADLINE,
		oneTimeActionRef: "ota-1",
	});
}

function provisioned() {
	const lease = createSponsoredProjectTransferLease({
		leaseId: "lease-1",
		subjectRef: PROJECT_SUBJECT,
		createdAt: NOW,
		transferCodeExpiresAt: TRANSFER_DEADLINE,
		fencingToken: FENCE,
	});
	let state = initialState("deployment-1", FENCE);
	const commands = sponsoredProjectTransferBootstrapCommands({
		deploymentRef: "deployment-1",
		offerId: "offer-1",
		offerDigest: "sha256:offer",
		acceptedAt: NOW,
		lease,
		projectSubjectRef: PROJECT_SUBJECT,
		resourceSubjectRef: RESOURCE_SUBJECT,
		idempotencyKey: "attempt-1",
	});
	for (const command of commands) {
		state = reduce(state, command, { fencingToken: FENCE }).state;
	}
	return { state: attachBundle(state, bundle()), commands, lease };
}

const CLAIMED_AND_VERIFIED: SubjectClaimOutcome = {
	observed: "claimed",
	verified: true,
	evidenceRef: "evidence://vercel/project/FAKE000",
	revocationEvidenceRef: "evidence://vercel/revocation/FAKE000",
};

const RESOURCE_CLAIMED_AND_VERIFIED: SubjectClaimOutcome = {
	observed: "claimed",
	verified: true,
	evidenceRef: "evidence://prisma-postgres/ownership/FAKE000",
	rotatedBindingId: "binding-rotated-1",
	revocationEvidenceRef: "evidence://prisma-postgres/revocation/FAKE000",
};

describe("vercel.sponsored-project-transfer/v1 classification", () => {
	it("is sponsor-backed and never described as anonymous deployment", () => {
		expect(SPONSORED_PROJECT_TRANSFER_BOOTSTRAP.bootstrapClass).toBe("sponsor");
		expect(SPONSORED_PROJECT_TRANSFER_BOOTSTRAP.publiclyAnonymous).toBe(false);
		expect(SPONSORED_PROJECT_TRANSFER_BOOTSTRAP.sponsorBacked).toBe(true);
		expect(SPONSORED_PROJECT_TRANSFER_BOOTSTRAP.initialOwner).toBe(
			"hobo-sponsor",
		);
		expect(SPONSORED_PROJECT_TRANSFER_BOOTSTRAP.costBearerBeforeClaim).toBe(
			"hobo-sponsor",
		);
		expect(
			VERCEL_SPONSORED_PROJECT_TRANSFER_CANDIDATE.sponsorExposureMinorUnits,
		).toBeGreaterThan(0);

		// Offer copy and every serialized fact must not present this as an
		// anonymous or accountless deploy. The only permitted mention of the word
		// is the explicit `publiclyAnonymous: false` denial.
		const serialized = JSON.stringify({
			bootstrap: SPONSORED_PROJECT_TRANSFER_BOOTSTRAP,
			candidate: VERCEL_SPONSORED_PROJECT_TRANSFER_CANDIDATE,
			bundle: bundle(),
		});
		expect(serialized).toContain('"publiclyAnonymous":false');
		const withoutDenials = serialized.replaceAll(
			'"publiclyAnonymous":false',
			"",
		);
		expect(withoutDenials).not.toMatch(/anonymous/iu);
		expect(SPONSORED_PROJECT_TRANSFER_BOOTSTRAP.offerSummary).not.toMatch(
			/anonymous|no account|without an account/iu,
		);
		expect(SPONSORED_PROJECT_TRANSFER_BOOTSTRAP.offerSummary).toMatch(
			/initial owner and cost bearer/iu,
		);
		expect(SPONSORED_PROJECT_TRANSFER_BOOTSTRAP.offerSummary).toMatch(
			/24 hours/u,
		);
	});

	it("refuses a zero sponsor exposure, which would advertise it as free", () => {
		expect(() =>
			createVercelSponsoredProjectTransferCandidate({
				sponsorExposureMinorUnits: 0,
			}),
		).toThrow(/positive sponsor exposure/u);
	});

	it("keeps Vercel Drop separate and not direct anonymous deployment", () => {
		expect(VERCEL_DROP_CLASSIFICATION.definitionId).not.toBe(
			VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID,
		);
		expect(VERCEL_DROP_CLASSIFICATION.directAnonymousDeployment).toBe(false);
		expect(VERCEL_DROP_CLASSIFICATION.accountRequiredToRetain).toBe(true);
		expect(VERCEL_DROP_CLASSIFICATION.bootstrapClass).toBe(
			"anonymous-claimable",
		);
	});

	it("records the marketplace providers the docs actually name", () => {
		// The docs name three; recording only Prisma would understate the surface.
		expect([...RESOURCE_TRANSFER_CAPABLE_MARKETPLACE_PROVIDERS]).toEqual([
			"neon",
			"prisma",
			"supabase",
		]);
	});
});

describe("sponsor budget is a gate, not a preference", () => {
	const requirement = parseCapabilityRequirement({
		requiredProfiles: [{ profileId: "web.hosted/v1" }],
	});

	it("is rejected under the default policy, which funds no sponsor spend", () => {
		const result = selectCapabilityImplementation({
			requirement,
			registry: REGISTRY,
			candidates: [VERCEL_SPONSORED_PROJECT_TRANSFER_CANDIDATE],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW,
		});
		expect(result.winner).toBeUndefined();
		expect(result.rejections.map((entry) => entry.code)).toContain(
			"SPONSOR_BUDGET_EXCEEDED",
		);
	});

	it("is selectable once an operator funds a budget on purpose", () => {
		const result = selectCapabilityImplementation({
			requirement,
			registry: REGISTRY,
			candidates: [VERCEL_SPONSORED_PROJECT_TRANSFER_CANDIDATE],
			policy: {
				...DEFAULT_TRUST_POLICY,
				sponsorBudgetMinorUnits: DEFAULT_SPONSOR_EXPOSURE_MINOR_UNITS,
			},
			nowMs: NOW,
		});
		expect(result.winner?.definitionId).toBe(
			VERCEL_SPONSORED_PROJECT_TRANSFER_DEFINITION_ID,
		);
	});

	it("refuses provisioning over the remaining budget", () => {
		try {
			assertSponsorBudget({
				exposureMinorUnits: 500,
				remainingBudgetMinorUnits: 100,
			});
			expect.unreachable("expected a sponsor budget refusal");
		} catch (error) {
			expect(isVercelProviderError(error)).toBe(true);
			if (isVercelProviderError(error)) {
				expect(error.code).toBe("SPONSOR_BUDGET_EXCEEDED");
			}
		}
	});
});

describe("application and database are two ownership facts", () => {
	it("emits two provider-bundled claim items with distinct subjects", () => {
		const claim = bundle();
		expect(claim.items).toHaveLength(2);
		expect(claim.atomicity).toBe("provider-bundled");
		const [project, resource] = claim.items;
		expect(project?.subjectKind).toBe("camp");
		expect(project?.mode).toBe("project-transfer");
		expect(resource?.subjectKind).toBe("resource");
		expect(resource?.mode).toBe("resource-claim");
		expect(resource?.subjectRef).toContain("prisma-postgres");
		expect(resource?.postClaimActions).toContain("rotate-binding");
		// One human ceremony, two subjects, and the database follows the project.
		expect(claim.dependencyEdges).toEqual([
			{
				fromItemId: SPONSORED_CLAIM_ITEM_IDS.project,
				toItemId: SPONSORED_CLAIM_ITEM_IDS.associatedResource,
			},
		]);
		expect(claim.compensation.onPartialClaim).toBe("continue-and-repair");
		expect(claim.earliestDeadline).toBe(TRANSFER_DEADLINE);
	});

	it("does not invent a provider expiry for a project that never expires", () => {
		const lease = createSponsoredProjectTransferLease({
			leaseId: "lease-1",
			subjectRef: PROJECT_SUBJECT,
			createdAt: NOW,
			transferCodeExpiresAt: TRANSFER_DEADLINE,
			fencingToken: FENCE,
		});
		expect(lease.expiresAt).toBeUndefined();
		expect(lease.claimBy).toBe(TRANSFER_DEADLINE);
		expect(lease.cleanupPolicy).toBe("delete");
		expect(lease.bootstrapClass).toBe("sponsor");
	});

	it("does not re-provision when a bootstrap attempt is replayed", () => {
		const { state, commands } = provisioned();
		let replayed = state;
		for (const command of commands) {
			replayed = reduce(replayed, command, { fencingToken: FENCE }).state;
		}
		expect(replayed.provisionedSubjects).toEqual([
			PROJECT_SUBJECT,
			RESOURCE_SUBJECT,
		]);
	});
});

describe("the claim bundle completes only when both subjects move", () => {
	it("completes when project and database are both independently verified", () => {
		const { state } = provisioned();
		const outcome: SponsoredClaimOutcome = {
			at: NOW + 60_000,
			bundleId: "bundle-1",
			project: CLAIMED_AND_VERIFIED,
			associatedResource: RESOURCE_CLAIMED_AND_VERIFIED,
		};
		const result = runSponsoredProjectTransferClaim(state, outcome, {
			fencingToken: FENCE,
		});
		expect(result.report.atomicSuccess).toBe(true);
		expect(result.report.bundleStatus).toBe("complete");
		expect(result.report.lifecycle).toBe("OwnerControlled");
		expect(result.report.outstandingItemIds).toEqual([]);
		expect(result.events.map((event) => event.type)).toContain(
			"ClaimBundleCompleted",
		);
	});

	it("enters repair when the project transfers but the Prisma resource does not", () => {
		const { state } = provisioned();
		const outcome: SponsoredClaimOutcome = {
			at: NOW + 60_000,
			bundleId: "bundle-1",
			project: CLAIMED_AND_VERIFIED,
			associatedResource: {
				observed: "claimed",
				// Vercel ran one ceremony and reported success; the independent
				// probe says the database is still on the sponsor installation.
				verified: false,
				evidenceRef: "evidence://prisma-postgres/ownership/FAKE001",
			},
		};
		const result = runSponsoredProjectTransferClaim(state, outcome, {
			fencingToken: FENCE,
		});

		expect(result.report.atomicSuccess).toBe(false);
		expect(result.report.failureCode).toBe("CLAIM_PARTIALLY_COMPLETED");
		expect(result.report.bundleStatus).toBe("claimed-needs-remediation");
		expect(result.report.lifecycle).toBe("RepairableFailure");
		expect(result.report.outstandingItemIds).toEqual([
			SPONSORED_CLAIM_ITEM_IDS.associatedResource,
		]);

		const items = result.state.bundle?.items ?? [];
		expect(
			items.find((item) => item.id === SPONSORED_CLAIM_ITEM_IDS.project)
				?.status,
		).toBe("completed");
		const resource = items.find(
			(item) => item.id === SPONSORED_CLAIM_ITEM_IDS.associatedResource,
		);
		expect(resource?.status).toBe("repairable-failure");
		expect(resource?.failureCode).toBe("CLAIM_NOT_VERIFIED");
		expect(result.events.map((event) => event.type)).toContain(
			"ClaimRepairRequested",
		);
		expect(result.events.map((event) => event.type)).not.toContain(
			"ClaimBundleCompleted",
		);
	});

	it("refuses to complete a resource item that still owes a binding rotation", () => {
		const { state } = provisioned();
		let next = state;
		const commands: readonly ClaimCommand[] = [
			{ kind: "BeginClaimBundle", bundleId: "bundle-1", at: NOW },
			{
				kind: "BeginClaimItem",
				itemId: SPONSORED_CLAIM_ITEM_IDS.associatedResource,
				at: NOW,
			},
			{
				kind: "ObserveClaimItem",
				itemId: SPONSORED_CLAIM_ITEM_IDS.associatedResource,
				observedStatus: "claimed",
				at: NOW,
			},
			{
				kind: "VerifyOwnership",
				itemId: SPONSORED_CLAIM_ITEM_IDS.associatedResource,
				verified: true,
				evidenceRef: "evidence://prisma-postgres/ownership/FAKE002",
				creatorAuthorityAfterClaim: "rotatable",
			},
		];
		for (const command of commands) {
			next = reduce(next, command, { fencingToken: FENCE }).state;
		}
		expect(() =>
			reduce(
				next,
				{
					kind: "CompleteClaimItem",
					itemId: SPONSORED_CLAIM_ITEM_IDS.associatedResource,
					at: NOW,
				},
				{ fencingToken: FENCE },
			),
		).toThrow(/still owes/u);
	});

	it("treats an expired transfer code as a lost subject, not a success", () => {
		const { state } = provisioned();
		const result = runSponsoredProjectTransferClaim(
			state,
			{
				at: TRANSFER_DEADLINE + 1,
				bundleId: "bundle-1",
				project: { observed: "expired", verified: false, evidenceRef: "n/a" },
				associatedResource: {
					observed: "expired",
					verified: false,
					evidenceRef: "n/a",
				},
			},
			{ fencingToken: FENCE },
		);
		expect(result.report.atomicSuccess).toBe(false);
		expect(result.report.bundleStatus).toBe("expired");
		expect(result.report.failureCode).toBe("CLAIM_PARTIALLY_COMPLETED");
	});

	it("rejects a stale worker holding the wrong fence", () => {
		const { state } = provisioned();
		expect(() =>
			runSponsoredProjectTransferClaim(
				state,
				{
					at: NOW,
					bundleId: "bundle-1",
					project: CLAIMED_AND_VERIFIED,
					associatedResource: RESOURCE_CLAIMED_AND_VERIFIED,
				},
				{ fencingToken: "fence-stale" },
			),
		).toThrow(/fencing token/u);
	});
});

describe("Matching sees a narrow, honest capability surface", () => {
	it("does not select on a limit no doc states", () => {
		const result = selectCapabilityImplementation({
			requirement: parseCapabilityRequirement({
				requiredProfiles: [{ profileId: "web.static/v1" }],
				features: [
					{
						key: "maxFileCount",
						operator: "at-least",
						value: 10_000,
						necessity: "required",
					},
				],
			}),
			registry: REGISTRY,
			candidates: [VERCEL_SPONSORED_PROJECT_TRANSFER_CANDIDATE],
			policy: {
				...DEFAULT_TRUST_POLICY,
				sponsorBudgetMinorUnits: DEFAULT_SPONSOR_EXPOSURE_MINOR_UNITS,
			},
			nowMs: NOW,
		});
		expect(result.winner).toBeUndefined();
		expect(result.rejections.map((entry) => entry.code)).toContain(
			"FEATURE_UNSATISFIED",
		);
	});

	it("refuses a websocket requirement rather than pretending functions upgrade", () => {
		const result = selectCapabilityImplementation({
			requirement: parseCapabilityRequirement({
				requiredProfiles: [{ profileId: "api.http/v1" }],
				features: [
					{
						key: "websocketUpgrade",
						operator: "equals",
						value: true,
						necessity: "required",
					},
				],
			}),
			registry: REGISTRY,
			candidates: [VERCEL_SPONSORED_PROJECT_TRANSFER_CANDIDATE],
			policy: {
				...DEFAULT_TRUST_POLICY,
				sponsorBudgetMinorUnits: DEFAULT_SPONSOR_EXPOSURE_MINOR_UNITS,
			},
			nowMs: NOW,
		});
		expect(result.winner).toBeUndefined();
	});
});
