import { describe, expect, it } from "vitest";

import {
	canonicalize,
	computeEvidenceDigest,
	parseTrustEvidence,
	TrustEvidenceError,
	type TrustEvidenceInput,
	tryParseTrustEvidence,
} from "../src/index.js";

const TESTED_AT = Date.UTC(2026, 7, 1);

const baseInput = (
	overrides: Partial<TrustEvidenceInput> = {},
): TrustEvidenceInput => {
	const draft: TrustEvidenceInput = {
		schemaVersion: "hobo.trust-evidence/v1",
		providerId: "cloudflare",
		productDefinitionId: "cloudflare.workers/v1",
		adapterVersion: "0.3.1",
		providerClass: "established",
		testedAt: TESTED_AT,
		expiresAt: TESTED_AT + 30 * 24 * 60 * 60 * 1000,
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

describe("parseTrustEvidence", () => {
	it("canonicalizes checks and sources so authoring order cannot change the digest", () => {
		const a = parseTrustEvidence(baseInput());
		const b = parseTrustEvidence(
			baseInput({
				checks: {
					"conformance.suite": "pass",
					"claim.documented-contract": "pass",
					"bootstrap.official-contract": "pass",
				},
			}),
		);
		expect(canonicalize(a.checks)).toBe(canonicalize(b.checks));
		expect(a.evidenceDigest).toBe(b.evidenceDigest);
	});

	it("rejects a wrong schema version", () => {
		expect(() =>
			parseTrustEvidence({
				...baseInput(),
				schemaVersion:
					"hobo.trust-evidence/v2" as unknown as "hobo.trust-evidence/v1",
			}),
		).toThrow(TrustEvidenceError);
	});

	it("rejects evidence with no checks, no sources, or a non-https source", () => {
		expect(() => parseTrustEvidence(baseInput({ checks: {} }))).toThrow(
			TrustEvidenceError,
		);
		expect(() => parseTrustEvidence(baseInput({ sourceRefs: [] }))).toThrow(
			TrustEvidenceError,
		);
		expect(() =>
			parseTrustEvidence(
				baseInput({
					sourceRefs: [{ url: "http://example.com", checkedAt: "2026-08-08" }],
				}),
			),
		).toThrow(TrustEvidenceError);
	});

	it("rejects an expiry that precedes the test run", () => {
		expect(() =>
			parseTrustEvidence(baseInput({ expiresAt: TESTED_AT - 1 })),
		).toThrow(TrustEvidenceError);
	});

	it("rejects an unknown check outcome and a malformed digest", () => {
		expect(() =>
			parseTrustEvidence(
				baseInput({
					checks: { "conformance.suite": "probably" as unknown as "pass" },
				}),
			),
		).toThrow(TrustEvidenceError);
		const withBadDigest = { ...baseInput(), evidenceDigest: "md5:abc" };
		expect(() => parseTrustEvidence(withBadDigest)).toThrow(TrustEvidenceError);
	});

	it("reports a parse failure as absent evidence rather than partial evidence", () => {
		expect(
			tryParseTrustEvidence(baseInput({ claimActionCount: -1 })),
		).toBeUndefined();
	});
});
