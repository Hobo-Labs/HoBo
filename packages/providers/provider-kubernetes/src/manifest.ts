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

// The schema ids are platform contract, so they live in @hobo/core and are
// re-exported here to keep this package's public surface unchanged.
export {
	AUTH_SCHEMA,
	CAPABILITIES_SCHEMA,
	COST_SCHEMA,
	MANIFEST_SCHEMA,
} from "@hobo/core";

// public-contract: the provider id every published document carries.
export const KUBERNETES_PROVIDER_ID = "@hobo/provider-kubernetes";

// A cluster has no region list of its own: where its nodes run is a fact about
// the infrastructure underneath it, which this provider cannot see and will not
// guess. The published default is therefore the one honest value — the cluster
// itself — and an operator who knows the topology passes real zone labels in.
export const DEFAULT_REGIONS = ["in-cluster"];

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
// ranking has honest inputs. Kubernetes is the one provider in this repo whose
// declared price is a *structural* zero rather than a transcribed one, and it
// says so rather than inventing a number: the Kubernetes API charges nothing
// for a Deployment. The nodes it schedules onto are billed by whoever owns the
// cluster — EKS, GKE, a DOKS pool, or a rack — and that bill belongs to the
// provider underneath, which HoBo already prices through that provider's own
// facts. A nonzero figure here would double-count it, and `included: 0` keeps
// the fact from reading as a free tier.
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
	// SAFETY: equivalence-class keys are the InitialCapabilityPort set.
	const declaredPorts = ports as InitialCapabilityPort[];
	const capabilitiesDocument = {
		schema: CAPABILITIES_SCHEMA,
		providerId,
		equivalenceClasses: declaredPorts.map((port) => {
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
	// Kubernetes is the one provider here with real first-class workload
	// identity: a ServiceAccount token is a projected, audience-scoped,
	// short-lived OIDC token, which is exactly the posture published below
	// rather than an approximation of it. The Yard broker still holds custody
	// and hands the resolver a *locator* (`scheme://path`); `staticSecrets:
	// false` is a parse-enforced claim about this package, which stores no
	// material anywhere.
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
