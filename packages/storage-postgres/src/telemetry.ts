/**
 * Metric emission. The shapes are structurally those of `OtelMetricPoint`
 * and `TelemetrySink.metrics` in `@hobo/cd` (frozen ports), so a CD
 * `TelemetrySink` can be passed straight in; this package does not import
 * `@hobo/cd`.
 */
export type StoreMetricAttributes = Readonly<
	Record<string, string | number | boolean>
>;

export type StoreMetricPoint = Readonly<{
	name: string;
	kind: "counter" | "histogram" | "gauge";
	value: number;
	unit: string;
	atMs: number;
	attributes: StoreMetricAttributes;
}>;

export interface StoreTelemetrySink {
	metrics(points: readonly StoreMetricPoint[]): Promise<void>;
}

/** Metric names this store emits. */
export const STORAGE_POSTGRES_METRICS = Object.freeze({
	commitDuration: "hobo.storage.postgres.commit.duration",
	eventsAppended: "hobo.storage.postgres.events.appended",
	conflicts: "hobo.storage.postgres.conflicts",
	leaseClaims: "hobo.storage.postgres.lease.claims",
	checkpointCommits: "hobo.storage.postgres.checkpoint.commits",
	errors: "hobo.storage.postgres.errors",
	retries: "hobo.storage.postgres.transaction.retries",
	migrationsApplied: "hobo.storage.postgres.migrations.applied",
});

export interface StoreMetrics {
	emit(points: readonly Omit<StoreMetricPoint, "atMs">[]): void;
	/** Wait for every emission started so far (tests, graceful shutdown). */
	flush(): Promise<void>;
}

/**
 * Wrap a sink so a failing or slow sink can never fail or block a store
 * operation. Emission is fire-and-forget; failures are counted, not thrown.
 */
export function createStoreMetrics(
	sink: StoreTelemetrySink | undefined,
	nowMs: () => number,
	base: StoreMetricAttributes,
): StoreMetrics & { readonly dropped: () => number } {
	const pending = new Set<Promise<void>>();
	let dropped = 0;
	return Object.freeze({
		emit(points: readonly Omit<StoreMetricPoint, "atMs">[]) {
			if (sink === undefined || points.length === 0) return;
			const atMs = nowMs();
			const stamped = points.map((point) =>
				Object.freeze({
					...point,
					atMs,
					attributes: Object.freeze({ ...base, ...point.attributes }),
				}),
			);
			let delivery: Promise<void>;
			try {
				delivery = sink.metrics(stamped).catch(() => {
					dropped += 1;
				});
			} catch {
				dropped += 1;
				return;
			}
			pending.add(delivery);
			void delivery.finally(() => pending.delete(delivery));
		},
		async flush() {
			await Promise.all(pending);
		},
		dropped: () => dropped,
	});
}
