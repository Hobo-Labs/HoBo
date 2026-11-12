/**
 * The status feed for the availability objectives (L27).
 * Signature frozen by the fleet contract commit (ADR-0182).
 */
import {
	type Clock,
	type FleetEventStore,
	type FleetLog,
	FleetNotImplemented,
} from "@hobo/fleet";

/** Emits `slo.Measured` events (`SloMeasuredData` of @hobo/status-page) for the enrollment API and the NATS callout. */
export function createStatusFeed(
	options: Readonly<{ store: FleetEventStore; now: Clock; log: FleetLog }>,
): Readonly<{
	record(component: "enrollment-api" | "nats-callout", up: boolean): void;
	tick(): Promise<void>;
}> {
	void options;
	throw new FleetNotImplemented("createStatusFeed");
}
