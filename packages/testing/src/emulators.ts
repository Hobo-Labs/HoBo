/** In-process service implementations use the same ports as deployed services. */
import {
	createInMemoryMessaging,
	type InMemoryMessagingOptions,
	type Messaging,
	type Queue,
	type VirtualClock,
} from "@hobo/core";
import { createRuntimeLocalQueueClock } from "@hobo/runtime-local";

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

export interface EmulatorContext {
	readonly alias: string;
	readonly stage: string;
}

export type EmulatorFactory<T> = (context: EmulatorContext) => T | Promise<T>;

/** Overrides apply to each resource of that kind in an in-process graph. */
export interface ServiceEmulatorFactories {
	readonly queue?: EmulatorFactory<QueueEmulator>;
	readonly topic?: EmulatorFactory<ServiceEmulator<Messaging>>;
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
