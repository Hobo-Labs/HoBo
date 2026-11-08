/**
 * The first-party catalog, and the two shapes providers declare it in.
 *
 * Matching cannot select a product nobody registered, so this module is the
 * gate every first-party product passes through. It holds no product facts of
 * its own — each entry is a re-export of a declaration living beside the driver
 * that honours it — which makes the *adaptation* the thing to test: providers
 * declare in two different shapes and the catalog has to render both into one.
 *
 * **A legacy declaration brings its own port/feature half; a semantics-only one
 * does not.** For the second, the legacy half is derived rather than invented —
 * `features` comes from the boolean structured capabilities the product
 * actually claims. That is what keeps the two matching paths from disagreeing
 * about the same product: `satisfies` answers the legacy port/feature question
 * using the same facts profile matching reads. A derived feature list that
 * drifted from the semantics would let a product pass one path and fail the
 * other.
 *
 * **Order is load-bearing.** The catalog is sorted by id so its digest — and
 * every signed resolution receipt that pins it — is independent of import
 * order. A catalog that reordered when someone moved an import line would
 * invalidate receipts without any product changing.
 *
 * **Cost is a claim about money.** Semantics-only entries price at the declared
 * sponsor exposure cap, because that is the only cost figure this repo is
 * entitled to state: transcribed vendor prices are ranking input, never billing
 * input.
 *
 * Nothing here decides whether a product is *usable* — trust evidence and
 * conformance are judged downstream at a supplied instant. Registration only
 * makes a product visible to that judgement.
 */
import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
	type TrustPolicy,
} from "@hobo/capability-profiles";
import { capability } from "@hobo/core";
import { LOCAL_DEFINITIONS, localCandidates } from "@hobo/provider-local";
import { NETLIFY_DEFINITIONS } from "@hobo/provider-netlify";
import { PRISMA_RESOURCE_DEFINITION } from "@hobo/provider-prisma-postgres";
import { TTL_SH_RESOURCE_DEFINITION } from "@hobo/provider-ttl-sh";
import { UPSTASH_RESOURCE_DEFINITION } from "@hobo/provider-upstash";
import { VERCEL_SPONSORED_DEFINITIONS } from "@hobo/provider-vercel";
import { describe, expect, it } from "vitest";

import {
	CATALOG_GAPS,
	FIRST_PARTY_CANDIDATES,
	FIRST_PARTY_DEFINITIONS,
	firstPartyEvidenceRefs,
} from "../src/first-party-catalog.js";

/**
 * Ids whose provider declared semantics only, asked of the declarations.
 *
 * The catalog does not record which shape an entry arrived in, and inferring it
 * from the rendered result would make these tests circular -- "entries with
 * specificity 10 have specificity 10". Asking the source declarations instead
 * keeps the assertions independent of the code under test, and means a provider
 * that later adds its legacy half moves to the other set automatically rather
 * than silently failing an assertion that no longer applies to it.
 */
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
		// Guards the rest of this file: every assertion below is vacuous over an
		// empty catalog, and an import that silently stopped contributing would
		// otherwise look like a pass.
		expect(FIRST_PARTY_DEFINITIONS.length).toBeGreaterThan(0);
	});

	it("is sorted by id, so its digest does not depend on import order", () => {
		// Signed resolution receipts pin this digest. Reordering when someone
		// moves an import line would invalidate them without a product changing.
		const ids = FIRST_PARTY_DEFINITIONS.map((definition) => definition.id);
		expect([...ids].sort()).toEqual(ids);
	});

	it("gives every product a distinct id", () => {
		// Two entries under one id make selection depend on iteration order.
		const ids = FIRST_PARTY_DEFINITIONS.map((definition) => definition.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("is frozen, because it is shared by the CLI, the compiler and the matrix", () => {
		expect(Object.isFrozen(FIRST_PARTY_DEFINITIONS)).toBe(true);
	});

	it("carries a semantics block on every entry", () => {
		// Registration is what makes a product visible to the downstream trust
		// judgement, and that judgement reads the semantics. An entry without one
		// would be selectable but un-gateable.
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
		// Not partial. A different port is not a partial match with everything
		// missing -- it is a different question.
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
		// The missing list is what a caller shows an operator. A partial verdict
		// with an empty list says "not quite" and nothing else.
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
		// The verdict is spread on the way out. A caller that sorted the missing
		// list in place would otherwise reorder the catalog's own state.
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
		// Only the ones set to `true`, so a structured capability declared false
		// is not advertised as a feature. Deriving from key presence instead
		// would advertise everything the product had an opinion about.
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
		// They go into the catalog digest, so key order in the semantics block
		// must not change it.
		for (const definition of semanticsOnly) {
			expect([...definition.features].sort()).toEqual(definition.features);
		}
	});

	it("ranks above a generic legacy entry but below a self-pinned one", () => {
		// specificity 10, priority 0: more specific than an unranked legacy port
		// entry, never outranking a product that stated its own numbers.
		for (const definition of semanticsOnly) {
			expect(definition.specificity).toBe(10);
			expect(definition.priority).toBe(0);
		}
	});

	it("prices at the declared sponsor exposure cap, per deployment", () => {
		// The only cost figure this repo may state. A transcribed vendor price
		// here would be a billing input the repo cannot stand behind.
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
		// The two views are read by different callers; a product visible to one
		// and not the other is selectable by only half the system.
		expect(FIRST_PARTY_CANDIDATES.length).toBe(FIRST_PARTY_DEFINITIONS.length);
	});

	it("keeps the same ids", () => {
		// The projection names the definition it came from `definitionId`, not
		// `id` -- it is a candidate, not a definition.
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
		// Several products can share a ref; publishing checks should ask for it
		// once.
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
		// So an empty matrix cell traces to a named piece of missing work rather
		// than to a silent omission in an import list -- "no Neon coverage yet"
		// has to read differently from "Neon is broken".
		expect(CATALOG_GAPS.length).toBeGreaterThan(0);
		for (const gap of CATALOG_GAPS) {
			expect(gap.providerId).toBeTruthy();
			expect(gap.detail.length).toBeGreaterThan(20);
		}
	});

	it("does not list a provider that is already in the catalog", () => {
		// A gap for a registered provider is a stale note, and the next reader
		// would take it as current.
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
	const profiles = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);
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
