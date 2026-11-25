/**
 * Reading a stored row back as an event envelope.
 *
 * `parseStoredEnvelope` is the seam between SQLite's column shapes and the
 * domain envelope, and the whole of its job is one translation: **SQL's NULL
 * becomes JavaScript's `undefined`, not `null`.**
 *
 * That is not cosmetic. The optional columns — project, causation, correlation,
 * lane — are absent for most events. An envelope carrying `project: null`
 * spreads into a message as an explicit null, and a downstream schema that
 * distinguishes "no project" from "the project is null" would reject it. It
 * also breaks the round trip: an event written with no project and read back
 * with `project: null` is not the event that was written.
 *
 * The rest of the row is re-parsed rather than trusted. The store owns the
 * bytes, but a row can predate a schema change, or be written by another
 * version, or be edited by hand — and every field goes through the same
 * validation an inbound event would face, so a bad row is caught at the read
 * that surfaces it rather than three layers up.
 *
 * The JSON columns (`actor`, `data`, `meta`) are parsed, not passed through:
 * they are stored as text, and a consumer reading `event.data.x` off a string
 * gets `undefined` for every field rather than an error.
 */
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
	// SAFETY: the fixture builds the exact row shape the store returns.
});

describe("optional columns that are NULL", () => {
	it("reads an absent project as undefined, not null", () => {
		// An envelope carrying an explicit null spreads into a message as one,
		// and a schema distinguishing "no project" from "project is null" would
		// reject it.
		// SAFETY: the fixture builds the exact row shape the store returns.
		expect(parseStoredEnvelope(row() as never).project).toBeUndefined();
	});

	it("reads an absent causation id as undefined", () => {
		// SAFETY: the fixture builds the exact row shape the store returns.
		expect(parseStoredEnvelope(row() as never).causationId).toBeUndefined();
	});

	it("reads an absent correlation id as undefined", () => {
		// SAFETY: the fixture builds the exact row shape the store returns.
		expect(parseStoredEnvelope(row() as never).correlationId).toBeUndefined();
	});

	it("reads an absent lane as undefined", () => {
		// SAFETY: the fixture builds the exact row shape the store returns.
		expect(parseStoredEnvelope(row() as never).lane).toBeUndefined();
	});

	it("translates each one independently", () => {
		// Four separate coalesces. One test setting all four could not tell a
		// correctly-translated column from one handled by a shared path.
		const envelope = parseStoredEnvelope(
			// SAFETY: the fixture builds the exact row shape the store returns.
			row({ project: "proj-a", causation_id: null }) as never,
		);
		expect(envelope.project).toBe("proj-a");
		expect(envelope.causationId).toBeUndefined();
	});
});

describe("optional columns that carry a value", () => {
	it("reads a project", () => {
		expect(
			// SAFETY: the fixture builds the exact row shape the store returns.
			parseStoredEnvelope(row({ project: "proj-a" }) as never).project,
		).toBe("proj-a");
	});

	it("reads a causation and correlation id", () => {
		const envelope = parseStoredEnvelope(
			// SAFETY: the fixture builds the exact row shape the store returns.
			row({ causation_id: "cmd-1", correlation_id: "trace-1" }) as never,
		);
		expect([envelope.causationId, envelope.correlationId]).toStrictEqual([
			"cmd-1",
			"trace-1",
		]);
	});

	it("reads a lane", () => {
		// SAFETY: the fixture builds the exact row shape the store returns.
		expect(parseStoredEnvelope(row({ lane: "canary" }) as never).lane).toBe(
			"canary",
		);
	});
});

describe("columns stored as JSON text", () => {
	it("parses the actor rather than handing back a string", () => {
		// Stored as text. A consumer reading `event.actor.kind` off a string
		// gets undefined for every field rather than an error, so the mistake
		// would surface as a missing actor somewhere far away.
		// SAFETY: the fixture builds the exact row shape the store returns.
		expect(parseStoredEnvelope(row() as never).actor).toStrictEqual({
			kind: "system",
			id: "runtime-local",
		});
	});

	it("parses the event data", () => {
		// SAFETY: the fixture builds the exact row shape the store returns.
		expect(parseStoredEnvelope(row() as never).data).toStrictEqual({
			workflow: "checkout",
		});
	});

	it("parses the meta", () => {
		expect(
			parseStoredEnvelope(
				// SAFETY: the fixture builds the exact row shape the store returns.
				row({ meta: JSON.stringify({ idempotencyKey: "k1" }) }) as never,
			).meta,
		).toStrictEqual({ idempotencyKey: "k1" });
	});

	it("carries the required fields through unchanged", () => {
		// SAFETY: the fixture builds the exact row shape the store returns.
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
		// The row is re-parsed rather than trusted: it can predate a schema
		// change, or be written by another version, or be edited by hand.
		// Catching it at the read that surfaces it beats catching it three
		// layers up.
		// SAFETY: the fixture builds the exact row shape the store returns.
		expect(() => parseStoredEnvelope(row({ type: "" }) as never)).toThrow(
			/type: expected non-empty string/,
		);
	});

	it("refuses a row with no stream id", () => {
		// SAFETY: the fixture builds the exact row shape the store returns.
		expect(() => parseStoredEnvelope(row({ stream_id: "" }) as never)).toThrow(
			/streamId: expected non-empty string/,
		);
	});

	it("refuses a row with no tenant", () => {
		// Tenancy is not optional. An untenanted event read back into a
		// projection would be visible to every tenant.
		// SAFETY: the fixture builds the exact row shape the store returns.
		expect(() => parseStoredEnvelope(row({ tenant: "" }) as never)).toThrow(
			/tenant: expected non-empty string/,
		);
	});

	it("names the field it refused", () => {
		// A row has fourteen columns; "invalid event" would leave an operator
		// reading all of them.
		// SAFETY: the fixture builds the exact row shape the store returns.
		expect(() => parseStoredEnvelope(row({ type: "" }) as never)).toThrow(
			/^EnvelopeParseError|type/,
		);
	});

	it("GAP: accepts a non-positive version", () => {
		// Pinned, not asserted as desirable. `parseEventInput` refuses `v: 0`
		// on the way in — `normalizeVersion` requires a positive safe integer —
		// but the *read* path goes through the core envelope parser, which does
		// not. So a version the store would never have accepted can be read
		// back without complaint.
		//
		// It cannot arrive through `append`, so this is a gap in defence rather
		// than a live bug: it matters for a row written by an older version, a
		// hand-edited database, or a restored backup — exactly the cases the
		// re-parse exists to catch. Not fixed here because tightening the read
		// could make an existing store unreadable, which is a migration
		// decision rather than a test fix.
		// SAFETY: the fixture builds the exact row shape the store returns.
		expect(parseStoredEnvelope(row({ v: 0 }) as never).v).toBe(0);
	});
});
