import { types } from "node:util";
import {
	type DurableQueue,
	type DurableQueueLimits,
	type DurableQueueOperation,
	parseDurableQueueLimits,
} from "@hobo/core";
import {
	decodeAtomicQueueCheckpoint,
	encodeAtomicQueueCheckpoint,
	resultVector,
} from "./atomic-queue-checkpoint.js";
import {
	ATOMIC_QUEUE_MAX_EVENTS,
	decodeAtomicQueueLog,
	encodeAtomicQueueLog,
	serializeVector,
	type AtomicQueueEvent,
	type AtomicQueueCheckpointRef,
} from "./atomic-queue-log.js";
import {
	emptyAtomicQueueState,
	transitionAtomicQueue,
	type AtomicQueueRequest,
	type AtomicQueueTransition,
	type AtomicQueueState,
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
export type AtomicQueueCompactionOutcome =
	| { readonly status: "compacted"; readonly prunedReceipts: number }
	| { readonly status: "empty" }
	| { readonly status: "unknown" };
export interface AtomicDurableQueue extends DurableQueue {
	compact(): Promise<AtomicQueueCompactionOutcome>;
}
export interface AtomicDurableQueueOptions {
	readonly store: AtomicQueueStore;
	readonly limits: DurableQueueLimits;
	readonly now: () => number;
}
export interface AtomicQueueIdentity {
	readonly store: AtomicQueueStore;
	readonly limits: DurableQueueLimits;
}
const queueIdentities = new WeakMap<object, AtomicQueueIdentity>();
const identityGet = WeakMap.prototype.get;
const identitySet = WeakMap.prototype.set;
const identityApply = Reflect.apply;
const identityProxy = types.isProxy;
const identityDescriptor = Object.getOwnPropertyDescriptor;
const identityOwnKeys = Reflect.ownKeys;
const identityHasOwn = Object.hasOwn;
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: the identity is obtained only from a private factory registry. */
export function inspectAtomicDurableQueue(
	value: unknown,
): AtomicQueueIdentity | undefined {
	if (typeof value !== "object" || value === null || identityProxy(value))
		return undefined;
	return identityApply(identityGet, queueIdentities, [value]);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply */
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
): AtomicDurableQueue {
	if (identityProxy(options) || identityOwnKeys(options).length !== 3)
		throw new TypeError("atomic_queue.invalid_options");
	const required = ["store", "limits", "now"];
	for (let index = 0; index < required.length; index++) {
		const key = required[index];
		if (key === undefined) throw new TypeError("atomic_queue.invalid_options");
		const field = identityDescriptor(options, key);
		if (
			field === undefined ||
			!field.enumerable ||
			!identityHasOwn(field, "value")
		)
			throw new TypeError("atomic_queue.invalid_options");
	}
	const store = options.store;
	if (identityProxy(store)) throw new TypeError("atomic_queue.invalid_options");
	const limits = parseDurableQueueLimits(options.limits);
	if (limits.nameBytes < 16)
		throw new TypeError("atomic_queue.invalid_options");
	const now = options.now;
	const load = store.load.bind(store);
	const compareAndSwap = store.compareAndSwap.bind(store);
	type Loaded = {
		readonly revision: number;
		readonly events: AtomicQueueEvent[];
		readonly checkpoint?: AtomicQueueCheckpointRef;
		readonly state: AtomicQueueState;
		readonly last: number;
	};
	const readState = async (): Promise<Loaded | undefined> => {
		try {
			const loaded = await load();
			if (loaded.status === "unavailable") return undefined;
			if (loaded.status === "missing")
				return outcome({
					revision: 0,
					events: [],
					state: emptyAtomicQueueState(),
					last: 0,
				});
			if (
				loaded.status !== "available" ||
				!isSafe(loaded.revision) ||
				loaded.revision < 1
			)
				return undefined;
			const log = decodeAtomicQueueLog(loaded.bytes, limits);
			const base = log.checkpoint?.revision ?? 0;
			if (
				!isSafe(base + log.events.length) ||
				loaded.revision !== base + log.events.length
			)
				return undefined;
			let state = emptyAtomicQueueState();
			let last = 0;
			if (log.checkpoint !== undefined) {
				const checkpoint = decodeAtomicQueueCheckpoint(
					log.checkpoint.bytes,
					limits,
				);
				state = checkpoint.state;
				last = checkpoint.atMs;
			}
			for (let index = 0; index < log.events.length; index++) {
				const event = log.events[index];
				if (event === undefined || event.atMs < last) return undefined;
				const step = transitionAtomicQueue(
					state,
					event.request,
					event.atMs,
					limits,
				);
				if (!step.changed) return undefined;
				state = step.state;
				last = event.atMs;
			}
			const common = {
				revision: loaded.revision,
				events: log.events,
				state,
				last,
			};
			return log.checkpoint === undefined
				? outcome(common)
				: outcome({ ...common, checkpoint: log.checkpoint });
		} catch {
			return undefined;
		}
	};
	const run = async (
		request: AtomicQueueRequest,
	): Promise<AtomicQueueTransition["outcome"]> => {
		const op = request.input.operation;
		try {
			const loaded = await readState();
			if (loaded === undefined) return uncertain(op);
			const current = now();
			if (!isSafe(current) || current < loaded.last) return uncertain(op);
			const next = transitionAtomicQueue(
				loaded.state,
				request,
				current,
				limits,
			);
			if (!next.changed) return outcome(next.outcome);
			if (loaded.events.length >= ATOMIC_QUEUE_MAX_EVENTS) return uncertain(op);
			loaded.events[loaded.events.length] = { atMs: current, request };
			const encoded = encodeAtomicQueueLog(
				loaded.events,
				limits,
				loaded.checkpoint,
			);
			const written = await compareAndSwap(loaded.revision, encoded);
			if (written.status !== "committed") return uncertain(op);
			return outcome(next.outcome);
		} catch {
			return uncertain(op);
		}
	};
	const compact = async (): Promise<AtomicQueueCompactionOutcome> => {
		try {
			const loaded = await readState();
			if (loaded === undefined) return outcome({ status: "unknown" });
			if (loaded.revision === 0) return outcome({ status: "empty" });
			const current = now();
			if (
				!isSafe(current) ||
				current < loaded.last ||
				!isSafe(loaded.revision + 1)
			)
				return outcome({ status: "unknown" });
			const bytes = encodeAtomicQueueCheckpoint(loaded.state, current, limits);
			const checked = decodeAtomicQueueCheckpoint(bytes, limits);
			if (
				checked.atMs !== current ||
				checked.state.nextMessage !== loaded.state.nextMessage ||
				checked.state.nextLease !== loaded.state.nextLease ||
				checked.state.messages.length !== loaded.state.messages.length
			)
				return outcome({ status: "unknown" });
			for (let index = 0; index < loaded.state.messages.length; index++) {
				const before = loaded.state.messages[index];
				const after = checked.state.messages[index];
				if (
					before === undefined ||
					after === undefined ||
					before.messageId !== after.messageId ||
					before.signature !== after.signature ||
					before.idempotencyKey !== after.idempotencyKey ||
					before.availableAtMs !== after.availableAtMs ||
					before.requestedAvailableAtMs !== after.requestedAvailableAtMs ||
					before.deliveryAttempt !== after.deliveryAttempt ||
					before.leaseId !== after.leaseId ||
					before.leaseExpiresAtMs !== after.leaseExpiresAtMs ||
					before.completed !== after.completed
				)
					return outcome({ status: "unknown" });
			}
			let live = 0;
			for (let index = 0; index < loaded.state.receipts.length; index++) {
				const receipt = loaded.state.receipts[index];
				if (receipt === undefined) return outcome({ status: "unknown" });
				if (receipt.expiresAtMs > current) {
					const restored = checked.state.receipts[live++];
					if (
						restored === undefined ||
						restored.id !== receipt.id ||
						restored.expiresAtMs !== receipt.expiresAtMs ||
						restored.fingerprint !== receipt.fingerprint
					)
						return outcome({ status: "unknown" });
					const before = serializeVector(resultVector(receipt));
					const after = serializeVector(resultVector(restored));
					if (before.length !== after.length)
						return outcome({ status: "unknown" });
					for (let position = 0; position < before.length; position++)
						if (before[position] !== after[position])
							return outcome({ status: "unknown" });
				}
			}
			if (checked.state.receipts.length !== live)
				return outcome({ status: "unknown" });
			const encoded = encodeAtomicQueueLog([], limits, {
				revision: loaded.revision + 1,
				bytes,
			});
			const written = await compareAndSwap(loaded.revision, encoded);
			if (written.status !== "committed") return outcome({ status: "unknown" });
			return outcome({
				status: "compacted",
				prunedReceipts: loaded.state.receipts.length - live,
			});
		} catch {
			return outcome({ status: "unknown" });
		}
	};
	const begin = <T>(start: () => Promise<T>): Promise<T> => {
		try {
			return start();
		} catch (error) {
			return new NativePromise((_resolve, reject) => reject(error));
		}
	};
	const port: AtomicDurableQueue = {
		compact,
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
	const result = freeze(port);
	identityApply(identitySet, queueIdentities, [
		result,
		freeze({ store, limits }),
	]);
	return result;
}
