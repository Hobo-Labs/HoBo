import { describe, expect, it } from "vitest";

import { parseStoredEnvelope } from "../../src/eventstore/parse.js";

const row = (overrides: Record<string, unknown> = {}) => ({
	id: "01JQZX000000000000000EVT1",
	type: "run.Started",
	v: 1,
	stream_id: "run:checkout-1",
	seq: 1,
	ts: "2026-06-26T00:00:00.000Z",
	actor: JSON.stringify({ kind: "system", id: "runtime-local" }),
	tenant: "tenant-a",
	project: null,
	causation_id: null,
	correlation_id: null,
	lane: null,
	data: JSON.stringify({ workflow: "checkout" }),
	meta: JSON.stringify({}),
	...overrides,
});

describe("optional columns that are NULL", () => {
	it("reads an absent project as undefined, not null", () => {
		expect(parseStoredEnvelope(row() as never).project).toBeUndefined();
	});

	it("reads an absent causation id as undefined", () => {
		expect(parseStoredEnvelope(row() as never).causationId).toBeUndefined();
	});

	it("reads an absent correlation id as undefined", () => {
		expect(parseStoredEnvelope(row() as never).correlationId).toBeUndefined();
	});

	it("reads an absent lane as undefined", () => {
		expect(parseStoredEnvelope(row() as never).lane).toBeUndefined();
	});

	it("translates each one independently", () => {
		const envelope = parseStoredEnvelope(
			row({ project: "proj-a", causation_id: null }) as never,
		);
		expect(envelope.project).toBe("proj-a");
		expect(envelope.causationId).toBeUndefined();
	});
});

describe("optional columns that carry a value", () => {
	it("reads a project", () => {
		expect(
			parseStoredEnvelope(row({ project: "proj-a" }) as never).project,
		).toBe("proj-a");
	});

	it("reads a causation and correlation id", () => {
		const envelope = parseStoredEnvelope(
			row({ causation_id: "cmd-1", correlation_id: "trace-1" }) as never,
		);
		expect([envelope.causationId, envelope.correlationId]).toStrictEqual([
			"cmd-1",
			"trace-1",
		]);
	});

	it("reads a lane", () => {
		expect(parseStoredEnvelope(row({ lane: "canary" }) as never).lane).toBe(
			"canary",
		);
	});
});

describe("columns stored as JSON text", () => {
	it("parses the actor rather than handing back a string", () => {
		expect(parseStoredEnvelope(row() as never).actor).toStrictEqual({
			kind: "system",
			id: "runtime-local",
		});
	});

	it("parses the event data", () => {
		expect(parseStoredEnvelope(row() as never).data).toStrictEqual({
			workflow: "checkout",
		});
	});

	it("parses the meta", () => {
		expect(
			parseStoredEnvelope(
				row({ meta: JSON.stringify({ idempotencyKey: "k1" }) }) as never,
			).meta,
		).toStrictEqual({ idempotencyKey: "k1" });
	});

	it("carries the required fields through unchanged", () => {
		expect(parseStoredEnvelope(row() as never)).toMatchObject({
			id: "01JQZX000000000000000EVT1",
			type: "run.Started",
			v: 1,
			streamId: "run:checkout-1",
			seq: 1,
			tenant: "tenant-a",
		});
	});
});

describe("rows the parse refuses", () => {
	it("refuses a row with no type", () => {
		expect(() => parseStoredEnvelope(row({ type: "" }) as never)).toThrow(
			/type: expected non-empty string/,
		);
	});

	it("refuses a row with no stream id", () => {
		expect(() => parseStoredEnvelope(row({ stream_id: "" }) as never)).toThrow(
			/streamId: expected non-empty string/,
		);
	});

	it("refuses a row with no tenant", () => {
		expect(() => parseStoredEnvelope(row({ tenant: "" }) as never)).toThrow(
			/tenant: expected non-empty string/,
		);
	});

	it("names the field it refused", () => {
		expect(() => parseStoredEnvelope(row({ type: "" }) as never)).toThrow(
			/^EnvelopeParseError|type/,
		);
	});

	it("GAP: accepts a non-positive version", () => {
		expect(parseStoredEnvelope(row({ v: 0 }) as never).v).toBe(0);
	});
});
