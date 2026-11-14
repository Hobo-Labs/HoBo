/**
 * Provider-side replay of a PACT v3 file (L42): the interaction shapes the
 * consumer pact holds, and the matching rules it uses (`$.body` by `type`,
 * `$.headers.<name>` by `regex`), applied as PACT v3 applies them.
 *
 * - `type`: a value matches when it has the expected JSON type; an object
 *   must hold every expected key (extra keys allowed), each matched by type;
 *   an array matches element by element against the expected element at that
 *   index, else the first. An empty actual array never matches an expected
 *   non-empty one, so an example list is never satisfied vacuously.
 * - `regex`: the whole value matches the pattern.
 * - A value with no rule matches only when equal.
 * - Header values compare as media types: the same type, and every parameter
 *   the pact names present with the same value (`application/json` matches
 *   `application/json; charset=utf-8`).
 *
 * `@hobo/contract-harness`'s `verifyPact` compares bodies as value subsets
 * and ignores matching rules, so it cannot verify this pact: its examples are
 * matched by type, not value.
 */
import type { JsonObject, JsonValue } from "@hobo/core";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	stringField,
} from "../../src/ops/json.js";

// domain-view: header values of a pact request or response, by header name.
export type PactHeaders = Readonly<Record<string, string>>;

// domain-view: the matching rules of a pact request or response, by JSON path.
export type PactRules = Readonly<Record<string, PactRule>>;

// domain-view: the request half of a PACT v3 interaction, parsed from the pact file.
export type PactRequest = Readonly<{
	method: string;
	path: string;
	query: string;
	headers: PactHeaders;
	body: JsonValue | undefined;
	rules: PactRules;
}>;

// domain-view: the response half of a PACT v3 interaction, parsed from the pact file.
export type PactResponse = Readonly<{
	status: number;
	headers: PactHeaders;
	body: JsonValue | undefined;
	rules: PactRules;
}>;

// domain-view: one PACT v3 interaction, parsed from the pact file.
export type PactInteraction = Readonly<{
	description: string;
	providerState: string;
	request: PactRequest;
	response: PactResponse;
}>;

export type PactRule =
	| Readonly<{ match: "type" }>
	| Readonly<{ match: "regex"; regex: string }>;

// domain-view: a parsed PACT v3 document.
export type PactDocument = Readonly<{
	consumer: string;
	provider: string;
	interactions: readonly PactInteraction[];
}>;

/** A media type and its parameters, for comparing header values. */
type MediaType = Readonly<{
	type: string;
	parameters: ReadonlyMap<string, string>;
}>;

const tagOf = Object.prototype.toString;
const isJsonBoolean = (value: JsonValue): boolean =>
	tagOf.call(value) === "[object Boolean]";

function stringsOf(value: JsonValue | undefined): PactHeaders {
	if (!isJsonObject(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, entry]) =>
			isJsonString(entry) ? [[key, entry]] : [],
		),
	);
}

function ruleOf(path: string, rule: JsonValue): PactRule {
	if (!isJsonObject(rule)) throw new Error(`rule ${path} is not an object`);
	const match = stringField(rule, "match");
	const regex = stringField(rule, "regex");
	if (match === "type") return { match: "type" };
	if (match === "regex" && regex !== undefined)
		return { match: "regex", regex };
	throw new Error(`rule ${path} uses an unsupported matcher`);
}

function rulesOf(value: JsonValue | undefined): PactRules {
	if (!isJsonObject(value)) return {};
	return Object.fromEntries(
		Object.entries(value).map(([path, rule]) => [path, ruleOf(path, rule)]),
	);
}

function objectField(object: JsonObject, key: string): JsonObject {
	const value = object[key];
	if (!isJsonObject(value)) throw new Error(`${key} is not an object`);
	return value;
}

/** Parses a PACT v3 document's interactions; throws on anything this replay does not support. */
export function parsePact(text: string): PactDocument {
	const document: JsonValue = JSON.parse(text);
	if (!isJsonObject(document)) throw new Error("the pact is not an object");
	const version = stringField(
		objectField(objectField(document, "metadata"), "pactSpecification"),
		"version",
	);
	if (version !== "3.0.0") throw new Error(`pact specification ${version}`);
	const interactions = document.interactions;
	if (!isJsonArray(interactions)) throw new Error("no interactions");
	return {
		consumer: stringField(objectField(document, "consumer"), "name") ?? "",
		provider: stringField(objectField(document, "provider"), "name") ?? "",
		interactions: interactions.map((entry) => {
			if (!isJsonObject(entry))
				throw new Error("an interaction is not an object");
			const request = objectField(entry, "request");
			const response = objectField(entry, "response");
			const status = response.status;
			if (!isJsonNumber(status)) throw new Error("a response has no status");
			return {
				description: stringField(entry, "description") ?? "",
				providerState: stringField(entry, "providerState") ?? "",
				request: {
					method: stringField(request, "method") ?? "",
					path: stringField(request, "path") ?? "",
					query: stringField(request, "query") ?? "",
					headers: stringsOf(request.headers),
					body: request.body,
					rules: rulesOf(request.matchingRules),
				},
				response: {
					status,
					headers: stringsOf(response.headers),
					body: response.body,
					rules: rulesOf(response.matchingRules),
				},
			};
		}),
	};
}

function kindOf(value: JsonValue): string {
	if (value === null) return "null";
	if (isJsonArray(value)) return "array";
	if (isJsonObject(value)) return "object";
	if (isJsonString(value)) return "string";
	if (isJsonNumber(value)) return "number";
	return isJsonBoolean(value) ? "boolean" : "unknown";
}

/** Where `actual` fails to match `expected` by type, or undefined when it matches. */
export function typeMismatch(
	expected: JsonValue,
	actual: JsonValue | undefined,
	path: string,
): string | undefined {
	if (actual === undefined) return `${path} is missing`;
	if (kindOf(expected) !== kindOf(actual))
		return `${path} is a ${kindOf(actual)}, not a ${kindOf(expected)}`;
	if (isJsonArray(expected) && isJsonArray(actual)) {
		if (expected.length > 0 && actual.length === 0) return `${path} is empty`;
		for (const [index, item] of actual.entries()) {
			const template = expected[index] ?? expected[0];
			if (template === undefined) continue;
			const nested = typeMismatch(template, item, `${path}[${index}]`);
			if (nested !== undefined) return nested;
		}
		return undefined;
	}
	if (isJsonObject(expected) && isJsonObject(actual)) {
		for (const [key, value] of Object.entries(expected)) {
			const nested = typeMismatch(value, actual[key], `${path}.${key}`);
			if (nested !== undefined) return nested;
		}
	}
	return undefined;
}

/** A body checked against the pact's `$.body` rule: by type, else by equality. */
export function bodyMismatch(
	expected: JsonValue | undefined,
	actual: JsonValue | undefined,
	rules: PactRules,
): string | undefined {
	if (expected === undefined) return undefined;
	if (rules["$.body"]?.match === "type")
		return typeMismatch(expected, actual, "$.body");
	return JSON.stringify(expected) === JSON.stringify(actual)
		? undefined
		: "$.body differs";
}

function mediaType(value: string): MediaType {
	const [type = "", ...parameters] = value
		.split(";")
		.map((part) => part.trim());
	return {
		type: type.toLowerCase(),
		parameters: new Map(
			parameters.map((parameter) => {
				const [key = "", entry = ""] = parameter.split("=");
				return [key.trim().toLowerCase(), entry.trim()];
			}),
		),
	};
}

/** A header the pact names, checked against the value sent or answered. */
export function headerMismatch(
	name: string,
	expected: string,
	actual: string | null,
	rules: PactRules,
): string | undefined {
	if (actual === null) return `header ${name} is missing`;
	const rule = rules[`$.headers.${name}`];
	if (rule?.match === "regex")
		return new RegExp(rule.regex, "u").test(actual)
			? undefined
			: `header ${name} does not match ${rule.regex}`;
	const want = mediaType(expected);
	const have = mediaType(actual);
	if (want.type !== have.type)
		return `header ${name} is ${actual}, not ${expected}`;
	for (const [key, value] of want.parameters)
		if (have.parameters.get(key) !== value)
			return `header ${name} lacks ${key}=${value}`;
	return undefined;
}
