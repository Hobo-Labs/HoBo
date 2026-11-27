import {
	type DurableQueue,
	type DurableQueueLimits,
	type DurableQueueOperation,
	parseDurableQueueLimits,
} from "@hobo/core";
import {
	ATOMIC_QUEUE_MAX_EVENTS,
	decodeAtomicQueueLog,
	encodeAtomicQueueLog,
	type AtomicQueueEvent,
} from "./atomic-queue-log.js";
import {
	emptyAtomicQueueState,
	transitionAtomicQueue,
	type AtomicQueueRequest,
	type AtomicQueueTransition,
} from "./atomic-queue-transition.js";
import {
	parseQueueDequeue,
	parseQueueEnqueue,
	parseQueueSettlement,
} from "./durable-queue-boundary.js";

export interface AtomicQueueStore {
	load(): Promise<
		| { readonly status: "missing" }
		| { readonly status: "unavailable" }
		| {
				readonly status: "available";
				readonly revision: number;
				readonly bytes: Uint8Array;
		  }
	>;
	compareAndSwap(
		revision: number,
		bytes: Uint8Array,
	): Promise<{ readonly status: "committed" | "unknown" }>;
}
export interface AtomicDurableQueueOptions {
	readonly store: AtomicQueueStore;
	readonly limits: DurableQueueLimits;
	readonly now: () => number;
}
const NativePromise = Promise;
const setPrototype = Object.setPrototypeOf;
const freeze = Object.freeze;
const isSafe = Number.isSafeInteger;
function outcome<T extends object>(value: T): T {
	setPrototype(value, null);
	return freeze(value);
}
function uncertain(
	operation: DurableQueueOperation,
): AtomicQueueTransition["outcome"] {
	return outcome({ status: "unknown", operation });
}

export function createAtomicDurableQueue(
	options: AtomicDurableQueueOptions,
): DurableQueue {
	const limits = parseDurableQueueLimits(options.limits);
	if (limits.nameBytes < 16)
		throw new TypeError("atomic_queue.invalid_options");
	const now = options.now;
	const load = options.store.load.bind(options.store);
	const compareAndSwap = options.store.compareAndSwap.bind(options.store);
	const run = async (
		request: AtomicQueueRequest,
	): Promise<AtomicQueueTransition["outcome"]> => {
		const op = request.input.operation;
		try {
			const loaded = await load();
			if (loaded.status === "unavailable") return uncertain(op);
			let revision = 0;
			let events: AtomicQueueEvent[] = [];
			if (loaded.status === "available") {
				if (!isSafe(loaded.revision) || loaded.revision < 1)
					return uncertain(op);
				revision = loaded.revision;
				events = decodeAtomicQueueLog(loaded.bytes, limits);
				if (events.length !== revision) return uncertain(op);
			} else if (loaded.status !== "missing") return uncertain(op);
			let state = emptyAtomicQueueState();
			let last = 0;
			for (let index = 0; index < events.length; index++) {
				const event = events[index];
				if (event === undefined || event.atMs < last) return uncertain(op);
				const step = transitionAtomicQueue(
					state,
					event.request,
					event.atMs,
					limits,
				);
				if (!step.changed) return uncertain(op);
				state = step.state;
				last = event.atMs;
			}
			const current = now();
			if (!isSafe(current) || current < last) return uncertain(op);
			const next = transitionAtomicQueue(state, request, current, limits);
			if (!next.changed) return outcome(next.outcome);
			if (events.length >= ATOMIC_QUEUE_MAX_EVENTS) return uncertain(op);
			events[events.length] = { atMs: current, request };
			const encoded = encodeAtomicQueueLog(events, limits);
			const written = await compareAndSwap(revision, encoded);
			if (written.status !== "committed") return uncertain(op);
			return outcome(next.outcome);
		} catch {
			return uncertain(op);
		}
	};
	const begin = <T>(start: () => Promise<T>): Promise<T> => {
		try {
			return start();
		} catch (error) {
			return new NativePromise((_resolve, reject) => reject(error));
		}
	};
	const port: DurableQueue = {
		async limits() {
			return outcome({ status: "available" as const, value: limits });
		},
		enqueue(input) {
			return begin(() => {
				const request = parseQueueEnqueue(input, limits, "port");
				// SAFETY: enqueue transitions return only enqueue receipts or noncommitted outcomes.
				return run({ kind: "enqueue", input: request }) as ReturnType<
					DurableQueue["enqueue"]
				>;
			});
		},
		dequeue(input) {
			return begin(() => {
				const request = parseQueueDequeue(input, limits, "port");
				// SAFETY: dequeue transitions return only delivery arrays or noncommitted outcomes.
				return run({ kind: "dequeue", input: request }) as ReturnType<
					DurableQueue["dequeue"]
				>;
			});
		},
		complete(input) {
			return begin(() => {
				const request = parseQueueSettlement(input, limits, false, "port");
				// SAFETY: completion transitions return only settlement receipts or noncommitted outcomes.
				return run({ kind: "complete", input: request }) as ReturnType<
					DurableQueue["complete"]
				>;
			});
		},
		release(input) {
			return begin(() => {
				const request = parseQueueSettlement(input, limits, false, "port");
				// SAFETY: release transitions return only settlement receipts or noncommitted outcomes.
				return run({ kind: "release", input: request }) as ReturnType<
					DurableQueue["release"]
				>;
			});
		},
		extendLease(input) {
			return begin(() => {
				const request = parseQueueSettlement(input, limits, true, "port");
				// SAFETY: extension transitions return only a delivery or noncommitted outcomes.
				return run({ kind: "extendLease", input: request }) as ReturnType<
					DurableQueue["extendLease"]
				>;
			});
		},
	};
	return freeze(port);
}
