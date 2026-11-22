import {
	type ConsumerConfig,
	type JetStreamPublishOptions,
	jetstream,
	jetstreamManager,
	type StreamConfig,
	type StreamUpdateConfig,
} from "@nats-io/jetstream";
import { type OpenOptions, open } from "./connection.js";

export interface BusMessage {
	readonly subject: string;
	readonly data: Uint8Array;
	readonly headers?: { get(name: string): string };
	respond(data: Uint8Array): boolean;
	json<T>(): T;
}

export interface BusSubscription extends AsyncIterable<BusMessage> {
	unsubscribe(): void;
}

export interface BusConnection {
	status(): AsyncIterable<Readonly<{ type: string }>>;
	closed(): Promise<void | Error>;
	publish(subject: string, data: Uint8Array): void;
	flush(): Promise<void>;
	subscribe(subject: string): BusSubscription;
	request(
		subject: string,
		data: Uint8Array,
		options: Readonly<{ timeout: number }>,
	): Promise<BusMessage>;
	close(): Promise<void>;
}

export interface StreamDelivery {
	readonly subject: string;
	readonly data: Uint8Array;
	readonly seq: number;
	readonly info: Readonly<{ pending: number }>;
}

export interface PullConsumer {
	info(cached?: boolean): Promise<Readonly<{ num_pending: number }>>;
	fetch(
		options: Readonly<{ max_messages: number; expires: number }>,
	): Promise<AsyncIterable<StreamDelivery>>;
	consume(
		options: Readonly<{ max_messages: number }>,
	): Promise<
		AsyncIterable<StreamDelivery> & { close(): Promise<void | Error> }
	>;
}

export interface JetStreamPort {
	publish(
		subject: string,
		data: Uint8Array,
		options?: Partial<JetStreamPublishOptions>,
	): Promise<Readonly<{ stream: string; seq: number }>>;
	readonly consumers: {
		get(stream: string, name: string): Promise<PullConsumer>;
	};
}

export type StreamDescription = Readonly<{
	config: Readonly<{ name: string }>;
}>;

export interface JetStreamManagerPort {
	readonly direct: {
		getMessage(
			stream: string,
			query: Readonly<{ last_by_subj: string }>,
		): Promise<Readonly<{
			subject: string;
			data: Uint8Array;
			seq: number;
		}> | null>;
	};
	readonly consumers: {
		add(
			stream: string,
			config: Partial<ConsumerConfig>,
		): Promise<Readonly<{ name: string }>>;
		delete(stream: string, name: string): Promise<boolean>;
	};
	readonly streams: {
		info(name: string): Promise<StreamDescription>;
		add(
			config: Partial<StreamConfig> & { name: string },
		): Promise<StreamDescription>;
		update(
			name: string,
			config: Partial<StreamUpdateConfig>,
		): Promise<StreamDescription>;
		deleteMessage(
			stream: string,
			seq: number,
			erase?: boolean,
		): Promise<boolean>;
	};
}

export interface NatsClients {
	open(options: OpenOptions): Promise<BusConnection>;
	jetstream(connection: BusConnection): JetStreamPort;
	jetstreamManager(
		connection: BusConnection,
		options?: Readonly<{ checkAPI: boolean }>,
	): Promise<JetStreamManagerPort>;
}

export const NATS: NatsClients = { open, jetstream, jetstreamManager };
