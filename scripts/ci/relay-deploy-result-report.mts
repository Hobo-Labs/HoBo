#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { redactRelayDeployText } from "./relay-deploy-redaction.mts";

const [jsonPath, label, stderrPath = "", exitArg] = process.argv.slice(2);
if (jsonPath === undefined || label === undefined || exitArg === undefined)
	throw new Error(
		"usage: relay-deploy-result-report.mts <json> <label> [stderr] <status>",
	);

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

function isObject(value: JsonValue | undefined): value is JsonObject {
	return tagOf.call(value) === "[object Object]";
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
	return isObject(value) ? value : undefined;
}

function isText(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}

function asText(value: JsonValue | undefined): string | undefined {
	return isText(value) ? value : undefined;
}

function parseEnvelope(raw: string): JsonObject | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	let root: JsonValue | undefined;
	try {
		root = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	const envelope = asObject(root);
	if (envelope === undefined || tagOf.call(envelope.ok) !== "[object Boolean]")
		return undefined;
	for (const key of ["code", "message"])
		if (
			envelope[key] !== undefined &&
			tagOf.call(envelope[key]) !== "[object String]"
		)
			return undefined;
	return envelope;
}

const envelope = parseEnvelope(
	existsSync(jsonPath) ? readFileSync(jsonPath, "utf8") : "",
);
const exitCode = Number(exitArg);
const validExitCode =
	exitArg.trim() !== "" &&
	Number.isInteger(exitCode) &&
	exitCode >= 0 &&
	exitCode <= 255;
const code =
	asText(envelope?.code) ??
	(envelope === undefined
		? "HOBO_CI_DEPLOY_NO_ENVELOPE"
		: envelope.ok
			? "HOBO_OK"
			: "HOBO_FAILED_WITHOUT_CODE");
const message =
	asText(envelope?.message) ??
	(envelope === undefined ? "command did not emit a valid JSON envelope" : "");
console.log(
	`${label}: ${redactRelayDeployText(code, 4096)}: ${redactRelayDeployText(message, 4096)}`,
);
const stderr =
	stderrPath !== "" && existsSync(stderrPath)
		? readFileSync(stderrPath, "utf8")
		: "";
if (stderr !== "") console.log(redactRelayDeployText(stderr, 4096));
process.exitCode =
	validExitCode && envelope?.ok === true
		? exitCode
		: validExitCode && exitCode > 0
			? exitCode
			: 1;
