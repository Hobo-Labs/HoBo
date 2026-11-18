import {
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export type AgentConfigFieldView = Readonly<{
	type: "string" | "boolean" | "int" | "json";
	required: boolean;
	sensitive: boolean;
	sensitivity: "public" | "internal" | "sensitive";
	source:
		| "bound-resource"
		| "provider-federation"
		| "camp-value"
		| "static-escape";
}>;

export type AgentConfigFieldInput = Readonly<{
	type: JsonValue;
	required: JsonValue;
	sensitive?: JsonValue;
	sensitivity?: JsonValue;
	source: JsonValue;
}>;

export type AgentConfigSchemaInput = Readonly<{
	schemaVersion: JsonValue;
	schemaHash: JsonValue;
	fields: Readonly<Record<string, AgentConfigFieldInput>>;
}>;

export type AgentConfigSchemaView = Readonly<{
	schemaVersion: string;
	schemaHash: string;
	fields: Readonly<Record<string, AgentConfigFieldView>>;
}>;

function requiredString(value: JsonValue | undefined, name: string): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return value;
}

function fieldType(value: JsonValue | undefined): AgentConfigFieldView["type"] {
	switch (value) {
		case "string":
		case "boolean":
		case "int":
		case "json":
			return value;
		default:
			throw new TypeError("config field type is invalid");
	}
}

function fieldSource(
	value: JsonValue | undefined,
): AgentConfigFieldView["source"] {
	switch (value) {
		case "bound-resource":
		case "provider-federation":
		case "camp-value":
		case "static-escape":
			return value;
		default:
			throw new TypeError("config field source is invalid");
	}
}

function fieldSensitivity(
	field: AgentConfigFieldInput & JsonObject,
): AgentConfigFieldView["sensitivity"] {
	if (field.sensitive !== false) return "sensitive";
	switch (field.sensitivity) {
		case undefined:
		case "public":
			return "public";
		case "internal":
			return "internal";
		case "sensitive":
			return "sensitive";
		default:
			return "sensitive";
	}
}

function fieldView(field: AgentConfigFieldInput): AgentConfigFieldView {
	if (!isJsonObject(field))
		throw new TypeError("config field must be an object");
	if (!isJsonBoolean(field.required)) {
		throw new TypeError("config field required must be boolean");
	}
	const sensitivity = fieldSensitivity(field);
	return Object.freeze({
		type: fieldType(field.type),
		required: field.required,
		sensitive: sensitivity === "sensitive",
		sensitivity,
		source: fieldSource(field.source),
	});
}

export function createAgentConfigSchemaView(
	schema: AgentConfigSchemaInput,
): AgentConfigSchemaView {
	if (!isJsonObject(schema))
		throw new TypeError("config schema must be an object");
	if (!isJsonObject(schema.fields)) {
		throw new TypeError("config schema fields must be an object");
	}
	const fields: Record<string, AgentConfigFieldView> = {};
	for (const [name, field] of Object.entries(schema.fields)) {
		Object.defineProperty(fields, name, {
			value: fieldView(field),
			enumerable: true,
		});
	}
	return Object.freeze({
		schemaVersion: requiredString(
			schema.schemaVersion,
			"config schema version",
		),
		schemaHash: requiredString(schema.schemaHash, "config schema hash"),
		fields: Object.freeze(fields),
	});
}
