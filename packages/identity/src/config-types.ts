export type SecretSourceRank =
	| "bound-resource"
	| "provider-federation"
	| "camp-value"
	| "static-escape";

export type ConfigSensitivity = "public" | "internal" | "sensitive";

export type ConfigFieldDef = Readonly<{
	kind: "config-field";
	name?: string;
	type: "string" | "boolean" | "int" | "json";
	required: boolean;
	sensitive: boolean;
	sensitivity?: ConfigSensitivity;
	defaultValue?: unknown;
	enumValues?: readonly string[];
	min?: number;
	max?: number;
	source: SecretSourceRank;
	ttl?: string;
	rotation?: "required" | "optional";
	docs?: string;
}>;

export type ConfigSchema = Readonly<{
	kind: "config-schema";
	schemaVersion: "hobo.config-schema/v1";
	fields: Readonly<Record<string, ConfigFieldDef>>;
	schemaHash: `sha256:${string}`;
}>;

export function configSensitivity(field: {
	readonly sensitive?: boolean;
	readonly sensitivity?: ConfigSensitivity;
}): ConfigSensitivity {
	if (field.sensitive !== undefined && field.sensitive !== false)
		return "sensitive";
	if (field.sensitivity === undefined) return "public";
	if (
		field.sensitivity === "public" ||
		field.sensitivity === "internal" ||
		field.sensitivity === "sensitive"
	)
		return field.sensitivity;
	return "sensitive";
}
