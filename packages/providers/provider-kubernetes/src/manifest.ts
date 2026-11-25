import {
	AUTH_SCHEMA,
	CAPABILITIES_SCHEMA,
	COST_SCHEMA,
	canonicalJson,
	digestRef,
	MANIFEST_SCHEMA,
	stableDigest,
} from "@hobo/core";
import type { InitialCapabilityPort } from "./equivalence.js";
import { EQUIVALENCE_CLASSES } from "./equivalence.js";
import { cloneAsJson } from "./json.js";

export {
	AUTH_SCHEMA,
	CAPABILITIES_SCHEMA,
	COST_SCHEMA,
	MANIFEST_SCHEMA,
} from "@hobo/core";

// public-contract: the provider id every published document carries.
export const KUBERNETES_PROVIDER_ID = "@hobo/provider-kubernetes";

// A cluster has no region list of its own: where its nodes run is a fact about
export const DEFAULT_REGIONS = ["in-cluster"];

export type PublishedManifestDocuments = {
	"/.well-known/capability-manifest/index.json": string;
	"/.well-known/capability-manifest/capabilities.json": string;
	"/.well-known/capability-manifest/auth.json": string;
	"/.well-known/capability-manifest/cost.json": string;
};

// parallel-type-allowed: provider-owned pricing transcription (ADR-0129), not a protobuf message
interface CostFact {
	sku: string;
	unit: string;
	marginalPrice: string;
	included: number;
}

type CostFacts = {
	readonly [K in InitialCapabilityPort]: CostFact;
};

export const COST_FACTS: CostFacts = {
	"web/service": {
		sku: "kubernetes.deployment.pod-hour",
		unit: "pod-hour",
		marginalPrice: "0.0000",
		included: 0,
	},
};

export interface KubernetesManifestInput {
	providerId?: string;
	regions?: string[];
	ports?: InitialCapabilityPort[];
}

export function publishCapabilityManifest(
	input: KubernetesManifestInput = {},
): PublishedManifestDocuments {
	const providerId = input.providerId ?? KUBERNETES_PROVIDER_ID;
	const regions = input.regions ?? DEFAULT_REGIONS;
	const ports = input.ports ?? Object.keys(EQUIVALENCE_CLASSES);
	const declaredPorts = ports as InitialCapabilityPort[];
	const capabilitiesDocument = {
		schema: CAPABILITIES_SCHEMA,
		providerId,
		equivalenceClasses: declaredPorts.map((port) => {
			const mapping = EQUIVALENCE_CLASSES[port];
			return {
				class: port,
				...mapping,
				features: [...mapping.features],
			};
		}),
		capabilities: declaredPorts.map((port) => {
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
	const authDocument = {
		schema: AUTH_SCHEMA,
		providerId,
		mode: "svid-federation",
		tokenAudience: `spiffe://hobo/providers/${providerId.replace("@hobo/", "")}`,
		exchange: "kubernetes:BoundServiceAccountToken",
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
		facts: declaredPorts.map((port) => {
			const mapping = EQUIVALENCE_CLASSES[port];
			const fact = COST_FACTS[port];
			return {
				port: mapping.port,
				sku: fact.sku,
				unit: fact.unit,
				marginalPrice: fact.marginalPrice,
				pricingStatus: "unknown",
				freeTier: {
					unit: fact.unit,
					included: fact.included,
					reset: "monthly",
				},
				source: {
					type: "declared-provider",
					documentRef: digestRef(`cost:${providerId}:${fact.sku}`),
					transcribedOn: "2026-08-19",
				},
			};
		}),
	};
	const documents = [
		{
			path: "/.well-known/capability-manifest/capabilities.json",
			schema: CAPABILITIES_SCHEMA,
			digest: stableDigest(cloneAsJson(capabilitiesDocument)),
		},
		{
			path: "/.well-known/capability-manifest/auth.json",
			schema: AUTH_SCHEMA,
			digest: stableDigest(cloneAsJson(authDocument)),
		},
		{
			path: "/.well-known/capability-manifest/cost.json",
			schema: COST_SCHEMA,
			digest: stableDigest(cloneAsJson(costDocument)),
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
			cloneAsJson(indexDocument),
		),
		"/.well-known/capability-manifest/capabilities.json": canonicalJson(
			cloneAsJson(capabilitiesDocument),
		),
		"/.well-known/capability-manifest/auth.json": canonicalJson(
			cloneAsJson(authDocument),
		),
		"/.well-known/capability-manifest/cost.json": canonicalJson(
			cloneAsJson(costDocument),
		),
	};
}

export type { PublishedManifestParseResult } from "@hobo/core";
export { parsePublishedManifest } from "@hobo/core";
