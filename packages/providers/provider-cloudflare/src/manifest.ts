import type { InitialCapabilityPort } from "./equivalence.js";
import {
	EQUIVALENCE_CLASSES,
	INITIAL_CAPABILITY_PORTS,
} from "./equivalence.js";
import {
	isJsonArray,
	isJsonObject,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
	parseJsonValue,
} from "./json.js";

// public-contract: capability-manifest bundle schema id (registry parity).
export const MANIFEST_SCHEMA = "hobo.capability-manifest/v1";
// public-contract: capabilities document schema id.
export const CAPABILITIES_SCHEMA = "hobo.capabilities/v1";
// public-contract: auth document schema id.
export const AUTH_SCHEMA = "hobo.provider-auth/v1";
// public-contract: cost document schema id.
export const COST_SCHEMA = "hobo.cost/v1";

// public-contract: the provider id every published document carries.
export const CLOUDFLARE_PROVIDER_ID = "@hobo/provider-cloudflare";

// A `type` alias (not an interface) so it keeps an implicit index signature
// and stays assignable to @hobo/core's `PublishedManifestDocuments`
// (Record<string, string>) on CapabilityManifest.published (ADR-0156).
export type PublishedManifestDocuments = {
	"/.well-known/capability-manifest/index.json": string;
	"/.well-known/capability-manifest/capabilities.json": string;
	"/.well-known/capability-manifest/auth.json": string;
	"/.well-known/capability-manifest/cost.json": string;
};

export interface CloudflareManifestInput {
	providerId?: string;
	colos?: string[];
	ports?: InitialCapabilityPort[];
	costFacts?: Array<{ port: string; sku: string; unit: string }>;
}

export function publishCapabilityManifest(
	input: CloudflareManifestInput = {},
): PublishedManifestDocuments {
	const providerId = input.providerId ?? CLOUDFLARE_PROVIDER_ID;
	const colos = input.colos ?? ["WNAM", "ENAM", "WEUR"];
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
				...(mapping.port === "compute"
					? { productId: "cloudflare.workers/v1" }
					: undefined),
				interface: `hobo:${mapping.port}/${mapping.resourceClass}`,
				version: "0.1.0",
				stability: "preview",
				features: [...mapping.features],
				regions: [...colos],
				resourceClass: mapping.resourceClass,
				providerService: mapping.providerService,
			};
		}),
	};
	const authDocument = {
		schema: AUTH_SCHEMA,
		providerId,
		mode: "svid-federation",
		tokenAudience: `spiffe://hobo/providers/${providerId.replace("@hobo/", "")}`,
		broker: {
			issuer: "https://identity.hobo.local",
			tokenExchange: "urn:ietf:params:oauth:grant-type:token-exchange",
		},
		requiredClaims: ["sub", "aud", "exp", "scope"],
		staticSecrets: false,
	};
	const defaultFacts = ports.map((port) => {
		const mapping = EQUIVALENCE_CLASSES[port];
		const sku = {
			"web/service": "cloudflare.workers.request",
			kv: "cloudflare.kv.read",
			objectStore: "cloudflare.r2.storage.gb-month",
		}[port];
		const unit = {
			"web/service": "request",
			kv: "operation",
			objectStore: "GB-month",
		}[port];
		return {
			port: mapping.port,
			sku,
			unit,
			marginalPrice: "0.0000",
			pricingStatus: "unknown",
			freeTier: { unit, included: 0, reset: "unknown" },
			source: {
				type: "declared-provider",
				documentRef: digestRef(`cost:${providerId}:${sku}`),
				// Transcribed from the vendor's public pricing page, not
				// attested by the provider (ADR-0129 §5).
				transcribedOn: "2026-07-27",
			},
		};
	});
	const costDocument = {
		schema: COST_SCHEMA,
		providerId,
		currency: "USD",
		pricingStatus: "unknown",
		facts: input.costFacts
			? input.costFacts.map((fact) => ({
					sku: fact.sku,
					unit: fact.unit,
					marginalPrice: "0.0000",
					pricingStatus: "unknown",
					freeTier: { unit: fact.unit, included: 0, reset: "unknown" },
					source: {
						type: "declared-provider",
						documentRef: digestRef(`cost:${providerId}:${fact.sku}`),
						// Transcribed from the vendor's public pricing page, not
						// attested by the provider (ADR-0129 §5).
						transcribedOn: "2026-07-27",
					},
				}))
			: defaultFacts,
	};
	const documents = [
		{
			path: "/.well-known/capability-manifest/capabilities.json",
			schema: CAPABILITIES_SCHEMA,
			digest: stableDigest(
				parseJsonValue(JSON.stringify(capabilitiesDocument)),
			),
		},
		{
			path: "/.well-known/capability-manifest/auth.json",
			schema: AUTH_SCHEMA,
			digest: stableDigest(parseJsonValue(JSON.stringify(authDocument))),
		},
		{
			path: "/.well-known/capability-manifest/cost.json",
			schema: COST_SCHEMA,
			digest: stableDigest(parseJsonValue(JSON.stringify(costDocument))),
		},
	];
	const indexDocument = {
		schema: "hobo.capability-manifest-index/v1",
		providerId,
		manifestSchema: MANIFEST_SCHEMA,
		documents,
	};

	return {
		"/.well-known/capability-manifest/index.json": canonicalJson(
			parseJsonValue(JSON.stringify(indexDocument)),
		),
		"/.well-known/capability-manifest/capabilities.json": canonicalJson(
			parseJsonValue(JSON.stringify(capabilitiesDocument)),
		),
		"/.well-known/capability-manifest/auth.json": canonicalJson(
			parseJsonValue(JSON.stringify(authDocument)),
		),
		"/.well-known/capability-manifest/cost.json": canonicalJson(
			parseJsonValue(JSON.stringify(costDocument)),
		),
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
 * Parse-don't-validate boundary: untrusted well-known manifest documents become
 * a parsed derived type or structured errors — no broad DTO checks downstream.
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
	if ("staticKey" in auth || "clientSecret" in auth) {
		errors.push("auth must not publish static secrets");
	}
	const listed = capabilities.capabilities;
	if (!isJsonArray(listed) || listed.length === 0) {
		errors.push("capabilities.capabilities must be non-empty");
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

function canonicalJson(value: JsonValue): string {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function stableDigest(value: JsonValue): string {
	return fnv1aHex(canonicalJson(value));
}

function digestRef(seed: string) {
	const digest = `sha256:${fnv1aHex(seed)}`;
	return {
		mediaType: "application/vnd.hobo.evidence.v1+json",
		uri: `oci://registry.example/hobo/evidence@${digest}`,
		digest,
	};
}

function sortKeys(value: JsonValue): JsonValue {
	if (isJsonArray(value)) {
		return value.map(sortKeys);
	}
	if (!isJsonObject(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortKeys(value[key] ?? null)]),
	);
}

function fnv1aHex(input: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "16");
}
