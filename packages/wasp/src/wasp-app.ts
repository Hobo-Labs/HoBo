import type { ProviderAnnotation } from "@hobo/bindles";
import { COMPONENT_METADATA } from "@hobo/runtime";
import {
	parseWaspRelativeRoot,
	parseWaspWebAppAnnotation,
	parseWaspWebAppMeta,
	WaspInputRejectedError,
} from "./parse.js";

export const WASP_WEBAPP_METADATA = Symbol.for("hobo.webapp.wasp");
export const WEBAPP_META = Symbol.for("hobo.webapp.meta");
export const WEBAPP_OPTION = "webapp" as const;

export type WaspWebAppMeta = {
	readonly framework: "wasp";
	readonly root: string;
};

const METADATA_SYMBOL =
	(Symbol as { metadata?: symbol }).metadata ?? Symbol.for("Symbol.metadata");

export function waspApp(root: string): new () => object {
	const trimmed = parseWaspRelativeRoot(root);

	const meta: WaspWebAppMeta = Object.freeze({
		framework: "wasp",
		root: trimmed,
	});

	class WaspApp {}
	Object.defineProperty(WaspApp, WASP_WEBAPP_METADATA, {
		value: meta,
		enumerable: false,
	});
	Object.defineProperty(WaspApp, WEBAPP_META, {
		value: meta,
		enumerable: false,
	});
	Object.defineProperty(WaspApp, METADATA_SYMBOL, {
		value: {
			[COMPONENT_METADATA]: {
				intent: `wasp:${trimmed}`,
				name: "WaspApp",
				operations: [],
			},
		},
		configurable: true,
	});
	return WaspApp;
}

export function waspMetaOf(binding: unknown): WaspWebAppMeta | undefined {
	if (typeof binding !== "function") return undefined;
	return parseWaspWebAppMeta(
		(binding as unknown as Record<symbol, unknown>)[WASP_WEBAPP_METADATA],
	);
}

export function waspAnnotation(meta: WaspWebAppMeta): ProviderAnnotation {
	return Object.freeze({
		provider: "hobo",
		option: WEBAPP_OPTION,
		config: Object.freeze({
			framework: meta.framework,
			root: meta.root,
		}),
	});
}

export function isWaspWebAppAnnotation(
	annotation: ProviderAnnotation,
): boolean {
	try {
		return parseWaspWebAppAnnotation(annotation) !== undefined;
	} catch (error) {
		if (error instanceof WaspInputRejectedError) throw error;
		return false;
	}
}

export function waspRootFromAnnotations(
	annotations: readonly ProviderAnnotation[],
): string {
	for (const annotation of annotations) {
		const parsed = parseWaspWebAppAnnotation(annotation);
		if (parsed !== undefined) return parsed.root;
	}
	throw new Error("Bindle web Kit missing waspApp(root) annotation");
}
