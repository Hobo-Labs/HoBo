import type { JsonObject } from "./json.js";

// public-contract: provider target accepted by authoring options.
export const PROVIDER_TARGET = "railway";

export interface TypedOptionBlock {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
}

export const railway = {
	with: {
		service(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"service",
				{ runtime: "container" },
				options,
			);
		},
		redis(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock("kv", "redis", {}, options);
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
		providerId: PROVIDER_TARGET,
		port,
		optionName,
		negotiation: "prefer",
		options: { ...defaults, ...options },
	};
}
