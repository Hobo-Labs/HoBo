import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	type SelectionCandidate,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
} from "@hobo/capability-profiles";
import { describe, expect, it } from "vitest";

import {
	createPrismaClaimablePostgresCandidate,
	PRISMA_CLAIMABLE_POSTGRES_CANDIDATE,
} from "../src/definition.js";

const registry = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);
const NOW_MS = Date.parse("2026-08-08T13:00:00.000Z");

/**
 * The default candidate is deliberately un-selectable under the default policy
 * (`creatorAuthorityAfterClaim: "unknown"`), so selection tests use the
 * opted-in variant a catalog owner would register after verifying rotation.
 */
const VERIFIED = createPrismaClaimablePostgresCandidate({
	creatorAuthorityAfterClaim: "rotatable",
	supportsRotation: true,
});

/** D1 speaks SQL, not the PostgreSQL wire protocol. */
const D1_LIKE: SelectionCandidate = {
	definitionId: "cloudflare.d1/v1",
	providerId: "cloudflare",
	implementsProfiles: [
		{
			profileId: "data.relational/v1",
			versionRange: ">=1",
			realization: "native",
			conformanceRef: "test://d1",
			conformance: "pass",
		},
	],
	runtimeModels: ["wasm", "serverless_faas"],
	structuredCapabilities: { transactions: true, constraints: true },
	producesBindingProfiles: ["binding.postgresql/v1"],
	migrationProfiles: [],
	providerClass: "established",
	evidenceExpiresAtMs: NOW_MS + 30 * 24 * 60 * 60 * 1000,
	evidenceSignatureValid: true,
	creatorAuthorityAfterClaim: "absent",
	claimAtomicity: "single-resource",
	claimActionCount: 0,
	continuity: {
		endpoint: "preserved",
		data: "preserved",
		credentials: "not-applicable",
	},
	supportsExport: true,
	supportsRotation: true,
	supportsRevocation: true,
	sponsorExposureMinorUnits: 0,
	hasRegisteredDriver: true,
	secretCustodyAvailable: true,
};

describe("data.postgres/v1 selection", () => {
	it("selects the Prisma product and rejects the relational-only product", () => {
		const requirement = parseCapabilityRequirement({
			requiredProfiles: [
				{ profileId: "data.postgres/v1", versionRange: ">=1" },
			],
		});
		const result = selectCapabilityImplementation({
			requirement,
			registry,
			candidates: [D1_LIKE, VERIFIED],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW_MS,
		});

		expect(result.winner?.definitionId).toBe("prisma.claimable-postgres/v1");
		expect(
			result.rejections.find(
				(rejection) => rejection.definitionId === "cloudflare.d1/v1",
			)?.code,
		).toBe("PROFILE_INCOMPATIBLE");
	});

	it("also satisfies data.relational/v1 by refinement", () => {
		const requirement = parseCapabilityRequirement({
			requiredProfiles: [
				{ profileId: "data.relational/v1", versionRange: ">=1" },
			],
		});
		const result = selectCapabilityImplementation({
			requirement,
			registry,
			candidates: [VERIFIED],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW_MS,
		});
		expect(result.winner?.definitionId).toBe("prisma.claimable-postgres/v1");
	});

	it("is rejected by default because post-claim credential authority is undocumented", () => {
		const requirement = parseCapabilityRequirement({
			requiredProfiles: [{ profileId: "data.postgres/v1" }],
		});
		const result = selectCapabilityImplementation({
			requirement,
			registry,
			candidates: [PRISMA_CLAIMABLE_POSTGRES_CANDIDATE],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW_MS,
		});

		expect(result.winner).toBeUndefined();
		expect(result.rejections[0]?.code).toBe("STRONG_CLAIM_REQUIRED");
	});

	it("survives a portability requirement for the pg_dump migration profile", () => {
		const requirement = parseCapabilityRequirement({
			requiredProfiles: [{ profileId: "data.postgres/v1" }],
			portability: {
				requireExportProfile: true,
				requiredMigrationProfiles: ["migration.postgres.pg-dump/v1"],
			},
		});
		const result = selectCapabilityImplementation({
			requirement,
			registry,
			candidates: [VERIFIED],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW_MS,
		});
		expect(result.winner).toBeDefined();
	});

	it("is gated out when logical replication is required, which this tier does not document", () => {
		const requirement = parseCapabilityRequirement({
			requiredProfiles: [{ profileId: "data.postgres/v1" }],
			portability: {
				requiredMigrationProfiles: ["migration.postgres.logical-copy/v1"],
			},
		});
		const result = selectCapabilityImplementation({
			requirement,
			registry,
			candidates: [VERIFIED],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW_MS,
		});
		expect(result.winner).toBeUndefined();
		expect(result.rejections[0]?.code).toBe(
			"MIGRATION_REQUIRED_BUT_UNAVAILABLE",
		);
	});

	it("is gated out when secret custody is unavailable", () => {
		const requirement = parseCapabilityRequirement({
			requiredProfiles: [{ profileId: "data.postgres/v1" }],
		});
		const result = selectCapabilityImplementation({
			requirement,
			registry,
			candidates: [
				createPrismaClaimablePostgresCandidate({
					creatorAuthorityAfterClaim: "rotatable",
					secretCustodyAvailable: false,
				}),
			],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW_MS,
		});
		expect(result.winner).toBeUndefined();
		expect(result.rejections[0]?.code).toBe("SECRET_CUSTODY_UNAVAILABLE");
	});

	it("is gated out when the trust evidence has expired", () => {
		const requirement = parseCapabilityRequirement({
			requiredProfiles: [{ profileId: "data.postgres/v1" }],
		});
		const result = selectCapabilityImplementation({
			requirement,
			registry,
			candidates: [
				createPrismaClaimablePostgresCandidate({
					creatorAuthorityAfterClaim: "rotatable",
					evidenceExpiresAtMs: NOW_MS - 1,
				}),
			],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW_MS,
		});
		expect(result.rejections[0]?.code).toBe("EVIDENCE_STALE");
	});

	it("fits inside the default two-action claim budget", () => {
		expect(VERIFIED.claimActionCount).toBeLessThanOrEqual(
			DEFAULT_TRUST_POLICY.maximumClaimActions,
		);
	});

	it("does not advertise a wasm runtime it cannot reach over TCP", () => {
		expect(VERIFIED.runtimeModels).not.toContain("wasm");
	});
});
