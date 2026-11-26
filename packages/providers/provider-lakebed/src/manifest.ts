import {
	AUTH_SCHEMA,
	CAPABILITIES_SCHEMA,
	COST_SCHEMA,
	canonicalJson,
	digestRef,
	MANIFEST_SCHEMA,
	stableDigest,
} from "@hobo/core";
import {
	EQUIVALENCE_CLASSES,
	INITIAL_CAPABILITY_PORTS,
	type InitialCapabilityPort,
} from "./equivalence.js";

// The schema ids are platform contract, so they live in @hobo/core and are
// re-exported here to keep this package's public surface unchanged.
export {
	AUTH_SCHEMA,
	CAPABILITIES_SCHEMA,
	COST_SCHEMA,
	MANIFEST_SCHEMA,
} from "@hobo/core";

// public-contract: the provider id every published document carries.
export const LAKEBED_PROVIDER_ID = "@hobo/provider-lakebed";

export const DEFAULT_REGIONS = ["global"];

// A `type` alias (not an interface) so it keeps an implicit index signature
// and stays assignable to @hobo/core's `PublishedManifestDocuments`
// (Record<string, string>) on CapabilityManifest.published (ADR-0156).
export type PublishedManifestDocuments = {
	"/.well-known/capability-manifest/index.json": string;
	"/.well-known/capability-manifest/capabilities.json": string;
	"/.well-known/capability-manifest/auth.json": string;
	"/.well-known/capability-manifest/cost.json": string;
};

// Declared marginal-cost facts per equivalence class — REAL public list-price
// magnitudes (representative SKUs, declared-provider source), so min-cost
// ranking has honest inputs rather than uniform zeros.
export const COST_FACTS = {
	"web/service": {
		sku: "lakebed.capsule.request",
		unit: "request",
		marginalPrice: "0.0000010",
		included: 1_000_000,
	},
	kv: {
		sku: "lakebed.kv.operation",
		unit: "operation",
		marginalPrice: "0.0000005",
		included: 1_000_000,
	},
	objectStore: {
		sku: "lakebed.files.gb-month",
		unit: "GB-month",
		marginalPrice: "0.0300",
		included: 1,
	},
	"database/reactive": {
		sku: "lakebed.reactivedb.read-unit",
		unit: "read-unit",
		marginalPrice: "0.0000004",
		included: 1_000_000,
	},
} satisfies Record<
	InitialCapabilityPort,
	{ sku: string; unit: string; marginalPrice: string; included: number }
>;

export interface LakebedManifestInput {
	providerId?: string;
	regions?: string[];
	ports?: InitialCapabilityPort[];
}

export function publishCapabilityManifest(
	input: LakebedManifestInput = {},
): PublishedManifestDocuments {
	const providerId = input.providerId ?? LAKEBED_PROVIDER_ID;
	const regions = input.regions ?? DEFAULT_REGIONS;
	const ports = input.ports ?? [...INITIAL_CAPABILITY_PORTS];
	const capabilitiesDocument = {
		schema: CAPABILITIES_SCHEMA,
		providerId,
		equivalenceClasses: ports.map((port) => {
			const mapping = EQUIVALENCE_CLASSES[port];
			// `features` is a readonly tuple on the mapping, and a readonly array
			// is not a `JsonValue` — spreading the mapping wholesale carries that
			// readonly-ness into the document and the digest call rejects it.
			// Copying is what publishing means here anyway: the document is a
			// snapshot, not a live view of the table it was built from.
			return {
				class: port,
				...mapping,
				features: [...mapping.features],
			};
		}),
		capabilities: ports.map((port) => {
			const mapping = EQUIVALENCE_CLASSES[port];
			return {
				port: mapping.port,
				interface: `hobo:${mapping.port}/${mapping.resourceClass}`,
				version: "0.1.0",
				stability: "preview",
				features: [...mapping.features],
				regions: [...regions],
				resourceClass: mapping.resourceClass,
				providerService: mapping.providerService,
			};
		}),
	};
	// Secretless-first posture for a closed PaaS: the Yard broker holds the
	// vendor relationship and mints SHORT-LIVED, deployment-scoped deploy
	// tokens per operation — no static Lakebed token is ever stored in a
	// Bindle, Camp, or this package (HOBO-110 brokered-credential model).
	const authDocument = {
		schema: AUTH_SCHEMA,
		providerId,
		mode: "svid-federation",
		tokenAudience: "lakebed.deploy",
		exchange: "hobo:brokered-deploy-token",
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
		facts: ports.map((port) => {
			const mapping = EQUIVALENCE_CLASSES[port];
			const fact = COST_FACTS[port];
			return {
				port: mapping.port,
				sku: fact.sku,
				unit: fact.unit,
				marginalPrice: fact.marginalPrice,
				pricingStatus: "estimate",
				freeTier: {
					unit: fact.unit,
					included: fact.included,
					reset: "monthly",
				},
				source: {
					type: "declared-provider",
					documentRef: digestRef(`cost:${providerId}:${fact.sku}`),
					// Transcribed from the vendor's public pricing page, not
					// attested by the provider (ADR-0129 §5).
					transcribedOn: "2026-07-27",
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

export type { PublishedManifestParseResult } from "@hobo/core";
export { parsePublishedManifest } from "@hobo/core";
