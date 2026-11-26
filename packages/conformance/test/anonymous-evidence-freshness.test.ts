// Evidence lifecycle: what a conformance artifact is worth an hour after the
// run, and what it is worth a year later.
//
// The whole point of the expiry is that nobody has to remember to retract
// evidence when a provider changes its claim flow. Selection asks "is this
// still fresh at `nowMs`" and fails closed on its own, so these tests wire a
// real artifact through the real selector rather than asserting on a field.

import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	type SelectionCandidate,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
} from "@hobo/capability-profiles";
import type { EvidenceVerifier } from "@hobo/trust";
import { describe, expect, it } from "vitest";

import {
	type AnonymousTrustEvidenceArtifact,
	conformanceOutcomeFromArtifact,
	DEFAULT_EVIDENCE_FRESHNESS_WINDOW_MS,
	emitAnonymousTrustEvidence,
	selectionEvidenceFacts,
} from "../src/live/index.js";
import { runAnonymousConformance } from "../src/suites/anonymous/index.js";
import {
	digestOf,
	PRODUCT_DEFINITION_DIGEST,
	REFERENCE_ANONYMOUS_PORTS,
} from "../src/suites/anonymous/reference-adapter.js";

const TESTED_AT_MS = 1_700_000_000_000;
const PROFILE_ID = STANDARD_CAPABILITY_PROFILES[0]?.id ?? "";

const SIGNER = {
	id: "test-signer/v1",
	sign: (digest: string): string => `sig:${digestOf(digest).slice(7, 39)}`,
};

/** A trust root that vouches for anything this signer signed. */
const TRUSTING_VERIFIER: EvidenceVerifier = {
	id: "test-trust-root/v1",
	verify: (request) =>
		request.signature.startsWith("sig:") ? "valid" : "invalid",
};

async function artifactFor(
	options: { readonly caseIds?: readonly string[] } = {},
): Promise<AnonymousTrustEvidenceArtifact> {
	const reports = await runAnonymousConformance(REFERENCE_ANONYMOUS_PORTS, {
		subjectId: "reference.claimable-postgres",
		...(options.caseIds !== undefined
			? { caseIds: options.caseIds }
			: undefined),
	});
	return emitAnonymousTrustEvidence({
		providerId: "reference-cloud",
		productDefinitionId: "reference.claimable-postgres",
		productDefinitionDigest: PRODUCT_DEFINITION_DIGEST,
		adapterVersion: "1.4.2",
		providerClass: "verified-emerging",
		providerDocsCheckedAt: "2026-08-01",
		runTag: "hobo-conf-freshness",
		testedAtMs: TESTED_AT_MS,
		reports,
		creatorAuthorityAfterClaim: "absent",
		claimActionCount: 1,
		sourceRefs: [
			{
				url: "https://docs.reference-cloud.example/anonymous-projects",
				checkedAt: "2026-08-01",
			},
		],
		signer: SIGNER,
	});
}

function candidateFrom(
	artifact: AnonymousTrustEvidenceArtifact,
	verifier: EvidenceVerifier,
): SelectionCandidate {
	return {
		definitionId: "reference.claimable-postgres",
		providerId: "reference-cloud",
		implementsProfiles: [
			{
				profileId: PROFILE_ID,
				versionRange: "*",
				realization: "native",
				conformanceRef: "hobo.anonymous.claim/v1",
				conformance: conformanceOutcomeFromArtifact(artifact),
			},
		],
		runtimeModels: ["container"],
		structuredCapabilities: {},
		producesBindingProfiles: ["binding.postgresql/v1"],
		migrationProfiles: [],
		providerClass: "verified-emerging",
		...selectionEvidenceFacts(artifact, verifier),
		creatorAuthorityAfterClaim: "absent",
		claimAtomicity: "single-resource",
		claimActionCount: 1,
		continuity: {
			endpoint: "preserved",
			data: "preserved",
			credentials: "rotated",
		},
		supportsExport: true,
		supportsRotation: true,
		supportsRevocation: true,
		sponsorExposureMinorUnits: 0,
		hasRegisteredDriver: true,
		secretCustodyAvailable: true,
	};
}

function select(candidate: SelectionCandidate, nowMs: number) {
	return selectCapabilityImplementation({
		requirement: parseCapabilityRequirement({
			requiredProfiles: [{ profileId: PROFILE_ID, versionRange: "*" }],
		}),
		registry: createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES),
		candidates: [candidate],
		policy: DEFAULT_TRUST_POLICY,
		nowMs,
	});
}

describe("conformance evidence expires on its own", () => {
	it("makes a product selectable while the evidence is fresh", async () => {
		const artifact = await artifactFor();
		const result = select(
			candidateFrom(artifact, TRUSTING_VERIFIER),
			TESTED_AT_MS + 60_000,
		);
		expect(result.winner?.definitionId).toBe("reference.claimable-postgres");
		expect(result.rejections).toEqual([]);
	});

	it("rejects the product as EVIDENCE_STALE once the window closes", async () => {
		const artifact = await artifactFor();
		const result = select(
			candidateFrom(artifact, TRUSTING_VERIFIER),
			artifact.evidence.expiresAt + 1,
		);
		expect(result.winner).toBeUndefined();
		expect(result.rejections.map((rejection) => rejection.code)).toEqual([
			"EVIDENCE_STALE",
		]);
		expect(result.rejections[0]?.detail).toContain("expired at");
	});

	it("expires exactly one freshness window after the run", async () => {
		const artifact = await artifactFor();
		expect(artifact.evidence.expiresAt - artifact.evidence.testedAt).toBe(
			DEFAULT_EVIDENCE_FRESHNESS_WINDOW_MS,
		);
		// The boundary instant itself is already too late: `expiresAt <= nowMs`
		// is the fail-closed comparison selection makes.
		expect(
			select(
				candidateFrom(artifact, TRUSTING_VERIFIER),
				artifact.evidence.expiresAt,
			).winner,
		).toBeUndefined();
	});

	it("rejects the product when no trust root vouches for the signature", async () => {
		const artifact = await artifactFor();
		const noTrustRoot: EvidenceVerifier = {
			id: "no-trust-root/v1",
			verify: () => "unknown",
		};
		const result = select(
			candidateFrom(artifact, noTrustRoot),
			TESTED_AT_MS + 60_000,
		);
		expect(result.rejections.map((rejection) => rejection.code)).toEqual([
			"EVIDENCE_STALE",
		]);
		expect(result.rejections[0]?.detail).toContain("signature is not valid");
	});

	it("rejects the product when part of the suite never ran", async () => {
		// A partially-run suite yields `unknown`, and `unknown` gates the
		// candidate out through CONFORMANCE_FAILED rather than sliding past.
		const artifact = await artifactFor({
			caseIds: ["bootstrap/advertised-class-holds"],
		});
		expect(conformanceOutcomeFromArtifact(artifact)).toBe("unknown");
		const result = select(
			candidateFrom(artifact, TRUSTING_VERIFIER),
			TESTED_AT_MS + 60_000,
		);
		expect(result.winner).toBeUndefined();
		expect(result.rejections.map((rejection) => rejection.code)).toEqual([
			"CONFORMANCE_FAILED",
		]);
	});
});
