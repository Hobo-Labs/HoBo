import type { JsonObject } from "./json.js";
import { type GuestPlacement, parseGuestPlacement } from "./placement.js";

// public-contract: provider target accepted by authoring options.
export const PROVIDER_TARGET = "browser-wasm";

export interface TypedOptionBlock {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
}

export const browserWasm = {
	with: {
		guest(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock("compute", "guest", { runtime: "wit" }, options);
		},
		/**
		 * A guest bound for a real browser runtime. Unlike `guest`, the option
		 * bag crosses `parseGuestPlacement` here, so the block either holds a
		 * placement a document could actually host or it does not exist.
		 */
		placement(options: JsonObject): TypedOptionBlock & {
			readonly placement: GuestPlacement;
		} {
			const placement = parseGuestPlacement(options);
			return {
				...optionBlock(placement.port, "placement", {}, options),
				negotiation: "require",
				placement,
			};
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
