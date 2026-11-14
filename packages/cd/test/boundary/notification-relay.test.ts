import { describe, expect, it } from "vitest";
import {
	type CdEvent,
	type CdEventSink,
	createCdEventsRelay,
	createNotificationPort,
	NOTIFICATION_EVENT_TYPE,
	projectCdEvents,
	type WebhookDelivery,
} from "../../src/boundary/index.js";
import type { CdContext } from "../../src/ports.js";
import { journalStore, recordingTelemetry } from "./fakes.js";
import { fixtureJournal } from "./journal.js";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const ctx: CdContext = {
	tenant: "acme",
	principal: { kind: "service", id: "cd" },
	now: () => NOW,
};

function recordingSink(
	outcome: WebhookDelivery["outcome"] = "delivered",
): CdEventSink & {
	readonly events: CdEvent[];
} {
	const events: CdEvent[] = [];
	return {
		events,
		async deliver(event) {
			events.push(event);
			return outcome === "delivered"
				? { outcome, attempts: 1, status: 202 }
				: { outcome, attempts: 8, code: "webhook-retries-exhausted" };
		},
	};
}

describe("NotificationPort over CDEvents webhooks", () => {
	it("sends a hobo-notification custom CDEvent to the channel's sink", async () => {
		const sink = recordingSink();
		const port = createNotificationPort({
			channels: { ops: sink },
			source: "/hobo/cd/acme",
		});
		await port.notify(
			{ channel: "ops", subject: "promotion p1", body: { state: "PROMOTED" } },
			ctx,
		);
		const settled = await port.drain();
		expect(settled).toEqual([
			{ outcome: "delivered", attempts: 1, status: 202 },
		]);
		expect(sink.events[0]?.context.type).toBe(NOTIFICATION_EVENT_TYPE);
		expect(NOTIFICATION_EVENT_TYPE).toBe(
			"dev.cdeventsx.hobo-notification.sent.0.1.0",
		);
		expect(sink.events[0]?.subject).toEqual({
			id: "promotion p1",
			source: "/hobo/cd/acme",
			content: { channel: "ops", body: { state: "PROMOTED" } },
		});
	});

	it("is deterministic: the same notification at the same instant has the same id", async () => {
		const sink = recordingSink();
		const port = createNotificationPort({
			channels: { ops: sink },
			source: "/s",
		});
		const input = { channel: "ops", subject: "s", body: { a: 1, b: [2] } };
		await port.notify(input, ctx);
		await port.notify({ ...input, body: { b: [2], a: 1 } }, ctx);
		await port.drain();
		expect(sink.events[0]?.context.id).toBe(sink.events[1]?.context.id);
	});

	it("never fails the caller on a dead-lettered delivery", async () => {
		const port = createNotificationPort({
			channels: { ops: recordingSink("dead-lettered") },
			source: "/s",
		});
		await expect(
			port.notify({ channel: "ops", subject: "s", body: {} }, ctx),
		).resolves.toBeUndefined();
		expect((await port.drain())[0]?.outcome).toBe("dead-lettered");
	});

	it("refuses an unknown channel with remediation", async () => {
		const port = createNotificationPort({ channels: {}, source: "/s" });
		await expect(
			port.notify({ channel: "pager", subject: "s", body: {} }, ctx),
		).rejects.toMatchObject({
			code: "notification-channel-unknown",
			remediation: expect.stringContaining("channels"),
		});
	});
});

describe("CDEvents relay (journal → projection → sinks)", () => {
	it("delivers every projected event once, in journal order, with metrics", async () => {
		const sink = recordingSink();
		const telemetry = recordingTelemetry();
		const relay = createCdEventsRelay({
			store: journalStore(fixtureJournal()),
			tenant: "acme",
			source: "/hobo/cd/acme",
			sinks: [sink],
			now: () => NOW,
			telemetry,
		});
		const first = await relay.pump();
		const expected = projectCdEvents(fixtureJournal(), {
			source: "/hobo/cd/acme",
		});
		expect(sink.events).toEqual(expected);
		expect(first).toMatchObject({
			read: 19,
			emitted: expected.length,
			delivered: expected.length,
			deadLettered: 0,
		});
		expect(first.deliveredThrough).toBe(19n);
		// Nothing new: a second pump sends nothing.
		expect((await relay.pump()).emitted).toBe(0);
		expect(
			telemetry.points.some(
				(p) => p.name === "hobo.cd.boundary.cdevents.projected",
			),
		).toBe(true);
		expect(
			telemetry.points.find(
				(p) => p.name === "hobo.cd.boundary.cdevents.skipped",
			)?.value,
		).toBe(1);
	});

	it("resumes after a restart without re-sending and without losing history", async () => {
		const sink = recordingSink();
		const journal = fixtureJournal();
		// The first run delivered through position 7 (the service.upgraded step).
		const relay = createCdEventsRelay({
			store: journalStore(journal),
			tenant: "acme",
			source: "/hobo/cd/acme",
			sinks: [sink],
			now: () => NOW,
			// SAFETY: EventPosition is a branded bigint.
			deliveredThrough: 7n as never,
		});
		await relay.pump();
		const all = projectCdEvents(journal, { source: "/hobo/cd/acme" });
		const tail = projectCdEvents(journal.slice(0, 7), {
			source: "/hobo/cd/acme",
		}).length;
		expect(sink.events).toEqual(all.slice(tail));
		// History was folded: the rollback still names the earlier artifact.
		expect(sink.events[0]?.context.type).toBe(
			"dev.cdevents.service.upgraded.0.3.0",
		);
	});
});
