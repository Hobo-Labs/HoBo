// The status feed (L27, O20 availability half): one `slo.Measured` event per
// minute and component, with the attainment of that minute's samples, in the
// `SloMeasuredData` shape of @hobo/status-page.
import type { EventEnvelope, JsonObject } from "@hobo/core";
import type { FleetEventStore } from "@hobo/fleet";
import { createMemoryEventStore } from "@hobo/fleet/testing";
import {
	createStatusPageProjection,
	STATUS_SIGNAL_EVENTS,
	type SloMeasuredData,
} from "@hobo/status-page";
import { describe, expect, it } from "vitest";
import { createStatusFeed } from "../../src/status/index.js";

const MINUTE = 60_000;
const START = Date.parse("2026-11-01T10:00:10.000Z");

function clock(start = START) {
	let at = start;
	return { now: () => at, advance: (ms: number) => (at += ms) };
}

async function measured(store: FleetEventStore): Promise<EventEnvelope[]> {
	const out: EventEnvelope[] = [];
	for await (const positioned of store.readAll())
		if (positioned.event.type === STATUS_SIGNAL_EVENTS.SloMeasured)
			out.push(positioned.event);
	return out;
}

function dataOf(event: EventEnvelope): SloMeasuredData & JsonObject {
	const data = event.data;
	if (data === null || data === undefined || Array.isArray(data))
		throw new Error("no data");
	// SAFETY: the test reads back what the feed wrote; the fields are checked by the assertions below.
	return data as SloMeasuredData & JsonObject;
}

function byComponent(events: readonly EventEnvelope[], componentId: string) {
	return events
		.map(dataOf)
		.filter((data) => data.componentId === componentId);
}

describe("createStatusFeed", () => {
	it("emits one slo.Measured per minute and component, with that minute's attainment", async () => {
		const store = createMemoryEventStore();
		const time = clock();
		const feed = createStatusFeed({ store, now: time.now, log: () => {} });

		for (let i = 0; i < 9; i += 1) feed.record("enrollment-api", true);
		feed.record("enrollment-api", false);
		feed.record("nats-callout", true);
		time.advance(MINUTE);
		await feed.tick();

		const events = await measured(store);
		expect(events).toHaveLength(2);
		const api = byComponent(events, "fleet-enrollment-api");
		expect(api).toHaveLength(1);
		expect(api[0]?.attainment).toBeCloseTo(0.9);
		expect(api[0]?.target).toBe(0.999);
		expect(api[0]?.sloName).toBe("availability");
		expect(api[0]?.measuredAt).toBe("2026-11-01T10:01:00.000Z");
		const callout = byComponent(events, "fleet-nats-callout");
		expect(callout[0]?.attainment).toBe(1);
		expect(callout[0]?.target).toBe(0.9995);
	});

	it("emits every elapsed minute exactly once, also across ticks and for idle minutes", async () => {
		const store = createMemoryEventStore();
		const time = clock();
		const feed = createStatusFeed({ store, now: time.now, log: () => {} });

		await feed.tick();
		expect(await measured(store)).toHaveLength(0);

		time.advance(10 * MINUTE);
		await feed.tick();
		await feed.tick();
		const events = await measured(store);
		expect(byComponent(events, "fleet-enrollment-api")).toHaveLength(10);
		expect(byComponent(events, "fleet-nats-callout")).toHaveLength(10);
		// An idle minute has no failed request: its attainment is 1.
		expect(
			byComponent(events, "fleet-nats-callout").every((d) => d.attainment === 1),
		).toBe(true);
		const minutes = byComponent(events, "fleet-enrollment-api").map(
			(d) => d.measuredAt,
		);
		expect(new Set(minutes).size).toBe(10);
	});

	it("attributes a sample to the minute it was recorded in", async () => {
		const store = createMemoryEventStore();
		const time = clock();
		const feed = createStatusFeed({ store, now: time.now, log: () => {} });

		feed.record("nats-callout", false);
		time.advance(MINUTE);
		feed.record("nats-callout", true);
		time.advance(MINUTE);
		await feed.tick();

		const callout = byComponent(await measured(store), "fleet-nats-callout");
		expect(callout.map((d) => d.attainment)).toEqual([0, 1]);
	});

	it("two feeds on one store (two replicas) emit each minute once", async () => {
		const store = createMemoryEventStore();
		const time = clock();
		const a = createStatusFeed({ store, now: time.now, log: () => {} });
		const b = createStatusFeed({ store, now: time.now, log: () => {} });
		a.record("enrollment-api", true);
		b.record("enrollment-api", true);
		time.advance(3 * MINUTE);
		await Promise.all([a.tick(), b.tick()]);
		const events = await measured(store);
		expect(byComponent(events, "fleet-enrollment-api")).toHaveLength(3);
		expect(byComponent(events, "fleet-nats-callout")).toHaveLength(3);
	});

	it("is folded by the status page into one component row each", async () => {
		const store = createMemoryEventStore();
		const time = clock();
		const feed = createStatusFeed({ store, now: time.now, log: () => {} });
		feed.record("enrollment-api", false);
		time.advance(MINUTE);
		await feed.tick();

		const projection = createStatusPageProjection();
		const rows = projection.query(projection.fold(await measured(store)));
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(Object.keys(row?.components ?? {}).sort()).toEqual([
			"fleet-enrollment-api",
			"fleet-nats-callout",
		]);
		expect(row?.components["fleet-enrollment-api"]?.status).not.toBe(
			"operational",
		);
	});
});
