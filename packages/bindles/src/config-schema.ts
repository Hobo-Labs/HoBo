/**
 * Secretless-first typed config/secret schema surface (ADR-0027).
 * Schema is the committed layout agents see; values never live in Bindles.
 */

import { createHash } from "node:crypto";
import type { ConfigSensitivity } from "./config-sensitivity.js";
import { sensitivityForField } from "./config-sensitivity.js";
import { isJsonObject, isJsonString, type JsonValue } from "./json.js";

export type { ConfigSensitivity } from "./config-sensitivity.js";

/** Preferred resolution source ranking (highest first). */
export const SECRET_SOURCE_RANKS = [
	"bound-resource",
	"provider-federation",
	"camp-value",
	"static-escape",
] as const;

export type SecretSourceRank = (typeof SECRET_SOURCE_RANKS)[number];

export type ConfigFieldKind = "string" | "boolean" | "int" | "json";

export type ConfigFieldDef = Readonly<{
	kind: "config-field";
	name?: string;
	type: ConfigFieldKind;
	required: boolean;
	sensitive: boolean;
	/** ADR-0142 classification; defaults from sensitive boolean. */
	sensitivity?: ConfigSensitivity;
	defaultValue?: unknown;
	enumValues?: readonly string[];
	min?: number;
	max?: number;
	source: SecretSourceRank;
	/** Static-escape only: max TTL (e.g. "7d"). */
	ttl?: string;
	/** Static-escape only: rotation policy. */
	rotation?: "required" | "optional";
	docs?: string;
}>;

export type ConfigSchema = Readonly<{
	kind: "config-schema";
	schemaVersion: "hobo.config-schema/v1";
	fields: Readonly<Record<string, ConfigFieldDef>>;
	schemaHash: `sha256:${string}`;
}>;

type FieldBuilder = {
	required(): FieldBuilder;
	optional(): FieldBuilder;
	default(value: JsonValue): FieldBuilder;
	enum(values: readonly string[]): FieldBuilder;
	min(n: number): FieldBuilder;
	max(n: number): FieldBuilder;
	source(rank: SecretSourceRank): FieldBuilder;
	ttl(spec: string): FieldBuilder;
	rotation(policy: "required" | "optional"): FieldBuilder;
	docs(text: string): FieldBuilder;
	sensitive(): FieldBuilder;
	/** Materialize the field definition (internal). */
	_build(): ConfigFieldDef;
};

function toConfigFieldDef(raw: FieldBuilder | ConfigFieldDef): ConfigFieldDef {
	if (isJsonObject(raw) && "kind" in raw && raw.kind === "config-field") {
		// SAFETY: config() field objects already carry the field-def kind.
		return raw as ConfigFieldDef;
	}
	// SAFETY: remaining entries are FieldBuilder instances with _build().
	const builder = raw as FieldBuilder;
	return builder._build();
}

function createFieldBuilder(
	type: ConfigFieldKind,
	defaults: { sensitive?: boolean; source?: SecretSourceRank } = {},
): FieldBuilder {
	let required = false;
	let sensitive = defaults.sensitive === true;
	let defaultValue: unknown;
	let enumValues: readonly string[] | undefined;
	let min: number | undefined;
	let max: number | undefined;
	let source: SecretSourceRank = defaults.source ?? "camp-value";
	let ttl: string | undefined;
	let rotation: "required" | "optional" | undefined;
	let docs: string | undefined;

	const builder: FieldBuilder = {
		required() {
			required = true;
			return builder;
		},
		optional() {
			required = false;
			return builder;
		},
		default(value: JsonValue) {
			defaultValue = value;
			return builder;
		},
		enum(values: readonly string[]) {
			enumValues = Object.freeze([...values]);
			return builder;
		},
		min(n: number) {
			min = n;
			return builder;
		},
		max(n: number) {
			max = n;
			return builder;
		},
		source(rank: SecretSourceRank) {
			// SAFETY: assertion required at this I/O or test boundary.
			if (!(SECRET_SOURCE_RANKS as readonly string[]).includes(rank)) {
				throw new TypeError(`unknown secret source rank: ${rank}`);
			}
			source = rank;
			return builder;
		},
		ttl(spec: string) {
			ttl = spec;
			return builder;
		},
		rotation(policy: "required" | "optional") {
			rotation = policy;
			return builder;
		},
		docs(text: string) {
			docs = text;
			return builder;
		},
		sensitive() {
			sensitive = true;
			return builder;
		},
		_build() {
			if (sensitive && source === "camp-value") {
				// Sensitive fields must not default to camp-value (would embed secrets).
				source = "bound-resource";
			}
			if (source === "static-escape") {
				if (!ttl) ttl = "7d";
				if (!rotation) rotation = "required";
				assertTtlAtMost7Days(ttl);
			}
			return Object.freeze({
				kind: "config-field" as const,
				type,
				required,
				sensitive,
				source,
				...(defaultValue !== undefined ? { defaultValue } : undefined),
				...(enumValues !== undefined ? { enumValues } : undefined),
				...(min !== undefined ? { min } : undefined),
				...(max !== undefined ? { max } : undefined),
				...(ttl !== undefined ? { ttl } : undefined),
				...(rotation !== undefined ? { rotation } : undefined),
				...(docs !== undefined ? { docs } : undefined),
			});
		},
	};
	return builder;
}

function assertTtlAtMost7Days(ttl: string): void {
	const match = /^(\d+)d$/.exec(ttl);
	if (!match) {
		throw new TypeError(
			`static-escape ttl must be Nd (days), got ${ttl} (ADR-0023 max 7d)`,
		);
	}
	const days = Number(match[1]);
	if (days > 7) {
		throw new Error(`static-escape ttl ${ttl} exceeds ADR-0023 ceiling of 7d`);
	}
}

/** Non-secret env field builders. */
export const envField = Object.freeze({
	string: () => createFieldBuilder("string", { source: "camp-value" }),
	boolean: () => createFieldBuilder("boolean", { source: "camp-value" }),
	int: () => createFieldBuilder("int", { source: "camp-value" }),
	json: () => createFieldBuilder("json", { source: "camp-value" }),
});

/** Secret field builders (sensitive; prefer bound-resource). */
export const secretField = Object.freeze({
	string: () =>
		createFieldBuilder("string", {
			sensitive: true,
			source: "bound-resource",
		}),
});

/**
 * Declare a typed config schema for a Bindle. Agents see only this shape.
 */
export function config(
	fields: Readonly<Record<string, FieldBuilder | ConfigFieldDef>>,
): ConfigSchema {
	const built: Record<string, ConfigFieldDef> = {};
	for (const [name, raw] of Object.entries(fields)) {
		if (!isJsonString(name) || name.length === 0) {
			throw new TypeError("config field names must be non-empty");
		}
		const def = toConfigFieldDef(raw);
		// Forbid sensitive defaults (plaintext in schema).
		if (def.sensitive && def.defaultValue !== undefined) {
			throw new Error(
				`config field ${name}: sensitive fields cannot have default values (secretless-first)`,
			);
		}
		built[name] = Object.freeze({ ...def, name });
	}
	const sortedKeys = Object.keys(built).sort();
	const canonical = JSON.stringify(
		Object.fromEntries(sortedKeys.map((k) => [k, built[k]])),
	);
	const schemaHash =
		`sha256:${createHash("sha256").update(canonical).digest("hex")}` as const;
	return Object.freeze({
		kind: "config-schema",
		schemaVersion: "hobo.config-schema/v1",
		fields: Object.freeze(built),
		schemaHash,
	});
}

/** Agent-safe view: schema only, no values. */
export function schemaOnlyView(schema: ConfigSchema): Readonly<{
	schemaVersion: string;
	schemaHash: string;
	fields: Readonly<
		Record<
			string,
			{
				type: string;
				required: boolean;
				sensitive: boolean;
				sensitivity: ConfigSensitivity;
				source: string;
				docs?: string;
			}
		>
	>;
}> {
	const fields: Record<
		string,
		{
			type: string;
			required: boolean;
			sensitive: boolean;
			sensitivity: ConfigSensitivity;
			source: string;
			docs?: string;
		}
	> = {};
	for (const [name, f] of Object.entries(schema.fields)) {
		fields[name] = {
			type: f.type,
			required: f.required,
			sensitive: f.sensitive,
			sensitivity: sensitivityForField(f),
			source: f.source,
			...(f.docs !== undefined ? { docs: f.docs } : undefined),
		};
	}
	return Object.freeze({
		schemaVersion: schema.schemaVersion,
		schemaHash: schema.schemaHash,
		fields: Object.freeze(fields),
	});
}

/** Rank comparison: lower index = higher preference. */
export function sourceRankIndex(source: SecretSourceRank): number {
	return SECRET_SOURCE_RANKS.indexOf(source);
}

export function assertSourceAllowed(
	field: ConfigFieldDef,
	allowedRanks: readonly SecretSourceRank[],
): void {
	if (!allowedRanks.includes(field.source)) {
		throw Object.assign(
			new Error(
				`field ${field.name ?? "?"} source ${field.source} forbidden by policy (allowed: ${allowedRanks.join(",")})`,
			),
			{ code: "config-source-denied" },
		);
	}
}

/**
 * Reference binding: declare config comes from a bound resource (secretless).
 */
export function fromBinding(resourceName: string): ConfigFieldDef {
	if (!isJsonString(resourceName) || resourceName.length === 0) {
		throw new TypeError("fromBinding requires a resource name");
	}
	return Object.freeze({
		kind: "config-field",
		type: "string",
		required: true,
		sensitive: true,
		sensitivity: "sensitive" as const,
		source: "bound-resource",
		docs: `bound to resource ${resourceName}`,
		name: resourceName,
	});
}

// Dual `secret` surface (resource factory + field builders) lives in
// secret-surface.ts so it does not clash with catalog.secret(name).
