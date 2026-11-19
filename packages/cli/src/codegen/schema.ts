import { Script } from "node:vm";
import { create, toJson } from "@bufbuild/protobuf";
import ts from "typescript";
import {
	type CodegenFieldSchema,
	CodegenFieldSchemaSchema,
} from "../_generated/project_codegen_pb.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import { pascalCase } from "./text.js";
import { CodegenError } from "./types.js";

function invalid(path: string, message: string): never {
	throw new CodegenError("HOBO_CODEGEN_SOURCE_PARSE", `${path}: ${message}`, {
		field: path,
	});
}

export function parseFieldSchema(
	raw: JsonValue | undefined,
	path = "schema",
): CodegenFieldSchema {
	if (raw === true) return create(CodegenFieldSchemaSchema, { kind: "any" });
	if (raw === false) return create(CodegenFieldSchemaSchema, { kind: "never" });
	if (isJsonString(raw)) raw = { type: raw };
	if (!isJsonObject(raw)) return invalid(path, "expected a field schema");
	const input: JsonObject = Object.fromEntries(Object.entries(raw));
	const optional = input.optional === true;
	const nullable = input.nullable === true;
	const node = create(CodegenFieldSchemaSchema, { optional, nullable });
	if (isJsonString(input.$ref) || isJsonString(input.ref)) {
		const reference = isJsonString(input.$ref) ? input.$ref : input.ref;
		if (!isJsonString(reference) || !reference)
			return invalid(path, "reference must name a schema");
		node.kind = "ref";
		node.reference = reference
			.replace(/^#\/(?:resources|definitions|\$defs)\//u, "")
			.replace(/~1/gu, "/")
			.replace(/~0/gu, "~");
		return node;
	}
	if (Object.hasOwn(input, "const") || Object.hasOwn(input, "literal")) {
		node.kind = "enum";
		node.valuesJson = [
			JSON.stringify(
				Object.hasOwn(input, "const") ? input.const : input.literal,
			),
		];
		return node;
	}
	const alternatives = input.anyOf ?? input.oneOf ?? input.variants;
	if (
		Array.isArray(alternatives) ||
		Array.isArray(input.allOf) ||
		Array.isArray(input.type)
	) {
		const list = Array.isArray(alternatives)
			? alternatives
			: Array.isArray(input.allOf)
				? input.allOf
				: input.type;
		if (!Array.isArray(list) || list.length === 0)
			return invalid(path, "variants must be non-empty");
		node.kind = Array.isArray(input.allOf)
			? "intersection"
			: Array.isArray(input.oneOf)
				? "oneof"
				: "union";
		node.variants = list.map((entry, index) =>
			parseFieldSchema(entry, `${path}.variants[${index}]`),
		);
		return node;
	}
	node.kind = isJsonString(input.type)
		? input.type
		: input.properties || input.fields
			? "object"
			: "";
	if (Array.isArray(input.enum) || node.kind === "enum") {
		const values = input.enum ?? input.values;
		if (!Array.isArray(values) || values.length === 0)
			return invalid(path, "enum must have values");
		node.kind = "enum";
		node.valuesJson = [
			...new Set(values.map((value) => JSON.stringify(value))),
		].sort();
		return node;
	}
	if (
		[
			"string",
			"number",
			"integer",
			"boolean",
			"null",
			"any",
			"unknown",
			"never",
		].includes(node.kind)
	) {
		if (isJsonString(input.format)) node.format = input.format;
		return node;
	}
	if (node.kind === "object") {
		const fields = input.fields ?? input.properties ?? {};
		if (!isJsonObject(fields))
			return invalid(path, "object fields must be a map");
		const required = Array.isArray(input.required) ? input.required : undefined;
		for (const [key, value] of Object.entries(fields).sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		)) {
			const field = parseFieldSchema(value, `${path}.${key}`);
			if (required !== undefined || input.properties !== undefined)
				field.optional = !required?.includes(key);
			Object.defineProperty(node.fields, key, {
				value: field,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		node.closed = input.additionalProperties === false;
		if (isJsonObject(input.additionalProperties))
			node.items = parseFieldSchema(
				input.additionalProperties,
				`${path}.additionalProperties`,
			);
		return node;
	}
	if (node.kind === "array" && Array.isArray(input.items)) node.kind = "tuple";
	if (node.kind === "tuple" || Array.isArray(input.prefixItems)) {
		node.kind = "tuple";
		const items = input.prefixItems ?? input.items;
		if (!Array.isArray(items))
			return invalid(path, "tuple items must be a list");
		node.tuple = items.map((entry, index) =>
			parseFieldSchema(entry, `${path}[${index}]`),
		);
		return node;
	}
	if (node.kind === "array" || node.kind === "record" || node.kind === "map") {
		if (node.kind === "map") node.kind = "record";
		node.items = parseFieldSchema(
			input.items ?? input.values ?? input.additionalProperties,
			`${path}.items`,
		);
		return node;
	}
	return invalid(path, `unsupported schema kind ${JSON.stringify(node.kind)}`);
}

export function renderSchemaType(schema: CodegenFieldSchema): string {
	let type: string;
	switch (schema.kind) {
		case "string":
			type = "string";
			break;
		case "number":
		case "integer":
			type = "number";
			break;
		case "boolean":
			type = "boolean";
			break;
		case "null":
			type = "null";
			break;
		case "any":
			type = "any";
			break;
		case "unknown":
			type = "unknown";
			break;
		case "never":
			type = "never";
			break;
		case "enum":
			type = schema.valuesJson.join(" | ");
			break;
		case "ref":
			type = pascalCase(schema.reference);
			break;
		case "array":
			type = `Array<${renderSchemaType(requiredItems(schema))}>`;
			break;
		case "record":
			type = `Record<string, ${renderSchemaType(requiredItems(schema))}>`;
			break;
		case "tuple":
			type = `[${schema.tuple.map(renderSchemaType).join(", ")}]`;
			break;
		case "oneof":
		case "union":
			type = `(${schema.variants.map(renderSchemaType).join(" | ")})`;
			break;
		case "intersection":
			type = `(${schema.variants.map(renderSchemaType).join(" & ")})`;
			break;
		case "object":
			type = `{ ${Object.entries(schema.fields)
				.map(
					([name, field]) =>
						`${JSON.stringify(name)}${field.optional ? "?" : ""}: ${renderSchemaType(field)};`,
				)
				.join(" ")} }`;
			if (schema.items) {
				const values = [
					renderSchemaType(schema.items),
					...Object.values(schema.fields).map(renderSchemaType),
				];
				if (Object.values(schema.fields).some((field) => field.optional))
					values.push("undefined");
				type = `(${type} & Record<string, ${[...new Set(values)].join(" | ")}>)`;
			}
			break;
		default:
			return invalid("schema", `invalid parsed kind ${schema.kind}`);
	}
	return schema.nullable && schema.kind !== "null" ? `(${type} | null)` : type;
}
function requiredItems(schema: CodegenFieldSchema): CodegenFieldSchema {
	return schema.items ?? invalid("schema", `${schema.kind} needs items`);
}

export function exampleSchemaValue(
	schema: CodegenFieldSchema,
	definitions: ReadonlyMap<string, CodegenFieldSchema> = new Map(),
	visiting = new Set<string>(),
): JsonValue {
	if (schema.nullable) return null;
	switch (schema.kind) {
		case "string":
			return schema.format === "date-time"
				? "2026-01-01T00:00:00.000Z"
				: schema.format === "email"
					? "example@example.com"
					: schema.format === "uuid"
						? "00000000-0000-4000-8000-000000000000"
						: schema.format === "uri"
							? "https://example.test"
							: "example";
		case "number":
		case "integer":
			return 0;
		case "boolean":
			return false;
		case "null":
		case "any":
		case "unknown":
			return null;
		case "enum":
			return JSON.parse(schema.valuesJson[0] ?? "null");
		case "array":
			return [];
		case "tuple":
			return schema.tuple.map((item) =>
				exampleSchemaValue(item, definitions, visiting),
			);
		case "record":
			return {};
		case "object":
			return Object.fromEntries(
				Object.entries(schema.fields)
					.filter(([, field]) => !field.optional)
					.map(([name, field]) => [
						name,
						exampleSchemaValue(field, definitions, visiting),
					]),
			);
		case "oneof":
		case "union":
			return exampleVariantValue(schema, definitions, visiting);
		case "intersection":
			return exampleVariantValue(schema, definitions, visiting);
		case "ref": {
			if (visiting.has(schema.reference))
				return invalid(
					"schema",
					`required recursive reference ${schema.reference} has no finite example; make the recursion optional, nullable, or use a collection`,
				);
			const next = new Set(visiting);
			next.add(schema.reference);
			return exampleSchemaValue(
				definitions.get(schema.reference) ??
					invalid("schema", `unknown reference ${schema.reference}`),
				definitions,
				next,
			);
		}
		default:
			return invalid("schema", `no value inhabits ${schema.kind}`);
	}
}

type RuntimeSchemaParser = (
	schema: JsonValue,
	value: JsonValue,
	path: string,
	definitions: Record<string, JsonValue>,
) => JsonValue;
let exampleParser: RuntimeSchemaParser | undefined;
function parserForExamples(): RuntimeSchemaParser {
	if (exampleParser) return exampleParser;
	const compiled = ts.transpileModule(schemaRuntimeSource(), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	exampleParser = new Script(
		`(function(exports) { ${compiled}; return exports.parseValue; })({})`,
	).runInThisContext() as RuntimeSchemaParser;
	return exampleParser;
}
function exampleVariantValue(
	schema: CodegenFieldSchema,
	definitions: ReadonlyMap<string, CodegenFieldSchema>,
	visiting: Set<string>,
): JsonValue {
	const candidates: JsonValue[] = [];
	for (const variant of schema.variants) {
		if (variant.kind === "enum")
			candidates.push(...variant.valuesJson.map((value) => JSON.parse(value)));
		try {
			candidates.push(exampleSchemaValue(variant, definitions, visiting));
		} catch (error) {
			if (!(error instanceof CodegenError)) throw error;
		}
	}
	if (
		schema.kind === "intersection" &&
		candidates.every((value) => isJsonObject(value))
	)
		candidates.unshift(candidates.reduce(mergeExampleObjects, {}));
	candidates.push(null, 0.5, 1, true, false, "", "other@example.com", [], {});
	const validate = parserForExamples();
	const wire = serializedSchema(schema);
	const registry = Object.fromEntries(
		[...definitions].map(([name, value]) => [name, serializedSchema(value)]),
	);
	for (const value of candidates) {
		try {
			validate(wire, value, "example", registry);
			return value;
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
		}
	}
	return invalid(
		"schema",
		"no valid finite contract example for the schema variants",
	);
}

function mergeExampleObjects(left: JsonObject, right: JsonObject): JsonObject {
	return Object.fromEntries(
		[...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => {
			const before = left[key] ?? null;
			const after = right[key] ?? null;
			return [
				key,
				Object.hasOwn(right, key)
					? isJsonObject(before) && isJsonObject(after)
						? mergeExampleObjects(before, after)
						: after
					: before,
			];
		}),
	);
}

export function serializedSchema(schema: CodegenFieldSchema): JsonValue {
	return toJson(CodegenFieldSchemaSchema, schema) as JsonValue;
}

export function schemaRuntimeSource(): string {
	return `
export type FieldSchema = {
  kind: string; fields?: Record<string, FieldSchema>; items?: FieldSchema;
  variants?: FieldSchema[]; valuesJson?: string[]; optional?: boolean;
  nullable?: boolean; reference?: string; tuple?: FieldSchema[]; format?: string; closed?: boolean;
};
export function parseValue(schema: FieldSchema, value: unknown, path = "$", definitions: Readonly<Record<string, FieldSchema>> = {}): unknown {
  const ancestors = new WeakSet<object>();
  function equalLiteral(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equalLiteral(a[key], b[key]));
  }
  function check(node: FieldSchema, input: unknown, at: string): void {
    const fail = (detail: string): never => { throw new TypeError(at + ": " + detail); };
    if (input === undefined && node.optional) return;
    if (input === null && node.nullable) return;
    if (node.kind === "ref") {
      const target = definitions[node.reference ?? ""];
      if (!target) return fail("unknown schema reference");
      return check(target, input, at);
    }
    if (node.kind === "union" || node.kind === "oneof") {
      let matches = 0;
      for (const candidate of node.variants ?? []) {
        try { check(candidate, input, at); matches += 1; if (node.kind === "union") return; } catch (error) { if (!(error instanceof TypeError)) throw error; }
      }
      if (node.kind === "oneof" && matches === 1) return;
      return fail("does not match exactly the required union variants");
    }
    if (node.kind === "intersection") { for (const candidate of node.variants ?? []) check(candidate, input, at); return; }
    if (node.kind === "any" || node.kind === "unknown") return;
    if (node.kind === "never") return fail("value is not allowed");
    if (node.kind === "null") { if (input !== null) fail("expected null"); return; }
    if (node.kind === "enum") {
      if (!(node.valuesJson ?? []).some(encoded => equalLiteral(JSON.parse(encoded), input))) fail("expected an enum member");
      return;
    }
    if (node.kind === "string") {
      if (typeof input !== "string") return fail("expected string");
      if (node.format === "date-time" && (!/^\\d{4}-\\d{2}-\\d{2}T/u.test(input) || !Number.isFinite(Date.parse(input)))) fail("expected date-time");
      if (node.format === "email" && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/u.test(input)) fail("expected email");
      if (node.format === "uri") { try { new URL(input); } catch { fail("expected absolute URI"); } }
      if (node.format === "uuid" && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(input)) fail("expected UUID");
      return;
    }
    if (node.kind === "number" || node.kind === "integer") {
      if (typeof input !== "number" || !Number.isFinite(input) || (node.kind === "integer" && !Number.isInteger(input))) fail("expected " + node.kind);
      return;
    }
    if (node.kind === "boolean") { if (typeof input !== "boolean") fail("expected boolean"); return; }
    if (typeof input !== "object" || input === null) return fail("expected " + node.kind);
    if (ancestors.has(input)) return fail("cyclic values cannot cross the JSON resource boundary");
    ancestors.add(input);
    try {
      if (node.kind === "array" || node.kind === "tuple") {
        if (!Array.isArray(input)) return fail("expected array");
        if (node.kind === "tuple" && input.length !== (node.tuple ?? []).length) fail("incorrect tuple length");
        for (let index = 0; index < input.length; index += 1) {
          if (!Object.hasOwn(input, index)) return fail("sparse arrays cannot cross the JSON resource boundary");
          const itemSchema = node.kind === "tuple" ? node.tuple?.[index] : node.items;
          if (!itemSchema) return fail("array has no item schema");
          check(itemSchema, input[index], at + "[" + index + "]");
        }
        return;
      }
      if (Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return fail("expected plain object");
      const record = input as Record<string, unknown>;
      if (node.kind === "record") {
        if (!node.items) return fail("record has no item schema");
        for (const [key, entry] of Object.entries(record)) check(node.items, entry, at + "." + key);
        return;
      }
      if (node.kind === "object") {
        for (const [key, field] of Object.entries(node.fields ?? {})) {
          if (!Object.hasOwn(record, key) && !field.optional) return fail("missing field " + key);
          check(field, record[key], at + "." + key);
        }
        for (const [key, entry] of Object.entries(record)) {
          if (Object.hasOwn(node.fields ?? {}, key)) continue;
          if (node.closed) return fail("unexpected field " + key);
          if (node.items) check(node.items, entry, at + "." + key);
        }
        return;
      }
      return fail("unknown schema kind " + node.kind);
    } finally { ancestors.delete(input); }
  }
  check(schema, value, path);
  return value;
}
`;
}
