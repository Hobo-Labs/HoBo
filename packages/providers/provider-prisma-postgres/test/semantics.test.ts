/**
 * The catalog record.
 *
 * Two jobs here. First, hold the structural mirror of
 * `ResourceDefinitionSemantics` honest — `src/semantics.ts` re-declares that
 * shape locally so a provider stays a leaf, and a re-declaration that drifts is
 * worse than an import. Second, pin the parse rules `parseResourceDefinitionVNext`
 * enforces, so a definition that would be rejected at catalog load is rejected
 * here instead, where the message is about this package.
 */
import { describe, expect, it } from "vitest";
import {
	isJsonArray,
	isJsonObject,
	type JsonValue,
	parseJsonValue,
} from "../src/json.js";
import {
	createPrismaClaimablePostgresSemantics,
	createPrismaResourceDefinition,
	PRISMA_CLAIMABLE_POSTGRES_SEMANTICS,
	PRISMA_PLACEMENT_CONSTRAINTS,
	PRISMA_REMEDIATION,
	PRISMA_RESOURCE_DEFINITION,
	RESOURCE_DEFINITION_VNEXT_SCHEMA,
} from "../src/semantics.js";

/**
 * The field list `@hobo/cloud` requires, transcribed from
 * `packages/cloud/src/registry/resource-definition-vnext.ts`. If that type
 * grows a required field, this list is where the mirror gets updated.
 */
const REQUIRED_SEMANTICS_FIELDS = [
	"schemaVersion",
	"productId",
	"displayName",
	"implementsProfiles",
	"runtimeModels",
	"structuredCapabilities",
	"placementConstraints",
	"producesBindingProfiles",
	"migrationProfiles",
	"bootstrapStrategyRef",
	"claimStrategyRef",
	"compilerRef",
	"executorRef",
	"permissionProfileRef",
	"trustEvidenceRef",
	"sourceEvidenceRefs",
	"remediation",
	"providerClass",
	"evidenceSignatureValid",
	"creatorAuthorityAfterClaim",
	"claimAtomicity",
	"claimActionCount",
	"continuity",
	"supportsExport",
	"supportsRotation",
	"supportsRevocation",
	"sponsorExposureMinorUnits",
	"secretCustodyAvailable",
] as const;

describe("semantics block", () => {
	const semantics = PRISMA_CLAIMABLE_POSTGRES_SEMANTICS;

	it("declares every field the vNext schema requires", () => {
		for (const field of REQUIRED_SEMANTICS_FIELDS) {
			expect(semantics, `missing ${field}`).toHaveProperty(field);
			expect(semantics[field], `${field} is undefined`).toBeDefined();
		}
	});

	it("uses the schema version the catalog parser checks for", () => {
		expect(semantics.schemaVersion).toBe(RESOURCE_DEFINITION_VNEXT_SCHEMA);
		expect(semantics.schemaVersion).toBe("hobo.resource-definition/vNext");
	});

	it("passes the rules parseResourceDefinitionVNext enforces", () => {
		expect(semantics.implementsProfiles.length).toBeGreaterThan(0);
		expect(Number.isInteger(semantics.claimActionCount)).toBe(true);
		expect(semantics.claimActionCount).toBeGreaterThanOrEqual(0);
		expect(semantics.sponsorExposureMinorUnits).toBeGreaterThanOrEqual(0);
		expect(semantics.executorRef.length).toBeGreaterThan(0);
	});

	it("names the product, provider, and strategy refs the brief specifies", () => {
		expect(semantics.productId).toBe("prisma.claimable-postgres");
		expect(PRISMA_RESOURCE_DEFINITION.id).toBe("prisma.claimable-postgres/v1");
		expect(PRISMA_RESOURCE_DEFINITION.providerId).toBe("prisma");
		expect(semantics.bootstrapStrategyRef).toBe(
			"bootstrap.prisma.create-db/v1",
		);
		expect(semantics.claimStrategyRef).toBe("claim.prisma.database/v1");
	});

	it("implements data.postgres/v1 natively and produces the postgres binding", () => {
		expect(semantics.implementsProfiles).toEqual([
			expect.objectContaining({
				profileId: "data.postgres/v1",
				realization: "native",
				versionRange: ">=1",
			}),
		]);
		expect(semantics.producesBindingProfiles).toEqual([
			"binding.postgresql/v1",
		]);
	});

	it("offers pg-dump only, because logical replication is not documented here", () => {
		expect(semantics.migrationProfiles).toEqual([
			"migration.postgres.pg-dump/v1",
		]);
	});

	it("runs on paas and does not claim a wasm-reachable transport", () => {
		expect(semantics.runtimeModels).toContain("paas");
		expect(semantics.runtimeModels).not.toContain("wasm");
	});

	it("declares secret custody, which the trust policy requires", () => {
		expect(semantics.secretCustodyAvailable).toBe(true);
	});

	it("leaves undocumented capabilities absent rather than optimistic", () => {
		for (const key of [
			"extensions",
			"maxConnections",
			"maxStorageBytes",
			"serverVersion",
		]) {
			expect(semantics.structuredCapabilities).not.toHaveProperty(key);
		}
	});

	it("labels the expiry source honestly", () => {
		expect(semantics.structuredCapabilities.expirySource).toBe(
			"cli-local-clock",
		);
		expect(semantics.structuredCapabilities.documentedTtlHours).toBe(24);
	});

	it("ships creator authority unknown until a human verifies rotation", () => {
		expect(semantics.creatorAuthorityAfterClaim).toBe("unknown");
		expect(semantics.continuity.credentials).toBe("unknown");
		expect(semantics.supportsRotation).toBe(false);

		const verified = createPrismaClaimablePostgresSemantics({
			creatorAuthorityAfterClaim: "rotatable",
			supportsRotation: true,
		});
		expect(verified.creatorAuthorityAfterClaim).toBe("rotatable");
		expect(verified.supportsRotation).toBe(true);
	});

	it("constrains placement to the six regions the pinned CLI accepts", () => {
		const regions = PRISMA_PLACEMENT_CONSTRAINTS.find(
			(constraint) => constraint.key === "region",
		);
		expect(regions?.operator).toBe("in");
		expect(regions?.values).toEqual([
			"ap-northeast-1",
			"ap-southeast-1",
			"eu-central-1",
			"eu-west-3",
			"us-east-1",
			"us-west-1",
		]);
	});

	it("carries remediation for every failure a caller can actually hit", () => {
		expect(PRISMA_REMEDIATION.map((hint) => hint.code)).toEqual([
			"STRONG_CLAIM_REQUIRED",
			"PROVIDER_RATE_LIMITED",
			"LEASE_EXPIRED",
			"PROVIDER_OPERATION_AMBIGUOUS",
			"MIGRATION_FAILED",
		]);
		for (const hint of PRISMA_REMEDIATION) {
			expect(hint.message.length).toBeGreaterThan(40);
		}
	});

	it("cites its sources", () => {
		expect(semantics.sourceEvidenceRefs).toContain(
			"https://docs.prisma.io/docs/postgres/npx-create-db",
		);
		expect(semantics.trustEvidenceRef).toContain("create-db@1.2.1");
	});

	it("is data: serializable, with no function anywhere in the block", () => {
		expect(() => JSON.stringify(semantics)).not.toThrow();
		const tagOf = Object.prototype.toString;
		const walk = (value: JsonValue): void => {
			expect(tagOf.call(value)).not.toBe("[object Function]");
			expect(tagOf.call(value)).not.toBe("[object AsyncFunction]");
			if (isJsonArray(value)) {
				for (const item of value) walk(item);
				return;
			}
			if (isJsonObject(value)) {
				for (const item of Object.values(value)) walk(item);
			}
		};
		walk(parseJsonValue(JSON.stringify(semantics)));
	});

	it("carries no credential-shaped material", () => {
		const serialized = JSON.stringify(semantics);
		expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//u);
		expect(serialized).not.toMatch(/\/\/[^/\s:@]+:[^/\s:@]+@/u);
	});
});

describe("legacy definition half", () => {
	it("still matches through the port/feature path", () => {
		const definition = createPrismaResourceDefinition();
		expect(definition.satisfies({ port: "data" })).toEqual({ kind: "full" });
		expect(
			definition.satisfies({
				port: "data",
				features: ["postgres", "claimable"],
			}),
		).toEqual({
			kind: "full",
		});
		expect(definition.satisfies({ port: "queue" })).toEqual({ kind: "none" });
		expect(
			definition.satisfies({ port: "data", features: ["vector-search"] }),
		).toEqual({
			kind: "partial",
			missing: ["vector-search"],
		});
	});

	it("prices at zero and sponsors nothing", () => {
		expect(PRISMA_RESOURCE_DEFINITION.cost.marginalPrice).toBe("0");
		expect(PRISMA_CLAIMABLE_POSTGRES_SEMANTICS.sponsorExposureMinorUnits).toBe(
			0,
		);
	});

	it("ranks below anything that survives the night", () => {
		// A 24-hour database winning a tie against a durable one would be the
		// single worst default in this package.
		expect(PRISMA_RESOURCE_DEFINITION.priority).toBeLessThanOrEqual(10);
	});
});
