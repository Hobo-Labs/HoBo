// Durable DPoP `jti` replay protection. A proof is accepted at most once per
// reconciler. The journal's per-stream idempotency key is the replay record,
// so the check is atomic and shared by every Station replica on one store.
//
// Proofs are only valid within ±skew of the Station clock, so a jti needs to
// be remembered only for 2×skew. Streams are bucketed by the proof's `iat`
// (`cd-dpop-<reconcilerId>-<floor(iat / 2·skew)>`): a replay carries the same
// iat and lands in the same bucket; old buckets are compaction-eligible.
import { type DurableEventStore, EventStoreError } from "@hobo/core";
import { AGENT_EVENT_SCHEMA, AGENT_EVENTS, AGENT_STREAMS } from "./events.js";

export interface DpopReplayStore {
	/** True on first sight of this (reconciler, jti); false on a replay. */
	claim(
		input: Readonly<{ reconcilerId: string; jti: string; iatSeconds: number }>,
	): Promise<boolean>;
}

const MAX_ATTEMPTS = 8;

export function createJournalReplayStore(
	d: Readonly<{ store: DurableEventStore; tenant: string; skewMs: number }>,
): DpopReplayStore {
	const bucketMs = Math.max(1, d.skewMs * 2);
	return Object.freeze({
		async claim(input) {
			const stream = AGENT_STREAMS.dpop(
				input.reconcilerId,
				Math.floor((input.iatSeconds * 1000) / bucketMs),
			);
			const event = {
				type: AGENT_EVENTS.DpopProofAccepted,
				data: {
					schema: AGENT_EVENT_SCHEMA,
					jti: input.jti,
					iat: input.iatSeconds,
				},
				meta: { idempotencyKey: input.jti },
			};
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
				const expectedSeq = await headOf(d.store, stream);
				try {
					const result = await d.store.append(stream, [event], {
						expectedSeq,
						actor: { kind: "service", id: "cd-feed" },
						tenant: d.tenant,
					});
					return result.appended.length === 1;
				} catch (error) {
					if (
						error instanceof EventStoreError &&
						error.code === "OPTIMISTIC_SEQUENCE_CONFLICT"
					)
						continue;
					throw error;
				}
			}
			throw new EventStoreError(
				"OPTIMISTIC_SEQUENCE_CONFLICT",
				`replay stream ${stream} kept changing`,
			);
		},
	} satisfies DpopReplayStore);
}

async function headOf(
	store: DurableEventStore,
	stream: string,
): Promise<number> {
	const head = store.getStreamHead?.(stream);
	if (head) return head.revision;
	let seq = 0;
	for await (const event of store.read(stream)) seq = event.seq;
	return seq;
}
