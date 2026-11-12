#!/usr/bin/env node
/**
 * Print the relay deploy workflow's secret-store verify envelope to the job
 * summary and annotate failures. Never prints JWTs or secret values.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [jsonPath, stderrPath = "", exitArg = "0"] = process.argv.slice(2);
const exitCode = Number.parseInt(exitArg, 10);

type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| JsonObject;
interface JsonObject {
	readonly [key: string]: JsonValue;
}

const tagOf = Object.prototype.toString;

function asObject(value: JsonValue | undefined): JsonObject | undefined {
	// SAFETY: the tag check proves a plain object, which JSON.parse only produces as a JsonObject.
	return tagOf.call(value) === "[object Object]"
		? (value as JsonObject)
		: undefined;
}

function asText(value: JsonValue | undefined): string | undefined {
	// SAFETY: the tag check proves a string primitive.
	return tagOf.call(value) === "[object String]"
		? (value as string)
		: undefined;
}

function asList(value: JsonValue | undefined): readonly JsonValue[] {
	return Array.isArray(value) ? value : [];
}

function redactNoise(text: string): string {
	return text
		.replaceAll(/bearer\s+[A-Za-z0-9._~+/=-]+/giu, "bearer [redacted]")
		.replaceAll(
			/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu,
			"[jwt redacted]",
		)
		.trim();
}

function parseEnvelopeRoot(raw: string): JsonObject | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	try {
		const value: unknown = JSON.parse(trimmed);
		// SAFETY: asObject accepts only JsonValue trees; unknown from JSON.parse is narrowed by the tag check inside.
		return asObject(value as JsonValue);
	} catch {
		return undefined;
	}
}

const stdoutRaw = existsSync(jsonPath) ? readFileSync(jsonPath, "utf8") : "";
const stderrRaw =
	stderrPath !== "" && existsSync(stderrPath)
		? readFileSync(stderrPath, "utf8")
		: "";
const envelope = parseEnvelopeRoot(stdoutRaw);

const lines = ["### Secret store connection", ""];
if (envelope !== undefined) {
	const data = asObject(envelope.data);
	const checks = asList(data?.checks);
	for (const entry of checks) {
		const check = asObject(entry);
		if (check === undefined) continue;
		const identity = asText(check.identity) ?? "identity";
		const method = asText(check.method) ?? "method";
		const result = asText(check.result) ?? "unknown";
		const detail = asText(check.detail) ?? "";
		lines.push(`- ${identity} (${method}): ${result} — ${detail}`);
	}
	if (lines.length === 2) {
		const code = asText(envelope.code) ?? "unknown";
		const message = asText(envelope.message) ?? "(no message)";
		lines.push(`- ${code}: ${message}`);
	}
} else {
	lines.push(
		"- HOBO_CI_SECRET_STORE_VERIFY_NO_ENVELOPE: verify did not emit JSON on stdout",
	);
	const stderr = redactNoise(stderrRaw);
	if (stderr !== "") lines.push(`- stderr: ${stderr.split("\n")[0]}`);
}

const summary = lines.join("\n");
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n`);
}
console.log(summary);

const headline =
	envelope !== undefined
		? `${asText(envelope.code) ?? "HOBO_CI_SECRET_STORE_VERIFY_FAILED"}: ${(asText(envelope.message) ?? "verify failed").split("\n")[0]}`
		: "HOBO_CI_SECRET_STORE_VERIFY_NO_ENVELOPE: verify produced no JSON envelope";

if (exitCode !== 0) {
	const escaped = headline.replaceAll("%", "%25").replaceAll("\r", "%0D");
	console.log(`::error title=Secret store verify::${escaped}`);
}

process.exit(Number.isFinite(exitCode) ? exitCode : 1);
