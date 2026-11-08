import type { PatternManifest } from "./_generated/patterns_pb.js";
import { isJsonArray, isJsonObject, isJsonString } from "./json.js";
import { PatternParseError, parsePatternManifest } from "./parse.js";

const KIND_FEATURE = new Map([
	["architecture", "artifact:starter"],
	["bindle", "artifact:bindle"],
	["camp", "artifact:yard"],
	["connector", "constraint:no-local-secret"],
	["http", "authoring-resource:api"],
	["junction", "artifact:yard"],
	["openfeature", "artifact:starter"],
	["package", "artifact:starter"],
	["station", "artifact:yard"],
	["storage", "property:durable"],
	["trail", "artifact:starter"],
	["yard", "artifact:yard"],
]);

const TAG_FEATURE = new Map([
	["api", "authoring-resource:api"],
	["web", "authoring-resource:web"],
	["bindle", "artifact:bindle"],
	["yard", "artifact:yard"],
	["azure", "artifact:yard"],
	["sqlite", "property:durable"],
	["hono", "authoring-resource:api"],
]);

/** A template parameter as the pattern manifest parser expects it. */
type AtomParameter = {
	readonly name: string;
	readonly kind: string;
	readonly required: boolean;
	readonly default: string;
	readonly displayInReceipt: boolean;
};

function asStringList<T>(value: T): string[] {
	if (!isJsonArray(value)) return [];
	return value.filter((item): item is string => isJsonString(item));
}

function featuresFor(
	kind: string,
	tags: readonly string[],
): { id: string; weight: number }[] {
	const ids = new Set<string>();
	ids.add(KIND_FEATURE.get(kind) ?? "artifact:starter");
	for (const tag of tags) {
		const mapped = TAG_FEATURE.get(tag.toLowerCase());
		if (mapped) ids.add(mapped);
	}
	return [...ids].map((id) => ({ id, weight: 1 }));
}

function parameters<T>(raw: T): AtomParameter[] {
	if (!isJsonObject(raw)) return [];
	const required = new Set(asStringList(raw.required));
	const properties = raw.properties;
	if (!isJsonObject(properties)) return [];
	return Object.entries(properties).map(([name, spec]) => {
		const fallback = isJsonObject(spec) ? spec.default : undefined;
		return {
			name,
			kind: name === "name" ? "resource_name" : "typescript_string",
			required: required.has(name),
			default: isJsonString(fallback) ? fallback : name === "name" ? "app" : "",
			displayInReceipt: true,
		};
	});
}

export function parseAtomAsPattern<T>(
	input: T,
	sourcePath: string,
): PatternManifest {
	if (!isJsonObject(input)) {
		throw new PatternParseError("atom meta must be an object");
	}
	const rec = input;
	const id = isJsonString(rec.id) ? rec.id : "";
	if (!id) throw new PatternParseError("atom id is required");
	const files = isJsonArray(rec.files) ? rec.files : [];
	if (files.length === 0) {
		throw new PatternParseError(`${id}: atom needs at least one file`);
	}
	const tags = asStringList(rec.tags);
	const queries = asStringList(rec.queries);
	const kind = isJsonString(rec.kind) ? rec.kind : "atom";
	const description =
		isJsonString(rec.description) && rec.description.trim()
			? rec.description
			: id;
	const renderings = files.map((file, index) => {
		if (!isJsonObject(file)) {
			throw new PatternParseError(`${id}: invalid file entry`);
		}
		const { path, from } = file;
		if (!isJsonString(path) || !isJsonString(from)) {
			throw new PatternParseError(`${id}: file needs path and from`);
		}
		return {
			id: path,
			kind: files.length === 1 ? "file" : "project",
			path: from,
			default: index === 0,
			language: path.endsWith(".ts") ? "ts" : "",
			outputFiles: [path],
		};
	});
	return parsePatternManifest({
		id,
		version: 1,
		kind: "concept",
		maturity: rec.tier === 0 ? "stable" : rec.tier === 2 ? "partial" : "stable",
		title: id,
		intent: description,
		description,
		aliases: [...new Set([id, ...queries])],
		apiSymbols: [],
		features: featuresFor(kind, tags),
		contexts: ["existing-typescript", "new-file"],
		languages: ["ts"],
		parameters: parameters(rec.params),
		provides: asStringList(rec.provides),
		requires: asStringList(rec.requires),
		conflicts: [],
		effects: [],
		renderings,
		provenance: [
			{
				path: sourcePath,
				commit: "",
				symbol: id,
				rationale:
					"git-backed atomic snippet; available via hobo-code template",
			},
		],
		limitations: [],
		legacyAliases: [id],
	});
}
