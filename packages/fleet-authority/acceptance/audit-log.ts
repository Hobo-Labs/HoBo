/**
 * An in-memory `AuditLog` with the witness's publish path, for the acceptance
 * world on the memory bus (whose own witness path is private to the
 * plumbing, §11.3 rule 6). A co-signature is paired with the checkpoint or
 * trust record whose payload bytes it signed, and the pair is delivered to
 * `onWitnessed` or `onTrustWitnessed`. The real chain and witness of
 * `@hobo/fleet/audit` run on top of it.
 */
import { create } from "@bufbuild/protobuf";
import {
	type AuditEntry,
	AuditEntrySchema,
	type AuditLog,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	type Subscription,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";

type Listener<T> = {
	handler: (value: T) => Promise<void>;
	chain: Promise<void>;
};

function topic<T>() {
	const values: T[] = [];
	const listeners = new Set<Listener<T>>();
	const deliver = (listener: Listener<T>, value: T) => {
		listener.chain = listener.chain.then(() =>
			listener.handler(value).catch(() => undefined),
		);
	};
	return {
		values,
		publish(value: T) {
			values.push(value);
			for (const listener of listeners) deliver(listener, value);
		},
		subscribe(handler: (value: T) => Promise<void>): Subscription {
			const listener: Listener<T> = { handler, chain: Promise.resolve() };
			for (const value of values) deliver(listener, value);
			listeners.add(listener);
			return {
				async stop() {
					listeners.delete(listener);
					await listener.chain;
				},
			};
		},
	};
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
	Buffer.from(a).equals(Buffer.from(b));

export type AuditLogDouble = Readonly<{
	log: AuditLog;
	entries: readonly AuditEntry[];
	witnessed: readonly WitnessedEnvelope[];
	publish(
		cosignature: SignedEnvelope,
		of: "checkpoint" | "trust",
	): Promise<void>;
}>;

export function createAuditLogDouble(): AuditLogDouble {
	const entries: AuditEntry[] = [];
	const checkpoints = topic<SignedEnvelope>();
	const witnessed = topic<WitnessedEnvelope>();
	const proposed = topic<SignedEnvelope>();
	const trustWitnessed = topic<WitnessedEnvelope>();
	let pending: { cosignature: SignedEnvelope; of: "checkpoint" | "trust" }[] =
		[];

	const pair = () => {
		const waiting = pending;
		pending = [];
		for (const item of waiting) {
			const pool =
				item.of === "checkpoint" ? checkpoints.values : proposed.values;
			const authority = pool.find((candidate) =>
				sameBytes(candidate.payload, item.cosignature.payload),
			);
			if (authority === undefined) {
				pending.push(item);
				continue;
			}
			const value = create(WitnessedEnvelopeSchema, {
				authority,
				witness: item.cosignature,
			});
			(item.of === "checkpoint" ? witnessed : trustWitnessed).publish(value);
		}
	};

	const log: AuditLog = {
		async append(entry) {
			entries.push(create(AuditEntrySchema, entry));
		},
		async appendCheckpoint(checkpoint) {
			checkpoints.publish(create(SignedEnvelopeSchema, checkpoint));
			pair();
		},
		async entries(from, to) {
			return entries.filter(
				(entry) => entry.sequence >= from && entry.sequence <= to,
			);
		},
		onWitnessed: (handler) => witnessed.subscribe(handler),
		onCheckpoint: (handler) => checkpoints.subscribe(handler),
		async proposeTrust(record) {
			proposed.publish(create(SignedEnvelopeSchema, record));
			pair();
		},
		onTrustProposed: (handler) => proposed.subscribe(handler),
		onTrustWitnessed: (handler) => trustWitnessed.subscribe(handler),
	};

	return {
		log,
		entries,
		witnessed: witnessed.values,
		async publish(cosignature, of) {
			pending.push({ cosignature, of });
			pair();
		},
	};
}
