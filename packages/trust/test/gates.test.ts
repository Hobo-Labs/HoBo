import { describe, expect, it } from "vitest";

import {
	computeEvidenceDigest,
	DEFAULT_TRUST_REQUIREMENT,
	type EvidenceVerifier,
	evaluateEvidenceFreshness,
	evaluateTrustBundle,
	parseTrustEvidence,
	parseTrustRequirement,
	type TrustEvidenceInput,
	trustPolicyFromRequirement,
} from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;
const TESTED_AT = Date.UTC(2026, 7, 1);
const NOW = Date.UTC(2026, 7, 8);

const validVerifier: EvidenceVerifier = {
	id: "test.always-valid/v1",
	verify: () => "valid",
};

const input = (
	overrides: Partial<TrustEvidenceInput> = {},
): TrustEvidenceInput => {
	const draft: TrustEvidenceInput = {
		schemaVersion: "hobo.trust-evidence/v1",
		providerId: "cloudflare",
		productDefinitionId: "cloudflare.workers/v1",
		adapterVersion: "0.3.1",
		providerClass: "established",
		testedAt: TESTED_AT,
		expiresAt: TESTED_AT + 30 * DAY,
		checks: {
			"bootstrap.official-contract": "pass",
			"claim.documented-contract": "pass",
			"conformance.suite": "pass",
		},
		creatorAuthorityAfterClaim: "rotatable",
		claimActionCount: 1,
		realizations: ["native"],
		sponsorBacked: false,
		evidenceDigest:
			"sha256:0000000000000000000000000000000000000000000000000000000000000000",
		signature: "sig:test",
		sourceRefs: [
			{
				url: "https://developers.cloudflare.com/workers/",
				checkedAt: "2026-08-08",
			},
		],
		...overrides,
	};
	return { ...draft, evidenceDigest: computeEvidenceDigest(draft) };
};

const evidence = (overrides: Partial<TrustEvidenceInput> = {}) =>
	parseTrustEvidence(input(overrides));

describe("evaluateEvidenceFreshness", () => {
	it("reports a fresh record with the time it has left", () => {
		const freshness = evaluateEvidenceFreshness(evidence(), NOW, 30 * DAY);
		expect(freshness.state).toBe("fresh");
		expect(freshness.fresh).toBe(true);
		expect(freshness.ageMs).toBe(7 * DAY);
		expect(freshness.remainingMs).toBe(23 * DAY);
	});

	it("treats absent evidence as unusable rather than as a gap", () => {
		const freshness = evaluateEvidenceFreshness(undefined, NOW, 30 * DAY);
		expect(freshness.state).toBe("absent");
		expect(freshness.fresh).toBe(false);
	});

	it("separates expiry from age", () => {
		expect(evaluateEvidenceFreshness(evidence(), NOW, DAY).state).toBe("aged");
		expect(
			evaluateEvidenceFreshness(evidence({ expiresAt: NOW - 1 }), NOW, 30 * DAY)
				.state,
		).toBe("expired");
	});

	it("refuses evidence dated after the evaluation instant", () => {
		const future = evidence({ testedAt: NOW + DAY, expiresAt: NOW + 30 * DAY });
		expect(evaluateEvidenceFreshness(future, NOW, 30 * DAY).state).toBe(
			"future-dated",
		);
	});

	it("flips exactly at expiry and nowhere else", () => {
		const record = evidence();
		expect(
			evaluateEvidenceFreshness(record, record.expiresAt - 1, 60 * DAY).fresh,
		).toBe(true);
		expect(
			evaluateEvidenceFreshness(record, record.expiresAt, 60 * DAY).fresh,
		).toBe(false);
	});
});

describe("evaluateTrustBundle", () => {
	const subjects = [
		{
			subjectId: "neon.postgres/v1",
			evidence: evidence({ providerId: "neon" }),
		},
		{ subjectId: "cloudflare.workers/v1", evidence: evidence() },
	];

	it("is selectable only when every subject is", () => {
		const bundle = evaluateTrustBundle({
			subjects,
			requirement: DEFAULT_TRUST_REQUIREMENT,
			nowMs: NOW,
			verifier: validVerifier,
		});
		expect(bundle.selectable).toBe(true);
		expect(bundle.subjects.map((entry) => entry.subjectId)).toEqual([
			"cloudflare.workers/v1",
			"neon.postgres/v1",
		]);

		const withStale = evaluateTrustBundle({
			subjects: [...subjects, { subjectId: "upstash.redis/v1" }],
			requirement: DEFAULT_TRUST_REQUIREMENT,
			nowMs: NOW,
			verifier: validVerifier,
		});
		expect(withStale.selectable).toBe(false);
		expect(withStale.reasons.map((reason) => reason.code)).toContain(
			"EVIDENCE_ABSENT",
		);
		expect(
			withStale.reasons.every((reason) => typeof reason.subjectId === "string"),
		).toBe(true);
	});

	it("fails closed on an empty bundle", () => {
		const bundle = evaluateTrustBundle({
			subjects: [],
			requirement: DEFAULT_TRUST_REQUIREMENT,
			nowMs: NOW,
			verifier: validVerifier,
		});
		expect(bundle.selectable).toBe(false);
	});

	it("is order-independent and deduplicates repeated subjects", () => {
		const forward = evaluateTrustBundle({
			subjects,
			requirement: DEFAULT_TRUST_REQUIREMENT,
			nowMs: NOW,
			verifier: validVerifier,
		});
		const reversed = evaluateTrustBundle({
			subjects: [...subjects].reverse(),
			requirement: DEFAULT_TRUST_REQUIREMENT,
			nowMs: NOW,
			verifier: validVerifier,
		});
		const duplicated = evaluateTrustBundle({
			subjects: [...subjects, ...subjects],
			requirement: DEFAULT_TRUST_REQUIREMENT,
			nowMs: NOW,
			verifier: validVerifier,
		});
		expect(reversed.bundleDigest).toBe(forward.bundleDigest);
		expect(duplicated.bundleDigest).toBe(forward.bundleDigest);
	});

	it("fails closed when no verifier is injected", () => {
		const bundle = evaluateTrustBundle({
			subjects,
			requirement: DEFAULT_TRUST_REQUIREMENT,
			nowMs: NOW,
		});
		expect(bundle.selectable).toBe(false);
		expect(bundle.verifierId).toBe("hobo.no-trust-root/v1");
	});
});

describe("trustPolicyFromRequirement", () => {
	it("carries the requirement's ceilings into the selection policy", () => {
		const requirement = parseTrustRequirement({
			minimumProviderClass: "established",
			requireOfficialBootstrapContract: true,
			requireDocumentedClaimContract: true,
			creatorAuthorityAfterClaim: "must-be-absent",
			maximumClaimActions: 1,
			maximumEvidenceAgeMs: 7 * DAY,
			requireExportProfile: true,
			allowBridge: true,
		});
		const policy = trustPolicyFromRequirement(requirement);
		expect(policy.minimumProviderClass).toBe("established");
		expect(policy.creatorAuthorityAfterClaim).toBe("must-be-absent");
		expect(policy.maximumClaimActions).toBe(1);
		expect(policy.maximumEvidenceAgeMs).toBe(7 * DAY);
		expect(policy.requireExportProfile).toBe(true);
		expect(policy.allowBridge).toBe(true);
	});

	it("never permits sponsorship without a funded budget", () => {
		const requirement = parseTrustRequirement({
			minimumProviderClass: "verified-emerging",
			requireOfficialBootstrapContract: true,
			requireDocumentedClaimContract: true,
			creatorAuthorityAfterClaim: "must-be-rotatable",
			maximumClaimActions: 2,
			maximumEvidenceAgeMs: 30 * DAY,
			allowSponsor: true,
		});
		expect(trustPolicyFromRequirement(requirement).allowSponsor).toBe(false);
		const funded = trustPolicyFromRequirement(requirement, {
			sponsorBudgetMinorUnits: 500,
		});
		expect(funded.allowSponsor).toBe(true);
		expect(funded.sponsorBudgetMinorUnits).toBe(500);
	});
});
