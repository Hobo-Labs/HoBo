/**
 * A fake NATS server for unit tests of the code that talks to a connection
 * (`nats-wire.ts`, `resolver.ts` and the entry points of `index.ts`), through
 * the `NatsClients` port of `src/bus/nats-client.ts`: core publish and
 * subscribe, request and reply, connection status, and the slice of
 * JetStream those modules call (publish with expectations and per-message
 * TTL, direct get, named pull consumers with a deliver policy, message
 * delete, stream add, info and update).
 *
 * The server-side rules follow the real server where the bus depends on them
 * (`discard_new_per_subject`, a create with an expected last subject sequence
 * of 0, the API errors' codes); the `*.integration.test.ts` files prove the
 * same paths against `nats-server`. Tests only.
 */
import {
	type ConsumerConfig,
	DeliverPolicy,
	JetStreamApiError,
	type JetStreamPublishOptions,
	type StreamConfig,
} from "@nats-io/jetstream";
import { type Account, type ClaimsData, decode } from "@nats-io/jwt";
import type { Authenticator } from "@nats-io/transport-node";
import { type OpenOptions, parseServers } from "../../src/bus/connection.js";
import type {
	BusConnection,
	BusMessage,
	BusSubscription,
	JetStreamManagerPort,
	JetStreamPort,
	NatsClients,
	PullConsumer,
	StreamDelivery,
} from "../../src/bus/nats-client.js";
import { matches } from "./memory-wire.js";

type Stored = Readonly<{
	subject: string;
	data: Uint8Array;
	seq: number;
	expiresAt: number;
}>;

type StreamSpec = Partial<StreamConfig> & { name: string };

type Stream = {
	config: StreamSpec;
	messages: Stored[];
	last: number;
	consumers: Map<string, ConsumerState>;
};

type ConsumerState = {
	filter: string;
	/** Messages owed before the cursor applies (last-per-subject). */
	initial: Stored[];
	cursor: number;
	stream: Stream;
};

type Wake = () => void;

/** An async queue: `push` feeds it, iteration waits for the next item until `end`. */
class Queue<T> implements AsyncIterable<T> {
	readonly #items: T[] = [];
	#done = false;
	#wake: Wake | undefined;

	push(item: T): void {
		this.#items.push(item);
		this.#wake?.();
	}

	end(): void {
		this.#done = true;
		this.#wake?.();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		for (;;) {
			const item = this.#items.shift();
			if (item !== undefined) {
				yield item;
				continue;
			}
			if (this.#done) return;
			await new Promise<void>((resolve) => {
				this.#wake = () => {
					this.#wake = undefined;
					resolve();
				};
			});
		}
	}
}

type Headers = Readonly<Record<string, string>>;

type Subscriber = { filter: string; queue: Queue<BusMessage>; closed: boolean };

/** What one `open` was asked for: the connection name and the auth token each authenticator gave. */
export type OpenRecord = Readonly<{
	name: string;
	authTokens: readonly (string | undefined)[];
}>;

export type FakeConnection = BusConnection &
	Readonly<{
		name: string;
		isClosed(): boolean;
		/** A request carrying headers, as the server sends an auth callout (`Nats-Server-Xkey`); rejects when nobody answers within a second. */
		ask(
			subject: string,
			data: Uint8Array,
			headers: Headers,
		): Promise<BusMessage>;
		/** Emits a status event to every `status()` iterator. */
		emit(type: string): void;
	}>;

export type FakeServer = Readonly<{
	/** The client port bound to this server, as the code under test takes it. */
	clients: NatsClients;
	connect(name?: string): FakeConnection;
	addStream(config: StreamSpec): void;
	streamNames(): string[];
	/** Answers requests on `subject` (which may hold wildcards); `undefined` means no responder. */
	reply(
		subject: string,
		answer: (data: Uint8Array, subject: string) => Uint8Array | undefined,
	): void;
	/** Moves the fake clock on. */
	advance(ms: number): void;
	connections: readonly FakeConnection[];
	opened: readonly OpenRecord[];
}>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function apiError(code: number, err_code: number, description: string) {
	return new JetStreamApiError({ code, err_code, description });
}

/** The token an authenticator gave, when it gave one. */
function tokenOf(auth: ReturnType<Authenticator>): string | undefined {
	if (!auth) return undefined;
	return "auth_token" in auth ? auth.auth_token : undefined;
}

export function createFakeServer(): FakeServer {
	let offset = 0;
	const now = () => Date.now() + offset;
	const streams = new Map<string, Stream>();
	const waiters = new Set<Wake>();
	const subscribers = new Set<Subscriber>();
	const responders = new Map<
		string,
		(data: Uint8Array, subject: string) => Uint8Array | undefined
	>();
	const connections: FakeConnection[] = [];
	const opened: OpenRecord[] = [];

	const message = (
		subject: string,
		data: Uint8Array,
		reply?: string,
		headers: Headers = {},
	): BusMessage => ({
		subject,
		data,
		headers: { get: (name) => headers[name] ?? "" },
		respond(answer) {
			if (reply === undefined) return false;
			deliver(reply, answer);
			return true;
		},
		json<T>(): T {
			// SAFETY: a test reads JSON it wrote itself with a known shape.
			return JSON.parse(decoder.decode(data)) as T;
		},
	});
	const deliver = (
		subject: string,
		data: Uint8Array,
		reply?: string,
		headers: Headers = {},
	) => {
		for (const subscriber of Array.from(subscribers))
			if (!subscriber.closed && matches(subscriber.filter, subject))
				subscriber.queue.push(message(subject, data, reply, headers));
	};

	const live = (stream: Stream): Stored[] => {
		const at = now();
		return stream.messages.filter((stored) => stored.expiresAt > at);
	};
	const streamFor = (subject: string): Stream | undefined => {
		for (const stream of streams.values())
			if (
				(stream.config.subjects ?? []).some((filter) =>
					matches(filter, subject),
				)
			)
				return stream;
		return undefined;
	};
	const streamNamed = (name: string): Stream => {
		const stream = streams.get(name);
		if (stream === undefined) throw apiError(404, 10059, "stream not found");
		return stream;
	};
	const addStream = (config: StreamSpec) => {
		streams.set(config.name, {
			config,
			messages: [],
			last: 0,
			consumers: new Map(),
		});
	};

	const pending = (consumer: ConsumerState): Stored[] => [
		...consumer.initial,
		...live(consumer.stream).filter(
			(stored) =>
				stored.seq >= consumer.cursor &&
				matches(consumer.filter, stored.subject),
		),
	];
	const take = (consumer: ConsumerState): StreamDelivery | undefined => {
		const next = consumer.initial.shift() ?? pending(consumer)[0];
		if (next === undefined) return undefined;
		consumer.cursor = Math.max(consumer.cursor, next.seq + 1);
		return {
			subject: next.subject,
			data: next.data,
			seq: next.seq,
			info: { pending: pending(consumer).length },
		};
	};
	const pullConsumer = (consumer: ConsumerState): PullConsumer => ({
		async info() {
			return { num_pending: pending(consumer).length };
		},
		async fetch(options) {
			const batch = new Queue<StreamDelivery>();
			for (let count = 0; count < options.max_messages; count += 1) {
				const next = take(consumer);
				if (next === undefined) break;
				batch.push(next);
			}
			batch.end();
			return batch;
		},
		async consume() {
			const deliveries = new Queue<StreamDelivery>();
			const pump: Wake = () => {
				for (let next = take(consumer); next; next = take(consumer))
					deliveries.push(next);
			};
			waiters.add(pump);
			pump();
			return {
				[Symbol.asyncIterator]: () => deliveries[Symbol.asyncIterator](),
				async close() {
					waiters.delete(pump);
					deliveries.end();
				},
			};
		},
	});

	const js: JetStreamPort = {
		async publish(
			subject: string,
			data: Uint8Array,
			options: Partial<JetStreamPublishOptions> = {},
		) {
			const stream = streamFor(subject);
			if (stream === undefined) throw new Error("503 no responders");
			if (
				options.expect?.streamName !== undefined &&
				options.expect.streamName !== stream.config.name
			)
				throw apiError(400, 10060, "expected stream does not match");
			const current = live(stream).filter(
				(stored) => stored.subject === subject,
			);
			if (
				options.expect?.lastSubjectSequence !== undefined &&
				(current.at(-1)?.seq ?? 0) !== options.expect.lastSubjectSequence
			)
				throw apiError(400, 10071, "wrong last sequence");
			if (
				stream.config.discard_new_per_subject === true &&
				current.length >= (stream.config.max_msgs_per_subject ?? 1)
			)
				throw apiError(503, 10077, "maximum messages per subject exceeded");
			const ttl = String(options.ttl ?? "").match(/^(\d+)s$/u)?.[1];
			stream.last += 1;
			stream.messages.push({
				subject,
				data: data.slice(),
				seq: stream.last,
				expiresAt:
					ttl === undefined
						? Number.POSITIVE_INFINITY
						: now() + Number(ttl) * 1000,
			});
			for (const wake of Array.from(waiters)) wake();
			return { stream: stream.config.name, seq: stream.last };
		},
		consumers: {
			async get(name, consumer) {
				const found = streamNamed(name).consumers.get(consumer);
				if (found === undefined)
					throw apiError(404, 10014, "consumer not found");
				return pullConsumer(found);
			},
		},
	};

	const jsm: JetStreamManagerPort = {
		direct: {
			async getMessage(name, query) {
				const last = live(streamNamed(name))
					.filter((stored) => stored.subject === query.last_by_subj)
					.at(-1);
				return last === undefined
					? null
					: { subject: last.subject, data: last.data, seq: last.seq };
			},
		},
		consumers: {
			async add(name, config: Partial<ConsumerConfig>) {
				const stream = streamNamed(name);
				const filter = config.filter_subject ?? ">";
				let initial: Stored[] = [];
				let cursor = 1;
				if (config.deliver_policy === DeliverPolicy.New)
					cursor = stream.last + 1;
				else if (config.deliver_policy === DeliverPolicy.LastPerSubject) {
					const latest = new Map<string, Stored>();
					for (const stored of live(stream))
						if (matches(filter, stored.subject))
							latest.set(stored.subject, stored);
					initial = [...latest.values()].sort((a, b) => a.seq - b.seq);
					cursor = stream.last + 1;
				} else if (config.deliver_policy === DeliverPolicy.StartSequence)
					cursor = config.opt_start_seq ?? 1;
				stream.consumers.set(config.name ?? "", {
					filter,
					initial,
					cursor,
					stream,
				});
				return { name: config.name ?? "" };
			},
			async delete(name, consumer) {
				if (!streamNamed(name).consumers.delete(consumer))
					throw apiError(404, 10014, "consumer not found");
				return true;
			},
		},
		streams: {
			async info(name) {
				return { config: streamNamed(name).config };
			},
			async add(config) {
				if (streams.has(config.name))
					throw apiError(400, 10058, "stream name already in use");
				addStream(config);
				return { config };
			},
			async update(name, config) {
				const stream = streamNamed(name);
				stream.config = { ...stream.config, ...config };
				return { config: stream.config };
			},
			async deleteMessage(name, seq) {
				const stream = streamNamed(name);
				const index = stream.messages.findIndex((stored) => stored.seq === seq);
				if (index < 0) throw apiError(400, 10057, "no message found");
				stream.messages.splice(index, 1);
				return true;
			},
		},
	};

	const connect = (name = "fake"): FakeConnection => {
		const statuses = new Set<Queue<Readonly<{ type: string }>>>();
		const own = new Set<Subscriber>();
		let closed = false;
		let markClosed: Wake = () => undefined;
		const whenClosed = new Promise<void>((resolve) => {
			markClosed = resolve;
		});
		const subscribe = (subject: string): BusSubscription => {
			const subscriber: Subscriber = {
				filter: subject,
				queue: new Queue<BusMessage>(),
				closed: false,
			};
			subscribers.add(subscriber);
			own.add(subscriber);
			return {
				[Symbol.asyncIterator]: () => subscriber.queue[Symbol.asyncIterator](),
				unsubscribe() {
					subscriber.closed = true;
					subscribers.delete(subscriber);
					subscriber.queue.end();
				},
			};
		};
		const ask = async (
			subject: string,
			data: Uint8Array,
			headers: Headers,
		): Promise<BusMessage> => {
			const inbox = `_INBOX.fake.${Math.random().toString(36).slice(2)}`;
			const replies = subscribe(inbox);
			try {
				deliver(subject, data, inbox, headers);
				const next = await Promise.race([
					replies[Symbol.asyncIterator]().next(),
					new Promise<IteratorResult<BusMessage>>((resolve) =>
						setTimeout(() => resolve({ value: undefined, done: true }), 1_000),
					),
				]);
				if (next.done === true) throw new Error("503 no responders");
				return next.value;
			} finally {
				replies.unsubscribe();
			}
		};
		const connection: FakeConnection = {
			name,
			ask,
			status() {
				const events = new Queue<Readonly<{ type: string }>>();
				statuses.add(events);
				return events;
			},
			closed: () => whenClosed,
			publish(subject, data) {
				if (closed) throw new Error("connection closed");
				deliver(subject, data);
			},
			async flush() {
				if (closed) throw new Error("connection closed");
			},
			subscribe,
			async request(subject, data) {
				const answer =
					responders.get(subject) ??
					[...responders].find(([filter]) => matches(filter, subject))?.[1];
				if (answer !== undefined) {
					const reply = answer(data, subject);
					if (reply === undefined) throw new Error("503 no responders");
					return message(subject, reply);
				}
				return ask(subject, data, {});
			},
			async close() {
				if (closed) return;
				closed = true;
				for (const subscriber of own) {
					subscriber.closed = true;
					subscribers.delete(subscriber);
					subscriber.queue.end();
				}
				for (const events of statuses) events.end();
				markClosed();
			},
			isClosed: () => closed,
			emit(type) {
				for (const events of statuses) events.push({ type });
			},
		};
		connections.push(connection);
		return connection;
	};

	const clients: NatsClients = {
		async open(options: OpenOptions) {
			parseServers(options.servers);
			const authenticators = Array.isArray(options.authenticator)
				? options.authenticator
				: [options.authenticator];
			opened.push({
				name: options.name,
				authTokens: authenticators.map((authenticate) =>
					tokenOf(authenticate("nonce")),
				),
			});
			return connect(options.name);
		},
		jetstream: () => js,
		jetstreamManager: async () => jsm,
	};

	return {
		clients,
		connect,
		addStream,
		streamNames: () => [...streams.keys()],
		reply(subject, answer) {
			responders.set(subject, answer);
		},
		advance(ms) {
			offset += ms;
		},
		connections,
		opened,
	};
}

/**
 * A resolver that accepts every account JWT, as `$SYS.REQ.CLAIMS.UPDATE`
 * answers, and answers `$SYS.REQ.ACCOUNT.<account>.CLAIMS.LOOKUP` with the
 * account's last pushed JWT, or nothing at all for one it does not hold.
 */
export function acceptAccounts(server: FakeServer): string[] {
	const pushed: string[] = [];
	const held = new Map<string, string>();
	server.reply("$SYS.REQ.CLAIMS.UPDATE", (data) => {
		const jwt = decoder.decode(data);
		pushed.push(jwt);
		const claims: ClaimsData<Account> = decode(jwt);
		held.set(claims.sub, jwt);
		return encoder.encode(JSON.stringify({ data: { code: 200 } }));
	});
	server.reply("$SYS.REQ.ACCOUNT.*.CLAIMS.LOOKUP", (_data, subject) =>
		encoder.encode(held.get(subject.split(".")[3] ?? "") ?? ""),
	);
	return pushed;
}
