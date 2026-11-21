import {
	AUTH_SCHEMA,
	CAPABILITIES_SCHEMA,
	COST_SCHEMA,
	canonicalJson,
	digestRef,
	MANIFEST_INDEX_SCHEMA,
	MANIFEST_SCHEMA,
	stableDigest,
} from "@hobo/core";

// public-contract: the hosting catalog pins the provider package identifier.
export const AGENT37_PROVIDER_ID = "@hobo/provider-agent37";
// public-contract: consumers select the provider through this capability name.
export const AGENT37_CAPABILITY = "ci/runner";
export const AGENT37_DEFAULT_REGIONS = Object.freeze(["us", "eu", "ap-south"]);
export const AGENT37_COST_SOURCE = Object.freeze({
	sourceUrl: "https://www.agent37.com/docs/agents-api/instance-sizing",
	transcribedOn: "2026-11-20",
});

const sizes = [
	{ cpu: 2, memoryGb: 4, monthlyUsd: 4.76 },
	{ cpu: 4, memoryGb: 8, monthlyUsd: 9.34 },
	{ cpu: 4, memoryGb: 16, monthlyUsd: 15.48 },
	{ cpu: 4, memoryGb: 32, monthlyUsd: 27.76 },
	{ cpu: 8, memoryGb: 64, monthlyUsd: 55.52 },
] as const;
const multipliers = { default: 1, vm: 2.5, performance: 4 } as const;

export const AGENT37_COST_FACTS = Object.freeze(
	(["default", "vm", "performance"] as const).flatMap((type) =>
		sizes
			.filter((size) => type !== "default" || size.cpu !== 8)
			.map((size) => ({
				port: AGENT37_CAPABILITY,
				pricingStatus: "estimate" as const,
				sku: `agent37.${type}.${size.cpu}vcpu-${size.memoryGb}gb.instance-minute`,
				unit: "instance-minute",
				marginalPrice: ((size.monthlyUsd * multipliers[type]) / 43800).toFixed(
					12,
				),
				type,
				cpu: size.cpu,
				memoryGb: size.memoryGb,
			})),
	),
);

export type Agent37PublishedManifestDocuments = {
	"/.well-known/capability-manifest/index.json": string;
	"/.well-known/capability-manifest/capabilities.json": string;
	"/.well-known/capability-manifest/auth.json": string;
	"/.well-known/capability-manifest/cost.json": string;
};

export type Agent37ManifestInput = {
	readonly providerId?: string;
	readonly regions?: readonly string[];
};

export function publishCapabilityManifest(
	input: Agent37ManifestInput = {},
): Agent37PublishedManifestDocuments {
	const providerId = input.providerId ?? AGENT37_PROVIDER_ID;
	const regions = input.regions ?? AGENT37_DEFAULT_REGIONS;
	const capabilities = {
		schema: CAPABILITIES_SCHEMA,
		providerId,
		capabilities: [
			{
				port: AGENT37_CAPABILITY,
				interface: "hobo:runner/job",
				version: "0.1.0",
				stability: "preview",
				features: ["ci-job", "workflow-dispatch", "ephemeral-runner"],
				regions: [...regions],
				resourceClass: AGENT37_CAPABILITY,
				providerService: "agent37",
			},
		],
	};
	const auth = {
		schema: AUTH_SCHEMA,
		providerId,
		mode: "static-api-key",
		staticSecrets: true,
		scopes: "workspace-full",
		rotation: "manual-dashboard",
		oidc: false,
		oauth: false,
		keyPage: "https://www.agent37.com/dashboard/cloud/api-keys",
	};
	const cost = {
		schema: COST_SCHEMA,
		providerId,
		currency: "USD",
		facts: AGENT37_COST_FACTS.map((fact) => ({
			...fact,
			source: {
				type: "declared-provider",
				documentRef: digestRef(`cost:${providerId}:${fact.sku}`),
				...AGENT37_COST_SOURCE,
			},
		})),
	};
	const documents = [
		{
			path: "/.well-known/capability-manifest/capabilities.json",
			schema: CAPABILITIES_SCHEMA,
			digest: stableDigest(capabilities),
		},
		{
			path: "/.well-known/capability-manifest/auth.json",
			schema: AUTH_SCHEMA,
			digest: stableDigest(auth),
		},
		{
			path: "/.well-known/capability-manifest/cost.json",
			schema: COST_SCHEMA,
			digest: stableDigest(cost),
		},
	];
	const index = {
		schema: MANIFEST_INDEX_SCHEMA,
		providerId,
		manifestSchema: MANIFEST_SCHEMA,
		documents,
	};
	return {
		"/.well-known/capability-manifest/index.json": canonicalJson(index),
		"/.well-known/capability-manifest/capabilities.json":
			canonicalJson(capabilities),
		"/.well-known/capability-manifest/auth.json": canonicalJson(auth),
		"/.well-known/capability-manifest/cost.json": canonicalJson(cost),
	};
}
