// A strict JSON Schema draft-07 validator for the keyword subset the pinned
// OSCAL 1.1.2 schemas use. Test-only: @hobo/policy is dependency-free, so
// the conformance check carries its own evaluator. Any keyword outside the
// supported set fails loudly instead of being skipped, so the check can
// never pass by ignoring part of the schema.
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../../src/json.js";

type Schema = { readonly [key: string]: JsonValue };

const ANNOTATIONS: ReadonlySet<string> = new Set([
	"$schema",
	"$id",
	"$comment",
	"title",
	"description",
	"definitions",
	"contentEncoding",
]);

const SUPPORTED: ReadonlySet<string> = new Set([
	"$ref",
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"minItems",
	"allOf",
	"anyOf",
	"oneOf",
	"enum",
	"const",
	"pattern",
	"format",
	"minimum",
]);

const DATE_TIME =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/u;
const URI_REFERENCE = /^[^\s]*$/u;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;

function typeOf(value: JsonValue): string {
	if (value === null) return "null";
	if (isJsonArray(value)) return "array";
	if (isJsonObject(value)) return "object";
	if (isJsonString(value)) return "string";
	if (isJsonNumber(value)) return "number";
	if (isJsonBoolean(value)) return "boolean";
	return "unknown";
}

function matchesType(value: JsonValue, type: string): boolean {
	const actual = typeOf(value);
	if (type === "integer") return actual === "number" && Number.isInteger(value);
	return actual === type;
}

export function createValidator(root: Schema) {
	const byId = new Map<string, Schema>();
	const definitions = root.definitions;
	if (isJsonObject(definitions)) {
		for (const definition of Object.values(definitions)) {
			if (isJsonObject(definition) && isJsonString(definition.$id))
				byId.set(definition.$id, definition);
		}
	}
	const patterns = new Map<string, RegExp>();

	function resolve(ref: string): Schema {
		if (ref.startsWith("#/definitions/")) {
			const name = ref.slice("#/definitions/".length);
			const found = isJsonObject(definitions) ? definitions[name] : undefined;
			if (isJsonObject(found)) return found;
		}
		const found = byId.get(ref);
		if (found) return found;
		throw new Error(`unresolved $ref ${ref}`);
	}

	function regex(source: string): RegExp {
		let compiled = patterns.get(source);
		if (!compiled) {
			compiled = new RegExp(source, "u");
			patterns.set(source, compiled);
		}
		return compiled;
	}

	function validate(value: JsonValue, schema: Schema, path: string): string[] {
		const errors: string[] = [];
		for (const key of Object.keys(schema)) {
			if (!ANNOTATIONS.has(key) && !SUPPORTED.has(key))
				throw new Error(`unsupported schema keyword ${key} at ${path}`);
		}
		if (isJsonString(schema.$ref))
			errors.push(...validate(value, resolve(schema.$ref), path));
		const type = schema.type;
		if (isJsonString(type) && !matchesType(value, type))
			errors.push(`${path}: expected ${type}, got ${typeOf(value)}`);
		if (
			isJsonArray(type) &&
			!type.some((t) => isJsonString(t) && matchesType(value, t))
		)
			errors.push(`${path}: expected one of ${type.join("|")}`);
		if (isJsonArray(schema.enum) && !schema.enum.includes(value))
			errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
		if (schema.const !== undefined && schema.const !== value)
			errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
		if (isJsonString(value)) {
			if (isJsonString(schema.pattern) && !regex(schema.pattern).test(value))
				errors.push(
					`${path}: ${JSON.stringify(value)} fails ${schema.pattern}`,
				);
			if (schema.format === "date-time" && !DATE_TIME.test(value))
				errors.push(`${path}: not a date-time`);
			if (schema.format === "uri" && !URI.test(value))
				errors.push(`${path}: not a uri`);
			if (schema.format === "uri-reference" && !URI_REFERENCE.test(value))
				errors.push(`${path}: not a uri-reference`);
			if (schema.format === "email" && !EMAIL.test(value))
				errors.push(`${path}: not an email`);
		}
		if (
			isJsonNumber(value) &&
			isJsonNumber(schema.minimum) &&
			value < schema.minimum
		)
			errors.push(`${path}: below minimum ${schema.minimum}`);
		if (isJsonArray(value)) {
			if (isJsonNumber(schema.minItems) && value.length < schema.minItems)
				errors.push(`${path}: fewer than ${schema.minItems} items`);
			if (isJsonObject(schema.items)) {
				const items = schema.items;
				value.forEach((item, index) => {
					errors.push(...validate(item, items, `${path}[${index}]`));
				});
			}
		}
		if (isJsonObject(value)) {
			const properties = isJsonObject(schema.properties)
				? schema.properties
				: {};
			if (isJsonArray(schema.required)) {
				for (const name of schema.required) {
					if (isJsonString(name) && !(name in value))
						errors.push(`${path}: missing required ${name}`);
				}
			}
			for (const [name, member] of Object.entries(value)) {
				const property = properties[name];
				if (isJsonObject(property)) {
					errors.push(...validate(member, property, `${path}.${name}`));
				} else if (schema.additionalProperties === false) {
					errors.push(`${path}: additional property ${name}`);
				} else if (isJsonObject(schema.additionalProperties)) {
					errors.push(
						...validate(member, schema.additionalProperties, `${path}.${name}`),
					);
				}
			}
		}
		if (isJsonArray(schema.allOf)) {
			for (const part of schema.allOf)
				if (isJsonObject(part)) errors.push(...validate(value, part, path));
		}
		if (isJsonArray(schema.anyOf)) {
			const passing = schema.anyOf.filter(
				(part) =>
					isJsonObject(part) && validate(value, part, path).length === 0,
			);
			if (passing.length === 0) errors.push(`${path}: matches no anyOf branch`);
		}
		if (isJsonArray(schema.oneOf)) {
			const passing = schema.oneOf.filter(
				(part) =>
					isJsonObject(part) && validate(value, part, path).length === 0,
			);
			if (passing.length !== 1)
				errors.push(`${path}: matches ${passing.length} oneOf branches`);
		}
		return errors;
	}

	return (value: JsonValue): string[] => validate(value, root, "$");
}
