import type { PrincipalRef } from "@hobo/core";
import { parseEventEnvelope } from "@hobo/core";
import {
	cloneAsJson,
	isJsonBigInt,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../json.js";

export type ParsedStreamId = string & { readonly __brand: "ParsedStreamId" };

export type ParsedExpectedSeq = number & {
	readonly __brand: "ParsedExpectedSeq";
};

export interface ParsedEventInput {
	readonly type: string;
	readonly v: number;
	readonly data: JsonValue;
	readonly meta: JsonObject;
	readonly idempotencyKey?: string | undefined;
}

export interface ParsedAppendContext {
	readonly streamId: ParsedStreamId;
	readonly expectedSeq: ParsedExpectedSeq;
	readonly actor: PrincipalRef;
	readonly tenant: string;
	readonly project?: string | undefined;
	readonly causationId?: string | undefined;
	readonly correlationId?: string | undefined;
	readonly lane?: string | undefined;
	readonly fenceToken?: bigint | undefined;
}

export function parseStreamId(value: JsonValue): ParsedStreamId {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError("streamId must be a non-empty string");
	}
	// SAFETY: assertion to `value as ParsedStreamId` is required at this boundary.
	return value as ParsedStreamId;
}

export function parseExpectedSeq(
	value: JsonValue | undefined,
	fieldName = "expectedSeq",
): ParsedExpectedSeq {
	if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${fieldName} must be a non-negative safe integer`);
	}
	// SAFETY: non-negative safe integers are branded expected seqs.
	return value as ParsedExpectedSeq;
}

export function parseEventInput<T>(value: T): ParsedEventInput {
	if (!isJsonObject(value)) {
		throw new TypeError("event must be an object");
	}
	const type = requireNonEmptyString(value.type, "event.type");
	const v = normalizeVersion(value.v ?? 1);
	const metaJson = isJsonObject(value.meta) ? value.meta : {};
	const meta = Object.freeze(cloneJson(metaJson));
	const idempotencyKey = optionalString(
		meta.idempotencyKey,
		"event.meta.idempotencyKey",
	);
	return Object.freeze({
		type,
		v,
		// `{}`, not `null`: this default is persisted. Events already on disk
		// carry `{}` for absent data, and a consumer reading `event.data.x`
		// throws on `null` where it merely reads `undefined` on `{}`.
		data: cloneJson(value.data ?? {}),
		meta,
		idempotencyKey,
	});
}

export function parseEventInputs<T>(value: T): ParsedEventInput[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new TypeError("events must be a non-empty array");
	}
	return value.map((event) => parseEventInput(event));
}

export function parseAppendContext<TStream, TOptions>(
	streamId: TStream,
	appendOptions: TOptions,
): ParsedAppendContext {
	if (!isJsonObject(appendOptions)) {
		throw new TypeError("appendOptions must be an object");
	}
	const options = appendOptions;
	const actor = options.actor;
	if (!actor || !isJsonObject(actor) || Array.isArray(actor)) {
		throw new TypeError("appendOptions.actor must be an object");
	}

	const fenceToken = parseOptionalFenceToken(
		options.fenceToken,
		"appendOptions.fenceToken",
	);

	return Object.freeze({
		streamId: parseStreamId(
			isJsonString(streamId) ? streamId : cloneAsJson(streamId),
		),
		expectedSeq: parseExpectedSeq(
			options.expectedSeq,
			"appendOptions.expectedSeq",
		),
		// SAFETY: assertion to `actor as PrincipalRef` is required at this boundary.
		actor: parsePrincipalRef(actor),
		tenant: requireNonEmptyString(options.tenant, "appendOptions.tenant"),
		project: optionalString(options.project, "appendOptions.project"),
		causationId: optionalString(
			options.causationId,
			"appendOptions.causationId",
		),
		correlationId: optionalString(
			options.correlationId,
			"appendOptions.correlationId",
		),
		lane: optionalString(options.lane, "appendOptions.lane"),
		fenceToken,
	});
}

function parsePrincipalRef(value: JsonObject): PrincipalRef {
	const kind = requireNonEmptyString(value.kind, "appendOptions.actor.kind");
	const id = requireNonEmptyString(value.id, "appendOptions.actor.id");
	// SAFETY: parsed kind/id is a PrincipalRef at this envelope boundary.
	return { kind, id } as never;
}

function parseOptionalFenceToken(
	value: JsonValue | undefined,
	fieldName: string,
): bigint | undefined {
	if (value === undefined) return undefined;
	if (isJsonBigInt(value)) {
		if (value < 0n) {
			throw new TypeError(`${fieldName} must be a non-negative bigint`);
		}
		return value;
	}
	if (isJsonNumber(value) && Number.isSafeInteger(value) && value >= 0) {
		return BigInt(value);
	}
	if (isJsonString(value) && /^(0|[1-9]\d*)$/.test(value)) {
		return BigInt(value);
	}
	throw new TypeError(`${fieldName} must be a non-negative integer/bigint`);
}

export function parseStoredEnvelope(row: {
	id: string;
	type: string;
	v: number;
	stream_id: string;
	seq: number;
	ts: string;
	actor: string;
	tenant: string;
	project: string | null;
	causation_id: string | null;
	correlation_id: string | null;
	lane: string | null;
	data: string;
	meta: string;
}): ReturnType<typeof parseEventEnvelope> {
	return parseEventEnvelope({
		id: row.id,
		type: row.type,
		v: row.v,
		streamId: row.stream_id,
		seq: row.seq,
		ts: row.ts,
		actor: parseJsonValue(row.actor),
		tenant: row.tenant,
		project: row.project ?? undefined,
		causationId: row.causation_id ?? undefined,
		correlationId: row.correlation_id ?? undefined,
		lane: row.lane ?? undefined,
		data: parseJsonValue(row.data),
		meta: parseJsonValue(row.meta),
	});
}

function normalizeVersion(value: JsonValue | undefined): number {
	if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError("event.v must be a positive safe integer");
	}
	return value;
}

function optionalString(
	value: JsonValue | undefined,
	fieldName: string,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return requireNonEmptyString(value, fieldName);
}

function requireNonEmptyString(
	value: JsonValue | undefined,
	fieldName: string,
): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${fieldName} must be a non-empty string`);
	}
	return value;
}

function cloneJson<T>(value: T): T {
	if (structuredClone instanceof Function) {
		return structuredClone(value);
	}
	const cloned = parseJsonValue(JSON.stringify(value));
	// SAFETY: JSON round-trip preserves the caller-owned parse snapshot type.
	return cloned as T;
}
