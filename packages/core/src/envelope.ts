import { EnvelopeParseError } from "./errors.js";
import { cloneAsJson, type JsonObject, type JsonValue } from "./json.js";
import {
	cloneJson,
	deepFreeze,
	enumValue,
	expectObject,
	isoTimestamp,
	nonEmptyString,
	nonNegativeInteger,
} from "./parse-utils.js";

export type PrincipalKind = "user" | "agent" | "service" | "system";

// domain-view: parse-don't-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface PrincipalRef {
	kind: PrincipalKind;
	id: string;
	delegatedBy?: PrincipalRef;
}

// domain-view: parse-don't-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface EventEnvelope<T = unknown> {
	id: string;
	type: string;
	v: number;
	streamId: string;
	seq: number;
	ts: string;
	actor: PrincipalRef;
	tenant: string;
	project?: string;
	causationId?: string;
	correlationId?: string;
	data: T;
	lane?: string;
	meta?: JsonObject;
}

export interface CloudEvent {
	specversion: "1.0";
	id: string;
	type: string;
	source: string;
	subject: string;
	time: string;
	datacontenttype: "application/json";
	data: JsonValue;
	hobov: number;
	hoboseq: number;
	hoboactor: PrincipalRef;
	hobostreamid: string;
	hobotenant: string;
	hoboproject?: string;
	hobocausationid?: string;
	hobocorrelationid?: string;
	hobolane?: string;
	hobometa?: JsonObject;
}

const PRINCIPAL_KINDS = new Set<PrincipalKind>([
	"user",
	"agent",
	"service",
	"system",
]);
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*\.[A-Z][A-Za-z0-9]*$/;

export function createEventEnvelope<T>(input: T): EventEnvelope {
	const source = expectObject(
		cloneAsJson(input),
		"event envelope",
		EnvelopeParseError,
	);
	return parseEventEnvelope(
		cloneAsJson({
			id: source.id,
			type: source.type,
			v: source.v ?? 1,
			streamId: source.streamId,
			seq: source.seq,
			ts: source.ts ?? source.time,
			actor: source.actor,
			tenant: source.tenant,
			project: source.project,
			causationId: source.causationId,
			correlationId: source.correlationId,
			data: source.data,
			lane: source.lane,
			meta: source.meta,
		}),
	);
}

export function parseEventEnvelope<T>(input: T): EventEnvelope {
	const source = expectObject(
		cloneAsJson(input),
		"event envelope",
		EnvelopeParseError,
	);
	const type = nonEmptyString(source.type, "type", EnvelopeParseError);
	if (!EVENT_TYPE_PATTERN.test(type)) {
		throw new EnvelopeParseError(
			"type",
			"family.PastTenseFact pattern",
			source.type,
		);
	}

	const envelope: EventEnvelope = {
		id: nonEmptyString(source.id, "id", EnvelopeParseError),
		type,
		v: nonNegativeInteger(source.v, "v", EnvelopeParseError),
		streamId: nonEmptyString(source.streamId, "streamId", EnvelopeParseError),
		seq: nonNegativeInteger(source.seq, "seq", EnvelopeParseError),
		ts: isoTimestamp(source.ts, "ts", EnvelopeParseError),
		actor: parsePrincipal(source.actor, "actor"),
		tenant: nonEmptyString(source.tenant, "tenant", EnvelopeParseError),
		data: cloneJson(source.data ?? {}),
	};

	for (const key of [
		"project",
		"causationId",
		"correlationId",
		"lane",
	] as const) {
		if (source[key] !== undefined) {
			envelope[key] = nonEmptyString(source[key], key, EnvelopeParseError);
		}
	}
	if (source.meta !== undefined) {
		// SAFETY: assertion required at this I/O or test boundary.
		envelope.meta = expectObject(
			source.meta,
			"meta",
			EnvelopeParseError,
		) as JsonObject;
		envelope.meta = cloneJson(envelope.meta);
	}

	return deepFreeze(envelope);
}

export function toCloudEvent(envelopeInput: JsonValue | undefined): CloudEvent {
	const envelope = parseEventEnvelope(envelopeInput);
	const cloudEvent: CloudEvent = {
		specversion: "1.0",
		id: envelope.id,
		type: envelope.type,
		source: `hobo://${envelope.tenant}/${envelope.streamId}`,
		subject: envelope.streamId,
		time: envelope.ts,
		datacontenttype: "application/json",
		data: cloneAsJson(envelope.data),
		hobov: envelope.v,
		hoboseq: envelope.seq,
		hoboactor: cloneJson(envelope.actor),
		hobostreamid: envelope.streamId,
		hobotenant: envelope.tenant,
	};
	if (envelope.project !== undefined) cloudEvent.hoboproject = envelope.project;
	if (envelope.causationId !== undefined)
		cloudEvent.hobocausationid = envelope.causationId;
	if (envelope.correlationId !== undefined)
		cloudEvent.hobocorrelationid = envelope.correlationId;
	if (envelope.lane !== undefined) cloudEvent.hobolane = envelope.lane;
	if (envelope.meta !== undefined)
		cloudEvent.hobometa = cloneJson(envelope.meta);
	return deepFreeze(cloudEvent);
}

export function fromCloudEvent(input: JsonValue | undefined): EventEnvelope {
	const event = expectObject(input, "CloudEvent", EnvelopeParseError);
	return parseEventEnvelope(
		cloneAsJson({
			id: event.id,
			type: event.type,
			v: event.hobov,
			streamId: event.hobostreamid ?? event.subject,
			seq: event.hoboseq,
			ts: event.time,
			actor: event.hoboactor,
			tenant: event.hobotenant,
			project: event.hoboproject,
			causationId: event.hobocausationid,
			correlationId: event.hobocorrelationid,
			lane: event.hobolane,
			meta: event.hobometa,
			data: event.data,
		}),
	);
}

function parsePrincipal(
	input: JsonValue | undefined,
	field: string,
): PrincipalRef {
	const source = expectObject(input, field, EnvelopeParseError);
	const principal: PrincipalRef = {
		kind: enumValue(
			source.kind,
			PRINCIPAL_KINDS,
			`${field}.kind`,
			EnvelopeParseError,
		),
		id: nonEmptyString(source.id, `${field}.id`, EnvelopeParseError),
	};
	if (source.delegatedBy !== undefined) {
		principal.delegatedBy = parsePrincipal(
			source.delegatedBy,
			`${field}.delegatedBy`,
		);
	}
	return principal;
}
