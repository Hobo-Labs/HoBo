import { canonicalJson, sortKeys, stableDigest } from "@hobo/core";

import {
	BUILD_MACHINE_CATEGORY,
	CATEGORY_PORTS,
	CATEGORY_SKUS,
	COST_SCHEMA,
	type CostProvenance,
	EXECUTION_HOST_MANIFEST_SCHEMA,
	type ExecutionHostCategory,
	type ExecutionHostManifest,
	type ProviderTerms,
	RUNNER_CATEGORY,
} from "@hobo/runner-github";

import { type JsonObject, parseJsonObject } from "./json.js";

// public-contract: capability-manifest bundle schema id (registry parity).
export const MANIFEST_SCHEMA = "hobo.capability-manifest/v1";
// public-contract: capabilities document schema id.
export const CAPABILITIES_SCHEMA = "hobo.capabilities/v1";
// public-contract: auth document schema id.
export const AUTH_SCHEMA = "hobo.provider-auth/v1";

// public-contract: the provider id every published document carries.
export const DEPOT_PROVIDER_ID = "@hobo/runner-depot";

// public-contract: the Depot runs-on label for Depot-managed Actions runners.
export const DEPOT_RUNS_ON_DEFAULT = "depot-ubuntu-22.04";

export const DEFAULT_REGIONS = ["global"];

// Observed ratios land as facts per build; this is the declared expectation.
// public-contract: the declared expected shared-cache hit rate for warm projects.
export const DEPOT_DECLARED_CACHE_HIT_RATE = "0.80";

// Declared cost facts — Depot public list magnitudes TRANSCRIBED BY HOBO from
// the vendor's published pricing page: Depot-managed Actions runners at
// $0.004/min, and remote build machines at $0.04/build-minute with 500
// included minutes/month. Ranking input, never billing input, and NOT attested
// by the provider (see COST_SOURCE/PROVIDER_TERMS below and ADR-0129 §5). The shared BuildKit cache is the economic point:
// a warm-cache Depot build does LESS metered work per identical build, so
// its EFFECTIVE cost can outrank a "free" cold GitHub build — CreditLedger
// ranking captures that through per-build observed cache facts.
// public-contract: where Depot's published rates were read from, and when.
export const COST_SOURCE: CostProvenance = {
	sourceUrl: "https://depot.dev/pricing",
	transcribedOn: "2026-07-27",
};

// public-contract: Depot's terms of service. A login may be used by one person
// only, so the adapter is only ever pointed at the operator's OWN Depot org
// (ADR-0129 §1).
export const PROVIDER_TERMS: ProviderTerms = {
	url: "https://depot.dev/terms-of-service",
	reviewedOn: "2026-07-27",
};

export const COST_FACTS = {
	[RUNNER_CATEGORY]: {
		sku: CATEGORY_SKUS[RUNNER_CATEGORY],
		unit: "minute",
		marginalPrice: "0.0040",
		included: 2000,
	},
	[BUILD_MACHINE_CATEGORY]: {
		sku: CATEGORY_SKUS[BUILD_MACHINE_CATEGORY],
		unit: "minute",
		marginalPrice: "0.0400",
		included: 500,
	},
} satisfies Record<
	ExecutionHostCategory,
	{ sku: string; unit: string; marginalPrice: string; included: number }
>;

// The per-category execution-host manifest (same schema every host parses
// through @hobo/runner-github's boundary): the build-machine side is Depot's
// core product, so its features declare the remote BuildKit + shared-cache
// lanes.
export function executionHostManifest(
	category: ExecutionHostCategory,
	options: { providerId?: string } = {},
): ExecutionHostManifest {
	const providerId = options.providerId ?? DEPOT_PROVIDER_ID;
	const port = CATEGORY_PORTS[category];
	const fact = COST_FACTS[category];
	// SAFETY: sortKeys preserves the ExecutionHostManifest field set; schema is the host contract.
	return sortKeys({
		schema: EXECUTION_HOST_MANIFEST_SCHEMA,
		provider: {
			id: providerId,
			category,
			kind: "execution-host-provider",
			adapter: "depot",
		},
		capabilities: [
			{
				port,
				interface:
					category === RUNNER_CATEGORY
						? "hobo:runner/job"
						: "hobo:build-machine/host",
				version: "0.1.0",
				stability: "preview",
				features:
					category === RUNNER_CATEGORY
						? ["ci-job", "workflow-dispatch", "depot-managed-runner"]
						: ["container-build", "remote-buildkit", "shared-cache"],
			},
		],
		cost: {
			schema: COST_SCHEMA,
			currency: "USD",
			facts: [
				{
					sku: fact.sku,
					unit: fact.unit,
					marginalPrice: fact.marginalPrice,
					freeTier: {
						unit: fact.unit,
						included: fact.included,
						reset: "monthly",
					},
					source: {
						type: "declared-provider",
						digest: stableDigest({
							providerId,
							category,
							sku: fact.sku,
							marginalPrice: fact.marginalPrice,
							included: fact.included,
						}),
					},
				},
			],
		},
	}) as ExecutionHostManifest;
}

export interface PublishedManifestDocuments {
	"/.well-known/capability-manifest/index.json": string;
	"/.well-known/capability-manifest/capabilities.json": string;
	"/.well-known/capability-manifest/auth.json": string;
	"/.well-known/capability-manifest/cost.json": string;
}

export interface DepotManifestInput {
	providerId?: string;
	regions?: string[];
}

// The registry-facing well-known bundle (HOBO-87 authoring contract): both
// execution-host ports, the brokered-token posture, the declared cost facts
// AND the declared shared-cache hit rate — what `hobo add runner-depot`
// snapshots into the provider.Registered fact.
export function publishCapabilityManifest(
	input: DepotManifestInput = {},
): PublishedManifestDocuments {
	const providerId = input.providerId ?? DEPOT_PROVIDER_ID;
	const regions = input.regions ?? DEFAULT_REGIONS;
	const categories: ExecutionHostCategory[] = [
		RUNNER_CATEGORY,
		BUILD_MACHINE_CATEGORY,
	];
	const capabilitiesDocument = {
		schema: CAPABILITIES_SCHEMA,
		providerId,
		capabilities: categories.map((category) => {
			const manifest = executionHostManifest(category, { providerId });
			const capability = manifest.capabilities[0];
			// Refuse rather than emit a capability with holes in it. Optional
			// chaining here would leave `port`, `interface`, `version` and
			// `stability` undefined, and `canonicalJson` drops undefined fields —
			// so a manifest missing its capability would publish as a document
			// that parses cleanly and describes nothing a consumer can dispatch
			// against. Every category has exactly one capability by construction;
			// if that ever stops being true, this is the line that should say so.
			if (capability === undefined)
				throw new Error(
					`execution host manifest for ${category} declares no capability`,
				);
			return {
				port: capability.port,
				interface: capability.interface,
				version: capability.version,
				stability: capability.stability,
				features: [...capability.features],
				regions: [...regions],
				category,
				...(category === RUNNER_CATEGORY
					? { runsOn: DEPOT_RUNS_ON_DEFAULT }
					: {
							sharedCache: { declaredHitRate: DEPOT_DECLARED_CACHE_HIT_RATE },
						}),
			};
		}),
	};
	// Secretless posture (HOBO-110): the Yard broker holds the Depot OIDC
	// trust relationship and mints SHORT-LIVED project tokens per operation —
	// no static Depot token in any Bindle, Camp or this package.
	const authDocument = {
		schema: AUTH_SCHEMA,
		providerId,
		mode: "oidc-trust-exchange",
		tokenAudience: "api.depot.dev",
		exchange: "hobo:brokered-depot-project-token",
		broker: {
			issuer: "https://identity.hobo.local",
			tokenExchange: "urn:ietf:params:oauth:grant-type:token-exchange",
		},
		requiredClaims: ["sub", "aud", "exp", "scope"],
		staticSecrets: false,
	};
	const costDocument = {
		schema: COST_SCHEMA,
		providerId,
		currency: "USD",
		facts: categories.map((category) => {
			const fact = COST_FACTS[category];
			return {
				port: CATEGORY_PORTS[category],
				sku: fact.sku,
				unit: fact.unit,
				marginalPrice: fact.marginalPrice,
				freeTier: {
					unit: fact.unit,
					included: fact.included,
					reset: "monthly",
				},
				...(category === BUILD_MACHINE_CATEGORY
					? { sharedCache: { declaredHitRate: DEPOT_DECLARED_CACHE_HIT_RATE } }
					: undefined),
				source: {
					type: "declared-provider",
					documentRef: stableDigest({ providerId, sku: fact.sku }),
					...COST_SOURCE,
				},
			};
		}),
	};
	const documents = [
		{
			path: "/.well-known/capability-manifest/capabilities.json",
			schema: CAPABILITIES_SCHEMA,
			digest: stableDigest(capabilitiesDocument),
		},
		{
			path: "/.well-known/capability-manifest/auth.json",
			schema: AUTH_SCHEMA,
			digest: stableDigest(authDocument),
		},
		{
			path: "/.well-known/capability-manifest/cost.json",
			schema: COST_SCHEMA,
			digest: stableDigest(costDocument),
		},
	];
	const indexDocument = {
		schema: "hobo.capability-manifest-index/v1",
		providerId,
		manifestSchema: MANIFEST_SCHEMA,
		executionHostSchema: EXECUTION_HOST_MANIFEST_SCHEMA,
		documents,
	};

	return {
		"/.well-known/capability-manifest/index.json": canonicalJson(indexDocument),
		"/.well-known/capability-manifest/capabilities.json":
			canonicalJson(capabilitiesDocument),
		"/.well-known/capability-manifest/auth.json": canonicalJson(authDocument),
		"/.well-known/capability-manifest/cost.json": canonicalJson(costDocument),
	};
}

export interface PublishedManifestParseResult {
	ok: boolean;
	errors: string[];
	index: JsonObject;
	capabilities: JsonObject;
	auth: JsonObject;
	cost: JsonObject;
}

/**
 * Parse-don't-validate boundary for the published well-known bundle: untrusted
 * documents become a parsed result or structured errors (secretless posture is
 * parse-enforced — `staticSecrets` must be `false`).
 */
export function parsePublishedManifest(
	documents: PublishedManifestDocuments,
): PublishedManifestParseResult {
	const index = parseJsonObject(
		documents["/.well-known/capability-manifest/index.json"],
	);
	const capabilities = parseJsonObject(
		documents["/.well-known/capability-manifest/capabilities.json"],
	);
	const auth = parseJsonObject(
		documents["/.well-known/capability-manifest/auth.json"],
	);
	const cost = parseJsonObject(
		documents["/.well-known/capability-manifest/cost.json"],
	);
	const errors: string[] = [];

	if (index.manifestSchema !== MANIFEST_SCHEMA) {
		errors.push(`index.manifestSchema must be ${MANIFEST_SCHEMA}`);
	}
	if (auth.schema !== AUTH_SCHEMA) {
		errors.push(`auth.schema must be ${AUTH_SCHEMA}`);
	}
	if (cost.schema !== COST_SCHEMA) {
		errors.push(`cost.schema must be ${COST_SCHEMA}`);
	}
	if ("staticKey" in auth || "clientSecret" in auth || "pat" in auth) {
		errors.push("auth must not publish static secrets");
	}
	if (auth.staticSecrets !== false) {
		errors.push("auth.staticSecrets must be false (brokered tokens only)");
	}
	if (
		!Array.isArray(capabilities.capabilities) ||
		capabilities.capabilities.length !== 2
	) {
		errors.push(
			"capabilities.capabilities must declare exactly the two execution-host ports",
		);
	}

	return {
		ok: errors.length === 0,
		errors,
		index,
		capabilities,
		auth,
		cost,
	};
}
