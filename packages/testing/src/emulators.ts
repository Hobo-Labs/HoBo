/** In-process service implementations use the same ports as deployed services. */
import {
	createInMemoryMessaging,
	type InMemoryMessagingOptions,
	type Messaging,
	type Queue,
	type SchedulerPort,
	type VirtualClock,
} from "@hobo/core";
import type { EngineBinding } from "@hobo/data-core";
import { createSqliteEngine } from "@hobo/data-sqlite";
import {
	createMemorySecretsPort,
	type FeatureFlagPort,
	FeatureFlagStore,
	type FlagEvent,
	type SecretsPort,
} from "@hobo/identity";
import {
	createLocalScheduler,
	createRuntimeLocalQueueClock,
} from "@hobo/runtime-local";
import type { Object as BlobMetadata } from "@hobo/wit/wasi-blobstore";

/** Ports generated from HoBo's pinned WASI subsets. */
export type KeyValuePort = typeof import("@hobo/wit/wasi-keyvalue-store");
export type BlobStorePort = typeof import("@hobo/wit/wasi-blobstore");

/** A factory owns an isolated resource and may release it when the graph closes. */
export interface ServiceEmulator<T> {
	readonly port: T;
	/** A caller-supplied fake must not be reported as a real provider. */
	readonly fidelity: "simulated" | "mocked";
	close?(): void | Promise<void>;
}

export interface QueueEmulator extends ServiceEmulator<Queue> {
	/** Present when the queue implementation supports controlled time. */
	readonly clock?: VirtualClock;
}

/** The data emulator must release its engine, even after an interrupted deploy. */
export interface DataEmulator extends ServiceEmulator<EngineBinding> {
	close(): void | Promise<void>;
}

export interface ScheduleEmulator extends ServiceEmulator<SchedulerPort> {
	/** Present when the implementation supports controlled time. */
	readonly clock?: VirtualClock;
}

export interface BucketInspector {
	/** Test-only access to bodies; the pinned WASI subset exposes metadata only. */
	readBody(name: string): Uint8Array | undefined;
}

export interface BucketEmulator extends ServiceEmulator<BlobStorePort> {
	readonly inspector?: BucketInspector;
}

/** Test-only access to a local flag engine's event history. */
export interface FlagInspector {
	events(): readonly FlagEvent[];
}

export interface FlagEmulator extends ServiceEmulator<FeatureFlagPort> {
	readonly inspector?: FlagInspector;
}

export interface EmulatorContext {
	readonly alias: string;
	readonly stage: string;
}

export type EmulatorFactory<T> = (context: EmulatorContext) => T | Promise<T>;

/** Overrides apply to each resource of that kind in an in-process graph. */
export interface ServiceEmulatorFactories {
	readonly queue?: EmulatorFactory<QueueEmulator>;
	readonly topic?: EmulatorFactory<ServiceEmulator<Messaging>>;
	readonly secret?: EmulatorFactory<ServiceEmulator<SecretsPort>>;
	readonly data?: EmulatorFactory<DataEmulator>;
	readonly schedule?: EmulatorFactory<ScheduleEmulator>;
	readonly kv?: EmulatorFactory<ServiceEmulator<KeyValuePort>>;
	readonly bucket?: EmulatorFactory<BucketEmulator>;
	readonly flag?: EmulatorFactory<FlagEmulator>;
}

export function createQueueEmulator(): QueueEmulator {
	const runtime = createRuntimeLocalQueueClock();
	return { port: runtime.queue, clock: runtime.clock, fidelity: "simulated" };
}

export function createTopicEmulator(
	options: InMemoryMessagingOptions = {},
): ServiceEmulator<Messaging> {
	return { port: createInMemoryMessaging(options), fidelity: "simulated" };
}

export function createSecretEmulator(): ServiceEmulator<SecretsPort> {
	return { port: createMemorySecretsPort(), fidelity: "simulated" };
}

/** A fresh flag engine, with every evaluation recorded by default. */
export function createFlagEmulator(
	options: ConstructorParameters<typeof FeatureFlagStore>[0] = {},
): FlagEmulator {
	const store = new FeatureFlagStore({ sampleRate: 1, ...options });
	return {
		port: store,
		inspector: { events: () => structuredClone(store.events) },
		fidelity: "simulated",
	};
}

/** An isolated SQLite engine exposing the data engine SPI, not a remote SQL server. */
export function createDataEmulator(): DataEmulator {
	const engine = createSqliteEngine({ path: ":memory:" });
	let closed = false;
	const close = () => {
		if (closed) return;
		engine.close();
		closed = true;
	};
	return { port: { ...engine, close }, fidelity: "simulated", close };
}

export function createScheduleEmulator(): ScheduleEmulator {
	const { clock } = createRuntimeLocalQueueClock();
	return { port: createLocalScheduler(clock), clock, fidelity: "simulated" };
}

/** In-memory implementation of the vendored wasi:keyvalue/store interface. */
export function createKeyValueEmulator(): ServiceEmulator<KeyValuePort> {
	const values = new Map<string, Uint8Array>();
	return {
		fidelity: "simulated",
		port: {
			get(key) {
				const value = values.get(key);
				return value === undefined ? undefined : Uint8Array.from(value);
			},
			set(entry) {
				values.set(entry.key, Uint8Array.from(entry.value));
			},
			delete(key) {
				values.delete(key);
			},
			exists(key) {
				return values.has(key);
			},
		},
	};
}

/** In-memory implementation of the vendored wasi:blobstore/blobstore subset. */
export function createBucketEmulator(): BucketEmulator {
	const objects = new Map<
		string,
		{ metadata: BlobMetadata; body: Uint8Array }
	>();
	return {
		fidelity: "simulated",
		port: {
			get(name) {
				const object = objects.get(name);
				return object === undefined ? undefined : { ...object.metadata };
			},
			put(metadata, body) {
				objects.set(metadata.name, {
					metadata: { ...metadata },
					body: Uint8Array.from(body),
				});
			},
			delete(name) {
				objects.delete(name);
			},
		},
		inspector: {
			readBody(name) {
				const body = objects.get(name)?.body;
				return body === undefined ? undefined : Uint8Array.from(body);
			},
		},
	};
}
