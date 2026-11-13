/**
 * The narrow seam between the fleet's bus ports and a NATS connection.
 *
 * Every port of `FleetBus` and `AuthorityBus` is built over these few
 * operations (`fleet-bus.ts`), so the port logic is tested against an
 * in-memory wire and the real one (`nats-wire.ts`) only translates each
 * operation to JetStream. Each operation names exactly the subjects the
 * permission templates of §6.7 allow for it.
 */
import type { BusStart, Subscription } from "@hobo/fleet";
import type { BucketName, StreamName } from "./names.js";

export type WireMessage = Readonly<{
	subject: string;
	data: Uint8Array;
	sequence: number;
}>;

export type WireEntry = Readonly<{ key: string; value: Uint8Array }>;

/** What a stream publish answered: stored, or refused because the subject already holds its one message (`discard_new_per_subject`). */
export type PublishResult = "stored" | "subject-full";

export interface BusWire {
	/** The latest value of `key`, or undefined when absent or deleted. */
	kvGet(bucket: BucketName, key: string): Promise<Uint8Array | undefined>;
	kvPut(bucket: BucketName, key: string, value: Uint8Array): Promise<void>;
	/** Put-if-absent; true when this call created the key. `ttlMs` sets a per-key expiry. */
	kvCreate(
		bucket: BucketName,
		key: string,
		value: Uint8Array,
		ttlMs: number,
	): Promise<boolean>;
	/** The latest value of each key under `prefix` (all keys when empty), at most `limit`. */
	kvEntries(
		bucket: BucketName,
		prefix: string,
		limit: number,
	): Promise<Readonly<{ entries: readonly WireEntry[]; capped: boolean }>>;
	streamPublish(
		stream: StreamName,
		subject: string,
		data: Uint8Array,
	): Promise<PublishResult>;
	/** The last message stored on `subject`, by direct get. */
	streamLast(
		stream: StreamName,
		subject: string,
	): Promise<WireMessage | undefined>;
	streamDelete(stream: StreamName, sequence: number): Promise<void>;
	/** Every message stored on `filter` up to the stream's current end, in order. */
	streamRead(
		stream: StreamName,
		filter: string,
	): Promise<readonly WireMessage[]>;
	/** A consumer on `filter` from `from`; the handler sees each message once, in order. */
	consume(
		stream: StreamName,
		filter: string,
		from: BusStart,
		handler: (message: WireMessage) => Promise<void>,
	): Subscription;
	/** Core publish, no stream. */
	publish(subject: string, data: Uint8Array): Promise<void>;
	/** Core subscription; `subject` may end in `>`. */
	subscribe(
		subject: string,
		handler: (subject: string, data: Uint8Array) => Promise<void>,
	): Subscription;
	status(): "connected" | "disconnected" | "closed";
	close(): Promise<void>;
}
