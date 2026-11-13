// The witness (design §6.14, F12, F13): a separate process that reads the
// audit entries itself, recomputes the chain, watches the registry, and
// co-signs a checkpoint or a proposed trust record only when the rules hold.
//
// The witness learns of a checkpoint from its `fleet.AuditCheckpointed` entry:
// that entry's data digest names the checkpoint's fields, and the checkpoint's
// `at` is the `at` of the entry it covers, so the witness rebuilds the exact
// payload the authority signed from entries it recomputed itself.
import { fromBinary } from "@bufbuild/protobuf";
import {
	AuditCheckpointSchema,
	type AuditEntry,
	KeyPurpose,
	type SignedEnvelope,
	type TrustRecord,
	TrustRecordSchema,
	type WitnessedEnvelope,
} from "../_generated/fleet_pb.js";
import { AUDIT_CHECKPOINT_CONTEXT, TRUST_RECORD_CONTEXT } from "../contexts.js";
import {
	signEnvelope,
	verifyEnvelope,
	verifyWitnessed,
} from "../keys/index.js";
import type {
	AuditLog,
	Clock,
	FleetLog,
	Signer,
	Subscription,
} from "../ports.js";
import {
	CHECKPOINTED_EVENT,
	checkpointData,
	checkpointOver,
	checkpointPayload,
	dataDigestOf,
	entryHash,
	GENESIS_HASH,
	sha256Hex,
	TRUST_ROTATED_EVENT,
} from "./hash.js";

/** How often the witness reads new entries. */
export const WITNESS_POLL_MS = 1_000;
/**
 * A registry change must have an entry before a checkpoint journaled at least
 * this long after the witness saw the change; this absorbs clock skew between
 * the witness and the authority. A later change is due at the next checkpoint.
 */
export const REGISTRY_CHANGE_SKEW_MS = 5_000;
/** Consecutive refused checkpoints that raise `hobo_fleet_witness_lag` (F13). */
export const WITNESS_LAG_CHECKPOINTS = 3;
const PAGE = 1_000;

export type WitnessDeps = Readonly<{
	log: AuditLog;
	registryChanges(
		handler: (key: string, recordSequence: number) => Promise<void>,
	): Subscription;
	trust(): TrustRecord;
	signer: Signer;
	publish(
		cosignature: SignedEnvelope,
		of: "checkpoint" | "trust",
	): Promise<void>;
	now: Clock;
	log2: FleetLog;
}>;

export type Witness = Readonly<{
	start(): void;
	stop(): Promise<void>;
	/** Reads every new entry, decides each checkpoint found, then each pending trust proposal. */
	poll(): Promise<void>;
}>;

type Change = Readonly<{ key: string; sequence: number; seenAtMs: number }>;
type Proposal = Readonly<{ envelope: SignedEnvelope; id: string }>;

const matchKey = (subject: string, sequence: number): string =>
	`${subject}\u0000${sequence}`;

export type WitnessProcess = Readonly<{ start(): void; stop(): Promise<void> }>;

/** The witness without its test-only `poll`. */
export function witnessProcess(deps: WitnessDeps): WitnessProcess {
	const { start, stop } = witness(deps);
	return { start, stop };
}

export function witness(deps: WitnessDeps, pollMs = WITNESS_POLL_MS): Witness {
	// The chain as recomputed so far.
	let position = 0;
	let hash = GENESIS_HASH;
	/** Hash and `at` of each entry after the last checkpoint found, for rebuilding the next one. */
	const window = new Map<number, Readonly<{ hash: string; at: string }>>();
	const recorded = new Set<string>();
	const trustDigests = new Set<string>();
	// The highest record sequence seen per registry key, and the changes not yet matched by an entry.
	const highest = new Map<string, number>();
	const pending = new Map<string, Change>();
	// Decisions already taken, so a refusal is logged once.
	const decided = new Set<number>();
	const finals = new Map<number, string>();
	const cosignedTrust = new Set<number>();
	const refusedProposals = new Set<string>();
	let proposals: Proposal[] = [];
	let consecutiveRefused = 0;

	let subscriptions: Subscription[] = [];
	let timer: ReturnType<typeof setInterval> | undefined;
	let running: Promise<void> = Promise.resolve();

	const refuseCheckpoint = (
		entry: number,
		reason: string,
		fields: Readonly<Record<string, string | number>> = {},
	): void => {
		if (decided.has(entry)) return;
		decided.add(entry);
		consecutiveRefused += 1;
		deps.log2("hobo_fleet_witness_refused", {
			of: "checkpoint",
			reason,
			entry,
			...fields,
		});
		if (consecutiveRefused >= WITNESS_LAG_CHECKPOINTS)
			deps.log2("hobo_fleet_witness_lag", {
				consecutive: consecutiveRefused,
				through: entry,
			});
	};

	const refuseTrust = (
		proposal: Proposal,
		reason: string,
		fields: Readonly<Record<string, string | number>> = {},
	): void => {
		if (refusedProposals.has(`${proposal.id}\u0000${reason}`)) return;
		refusedProposals.add(`${proposal.id}\u0000${reason}`);
		deps.log2("hobo_fleet_witness_refused", { of: "trust", reason, ...fields });
	};

	const findCovered = (entry: AuditEntry, incarnation: number) => {
		for (let sequence = entry.sequence - 1; sequence > 0; sequence -= 1) {
			const head = window.get(sequence);
			if (head === undefined) return undefined;
			const candidate = checkpointOver(
				sequence,
				head.hash,
				head.at,
				incarnation,
			);
			if (
				dataDigestOf(CHECKPOINTED_EVENT, checkpointData(candidate)) ===
				entry.dataDigest
			)
				return candidate;
		}
		return undefined;
	};

	const onCheckpointEntry = async (entry: AuditEntry): Promise<void> => {
		if (decided.has(entry.sequence)) return;
		const checkpoint = findCovered(entry, deps.trust().authorityIncarnation);
		if (checkpoint === undefined) {
			refuseCheckpoint(entry.sequence, "checkpoint-unknown");
			return;
		}
		const journaledAtMs = Date.parse(entry.at);
		for (const change of pending.values()) {
			if (change.seenAtMs + REGISTRY_CHANGE_SKEW_MS >= journaledAtMs) continue;
			refuseCheckpoint(entry.sequence, "registry-change-unrecorded", {
				key: change.key,
				record_sequence: change.sequence,
				checkpoint: checkpoint.sequence,
			});
			return;
		}
		const final = finals.get(checkpoint.sequence);
		if (final !== undefined && final !== checkpoint.entryHash) {
			refuseCheckpoint(entry.sequence, "checkpoint-rewritten", {
				checkpoint: checkpoint.sequence,
			});
			return;
		}
		decided.add(entry.sequence);
		consecutiveRefused = 0;
		for (const sequence of window.keys())
			if (sequence <= checkpoint.sequence) window.delete(sequence);
		if (final !== undefined) return;
		const cosignature = await signEnvelope(
			deps.signer,
			AUDIT_CHECKPOINT_CONTEXT,
			checkpointPayload(checkpoint),
		);
		await deps.publish(cosignature, "checkpoint");
	};

	const record = (entry: AuditEntry): void => {
		hash = entryHash(hash, entry);
		position = entry.sequence;
		window.set(entry.sequence, { hash, at: entry.at });
		if (entry.subjectSequence > 0) {
			const key = matchKey(entry.subject, entry.subjectSequence);
			recorded.add(key);
			pending.delete(key);
		}
		if (entry.eventType === TRUST_ROTATED_EVENT)
			trustDigests.add(entry.dataDigest);
	};

	/** Refuses every checkpoint entry past a point the witness cannot recompute through. */
	const halt = (
		rest: readonly AuditEntry[],
		reason: string,
		at: number,
	): void => {
		for (const entry of rest)
			if (entry.eventType === CHECKPOINTED_EVENT)
				refuseCheckpoint(entry.sequence, reason, { at });
	};

	const readEntries = async (): Promise<void> => {
		for (;;) {
			const page = await deps.log.entries(position + 1, position + PAGE);
			for (const [index, entry] of page.entries()) {
				if (entry.sequence !== position + 1) {
					halt(page.slice(index), "entries-withheld", position + 1);
					return;
				}
				if (entry.previousHash !== hash) {
					halt(page.slice(index), "chain-broken", entry.sequence);
					return;
				}
				record(entry);
				if (entry.eventType === CHECKPOINTED_EVENT)
					await onCheckpointEntry(entry);
			}
			if (page.length < PAGE) return;
		}
	};

	const decideProposal = async (proposal: Proposal): Promise<boolean> => {
		const pinned = deps.trust();
		const { envelope } = proposal;
		const key = pinned.authorityKeys.find(
			(candidate) =>
				candidate.keyId === envelope.keyId &&
				candidate.purpose === KeyPurpose.AUTHORITY,
		);
		if (key === undefined) {
			refuseTrust(proposal, "unpinned-key", { key_id: envelope.keyId });
			return true;
		}
		if (!verifyEnvelope(envelope, TRUST_RECORD_CONTEXT, key)) {
			refuseTrust(proposal, "authority-signature", { key_id: envelope.keyId });
			return true;
		}
		let next: TrustRecord;
		try {
			next = fromBinary(TrustRecordSchema, envelope.payload);
		} catch {
			refuseTrust(proposal, "payload");
			return true;
		}
		if (
			cosignedTrust.has(next.sequence) &&
			next.sequence <= pinned.sequence + 1
		)
			return true;
		if (next.sequence !== pinned.sequence + 1) {
			refuseTrust(proposal, "sequence", {
				sequence: next.sequence,
				pinned: pinned.sequence,
			});
			return true;
		}
		if (next.tenant !== pinned.tenant) {
			refuseTrust(proposal, "tenant", { sequence: next.sequence });
			return true;
		}
		if (!trustDigests.has(sha256Hex(envelope.payload))) {
			// Kept: co-signed once its fleet.TrustRotated entry is in the chain.
			refuseTrust(proposal, "trust-rotation-unrecorded", {
				sequence: next.sequence,
			});
			return false;
		}
		const cosignature = await signEnvelope(
			deps.signer,
			TRUST_RECORD_CONTEXT,
			envelope.payload,
		);
		await deps.publish(cosignature, "trust");
		cosignedTrust.add(next.sequence);
		return true;
	};

	const pollOnce = async (): Promise<void> => {
		await readEntries();
		const waiting = proposals;
		proposals = [];
		for (const proposal of waiting)
			if (!(await decideProposal(proposal))) proposals.push(proposal);
	};

	const poll = (): Promise<void> => {
		const next = running.then(pollOnce);
		running = next.catch((error: Error) => {
			deps.log2("hobo_fleet_witness_refused", {
				of: "checkpoint",
				reason: "unavailable",
				message: error.message,
			});
		});
		return next;
	};

	const onWitnessed = async (witnessed: WitnessedEnvelope): Promise<void> => {
		const payload = witnessed.authority?.payload;
		if (
			payload === undefined ||
			!verifyWitnessed(witnessed, AUDIT_CHECKPOINT_CONTEXT, deps.trust())
		)
			return;
		const checkpoint = fromBinary(AuditCheckpointSchema, payload);
		finals.set(checkpoint.sequence, checkpoint.entryHash);
	};

	const onChange = async (
		key: string,
		recordSequence: number,
	): Promise<void> => {
		if (recordSequence <= (highest.get(key) ?? 0)) return; // a re-sign, or a value already seen
		highest.set(key, recordSequence);
		const match = matchKey(key, recordSequence);
		if (!recorded.has(match))
			pending.set(match, {
				key,
				sequence: recordSequence,
				seenAtMs: deps.now(),
			});
	};

	const onProposal = async (envelope: SignedEnvelope): Promise<void> => {
		proposals.push({
			envelope,
			id: sha256Hex(envelope.payload) + envelope.keyId,
		});
		void poll().catch(() => {});
	};

	return {
		start() {
			if (timer !== undefined) return;
			subscriptions = [
				deps.log.onWitnessed(onWitnessed),
				deps.registryChanges(onChange),
				deps.log.onTrustProposed(onProposal),
			];
			timer = setInterval(() => {
				void poll().catch(() => {});
			}, pollMs);
			timer.unref?.();
			void poll().catch(() => {});
		},
		async stop() {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
			const stopping = subscriptions;
			subscriptions = [];
			await Promise.all(stopping.map((subscription) => subscription.stop()));
			await running;
		},
		poll,
	};
}
