// CDEvents relay: journal → projection → sinks (WP16, plan 0024 D17).
//
// A materialized-view consumer over `readAll`. It folds every event (the
// projector needs history to tell `deployed` from `upgraded`) but delivers
// only events after the caller's delivery cursor, so a restart that passes
// its persisted cursor neither re-sends nor loses anything; at-least-once
// delivery is tolerated by the deterministic CDEvent ids. Read-only: it never
// appends to the journal.

import type { DurableEventStore, EventPosition } from "@hobo/core";
import type { OtelMetricPoint, TelemetrySink } from "../ports.js";
import type { CdEvent } from "./cdevents.js";
import { createCdEventsProjector } from "./projection.js";
import type { CdEventSink } from "./webhook.js";

export type CdEventsRelayOptions = Readonly<{
	/** Only catch-up reads are used; the relay never appends. */
	store: Pick<DurableEventStore, "readAll">;
	tenant: string;
	source: string;
	sinks: readonly CdEventSink[];
	now: () => number;
	/** Last journal position already delivered (persisted by the caller). */
	deliveredThrough?: EventPosition;
	telemetry?: TelemetrySink;
}>;

export type RelayPumpResult = Readonly<{
	read: number;
	emitted: number;
	delivered: number;
	deadLettered: number;
	/** Persist this; pass it back as `deliveredThrough` after a restart. */
	deliveredThrough: EventPosition | undefined;
}>;

export interface CdEventsRelay {
	/** Read new journal events, project them, deliver each to every sink. */
	pump(): Promise<RelayPumpResult>;
}

export function createCdEventsRelay(
	options: CdEventsRelayOptions,
): CdEventsRelay {
	const projector = createCdEventsProjector({ source: options.source });
	let foldedThrough: EventPosition | undefined;
	let deliveredThrough = options.deliveredThrough;

	const metrics = async (points: readonly OtelMetricPoint[]): Promise<void> => {
		try {
			await options.telemetry?.metrics(points);
		} catch {
			// Telemetry is advisory.
		}
	};

	return {
		async pump() {
			let read = 0;
			let emitted = 0;
			let delivered = 0;
			let deadLettered = 0;
			const byType = new Map<string, number>();
			const iterator = options.store.readAll({
				tenant: options.tenant,
				...(foldedThrough !== undefined ? { after: foldedThrough } : undefined),
			});
			for await (const { position, event } of iterator) {
				read += 1;
				foldedThrough = position;
				const out: readonly CdEvent[] = projector.apply(event);
				if (deliveredThrough !== undefined && position <= deliveredThrough)
					continue;
				for (const cdevent of out) {
					emitted += 1;
					byType.set(
						cdevent.context.type,
						(byType.get(cdevent.context.type) ?? 0) + 1,
					);
					for (const sink of options.sinks) {
						const result = await sink.deliver(cdevent);
						if (result.outcome === "delivered") delivered += 1;
						else deadLettered += 1;
					}
				}
				deliveredThrough = position;
			}
			const atMs = options.now();
			await metrics([
				...[...byType.entries()].map(
					([type, value]): OtelMetricPoint => ({
						name: "hobo.cd.boundary.cdevents.projected",
						kind: "counter",
						value,
						unit: "{event}",
						atMs,
						attributes: { "cdevents.type": type },
					}),
				),
				{
					name: "hobo.cd.boundary.cdevents.skipped",
					kind: "gauge",
					value: projector.skipped,
					unit: "{event}",
					atMs,
					attributes: {},
				},
			]);
			return { read, emitted, delivered, deadLettered, deliveredThrough };
		},
	};
}
