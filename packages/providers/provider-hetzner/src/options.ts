import type { JsonObject } from "./json.js";

export const HETZNER_PROVIDER_TARGET = "hetzner";

export type TypedOptionBlock = {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
};

export const hetzner = {
	with: {
		cloudServer(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"cloudServer",
				{ serverType: "cx22", backups: false },
				options,
			);
		},
		loadBalancer(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"loadBalancer",
				{ loadBalancerType: "lb11", algorithm: "round_robin" },
				options,
			);
		},
		objectStorage(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"objectStore",
				"objectStorage",
				{ acl: "private", versioning: false },
				options,
			);
		},
		volume(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"volume",
				{ sizeGb: 10, format: "ext4" },
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
		providerId: HETZNER_PROVIDER_TARGET,
		port,
		optionName,
		negotiation: "prefer",
		options: { ...defaults, ...options },
	};
}
