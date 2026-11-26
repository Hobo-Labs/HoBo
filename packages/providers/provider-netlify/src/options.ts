import type { JsonObject } from "./json.js";

// public-contract: provider target accepted by authoring options.
export const PROVIDER_TARGET = "netlify";

export interface TypedOptionBlock {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
}

export const netlify = {
	with: {
		site(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock("compute", "site", { framework: "static" }, options);
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
