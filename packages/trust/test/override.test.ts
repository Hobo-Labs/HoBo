import { describe, expect, it } from "vitest";

import {
	applyOperatorOverride,
	computeEvidenceDigest,
	DEFAULT_TRUST_REQUIREMENT,
	type EvidenceVerifier,
	evaluateTrust,
	isOverriddenTrustVerdict,
	MAXIMUM_OVERRIDE_WINDOW_MS,
	OperatorOverrideError,
	type OperatorOverrideInput,
	parseTrustEvidence,
	type TrustEvidenceInput,
} from "../src/index.js";

const TESTED_AT = Date.UTC(2026, 7, 1);
const NOW = Date.UTC(2026, 7, 8);
const DAY = 24 * 60 * 60 * 1000;

const validVerifier: EvidenceVerifier = {
	id: "test.valid/v1",
	verify: () => "valid",
};

const evidence = (overrides: Partial<TrustEvidenceInput> = {}) => {
	const draft: TrustEvidenceInput = {
		schemaVersion: "hobo.trust-evidence/v1",
		providerId: "upstash",
		productDefinitionId: "upstash.redis/v1",
		adapterVersion: "0.1.0",
		providerClass: "experimental",
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
			{ url: "https://upstash.com/docs/redis", checkedAt: "2026-08-08" },
		],
		...overrides,
	};
	return parseTrustEvidence({
		...draft,
		evidenceDigest: computeEvidenceDigest(draft),
	});
};

const denied = () =>
	evaluateTrust(evidence(), DEFAULT_TRUST_REQUIREMENT, NOW, validVerifier);

const override = (
	overrides: Partial<OperatorOverrideInput> = {},
): OperatorOverrideInput => ({
	schemaVersion: "hobo.trust-override/v1",
	operatorId: "operator:ada",
	reason: "pilot workload accepts an experimental provider for two weeks",
	grantedAtMs: NOW - DAY,
	expiresAtMs: NOW + 13 * DAY,
	waivedCodes: ["PROVIDER_MATURITY_DENIED"],
	ticketRef: "HOBO-1234",
	...overrides,
});

describe("applyOperatorOverride", () => {
	it("records who, why, and until when — and never sets selectable", () => {
		const verdict = denied();
		expect(verdict.selectable).toBe(false);

		const overridden = applyOperatorOverride(verdict, override());
		expect(overridden.selectable).toBe(false);
		expect(overridden.manuallyAuthorized).toBe(true);
		expect(overridden.override.operatorId).toBe("operator:ada");
		expect(overridden.override.reason).toContain("experimental provider");
		expect(overridden.override.expiresAtMs).toBe(NOW + 13 * DAY);
		expect(overridden.override.ticketRef).toBe("HOBO-1234");
		expect(overridden.override.recordDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
		// The underlying reasons stay on the record: an override hides nothing.
		expect(overridden.reasons.map((reason) => reason.code)).toContain(
			"PROVIDER_MATURITY_DENIED",
		);
		expect(isOverriddenTrustVerdict(overridden)).toBe(true);
	});

	it("never authorizes implicitly: unwaived reason codes still gate", () => {
		const verdict = evaluateTrust(
			evidence({ claimActionCount: 7 }),
			DEFAULT_TRUST_REQUIREMENT,
			NOW,
			validVerifier,
		);
		const overridden = applyOperatorOverride(verdict, override());
		expect(overridden.manuallyAuthorized).toBe(false);
		expect(overridden.override.unwaivedCodes).toEqual([
			"TOO_MANY_CLAIM_ACTIONS",
		]);
	});

	it("does not authorize outside the override window", () => {
		const verdict = denied();
		const expired = applyOperatorOverride(
			verdict,
			override({ grantedAtMs: NOW - 10 * DAY, expiresAtMs: NOW - DAY }),
		);
		expect(expired.override.active).toBe(false);
		expect(expired.manuallyAuthorized).toBe(false);

		const notYet = applyOperatorOverride(
			verdict,
			override({ grantedAtMs: NOW + DAY, expiresAtMs: NOW + 10 * DAY }),
		);
		expect(notYet.override.active).toBe(false);
		expect(notYet.manuallyAuthorized).toBe(false);
	});

	it("refuses a blanket override, a thin reason, an anonymous operator, and a bad window", () => {
		const verdict = denied();
		expect(() =>
			applyOperatorOverride(verdict, override({ waivedCodes: [] })),
		).toThrow(OperatorOverrideError);
		expect(() =>
			applyOperatorOverride(verdict, override({ reason: "because" })),
		).toThrow(OperatorOverrideError);
		expect(() =>
			applyOperatorOverride(verdict, override({ operatorId: "  " })),
		).toThrow(OperatorOverrideError);
		expect(() =>
			applyOperatorOverride(
				verdict,
				override({ grantedAtMs: NOW, expiresAtMs: NOW - 1 }),
			),
		).toThrow(OperatorOverrideError);
		expect(() =>
			applyOperatorOverride(
				verdict,
				override({
					grantedAtMs: NOW,
					expiresAtMs: NOW + MAXIMUM_OVERRIDE_WINDOW_MS + 1,
				}),
			),
		).toThrow(OperatorOverrideError);
	});

	it("refuses to decorate a verdict that already passed", () => {
		const clean = evaluateTrust(
			evidence({ providerClass: "established" }),
			DEFAULT_TRUST_REQUIREMENT,
			NOW,
			validVerifier,
		);
		expect(clean.selectable).toBe(true);
		expect(() => applyOperatorOverride(clean, override())).toThrow(
			OperatorOverrideError,
		);
	});

	it("is deterministic: the same override over the same verdict digests identically", () => {
		const a = applyOperatorOverride(denied(), override());
		const b = applyOperatorOverride(denied(), override());
		expect(b.override.recordDigest).toBe(a.override.recordDigest);
		expect(b).toEqual(a);
	});
});
