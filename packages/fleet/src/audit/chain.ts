// The authority's audit chain (design §6.14): every journal event, in
// `readAll` order, becomes one `AuditEntry`; a checkpoint is signed every 60 s
// or 1,000 entries and journaled as `fleet.AuditCheckpointed`.
import {
	type EventPosition,
	type JsonValue,
	OptimisticSequenceConflictError,
	type PositionedEvent,
} from "@hobo/core";
import type { AuditEntry } from "../_generated/fleet_pb.js";
import { AUDIT_CHECKPOINT_CONTEXT } from "../contexts.js";
import { signEnvelope } from "../keys/index.js";
import type { AuditLog, Clock, FleetEventStore, Signer } from "../ports.js";
import {
	AUDIT_STREAM,
	CHECKPOINTED_EVENT,
	checkpointData,
	checkpointOver,
	checkpointPayload,
	entryHash,
	entryOf,
	GENESIS_HASH,
	jsonOf,
} from "./hash.js";

export const CHECKPOINT_INTERVAL_MS = 60_000;
export const CHECKPOINT_ENTRIES = 1_000;
const PAGE = 1_000;
const APPEND_RETRIES = 8;

export type AuditChainDeps = Readonly<{
	store: FleetEventStore;
	log: AuditLog;
	signer: Signer;
	incarnation: number;
	now: Clock;
}>;

type Head = {
	sequence: number;
	hash: string;
	at: string;
	position: EventPosition | undefined;
	checkpointSequence: number;
	checkpointAtMs: number;
	auditStreamSeq: number;
	tenant: string;
};

const tagOf = Object.prototype.toString;

function field(
	meta: JsonValue | undefined,
	key: string,
): JsonValue | undefined {
	if (
		meta === undefined ||
		meta === null ||
		tagOf.call(meta) !== "[object Object]" ||
		Array.isArray(meta)
	)
		return undefined;
	// SAFETY: checked above to be a plain JSON object.
	return (meta as { readonly [k: string]: JsonValue })[key];
}

function positionOf(text: JsonValue | undefined): EventPosition | undefined {
	if (tagOf.call(text) !== "[object String]") return undefined;
	try {
		// SAFETY: EventPosition is a branded bigint; the text was written from one by this chain.
		return BigInt(String(text)) as EventPosition;
	} catch {
		return undefined;
	}
}

async function pageAll(log: AuditLog, from: number): Promise<AuditEntry[]> {
	const out: AuditEntry[] = [];
	for (let next = from; ; next += PAGE) {
		const page = await log.entries(next, next + PAGE - 1);
		out.push(...page);
		if (page.length < PAGE) return out;
	}
}

/** Recovers the head of the chain from the journal's last checkpoint and the log. */
async function recover(deps: AuditChainDeps): Promise<Head> {
	let last:
		| Readonly<{
				sequence: number;
				hash: string;
				at: string;
				position: EventPosition | undefined;
		  }>
		| undefined;
	let auditStreamSeq = 0;
	for await (const event of deps.store.read(AUDIT_STREAM)) {
		auditStreamSeq = event.seq;
		if (event.type !== CHECKPOINTED_EVENT) continue;
		const data = jsonOf(event.data);
		const sequence = Number(field(data, "sequence"));
		const hash = String(field(data, "entryHash"));
		if (!Number.isSafeInteger(sequence) || sequence <= 0) continue;
		last = {
			sequence,
			hash,
			at: String(field(data, "at")),
			position: positionOf(event.meta?.throughPosition),
		};
	}
	if (last !== undefined && last.position === undefined)
		throw new Error(`checkpoint ${last.sequence} names no journal position`);
	const from = (last?.sequence ?? 0) + 1;
	const tail = await pageAll(deps.log, from);
	let hash = last?.hash ?? GENESIS_HASH;
	let sequence = from - 1;
	let at = last?.at ?? "";
	for (const entry of tail) {
		if (entry.sequence !== sequence + 1 || entry.previousHash !== hash)
			throw new Error(
				`audit log does not continue the chain at entry ${sequence + 1}`,
			);
		hash = entryHash(hash, entry);
		sequence = entry.sequence;
		at = entry.at;
	}
	// Skip the journal events the log already holds after the checkpoint, checking they are the same events.
	let position = last?.position;
	let tenant = "";
	let skipped = 0;
	if (tail.length > 0) {
		for await (const positioned of deps.store.readAll(
			position === undefined ? undefined : { after: position },
		)) {
			const expected = tail[skipped];
			if (expected === undefined) break;
			if (positioned.event.id !== expected.eventId)
				throw new Error(
					`journal event at entry ${expected.sequence} is not the one the audit log recorded`,
				);
			position = positioned.position;
			tenant = positioned.event.tenant;
			skipped += 1;
			if (skipped === tail.length) break;
		}
		if (skipped !== tail.length)
			throw new Error("the audit log holds entries the journal does not");
	}
	return {
		sequence,
		hash,
		at,
		position,
		checkpointSequence: last?.sequence ?? 0,
		checkpointAtMs: deps.now(),
		auditStreamSeq,
		tenant,
	};
}

export type AuditChain = Readonly<{ tick(): Promise<void> }>;

export function auditChain(deps: AuditChainDeps): AuditChain {
	let head: Head | undefined;
	let running: Promise<void> = Promise.resolve();

	const checkpoint = async (
		state: Head,
		throughPosition: EventPosition | undefined,
	): Promise<void> => {
		const cp = checkpointOver(
			state.sequence,
			state.hash,
			state.at,
			deps.incarnation,
		);
		const signed = await signEnvelope(
			deps.signer,
			AUDIT_CHECKPOINT_CONTEXT,
			checkpointPayload(cp),
		);
		await deps.log.appendCheckpoint(signed);
		const idempotencyKey = `audit-checkpoint-${deps.incarnation}-${cp.sequence}`;
		const meta =
			throughPosition === undefined
				? { idempotencyKey }
				: { idempotencyKey, throughPosition: throughPosition.toString() };
		for (let attempt = 0; ; attempt += 1) {
			try {
				const result = await deps.store.append(
					AUDIT_STREAM,
					[{ type: CHECKPOINTED_EVENT, data: checkpointData(cp), meta }],
					{
						expectedSeq: state.auditStreamSeq,
						actor: { kind: "service", id: "fleet-authority" },
						tenant: state.tenant,
					},
				);
				const written = [...result.appended, ...result.deduped].at(-1);
				if (written !== undefined)
					state.auditStreamSeq = Math.max(state.auditStreamSeq, written.seq);
				break;
			} catch (error) {
				if (
					!(error instanceof OptimisticSequenceConflictError) ||
					attempt >= APPEND_RETRIES
				)
					throw error;
				for await (const event of deps.store.read(
					AUDIT_STREAM,
					state.auditStreamSeq + 1,
				))
					state.auditStreamSeq = event.seq;
			}
		}
		state.checkpointSequence = cp.sequence;
		state.checkpointAtMs = deps.now();
	};

	const append = async (
		state: Head,
		positioned: PositionedEvent,
	): Promise<void> => {
		const entry = entryOf(positioned.event, state.sequence + 1, state.hash);
		await deps.log.append(entry);
		state.sequence = entry.sequence;
		state.hash = entryHash(state.hash, entry);
		state.at = entry.at;
		state.position = positioned.position;
		state.tenant = positioned.event.tenant;
		if (state.sequence - state.checkpointSequence >= CHECKPOINT_ENTRIES)
			await checkpoint(state, state.position);
	};

	const tickOnce = async (): Promise<void> => {
		head ??= await recover(deps);
		const state = head;
		const options =
			state.position === undefined ? undefined : { after: state.position };
		for await (const positioned of deps.store.readAll(options))
			await append(state, positioned);
		if (
			state.sequence > state.checkpointSequence &&
			deps.now() - state.checkpointAtMs >= CHECKPOINT_INTERVAL_MS
		)
			await checkpoint(state, state.position);
	};

	return {
		tick() {
			const next = running.then(tickOnce);
			running = next.catch(() => {
				// A failed tick leaves the head to be recovered from the log and journal on the next one.
				head = undefined;
			});
			return next;
		},
	};
}
