import type { JsonObject } from "./json.js";

export const LAKEBED_PROVIDER_TARGET = "lakebed";

export type TypedOptionBlock = {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
};

export const lakebed = {
	with: {
		capsule(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"capsule",
				{ syncRpc: true, coldStart: "instant" },
				options,
			);
		},
		reactiveDb(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"database",
				"reactiveDb",
				{ consistency: "reactive", schema: "document" },
				options,
			);
		},
		files(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"objectStore",
				"files",
				{ publicAccess: false },
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
		providerId: LAKEBED_PROVIDER_TARGET,
		port,
		optionName,
		negotiation: "prefer",
		options: { ...defaults, ...options },
	};
}
