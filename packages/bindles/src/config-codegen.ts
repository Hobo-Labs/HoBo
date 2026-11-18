import type { ConfigFieldDef, ConfigSchema } from "./config-schema.js";
import { sensitivityForField } from "./config-sensitivity.js";
import type { JsonObject } from "./json.js";

const RESERVED_IDENTIFIERS = new Set([
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"any",
	"boolean",
	"never",
	"number",
	"object",
	"string",
	"symbol",
	"unknown",
]);

function tsTypeForField(field: ConfigFieldDef): string {
	if (sensitivityForField(field) !== "public") {
		return "`[REDACTED:${string}]` | string";
	}
	switch (field.type) {
		case "boolean":
			return "boolean";
		case "int":
			return "number";
		case "json":
			return "unknown";
		case "string":
			if (field.enumValues && field.enumValues.length > 0) {
				return field.enumValues.map((v) => JSON.stringify(v)).join(" | ");
			}
			return "string";
		default:
			return "unknown";
	}
}

export function generateCtxConfigSource(
	schema: ConfigSchema,
	options?: {
		readonly interfaceName?: string;
		readonly includeSchemaHash?: boolean;
	},
): string {
	const iface = options?.interfaceName ?? "CtxConfig";
	if (
		!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(iface) ||
		RESERVED_IDENTIFIERS.has(iface)
	) {
		throw new TypeError("interfaceName must be a valid TypeScript identifier");
	}
	const lines: string[] = [`export interface ${iface} {`];
	const entries = Object.entries(schema.fields).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	const keys = entries.map(([name]) => name);
	for (const [name, field] of entries) {
		const optional = field.required ? "" : "?";
		lines.push(
			`  readonly ${JSON.stringify(name)}${optional}: ${tsTypeForField(field)};`,
		);
	}
	lines.push("}");
	lines.push("");
	lines.push(
		`export type ${iface}Keys = ${
			keys.length === 0
				? "never"
				: keys.map((k) => JSON.stringify(k)).join(" | ")
		};`,
	);
	if (options?.includeSchemaHash !== false) {
		lines.push(
			`export const ${iface}_SCHEMA_HASH = ${JSON.stringify(schema.schemaHash)} as const;`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

export type GeneratedAgentConfigView = Readonly<Record<string, string>>;

export function materializeAgentConfigView(
	schema: ConfigSchema,
	values: JsonObject,
): GeneratedAgentConfigView {
	const entries: Array<[string, string]> = [];
	for (const [name, field] of Object.entries(schema.fields)) {
		if (sensitivityForField(field) !== "public") {
			entries.push([name, `[REDACTED:${field.source}:${name}]`]);
			continue;
		}
		const value = Object.hasOwn(values, name) ? values[name] : undefined;
		const resolved = value ?? field.defaultValue;
		if (resolved !== undefined) entries.push([name, String(resolved)]);
	}
	return Object.freeze(Object.fromEntries(entries));
}
