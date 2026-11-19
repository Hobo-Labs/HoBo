import type { JsonObject } from "./json.js";
import { parseWorkloadPlacement, type WorkloadPlacement } from "./placement.js";

// public-contract: provider target accepted by authoring options.
export const PROVIDER_TARGET = "kubernetes";

export type TypedOptionBlock = {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
};

export const kubernetes = {
	with: {
		deployment(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"deployment",
				{ simulation: true },
				options,
			);
		},
		workload(options: JsonObject): TypedOptionBlock & {
			readonly placement: WorkloadPlacement;
		} {
			const placement = parseWorkloadPlacement(options);
			return {
				...optionBlock("compute", "workload", {}, options),
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
