/**
 * Typed realization output contract (`hobo.realization-result/v1`, Plan 25
 * Driver surface).
 *
 * What a realization engine — an IaC program (terraform/pulumi/crossplane
 * adapters, which already converge on `{resources, stackOutputs, bindings}`)
 * or a provider recipe/driver program (Radius-semantics
 * `{values, secrets, resources}`) — reports back after apply. Parse, don't
 * validate: `parseRealizationResult` returns the frozen, canonically ordered
 * derived type or throws a typed error. The ref-only secret rule is
 * fail-closed: `secrets` carries URI-shaped references (e.g.
 * `secretRef: "broker://tenant/db"`) and NEVER values, and a raw
 * secret-looking value anywhere in `values`, `bindings`, or resource
 * `outputs` is a parse error — engines do not launder credentials through
 * this record.
 */

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

// public-contract: the schema id every realization engine reports back under.
export const REALIZATION_RESULT_SCHEMA = "hobo.realization-result/v1";

/** Why a raw realization result was rejected. */
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

// domain-view: parsed derived type; wire form is RealizedResourceRecord in data-models/realization_result.proto (outputs JSON-encoded on the wire).
export interface RealizedResourceRecord {
	/** Logical resource name inside the deployment set. */
	readonly name: string;
	/** Resource class/type token (e.g. `bucket`, `kv`, `convex.function`). */
	readonly resourceClass: string;
	/**
	 * Stable provider-side id: adapter URN, workspace key, adopted external id
	 * (`terraform://…`), or OCI digest for artifact resources.
	 */
	readonly providerId: string;
	/** Non-sensitive outputs of this resource; secret values never ride here. */
	readonly outputs: JsonObject;
}

// domain-view: parsed derived type; wire form is SecretRefRecord in data-models/realization_result.proto.
export interface SecretRefRecord {
	/** URI-shaped reference (e.g. `broker://tenant/db`) — never the value. */
	readonly secretRef: string;
}

// domain-view: parsed derived type; wire form is RealizationBindingRecord in data-models/realization_result.proto (value JSON-encoded on the wire).
export interface RealizationBindingRecord {
	/** Binding key or `${resources.<name>.outputs.<key>}` placeholder. */
	readonly key: string;
	readonly value: JsonValue;
}

// domain-view: parsed derived type; wire form is RealizationResultRecord in data-models/realization_result.proto.
export interface RealizationResult {
	readonly schema: typeof REALIZATION_RESULT_SCHEMA;
	/** Realized/adopted backing resources, sorted by name. */
	readonly resources: readonly RealizedResourceRecord[];
	/** Non-sensitive stack outputs for dependents, keys sorted. */
	readonly values: JsonObject;
	/** Resolved binding entries, sorted by key. */
	readonly bindings: readonly RealizationBindingRecord[];
	/** REFERENCES ONLY — the fail-closed ref-only rule, keys sorted. */
	readonly secrets: Readonly<Record<string, SecretRefRecord>>;
}

/** URI-shaped secret reference: `<scheme>://<non-empty rest>`. */
const SECRET_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/**
 * Heuristic for keys that name credentials: secret/password/token/credential,
 * `apiKey`/`api_key`-style compounds, and a bare `key` segment. Deliberately
 * fail-closed — a matching key must hold a ref (or non-string), never a raw
 * string value.
 */
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
	// SAFETY: assertion required at this I/O or test boundary.
	return value as JsonObject;
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
		record[key] = value;
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

/**
 * Parse, don't validate: returns the frozen, canonically ordered
 * `RealizationResult` (resources sorted by name, bindings by key, map keys
 * sorted) or throws `RealizationResultParseError`. Fail-closed on secrets: a
 * raw secret-looking string value anywhere is a rejection, never a warning.
 */
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

/** The `{resources, stackOutputs, bindings}` triple every IaC adapter emits. */
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

/**
 * Map the IaC engine output triple (`terraform-adapter.ts` / the pulumi and
 * crossplane mirrors) onto a parsed `RealizationResult`. Binding or stack
 * output entries whose key looks secret-like AND whose value already is a
 * ref string are hoisted into `secrets`; raw secret values are left in place
 * so the parse rejects them (fail-closed — the adapter never launders).
 */
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

/** Radius-semantics driver/recipe result: `{values, secrets, resources}`. */
export interface RecipeOutputsLike {
	readonly values?: JsonObject;
	/** Refs only — bare ref strings and `{secretRef}` / `{ref}` records. */
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

/**
 * Map a provider driver-program/recipe result (clean-room Radius
 * `{values, secrets, resources}` semantics — no Radius dependency) onto a
 * parsed `RealizationResult`. Secret entries are normalized to
 * `{secretRef}`; anything that is not a ref reaches the parser unchanged and
 * is rejected there (fail-closed).
 */
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
