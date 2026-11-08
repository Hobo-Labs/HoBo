import type { PatternManifest } from "./_generated/patterns_pb.js";
import { PatternParseError, parsePatternManifest } from "./parse.js";

const KIND_FEATURE: Record<string, string> = {
	architecture: "artifact:starter",
	bindle: "artifact:bindle",
	camp: "artifact:yard",
	connector: "constraint:no-local-secret",
	http: "authoring-resource:api",
	junction: "artifact:yard",
	openfeature: "artifact:starter",
	package: "artifact:starter",
	station: "artifact:yard",
	storage: "property:durable",
	trail: "artifact:starter",
	yard: "artifact:yard",
};

const TAG_FEATURE: Record<string, string> = {
	api: "authoring-resource:api",
	web: "authoring-resource:web",
	bindle: "artifact:bindle",
	yard: "artifact:yard",
	azure: "artifact:yard",
	sqlite: "property:durable",
	hono: "authoring-resource:api",
};

function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function featuresFor(
	kind: string,
	tags: readonly string[],
): { id: string; weight: number }[] {
	const ids = new Set<string>();
	ids.add(KIND_FEATURE[kind] ?? "artifact:starter");
	for (const tag of tags) {
		const mapped = TAG_FEATURE[tag.toLowerCase()];
		if (mapped) ids.add(mapped);
	}
	return [...ids].map((id) => ({ id, weight: 1 }));
}

function parameters(raw: unknown): unknown[] {
	if (!raw || typeof raw !== "object") return [];
	const rec = raw as {
		required?: unknown;
		properties?: unknown;
	};
	const required = new Set(asStringList(rec.required));
	if (!rec.properties || typeof rec.properties !== "object") return [];
	return Object.entries(rec.properties as Record<string, unknown>).map(
		([name, spec]) => {
			const item =
				spec && typeof spec === "object" ? (spec as { default?: unknown }) : {};
			return {
				name,
				kind: name === "name" ? "resource_name" : "typescript_string",
				required: required.has(name),
				default:
					typeof item.default === "string"
						? item.default
						: name === "name"
							? "app"
							: "",
				displayInReceipt: true,
			};
		},
	);
}

export function parseAtomAsPattern(
	input: unknown,
	sourcePath: string,
): PatternManifest {
	if (typeof input !== "object" || input === null) {
		throw new PatternParseError("atom meta must be an object");
	}
	const rec = input as Record<string, unknown>;
	const id = typeof rec.id === "string" ? rec.id : "";
	if (!id) throw new PatternParseError("atom id is required");
	const files = Array.isArray(rec.files) ? rec.files : [];
	if (files.length === 0) {
		throw new PatternParseError(`${id}: atom needs at least one file`);
	}
	const tags = asStringList(rec.tags);
	const queries = asStringList(rec.queries);
	const kind = typeof rec.kind === "string" ? rec.kind : "atom";
	const description =
		typeof rec.description === "string" && rec.description.trim()
			? rec.description
			: id;
	const renderings = files.map((file, index) => {
		if (!file || typeof file !== "object") {
			throw new PatternParseError(`${id}: invalid file entry`);
		}
		const item = file as { path?: unknown; from?: unknown };
		if (typeof item.path !== "string" || typeof item.from !== "string") {
			throw new PatternParseError(`${id}: file needs path and from`);
		}
		return {
			id: item.path,
			kind: files.length === 1 ? "file" : "project",
			path: item.from,
			default: index === 0,
			language: item.path.endsWith(".ts") ? "ts" : "",
			outputFiles: [item.path],
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
				rationale: "git-backed atomic snippet; available through the catalog",
			},
		],
		limitations: [],
		legacyAliases: [id],
	});
}
