import { MESSAGING_PORT_CONTRACT_VERSION } from "@hobo/core";

// public-contract: capability-manifest bundle schema id (registry parity).
export const MANIFEST_SCHEMA = "hobo.capability-manifest/v1";
// public-contract: capabilities document schema id.
export const CAPABILITIES_SCHEMA = "hobo.capabilities/v1";
// public-contract: auth document schema id.
export const AUTH_SCHEMA = "hobo.provider-auth/v1";
// public-contract: cost document schema id.
export const COST_SCHEMA = "hobo.cost/v1";
// public-contract: the provider id every published document carries.
export const KAFKA_PROVIDER_ID = "@hobo/provider-kafka";

export interface PublishedManifestDocuments {
	"/.well-known/capability-manifest/index.json": string;
	"/.well-known/capability-manifest/capabilities.json": string;
	"/.well-known/capability-manifest/auth.json": string;
	"/.well-known/capability-manifest/cost.json": string;
}

export function publishCapabilityManifest(
	input: { providerId?: string; regions?: string[] } = {},
): PublishedManifestDocuments {
	const providerId = input.providerId ?? KAFKA_PROVIDER_ID;
	const regions = input.regions ?? ["local", "us-east-1", "eu-west-1"];
	return {
		"/.well-known/capability-manifest/index.json": JSON.stringify({
			schema: MANIFEST_SCHEMA,
			providerId,
			ports: [],
			witExports: [],
			nativeMessaging: {
				contract: MESSAGING_PORT_CONTRACT_VERSION,
				componentWit: false,
			},
			regions,
		}),
		"/.well-known/capability-manifest/capabilities.json": JSON.stringify({
			schema: CAPABILITIES_SCHEMA,
			providerId,
			capabilities: [],
		}),
		"/.well-known/capability-manifest/auth.json": JSON.stringify({
			schema: AUTH_SCHEMA,
			providerId,
			mode: "secretless-first",
			staticSecrets: false,
			exchange: "token-broker",
			tokenAudience: "kafka",
			bindings: ["fromBinding", "provider-federation", "secretRef"],
		}),
		"/.well-known/capability-manifest/cost.json": JSON.stringify({
			schema: COST_SCHEMA,
			providerId,
			facts: [
				{
					port: "topic",
					sku: "kafka.produce.gib",
					unit: "GiB",
					marginalPrice: "0.10",
					included: 0,
				},
				{
					port: "topic",
					sku: "kafka.partition.hour",
					unit: "partition-hour",
					marginalPrice: "0.01",
					included: 0,
				},
			],
		}),
	};
}
