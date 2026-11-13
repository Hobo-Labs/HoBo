/**
 * `JournalTransport` on `@nats-io/jetstream` (L36): the `FLEET_JOURNAL`
 * stream of the topology (design §6.7, §6.16).
 *
 * - `last`: the stream's message-get by `last_by_subj` (works without
 *   `allow_direct`); API error 10037 means the subject has none.
 * - `publish`: a JetStream publish with `Nats-Expected-Last-Subject-Sequence`;
 *   API error 10071 becomes `JournalWrongLastSequence`.
 * - `messages`: an ephemeral pull consumer (`ack_policy: none`) from a start
 *   sequence, read for as many messages as it had pending when created, then
 *   deleted.
 * - `watch`: an ordered consumer from a start sequence.
 *
 * When the stream does not exist the store creates it with the topology's
 * settings (no expiry, `deny_delete`, `deny_purge`) and one replica; a
 * deployment provisions it beforehand (`provisionTopology`) with its own
 * replica count, which this never changes.
 *
 * `JournalJetStream` is the part of the client this uses, so the unit tests
 * run all of the logic here against a fake JetStream context.
 */
import {
	AckPolicy,
	type ConsumerConfig,
	DeliverPolicy,
	type FetchOptions,
	JetStreamApiCodes,
	JetStreamApiError,
	type JetStreamPublishOptions,
	jetstream,
	jetstreamManager,
	type OrderedConsumerOptions,
	type StreamConfig,
} from "@nats-io/jetstream";
import {
	connect,
	credsAuthenticator,
	type NatsConnection,
	type NodeConnectionOptions,
	nanos,
} from "@nats-io/transport-node";
import { connectionOptions } from "../bus/connection.js";
import {
	JOURNAL_STREAM,
	JOURNAL_STREAM_CONFIG,
	JOURNAL_SUBJECTS,
} from "./codec.js";
import {
	type JournalMessage,
	type JournalTransport,
	JournalWrongLastSequence,
} from "./transport.js";

const FETCH_BATCH = 256;
const FETCH_EXPIRES_MS = 5_000;
const CONSUMER_INACTIVE_MS = 60_000;

/** A message as JetStream hands it back; `pending` is what a consumer still has after it. */
type JetStreamMessage = Readonly<{
	seq: number;
	subject: string;
	data: Uint8Array;
}>;
type ConsumedMessage = JetStreamMessage &
	Readonly<{ info: Readonly<{ pending: number }> }>;

/** The part of `@nats-io/jetstream` the journal uses (its manager, client and connection). */
export type JournalJetStream = Readonly<{
	streams: Readonly<{
		info(name: string): Promise<
			Readonly<{
				config: Readonly<{ subjects: readonly string[] }>;
				state: Readonly<{ last_seq: number }>;
			}>
		>;
		add(
			config: Partial<StreamConfig> & Readonly<{ name: string }>,
		): Promise<object>;
		getMessage(
			name: string,
			query: Readonly<{ last_by_subj: string }>,
		): Promise<JetStreamMessage | null>;
	}>;
	consumers: Readonly<{
		add(
			stream: string,
			config: Partial<ConsumerConfig>,
		): Promise<Readonly<{ name: string; num_pending: number }>>;
		delete(stream: string, name: string): Promise<boolean>;
	}>;
	publish(
		subject: string,
		data: Uint8Array,
		options: Partial<JetStreamPublishOptions>,
	): Promise<Readonly<{ seq: number }>>;
	consumer(
		stream: string,
		nameOrOrdered: string | Partial<OrderedConsumerOptions>,
	): Promise<
		Readonly<{
			fetch(
				options: Partial<FetchOptions>,
			): Promise<AsyncIterable<ConsumedMessage>>;
			consume(): Promise<
				AsyncIterable<ConsumedMessage> &
					// biome-ignore lint/suspicious/noConfusingVoidType: the client's ConsumerMessages.close() answers exactly this.
					Readonly<{ close(): Promise<void | Error> }>
			>;
		}>
	>;
	close(): Promise<void>;
}>;

export type JournalConnectInput = Readonly<{
	servers: readonly string[];
	/** A NATS credentials file's text (user JWT and seed); empty for a server without authentication. */
	credentials: string;
}>;

/**
 * The journal's connection options: the bus's (`connectionOptions`), so TLS
 * is required and the CA named by `HOBO_FLEET_NATS_CA` is trusted exactly as
 * on the bus. `persistent` keeps reconnecting for the life of the process
 * (the store); an import fails fast.
 */
export function journalConnectionOptions(
	input: JournalConnectInput,
	persistent = true,
): NodeConnectionOptions {
	if (input.servers.length === 0)
		throw new TypeError("createJournalEventStore needs at least one server");
	const options = connectionOptions({
		servers: input.servers,
		name: "hobo-fleet-journal",
		persistent,
	});
	if (input.credentials !== "")
		options.authenticator = credsAuthenticator(
			new TextEncoder().encode(input.credentials),
		);
	return options;
}

export async function connectJournalTransport(
	input: JournalConnectInput,
	persistent = true,
): Promise<JournalTransport> {
	return journalTransportOver(
		await connect(journalConnectionOptions(input, persistent)),
	);
}

/** The journal transport on an open connection, which it owns from here on (closing it closes the connection). */
export async function journalTransportOver(
	nc: NatsConnection,
): Promise<JournalTransport> {
	try {
		const jsm = await jetstreamManager(nc);
		const js = jetstream(nc);
		return await journalTransportOn({
			streams: jsm.streams,
			consumers: jsm.consumers,
			publish: js.publish.bind(js),
			consumer: js.consumers.get.bind(js.consumers),
			close: nc.close.bind(nc),
		});
	} catch (cause) {
		await nc.close();
		throw cause;
	}
}

function isApiError(cause: Error | null, code: number): boolean {
	return cause instanceof JetStreamApiError && cause.code === code;
}

async function ensureJournalStream(jet: JournalJetStream): Promise<void> {
	try {
		const info = await jet.streams.info(JOURNAL_STREAM);
		if (!info.config.subjects.includes(JOURNAL_SUBJECTS))
			throw new Error(
				`${JOURNAL_STREAM} exists without the subjects ${JOURNAL_SUBJECTS}`,
			);
		return;
	} catch (cause) {
		if (
			!isApiError(
				cause instanceof Error ? cause : null,
				JetStreamApiCodes.StreamNotFound,
			)
		)
			throw cause;
	}
	await jet.streams.add({
		...JOURNAL_STREAM_CONFIG,
		subjects: [...JOURNAL_STREAM_CONFIG.subjects],
		num_replicas: 1,
	});
}

function toMessage(stored: JetStreamMessage): JournalMessage {
	return { seq: stored.seq, subject: stored.subject, data: stored.data };
}

/** The journal transport over `jet`, after making sure `FLEET_JOURNAL` exists. */
export async function journalTransportOn(
	jet: JournalJetStream,
): Promise<JournalTransport> {
	await ensureJournalStream(jet);
	return {
		async last(subject) {
			let stored: JetStreamMessage | null;
			try {
				stored = await jet.streams.getMessage(JOURNAL_STREAM, {
					last_by_subj: subject,
				});
			} catch (cause) {
				if (
					isApiError(
						cause instanceof Error ? cause : null,
						JetStreamApiCodes.NoMessageFound,
					)
				)
					return undefined;
				throw cause;
			}
			return stored === null ? undefined : toMessage(stored);
		},

		async lastSequence() {
			const info = await jet.streams.info(JOURNAL_STREAM);
			return info.state.last_seq;
		},

		async publish(subject, data, expected) {
			try {
				const ack = await jet.publish(subject, data, {
					expect: { lastSubjectSequence: expected, streamName: JOURNAL_STREAM },
				});
				return { seq: ack.seq };
			} catch (cause) {
				if (
					isApiError(
						cause instanceof Error ? cause : null,
						JetStreamApiCodes.StreamWrongLastSequence,
					)
				)
					throw new JournalWrongLastSequence(subject, expected);
				throw cause;
			}
		},

		async *messages(filter, fromSeq) {
			const created = await jet.consumers.add(JOURNAL_STREAM, {
				filter_subject: filter,
				deliver_policy: DeliverPolicy.StartSequence,
				opt_start_seq: Math.max(1, fromSeq),
				ack_policy: AckPolicy.None,
				inactive_threshold: nanos(CONSUMER_INACTIVE_MS),
				mem_storage: true,
			});
			try {
				let remaining = created.num_pending;
				if (remaining === 0) return;
				const consumer = await jet.consumer(JOURNAL_STREAM, created.name);
				while (remaining > 0) {
					const batch = await consumer.fetch({
						max_messages: Math.min(remaining, FETCH_BATCH),
						expires: FETCH_EXPIRES_MS,
					});
					let received = 0;
					for await (const message of batch) {
						received += 1;
						remaining = Math.min(remaining - 1, message.info.pending);
						yield toMessage(message);
						if (remaining <= 0) break;
					}
					if (received === 0) break;
				}
			} finally {
				await jet.consumers
					.delete(JOURNAL_STREAM, created.name)
					.catch(() => false);
			}
		},

		async watch(filter, fromSeq, onMessage) {
			const consumer = await jet.consumer(JOURNAL_STREAM, {
				filter_subjects: filter,
				deliver_policy: DeliverPolicy.StartSequence,
				opt_start_seq: Math.max(1, fromSeq),
			});
			const messages = await consumer.consume();
			const pump = (async () => {
				for await (const message of messages) onMessage(toMessage(message));
			})().catch(() => undefined);
			return {
				async stop() {
					await messages.close();
					await pump;
				},
			};
		},

		close: () => jet.close(),
	};
}
