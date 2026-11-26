import { EnvelopeParseError } from "./errors.js";
import {
  cloneJson,
  deepFreeze,
  enumValue,
  expectObject,
  isoTimestamp,
  nonEmptyString,
  nonNegativeInteger,
} from "./parse-utils.js";
import { type JsonValue, type JsonObject, type JsonBag } from "./json.js";


export type PrincipalKind = "user" | "agent" | "service" | "system";

// domain-view: parse-produced draft-proof record; its wire form is the PrincipalRef proto message in data-models/.
export interface PrincipalRef {
  kind: PrincipalKind;
  id: string;
  delegatedBy?: PrincipalRef;
}

// domain-view: parse-produced draft-proof record; its wire form is the EventEnvelope proto message in data-models/.
export interface EventEnvelope<T = JsonValue> {
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

const PRINCIPAL_KINDS = new Set<PrincipalKind>(["user", "agent", "service", "system"]);
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*\.[A-Z][A-Za-z0-9]*$/;

export function createEventEnvelope(input: JsonValue): EventEnvelope {
  const source = expectObject(input, "event envelope", EnvelopeParseError);
  const remapped: JsonBag = { ...source };
  if (remapped.v === undefined) {
    remapped.v = 1;
  }
  if (remapped.ts === undefined && remapped.time !== undefined) {
    remapped.ts = remapped.time;
  }
  return parseEventEnvelope(remapped);
}

export function parseEventEnvelope(input: JsonValue): EventEnvelope {
  const source = expectObject(input, "event envelope", EnvelopeParseError);
  const type = nonEmptyString(source.type, "type", EnvelopeParseError);
  if (!EVENT_TYPE_PATTERN.test(type)) {
    throw new EnvelopeParseError("type", "family.PastTenseFact pattern", source.type);
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

  for (const key of ["project", "causationId", "correlationId", "lane"] as const) {
    if (source[key] !== undefined) {
      envelope[key] = nonEmptyString(source[key], key, EnvelopeParseError);
    }
  }
  if (source.meta !== undefined) {
    // SAFETY: `envelope.meta = expectObject(source.meta, "meta", EnvelopeParseError) as JsonObj` is required at this I/O or test boundary.
    envelope.meta = expectObject(source.meta, "meta", EnvelopeParseError) as JsonObject;
    envelope.meta = cloneJson(envelope.meta);
  }

  return deepFreeze(envelope);
}

export function toCloudEvent(envelopeInput: JsonValue): CloudEvent {
  const envelope = parseEventEnvelope(envelopeInput);
  const cloudEvent: CloudEvent = {
    specversion: "1.0",
    id: envelope.id,
    type: envelope.type,
    source: `hobo://${envelope.tenant}/${envelope.streamId}`,
    subject: envelope.streamId,
    time: envelope.ts,
    datacontenttype: "application/json",
    data: cloneJson(envelope.data),
    hobov: envelope.v,
    hoboseq: envelope.seq,
    hoboactor: cloneJson(envelope.actor),
    hobostreamid: envelope.streamId,
    hobotenant: envelope.tenant,
  };
  if (envelope.project !== undefined) cloudEvent.hoboproject = envelope.project;
  if (envelope.causationId !== undefined) cloudEvent.hobocausationid = envelope.causationId;
  if (envelope.correlationId !== undefined) cloudEvent.hobocorrelationid = envelope.correlationId;
  if (envelope.lane !== undefined) cloudEvent.hobolane = envelope.lane;
  if (envelope.meta !== undefined) cloudEvent.hobometa = cloneJson(envelope.meta);
  return deepFreeze(cloudEvent);
}

export function fromCloudEvent(input: JsonValue): EventEnvelope {
  const event = expectObject(input, "CloudEvent", EnvelopeParseError);
  const remapped: JsonBag = {
    id: event.id ?? null,
    type: event.type ?? null,
    v: event.hobov ?? null,
    streamId: event.hobostreamid ?? event.subject ?? null,
    seq: event.hoboseq ?? null,
    ts: event.time ?? null,
    actor: event.hoboactor ?? null,
    tenant: event.hobotenant ?? null,
    data: event.data ?? null,
  };
  if (event.hoboproject !== undefined) remapped.project = event.hoboproject;
  if (event.hobocausationid !== undefined) remapped.causationId = event.hobocausationid;
  if (event.hobocorrelationid !== undefined) remapped.correlationId = event.hobocorrelationid;
  if (event.hobolane !== undefined) remapped.lane = event.hobolane;
  if (event.hobometa !== undefined) remapped.meta = event.hobometa;
  return parseEventEnvelope(remapped);
}

function parsePrincipal(input: JsonValue | undefined, field: string): PrincipalRef {
  const source = expectObject(input, field, EnvelopeParseError);
  const principal: PrincipalRef = {
    kind: enumValue(source.kind, PRINCIPAL_KINDS, `${field}.kind`, EnvelopeParseError),
    id: nonEmptyString(source.id, `${field}.id`, EnvelopeParseError),
  };
  if (source.delegatedBy !== undefined) {
    principal.delegatedBy = parsePrincipal(source.delegatedBy, `${field}.delegatedBy`);
  }
  return principal;
}
