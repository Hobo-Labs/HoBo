import { CoreParseError } from "./errors.js";
import {
	type ExtensionPointId,
	parseExtensionPointId,
} from "./extension-registry.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import {
	assertNoExtra,
	deepFreeze,
	expectObject,
	nonEmptyString,
	requiredArray,
} from "./parse-utils.js";

// hobo.plugin/v1 (ADR-0156 §4, extension-points.md §Packaging): the `hobo`
// key an external plugin package declares in its package.json — the entry
// module plus the `{point, export}` extensions it provides. This module is
// the PURE half (parse-don't-validate); the effectful loader that imports
// the entry and checks exports lives at the composition root
// (`packages/hobo`), never in core. Wire form:
// data-models/extension_plugin.proto (+ CUE constraints).

// public-contract: plugin manifest schema id.
export const PLUGIN_MANIFEST_SCHEMA = "hobo.plugin/v1";

export class PluginManifestParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_PLUGIN_MANIFEST_PARSE", path, expected, received, message);
		this.name = "PluginManifestParseError";
	}
}

// domain-view: parse-dont-validate parsed/derived types below; the generated
// extension_plugin_pb wire records are the transport form.

/**
 * One extension a plugin provides: which point, via which named export.
 * `id` is the optional stable id the host registers the extension under
 * (e.g. the installable-catalog key for `hobo add`); when absent the host
 * derives it from the extension instance (a provider's `id`).
 */
// domain-view: branded ExtensionPointId refinement of extension_plugin.proto PluginExtensionDeclaration.
export interface PluginExtensionDeclaration {
	readonly point: ExtensionPointId;
	readonly export: string;
	readonly id?: string;
}

export interface HoboPluginManifest {
	readonly schema: typeof PLUGIN_MANIFEST_SCHEMA;
	/** Module specifier of the plugin entry, relative to the package root. */
	readonly entry: string;
	readonly extensions: ReadonlyArray<PluginExtensionDeclaration>;
}

const MANIFEST_KEYS = ["schema", "entry", "extensions"] as const;
const EXTENSION_KEYS = ["point", "export", "id"] as const;

/** Parse a `hobo.plugin/v1` manifest object (the `hobo` package.json key). */
export function parsePluginManifest(
	value: JsonValue | undefined,
): HoboPluginManifest {
	const source = expectObject(value, "hobo", PluginManifestParseError);
	assertNoExtra(source, "hobo", MANIFEST_KEYS, PluginManifestParseError);
	if (source.schema !== PLUGIN_MANIFEST_SCHEMA) {
		throw new PluginManifestParseError(
			"hobo.schema",
			PLUGIN_MANIFEST_SCHEMA,
			source.schema,
		);
	}
	const entry = nonEmptyString(
		source.entry,
		"hobo.entry",
		PluginManifestParseError,
	);
	if (!entry.startsWith("./")) {
		throw new PluginManifestParseError(
			"hobo.entry",
			"package-relative specifier starting with ./",
			entry,
		);
	}
	const rawExtensions = requiredArray(
		source.extensions,
		"hobo.extensions",
		PluginManifestParseError,
	);
	const seen = new Set<string>();
	const extensions = rawExtensions.map((raw, index) => {
		const field = `hobo.extensions[${index}]`;
		const record = expectObject(raw, field, PluginManifestParseError);
		assertNoExtra(record, field, EXTENSION_KEYS, PluginManifestParseError);
		const point = parseExtensionPointId(record.point);
		const exportName = nonEmptyString(
			record.export,
			`${field}.export`,
			PluginManifestParseError,
		);
		const key = `${point}#${exportName}`;
		if (seen.has(key)) {
			throw new PluginManifestParseError(
				field,
				"unique (point, export) pairs",
				key,
			);
		}
		seen.add(key);
		const id =
			record.id === undefined
				? undefined
				: nonEmptyString(record.id, `${field}.id`, PluginManifestParseError);
		return {
			point,
			export: exportName,
			...(id !== undefined ? { id } : undefined),
		};
	});

	return deepFreeze({ schema: PLUGIN_MANIFEST_SCHEMA, entry, extensions });
}

// domain-view: frozen parse-derived refinement of extension_plugin.proto PluginPackageManifest.
export interface PluginPackageManifest {
	readonly packageName: string;
	readonly plugin: HoboPluginManifest;
}

/**
 * Parse a plugin package's package.json: requires `name` plus a valid `hobo`
 * key. A package.json without a `hobo` key is not a plugin — that is a
 * distinct, detectable condition (`isPluginPackageJson`), not a parse error
 * with a confusing path.
 */
export function parsePluginPackageJson(
	value: JsonValue | undefined,
): PluginPackageManifest {
	const source = expectObject(value, "package.json", PluginManifestParseError);
	const packageName = nonEmptyString(
		source.name,
		"package.json name",
		PluginManifestParseError,
	);
	if (source.hobo === undefined) {
		throw new PluginManifestParseError(
			"package.json hobo",
			"hobo.plugin/v1 manifest object",
			undefined,
			`${packageName} has no "hobo" key — not a HoBo plugin package`,
		);
	}
	return deepFreeze({
		packageName,
		plugin: parsePluginManifest(source.hobo),
	});
}

/** True when the value looks like a package.json carrying a `hobo` key. */
export function isPluginPackageJson(value: JsonValue | undefined): boolean {
	return (
		isJsonObject(value) &&
		value !== null &&
		!Array.isArray(value) &&
		// SAFETY: assertion required at this I/O or test boundary.
		(value as JsonObject).hobo !== undefined
	);
}
