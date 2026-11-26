import type { JsonObject } from "./json.js";

// public-contract: the provider target id `.with(...)` option blocks carry.
export const LAKEBED_PROVIDER_TARGET = "lakebed";

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
// targets many clouds unedited, including the competitor's.
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
