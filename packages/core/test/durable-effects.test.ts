import { expect, it } from "vitest";
import {
	type DurableEffectInput,
	EventStoreParseError,
	parseDurableEffect,
} from "../src/index.js";

const valid: DurableEffectInput[] = [
	{
		kind: "queue",
		queueName: "jobs",
		idempotencyKey: "q1",
		body: { nested: [1, true, null] },
		availableAt: "2026-01-01T00:00:00.000Z",
	},
	{ kind: "actor-signal", actorKey: "worker", idempotencyKey: "a1", body: {} },
	{
		kind: "timer",
		timerKind: "sleep",
		subjectId: "subject",
		idempotencyKey: "t1",
		dueAt: "2026-01-01T00:00:00.000Z",
	},
	{
		kind: "cron",
		scheduleId: "nightly",
		everyMs: 1_000,
		startAt: "2026-01-01T00:00:00.000Z",
		nextFireAt: "2026-01-01T00:00:01.000Z",
		occurrence: 0,
	},
	{
		kind: "outbox",
		destination: "notifications",
		idempotencyKey: "o1",
		payload: { item: "one" },
		headers: { source: "app" },
	},
];

it("accepts each effect kind and copies nested data", () => {
	for (const effect of valid)
		expect(parseDurableEffect(effect)).toEqual(effect);
	const input = {
		kind: "outbox" as const,
		destination: "notifications",
		idempotencyKey: "o1",
		payload: { item: "one" },
	};
	const parsed = parseDurableEffect(input);
	input.payload.item = "changed";
	expect(parsed).toMatchObject({ payload: { item: "one" } });
});

it.each([
	[
		{ kind: "outbox", destination: " ", idempotencyKey: "o", payload: {} },
		"effect.destination",
	],
	[
		{ kind: "queue", queueName: "", idempotencyKey: "q", body: {} },
		"effect.queueName",
	],
	[
		{ kind: "actor-signal", actorKey: "worker", idempotencyKey: "", body: {} },
		"effect.idempotencyKey",
	],
	[
		{
			kind: "timer",
			timerKind: "sleep",
			subjectId: "s",
			idempotencyKey: "t",
			dueAt: "tomorrow",
		},
		"effect.dueAt",
	],
	[
		{
			kind: "cron",
			scheduleId: "s",
			everyMs: 0,
			startAt: "2026-01-01T00:00:00Z",
			nextFireAt: "2026-01-01T00:00:00Z",
		},
		"effect.everyMs",
	],
	[
		{
			kind: "outbox",
			destination: "d",
			idempotencyKey: "o",
			payload: { count: Number.NaN },
		},
		"effect.payload",
	],
	[
		{
			kind: "outbox",
			destination: "d",
			idempotencyKey: "o",
			payload: {},
			headers: { n: 3 },
		},
		"effect.headers",
	],
])("rejects invalid durable effect field %s", (input, path) => {
	try {
		parseDurableEffect(input as DurableEffectInput);
		throw new Error("invalid effect was accepted");
	} catch (error) {
		expect(error).toBeInstanceOf(EventStoreParseError);
		expect(error).toMatchObject({ path });
	}
});

interface CircularPayload {
	self?: CircularPayload;
}

it("rejects circular payloads", () => {
	const payload: CircularPayload = {};
	payload.self = payload;
	expect(() =>
		parseDurableEffect({
			kind: "outbox",
			destination: "d",
			idempotencyKey: "o",
			payload,
		} as DurableEffectInput),
	).toThrow(EventStoreParseError);
});
