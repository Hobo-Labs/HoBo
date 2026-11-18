import { MESSAGING_WIT_INTERFACE, providerTermsFor } from "@hobo/core";

export const MANIFEST_SCHEMA = "hobo.capability-manifest/v1";
export const CAPABILITIES_SCHEMA = "hobo.capabilities/v1";
export const AUTH_SCHEMA = "hobo.provider-auth/v1";
export const COST_SCHEMA = "hobo.cost/v1";
export const KAFKA_PROVIDER_ID = "@hobo/provider-kafka";
export const PROVIDER_TERMS = providerTermsFor(KAFKA_PROVIDER_ID);

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
			terms: PROVIDER_TERMS,
			ports: ["topic", "queue"],
			witExports: [MESSAGING_WIT_INTERFACE, "hobo:queue/queue@0.1.0"],
			regions,
		}),
		"/.well-known/capability-manifest/capabilities.json": JSON.stringify({
			schema: CAPABILITIES_SCHEMA,
			providerId,
			capabilities: [
				{
					port: "topic",
					wit: MESSAGING_WIT_INTERFACE,
					features: [
						"consumer-groups",
						"at-least-once",
						"exactly-once",
						"transactional-produce",
						"idempotent-produce",
						"schema-registry",
						"dead-letter",
						"partition-aware",
						"cross-yard-federation",
					],
				},
				{
					port: "queue",
					wit: "hobo:queue/queue@0.1.0",
					features: ["enqueue", "dequeue", "complete"],
					notes:
						"aligned semantics where pull-queue maps to consumer-group poll",
				},
			],
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
