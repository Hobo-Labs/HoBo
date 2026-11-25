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
export const BLACKSMITH_PROVIDER_ID = "@hobo/runner-blacksmith";

// public-contract: the Blacksmith runs-on label the fast-runner lane targets.
export const BLACKSMITH_RUNS_ON_DEFAULT = "blacksmith-4vcpu-ubuntu-2204";

export const DEFAULT_REGIONS = ["global"];

// Declared cost facts — Blacksmith public list prices TRANSCRIBED BY HOBO from
// the vendor's published pricing page ($0.004/min for the 4-vCPU Linux class,
// with 3,000 free minutes/month). With GitHub and Blacksmith both registered
// the Dispatcher gets its first real price/performance choice for the same job.
//
// Ranking input, never billing input, and NOT attested by the provider —
// `declared-provider` marks a declared fact as opposed to an
// `observed-executor` measured one. See COST_SOURCE/PROVIDER_TERMS below and
// ADR-0129 §5.
// public-contract: where Blacksmith's published rates were read from, and when.
export const COST_SOURCE: CostProvenance = {
	sourceUrl: "https://www.blacksmith.sh/pricing",
	transcribedOn: "2026-07-27",
};

// public-contract: Blacksmith's terms of service. §3 prohibits acting as a
// service bureau or otherwise letting third parties use the Services — the
// adapter is only ever pointed at the operator's OWN Blacksmith org
// (ADR-0129 §1).
export const PROVIDER_TERMS: ProviderTerms = {
	url: "https://docs.blacksmith.sh/about/terms-of-service",
	reviewedOn: "2026-07-27",
};

export const COST_FACTS = {
	[RUNNER_CATEGORY]: {
		sku: CATEGORY_SKUS[RUNNER_CATEGORY],
		unit: "minute",
		marginalPrice: "0.0040",
		included: 3000,
	},
	[BUILD_MACHINE_CATEGORY]: {
		sku: CATEGORY_SKUS[BUILD_MACHINE_CATEGORY],
		unit: "minute",
		marginalPrice: "0.0040",
		included: 3000,
	},
} satisfies Record<
	ExecutionHostCategory,
	{ sku: string; unit: string; marginalPrice: string; included: number }
>;

// The per-category execution-host manifest (same schema the Dispatcher parses
// for every host): Blacksmith substitutes the runs-on substrate of the GitHub
// Actions job model, so the features declare the fast-runner + sticky-disk
// cache lanes on top of the shared job shape.
export function executionHostManifest(
	category: ExecutionHostCategory,
	options: { providerId?: string } = {},
): ExecutionHostManifest {
	const providerId = options.providerId ?? BLACKSMITH_PROVIDER_ID;
	const port = CATEGORY_PORTS[category];
	const fact = COST_FACTS[category];
	// SAFETY: sortKeys preserves the ExecutionHostManifest field set; schema is the host contract.
	return sortKeys({
		schema: EXECUTION_HOST_MANIFEST_SCHEMA,
		provider: {
			id: providerId,
			category,
			kind: "execution-host-provider",
			adapter: "blacksmith",
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
						? ["ci-job", "workflow-dispatch", "fast-runner"]
						: ["container-build", "ghcr-publish", "docker-layer-cache"],
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

export interface BlacksmithManifestInput {
	providerId?: string;
	regions?: string[];
}

// The registry-facing well-known bundle (HOBO-87 authoring contract): both
// execution-host ports, the brokered credential posture and the declared cost
// facts — what `hobo add runner-blacksmith` snapshots into the
// provider.Registered fact.
export function publishCapabilityManifest(
	input: BlacksmithManifestInput = {},
): PublishedManifestDocuments {
	const providerId = input.providerId ?? BLACKSMITH_PROVIDER_ID;
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
				runsOn: BLACKSMITH_RUNS_ON_DEFAULT,
			};
		}),
	};
	// Secretless posture (HOBO-110): jobs still dispatch through the GitHub
	// Actions job model with broker-minted short-lived installation tokens,
	// and the Blacksmith org relationship itself is held by the Yard broker —
	// no static org token in any Bindle, Camp or this package.
	const authDocument = {
		schema: AUTH_SCHEMA,
		providerId,
		mode: "github-app-installation",
		tokenAudience: "api.github.com",
		exchange: "hobo:brokered-installation-token",
		substrate: {
			vendor: "blacksmith",
			exchange: "hobo:brokered-blacksmith-org-token",
			tokenAudience: "api.blacksmith.sh",
		},
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
		errors.push("auth.staticSecrets must be false (brokered credentials only)");
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
