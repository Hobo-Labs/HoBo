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
	CLOUDFLARE_TEMPORARY_ACCOUNT_DEFINITIONS,
	CLOUDFLARE_TEMPORARY_D1,
	CLOUDFLARE_TEMPORARY_HYPERDRIVE,
	CLOUDFLARE_TEMPORARY_QUEUE_CONSUMER,
	CLOUDFLARE_TEMPORARY_WORKERS_WEB,
} from "../src/temporary-account-definitions.js";

const registry = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);
const NOW = Date.parse("2026-08-08T12:00:00.000Z");

/** A genuine PostgreSQL product, for the comparison D1 must lose. */
const REAL_POSTGRES: SelectionCandidate = {
	definitionId: "example.managed-postgres/v1",
	providerId: "example",
	implementsProfiles: [
		{
			profileId: "data.postgres/v1",
			versionRange: ">=1",
			realization: "native",
			conformanceRef: "conformance.example.postgres",
			conformance: "pass",
		},
	],
	runtimeModels: ["serverless_faas", "wasm"],
	structuredCapabilities: { postgresWireProtocol: true, tls: true },
	producesBindingProfiles: ["binding.postgresql/v1"],
	migrationProfiles: [],
	providerClass: "established",
	evidenceExpiresAtMs: Date.parse("2027-02-08T00:00:00.000Z"),
	evidenceSignatureValid: true,
	creatorAuthorityAfterClaim: "rotatable",
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

describe("temporary-account product definitions", () => {
	it("names every published product exactly once", () => {
		expect(
			CLOUDFLARE_TEMPORARY_ACCOUNT_DEFINITIONS.map((d) => d.definitionId),
		).toEqual([
			"cloudflare.temporary-d1/v1",
			"cloudflare.temporary-durable-object/v1",
			"cloudflare.temporary-hyperdrive/v1",
			"cloudflare.temporary-kv/v1",
			"cloudflare.temporary-queue/v1",
			"cloudflare.temporary-queue-consumer/v1",
			"cloudflare.temporary-webhook-realtime/v1",
			"cloudflare.temporary-workers-api/v1",
			"cloudflare.temporary-workers-web/v1",
		]);
	});

	it("uses profile ids the registry actually knows", () => {
		for (const definition of CLOUDFLARE_TEMPORARY_ACCOUNT_DEFINITIONS) {
			for (const implementation of definition.implementsProfiles) {
				expect(
					registry.has(implementation.profileId),
					`${definition.definitionId} claims unknown profile ${implementation.profileId}`,
				).toBe(true);
			}
		}
	});

	it("declares reauthorization-required authority on every product", () => {
		for (const definition of CLOUDFLARE_TEMPORARY_ACCOUNT_DEFINITIONS) {
			expect(definition.creatorAuthorityAfterClaim).toBe(
				"reauthorization-required",
			);
			expect(definition.continuity.credentials).toBe("revoked");
			expect(definition.sponsorExposureMinorUnits).toBe(0);
		}
	});

	it("records the workers.dev-only web surface", () => {
		expect(
			CLOUDFLARE_TEMPORARY_WORKERS_WEB.structuredCapabilities.customDomain,
		).toBe(false);
		expect(
			CLOUDFLARE_TEMPORARY_WORKERS_WEB.structuredCapabilities.maxFileCount,
		).toBe(1000);
		expect(
			CLOUDFLARE_TEMPORARY_WORKERS_WEB.structuredCapabilities.maxFileMebibytes,
		).toBe(5);
	});

	it("never claims scheduled execution: Cron Triggers are unsupported", () => {
		for (const definition of CLOUDFLARE_TEMPORARY_ACCOUNT_DEFINITIONS) {
			for (const implementation of definition.implementsProfiles) {
				expect(
					registry.satisfies(implementation.profileId, "service.scheduled/v1"),
				).toBe(false);
			}
		}
		expect(
			CLOUDFLARE_TEMPORARY_QUEUE_CONSUMER.implementsProfiles.map(
				(i) => i.profileId,
			),
		).toEqual(["service.queue-consumer/v1"]);
	});
});

describe("cloudflare.temporary-d1/v1 is relational, not PostgreSQL", () => {
	it("implements data.sqlite and data.relational but never data.postgres", () => {
		const claimed = CLOUDFLARE_TEMPORARY_D1.implementsProfiles.map(
			(i) => i.profileId,
		);
		expect(claimed).toContain("data.sqlite/v1");
		expect(claimed).toContain("data.relational/v1");
		expect(claimed).not.toContain("data.postgres/v1");
		for (const profileId of claimed) {
			expect(registry.satisfies(profileId, "data.postgres/v1")).toBe(false);
			expect(registry.satisfies(profileId, "data.relational/v1")).toBe(true);
		}
	});

	it("loses a data.postgres/v1 requirement to a real PostgreSQL product", () => {
		const result = selectCapabilityImplementation({
			requirement: parseCapabilityRequirement({
				requiredProfiles: [{ profileId: "data.postgres/v1" }],
			}),
			registry,
			candidates: [CLOUDFLARE_TEMPORARY_D1, REAL_POSTGRES],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW,
		});

		expect(result.winner?.definitionId).toBe("example.managed-postgres/v1");
		expect(result.ranked.map((c) => c.definitionId)).not.toContain(
			"cloudflare.temporary-d1/v1",
		);
		expect(result.rejections).toContainEqual({
			definitionId: "cloudflare.temporary-d1/v1",
			code: "PROFILE_INCOMPATIBLE",
			detail: "does not implement data.postgres/v1 >=1",
		});
	});

	it("still wins a plain data.relational/v1 requirement", () => {
		const result = selectCapabilityImplementation({
			requirement: parseCapabilityRequirement({
				requiredProfiles: [{ profileId: "data.relational/v1" }],
			}),
			registry,
			candidates: [CLOUDFLARE_TEMPORARY_D1],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW,
		});
		expect(result.winner?.definitionId).toBe("cloudflare.temporary-d1/v1");
	});
});

describe("cloudflare.temporary-hyperdrive/v1 is connectivity only", () => {
	it("implements no capability profile and produces a postgres binding", () => {
		expect(CLOUDFLARE_TEMPORARY_HYPERDRIVE.implementsProfiles).toEqual([]);
		expect(CLOUDFLARE_TEMPORARY_HYPERDRIVE.producesBindingProfiles).toEqual([
			"binding.postgresql/v1",
		]);
		expect(
			CLOUDFLARE_TEMPORARY_HYPERDRIVE.structuredCapabilities.maxConfigurations,
		).toBe(2);
		expect(
			CLOUDFLARE_TEMPORARY_HYPERDRIVE.structuredCapabilities.maxConnections,
		).toBe(10);
	});

	it("satisfies no data requirement at all", () => {
		for (const profileId of ["data.postgres/v1", "data.relational/v1"]) {
			const result = selectCapabilityImplementation({
				requirement: parseCapabilityRequirement({
					requiredProfiles: [{ profileId }],
				}),
				registry,
				candidates: [CLOUDFLARE_TEMPORARY_HYPERDRIVE],
				policy: DEFAULT_TRUST_POLICY,
				nowMs: NOW,
			});
			expect(result.winner).toBeUndefined();
			expect(result.rejections[0]?.code).toBe("PROFILE_INCOMPATIBLE");
		}
	});
});
