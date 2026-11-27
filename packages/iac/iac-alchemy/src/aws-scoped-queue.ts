import {
	type DurableQueue,
	type DurableQueueLimits,
	type DurableQueueOperation,
	type DurableQueueOutcome,
	snapshotAtomicQueueDequeue,
	snapshotAtomicQueueEnqueue,
	snapshotAtomicQueueExtension,
	snapshotAtomicQueueSettlement,
} from "@hobo/runtime/atomic-durable-queue";

const apply = Reflect.apply;
const includes = Array.prototype.includes;
const create = Object.create;
const define = Object.defineProperty;
const freeze = Object.freeze;
const NativePromise = Promise;

/* oxlint-disable anti-slop/no-reflect-apply -- SAFETY: queue outcomes cross a scoped application boundary. */
function unknown<T>(op: DurableQueueOperation): DurableQueueOutcome<T> {
	// SAFETY: both own fields are defined before the non-thenable variant is returned.
	const result = create(null) as {
		status: "unknown";
		operation: DurableQueueOperation;
	};
	define(result, "status", { value: "unknown", enumerable: true });
	define(result, "operation", { value: op, enumerable: true });
	return freeze(result);
}
function unavailable(): { status: "unavailable" } {
	// SAFETY: the discriminant is defined before the non-thenable variant is returned.
	const result = create(null) as { status: "unavailable" };
	define(result, "status", { value: "unavailable", enumerable: true });
	return freeze(result);
}
export function scopeAwsQueue(
	port: DurableQueue,
	limits: DurableQueueLimits,
	allow: readonly string[],
	live: () => boolean,
): DurableQueue {
	const permitted = (kind: "enqueue" | "dequeue") => {
		try {
			return live() && apply(includes, allow, [kind]);
		} catch {
			return false;
		}
	};
	const invoke = async <T>(
		op: DurableQueueOperation,
		kind: "enqueue" | "dequeue",
		action: () => Promise<DurableQueueOutcome<T>>,
	): Promise<DurableQueueOutcome<T>> => {
		if (!permitted(kind)) return unknown(op);
		try {
			const result = await action();
			return permitted(kind) ? result : unknown(op);
		} catch {
			return unknown(op);
		}
	};
	const begin = <T>(start: () => Promise<T>): Promise<T> => {
		try {
			return start();
		} catch (error) {
			return new NativePromise((_resolve, reject) => reject(error));
		}
	};
	const scoped: DurableQueue = {
		async limits() {
			try {
				if (!live()) return unavailable();
				const result = await port.limits();
				return live() ? result : unavailable();
			} catch {
				return unavailable();
			}
		},
		enqueue(input) {
			return begin(() => {
				const snapshot = snapshotAtomicQueueEnqueue(input, limits);
				return invoke(snapshot.operation, "enqueue", () =>
					port.enqueue(snapshot),
				);
			});
		},
		dequeue(input) {
			return begin(() => {
				const snapshot = snapshotAtomicQueueDequeue(input, limits);
				return invoke(snapshot.operation, "dequeue", () =>
					port.dequeue(snapshot),
				);
			});
		},
		complete(input) {
			return begin(() => {
				const snapshot = snapshotAtomicQueueSettlement(input, limits);
				return invoke(snapshot.operation, "dequeue", () =>
					port.complete(snapshot),
				);
			});
		},
		release(input) {
			return begin(() => {
				const snapshot = snapshotAtomicQueueSettlement(input, limits);
				return invoke(snapshot.operation, "dequeue", () =>
					port.release(snapshot),
				);
			});
		},
		extendLease(input) {
			return begin(() => {
				const snapshot = snapshotAtomicQueueExtension(input, limits);
				return invoke(snapshot.operation, "dequeue", () =>
					port.extendLease(snapshot),
				);
			});
		},
	};
	return freeze(scoped);
}
/* oxlint-enable anti-slop/no-reflect-apply */
