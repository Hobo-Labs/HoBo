import type { JsonObject } from "./json.js";

// public-contract: the provider target id `.with(...)` option blocks carry.
export const DIGITALOCEAN_PROVIDER_TARGET = "digitalocean";

export type TypedOptionBlock = {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
};

export const digitalocean = {
	with: {
		appPlatform(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"appPlatform",
				{ instanceSizeSlug: "basic-xxs", instanceCount: 1 },
				options,
			);
		},
		droplet(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"droplet",
				{ size: "s-1vcpu-1gb", backups: false },
				options,
			);
		},
		managedPostgres(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"database",
				"managedPostgres",
				{ version: "16", size: "db-s-1vcpu-1gb", nodeCount: 1 },
				options,
			);
		},
		spaces(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"objectStore",
				"spaces",
				{ acl: "private", cdn: false },
				options,
			);
		},
		managedValkey(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"cache",
				"managedValkey",
				{ version: "8", size: "db-s-1vcpu-1gb", nodeCount: 1 },
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
		providerId: DIGITALOCEAN_PROVIDER_TARGET,
		port,
		optionName,
		negotiation: "prefer",
		options: { ...defaults, ...options },
	};
}
