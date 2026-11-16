import type { JsonObject } from "./json.js";

// public-contract: provider target accepted by authoring options.
export const PROVIDER_TARGET = "vercel";

export interface TypedOptionBlock {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
}

export const vercel = {
	with: {
		web(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock("compute", "web", { framework: "nextjs" }, options);
		},
		blob(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock("objectStore", "blob", { store: "assets" }, options);
		},
		neonPostgres(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"database",
				"neonPostgres",
				{ engine: "postgres" },
				options,
			);
		},
		edgeConfig(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock("kv", "edgeConfig", { store: "edge-config" }, options);
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
