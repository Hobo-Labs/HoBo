import { CoreParseError } from "../errors.js";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import { deepFreeze } from "../parse-utils.js";

export const REALIZATION_RESULT_SCHEMA = "hobo.realization-result/v1";

export type RealizationResultRejection =
	| "not-an-object"
	| "schema-mismatch"
	| "invalid-resource"
	| "duplicate-resource"
	| "invalid-value-map"
	| "invalid-binding"
	| "duplicate-binding"
	| "invalid-secret-ref"
	| "raw-secret-value";

export class RealizationResultParseError extends CoreParseError {
	readonly rejection: RealizationResultRejection;

	constructor(
		rejection: RealizationResultRejection,
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super(
			"HOBO_CORE_REALIZATION_RESULT_PARSE",
			path,
			expected,
			received,
			message,
		);
		this.name = "RealizationResultParseError";
		this.rejection = rejection;
	}
}

export interface RealizedResourceRecord {
	readonly name: string;
	readonly resourceClass: string;
	readonly providerId: string;
	readonly outputs: JsonObject;
}

export interface SecretRefRecord {
	readonly secretRef: string;
}

export interface RealizationBindingRecord {
	readonly key: string;
	readonly value: JsonValue;
}

export interface RealizationResult {
	readonly schema: typeof REALIZATION_RESULT_SCHEMA;
	readonly resources: readonly RealizedResourceRecord[];
	readonly values: JsonObject;
	readonly bindings: readonly RealizationBindingRecord[];
	readonly secrets: Readonly<Record<string, SecretRefRecord>>;
}

const SECRET_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

const SECRET_KEY_PATTERN =
	/secret|password|passwd|credential|token|api[_-]?key|private[_-]?key|access[_-]?key|(^|[._-])key([._-]|$)/i;

export function isSecretRefString(
	value: JsonValue | undefined,
): value is string {
	return isJsonString(value) && SECRET_REF_PATTERN.test(value);
}

export function looksLikeSecretKey(key: string): boolean {
	return SECRET_KEY_PATTERN.test(key);
}

function rejectRawSecret(
	path: string,
	key: string,
	value: JsonValue | undefined,
): void {
	if (
		looksLikeSecretKey(key) &&
		isJsonString(value) &&
		!isSecretRefString(value)
	) {
		throw new RealizationResultParseError(
			"raw-secret-value",
			`${path}.${key}`,
			"a secret reference (e.g. broker://…), never a raw secret value",
			"<redacted raw string>",
			`${path}.${key}: secret-looking key carries a raw string value; realization results are ref-only (hobo.realization-result/v1)`,
		);
	}
}

function plainObject(
	value: JsonValue | undefined,
	path: string,
	rejection: RealizationResultRejection,
): JsonObject {
	if (!value || !isJsonObject(value) || Array.isArray(value)) {
		throw new RealizationResultParseError(rejection, path, "object", value);
	}
	return value;
}

function requireString(
	value: JsonValue | undefined,
	path: string,
	rejection: RealizationResultRejection,
): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new RealizationResultParseError(
			rejection,
			path,
			"non-empty string",
			value,
		);
	}
	return value;
}

function sortedRecord<T>(entries: readonly (readonly [string, T])[]) {
	const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const record: { [key: string]: T } = {};
	for (const [key, value] of sorted) {
		Object.defineProperty(record, key, {
			value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return record;
}

function parseRealizedResource(
	raw: JsonValue | undefined,
	index: number,
): RealizedResourceRecord {
	const path = `resources[${index}]`;
	const input = plainObject(raw, path, "invalid-resource");
	const name = requireString(input.name, `${path}.name`, "invalid-resource");
	const resourceClass = requireString(
		input.resourceClass,
		`${path}.resourceClass`,
		"invalid-resource",
	);
	const providerId = requireString(
		input.providerId,
		`${path}.providerId`,
		"invalid-resource",
	);
	const outputs =
		input.outputs === undefined
			? {}
			: plainObject(input.outputs, `${path}.outputs`, "invalid-resource");
	for (const [key, value] of Object.entries(outputs)) {
		rejectRawSecret(`${path}.outputs`, key, value);
	}
	return {
		name,
		resourceClass,
		providerId,
		outputs: sortedRecord(Object.entries(outputs)),
	};
}

function parseSecretRef(
	raw: JsonValue | undefined,
	path: string,
): SecretRefRecord {
	const candidate = isJsonString(raw)
		? raw
		: plainObject(raw, path, "invalid-secret-ref").secretRef;
	if (!isSecretRefString(candidate)) {
		throw new RealizationResultParseError(
			"invalid-secret-ref",
			path,
			"a URI-shaped secret reference (e.g. broker://tenant/db); raw secret values never ride a realization result",
			"<redacted>",
		);
	}
	return { secretRef: candidate };
}

export function parseRealizationResult(
	raw: JsonValue | undefined,
): RealizationResult {
	const input = plainObject(raw, "realizationResult", "not-an-object");
	if (input.schema !== REALIZATION_RESULT_SCHEMA) {
		throw new RealizationResultParseError(
			"schema-mismatch",
			"realizationResult.schema",
			REALIZATION_RESULT_SCHEMA,
			input.schema,
		);
	}

	const rawResources = input.resources ?? [];
	if (!Array.isArray(rawResources)) {
		throw new RealizationResultParseError(
			"invalid-resource",
			"realizationResult.resources",
			"array of realized resources",
			rawResources,
		);
	}
	const resources = rawResources.map(parseRealizedResource);
	const seenNames = new Set<string>();
	for (const resource of resources) {
		if (seenNames.has(resource.name)) {
			throw new RealizationResultParseError(
				"duplicate-resource",
				"realizationResult.resources",
				"unique resource names",
				resource.name,
			);
		}
		seenNames.add(resource.name);
	}
	resources.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	const values =
		input.values === undefined
			? {}
			: plainObject(
					input.values,
					"realizationResult.values",
					"invalid-value-map",
				);
	for (const [key, value] of Object.entries(values)) {
		rejectRawSecret("values", key, value);
	}

	const rawBindings = input.bindings ?? [];
	if (!Array.isArray(rawBindings)) {
		throw new RealizationResultParseError(
			"invalid-binding",
			"realizationResult.bindings",
			"array of binding records",
			rawBindings,
		);
	}
	const bindings: RealizationBindingRecord[] = rawBindings.map(
		(entry, index) => {
			const path = `bindings[${index}]`;
			const record = plainObject(entry, path, "invalid-binding");
			const key = requireString(record.key, `${path}.key`, "invalid-binding");
			rejectRawSecret("bindings", key, record.value);
			if (record.value === undefined) {
				throw new RealizationResultParseError(
					"invalid-binding",
					`${path}.value`,
					"JSON value",
					record.value,
				);
			}
			return { key, value: record.value };
		},
	);
	const seenKeys = new Set<string>();
	for (const binding of bindings) {
		if (seenKeys.has(binding.key)) {
			throw new RealizationResultParseError(
				"duplicate-binding",
				"realizationResult.bindings",
				"unique binding keys",
				binding.key,
			);
		}
		seenKeys.add(binding.key);
	}
	bindings.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

	const rawSecrets =
		input.secrets === undefined
			? {}
			: plainObject(
					input.secrets,
					"realizationResult.secrets",
					"invalid-secret-ref",
				);
	const secrets = sortedRecord(
		Object.entries(rawSecrets).map(
			([name, ref]) => [name, parseSecretRef(ref, `secrets.${name}`)] as const,
		),
	);

	return deepFreeze({
		schema: REALIZATION_RESULT_SCHEMA,
		resources,
		values: sortedRecord(Object.entries(values)),
		bindings,
		secrets,
	});
}

export interface IacOutputsLike {
	readonly resources: Readonly<
		Record<
			string,
			{
				readonly id?: unknown;
				readonly type?: unknown;
				readonly outputs?: unknown;
			}
		>
	>;
	readonly stackOutputs?: JsonObject;
	readonly bindings?: JsonObject;
}

export function fromIacOutputs(
	outputs: IacOutputsLike,
	options: { readonly defaultResourceClass?: string } = {},
): RealizationResult {
	const resourceEntries = plainObject(
		cloneAsJson(outputs.resources),
		"iacOutputs.resources",
		"invalid-resource",
	);
	const resources = Object.entries(resourceEntries).map(([name, entry]) => {
		const record = plainObject(
			entry,
			`iacOutputs.resources.${name}`,
			"invalid-resource",
		);
		return {
			name,
			resourceClass:
				isJsonString(record.type) && record.type.length > 0
					? record.type
					: (options.defaultResourceClass ?? "iac-resource"),
			providerId:
				isJsonString(record.id) && record.id.length > 0 ? record.id : name,
			outputs: isJsonObject(record.outputs) ? record.outputs : {},
		};
	});

	const secrets: JsonBag = {};
	const values: JsonBag = {};
	for (const [key, value] of Object.entries(outputs.stackOutputs ?? {})) {
		if (looksLikeSecretKey(key) && isSecretRefString(value)) {
			secrets[key] = { secretRef: value };
		} else {
			values[key] = value;
		}
	}
	const bindings: { key: string; value: JsonValue }[] = [];
	for (const [key, value] of Object.entries(outputs.bindings ?? {})) {
		if (looksLikeSecretKey(key) && isSecretRefString(value)) {
			secrets[key] = { secretRef: value };
		} else {
			bindings.push({ key, value });
		}
	}

	return parseRealizationResult(
		cloneAsJson({
			schema: REALIZATION_RESULT_SCHEMA,
			resources,
			values,
			bindings,
			secrets,
		}),
	);
}

export interface RecipeOutputsLike {
	readonly values?: JsonObject;
	readonly secrets?: JsonObject;
	readonly resources?: readonly {
		readonly name?: unknown;
		readonly resourceClass?: unknown;
		readonly type?: unknown;
		readonly providerId?: unknown;
		readonly id?: unknown;
		readonly outputs?: unknown;
	}[];
}

export function fromRecipeOutputs(
	outputs: RecipeOutputsLike,
	options: { readonly defaultResourceClass?: string } = {},
): RealizationResult {
	const resources = (outputs.resources ?? []).map((entry, index) => {
		const record = plainObject(
			cloneAsJson(entry),
			`recipeOutputs.resources[${index}]`,
			"invalid-resource",
		);
		const name = record.name;
		const resourceClass =
			isJsonString(record.resourceClass) && record.resourceClass.length > 0
				? record.resourceClass
				: isJsonString(record.type) && record.type.length > 0
					? record.type
					: (options.defaultResourceClass ?? "recipe-resource");
		const providerId =
			isJsonString(record.providerId) && record.providerId.length > 0
				? record.providerId
				: isJsonString(record.id) && record.id.length > 0
					? record.id
					: name;
		return {
			name,
			resourceClass,
			providerId,
			outputs: isJsonObject(record.outputs) ? record.outputs : {},
		};
	});

	const secrets: JsonBag = {};
	for (const [name, ref] of Object.entries(outputs.secrets ?? {})) {
		if (isJsonString(ref)) {
			secrets[name] = { secretRef: ref };
		} else if (
			isJsonObject(ref) &&
			isJsonString(ref.ref) &&
			ref.secretRef === undefined
		) {
			secrets[name] = { secretRef: ref.ref };
		} else {
			secrets[name] = ref;
		}
	}

	return parseRealizationResult(
		cloneAsJson({
			schema: REALIZATION_RESULT_SCHEMA,
			resources,
			values: outputs.values ?? {},
			bindings: [],
			secrets,
		}),
	);
}
