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

type InForce = Readonly<{ record: TrustRecord; from: number }>;

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

export function verifyChain(
	entries: readonly AuditEntry[],
	checkpoints: readonly WitnessedEnvelope[],
	trust: TrustRecord,
): Outcome<Verified> {
	return verifyChainAcrossTrust(entries, checkpoints, trust, []);
}
