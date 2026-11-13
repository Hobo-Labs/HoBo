import {
	type AppendOptions,
	EVENTSTORE_LIMITS,
	type EventInput,
	type JsonObject,
	type JsonValue,
	type PrincipalRef,
} from "@hobo/core";
import { StoragePostgresError } from "./errors.js";
import {
	isJsonBigInt,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	parseJsonText,
} from "./json.js";

/** Largest value an int8 column holds; fence tokens and positions above it are refused. */
export const MAX_INT8 = (1n << 63n) - 1n;

/** One event input after parsing: JSON-clean, size-checked, key extracted. */
export type ParsedEventInput = Readonly<{
	type: string;
	v: number;
	data: JsonValue;
	meta: JsonObject;
	/** Canonical JSON text of `data` / `meta` as stored. */
	dataText: string;
	metaText: string;
	idempotencyKey: string | undefined;
}>;

/** Append options after parsing. */
export type ParsedAppend = Readonly<{
	expectedSeq: number;
	actor: PrincipalRef;
	tenant: string;
	project: string | undefined;
	causationId: string | undefined;
	correlationId: string | undefined;
	lane: string | undefined;
	fenceToken: bigint | undefined;
}>;

function invalid(message: string): StoragePostgresError {
	return new StoragePostgresError("invalid-input", message);
}

export function requireNonEmpty<T>(value: T, field: string): string {
	if (!isJsonString(value) || value.length === 0) {
		throw invalid(`${field} must be a non-empty string`);
	}
	return value;
}

export function requireNonNegInt<T>(value: T, field: string): number {
	if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value < 0) {
		throw invalid(`${field} must be a non-negative safe integer`);
	}
	return value;
}

export function requireInt8<T>(value: T, field: string): bigint {
	let parsed: bigint;
	if (isJsonBigInt(value)) parsed = value;
	else if (isJsonNumber(value) && Number.isSafeInteger(value))
		parsed = BigInt(value);
	else if (isJsonString(value) && /^(0|[1-9][0-9]*)$/u.test(value))
		parsed = BigInt(value);
	else throw invalid(`${field} must be a non-negative integer`);
	if (parsed < 0n || parsed > MAX_INT8) {
		throw invalid(`${field} must be within 0..${MAX_INT8}`);
	}
	return parsed;
}

function optionalText<T>(value: T, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isJsonString(value)) throw invalid(`${field} must be a string`);
	return value;
}

/** Canonical JSON text of a caller value, bounded in bytes. */
function canonicalText<T>(value: T, field: string, maxBytes: number): string {
	let text: string | undefined;
	try {
		text = JSON.stringify(value ?? {});
	} catch {
		text = undefined;
	}
	if (text === undefined) throw invalid(`${field} must be JSON-serialisable`);
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		throw invalid(`${field} exceeds ${maxBytes} bytes`);
	}
	return text;
}

function parseEventInput(event: EventInput, index: number): ParsedEventInput {
	if (!isJsonObject(event)) throw invalid(`events[${index}] must be an object`);
	const type = requireNonEmpty(event.type, `events[${index}].type`);
	const v = event.v ?? 1;
	if (!isJsonNumber(v) || !Number.isSafeInteger(v) || v <= 0) {
		throw invalid(`events[${index}].v must be a positive safe integer`);
	}
	const dataText = canonicalText(
		event.data ?? {},
		`events[${index}].data`,
		EVENTSTORE_LIMITS.maxPayloadBytes,
	);
	const metaText = canonicalText(
		event.meta ?? {},
		`events[${index}].meta`,
		EVENTSTORE_LIMITS.maxMetadataBytes,
	);
	const data = parseJsonText(dataText) ?? null;
	const meta = parseJsonText(metaText);
	if (!isJsonObject(meta)) {
		throw invalid(`events[${index}].meta must be an object`);
	}
	const key = meta.idempotencyKey;
	return Object.freeze({
		type,
		v,
		data,
		meta,
		dataText,
		metaText,
		idempotencyKey: isJsonString(key) && key.length > 0 ? key : undefined,
	});
}

export function parseEventInputs(
	events: readonly EventInput[],
): readonly ParsedEventInput[] {
	if (!Array.isArray(events)) throw invalid("events must be an array");
	if (events.length > EVENTSTORE_LIMITS.maxBatchEvents) {
		throw invalid(
			`events batch exceeds maxBatchEvents=${EVENTSTORE_LIMITS.maxBatchEvents}`,
		);
	}
	return events.map(parseEventInput);
}

function parseActor(actor: PrincipalRef): PrincipalRef {
	if (
		!isJsonObject(actor) ||
		!isJsonString(actor.kind) ||
		!isJsonString(actor.id) ||
		actor.id.length === 0
	) {
		throw invalid("actor must be a principal reference { kind, id }");
	}
	return actor;
}

export function parseAppendOptions(opts: AppendOptions): ParsedAppend {
	if (!isJsonObject(opts)) throw invalid("append options must be an object");
	return Object.freeze({
		expectedSeq: requireNonNegInt(opts.expectedSeq, "expectedSeq"),
		actor: parseActor(opts.actor),
		tenant: requireNonEmpty(opts.tenant, "tenant"),
		project: optionalText(opts.project, "project"),
		causationId: optionalText(opts.causationId, "causationId"),
		correlationId: optionalText(opts.correlationId, "correlationId"),
		lane: optionalText(opts.lane, "lane"),
		fenceToken:
			opts.fenceToken === undefined
				? undefined
				: requireInt8(opts.fenceToken, "fenceToken"),
	});
}

/** Lease TTL from the caller, bounded to (0, 24 h]. */
export function parseLeaseTtl(
	value: number | undefined,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (
		!isJsonNumber(value) ||
		!Number.isSafeInteger(value) ||
		value <= 0 ||
		value > 86_400_000
	) {
		throw invalid("leaseTtlMs must be a positive integer of at most 24 h");
	}
	return value;
}
