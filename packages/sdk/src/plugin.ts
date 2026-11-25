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


export interface DefinePluginSpec {
	package: string;
	entry: string;
	extensions: Array<{ point: string; export: string; id?: string }>;
}

export interface SdkPluginDeclaration {
	readonly schema: typeof PLUGIN_DECLARATION_SCHEMA;
	readonly packageName: string;
	readonly manifest: HoboPluginManifest;
	readonly packageJsonFragment: { readonly hobo: HoboPluginManifest };
}

export function definePlugin(spec: DefinePluginSpec): SdkPluginDeclaration {
	const record = requireRecord("definePlugin", "spec", spec);
	const packageName = requireNonEmptyString(
		"definePlugin",
		"package",
		record.package,
	);
	let manifest: HoboPluginManifest;
	try {
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
