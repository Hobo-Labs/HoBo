// Test keys, a trust record and an in-memory AuditLog for the audit tests.
import { generateKeyPairSync, sign } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	type AuditEntry,
	AuditEntrySchema,
	KeyAlgorithm,
	KeyPurpose,
	type PublicKeyRef,
	PublicKeyRefSchema,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	type TrustRecord,
	TrustRecordSchema,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	checkpointData,
	checkpointOver,
	dataDigestOf,
	entryHash,
	GENESIS_HASH,
} from "../../src/audit/hash.js";
import { parseKeyId } from "../../src/ids.js";
import type { AuditLog, Signer, Subscription } from "../../src/ports.js";

export type TestKey = Readonly<{ signer: Signer; ref: PublicKeyRef }>;

export function ed25519Key(keyId: string, purpose: KeyPurpose): TestKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const x = publicKey.export({ format: "jwk" }).x ?? "";
	const id = parseKeyId(keyId);
	return {
		signer: {
			keyId: id,
			algorithm: KeyAlgorithm.EDDSA,
			async sign(bytes) {
				return new Uint8Array(sign(null, bytes, privateKey));
			},
		},
		ref: create(PublicKeyRefSchema, {
			purpose,
			keyId: id,
			algorithm: KeyAlgorithm.EDDSA,
			value: x,
		}),
	};
}

export type TrustKeys = Readonly<{ authority: TestKey; witness: TestKey }>;

export function trustKeys(n = 1): TrustKeys {
	return {
		authority: ed25519Key(`authority#${n}`, KeyPurpose.AUTHORITY),
		witness: ed25519Key(`witness#${n}`, KeyPurpose.WITNESS),
	};
}

export function trustRecord(
	sequence: number,
	keys: TrustKeys,
	incarnation = 1,
	tenant = "acme",
): TrustRecord {
	return create(TrustRecordSchema, {
		tenant,
		sequence,
		authorityKeys: [keys.authority.ref],
		witnessKeys: [keys.witness.ref],
		authorityIncarnation: incarnation,
		issuer: "https://authority.test",
		jwksUri: "https://authority.test/v1/fleet/jwks",
		issuedAt: "2026-01-01T00:00:00.000Z",
	});
}

export function trustPayload(record: TrustRecord): Uint8Array {
	return toBinary(TrustRecordSchema, record);
}

export function witnessedOf(
	authority: SignedEnvelope,
	witness: SignedEnvelope,
): WitnessedEnvelope {
	return create(WitnessedEnvelopeSchema, { authority, witness });
}

/** An AuditLog in memory: holds what it is given and hands out what it holds, unchanged. */
export type MemoryAuditLog = AuditLog &
	Readonly<{
		all: AuditEntry[];
		checkpoints: SignedEnvelope[];
		proposeHandlers: ((record: SignedEnvelope) => Promise<void>)[];
		witnessedHandlers: ((checkpoint: WitnessedEnvelope) => Promise<void>)[];
		/** Entries returned by `entries`: all of them unless a test hides some. */
		visible: (entry: AuditEntry) => boolean;
		hide(predicate: (entry: AuditEntry) => boolean): void;
	}>;

export function memoryAuditLog(): MemoryAuditLog {
	const all: AuditEntry[] = [];
	const checkpoints: SignedEnvelope[] = [];
	const proposeHandlers: ((record: SignedEnvelope) => Promise<void>)[] = [];
	const witnessedHandlers: ((
		checkpoint: WitnessedEnvelope,
	) => Promise<void>)[] = [];
	let hidden: (entry: AuditEntry) => boolean = () => false;
	const none: Subscription = { async stop() {} };
	const log: MemoryAuditLog = {
		all,
		checkpoints,
		proposeHandlers,
		witnessedHandlers,
		visible: (entry) => !hidden(entry),
		hide(predicate) {
			hidden = predicate;
		},
		async append(entry) {
			all.push(create(AuditEntrySchema, entry));
		},
		async appendCheckpoint(checkpoint) {
			checkpoints.push(create(SignedEnvelopeSchema, checkpoint));
		},
		async entries(from, to) {
			return all.filter(
				(e) => e.sequence >= from && e.sequence <= to && !hidden(e),
			);
		},
		onWitnessed(handler) {
			witnessedHandlers.push(handler);
			return none;
		},
		async proposeTrust(record) {
			for (const handler of proposeHandlers) await handler(record);
		},
		onTrustProposed(handler) {
			proposeHandlers.push(handler);
			return none;
		},
		onTrustWitnessed() {
			return none;
		},
	};
	return log;
}

export type EntrySpec = Readonly<{
	type?: string;
	subject?: string;
	subjectSequence?: number;
	at: string;
	digest?: string;
}>;

/** Appends chained entries to `log`, as the authority's chain would. */
export async function appendEntries(
	log: MemoryAuditLog,
	specs: readonly EntrySpec[],
): Promise<void> {
	for (const spec of specs) {
		const previous = log.all.at(-1);
		const previousHash =
			previous === undefined
				? GENESIS_HASH
				: entryHash(previous.previousHash, previous);
		await log.append(
			create(AuditEntrySchema, {
				sequence: log.all.length + 1,
				previousHash,
				eventType: spec.type ?? "fleet.MemberActivated",
				eventId: `evt-${log.all.length + 1}`,
				subject: spec.subject ?? `fleet-member-dev_${log.all.length + 1}`,
				actor: "service:test",
				at: spec.at,
				dataDigest: spec.digest ?? "0".repeat(64),
				subjectSequence: spec.subjectSequence ?? 0,
			}),
		);
	}
}

export type EntryHead = Readonly<{ hash: string; at: string }>;

/** Hash and `at` of the entry at `sequence` (1-based). */
export function headOf(log: MemoryAuditLog, sequence: number): EntryHead {
	const entry = log.all[sequence - 1];
	if (entry === undefined) throw new Error(`no entry ${sequence}`);
	return { hash: entryHash(entry.previousHash, entry), at: entry.at };
}

/** Appends the `fleet.AuditCheckpointed` entry the authority's chain would write for a checkpoint over `sequence`. */
export async function appendCheckpointEntry(
	log: MemoryAuditLog,
	sequence: number,
	at: string,
	incarnation = 1,
): Promise<void> {
	const head = headOf(log, sequence);
	const checkpoint = checkpointOver(sequence, head.hash, head.at, incarnation);
	await appendEntries(log, [
		{
			type: "fleet.AuditCheckpointed",
			subject: "fleet-audit",
			at,
			digest: dataDigestOf(
				"fleet.AuditCheckpointed",
				checkpointData(checkpoint),
			),
		},
	]);
}

export function iso(ms: number): string {
	return new Date(ms).toISOString();
}
