import type { JsonObject } from "./json.js";

export const HOSTINGER_PROVIDER_TARGET = "hostinger";

export type TypedOptionBlock = {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
};

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
