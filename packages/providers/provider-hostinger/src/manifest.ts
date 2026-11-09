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
export const HOSTINGER_PROVIDER_ID = "@hobo/provider-hostinger";

// Hostinger's data-centre slugs (Phoenix, Boston, Amsterdam, London, São
// Paulo, Mumbai, Singapore, Tokyo). Transcribed from the public locations list,
// not discovered from the account — a location this list is missing is a gap in
// the transcription, never a claim that Hostinger does not serve it.
export const DEFAULT_REGIONS = [
	"phx",
	"bos",
	"ams",
	"lon",
	"sao",
	"mum",
	"sgp",
	"tyo",
];

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
// ranking has honest inputs rather than uniform zeros. Hostinger prices per
// month on a term commitment, so the VPS figure is the monthly plan price
// divided by 730 to make it comparable with the hourly providers; the deep
// multi-year discount Hostinger advertises is a real saving this fact does not
// model, so this over-states the marginal cost rather than under-stating it.
//
// The MySQL price is a genuine zero, and that is not a placeholder: a database
// is included in the hosting plan rather than billed separately, so the
// marginal cost of the database itself really is nothing. The `included: 730`
// free-tier fact is what carries the "it comes with the plan" meaning; a
// nonzero invented price would be the dishonest choice here.
export const COST_FACTS = {
	"web/service": {
		sku: "hostinger.vps.kvm1.instance-hour",
		unit: "instance-hour",
		marginalPrice: "0.0080",
		included: 0,
	},
	"database/mysql": {
		sku: "hostinger.mysql.database-hour",
		unit: "database-hour",
		marginalPrice: "0.0000",
		included: 730,
	},
};

export interface HostingerManifestInput {
	providerId?: string;
	regions?: string[];
	ports?: InitialCapabilityPort[];
}

export function publishCapabilityManifest(
	input: HostingerManifestInput = {},
): PublishedManifestDocuments {
	const providerId = input.providerId ?? HOSTINGER_PROVIDER_ID;
	const regions = input.regions ?? DEFAULT_REGIONS;
	const ports = input.ports ?? INITIAL_CAPABILITY_PORTS;
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
	// The Hostinger API takes an account-scoped API token, and there is no OIDC
	// federation endpoint to exchange an SVID at — so, exactly as the Cloudflare
	// provider does, the keyless posture published here is HoBo's own: the Yard
	// broker holds custody of the token and hands the resolver a *locator*
	// (`scheme://path`). `staticSecrets: false` is a claim about this package,
	// which stores no material anywhere, and not a claim that Hostinger has
	// shipped workload-identity federation. It has not.
	const authDocument = {
		schema: AUTH_SCHEMA,
		providerId,
		mode: "svid-federation",
		tokenAudience: `spiffe://hobo/providers/${providerId.replace("@hobo/", "")}`,
		exchange: "hobo:broker-credential-locator",
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
				pricingStatus: Number(fact.marginalPrice) > 0 ? "estimate" : "unknown",
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
					documentRef: digestRef(`cost:${providerId}:${fact.sku}`),
					// Transcribed from the vendor's public pricing page, not
					// attested by the provider (ADR-0129 §5).
					transcribedOn: "2026-08-19",
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
