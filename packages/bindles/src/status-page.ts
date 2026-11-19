import { isJsonString, type JsonObject } from "./json.js";
import type { ProviderAnnotation } from "./types.js";

// public-contract: platform annotation option for status-page configuration.
export const STATUS_PAGE_OPTION = "status-page" as const;

export type StatusPageBindleConfig = Readonly<{
	enabled?: boolean;
	project?: string;
	label?: string;
}>;

export function statusPage(
	config: StatusPageBindleConfig = {},
): ProviderAnnotation {
	if (config.project !== undefined) {
		if (!isJsonString(config.project) || config.project.length === 0) {
			throw new TypeError("statusPage project must be a non-empty string");
		}
	}
	if (config.label !== undefined) {
		if (!isJsonString(config.label) || config.label.length === 0) {
			throw new TypeError("statusPage label must be a non-empty string");
		}
	}
	return Object.freeze({
		provider: "hobo",
		option: STATUS_PAGE_OPTION,
		config: Object.freeze({
			enabled: config.enabled !== false,
			...(config.project !== undefined
				? { project: config.project }
				: undefined),
			...(config.label !== undefined ? { label: config.label } : undefined),
		}),
	});
}

export function isStatusPageAnnotation(
	annotation: ProviderAnnotation,
): boolean {
	return annotation.option === STATUS_PAGE_OPTION;
}

export function readStatusPageConfig(
	annotations: readonly ProviderAnnotation[],
): StatusPageBindleConfig | null {
	for (const annotation of annotations) {
		if (!isStatusPageAnnotation(annotation)) continue;
		const config = annotation.config as JsonObject;
		return Object.freeze({
			enabled: config.enabled !== false,
			...(isJsonString(config.project) && config.project.length > 0
				? { project: config.project }
				: undefined),
			...(isJsonString(config.label) && config.label.length > 0
				? { label: config.label }
				: undefined),
		});
	}
	return null;
}
