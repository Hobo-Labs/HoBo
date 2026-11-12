/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: the output boundary serializes command data (protobuf records, bigints, plain JSON) to the CLI/MCP envelope; values are only classified to choose an encoding, never trusted as a domain type. */
/**
 * Rendering for `hobo deploy` CD subcommands (WP18, plan 0024).
 *
 * One structure for every caller: a human at a terminal, an agent through
 * MCP and a script with `--json` all receive the same envelope `data`
 * (records as canonical protobuf JSON). `--format text|json` changes only the
 * human `message`, never `data`. Every refusal carries a stable code and a
 * next step (`remediation`).
 */

import {
	createRegistry,
	type DescMessage,
	isMessage,
	type Message,
	toJson,
} from "@bufbuild/protobuf";
import { file_cd, type ReasonRecord } from "@hobo/cd";
import type { CommandResult } from "@hobo/cli";
import { isJsonString, type JsonObject, type JsonValue } from "./json.js";

export type CdFormat = "json" | "text";

const registry = createRegistry(file_cd);

/**
 * The flags a CD command reads: the shell's flags with the options its
 * subcommand declares (`@hobo/cli` subcommands.ts) merged by name. Callers
 * that pass a plain flag object (tests, MCP fakes) get it unchanged.
 */
export function cdFlagsOf(flags: unknown): JsonObject {
	// SAFETY: CommandRunInput flags; members are read by name and narrowed by the subcommand.
	const base = flags as JsonObject;
	const declared = base.subcommandOptions;
	if (
		declared === null ||
		typeof declared !== "object" ||
		Array.isArray(declared)
	)
		return base;
	return {
		...base,
		...Object.fromEntries(
			Object.entries(declared).filter(
				([, value]) => value === true || isJsonString(value),
			),
		),
	};
}

/** `--format json|text`; `--json` implies json. Unknown values are a usage error. */
export function parseCdFormat(
	flags: JsonObject,
): { ok: true; format: CdFormat } | { ok: false; value: string } {
	const raw = flags.format;
	if (raw === undefined || raw === null || raw === "")
		return { ok: true, format: flags.json === true ? "json" : "text" };
	if (raw === "json" || raw === "text") return { ok: true, format: raw };
	return { ok: false, value: isJsonString(raw) ? raw : String(raw) };
}

function isProto(value: unknown): value is Message {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { $typeName?: unknown }).$typeName === "string"
	);
}

/**
 * Any value → JSON: protobuf records become canonical JSON (enum names,
 * 64-bit integers as strings), bigints become decimal strings, `undefined`
 * members are dropped.
 */
export function cdWire(value: unknown): JsonValue {
	if (value === null || value === undefined) return null;
	if (typeof value === "bigint") return value.toString();
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	)
		return value;
	if (Array.isArray(value)) return value.map(cdWire);
	if (isProto(value)) {
		const schema = registry.getMessage(value.$typeName);
		if (schema && isMessage(value, schema as DescMessage))
			// SAFETY: toJson emits JSON values only.
			return toJson(schema, value, { alwaysEmitImplicit: false }) as JsonValue;
	}
	if (typeof value === "object") {
		const out: Record<string, JsonValue> = {};
		for (const [key, member] of Object.entries(value)) {
			if (member === undefined || typeof member === "function") continue;
			out[key] = cdWire(member);
		}
		return out;
	}
	return String(value);
}

function textOf(value: JsonValue, indent = ""): string {
	if (value === null) return "-";
	if (typeof value !== "object") return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return "(none)";
		return value
			.map((item) => `${indent}- ${textOf(item, `${indent}  `).trimStart()}`)
			.join("\n");
	}
	const entries = Object.entries(value);
	if (entries.length === 0) return "(empty)";
	return entries
		.map(([key, member]) =>
			member !== null && typeof member === "object"
				? `${indent}${key}:\n${textOf(member, `${indent}  `)}`
				: `${indent}${key}: ${textOf(member)}`,
		)
		.join("\n");
}

/** A successful CD subcommand result. `data` is identical for every format. */
export function cdOk(
	input: Readonly<{
		code: string;
		summary: string;
		data: Readonly<Record<string, unknown>>;
		format: CdFormat;
	}>,
): CommandResult {
	const data = cdWire(input.data);
	return {
		ok: true,
		status: "ok",
		code: input.code,
		message:
			input.format === "text"
				? `${input.summary}\n${textOf(data)}`
				: input.summary,
		// SAFETY: cdWire of a record is a JSON object.
		data: data as JsonObject,
	};
}

/** A refusal: stable code, every reason, and a next step for each. */
export function cdRefused(
	input: Readonly<{
		reasons: readonly ReasonRecord[];
		subcommand: string;
		format: CdFormat;
	}>,
): CommandResult {
	const first = input.reasons[0];
	const code = first?.code || "cd-refused";
	const remediation = input.reasons
		.map((r) => r.remediation)
		.filter((r) => r !== "");
	const message = `hobo deploy ${input.subcommand}: refused (${code})${first?.message ? `: ${first.message}` : ""}`;
	return {
		ok: false,
		status: "refused",
		code,
		message:
			input.format === "text" && remediation.length > 0
				? `${message}\nnext: ${remediation.join("\nnext: ")}`
				: message,
		remediation:
			remediation.length > 0
				? remediation
				: [`hobo deploy ${input.subcommand} --help`],
		data: {
			command: "deploy",
			subcommand: input.subcommand,
			reasons: cdWire(input.reasons),
		},
	};
}

/** A usage error, with the usage lines as the next step. */
export function cdUsage(
	input: Readonly<{
		code: string;
		message: string;
		usage: readonly string[];
		subcommand: string;
	}>,
): CommandResult {
	return {
		ok: false,
		status: "usage",
		code: input.code,
		message: `hobo deploy ${input.subcommand}: ${input.message}`,
		remediation: [...input.usage],
		data: { command: "deploy", subcommand: input.subcommand },
	};
}
