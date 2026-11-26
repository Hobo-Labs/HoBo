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
	type AtomicQueueCheckpointRef,
	type AtomicQueueEvent,
	decodeAtomicQueueLog,
	encodeAtomicQueueLog,
	serializeVector,
} from "./atomic-queue-log.js";
import {
	type AtomicQueueRequest,
	type AtomicQueueState,
	type AtomicQueueTransition,
	emptyAtomicQueueState,
	transitionAtomicQueue,
} from "./atomic-queue-transition.js";
import {
	parseQueueDequeue,
	parseQueueEnqueue,
	parseQueueExportConfirmation,
	parseQueueRedrive,
	parseQueueSettlement,
} from "./durable-queue-boundary.js";

export type {
	DurableQueue,
	DurableQueueLimits,
	DurableQueueOperation,
	DurableQueueOutcome,
} from "@hobo/core";
export { parseDurableQueueOperation } from "@hobo/core";

export function snapshotAtomicQueueEnqueue(
	input: Parameters<DurableQueue["enqueue"]>[0],
	limits: DurableQueueLimits,
): Parameters<DurableQueue["enqueue"]>[0] {
	return parseQueueEnqueue(input, limits, "port");
}
export function snapshotAtomicQueueDequeue(
	input: Parameters<DurableQueue["dequeue"]>[0],
	limits: DurableQueueLimits,
): Parameters<DurableQueue["dequeue"]>[0] {
	return parseQueueDequeue(input, limits, "port");
}
export function snapshotAtomicQueueSettlement(
	input: Parameters<DurableQueue["complete"]>[0],
	limits: DurableQueueLimits,
): Parameters<DurableQueue["complete"]>[0] {
	return parseQueueSettlement(input, limits, false, "port");
}
export function snapshotAtomicQueueExtension(
	input: Parameters<DurableQueue["extendLease"]>[0],
	limits: DurableQueueLimits,
): Parameters<DurableQueue["extendLease"]>[0] {
	return parseQueueSettlement(input, limits, true, "port");
}

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
export type AtomicQueueReclamationOutcome =
	| {
			readonly status: "reclaimed";
			readonly reclaimedMessages: number;
			readonly prunedReceipts: number;
	  }
	| { readonly status: "empty" }
	| { readonly status: "unknown" };
export type AtomicQueueExhaustedSnapshot =
	| {
			readonly status: "available";
			readonly revision: number;
			readonly observedAtMs: number;
			readonly messages: readonly {
				readonly messageId: string;
				readonly idempotencyKey: string;
				readonly body: Uint8Array;
				readonly attributes: readonly {
					readonly key: string;
					readonly value: string;
				}[];
				readonly deliveryAttempts: number;
			}[];
			readonly more: boolean;
	  }
	| { readonly status: "unknown" };
export interface AtomicDurableQueue extends DurableQueue {
	compact(): Promise<AtomicQueueCompactionOutcome>;
	reclaimCompleted(): Promise<AtomicQueueReclamationOutcome>;
	inspectExhausted(): Promise<AtomicQueueExhaustedSnapshot>;
	confirmExhaustedExport(input: {
		readonly operation: DurableQueueOperation;
		readonly messageId: string;
		readonly expectedRevision: number;
		readonly exportReceipt: string;
	}): Promise<
		import("@hobo/core").DurableQueueOutcome<
			import("@hobo/core").DurableQueueEnqueueReceipt
		>
	>;
	redriveExhausted(input: {
		readonly operation: DurableQueueOperation;
		readonly messageId: string;
	}): Promise<
		import("@hobo/core").DurableQueueOutcome<
			import("@hobo/core").DurableQueueEnqueueReceipt
		>
	>;
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
const ReclamationSet = Set;
const reclamationAdd = Set.prototype.add;
const reclamationHas = Set.prototype.has;
const reclamationArray = Array.isArray;
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
const InspectionBytes = Uint8Array;
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
				if (
					event.request.kind === "confirmExport" &&
					event.request.input.expectedRevision !== base + index
				)
					return undefined;
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
			if (
				request.kind === "confirmExport" &&
				request.input.expectedRevision !== loaded.revision
			)
				return uncertain(op);
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
	const checkpoint = async (
		reclaim: boolean,
	): Promise<AtomicQueueReclamationOutcome> => {
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
			const referenced = new ReclamationSet<string>();
			if (reclaim) {
				for (let index = 0; index < loaded.state.receipts.length; index++) {
					const receipt = loaded.state.receipts[index];
					if (receipt === undefined) return outcome({ status: "unknown" });
					if (
						receipt.expiresAtMs <= current ||
						receipt.result.status !== "committed"
					)
						continue;
					const value = receipt.result.value;
					if (reclamationArray(value)) {
						for (let position = 0; position < value.length; position++) {
							const delivery = value[position];
							if (delivery === undefined) return outcome({ status: "unknown" });
							identityApply(reclamationAdd, referenced, [delivery.messageId]);
						}
					} else if ("messageId" in value)
						identityApply(reclamationAdd, referenced, [value.messageId]);
					else return outcome({ status: "unknown" });
				}
			}
			const retainedMessages: (typeof loaded.state.messages)[number][] = [];
			for (let index = 0; index < loaded.state.messages.length; index++) {
				const message = loaded.state.messages[index];
				if (message === undefined) return outcome({ status: "unknown" });
				if (
					!reclaim ||
					!message.completed ||
					identityApply(reclamationHas, referenced, [message.messageId])
				)
					retainedMessages[retainedMessages.length] = message;
			}
			const candidate = { ...loaded.state, messages: retainedMessages };
			const bytes = encodeAtomicQueueCheckpoint(candidate, current, limits);
			const checked = decodeAtomicQueueCheckpoint(bytes, limits);
			if (
				checked.atMs !== current ||
				checked.state.nextMessage !== loaded.state.nextMessage ||
				checked.state.nextLease !== loaded.state.nextLease ||
				checked.state.messages.length !== candidate.messages.length
			)
				return outcome({ status: "unknown" });
			for (let index = 0; index < candidate.messages.length; index++) {
				const before = candidate.messages[index];
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
				status: "reclaimed",
				reclaimedMessages:
					loaded.state.messages.length - candidate.messages.length,
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
		async compact() {
			const result = await checkpoint(false);
			return result.status === "reclaimed"
				? outcome({
						status: "compacted" as const,
						prunedReceipts: result.prunedReceipts,
					})
				: result;
		},
		reclaimCompleted: () => checkpoint(true),
		async inspectExhausted() {
			try {
				const loaded = await readState();
				if (!loaded) return outcome({ status: "unknown" as const });
				const observedAtMs = now();
				if (!isSafe(observedAtMs) || observedAtMs < loaded.last)
					return outcome({ status: "unknown" as const });
				const messages: {
					messageId: string;
					idempotencyKey: string;
					body: Uint8Array;
					attributes: { key: string; value: string }[];
					deliveryAttempts: number;
				}[] = [];
				let more = false;
				for (let index = 0; index < loaded.state.messages.length; index++) {
					const message = loaded.state.messages[index];
					if (!message) return outcome({ status: "unknown" as const });
					if (
						message.completed ||
						message.deliveryAttempt < limits.deliveryAttempts ||
						(message.leaseId !== null &&
							message.leaseExpiresAtMs > observedAtMs)
					)
						continue;
					if (messages.length >= limits.batchSize) {
						more = true;
						break;
					}
					const attributes: { key: string; value: string }[] = [];
					for (
						let attributeIndex = 0;
						attributeIndex < message.attributes.length;
						attributeIndex++
					) {
						const attribute = message.attributes[attributeIndex];
						if (!attribute) return outcome({ status: "unknown" as const });
						attributes[attributes.length] = {
							key: attribute.key,
							value: attribute.value,
						};
					}
					messages[messages.length] = {
						messageId: message.messageId,
						idempotencyKey: message.idempotencyKey,
						body: new InspectionBytes(message.body),
						attributes,
						deliveryAttempts: message.deliveryAttempt,
					};
				}
				const verified = await load();
				if (
					loaded.revision === 0
						? verified.status !== "missing"
						: verified.status !== "available" ||
							verified.revision !== loaded.revision
				)
					return outcome({ status: "unknown" as const });
				return outcome({
					status: "available" as const,
					revision: loaded.revision,
					observedAtMs,
					messages,
					more,
				});
			} catch {
				return outcome({ status: "unknown" as const });
			}
		},
		confirmExhaustedExport(input) {
			return begin(() => {
				const request = parseQueueExportConfirmation(input, limits);
				// SAFETY: export confirmations return message receipts or noncommitted outcomes.
				return run({ kind: "confirmExport", input: request }) as ReturnType<
					AtomicDurableQueue["confirmExhaustedExport"]
				>;
			});
		},
		redriveExhausted(input) {
			return begin(() => {
				const request = parseQueueRedrive(input, limits);
				// SAFETY: redrive transitions return message receipts or noncommitted outcomes.
				return run({ kind: "redrive", input: request }) as ReturnType<
					AtomicDurableQueue["redriveExhausted"]
				>;
			});
		},
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
