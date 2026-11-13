/**
 * A fake NATS connection: an in-memory `BusWire` with the stream and bucket
 * semantics the ports rely on (one message per claim subject, per-key expiry,
 * ordered consumers honouring `BusStart`). Tests only.
 */
import type { BusStart, Subscription } from "@hobo/fleet";
import {
	type BucketName,
	STREAMS,
	type StreamName,
} from "../../src/bus/names.js";
import type {
	BusWire,
	PublishResult,
	WireMessage,
} from "../../src/bus/wire.js";

type Stored = WireMessage & Readonly<{ expiresAt: number }>;

/** Subject match with NATS wildcards `*` and a trailing `>`. */
export function matches(filter: string, subject: string): boolean {
	const want = filter.split(".");
	const have = subject.split(".");
	for (let index = 0; index < want.length; index += 1) {
		const token = want[index];
		if (token === ">") return have.length > index;
		if (index >= have.length) return false;
		if (token !== "*" && token !== have[index]) return false;
	}
	return want.length === have.length;
}

export type MemoryNats = Readonly<{
	/** A connection to the shared server. */
	connect(): BusWire;
	/** Messages per stream, for assertions. */
	stored(stream: StreamName): readonly WireMessage[];
	/** Every operation any connection asked for, as `<operation> <name> <subject>`. */
	operations: readonly string[];
}>;

/** One fake server shared by any number of connections. */
export function createMemoryNats(now: () => number = Date.now): MemoryNats {
	const streams = new Map<string, Stored[]>();
	const sequences = new Map<string, number>();
	const listeners = new Set<() => void>();
	const core = new Set<
		Readonly<{
			filter: string;
			deliver: (subject: string, data: Uint8Array) => void;
		}>
	>();
	const operations: string[] = [];
	const perSubjectOne: ReadonlySet<string> = new Set([STREAMS.claims]);

	const messagesOf = (stream: string): Stored[] => {
		const existing = streams.get(stream);
		if (existing !== undefined) return existing;
		const created: Stored[] = [];
		streams.set(stream, created);
		return created;
	};
	const live = (stream: string): Stored[] =>
		messagesOf(stream).filter((message) => message.expiresAt > now());
	const append = (
		stream: string,
		subject: string,
		data: Uint8Array,
		ttlMs = Number.POSITIVE_INFINITY,
	): number => {
		const sequence = (sequences.get(stream) ?? 0) + 1;
		sequences.set(stream, sequence);
		messagesOf(stream).push({
			subject,
			data: data.slice(),
			sequence,
			expiresAt: now() + ttlMs,
		});
		for (const listener of listeners) listener();
		return sequence;
	};
	const kvStream = (bucket: BucketName) => `KV_${bucket}`;
	const kvSubject = (bucket: BucketName, key: string) => `$KV.${bucket}.${key}`;
	const lastOn = (stream: string, subject: string): Stored | undefined =>
		live(stream)
			.filter((message) => message.subject === subject)
			.at(-1);

	const connect = (): BusWire => {
		let state: "connected" | "closed" = "connected";
		const stops = new Set<() => void>();
		const open = () => {
			if (state === "closed") throw new Error("connection closed");
		};
		const record = (entry: string) => operations.push(entry);
		return {
			async kvGet(bucket, key) {
				open();
				record(`kv.get ${bucket} ${key}`);
				const last = lastOn(kvStream(bucket), kvSubject(bucket, key));
				return last === undefined || last.data.length === 0
					? undefined
					: last.data.slice();
			},
			async kvPut(bucket, key, value) {
				open();
				record(`kv.put ${bucket} ${key}`);
				append(kvStream(bucket), kvSubject(bucket, key), value);
			},
			async kvCreate(bucket, key, value, ttlMs) {
				open();
				record(`kv.create ${bucket} ${key}`);
				const last = lastOn(kvStream(bucket), kvSubject(bucket, key));
				if (last !== undefined && last.data.length > 0) return false;
				append(kvStream(bucket), kvSubject(bucket, key), value, ttlMs);
				return true;
			},
			async kvEntries(bucket, prefix, limit) {
				open();
				record(`kv.entries ${bucket} ${prefix}`);
				const latest = new Map<string, Stored>();
				const head = `$KV.${bucket}.`;
				for (const message of live(kvStream(bucket))) {
					const key = message.subject.slice(head.length);
					if (prefix.length > 0 && !key.startsWith(prefix)) continue;
					latest.set(key, message);
				}
				const entries = [...latest.entries()]
					.filter(([, message]) => message.data.length > 0)
					.map(([key, message]) => ({ key, value: message.data.slice() }));
				return {
					entries: entries.slice(0, limit),
					capped: entries.length > limit,
				};
			},
			async streamPublish(stream, subject, data): Promise<PublishResult> {
				open();
				record(`stream.publish ${stream} ${subject}`);
				if (perSubjectOne.has(stream) && lastOn(stream, subject) !== undefined)
					return "subject-full";
				append(stream, subject, data);
				return "stored";
			},
			async streamLast(stream, subject) {
				open();
				record(`stream.last ${stream} ${subject}`);
				const last = lastOn(stream, subject);
				return last === undefined
					? undefined
					: {
							subject: last.subject,
							data: last.data.slice(),
							sequence: last.sequence,
						};
			},
			async streamDelete(stream, sequence) {
				open();
				record(`stream.delete ${stream} ${sequence}`);
				const messages = messagesOf(stream);
				const index = messages.findIndex(
					(message) => message.sequence === sequence,
				);
				if (index >= 0) messages.splice(index, 1);
			},
			async streamRead(stream, filter) {
				open();
				record(`stream.read ${stream} ${filter}`);
				return live(stream)
					.filter((message) => matches(filter, message.subject))
					.map(({ subject, data, sequence }) => ({
						subject,
						data: data.slice(),
						sequence,
					}));
			},
			consume(stream, filter, from, handler): Subscription {
				open();
				record(`consume ${stream} ${filter}`);
				let after = startAfter(stream, from);
				let stopped = false;
				let running = Promise.resolve();
				const pump = () => {
					running = running.then(async () => {
						for (const message of live(stream)) {
							if (stopped) return;
							if (
								message.sequence <= after ||
								!matches(filter, message.subject)
							)
								continue;
							after = message.sequence;
							await handler({
								subject: message.subject,
								data: message.data.slice(),
								sequence: message.sequence,
							});
						}
					});
				};
				const stop = () => {
					stopped = true;
					listeners.delete(pump);
				};
				listeners.add(pump);
				stops.add(stop);
				pump();
				return {
					async stop() {
						stop();
						stops.delete(stop);
						await running.catch(() => undefined);
					},
				};
			},
			async publish(subject, data) {
				open();
				record(`publish ${subject}`);
				for (const listener of Array.from(core))
					if (matches(listener.filter, subject))
						listener.deliver(subject, data.slice());
			},
			subscribe(subject, handler): Subscription {
				open();
				record(`subscribe ${subject}`);
				let chain = Promise.resolve();
				const listener = {
					filter: subject,
					deliver: (on: string, data: Uint8Array) => {
						chain = chain.then(() => handler(on, data)).catch(() => undefined);
					},
				};
				core.add(listener);
				const stop = () => core.delete(listener);
				stops.add(stop);
				return {
					async stop() {
						stop();
						stops.delete(stop);
						await chain;
					},
				};
			},
			status: () => state,
			async close() {
				state = "closed";
				for (const stop of stops) stop();
				stops.clear();
			},
		};
	};

	const startAfter = (stream: string, from: BusStart): number => {
		if (from === "start") return 0;
		if (from === "new") return sequences.get(stream) ?? 0;
		return from.after;
	};

	return {
		connect,
		stored: (stream) =>
			live(stream).map(({ subject, data, sequence }) => ({
				subject,
				data,
				sequence,
			})),
		operations,
	};
}
