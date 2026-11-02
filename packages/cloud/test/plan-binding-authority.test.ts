/**
 * Planning with Yard binding authority (ADR-0157).
 *
 * The point of these tests is the wire that did not exist: the ADR-0151
 * capability-profile pipeline computed a winning product and its Yard-scoped
 * realization parameters, and nothing carried them onto the plan, so a
 * deployment driver could never act on a Yard's declared configuration. These
 * assert that the product and parameters now reach both the decision (the audit
 * trail) and the plan node (what gets built), and — just as important — that
 * omitting the authority leaves the legacy path byte-for-byte unchanged.
 */
import { type ManifestV1, parseManifest } from "@hobo/bindles";
import {
	createCapabilityProfileRegistry,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	type TrustPolicy,
} from "@hobo/capability-profiles";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import { describe, expect, it } from "vitest";

import {
	canonicalPlanJson,
	createRegistryFromProviders,
	type PlanBindingAuthority,
	parseResourceDefinitionVNext,
	plan,
	RESOURCE_DEFINITION_VNEXT_SCHEMA,
	type ResourceDefinitionSemantics,
	type ResourceDefinitionVNext,
	type YardBindingContext,
} from "../src/index.js";
import { type JsonObject } from "../src/json.js";


const NOW = Date.UTC(2026, 7, 8);

const profiles = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);

const policy: TrustPolicy = {
	minimumProviderClass: "experimental",
	maximumClaimActions: 4,
	creatorAuthorityAfterClaim: "may-be-retained",
	allowPack: true,
	allowBridge: true,
	allowSponsor: true,
	requireExportProfile: false,
	requireSecretCustody: true,
	maximumEvidenceAgeMs: 30 * 24 * 60 * 60 * 1000,
	maximumSponsorExposureMinorUnits: 10_000,
};

function semantics(
	overrides: Partial<ResourceDefinitionSemantics> & {
		productId: string;
		implementsProfiles: ResourceDefinitionSemantics["implementsProfiles"];
	},
): ResourceDefinitionSemantics {
	return {
		schemaVersion: RESOURCE_DEFINITION_VNEXT_SCHEMA,
		displayName: overrides.productId,
		runtimeModels: ["paas"],
		structuredCapabilities: {},
		placementConstraints: [],
		producesBindingProfiles: ["binding.http/v1"],
		migrationProfiles: [],
		bootstrapStrategyRef: "bootstrap.anonymous-claimable/v1",
		claimStrategyRef: "claim.resource/v1",
		compilerRef: "compile.test/v1",
		executorRef: "execute.test/v1",
		permissionProfileRef: "permissions.test/v1",
		trustEvidenceRef: "evidence.test/v1",
		sourceEvidenceRefs: [],
		remediation: [],
		providerClass: "established",
		evidenceExpiresAtMs: NOW + 86_400_000,
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
		secretCustodyAvailable: true,
		...overrides,
	};
}

function definition(
	id: string,
	providerId: string,
	productId: string,
	profileId: string,
): ResourceDefinitionVNext {
	return parseResourceDefinitionVNext({
		id,
		providerId,
		port: "kv",
		features: [],
		regions: [],
		specificity: 1,
		priority: 1,
		cost: { sku: id, unit: "hour", marginalPrice: "0" },
		// SAFETY: `satisfies: () => ({ ok: true, missing: [] }) as never,` is required at this I/O or test boundary.
		satisfies: () => ({ ok: true, missing: [] }) as never,
		semantics: semantics({
			productId,
			implementsProfiles: [
				{
					profileId,
					versionRange: ">=1",
					realization: "native",
					conformanceRef: "conformance.kv/v1",
					conformance: "pass",
				},
			],
		}),
	});
}

// Two Cloudflare offerings for the same capability — the normal case for a
// catalog, and precisely what makes the Yard's row the deciding constraint.
const kvDefinition = definition(
	"cloudflare.kv/v1",
	"cloudflare",
	"cloudflare.kv/v1",
	"kv.key-value/v1",
);
const durableDefinition = definition(
	"cloudflare.durable-kv/v1",
	"cloudflare",
	"cloudflare.durable-kv/v1",
	"kv.key-value/v1",
);

const kvRequirement = parseCapabilityRequirement({
	requiredProfiles: [{ profileId: "kv.key-value/v1", versionRange: ">=1" }],
});

function helloBindle(): ManifestV1 {
	return parseManifest({
		schema: "hobo.manifest/v1",
		componentHost: { kind: "wasmtime", version: "1.0.0" },
		resources: {
			sessions: { type: "data.v1", port: "kv" },
		},
	});
}

function registry() {
	return createRegistryFromProviders([createCloudflareProvider()]);
}

function authority(
	yard: YardBindingContext,
	overrides: Partial<PlanBindingAuthority> = {},
): PlanBindingAuthority {
	return {
		yard,
		profiles,
		definitions: [kvDefinition, durableDefinition],
		policy,
		nowMs: NOW,
		requirements: { sessions: kvRequirement },
		...overrides,
	};
}

const kvYard = (
	productId: string,
	properties?: JsonObject,
): YardBindingContext => ({
	yardId: "yard:edge",
	providerId: "cloudflare",
	bindings: [
		{
			contract: "hobo.yard-binding/v1",
			profile: "kv.key-value/v1",
			productId,
			...(properties !== undefined ? { properties } : undefined),
		},
	],
});

describe("plan() with Yard binding authority", () => {
	it("lands the selected product on both the decision and the plan node", () => {
		const result = plan(
			helloBindle(),
			{
				deploymentId: "d-1",
				binding: authority(kvYard("cloudflare.kv/v1")),
			},
			registry(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const node = result.plan.resources.find((r) => r.name === "sessions");
		expect(node?.productId).toBe("cloudflare.kv/v1");
		const decision = result.decisions.find((d) => d.resource === "sessions");
		expect(decision?.productId).toBe("cloudflare.kv/v1");
	});

	it("carries the Yard's realization parameters onto the plan node", () => {
		const result = plan(
			helloBindle(),
			{
				deploymentId: "d-2",
				binding: authority(
					kvYard("cloudflare.kv/v1", { ttlSeconds: 3600, tier: "standard" }),
				),
			},
			registry(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const node = result.plan.resources.find((r) => r.name === "sessions");
		expect(node?.realizationParameters).toEqual({
			ttlSeconds: 3600,
			tier: "standard",
		});
		// Provider-native parameters are a non-portable surface, and the scorer
		// needs to name *which* row cost the portability, not merely that
		// something did.
		expect(node?.nonPortableRows?.length).toBeGreaterThan(0);
	});

	it("the row is the deciding constraint: a different row selects a different product", () => {
		const first = plan(
			helloBindle(),
			{ deploymentId: "d-3", binding: authority(kvYard("cloudflare.kv/v1")) },
			registry(),
		);
		const second = plan(
			helloBindle(),
			{
				deploymentId: "d-3",
				binding: authority(kvYard("cloudflare.durable-kv/v1")),
			},
			registry(),
		);
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.plan.resources[0]?.productId).toBe("cloudflare.kv/v1");
		expect(second.plan.resources[0]?.productId).toBe(
			"cloudflare.durable-kv/v1",
		);
	});

	it("fails closed when the Yard's rows admit nothing, rather than falling back", () => {
		// A row naming a product no definition publishes must refuse. Falling
		// through to the port-only winner would deploy an offering the Yard never
		// declared — the Yard's authority would be advisory, not binding.
		const result = plan(
			helloBindle(),
			{
				deploymentId: "d-4",
				binding: authority(kvYard("cloudflare.not-registered/v1")),
			},
			registry(),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.remediations.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.remediations)).toContain(
			"cloudflare.not-registered/v1",
		);
	});

	it("is deterministic: two passes over the same authority are byte-identical", () => {
		const config = {
			deploymentId: "d-5",
			binding: authority(kvYard("cloudflare.kv/v1", { ttlSeconds: 60 })),
		};
		const a = plan(helloBindle(), config, registry());
		const b = plan(helloBindle(), config, registry());
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(canonicalPlanJson(a.plan)).toBe(canonicalPlanJson(b.plan));
	});
});

describe("plan() without binding authority", () => {
	it("leaves the legacy path untouched — no productId, no parameters", () => {
		const result = plan(helloBindle(), { deploymentId: "d-6" }, registry());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const node = result.plan.resources[0];
		// Absent means "not decided here", never "any product will do". A driver
		// reading this plan must fail closed rather than guess a product.
		expect(node?.productId).toBeUndefined();
		expect(node?.realizationParameters).toBeUndefined();
	});

	it("a resource with no requirement entry keeps its legacy decision", () => {
		// The authority covers `sessions` only; a manifest resource outside
		// `requirements` must not be refused for lacking an entry.
		const manifest = parseManifest({
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasmtime", version: "1.0.0" },
			resources: {
				sessions: { type: "data.v1", port: "kv" },
				assets: { type: "data.v1", port: "objectStore" },
			},
		});
		const result = plan(
			manifest,
			{ deploymentId: "d-7", binding: authority(kvYard("cloudflare.kv/v1")) },
			registry(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const assets = result.plan.resources.find((r) => r.name === "assets");
		expect(assets).toBeDefined();
		expect(assets?.productId).toBeUndefined();
	});
});
