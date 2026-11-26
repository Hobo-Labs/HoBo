import type { JsonObject } from "./json.js";

// public-contract: the provider target id `.with(...)` option blocks carry.
export const GCP_PROVIDER_TARGET = "gcp";

// A `type` alias (not an interface) so it keeps an implicit index signature
// and stays assignable to @hobo/core's opaque `TypedOptionBlock`
// (Record<string, unknown>) on ResourcePlan.options (ADR-0156).
export type TypedOptionBlock = {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
};

// The provider-specific options pattern (sdk-api.md "the core promise"): typed,
// additive annotations that are inert for non-resolved providers — one Bindle
// targets many clouds unedited.
export const gcp = {
	with: {
		cloudRun(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"cloudRun",
				{ cpu: 1, memoryMiB: 512, minInstances: 0, maxInstances: 10 },
				options,
			);
		},
		cloudSql(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"database",
				"cloudSql",
				{ version: "POSTGRES_16", tier: "db-f1-micro", ha: false },
				options,
			);
		},
		gcs(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"objectStore",
				"gcs",
				{ storageClass: "STANDARD", versioning: true, publicAccess: false },
				options,
			);
		},
		firestore(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"kv",
				"firestore",
				{ mode: "NATIVE", ttlField: null },
				options,
			);
		},
		pubsub(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"queue",
				"pubsub",
				{ ordering: false, ackDeadlineSeconds: 10 },
				options,
			);
		},
		memorystore(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"cache",
				"memorystore",
				{ tier: "BASIC", memoryGb: 1 },
				options,
			);
		},
	},
};

function optionBlock(
	port: string,
	optionName: string,
	defaults: JsonObject,
	options: JsonObject,
): TypedOptionBlock {
	return {
		providerId: GCP_PROVIDER_TARGET,
		port,
		optionName,
		negotiation: "prefer",
		options: { ...defaults, ...options },
	};
}
