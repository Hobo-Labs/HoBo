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
import { createMemorySecretsPort, type SecretsPort } from "@hobo/identity";
import {
	createLocalScheduler,
	createRuntimeLocalQueueClock,
} from "@hobo/runtime-local";

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
