import { describe, expect, it } from "vitest";
import { createRecordingCdEventSink } from "../../src/testing/index.js";

describe("recording CDEvents sink", () => {
	it("records independent snapshots in order and can be cleared", async () => {
		const sink = createRecordingCdEventSink();
		const event = {
			context: {
				specversion: "1.0",
				id: "event-1",
				source: "/cd",
				type: "dev.cdevents.service.deployed.0.3.0",
				timestamp: "2026-01-01T00:00:00Z",
			},
			subject: { id: "service", content: { state: { value: "ready" } } },
		};
		expect(await sink.deliver(event)).toEqual({
			outcome: "delivered",
			attempts: 1,
			status: 202,
		});
		await sink.deliver({
			...event,
			context: { ...event.context, id: "event-2" },
		});
		expect(sink.events.map((entry) => entry.context.id)).toEqual([
			"event-1",
			"event-2",
		]);
		event.subject.content.state.value = "changed";
		expect(sink.events[0]?.subject.content).toEqual({
			state: { value: "ready" },
		});
		const snapshot = sink.events[0];
		if (!snapshot) throw new Error("expected a recorded event");
		// SAFETY: this mutates the returned test snapshot to prove it is detached.
		const state = snapshot.subject.content.state as { value: string };
		state.value = "changed-again";
		expect(sink.events[0]?.subject.content).toEqual({
			state: { value: "ready" },
		});
		sink.clear();
		expect(sink.events).toEqual([]);
	});

	it("returns a configured delivery outcome for failure-path tests", async () => {
		const delivery = {
			outcome: "dead-lettered",
			attempts: 8,
			code: "webhook-retries-exhausted",
		} as const;
		const sink = createRecordingCdEventSink({ delivery });
		const event = {
			context: {
				specversion: "1.0",
				id: "e",
				source: "/cd",
				type: "dev.cdevents.test.0.3.0",
				timestamp: "2026-01-01T00:00:00Z",
			},
			subject: { id: "test", content: {} },
		};
		expect(await sink.deliver(event)).toEqual(delivery);
		expect(sink.events).toHaveLength(1);
	});
});
