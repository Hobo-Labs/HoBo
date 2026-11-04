import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RegistrableProvider } from "@hobo/cloud";
import {
	CLOUD_PROVIDER_EXTENSION_POINT,
	type HoboPluginManifest,
	type PluginExtensionDeclaration,
	PluginManifestParseError,
	type PluginPackageManifest,
	parsePluginPackageJson,
} from "@hobo/core";
import { registerInstallable } from "./add-command.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// The effectful half of the hobo.plugin/v1 story (ADR-0156 §4,
// extension-points.md §Packaging). `@hobo/core` owns the PURE manifest
// parser; this module — the composition root — owns dynamic import and
// registration. Discovery is by EXPLICIT specifier only (config/CLI), never
// node_modules scanning, and a loaded provider goes through the same
// `registerInstallable` → `hobo add` → `provider.Registered`/
// `provider.Approved` lifecycle as a first-party installable: plugin loading
// never bypasses the approval gate that makes a provider matchable.

export class PluginLoadError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "PluginLoadError";
		this.code = code;
	}
}

export interface LoadedPluginExtension {
	readonly point: string;
	readonly export: string;
	/** The catalog id the extension registered under (providers). */
	readonly id?: string;
	readonly status: "registered" | "skipped";
	/** Why a `skipped` extension was skipped (unknown point, etc.). */
	readonly reason?: string;
}

export interface LoadedPluginReport {
	readonly packageName: string;
	readonly extensions: ReadonlyArray<LoadedPluginExtension>;
}

export interface PluginHostHooks {
	/** Installable-catalog registration seam (default: the real one). */
	registerInstallable?: (
		id: string,
		factory: () => RegistrableProvider,
		options?: { defaultHold?: boolean },
	) => void;
}

function asProviderFactory(value: object): () => RegistrableProvider {
	// SAFETY: the export was checked with instanceof Function at the plugin boundary.
	return value as () => RegistrableProvider;
}

function providerFactoryFrom(
	packageName: string,
	declaration: PluginExtensionDeclaration,
	moduleExports: JsonObject,
) {
	const candidate = moduleExports[declaration.export];
	if (!(candidate instanceof Function)) {
		throw new PluginLoadError(
			"HOBO_PLUGIN_EXPORT_MISSING",
			`${packageName}: declared export "${declaration.export}" for ${declaration.point} is not a function export of the plugin entry`,
		);
	}
	const factory = asProviderFactory(candidate);
	// Probe once, fail closed on shape: a provider factory must yield an
	// id-bearing, capability-bearing, manifest-bearing provider.
	const probe = factory();
	if (
		!probe ||
		!isJsonObject(probe) ||
		!isJsonString(probe.id) ||
		probe.id.length === 0 ||
		!Array.isArray(probe.capabilities) ||
		!(probe.capabilityManifest instanceof Function)
	) {
		throw new PluginLoadError(
			"HOBO_PLUGIN_PROVIDER_SHAPE",
			`${packageName}: export "${declaration.export}" did not produce a CloudProvider (need id, capabilities[], capabilityManifest())`,
		);
	}
	return { id: declaration.id ?? probe.id, factory };
}

/**
 * Register a parsed plugin's extensions with the host. Pure in/out apart
 * from the injected registration seam — the import already happened.
 * Unknown extension points are reported `skipped`, never fatal: a newer
 * plugin may declare points this host does not implement yet.
 */
export function registerPluginExtensions(
	manifest: PluginPackageManifest,
	moduleExports: JsonObject,
	hooks: PluginHostHooks = {},
): LoadedPluginReport {
	const register = hooks.registerInstallable ?? registerInstallable;
	const extensions = manifest.plugin.extensions.map(
		(declaration): LoadedPluginExtension => {
			if (declaration.point === CLOUD_PROVIDER_EXTENSION_POINT) {
				const { id, factory } = providerFactoryFrom(
					manifest.packageName,
					declaration,
					moduleExports,
				);
				register(id, factory);
				return {
					point: declaration.point,
					export: declaration.export,
					id,
					status: "registered",
				};
			}
			return {
				point: declaration.point,
				export: declaration.export,
				...(declaration.id !== undefined ? { id: declaration.id } : undefined),
				status: "skipped",
				reason: `extension point ${declaration.point} has no host registration seam in this composition root`,
			};
		},
	);
	return { packageName: manifest.packageName, extensions };
}

export interface PluginModuleNamespace {
	readonly [exportName: string]:
		| JsonValue
		| ((...args: never[]) => RegistrableProvider);
}

export interface LoadPluginOptions extends PluginHostHooks {
	/** Injection seam for tests: import a module URL/specifier. */
	importModule?: (specifier: string) => Promise<PluginModuleNamespace>;
}

function resolvePluginPackage(specifier: string) {
	const require = createRequire(path.join(process.cwd(), "noop.js"));
	let packageJsonPath: string;
	if (
		specifier.startsWith(".") ||
		specifier.startsWith("/") ||
		specifier.startsWith("file:")
	) {
		const dir = specifier.startsWith("file:")
			? new URL(specifier).pathname
			: path.resolve(specifier);
		packageJsonPath = path.join(dir, "package.json");
	} else {
		// `<pkg>/package.json` resolution can be blocked by an exports map;
		// fall back to resolving the package entry and walking up.
		try {
			packageJsonPath = require.resolve(`${specifier}/package.json`);
		} catch {
			const entry = require.resolve(specifier);
			let dir = path.dirname(entry);
			for (;;) {
				const candidate = path.join(dir, "package.json");
				try {
					// SAFETY: assertion required at this I/O or test boundary.
					const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
						name?: string;
					};
					if (parsed.name === specifier) {
						packageJsonPath = candidate;
						break;
					}
				} catch {
					// keep walking
				}
				const parent = path.dirname(dir);
				if (parent === dir) {
					throw new PluginLoadError(
						"HOBO_PLUGIN_PACKAGE_JSON",
						`cannot locate package.json for plugin specifier "${specifier}"`,
					);
				}
				dir = parent;
			}
		}
	}
	try {
		return {
			packageDir: path.dirname(packageJsonPath),
			packageJson: JSON.parse(readFileSync(packageJsonPath, "utf8")),
		};
	} catch (error) {
		throw new PluginLoadError(
			"HOBO_PLUGIN_PACKAGE_JSON",
			`cannot read package.json for plugin specifier "${specifier}": ${String(error)}`,
		);
	}
}

/**
 * Load a plugin package by explicit specifier: resolve its package.json,
 * parse the `hobo` manifest (`hobo.plugin/v1`), import the declared entry,
 * verify the declared exports, and register the extensions. Returns the
 * per-extension report; throws `PluginLoadError` /
 * `PluginManifestParseError` fail-closed on anything malformed.
 */
export async function loadHoboPlugin(
	specifier: string,
	options: LoadPluginOptions = {},
): Promise<LoadedPluginReport> {
	const { packageDir, packageJson } = resolvePluginPackage(specifier);
	const manifest = parsePluginPackageJson(packageJson);
	const entryPath = path.join(packageDir, manifest.plugin.entry);
	const importModule =
		options.importModule ??
		(async (url: string): Promise<PluginModuleNamespace> => {
			const imported = await import(url);
			if (imported === null || imported === undefined) {
				throw new PluginLoadError(
					"HOBO_PLUGIN_ENTRY_SHAPE",
					`${manifest.packageName}: plugin entry did not evaluate to a module object`,
				);
			}
			// SAFETY: dynamic import yields a module namespace of plugin exports.
			return imported as PluginModuleNamespace;
		});
	let moduleExports: PluginModuleNamespace;
	try {
		moduleExports = await importModule(pathToFileURL(entryPath).href);
	} catch (error) {
		if (error instanceof PluginLoadError) throw error;
		throw new PluginLoadError(
			"HOBO_PLUGIN_ENTRY_IMPORT",
			`${manifest.packageName}: cannot import plugin entry ${manifest.plugin.entry}: ${String(error)}`,
		);
	}
	if (moduleExports === null || moduleExports === undefined) {
		throw new PluginLoadError(
			"HOBO_PLUGIN_ENTRY_SHAPE",
			`${manifest.packageName}: plugin entry did not evaluate to a module object`,
		);
	}
	const exported: JsonObject = {};
	Object.assign(exported, moduleExports);
	return registerPluginExtensions(manifest, exported, options);
}

export type { HoboPluginManifest, PluginPackageManifest };
export { PluginManifestParseError };
