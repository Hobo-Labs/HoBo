/**
 * Parsers for the executor port's request records.
 *
 * The port is in-process, but its requests are plain JSON on purpose: a host
 * may put an executor behind a worker, a sidecar, or an HTTP hop, and the
 * pact replays requests straight from a file. Whatever arrives as JSON
 * crosses one parser here and becomes the typed request the port accepts —
 * an unknown operation kind or a missing bound is refused, not guessed at.
 */
import type { JsonObject, JsonValue } from "@hobo/data-core";
import { MongoDataError } from "./errors.js";
import type {
	MongoAwaitTransactionsRequest,
	MongoBulkWriteRequest,
	MongoChangeHeadRequest,
	MongoChangeReadRequest,
	MongoEnsureCollectionRequest,
	MongoFindRequest,
	MongoIdRange,
	MongoIdSelector,
	MongoWriteOperation,
} from "./executor.js";
import type { MongoDocument } from "./extended-json.js";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "./json.js";

function invalid(message: string, field: string): never {
	throw new MongoDataError("MONGODB_INVALID_REQUEST", message, {
		detail: { field },
	});
}

function record(value: JsonValue | undefined, field: string): JsonObject {
	return isJsonObject(value)
		? value
		: invalid(`${field} must be an object`, field);
}

function text(value: JsonValue | undefined, field: string): string {
	return isJsonString(value) && value !== ""
		? value
		: invalid(`${field} must be a non-empty string`, field);
}

/**
 * A collection the port may address: a dataset's (an identifier) or the
 * metadata collection (`_` then an identifier). Never `system.*`, never a
 * name with a dot, a `$`, or a NUL.
 */
function collectionName(value: JsonValue | undefined): string {
	return isJsonString(value) && /^[a-z_][a-z0-9_]{0,62}$/u.test(value)
		? value
		: invalid(
				"collection must be a lowercase identifier, optionally starting with `_`",
				"collection",
			);
}

/** A dotted path of plain field names — never an operator. */
function keyPath(value: JsonValue | undefined): string {
	return isJsonString(value) &&
		/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/u.test(value)
		? value
		: invalid("where.path must be a dotted path of field names", "where.path");
}

function count(value: JsonValue | undefined, field: string): number {
	return isJsonNumber(value) && Number.isInteger(value) && value >= 1
		? value
		: invalid(`${field} must be a positive integer`, field);
}

function document(value: JsonValue | undefined, field: string): MongoDocument {
	const parsed = record(value, field);
	if (parsed._id === undefined) invalid(`${field} must carry an _id`, field);
	return parsed;
}

/** The two optional bounds of a range, kept absent when absent. */
function bounds(value: JsonObject): Omit<MongoIdRange, "kind"> {
	return {
		...(value.after === undefined ? undefined : { after: value.after }),
		...(value.before === undefined ? undefined : { before: value.before }),
	};
}

function selector(
	value: JsonValue | undefined,
	field: string,
): MongoIdSelector {
	const parsed = record(value, field);
	if (parsed.kind === "ids") {
		return isJsonArray(parsed.ids)
			? { kind: "ids", ids: parsed.ids }
			: invalid(`${field}.ids must be an array`, `${field}.ids`);
	}
	if (parsed.kind === "range") return { kind: "range", ...bounds(parsed) };
	return invalid(`${field}.kind must be ids or range`, `${field}.kind`);
}

function operation(value: JsonValue, field: string): MongoWriteOperation {
	const parsed = record(value, field);
	switch (parsed.kind) {
		case "insert":
		case "replace":
			return {
				kind: parsed.kind,
				document: document(parsed.document, `${field}.document`),
			};
		case "delete":
			return parsed.id === undefined
				? invalid(`${field}.id is required`, `${field}.id`)
				: { kind: "delete", id: parsed.id };
		case "deleteRange":
			return { kind: "deleteRange", ...bounds(parsed) };
		default:
			return invalid(
				`${field}.kind must be insert, replace, delete, or deleteRange`,
				`${field}.kind`,
			);
	}
}

export function parseEnsureCollectionRequest(
	value: JsonValue | undefined,
): MongoEnsureCollectionRequest {
	const parsed = record(value, "request");
	const { validator, changeImages } = parsed;
	if (!isJsonBoolean(changeImages)) {
		invalid("changeImages must be a boolean", "changeImages");
	}
	return {
		collection: collectionName(parsed.collection),
		changeImages,
		...(validator === undefined
			? undefined
			: { validator: record(validator, "validator") }),
	};
}

export function parseFindRequest(
	value: JsonValue | undefined,
): MongoFindRequest {
	const parsed = record(value, "request");
	return {
		collection: collectionName(parsed.collection),
		select: selector(parsed.select, "select"),
		...(parsed.limit === undefined
			? undefined
			: { limit: count(parsed.limit, "limit") }),
	};
}

export function parseBulkWriteRequest(
	value: JsonValue | undefined,
): MongoBulkWriteRequest {
	const parsed = record(value, "request");
	if (!isJsonArray(parsed.operations)) {
		invalid("operations must be an array", "operations");
	}
	return {
		collection: collectionName(parsed.collection),
		operations: parsed.operations.map((entry, index) =>
			operation(entry, `operations[${index}]`),
		),
	};
}

export function parseChangeHeadRequest(
	value: JsonValue | undefined,
): MongoChangeHeadRequest {
	return {
		collection: collectionName(record(value, "request").collection),
	};
}

export function parseChangeReadRequest(
	value: JsonValue | undefined,
): MongoChangeReadRequest {
	const parsed = record(value, "request");
	const where =
		parsed.where === undefined ? undefined : record(parsed.where, "where");
	return {
		collection: collectionName(parsed.collection),
		after: text(parsed.after, "after"),
		limit: count(parsed.limit, "limit"),
		...(where === undefined
			? undefined
			: {
					where: {
						path: keyPath(where.path),
						equals:
							where.equals ??
							invalid("where.equals is required", "where.equals"),
					},
				}),
	};
}

export function parseAwaitTransactionsRequest(
	value: JsonValue | undefined,
): MongoAwaitTransactionsRequest {
	return {
		collection: collectionName(record(value, "request").collection),
	};
}
