import { create } from "@bufbuild/protobuf";

import {
	EffectKind,
	ParameterKind,
	PatternKind,
	type PatternManifest,
	PatternManifestSchema,
	PatternMaturity,
	type PatternParameter,
	PatternParameterSchema,
	type PatternProvenance,
	PatternProvenanceSchema,
	type PatternRendering,
	PatternRenderingSchema,
	type PatternSearchRequest,
	PatternSearchRequestSchema,
	RenderingKind,
	type StructuralEffect,
	StructuralEffectSchema,
	WritePolicy,
} from "./_generated/patterns_pb.js";
import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

export class PatternParseError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "PatternParseError";
	}
}

const KIND = {
	concept: PatternKind.CONCEPT,
	starter: PatternKind.STARTER,
	guidance: PatternKind.GUIDANCE,
	transform: PatternKind.TRANSFORM,
} satisfies Record<string, PatternKind>;

const MATURITY = {
	stable: PatternMaturity.STABLE,
	partial: PatternMaturity.PARTIAL,
	experimental: PatternMaturity.EXPERIMENTAL,
	legacy: PatternMaturity.LEGACY,
	deprecated: PatternMaturity.DEPRECATED,
} satisfies Record<string, PatternMaturity>;

const RENDER = {
	snippet: RenderingKind.SNIPPET,
	file: RenderingKind.FILE,
	project: RenderingKind.PROJECT,
	markdown: RenderingKind.MARKDOWN,
	vscode: RenderingKind.VSCODE_SNIPPET,
	vscode_snippet: RenderingKind.VSCODE_SNIPPET,
	effects: RenderingKind.STRUCTURAL_EFFECTS,
	structural_effects: RenderingKind.STRUCTURAL_EFFECTS,
} satisfies Record<string, RenderingKind>;

const PARAM = {
	typescript_identifier: ParameterKind.TYPESCRIPT_IDENTIFIER,
	typescript_string: ParameterKind.TYPESCRIPT_STRING,
	json_string: ParameterKind.JSON_STRING,
	package_name: ParameterKind.PACKAGE_NAME,
	relative_path: ParameterKind.RELATIVE_PATH,
	profile_id: ParameterKind.PROFILE_ID,
	resource_name: ParameterKind.RESOURCE_NAME,
	integer: ParameterKind.INTEGER,
	boolean: ParameterKind.BOOLEAN,
	literal_choice: ParameterKind.LITERAL_CHOICE,
} satisfies Record<string, ParameterKind>;

const EFFECT = {
	ensure_import: EffectKind.ENSURE_IMPORT,
	declare_resource: EffectKind.DECLARE_RESOURCE,
	declare_connector: EffectKind.DECLARE_CONNECTOR,
	add_dependency: EffectKind.ADD_DEPENDENCY,
	add_allowance: EffectKind.ADD_ALLOWANCE,
	add_annotation: EffectKind.ADD_ANNOTATION,
	add_return_property: EffectKind.ADD_RETURN_PROPERTY,
	create_file: EffectKind.CREATE_FILE,
	create_project_file: EffectKind.CREATE_PROJECT_FILE,
	emit_guidance: EffectKind.EMIT_GUIDANCE,
} satisfies Record<string, EffectKind>;

function str<T>(value: T, field: string): string {
	if (!isJsonString(value) || value.trim() === "") {
		throw new PatternParseError(`${field} must be a non-empty string`);
	}
	return value;
}

function optStr<T>(value: T): string {
	return isJsonString(value) ? value : "";
}

function num<T>(value: T, field: string): number {
	if (!isJsonNumber(value) || !Number.isFinite(value) || value <= 0) {
		throw new PatternParseError(`${field} must be a positive number`);
	}
	return value;
}

function lookup<T, V>(table: Record<string, T>, value: V, field: string): T {
	const key = isJsonString(value) ? value : "";
	const found = table[key];
	if (found === undefined) {
		throw new PatternParseError(
			`${field} has unknown value ${JSON.stringify(value)}`,
		);
	}
	return found;
}

function strings<T>(value: T): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => !isJsonString(item))) {
		throw new PatternParseError("expected a string array");
	}
	return value;
}

function csv<T>(value: T): string[] {
	if (value === undefined || value === "") return [];
	if (isJsonString(value)) {
		return value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}
	return strings(value)
		.flatMap((item) => item.split(","))
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseParameter<T>(raw: T): PatternParameter {
	if (!isJsonObject(raw)) {
		throw new PatternParseError("parameter must be an object");
	}
	const rec = raw;
	return create(PatternParameterSchema, {
		name: str(rec.name, "parameter.name"),
		kind: lookup(PARAM, rec.kind, "parameter.kind"),
		required: rec.required === true,
		defaultWire: optStr(rec.default),
		choices: strings(rec.choices),
		description: optStr(rec.description),
		constraint: optStr(rec.constraint),
		affectsPath: rec.affectsPath === true,
		displayInReceipt: rec.displayInReceipt !== false,
	});
}

function parseRendering<T>(
	raw: T,
	patternId: string,
	version: number,
): PatternRendering {
	if (!isJsonObject(raw)) {
		throw new PatternParseError("rendering must be an object");
	}
	const rec = raw;
	return create(PatternRenderingSchema, {
		patternId,
		patternVersion: version,
		renderingId: str(rec.id, "rendering.id"),
		kind: lookup(RENDER, rec.kind, "rendering.kind"),
		language: optStr(rec.language),
		targetContext: optStr(rec.context),
		sourcePath: str(rec.path, "rendering.path"),
		writePolicy: WritePolicy.STDOUT_ONLY,
		outputFiles: strings(rec.outputFiles),
		requiredParameters: strings(rec.requiredParameters),
		contentDigest: "",
		effectIds: strings(rec.effectIds),
		isDefault: rec.default === true,
	});
}

function parseEffect<T>(raw: T): StructuralEffect {
	if (!isJsonObject(raw)) {
		throw new PatternParseError("effect must be an object");
	}
	const rec = raw;
	return create(StructuralEffectSchema, {
		id: str(rec.id, "effect.id"),
		kind: lookup(EFFECT, rec.kind, "effect.kind"),
		target: optStr(rec.target),
		payload: isJsonString(rec.payload)
			? rec.payload
			: JSON.stringify(rec.payload ?? {}),
	});
}

function parseProvenance<T>(raw: T): PatternProvenance {
	if (!isJsonObject(raw)) {
		throw new PatternParseError("provenance must be an object");
	}
	const rec = raw;
	return create(PatternProvenanceSchema, {
		sourcePath: str(rec.path, "provenance.path"),
		sourceCommit: optStr(rec.commit),
		sourceSymbol: optStr(rec.symbol),
		rationale: optStr(rec.rationale),
	});
}

export function parsePatternManifest<T>(input: T): PatternManifest {
	if (!isJsonObject(input)) {
		throw new PatternParseError("manifest must be an object");
	}
	const rec = input;
	const id = str(rec.id, "id");
	const version = num(rec.version, "version");
	const renderings = Array.isArray(rec.renderings)
		? rec.renderings.map((item) => parseRendering(item, id, version))
		: [];
	if (renderings.length === 0) {
		throw new PatternParseError(`${id} must declare at least one rendering`);
	}
	const provenance = Array.isArray(rec.provenance)
		? rec.provenance.map(parseProvenance)
		: [];
	if (provenance.length === 0) {
		throw new PatternParseError(`${id} must declare provenance`);
	}
	const features = Array.isArray(rec.features)
		? rec.features.map((item) => {
				if (!isJsonObject(item)) {
					throw new PatternParseError("feature must be an object");
				}
				const feat = item;
				return {
					id: str(feat.id, "feature.id"),
					weight: num(feat.weight, "feature.weight"),
				};
			})
		: [];
	return create(PatternManifestSchema, {
		id,
		version,
		kind: lookup(KIND, rec.kind, "kind"),
		maturity: lookup(MATURITY, rec.maturity, "maturity"),
		title: str(rec.title, "title"),
		intent: str(rec.intent, "intent"),
		description: optStr(rec.description),
		aliases: strings(rec.aliases),
		apiSymbols: strings(rec.apiSymbols),
		features,
		contexts: strings(rec.contexts),
		languages: strings(rec.languages),
		outputKinds: renderings.map((item) => item.kind),
		parameters: Array.isArray(rec.parameters)
			? rec.parameters.map(parseParameter)
			: [],
		provides: strings(rec.provides),
		requires: strings(rec.requires),
		conflicts: strings(rec.conflicts),
		effects: Array.isArray(rec.effects) ? rec.effects.map(parseEffect) : [],
		renderings,
		packageConstraints: strings(rec.packageConstraints),
		provenance,
		limitations: strings(rec.limitations),
		validations: [],
		replacementId: optStr(rec.replacementId),
		contentDigest: "",
	});
}

export function parsePatternQuery<T>(input: T): PatternSearchRequest {
	if (isJsonString(input)) {
		return create(PatternSearchRequestSchema, {
			query: input,
			maxResults: 8,
		});
	}
	if (!isJsonObject(input)) {
		throw new PatternParseError("query must be a string or object");
	}
	const rec = input;
	const topKRaw = rec.topK ?? rec.maxResults;
	const topK = isJsonNumber(topKRaw)
		? topKRaw
		: isJsonString(topKRaw)
			? Number(topKRaw)
			: 8;
	const kinds = csv(rec.kind ?? rec.kinds);
	const maturities = csv(rec.maturity ?? rec.maturities);
	return create(PatternSearchRequestSchema, {
		query: optStr(rec.query),
		exactId: optStr(rec.id ?? rec.exactId),
		maxResults: Number.isFinite(topK) && topK > 0 ? topK : 8,
		allowDense: rec.allowDense === true,
		autoSelect: rec.autoSelect === true,
		allowComposition: rec.compose === true,
		languageFilter: optStr(rec.language),
		contextFilter: optStr(rec.context),
		kindFilter: kinds.map((item) => lookup(KIND, item, "kind")),
		maturityFilter: maturities.map((item) =>
			lookup(MATURITY, item, "maturity"),
		),
	});
}

export type ParsedRenderRequest = {
	readonly patternId: string;
	readonly renderingId: string;
	readonly params: Readonly<Record<string, string>>;
};

export type ParsedCompositionRequest = {
	readonly query: string;
	readonly params: Readonly<Record<string, string>>;
};

export type ParsedApplicationRequest = {
	readonly patternId: string;
	readonly isolationRoot: string;
	readonly targetPath: string;
	readonly isolationRunId: string;
	readonly params: Readonly<Record<string, string>>;
};

function recordParams<T>(value: T): ParsedRenderRequest["params"] {
	if (value === undefined) return {};
	if (!isJsonObject(value)) {
		throw new PatternParseError("params must be an object");
	}
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!isJsonString(item) && !isJsonNumber(item) && !isJsonBoolean(item)) {
			throw new PatternParseError(`param ${key} must be a scalar`);
		}
		out[key] = String(item);
	}
	return out;
}

export function parseRenderRequest<T>(input: T): ParsedRenderRequest {
	if (!isJsonObject(input)) {
		throw new PatternParseError("render request must be an object");
	}
	const rec = input;
	return Object.freeze({
		patternId: str(rec.patternId ?? rec.id, "patternId"),
		renderingId: optStr(rec.renderingId),
		params: recordParams(rec.params),
	});
}

export function parseCompositionRequest<T>(input: T): ParsedCompositionRequest {
	if (!isJsonObject(input)) {
		throw new PatternParseError("composition request must be an object");
	}
	const rec = input;
	return Object.freeze({
		query: str(rec.query, "query"),
		params: recordParams(rec.params),
	});
}

export function parseApplicationRequest<T>(input: T): ParsedApplicationRequest {
	if (!isJsonObject(input)) {
		throw new PatternParseError("application request must be an object");
	}
	const rec = input;
	return Object.freeze({
		patternId: str(rec.patternId ?? rec.id, "patternId"),
		isolationRoot: str(rec.isolationRoot, "isolationRoot"),
		targetPath: str(rec.targetPath, "targetPath"),
		isolationRunId: str(rec.isolationRunId, "isolationRunId"),
		params: recordParams(rec.params),
	});
}

export function canonicalJson<T>(value: T): string {
	return `${JSON.stringify(value, (_, item: JsonValue) => {
		if (isJsonObject(item)) {
			return Object.fromEntries(
				Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
			);
		}
		return item;
	})}\n`;
}
