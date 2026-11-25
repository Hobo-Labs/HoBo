import type { BusStart, Clock, Subscription } from "../../ports.js";

export type StreamEntry<T> = Readonly<{
	sequence: number;
	at: number;
	value: T;
}>;

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
				} catch {}
			});
		},
		stop() {
			stopped = true;
		},
	};
}

export type MemoryStream<T> = Readonly<{
	publish(value: T): number;
	retained(): readonly StreamEntry<T>[];
	remove(matches: (value: T) => boolean): void;
	subscribe(
		from: BusStart,
		accept: (value: T) => boolean,
		deliver: (entry: StreamEntry<T>) => Promise<void>,
	): Subscription;
	close(): void;
}>;

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
