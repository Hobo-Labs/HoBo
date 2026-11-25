import type { JsonObject } from "./json.js";

// public-contract: the provider target id `.with(...)` option blocks carry.
export const AZURE_PROVIDER_TARGET = "azure";

export type TypedOptionBlock = {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
};

export const azure = {
	with: {
		containerApps(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"containerApps",
				{ cpu: 0.25, memoryGiB: 0.5, minReplicas: 0, maxReplicas: 10 },
				options,
			);
		},
		postgres(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"database",
				"postgres",
				{ version: "16", sku: "Standard_B1ms", haMode: "Disabled" },
				options,
			);
		},
		blob(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"objectStore",
				"blob",
				{ accessTier: "Hot", versioning: true, publicAccess: false },
				options,
			);
		},
		cosmos(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"kv",
				"cosmos",
				{ capacityMode: "serverless", consistency: "Session" },
				options,
			);
		},
		serviceBus(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"queue",
				"serviceBus",
				{ tier: "Standard", partitioning: false, sessions: false },
				options,
			);
		},
		redis(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"cache",
				"redis",
				{ sku: "Basic_C0", tlsOnly: true },
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
		providerId: AZURE_PROVIDER_TARGET,
		port,
		optionName,
		negotiation: "prefer",
		options: { ...defaults, ...options },
	};
}
