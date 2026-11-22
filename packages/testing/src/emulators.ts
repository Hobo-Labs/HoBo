/** In-process service implementations use the same ports as deployed services. */
import { AsyncLocalStorage } from "node:async_hooks";
import {
	type CronSchedule,
	createInMemoryMessaging,
	type FiredTimer,
	type InMemoryMessagingOptions,
	type IntervalCronSpec,
	type Messaging,
	type Queue,
	type ScheduleId,
	type SchedulerPort,
	type VirtualClock,
} from "@hobo/core";
import type { EngineBinding } from "@hobo/data-core";
import { createSqliteEngine } from "@hobo/data-sqlite";
import {
	createMemorySecretsPort,
	type DeliveryPort,
	type ExperimentPort,
	type FeatureFlagPort,
	FeatureFlagStore,
	type FlagEvent,
	OpenDeliveryEngine,
	OpenExperimentEngine,
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

export interface ScheduleDriver {
	registerJob(
		scheduleId: ScheduleId,
		spec: IntervalCronSpec,
		handler: (fire: FiredTimer) => void | Promise<void>,
	): CronSchedule;
	advance(deltaMs: number): Promise<readonly FiredTimer[]>;
}

export class ScheduleHandlerError extends Error {
	readonly fire: FiredTimer;

	constructor(fire: FiredTimer, options: ErrorOptions) {
		super(
			`Scheduled handler failed for schedule ${JSON.stringify(fire.scheduleId)} and fire ${JSON.stringify(fire.fireId)}.`,
			options,
		);
		this.name = "ScheduleHandlerError";
		this.fire = fire;
	}
}

export interface ScheduleEmulator extends ServiceEmulator<SchedulerPort> {
	/** Present when the implementation supports controlled time. */
	readonly clock?: VirtualClock;
	readonly driver?: ScheduleDriver;
}

const scheduleExecutions = new WeakMap<
	ScheduleDriver["advance"],
	AsyncLocalStorage<{ active: boolean }>
>();
const trackedSchedules = new WeakMap<
	ScheduleEmulator,
	{
		original: ScheduleEmulator;
		executing: AsyncLocalStorage<{ active: boolean }>;
	}
>();

function isInScheduleHandler(emulator: ScheduleEmulator): boolean {
	const tracked = trackedSchedules.get(emulator);
	if (tracked?.executing.getStore()?.active) return true;
	const advance = emulator.driver?.advance;
	if (advance && scheduleExecutions.get(advance)?.getStore()?.active)
		return true;
	return tracked ? isInScheduleHandler(tracked.original) : false;
}

export function assertNotInScheduleHandler(
	schedules: Iterable<ScheduleEmulator>,
): void {
	for (const schedule of schedules)
		if (isInScheduleHandler(schedule))
			throw new Error("A scheduled handler cannot destroy its own graph.");
}

export function trackScheduleEmulator(
	emulator: ScheduleEmulator,
): ScheduleEmulator {
	const original = emulator.driver;
	if (!original) return emulator;
	const executing = new AsyncLocalStorage<{ active: boolean }>();
	const tracked: ScheduleEmulator = {
		port: emulator.port,
		fidelity: emulator.fidelity,
		driver: {
			registerJob(scheduleId, spec, handler) {
				return original.registerJob(scheduleId, spec, (fire) => {
					const frame = { active: true };
					try {
						const result = executing.run(frame, () => handler(fire));
						if (result === undefined) {
							frame.active = false;
							return;
						}
						return Promise.resolve(result).finally(() => {
							frame.active = false;
						});
					} catch (error) {
						frame.active = false;
						throw error;
					}
				});
			},
			advance(deltaMs) {
				const frame = { active: true };
				try {
					return executing
						.run(frame, () => original.advance(deltaMs))
						.finally(() => {
							frame.active = false;
						});
				} catch (error) {
					frame.active = false;
					throw error;
				}
			},
		},
	};
	if (emulator.clock !== undefined)
		Object.assign(tracked, { clock: emulator.clock });
	if (emulator.close !== undefined)
		Object.assign(tracked, { close: () => emulator.close?.() });
	trackedSchedules.set(tracked, { original: emulator, executing });
	return tracked;
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
	readonly rollout?: EmulatorFactory<ServiceEmulator<DeliveryPort>>;
	readonly experiment?: EmulatorFactory<ServiceEmulator<ExperimentPort>>;
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

export interface ProgressiveEmulatorOptions {
	readonly store?: FeatureFlagPort;
	readonly storeFidelity?: "simulated" | "mocked";
	readonly now?: () => string;
}

export function createDeliveryEmulator(
	options: ProgressiveEmulatorOptions = {},
): ServiceEmulator<DeliveryPort> {
	return {
		port: new OpenDeliveryEngine({
			store: options.store ?? new FeatureFlagStore(),
			...(options.now !== undefined ? { now: options.now } : undefined),
		}),
		fidelity:
			options.storeFidelity ??
			(options.store === undefined ? "simulated" : "mocked"),
	};
}

export function createExperimentEmulator(
	options: ProgressiveEmulatorOptions = {},
): ServiceEmulator<ExperimentPort> {
	return {
		port: new OpenExperimentEngine({
			store: options.store ?? new FeatureFlagStore(),
			...(options.now !== undefined ? { now: options.now } : undefined),
		}),
		fidelity:
			options.storeFidelity ??
			(options.store === undefined ? "simulated" : "mocked"),
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
	const scheduler = createLocalScheduler(clock);
	const pending: {
		fire: FiredTimer;
		handler: (fire: FiredTimer) => void | Promise<void>;
	}[] = [];
	const executing = new AsyncLocalStorage<{ active: boolean }>();
	let closed = false;
	let queued = 0;
	let tail: Promise<void> = Promise.resolve();
	const driver: ScheduleDriver = {
		registerJob(scheduleId, spec, handler) {
			if (closed) throw new Error("The schedule emulator is closed.");
			return scheduler.registerJob(scheduleId, spec, (fire) => {
				pending.push({ fire, handler });
			});
		},
		advance(deltaMs) {
			if (closed)
				return Promise.reject(new Error("The schedule emulator is closed."));
			if (executing.getStore()?.active)
				return Promise.reject(
					new Error("A scheduled handler cannot advance its own driver."),
				);
			queued += 1;
			const operation = tail.then(async () => {
				if (closed) throw new Error("The schedule emulator is closed.");
				const fires = scheduler.advance(deltaMs);
				const work = pending.splice(0);
				const failures: unknown[] = [];
				for (const item of work) {
					const frame = { active: true };
					try {
						await executing.run(frame, () => item.handler(item.fire));
					} catch (error) {
						failures.push(
							new ScheduleHandlerError(item.fire, { cause: error }),
						);
					} finally {
						frame.active = false;
					}
				}
				if (failures.length > 0)
					throw new AggregateError(failures, "Scheduled handlers failed.");
				return fires;
			});
			const settled = operation.finally(() => {
				queued -= 1;
			});
			tail = settled.then(
				() => undefined,
				() => undefined,
			);
			return settled;
		},
	};
	const exposedClock: VirtualClock = Object.freeze({
		...clock,
		advance(deltaMs: number) {
			if (queued > 0) throw new Error("A schedule advance is in progress.");
			return clock.advance(deltaMs);
		},
	});
	scheduleExecutions.set(driver.advance, executing);
	return {
		port: Object.freeze({ every: scheduler.every, cron: scheduler.cron }),
		clock: exposedClock,
		driver,
		fidelity: "simulated",
		async close() {
			if (executing.getStore()?.active)
				throw new Error("A scheduled handler cannot close its own driver.");
			closed = true;
			await tail;
		},
	};
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
