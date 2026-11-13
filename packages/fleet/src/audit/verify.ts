// `verifyAuditChain` (design §6.14): recompute the chain from entry 1 and check
// every checkpoint's two signatures and its hash against the recomputation.
import { fromBinary } from "@bufbuild/protobuf";
import {
	type AuditCheckpoint,
	AuditCheckpointSchema,
	type AuditEntry,
	type TrustRecord,
	type WitnessedEnvelope,
} from "../_generated/fleet_pb.js";
import { AUDIT_CHECKPOINT_CONTEXT } from "../contexts.js";
import { verifyWitnessed } from "../keys/index.js";
import type { Outcome } from "../ports.js";
import { entryHash, GENESIS_HASH } from "./hash.js";

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

/** Entries must be the whole chain from sequence 1, in order; every checkpoint must be witnessed, against `trust`, and match it. */
export function verifyChain(
	entries: readonly AuditEntry[],
	checkpoints: readonly WitnessedEnvelope[],
	trust: TrustRecord,
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
	let finalThrough = 0;
	for (const witnessed of checkpoints) {
		const payload = witnessed.authority?.payload;
		const checkpoint = payload === undefined ? undefined : decode(payload);
		const sequence = checkpoint?.sequence ?? 0;
		if (
			!verifyWitnessed(witnessed, AUDIT_CHECKPOINT_CONTEXT, trust) ||
			checkpoint === undefined
		)
			return broken(
				"checkpoint-signature",
				"a checkpoint is not signed by a pinned authority and witness key",
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
