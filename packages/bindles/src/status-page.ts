/**
 * Bindle-side status-page annotation helpers (ADR-0077 / ADR-0145).
 * Page derivation and rendering live in `@hobo/status-page`; this module only
 * declares intent, exactly like Session Replay (ADR-0137).
 *
 * The trait is **read-side default-on**: every Bindle gets a status page even
 * without an annotation (`deriveBindleStatusPlan` in `@hobo/status-page`), so
 * attaching nothing here keeps canonical manifests and plan hashes stable.
 * Use `.with(statusPage({ enabled: false }))` to exclude a resource's
 * component, `statusPage({ project: "…" })` to group the page under a project.
 */
import { isJsonString, type JsonObject } from "./json.js";
import type { ProviderAnnotation } from "./types.js";

// public-contract: platform annotation option for status-page configuration.
export const STATUS_PAGE_OPTION = "status-page" as const;

export type StatusPageBindleConfig = Readonly<{
	/** Default true. Set false to exclude this resource's component. */
	enabled?: boolean;
	/** Project grouping dimension (ADR-0077 §1). Never a provider id. */
	project?: string;
	/** Public label for the page; defaults to the Bindle name. */
	label?: string;
}>;

/** Explicit status-page annotation for `.with(statusPage(...))`. */
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

/** Parse the first status-page annotation's config, if any. */
export function readStatusPageConfig(
	annotations: readonly ProviderAnnotation[],
): StatusPageBindleConfig | null {
	for (const annotation of annotations) {
		if (!isStatusPageAnnotation(annotation)) continue;
		// SAFETY: assertion required at this I/O or test boundary.
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
