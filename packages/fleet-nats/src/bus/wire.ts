import type { BusStart, Subscription } from "@hobo/fleet";
import type { BucketName, StreamName } from "./names.js";

export type WireMessage = Readonly<{
	subject: string;
	data: Uint8Array;
	sequence: number;
}>;

export type WireEntry = Readonly<{ key: string; value: Uint8Array }>;

export type PublishResult = "stored" | "subject-full";

export interface BusWire {
	kvGet(bucket: BucketName, key: string): Promise<Uint8Array | undefined>;
	kvPut(bucket: BucketName, key: string, value: Uint8Array): Promise<void>;
	kvCreate(
		bucket: BucketName,
		key: string,
		value: Uint8Array,
		ttlMs: number,
	): Promise<boolean>;
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
	streamLast(
		stream: StreamName,
		subject: string,
	): Promise<WireMessage | undefined>;
	streamDelete(stream: StreamName, sequence: number): Promise<void>;
	streamRead(
		stream: StreamName,
		filter: string,
	): Promise<readonly WireMessage[]>;
	consume(
		stream: StreamName,
		filter: string,
		from: BusStart,
		handler: (message: WireMessage) => Promise<void>,
	): Subscription;
	publish(subject: string, data: Uint8Array): Promise<void>;
	subscribe(
		subject: string,
		handler: (subject: string, data: Uint8Array) => Promise<void>,
	): Subscription;
	status(): "connected" | "disconnected" | "closed";
	close(): Promise<void>;
}
