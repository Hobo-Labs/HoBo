import { BINDING_UNAVAILABLE_REMEDIATION } from "@hobo/bindings";
import {
	createCapabilityProfileRegistry,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	type TrustPolicy,
} from "@hobo/capability-profiles";
import { describeConcern } from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";
import {
	capabilityRequirementFromBindleRequirements,
	matchCapabilityRequirement,
	parseResourceDefinitionVNext,
	profileCatalogHash,
	RESOURCE_DEFINITION_VNEXT_SCHEMA,
	type ResourceDefinitionSemantics,
	type ResourceDefinitionVNext,
	type YardBindingContext,
	type YardBindingRow,
} from "../src/index.js";
import { isJsonString, type JsonObject } from "../src/json.js";


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

const NOW = Date.UTC(2026, 7, 8);

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
		producesBindingProfiles: ["binding.postgresql/v1"],
		migrationProfiles: ["migration.postgres.pg-dump/v1"],
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
	sem: ResourceDefinitionSemantics,
): ResourceDefinitionVNext {
	return parseResourceDefinitionVNext({
		id,
		providerId,
		port: "data",
		features: [],
		regions: [],
		specificity: 1,
		priority: 1,
		cost: { sku: id, unit: "hour", marginalPrice: "0" },
		// SAFETY: `satisfies: () => ({ ok: true, missing: [] }) as never,` is required at this I/O or test boundary.
		satisfies: () => ({ ok: true, missing: [] }) as never,
		semantics: sem,
	});
}

const neon = definition(
	"neon.claimable-postgres/v1",
	"neon",
	semantics({
		productId: "neon.claimable-postgres",
		implementsProfiles: [
			{
				profileId: "data.postgres/v1",
				versionRange: ">=1",
				realization: "native",
				conformanceRef: "conformance.postgres/v1",
				conformance: "pass",
			},
		],
	}),
);

const d1 = definition(
	"cloudflare.temporary-d1/v1",
	"cloudflare",
	semantics({
		productId: "cloudflare.temporary-d1",
		implementsProfiles: [
			{
				profileId: "data.sqlite/v1",
				versionRange: ">=1",
				realization: "native",
				conformanceRef: "conformance.sqlite/v1",
				conformance: "pass",
			},
		],
		producesBindingProfiles: ["binding.http/v1"],
		migrationProfiles: [],
	}),
);

const postgresRequirement = parseCapabilityRequirement({
	requiredProfiles: [{ profileId: "data.postgres/v1", versionRange: ">=1" }],
});

const POSTGRES_CLAIM = [
	{
		profileId: "data.postgres/v1",
		versionRange: ">=1",
		realization: "native" as const,
		conformanceRef: "conformance.postgres/v1",
		conformance: "pass" as const,
	},
];

const NAMED = { neon, d1 } as const;

interface DefinitionSpec {
	readonly id: string;
	readonly providerId: string;
	/** Merged into the semantics; `implementsProfiles` defaults to Postgres. */
	readonly semantics?: JsonObject;
}

const resolve = (spec: keyof typeof NAMED | DefinitionSpec) =>
	isJsonString(spec)
		? NAMED[spec]
		: definition(
				spec.id,
				spec.providerId,
				// SAFETY: `semantics({` is required at this I/O or test boundary.
				semantics({
					productId: spec.id.split("/")[0] ?? spec.id,
					implementsProfiles: POSTGRES_CLAIM,
					...spec.semantics,
				} as never),
			);

interface Ask {
	readonly requirement?: JsonObject;
	/** Built from Bindle-declared requirements instead of a parsed one. */
	readonly fromBindle?: Parameters<
		typeof capabilityRequirementFromBindleRequirements
	>[0];
	readonly definitions: readonly (keyof typeof NAMED | DefinitionSpec)[];
}

function match(ask: Ask) {
	const requirement = ask.fromBindle
		// SAFETY: `? capabilityRequirementFromBindleRequirements(ask.fromBindle as never)` is required at this I/O or test boundary.
		? capabilityRequirementFromBindleRequirements(ask.fromBindle)
		: parseCapabilityRequirement(
				// SAFETY: `(ask.requirement ?? {` is required at this I/O or test boundary.
				(ask.requirement ?? {
					requiredProfiles: [
						{ profileId: "data.postgres/v1", versionRange: ">=1" },
					],
				}) as never,
			);
	if (requirement === undefined) throw new Error("no capability requirement");
	return matchCapabilityRequirement({
		resourceName: "db",
		requirement,
		profiles,
		definitions: ask.definitions.map(resolve),
		policy,
		nowMs: NOW,
	});
}

describeConcern("profile-aware matching", {
	cases: `${import.meta.dirname}/profile-matching.cases.jsonl`,
	subject: () => ({
		match: (ask: Ask) => {
			const outcome = match(ask);
			return outcome.ok
				? {
						ok: true,
						definitionId: outcome.definition.id,
						ranking: outcome.ranking,
						rejections: [],
						remediationCode: null,
					}
				: {
						ok: false,
						definitionId: null,
						ranking: [],
						rejections: outcome.rejections.map((r) => r.code).sort(),
						remediationCode: outcome.remediation.code,
					};
		},
		/** Registration order must decide nothing — neither ranking nor hash. */
		isOrderIndependent: (ask: Ask) => {
			const forward = match(ask);
			const reverse = match({
				...ask,
				definitions: [...ask.definitions].reverse(),
			});
			if (!forward.ok || !reverse.ok) return false;
			return (
				JSON.stringify(forward.ranking) === JSON.stringify(reverse.ranking) &&
				forward.catalogHash === reverse.catalogHash
			);
		},
		/** A conformance result is part of the catalog's identity. */
		catalogHashesDiffer: (
			a: readonly (keyof typeof NAMED | DefinitionSpec)[],
			b: readonly (keyof typeof NAMED | DefinitionSpec)[],
		) =>
			profileCatalogHash(a.map(resolve), profiles) !==
			profileCatalogHash(b.map(resolve), profiles),
		/** A bare port name belongs to the legacy matcher, not to a guess. */
		bindleRequirement: (input: JsonObject) =>
			// SAFETY: `capabilityRequirementFromBindleRequirements(input as never) ?? null,` is required at this I/O or test boundary.
			capabilityRequirementFromBindleRequirements(input as never) ?? null,
		/** Semantics without an executor is a refusal, not a warning. */
		parseDefinition: (spec: DefinitionSpec) => resolve(spec).id,
	}),
});

// --- Yard binding rows (ADR-0157) -------------------------------------------
// Rows are a hard filter in front of the ADR-0151 gate sequence. They remove
// candidates; they never reorder survivors and never rescue a gated candidate.

const pooled = definition(
	"neon.pooled-postgres/v1",
	"neon",
	semantics({
		productId: "neon.pooled-postgres",
		implementsProfiles: neon.semantics?.implementsProfiles ?? [],
		claimActionCount: 2,
		claimAtomicity: "best-effort-saga",
	}),
);

// Provider-coherent with the Yard, but semantically ineligible: it exists to
// prove a row cannot admit a candidate another gate refuses.
const neonSqlite = definition(
	"neon.sqlite-shim/v1",
	"neon",
	semantics({
		productId: "neon.sqlite-shim",
		implementsProfiles: d1.semantics?.implementsProfiles ?? [],
	}),
);

const neonStale = definition(
	"neon.stale-postgres/v1",
	"neon",
	semantics({
		productId: "neon.stale-postgres",
		implementsProfiles: neon.semantics?.implementsProfiles ?? [],
		evidenceExpiresAtMs: NOW - 1,
	}),
);

function yardContext(
	bindings: readonly YardBindingRow[],
	overrides: Partial<Omit<YardBindingContext, "bindings">> = {},
): YardBindingContext {
	return {
		yardId: "yard:prod",
		providerId: "neon",
		bindings,
		...overrides,
	};
}

const CATALOG = [d1, neon, neonSqlite, neonStale, pooled];

describe("yard binding rows in profile matching", () => {
	it("narrows the catalog to the products the rows name", () => {
		const outcome = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([
				{ profile: "data.postgres/v1", productId: "neon.pooled-postgres" },
			]),
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.ranking).toEqual(["neon.pooled-postgres/v1"]);
		expect(outcome.definition.id).toBe("neon.pooled-postgres/v1");
	});

	it("carries the row's provider-native realization parameters onto the outcome", () => {
		// The configuration half of a Yard binding (ADR-0157): the row selects the
		// product, these parameterize how it is realized in this Yard. Without
		// this, a Yard could say "use this product" but not "configured this way",
		// which is the mapping an ops manager actually writes.
		const outcome = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([
				{
					profile: "data.postgres/v1",
					productId: "neon.pooled-postgres",
					properties: { replicas: 2, instanceClass: "db.r6g.large" },
				},
			]),
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.realizationParameters).toEqual({
			instanceClass: "db.r6g.large",
			replicas: 2,
		});
		// Provider-native parameters make the Yard non-portable, and the scorer
		// must be able to name WHICH row did it, not merely that something did.
		expect(outcome.nonPortableRows).toEqual([
			"data.postgres/v1|neon.pooled-postgres|",
		]);
	});

	it("omits the parameter block entirely when no applied row carries properties", () => {
		const outcome = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([
				{ profile: "data.postgres/v1", productId: "neon.pooled-postgres" },
			]),
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// Absent, not an empty object: "this Yard added no provider-native
		// configuration" and "it added an empty one" are different claims.
		expect("realizationParameters" in outcome).toBe(false);
		expect("nonPortableRows" in outcome).toBe(false);
	});

	it("refuses two rows that disagree on the same realization parameter", () => {
		// Rows are a set, so there is no precedence rule to appeal to. Picking one
		// silently would make realization depend on iteration order.
		expect(() =>
			matchCapabilityRequirement({
				resourceName: "db",
				requirement: postgresRequirement,
				profiles,
				definitions: CATALOG,
				policy,
				nowMs: NOW,
				yard: yardContext([
					{
						profile: "data.postgres/v1",
						productId: "neon.pooled-postgres",
						properties: { replicas: 2 },
					},
					{
						profile: "data.postgres/v1",
						productId: "neon.claimable-postgres",
						properties: { replicas: 5 },
					},
				]),
			}),
		).toThrow(/disagree on realization parameter "replicas"/u);
	});

	it("merges compatible parameters from several rows deterministically", () => {
		const rows = [
			{
				profile: "data.postgres/v1",
				productId: "neon.pooled-postgres",
				properties: { replicas: 2 },
			},
			{
				profile: "data.postgres/v1",
				productId: "neon.claimable-postgres",
				properties: { backupWindow: "03:00-04:00" },
			},
		];
		const forward = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext(rows),
		});
		const reversed = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([...rows].reverse()),
		});
		expect(forward.ok && reversed.ok).toBe(true);
		if (!forward.ok || !reversed.ok) return;
		expect(forward.realizationParameters).toEqual({
			backupWindow: "03:00-04:00",
			replicas: 2,
		});
		// Authoring order must not change the realization.
		expect(reversed.realizationParameters).toEqual(
			forward.realizationParameters,
		);
		expect(reversed.nonPortableRows).toEqual(forward.nonPortableRows);
	});

	it("records the applied rows on the accepted outcome for the audit trail", () => {
		const outcome = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([
				{ profile: "data.postgres/v1", productId: "neon.pooled-postgres" },
				{ profile: "data.postgres/v1", productId: "neon.claimable-postgres" },
				{ profile: "kv.redis/v1", productId: "somebody.redis" },
			]),
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// Only rows for a profile this requirement names are applied, and they are
		// recorded in canonical order so the audit trail is order-independent.
		expect(outcome.appliedRows).toEqual([
			"data.postgres/v1|neon.claimable-postgres|",
			"data.postgres/v1|neon.pooled-postgres|",
		]);
		// No row pinned connectivity, so no complete resolution fact is emitted.
		expect(outcome.bindingResolved).toBeUndefined();
	});

	it("pins the connectivity implementation when exactly one row names it", () => {
		const outcome = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([
				{
					profile: "data.postgres/v1",
					productId: "neon.claimable-postgres",
					connectivityId: "cloudflare.postgres.hyperdrive/v1",
				},
			]),
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const fact = outcome.bindingResolved;
		expect(fact).toBeDefined();
		if (fact === undefined) return;
		expect(fact.type).toBe("binding.Resolved");
		expect(fact.data.contract).toBe("hobo.binding-resolution/v1");
		expect(fact.data.yardId).toBe("yard:prod");
		expect(fact.data.profile).toBe("data.postgres/v1");
		expect(fact.data.productId).toBe("neon.claimable-postgres");
		expect(fact.data.connectivityId).toBe("cloudflare.postgres.hyperdrive/v1");
		expect(fact.data.realization).toBe("native");
		expect(fact.data.consideredCount).toBe(CATALOG.length);
		expect(fact.data.appliedRows).toEqual([
			"data.postgres/v1|neon.claimable-postgres|cloudflare.postgres.hyperdrive/v1",
		]);
		expect(Object.isFrozen(fact)).toBe(true);
		expect(Object.isFrozen(fact.data)).toBe(true);
	});

	it("treats the row set as a set: authoring order changes nothing", () => {
		const rows: readonly YardBindingRow[] = [
			{ profile: "data.postgres/v1", productId: "neon.claimable-postgres" },
			{ profile: "data.postgres/v1", productId: "neon.pooled-postgres" },
		];
		const forward = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext(rows),
		});
		const reverse = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([...rows].reverse()),
		});
		expect(forward).toEqual(reverse);
	});

	it("filters without reordering: survivor order is identical with and without rows", () => {
		const withoutRows = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
		});
		const withRows = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([
				// Deliberately authored lowest-ranked first: if rows influenced
				// ordering at all, `neon.pooled-postgres` would surface first.
				{ profile: "data.postgres/v1", productId: "neon.pooled-postgres" },
				{ profile: "data.postgres/v1", productId: "neon.claimable-postgres" },
			]),
		});
		expect(withoutRows.ok && withRows.ok).toBe(true);
		if (!withoutRows.ok || !withRows.ok) return;
		const survivors = new Set(withRows.ranking);
		// Every surviving candidate keeps its relative position from the
		// unconstrained ranking — rows subtract, they never promote.
		expect(withRows.ranking).toEqual(
			withoutRows.ranking.filter((id) => survivors.has(id)),
		);
		expect(withRows.ranking).toEqual([
			"neon.claimable-postgres/v1",
			"neon.pooled-postgres/v1",
		]);
		expect(withRows.definition.id).toBe(withoutRows.definition.id);
	});

	it("fails closed when a row names a product absent from the catalog", () => {
		const outcome = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([
				{ profile: "data.postgres/v1", productId: "acme.not-registered" },
			]),
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.rejections.map((r) => r.code)).toEqual([
			"YARD_BINDING_PRODUCT_UNKNOWN",
		]);
		expect(outcome.remediation.code).toBe(
			"capability.yard-binding-unsatisfiable",
		);
		expect(outcome.bindingUnavailable?.type).toBe("binding.Unavailable");
		expect(outcome.bindingUnavailable?.data.code).toBe(
			"YARD_BINDING_PRODUCT_UNKNOWN",
		);
		expect(outcome.bindingUnavailable?.data.remediation).toBe(
			BINDING_UNAVAILABLE_REMEDIATION.YARD_BINDING_PRODUCT_UNKNOWN,
		);
		expect(outcome.bindingUnavailable?.data.yardId).toBe("yard:prod");
	});

	it("fails closed when a row names a product published by another provider", () => {
		const outcome = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([
				{ profile: "data.postgres/v1", productId: "cloudflare.temporary-d1" },
			]),
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.rejections.map((r) => r.code)).toEqual([
			"YARD_BINDING_PROVIDER_MISMATCH",
		]);
		expect(outcome.rejections[0]?.definitionId).toBe(
			"cloudflare.temporary-d1/v1",
		);
		expect(outcome.bindingUnavailable?.data.code).toBe(
			"YARD_BINDING_PROVIDER_MISMATCH",
		);
	});

	it("names the rows when they exclude every otherwise-eligible candidate", () => {
		const outcome = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([
				{ profile: "data.postgres/v1", productId: "neon.sqlite-shim" },
			]),
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		const excluded = outcome.rejections.filter(
			(rejection) => rejection.code === "YARD_BINDING_EXCLUDED_ALL",
		);
		expect(excluded.map((rejection) => rejection.definitionId)).toEqual([
			"cloudflare.temporary-d1/v1",
			"neon.claimable-postgres/v1",
			"neon.pooled-postgres/v1",
			"neon.stale-postgres/v1",
		]);
		// The admitted candidate still failed its own gate; the row did not save it.
		expect(outcome.rejections.map((r) => r.code)).toContain(
			"PROFILE_INCOMPATIBLE",
		);
		expect(outcome.bindingUnavailable?.data.code).toBe(
			"YARD_BINDING_EXCLUDED_ALL",
		);
		expect(outcome.bindingUnavailable?.data.consideredCount).toBe(
			CATALOG.length,
		);
	});

	it("never admits a candidate that failed another gate", () => {
		const outcome = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([
				{ profile: "data.postgres/v1", productId: "neon.stale-postgres" },
			]),
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.rejections.map((r) => r.code)).toContain("EVIDENCE_STALE");
		expect(
			outcome.rejections.some(
				(r) => r.definitionId === "neon.stale-postgres/v1",
			),
		).toBe(true);
	});

	it("ignores rows for profiles this requirement does not name", () => {
		const outcome = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([
				{ profile: "kv.redis/v1", productId: "acme.not-registered" },
			]),
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.definition.id).toBe("neon.claimable-postgres/v1");
		expect(outcome.appliedRows).toEqual([]);
	});

	it("regression guard: omitting the Yard leaves the outcome byte-identical", () => {
		const baseline = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
		});
		const emptyYard = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: CATALOG,
			policy,
			nowMs: NOW,
			yard: yardContext([]),
		});
		expect(baseline.ok && emptyYard.ok).toBe(true);
		if (!baseline.ok || !emptyYard.ok) return;
		// Same ranking, same rejections, same hash, same winner — the only
		// difference is the audit record the Yard's presence adds.
		expect(emptyYard.ranking).toEqual(baseline.ranking);
		expect(emptyYard.rejections).toEqual(baseline.rejections);
		expect(emptyYard.catalogHash).toEqual(baseline.catalogHash);
		expect(emptyYard.definition.id).toEqual(baseline.definition.id);
		expect(emptyYard.tie).toEqual(baseline.tie);
		expect("appliedRows" in baseline).toBe(false);
		expect("bindingResolved" in baseline).toBe(false);
		expect(emptyYard.appliedRows).toEqual([]);
	});

	it("regression guard: a refusal without a Yard carries no binding fact", () => {
		const outcome = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: [d1],
			policy,
			nowMs: NOW,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(Object.keys(outcome).sort()).toEqual([
			"catalogHash",
			"ok",
			"rejections",
			"remediation",
		]);
	});

	// The companion to the rejected-shape case above: Yard bindings must not
	// widen the *accepted* outcome either, when no Yard supplies rows at all.
	it("keeps the accepted outcome shape unchanged when no Yard supplies rows", () => {
		const outcome = matchCapabilityRequirement({
			resourceName: "db",
			requirement: postgresRequirement,
			profiles,
			definitions: [d1, neon],
			policy,
			nowMs: NOW,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(Object.keys(outcome).sort()).toEqual([
			"catalogHash",
			"definition",
			"ok",
			"ranking",
			"rejections",
			"tie",
		]);
	});
});
