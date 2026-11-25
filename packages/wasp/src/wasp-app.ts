/**
 * Minimal Wasp webApp marker for `b.web(waspApp(root))`.
 * Open SaaS: https://github.com/wasp-lang/open-saas · https://docs.opensaas.sh/
 */
import type { ProviderAnnotation } from "@hobo/bindles";
import { COMPONENT_METADATA } from "@hobo/runtime";
import {
	parseWaspRelativeRoot,
	parseWaspWebAppAnnotation,
	parseWaspWebAppMeta,
	WaspInputRejectedError,
} from "./parse.js";

export const WASP_WEBAPP_METADATA = Symbol.for("hobo.webapp.wasp");
/** Shared meta symbol — Bindle detects any `{ framework, root }` webApp. */
export const WEBAPP_META = Symbol.for("hobo.webapp.meta");
// public-contract: Bindle provider annotations use this stable option name.
export const WEBAPP_OPTION = "webapp" as const;

export type WaspWebAppMeta = {
	readonly framework: "wasp";
	readonly root: string;
};

const METADATA_SYMBOL =
	(Symbol as { metadata?: symbol }).metadata ?? Symbol.for("Symbol.metadata");

/** DeclaredComponent for Bindle — only stamps `root` (repo-relative Wasp app dir). */
export function waspApp(root: string): new () => object {
	// The marker is stamped once and read back much later, so the path is
	// parsed here rather than wherever it is eventually resolved.
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
		// A malformed Wasp annotation is a rejection, not a "no". Anything else
		// is not this package's annotation and answers false.
		if (error instanceof WaspInputRejectedError) throw error;
		return false;
	}
}

/**
 * The root a Bindle definition says its web Kit is. Untrusted on the way in —
 * the definition is assembled by the author's own code — and a repo-relative
 * path with no traversal on the way out.
 */
export function waspRootFromAnnotations(
	annotations: readonly ProviderAnnotation[],
): string {
	for (const annotation of annotations) {
		const parsed = parseWaspWebAppAnnotation(annotation);
		if (parsed !== undefined) return parsed.root;
	}
	throw new Error("Bindle web Kit missing waspApp(root) annotation");
}
