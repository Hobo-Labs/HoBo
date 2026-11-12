/**
 * The body of a key's blob: a `VercelBlobEphemeralRecord` (see
 * `data-models/vercel_blob_ephemeral_state.proto`) written as protobuf JSON.
 *
 * Parse, don't validate: a body read back is decoded by the generated schema
 * and then parsed into `StoredRecord`, whose incarnation, revision, expiry and
 * write id are checked once here; nothing past this module handles a raw body.
 * A body that does not parse is a contract error, never an absent key: a blob
 * under the binding's namespace that is not one of its records means another
 * writer shares the namespace, and overwriting it would hide that.
 */
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	type EphemeralEntry,
	type EphemeralVersion,
	parseEphemeralVersion,
} from "@hobo/core";
import { KvRedisCompatibleError } from "@hobo/kv-redis-compatible";

import {
	type VercelBlobEphemeralRecord,
	VercelBlobEphemeralRecordSchema,
} from "./_generated/vercel_blob_ephemeral_state_pb.js";

// public-contract: format tag every record body carries.
export const VERCEL_BLOB_RECORD_FORMAT = "hobo.vercel-blob.ephemeral/v1";

const INCARNATION = /^[\x21-\x39\x3b-\x7e]{1,64}$/u; // printable ASCII without ':'
const WRITE_ID = /^[\x21-\x7e]{1,64}$/u;

// domain-view: the parsed form of the generated VercelBlobEphemeralRecord, int64 fields as safe integers.
export type StoredRecord = {
	readonly value: string;
	readonly incarnation: string;
	readonly revision: number;
	readonly expiresAtMs: number;
	readonly writeId: string;
};

const contract = (message: string) =>
	new KvRedisCompatibleError("EPHEMERAL_BACKEND_CONTRACT", message);

export function parseIncarnation(value: string): string {
	if (!INCARNATION.test(value)) {
		throw new RangeError(
			"an incarnation must be 1..64 printable ASCII characters without ':'",
		);
	}
	return value;
}

export function parseWriteId(value: string): string {
	if (!WRITE_ID.test(value)) {
		throw new RangeError("a write id must be 1..64 printable ASCII characters");
	}
	return value;
}

function safeInteger(value: bigint, field: string, least: number): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < least) {
		throw contract(`ephemeral blob record has an out-of-range ${field}`);
	}
	return parsed;
}

/** Decode and parse a blob body; a body that is not a record is a contract error. */
export function parseStoredRecord(body: string): StoredRecord {
	let message: VercelBlobEphemeralRecord;
	try {
		message = fromJsonString(VercelBlobEphemeralRecordSchema, body);
	} catch {
		throw contract("ephemeral blob body is not a record");
	}
	if (message.format !== VERCEL_BLOB_RECORD_FORMAT) {
		throw contract("ephemeral blob body has an unknown format");
	}
	if (!INCARNATION.test(message.incarnation)) {
		throw contract("ephemeral blob record has an invalid incarnation");
	}
	if (!WRITE_ID.test(message.writeId)) {
		throw contract("ephemeral blob record has an invalid write id");
	}
	return {
		value: message.value,
		incarnation: message.incarnation,
		revision: safeInteger(message.revision, "revision", 1),
		expiresAtMs: safeInteger(message.expiresAtMs, "expiry", 1),
		writeId: message.writeId,
	};
}

export function encodeStoredRecord(record: StoredRecord): string {
	return toJsonString(
		VercelBlobEphemeralRecordSchema,
		create(VercelBlobEphemeralRecordSchema, {
			format: VERCEL_BLOB_RECORD_FORMAT,
			value: record.value,
			incarnation: record.incarnation,
			revision: BigInt(record.revision),
			expiresAtMs: BigInt(record.expiresAtMs),
			writeId: record.writeId,
		}),
	);
}

export function versionOf(record: StoredRecord): EphemeralVersion {
	return parseEphemeralVersion(`${record.incarnation}:${record.revision}`);
}

export function entryOf(record: StoredRecord): EphemeralEntry {
	return { value: record.value, version: versionOf(record) };
}
