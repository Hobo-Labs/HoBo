/**
 * An in-memory ordered stream with sequence numbers, a maximum age and
 * `BusStart`-aware subscriptions: the one piece the memory bus builds every
 * stream port from. Plumbing of the contract commit (design §11.2 step 5).
 *
 * Each subscription delivers in stream order through its own queue, so a slow
 * handler never reorders messages and a handler that publishes cannot deadlock
 * the publisher. Delivery is asynchronous: `publish` resolves once the message
 * is stored, as a JetStream publish acknowledgement does.
 */
import type { BusStart, Clock, Subscription } from "../../ports.js";

/** One retained message and the stream sequence it was stored under. */
export type StreamEntry<T> = Readonly<{
	sequence: number;
	at: number;
	value: T;
}>;

/** A serial delivery queue: tasks run one after another; a failing task never stops the queue. */
export type DeliveryQueue = Readonly<{
	push(task: () => Promise<void>): void;
	stop(): void;
}>;

export function createDeliveryQueue(): DeliveryQueue {
	let tail: Promise<void> = Promise.resolve();
	let stopped = false;
	return {
		push(task) {
			tail = tail.then(async () => {
				if (stopped) return;
				try {
					await task();
				} catch {
					// A handler's failure is the handler's business; the stream keeps delivering.
				}
			});
		},
		stop() {
			stopped = true;
		},
	};
}

export type MemoryStream<T> = Readonly<{
	publish(value: T): number;
	/** Retained messages, oldest first, after pruning those past the maximum age. */
	retained(): readonly StreamEntry<T>[];
	/** Removes the messages `matches` selects (a JetStream message delete). */
	remove(matches: (value: T) => boolean): void;
	subscribe(
		from: BusStart,
		accept: (value: T) => boolean,
		deliver: (entry: StreamEntry<T>) => Promise<void>,
	): Subscription;
	close(): void;
}>;

/** `maxAgeMs` undefined keeps every message (no expiry). */
export function createMemoryStream<T>(
	now: Clock,
	maxAgeMs: number | undefined,
): MemoryStream<T> {
	let entries: StreamEntry<T>[] = [];
	let nextSequence = 1;
	const subscribers = new Set<
		Readonly<{
			accept: (value: T) => boolean;
			deliver: (entry: StreamEntry<T>) => Promise<void>;
			queue: DeliveryQueue;
		}>
	>();

	const prune = () => {
		if (maxAgeMs === undefined) return;
		const cutoff = now() - maxAgeMs;
		entries = entries.filter((entry) => entry.at > cutoff);
	};

	return {
		publish(value) {
			prune();
			const entry: StreamEntry<T> = {
				sequence: nextSequence,
				at: now(),
				value,
			};
			nextSequence += 1;
			entries.push(entry);
			for (const subscriber of subscribers) {
				if (subscriber.accept(value))
					subscriber.queue.push(() => subscriber.deliver(entry));
			}
			return entry.sequence;
		},
		retained() {
			prune();
			return [...entries];
		},
		remove(matches) {
			entries = entries.filter((entry) => !matches(entry.value));
		},
		subscribe(from, accept, deliver) {
			prune();
			const queue = createDeliveryQueue();
			const subscriber = { accept, deliver, queue };
			if (from !== "new") {
				const after = from === "start" ? 0 : from.after;
				for (const entry of entries) {
					if (entry.sequence > after && accept(entry.value))
						queue.push(() => deliver(entry));
				}
			}
			subscribers.add(subscriber);
			return {
				async stop() {
					subscribers.delete(subscriber);
					queue.stop();
				},
			};
		},
		close() {
			for (const subscriber of subscribers) subscriber.queue.stop();
			subscribers.clear();
		},
	};
}
