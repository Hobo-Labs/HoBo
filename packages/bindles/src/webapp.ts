/**
 * Structural webApp detection for Bindle Kit bindings.
 * Framework packages stamp `Symbol.for("hobo.webapp.meta")` with `{ framework, root }`
 * (Wasp also stamps `hobo.webapp.wasp`; Convex stamps `hobo.webapp.convex`).
 */
import { isJsonObject, isJsonString, type JsonValue } from "./json.js";
import type { ComponentBinding, ProviderAnnotation } from "./types.js";

// public-contract: identifies framework-neutral web application annotations.
export const WEBAPP_OPTION = "webapp" as const;
export const WEBAPP_META = Symbol.for("hobo.webapp.meta");
export const WASP_WEBAPP_METADATA = Symbol.for("hobo.webapp.wasp");
export const CONVEX_WEBAPP_METADATA = Symbol.for("hobo.webapp.convex");

type WebAppMeta = { framework?: JsonValue; root?: JsonValue };

type BindingSymbolBag = ComponentBinding & {
	readonly [key: symbol]: WebAppMeta | undefined;
};

function isBindingSymbolBag(
	value: ComponentBinding,
): value is BindingSymbolBag {
	return value instanceof Function;
}

function readMeta(
	binding: ComponentBinding,
	symbol: symbol,
): WebAppMeta | undefined {
	if (!isBindingSymbolBag(binding)) return undefined;
	const meta = binding[symbol];
	return meta && isJsonObject(meta) ? meta : undefined;
}

export function webAppAnnotationFromBinding(
	binding: ComponentBinding | undefined,
): ProviderAnnotation | undefined {
	if (!(binding instanceof Function)) return undefined;
	const meta =
		readMeta(binding, WEBAPP_META) ??
		readMeta(binding, WASP_WEBAPP_METADATA) ??
		readMeta(binding, CONVEX_WEBAPP_METADATA);
	if (!meta) return undefined;
	if (!isJsonString(meta.framework) || meta.framework.length === 0) {
		return undefined;
	}
	if (!isJsonString(meta.root) || meta.root.length === 0) return undefined;
	return Object.freeze({
		provider: "hobo",
		option: WEBAPP_OPTION,
		config: Object.freeze({ framework: meta.framework, root: meta.root }),
	});
}

export function isWebAppAnnotation(annotation: ProviderAnnotation): boolean {
	return annotation.provider === "hobo" && annotation.option === WEBAPP_OPTION;
}
