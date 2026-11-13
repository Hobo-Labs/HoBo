// `verifyAuditChain` (design §6.14): recompute the chain from entry 1 and check
// every checkpoint's two signatures and its hash against the recomputation.
//
// Across trust rotations (L41, `verifyChainAcrossTrust`): each checkpoint is
// checked against the trust record in force at it. The history is the
// journalled `fleet.TrustRotated` records (`data.record`, the record's bytes
// in base64) whose digest a `fleet.TrustRotated` entry of the chain carries;
// a record is in force from its entry on. Records with a sequence above the
// pinned record's were never witnessed into force and are ignored, as are
// records no entry carries. The history must be unambiguous (one record per
// sequence, sequences rising along the chain, one tenant) and end at the
// pinned record (`trust-history`).
//
// A checkpoint verifies against the record in force at its sequence, or the
// next one (the witness may co-sign a checkpoint just after a rotation, with
// its new key); a checkpoint before the first journalled record verifies
// against that record, which still lists the keys it rotates away from (add
// and publish keep the old key). A removed key therefore verifies nothing
// signed after the record that removed it, plus one rotation.
import { equals, fromBinary } from "@bufbuild/protobuf";
import type { EventEnvelope } from "@hobo/core";
import {
	type AuditCheckpoint,
	AuditCheckpointSchema,
	type AuditEntry,
	type TrustRecord,
	TrustRecordSchema,
	type WitnessedEnvelope,
} from "../_generated/fleet_pb.js";
import { AUDIT_CHECKPOINT_CONTEXT } from "../contexts.js";
import { FLEET_TRUST_STREAM } from "../events.js";
import { verifyWitnessed } from "../keys/index.js";
import type { Outcome } from "../ports.js";
import {
	entryHash,
	GENESIS_HASH,
	isObject,
	isString,
	jsonOf,
	sha256Hex,
	TRUST_ROTATED_EVENT,
} from "./hash.js";

type Verified = Readonly<{ entries: number; finalThrough: number }>;

function broken(
	rule: string,
	message: string,
	sequence: number,
): Outcome<Verified> {
	return {
		ok: false,
		error: {
			code: "proof-invalid",
			message,
			detail: { rule, sequence: String(sequence) },
		},
	};
}

function decode(payload: Uint8Array): AuditCheckpoint | undefined {
	try {
		return fromBinary(AuditCheckpointSchema, payload);
	} catch {
		return undefined;
	}
}

/** A trust record and the chain entry (1-based) from which it is in force; 0 for the pinned record with no entry. */
type InForce = Readonly<{ record: TrustRecord; from: number }>;

/** The trust records in force along the chain, oldest first; a failure message when the history is not usable. */
function historyOf(
	entries: readonly AuditEntry[],
	pinned: TrustRecord,
	journal: readonly EventEnvelope[],
): InForce[] | string {
	const rotations = new Map<string, number>();
	for (const entry of entries)
		if (
			entry.eventType === TRUST_ROTATED_EVENT &&
			!rotations.has(entry.dataDigest)
		)
			rotations.set(entry.dataDigest, entry.sequence);
	const found: InForce[] = [];
	for (const event of journal) {
		if (
			event.streamId !== FLEET_TRUST_STREAM ||
			event.type !== TRUST_ROTATED_EVENT
		)
			continue;
		const data = jsonOf(event.data);
		const encoded = isObject(data) ? data.record : undefined;
		if (!isString(encoded)) continue;
		const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
		const from = rotations.get(sha256Hex(bytes));
		if (from === undefined) continue;
		let record: TrustRecord;
		try {
			record = fromBinary(TrustRecordSchema, bytes);
		} catch {
			continue;
		}
		if (record.sequence > pinned.sequence) continue;
		if (!found.some((held) => held.from === from)) found.push({ record, from });
	}
	found.sort((a, b) => a.from - b.from);
	for (const [index, held] of found.entries()) {
		if (held.record.tenant !== pinned.tenant)
			return `trust record ${held.record.sequence} is for another tenant`;
		const before = found[index - 1];
		if (before !== undefined && held.record.sequence <= before.record.sequence)
			return `trust record ${held.record.sequence} is journalled twice or out of order`;
	}
	const last = found.at(-1);
	if (last === undefined || last.record.sequence < pinned.sequence)
		return [...found, { record: pinned, from: Number.POSITIVE_INFINITY }];
	return equals(TrustRecordSchema, last.record, pinned)
		? found
		: `the journalled trust record ${pinned.sequence} is not the pinned one`;
}

/** The records a checkpoint over entry `sequence` may verify against. */
function candidatesAt(
	history: readonly InForce[],
	sequence: number,
): TrustRecord[] {
	let current = 0;
	for (const [index, held] of history.entries())
		if (held.from <= sequence) current = index;
	return [history[current], history[current + 1]].flatMap((held) =>
		held === undefined ? [] : [held.record],
	);
}

/**
 * Entries must be the whole chain from sequence 1, in order; every checkpoint
 * must be witnessed against the trust record in force at it, from `journal`'s
 * `fleet.TrustRotated` records and the pinned `trust`, and match the chain.
 */
export function verifyChainAcrossTrust(
	entries: readonly AuditEntry[],
	checkpoints: readonly WitnessedEnvelope[],
	trust: TrustRecord,
	journal: readonly EventEnvelope[],
): Outcome<Verified> {
	const hashes: string[] = [GENESIS_HASH];
	for (const [index, entry] of entries.entries()) {
		const expected = index + 1;
		if (entry.sequence !== expected)
			return broken(
				"sequence",
				`entry ${expected} is missing or out of order`,
				expected,
			);
		const previous = hashes[index] ?? GENESIS_HASH;
		if (entry.previousHash !== previous)
			return broken(
				"previous-hash",
				`entry ${expected} does not chain to entry ${index}`,
				expected,
			);
		hashes.push(entryHash(previous, entry));
	}
	const history = historyOf(entries, trust, journal);
	if (!Array.isArray(history)) return broken("trust-history", history, 0);
	let finalThrough = 0;
	for (const witnessed of checkpoints) {
		const payload = witnessed.authority?.payload;
		const checkpoint = payload === undefined ? undefined : decode(payload);
		const sequence = checkpoint?.sequence ?? 0;
		if (
			checkpoint === undefined ||
			!candidatesAt(history, sequence).some((record) =>
				verifyWitnessed(witnessed, AUDIT_CHECKPOINT_CONTEXT, record),
			)
		)
			return broken(
				"checkpoint-signature",
				"a checkpoint is not signed by an authority and witness key in force at it",
				sequence,
			);
		if (sequence === 0 || sequence > entries.length)
			return broken(
				"checkpoint-beyond",
				`checkpoint ${sequence} covers entries that are missing`,
				sequence,
			);
		if (hashes[sequence] !== checkpoint.entryHash)
			return broken(
				"checkpoint-hash",
				`checkpoint ${sequence} does not match the recomputed chain`,
				sequence,
			);
		finalThrough = Math.max(finalThrough, sequence);
	}
	return { ok: true, value: { entries: entries.length, finalThrough } };
}

/** Entries must be the whole chain from sequence 1, in order; every checkpoint must be witnessed, against `trust`, and match it. */
export function verifyChain(
	entries: readonly AuditEntry[],
	checkpoints: readonly WitnessedEnvelope[],
	trust: TrustRecord,
): Outcome<Verified> {
	return verifyChainAcrossTrust(entries, checkpoints, trust, []);
}
