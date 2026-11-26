import type { JsonObject } from "./json.js";

// public-contract: the provider target id `.with(...)` option blocks carry.
export const HOSTINGER_PROVIDER_TARGET = "hostinger";

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
export const hostinger = {
	with: {
		vps(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"vps",
				{ template: "ubuntu-24-04", backups: false },
				options,
			);
		},
		webHosting(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"webHosting",
				{ phpVersion: "8.3", ssl: true },
				options,
			);
		},
		mysql(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"database",
				"mysql",
				{ version: "8.0", remoteAccess: false },
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
		providerId: HOSTINGER_PROVIDER_TARGET,
		port,
		optionName,
		negotiation: "prefer",
		options: { ...defaults, ...options },
	};
}
