import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
	type TrustPolicy,
} from "@hobo/capability-profiles";
import { capability } from "@hobo/core";
import {
	LOCAL_DEFINITIONS,
	LOCAL_ENGINE_GAPS,
	localCandidates,
} from "@hobo/provider-local";
import { NETLIFY_DEFINITIONS } from "@hobo/provider-netlify";
import { PRISMA_RESOURCE_DEFINITION } from "@hobo/provider-prisma-postgres";
import { TTL_SH_RESOURCE_DEFINITION } from "@hobo/provider-ttl-sh";
import { UPSTASH_RESOURCE_DEFINITION } from "@hobo/provider-upstash";
import { VERCEL_SPONSORED_DEFINITIONS } from "@hobo/provider-vercel";
import { LOCALHOST_PROVIDER_ID, seedLocalhostYard } from "@hobo/yards";
import { describe, expect, it } from "vitest";

import {
	CATALOG_GAPS,
	FIRST_PARTY_CANDIDATES,
	FIRST_PARTY_DEFINITIONS,
	firstPartyEvidenceRefs,
} from "../src/first-party-catalog.js";

const SEMANTICS_ONLY_IDS = new Set(
	[
		UPSTASH_RESOURCE_DEFINITION,
		PRISMA_RESOURCE_DEFINITION,
		TTL_SH_RESOURCE_DEFINITION,
		...NETLIFY_DEFINITIONS,
		...VERCEL_SPONSORED_DEFINITIONS,
	]
		.filter((declared) => !("features" in declared))
		.map((declared) => declared.id),
);

const semanticsOnly = FIRST_PARTY_DEFINITIONS.filter((definition) =>
	SEMANTICS_ONLY_IDS.has(definition.id),
);

describe("the catalog as a whole", () => {
	it("registers at least one semantics-only product", () => {
		expect(semanticsOnly.length).toBeGreaterThan(0);
	});

	it("registers at least one product", () => {
		expect(FIRST_PARTY_DEFINITIONS.length).toBeGreaterThan(0);
	});

	it("is sorted by id, so its digest does not depend on import order", () => {
		const ids = FIRST_PARTY_DEFINITIONS.map((definition) => definition.id);
		expect([...ids].sort()).toEqual(ids);
	});

	it("gives every product a distinct id", () => {
		const ids = FIRST_PARTY_DEFINITIONS.map((definition) => definition.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("is frozen, because it is shared by the CLI, the compiler and the matrix", () => {
		expect(Object.isFrozen(FIRST_PARTY_DEFINITIONS)).toBe(true);
	});

	it("carries a semantics block on every entry", () => {
		for (const definition of FIRST_PARTY_DEFINITIONS) {
			expect(definition.semantics).toBeDefined();
			expect(definition.semantics?.trustEvidenceRef).toBeTruthy();
		}
	});

	it("names a provider and a port on every entry", () => {
		for (const definition of FIRST_PARTY_DEFINITIONS) {
			expect(definition.providerId).toBeTruthy();
			expect(definition.port).toBeTruthy();
		}
	});
});

describe("matching a request against a product", () => {
	it("answers full for its own port with no features asked", () => {
		for (const definition of FIRST_PARTY_DEFINITIONS) {
			expect(definition.satisfies({ port: definition.port }).kind).toBe("full");
		}
	});

	it("answers none for a port it does not serve", () => {
		for (const definition of FIRST_PARTY_DEFINITIONS) {
			expect(
				definition.satisfies({ port: "hobo:definitely-not-a-port" }).kind,
			).toBe("none");
		}
	});

	it("answers full when every requested feature is claimed", () => {
		for (const definition of semanticsOnly) {
			if (definition.features.length === 0) continue;
			expect(
				definition.satisfies({
					port: definition.port,
					features: [...definition.features],
				}).kind,
			).toBe("full");
		}
	});

	it("answers partial and names what is missing", () => {
		for (const definition of semanticsOnly) {
			const verdict = definition.satisfies({
				port: definition.port,
				features: ["a-feature-nobody-claims"],
			});
			expect(verdict.kind).toBe("partial");
			expect(verdict.missing).toEqual(["a-feature-nobody-claims"]);
		}
	});

	it("reports only the unclaimed features, not the whole request", () => {
		for (const definition of semanticsOnly) {
			const claimed = definition.features[0];
			if (claimed === undefined) continue;
			const verdict = definition.satisfies({
				port: definition.port,
				features: [claimed, "unclaimed"],
			});
			expect(verdict.missing).toEqual(["unclaimed"]);
		}
	});

	it("hands back a fresh missing array rather than an internal one", () => {
		const definition = semanticsOnly[0];
		if (definition === undefined) return;
		const verdict = definition.satisfies({
			port: definition.port,
			features: ["x"],
		});
		const again = definition.satisfies({
			port: definition.port,
			features: ["x"],
		});
		expect(verdict.missing).not.toBe(again.missing);
	});
});

describe("the legacy half derived from semantics", () => {
	it("derives features from the capabilities the product claims", () => {
		for (const definition of semanticsOnly) {
			const claimed = Object.entries(
				definition.semantics?.structuredCapabilities ?? {},
			)
				.filter(([, value]) => value === true)
				.map(([key]) => key)
				.sort();
			expect(definition.features).toEqual(claimed);
		}
	});

	it("sorts the derived features", () => {
		for (const definition of semanticsOnly) {
			expect([...definition.features].sort()).toEqual(definition.features);
		}
	});

	it("ranks above a generic legacy entry but below a self-pinned one", () => {
		for (const definition of semanticsOnly) {
			expect(definition.specificity).toBe(10);
			expect(definition.priority).toBe(0);
		}
	});

	it("prices at the declared sponsor exposure cap, per deployment", () => {
		for (const definition of semanticsOnly) {
			expect(definition.cost.unit).toBe("deployment");
			expect(definition.cost.sku).toBe(definition.semantics?.productId);
			expect(definition.cost.marginalPrice).toBe(
				String(definition.semantics?.sponsorExposureMinorUnits),
			);
		}
	});
});

describe("the profile-aware projection", () => {
	it("projects every definition", () => {
		expect(FIRST_PARTY_CANDIDATES.length).toBe(FIRST_PARTY_DEFINITIONS.length);
	});

	it("keeps the same ids", () => {
		expect(
			FIRST_PARTY_CANDIDATES.map((candidate) => candidate.definitionId),
		).toEqual(FIRST_PARTY_DEFINITIONS.map((definition) => definition.id));
	});

	it("is frozen too", () => {
		expect(Object.isFrozen(FIRST_PARTY_CANDIDATES)).toBe(true);
	});
});

describe("the evidence refs it expects published", () => {
	it("lists one entry per distinct ref", () => {
		const refs = firstPartyEvidenceRefs();
		expect(new Set(refs).size).toBe(refs.length);
	});

	it("is sorted", () => {
		const refs = firstPartyEvidenceRefs();
		expect([...refs].sort()).toEqual([...refs]);
	});

	it("covers every ref the catalog declares", () => {
		const refs = new Set(firstPartyEvidenceRefs());
		for (const definition of FIRST_PARTY_DEFINITIONS) {
			expect(refs.has(definition.semantics?.trustEvidenceRef ?? "")).toBe(true);
		}
	});
});

describe("products whose declaration has not landed", () => {
	it("names them rather than omitting them", () => {
		expect(CATALOG_GAPS.length).toBeGreaterThan(0);
		for (const gap of CATALOG_GAPS) {
			expect(gap.providerId).toBeTruthy();
			expect(gap.detail.length).toBeGreaterThan(20);
		}
	});

	it("does not list a provider that is already in the catalog", () => {
		const registered = new Set(
			FIRST_PARTY_DEFINITIONS.map((definition) => definition.providerId),
		);
		for (const gap of CATALOG_GAPS) {
			expect(registered.has(gap.providerId)).toBe(false);
		}
	});

	it("is frozen", () => {
		expect(Object.isFrozen(CATALOG_GAPS)).toBe(true);
	});
});

describe("local yard definitions (consumer side of @hobo/provider-local)", () => {
	const profiles = createCapabilityProfileRegistry(
		STANDARD_CAPABILITY_PROFILES,
	);
	const NOW = Date.UTC(2026, 10, 8);
	const policy: TrustPolicy = {
		...DEFAULT_TRUST_POLICY,
		minimumProviderClass: "experimental",
		creatorAuthorityAfterClaim: "must-be-absent",
	};
	const select = (
		profileId: string,
		candidates: ReturnType<typeof localCandidates>,
	) =>
		selectCapabilityImplementation({
			requirement: parseCapabilityRequirement({
				requiredProfiles: [{ profileId, versionRange: ">=1" }],
			}),
			registry: profiles,
			candidates,
			policy,
			nowMs: NOW,
		});

	it("registers the four local definitions", () => {
		const ids = new Set(FIRST_PARTY_DEFINITIONS.map((d) => d.id));
		expect(LOCAL_DEFINITIONS).toHaveLength(4);
		for (const definition of LOCAL_DEFINITIONS) {
			expect(ids.has(definition.id)).toBe(true);
		}
	});

	const FULL_SEED = seedLocalhostYard([
		{ capabilityId: "capability:runtime:node", present: true },
		{ capabilityId: "capability:toolchain:sqlite", present: true },
	]);

	it("stamps the seed's provider id on every local definition", () => {
		for (const definition of LOCAL_DEFINITIONS) {
			expect(definition.providerId).toBe(LOCALHOST_PROVIDER_ID);
		}
	});

	it("maps every local definition to a seed row, profile for profile", () => {
		for (const definition of LOCAL_DEFINITIONS) {
			const rows = FULL_SEED.rows.filter(
				(row) => row.productId === definition.semantics.productId,
			);
			expect(rows.length).toBeGreaterThan(0);
			const seedProfiles = rows.map((row) => row.profile).sort();
			const claimed = definition.semantics.implementsProfiles
				.map((implementation) => implementation.profileId)
				.sort();
			expect(claimed).toEqual(seedProfiles);
		}
	});

	it("partitions the seed products into claimed and named gaps", () => {
		const seedProductIds = [
			...new Set(FULL_SEED.rows.map((row) => row.productId)),
		];
		const claimed = LOCAL_DEFINITIONS.map(
			(definition) => definition.semantics.productId,
		);
		const gaps = LOCAL_ENGINE_GAPS.map((gap) => gap.seedProductId);
		expect([...claimed, ...gaps].sort()).toEqual([...seedProductIds].sort());
	});

	it("never claims a profile the seed lists as unavailable", () => {
		const unavailable = new Set(
			FULL_SEED.unavailable.map((entry) => entry.profile),
		);
		for (const definition of LOCAL_DEFINITIONS) {
			for (const implementation of definition.semantics.implementsProfiles) {
				expect(unavailable.has(implementation.profileId)).toBe(false);
			}
		}
	});

	it("refuses the shipped local candidates: evidence fails closed", () => {
		const shipped = FIRST_PARTY_CANDIDATES.filter(
			(candidate) => candidate.providerId === "local",
		);
		expect(shipped).toHaveLength(4);
		for (const profileId of [
			capability.api.http,
			capability.data.sqlite,
			capability.queue.atLeastOnce,
		]) {
			const result = select(profileId, shipped);
			expect(result.winner).toBeUndefined();
			expect(result.rejections.length).toBeGreaterThan(0);
		}
	});

	it("selects a local winner once the station injects evidence", () => {
		const injected = localCandidates({
			evidenceSignatureValid: true,
			evidenceExpiresAtMs: NOW + 30 * 24 * 60 * 60 * 1000,
			conformance: "pass",
		});
		const expected = [
			[capability.api.http, "local.node-http-server/v1"],
			[capability.data.sqlite, "local.sqlite-file/v1"],
			[capability.queue.atLeastOnce, "local.in-memory-queue/v1"],
		] as const;
		for (const [profileId, definitionId] of expected) {
			const result = select(profileId, injected);
			expect(result.winner?.definitionId).toBe(definitionId);
			expect(result.winner?.providerId).toBe("local");
		}
	});
});
