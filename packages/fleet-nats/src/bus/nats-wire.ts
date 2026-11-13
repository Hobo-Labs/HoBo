/**
 * `BusWire` over a NATS connection and JetStream. Every operation uses only
 * subjects the §6.7 templates grant a device of the right template:
 *
 * - key-value reads are direct gets (`$JS.API.DIRECT.GET.<stream>.>`); writes
 *   are plain publishes on `$KV.<bucket>.<key>`, a create with
 *   `Nats-Expected-Last-Subject-Sequence: 0` and a per-message TTL;
 * - every consumer is a pull consumer with `ack_policy: none`, named by the
 *   connection's consumer name (a device's `MemberId`) and created with a
 *   single filter subject, so the create subject carries the name and filter;
 *   the consumer is deleted when the subscription stops.
 */

import type { BusStart, Subscription } from "@hobo/fleet";
import {
	AckPolicy,
	DeliverPolicy,
	JetStreamApiError,
	type JetStreamClient,
	type JetStreamManager,
	jetstream,
	jetstreamManager,
} from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import {
	type BucketName,
	bucketStream,
	bucketSubject,
	type StreamName,
} from "./names.js";
import type { BusWire, PublishResult, WireMessage } from "./wire.js";

const NANOS_PER_MS = 1_000_000;
/** How long one fetch of a snapshot read waits for the next message. */
const FETCH_WAIT_MS = 2_000;
/** A consumer left behind by a crashed process expires after this long. */
const INACTIVE_MS = 5 * 60_000;

/** JetStream refuses a publish to a subject that already holds its one message (`discard_new_per_subject`). */
function isSubjectFull(error: Error): boolean {
	return /maximum messages per subject/iu.test(error.message);
}

/** JetStream refuses a create whose expected last subject sequence does not match. */
function isWrongLastSequence(error: Error): boolean {
	return (
		error instanceof JetStreamApiError &&
		(error.code === 10071 || /wrong last sequence/iu.test(error.message))
	);
}

export type NatsWireOptions = Readonly<{
	/** The name every consumer of this connection gets: a device's MemberId, or a unique name for the authority. */
	consumerName: () => string;
	onStatus?: (status: "connected" | "disconnected" | "closed") => void;
}>;

export function natsWire(
	connection: NatsConnection,
	options: NatsWireOptions,
): BusWire {
	const js: JetStreamClient = jetstream(connection);
	let manager: Promise<JetStreamManager> | undefined;
	const jsm = () => {
		manager ??= jetstreamManager(connection, { checkAPI: false });
		return manager;
	};
	let state: "connected" | "disconnected" | "closed" = "connected";
	void (async () => {
		for await (const status of connection.status()) {
			if (status.type === "disconnect") state = "disconnected";
			else if (status.type === "reconnect") state = "connected";
			else continue;
			options.onStatus?.(state);
		}
	})();
	void connection.closed().then(() => {
		state = "closed";
		options.onStatus?.("closed");
	});

	const lastOn = async (
		stream: string,
		subject: string,
	): Promise<WireMessage | undefined> => {
		const stored = await (await jsm()).direct.getMessage(stream, {
			last_by_subj: subject,
		});
		return stored === null
			? undefined
			: { subject: stored.subject, data: stored.data, sequence: stored.seq };
	};

	/** A consumer on `filter` named for this connection; `deliver` picks where it starts. */
	const createConsumer = async (
		stream: string,
		filter: string,
		deliver: BusStart | "last-per-subject",
	) => {
		const name = options.consumerName();
		const manager = await jsm();
		await manager.consumers.delete(stream, name).catch(() => false);
		const start =
			deliver === "start"
				? { deliver_policy: DeliverPolicy.All }
				: deliver === "new"
					? { deliver_policy: DeliverPolicy.New }
					: deliver === "last-per-subject"
						? { deliver_policy: DeliverPolicy.LastPerSubject }
						: {
								deliver_policy: DeliverPolicy.StartSequence,
								opt_start_seq: deliver.after + 1,
							};
		await manager.consumers.add(stream, {
			name,
			filter_subject: filter,
			ack_policy: AckPolicy.None,
			inactive_threshold: INACTIVE_MS * NANOS_PER_MS,
			...start,
		});
		return {
			consumer: await js.consumers.get(stream, name),
			remove: () => manager.consumers.delete(stream, name).catch(() => false),
		};
	};

	/** Every message on `filter` up to the stream's end at the time of the read. */
	const snapshot = async (
		stream: string,
		filter: string,
		deliver: "start" | "last-per-subject",
		limit: number,
	): Promise<Readonly<{ messages: WireMessage[]; capped: boolean }>> => {
		const { consumer, remove } = await createConsumer(stream, filter, deliver);
		const messages: WireMessage[] = [];
		try {
			if ((await consumer.info(true)).num_pending === 0)
				return { messages, capped: false };
			for (;;) {
				const batch = await consumer.fetch({
					max_messages: Math.min(256, limit + 1 - messages.length),
					expires: FETCH_WAIT_MS,
				});
				let pending = 0;
				let received = 0;
				for await (const message of batch) {
					messages.push({
						subject: message.subject,
						data: message.data,
						sequence: message.seq,
					});
					pending = message.info.pending;
					received += 1;
				}
				if (messages.length > limit)
					return { messages: messages.slice(0, limit), capped: true };
				if (received === 0 || pending === 0) return { messages, capped: false };
			}
		} finally {
			await remove();
		}
	};

	return {
		async kvGet(bucket, key) {
			const last = await lastOn(
				bucketStream(bucket),
				bucketSubject(bucket, key),
			);
			return last === undefined || last.data.length === 0
				? undefined
				: last.data;
		},
		async kvPut(bucket, key, value) {
			await js.publish(bucketSubject(bucket, key), value);
		},
		async kvCreate(bucket: BucketName, key, value, ttlMs) {
			try {
				await js.publish(bucketSubject(bucket, key), value, {
					expect: { lastSubjectSequence: 0 },
					ttl: `${Math.max(1, Math.ceil(ttlMs / 1000))}s`,
				});
				return true;
			} catch (error) {
				if (error instanceof Error && isWrongLastSequence(error)) return false;
				throw error;
			}
		},
		async kvEntries(bucket, prefix, limit) {
			const head = `$KV.${bucket}.`;
			const { messages, capped } = await snapshot(
				bucketStream(bucket),
				prefix === "" ? `${head}>` : `${head}${prefix}>`,
				"last-per-subject",
				limit,
			);
			return {
				entries: messages
					.filter((message) => message.data.length > 0)
					.map((message) => ({
						key: message.subject.slice(head.length),
						value: message.data,
					})),
				capped,
			};
		},
		async streamPublish(stream, subject, data): Promise<PublishResult> {
			try {
				await js.publish(subject, data, { expect: { streamName: stream } });
				return "stored";
			} catch (error) {
				if (error instanceof Error && isSubjectFull(error))
					return "subject-full";
				throw error;
			}
		},
		streamLast: (stream, subject) => lastOn(stream, subject),
		async streamDelete(stream: StreamName, sequence) {
			await (await jsm()).streams.deleteMessage(stream, sequence, false);
		},
		async streamRead(stream, filter) {
			const { messages } = await snapshot(
				stream,
				filter,
				"start",
				Number.MAX_SAFE_INTEGER,
			);
			return messages;
		},
		consume(stream, filter, from, handler): Subscription {
			let stopped = false;
			let stop = async () => undefined;
			const running = (async () => {
				const { consumer, remove } = await createConsumer(stream, filter, from);
				try {
					const messages = await consumer.consume({ max_messages: 256 });
					stop = async () => {
						await messages.close();
					};
					if (stopped) await messages.close();
					for await (const message of messages) {
						if (stopped) break;
						await handler({
							subject: message.subject,
							data: message.data,
							sequence: message.seq,
						});
					}
				} finally {
					await remove();
				}
			})();
			running.catch(() => undefined);
			return {
				async stop() {
					stopped = true;
					await stop();
					await running.catch(() => undefined);
				},
			};
		},
		async publish(subject, data) {
			connection.publish(subject, data);
			await connection.flush();
		},
		subscribe(subject, handler): Subscription {
			const subscription = connection.subscribe(subject);
			const running = (async () => {
				for await (const message of subscription)
					await handler(message.subject, message.data);
			})();
			running.catch(() => undefined);
			return {
				async stop() {
					subscription.unsubscribe();
					await running.catch(() => undefined);
				},
			};
		},
		status: () => state,
		async close() {
			if (state === "closed") return;
			state = "closed";
			await connection.close();
		},
	};
}
