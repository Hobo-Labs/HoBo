import {
	type HoboPluginManifest,
	type JsonValue,
	PLUGIN_MANIFEST_SCHEMA,
	parsePluginManifest,
} from "@hobo/core";
import {
	deepFreeze,
	requireNonEmptyString,
	requireRecord,
	SdkDeclarationError,
} from "./errors.js";
import { PLUGIN_DECLARATION_SCHEMA } from "./schema.js";

// `definePlugin` is the authoring factory for hobo.plugin/v1 packages
// (ADR-0156 §4, extension-points.md §Packaging). The manifest TYPES and the
// pure parser live in @hobo/core; this factory is the operator-SDK
// ergonomics: declare once in code, emit the exact package.json `hobo`
// fragment, and self-check the plugin entry's exports in the plugin's own
// tests via `assertPluginExports`. It invents no second manifest shape —
// the declaration wraps the parsed core manifest.

export interface DefinePluginSpec {
	/** The plugin package name (`@acme/hobo-provider-acme`). */
	package: string;
	/** Package-relative entry module specifier (`./dist/plugin.js`). */
	entry: string;
	extensions: Array<{ point: string; export: string; id?: string }>;
}

export interface SdkPluginDeclaration {
	readonly schema: typeof PLUGIN_DECLARATION_SCHEMA;
	readonly packageName: string;
	readonly manifest: HoboPluginManifest;
	/** The exact fragment to merge into the plugin's package.json. */
	readonly packageJsonFragment: { readonly hobo: HoboPluginManifest };
}

export function definePlugin(spec: DefinePluginSpec): SdkPluginDeclaration {
	const record = requireRecord("definePlugin", "spec", spec);
	const packageName = requireNonEmptyString(
		"definePlugin",
		"package",
		record.package,
	);
	// Parse-don't-validate through the core parser so the declaration can
	// never drift from what the loader accepts.
	let manifest: HoboPluginManifest;
	try {
		// SAFETY: unchecked spec fields handed to the parser that checks them.
		// `parsePluginManifest` is the authority on what a manifest may contain,
		// and the catch below turns its refusal into this declaration's own typed
		// error. Narrowing here first would restate the loader's rules in the SDK,
		// which is the drift this call exists to prevent.
		manifest = parsePluginManifest({
			schema: PLUGIN_MANIFEST_SCHEMA,
			entry: record.entry,
			extensions: record.extensions,
		} as JsonValue);
	} catch (error) {
		throw new SdkDeclarationError(
			"definePlugin",
			"manifest",
			error instanceof Error ? error.message : String(error),
		);
	}
	return deepFreeze({
		schema: PLUGIN_DECLARATION_SCHEMA,
		packageName,
		manifest,
		packageJsonFragment: { hobo: manifest },
	});
}

/**
 * Self-check that a plugin entry module exports every declared extension
 * factory. Run this in the plugin package's own tests so a renamed export
 * fails at the author's desk, not at the operator's load time.
 */
export function assertPluginExports(
	declaration: SdkPluginDeclaration,
	moduleExports: Record<string, unknown>,
): void {
	for (const extension of declaration.manifest.extensions) {
		if (typeof moduleExports[extension.export] !== "function") {
			throw new SdkDeclarationError(
				"definePlugin",
				`extensions.${extension.export}`,
				`plugin entry does not export function "${extension.export}" declared for ${extension.point}`,
			);
		}
	}
}
