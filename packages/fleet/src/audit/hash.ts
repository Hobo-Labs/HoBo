// The hash chain of design §6.14, shared by the chain, its verifier and the witness.
//
//   entry_hash = SHA-256(previous_hash ‖ entry_bytes)
//
// `previous_hash` is the 32 raw bytes of the previous entry's hash (64 zeros in
// hex for the first entry) and `entry_bytes` is the protobuf binary of the
// `AuditEntry`, which itself carries `previous_hash` as hex.
import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { canonicalJson, type EventEnvelope, type JsonValue } from "@hobo/core";
import {
	type AuditCheckpoint,
	AuditCheckpointSchema,
	type AuditEntry,
	AuditEntrySchema,
} from "../_generated/fleet_pb.js";

/** `previous_hash` of the first entry. */
// public-contract: §7.1 AuditEntry.previous_hash of the first entry, "64 zeros".
export const GENESIS_HASH = "0".repeat(64);

/** Stream of `fleet.AuditCheckpointed` (§7.5). */
// public-contract: the §7.5 stream id of the audit chain's own events.
export const AUDIT_STREAM = "fleet-audit";
// public-contract: the §7.5 event types the chain and witness interpret.
export const CHECKPOINTED_EVENT = "fleet.AuditCheckpointed";
// public-contract: see above.
export const TRUST_ROTATED_EVENT = "fleet.TrustRotated";

export function sha256Hex(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function entryHash(previousHash: string, entry: AuditEntry): string {
	return createHash("sha256")
		.update(Buffer.from(previousHash, "hex"))
		.update(toBinary(AuditEntrySchema, entry))
		.digest("hex");
}

const tagOf = Object.prototype.toString;

export function isObject<T>(
	value: T,
): value is T & { readonly [key: string]: JsonValue } {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

export function isString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

/** The event data as JSON (stored events are JSON by construction). */
export function jsonOf<T>(data: T): JsonValue {
	if (data === undefined) return null;
	// SAFETY: journal event data crossed a JSON document boundary when stored; this round-trip only normalises it.
	return JSON.parse(JSON.stringify(data)) as JsonValue;
}

/**
 * `data_digest` of an event: SHA-256 hex of the canonical JSON of its data
 * (`canonicalJson` of `@hobo/core`). A `fleet.TrustRotated` event carries the
 * proposed trust record's protobuf bytes, base64, in `data.record`; its digest
 * is SHA-256 of those bytes, so the witness can match a proposal to it.
 */
export function dataDigestOf(type: string, data: JsonValue): string {
	if (type === TRUST_ROTATED_EVENT && isObject(data) && isString(data.record))
		return sha256Hex(Buffer.from(data.record, "base64"));
	return sha256Hex(canonicalJson(data));
}

/** The data of a `fleet.AuditCheckpointed` event: the checkpoint's fields. */
export function checkpointData(checkpoint: AuditCheckpoint): JsonValue {
	return {
		sequence: checkpoint.sequence,
		entryHash: checkpoint.entryHash,
		at: checkpoint.at,
		authorityIncarnation: checkpoint.authorityIncarnation,
	};
}

/**
 * The checkpoint over entry `sequence`. Its `at` is the `at` of that entry, so
 * the witness, which reads the same entries, builds the same payload bytes.
 */
export function checkpointOver(
	sequence: number,
	hash: string,
	at: string,
	incarnation: number,
): AuditCheckpoint {
	return create(AuditCheckpointSchema, {
		sequence,
		entryHash: hash,
		at,
		authorityIncarnation: incarnation,
	});
}

export function checkpointPayload(checkpoint: AuditCheckpoint): Uint8Array {
	return toBinary(AuditCheckpointSchema, checkpoint);
}

const REGISTRY_STREAMS: readonly Readonly<{
	prefix: string;
	exact: boolean;
	subject: (rest: string) => string;
	field: string;
}>[] = [
	{
		prefix: "fleet-member-",
		exact: false,
		subject: (id) => `member.${id}`,
		field: "recordSequence",
	},
	{
		prefix: "fleet-fleet-",
		exact: false,
		subject: (id) => `fleet.${id}`,
		field: "revision",
	},
	{
		prefix: "fleet-trust",
		exact: true,
		subject: () => "trust",
		field: "sequence",
	},
];

function positiveInteger(value: JsonValue | undefined): number | undefined {
	return Number.isSafeInteger(value) && Number(value) > 0
		? Number(value)
		: undefined;
}

/**
 * `subject` and `subject_sequence` of an event (§7.1). An event changes a
 * registry record when it is on a member, fleet or trust stream and names the
 * record's sequence after the event: `meta.subjectSequence`, else the data
 * field `subjectSequence` (as L02 and L32 write it), else `recordSequence`
 * (member), `revision` (fleet) or `sequence` (trust).
 * Every other event's subject is its stream id, with sequence 0.
 */
/** `subject` and `subject_sequence` of an audit entry. */
export type EntrySubject = Readonly<{
	subject: string;
	subjectSequence: number;
}>;

export function subjectOf(event: EventEnvelope, data: JsonValue): EntrySubject {
	for (const stream of REGISTRY_STREAMS) {
		const matches = stream.exact
			? event.streamId === stream.prefix
			: event.streamId.startsWith(stream.prefix) &&
				event.streamId.length > stream.prefix.length;
		if (!matches) continue;
		const sequence =
			positiveInteger(event.meta?.subjectSequence) ??
			(isObject(data)
				? (positiveInteger(data.subjectSequence) ??
					positiveInteger(data[stream.field]))
				: undefined);
		if (sequence === undefined) break;
		return {
			subject: stream.subject(event.streamId.slice(stream.prefix.length)),
			subjectSequence: sequence,
		};
	}
	return { subject: event.streamId, subjectSequence: 0 };
}

function actorOf(event: EventEnvelope): string {
	return `${event.actor.kind}:${event.actor.id}`;
}

/** The audit entry of one journal event. */
export function entryOf(
	event: EventEnvelope,
	sequence: number,
	previousHash: string,
): AuditEntry {
	const data = jsonOf(event.data);
	const { subject, subjectSequence } = subjectOf(event, data);
	return create(AuditEntrySchema, {
		sequence,
		previousHash,
		eventType: event.type,
		eventId: event.id,
		subject,
		actor: actorOf(event),
		at: event.ts,
		dataDigest: dataDigestOf(event.type, data),
		subjectSequence,
	});
}
